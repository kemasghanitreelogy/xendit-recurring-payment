import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRecurringPlan } from '@/lib/xendit';
import {
  addCustomerTag,
  removeCustomerTag,
  createPaidOrder,
  ShopifyError,
} from '@/lib/shopify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MEMBER_TAG = 'pro-member';

type WebhookEvent = {
  id?: string;
  event?: string;
  created?: string;
  business_id?: string;
  data?: any;
};

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Xendit webhook handler.
 *
 * Order of operations is critical:
 *   1. Verify token. Reject anything unsigned.
 *   2. Dedupe via xendit_webhook_events PK (idempotent).
 *   3. Update DB state (single source of truth) BEFORE any external call.
 *   4. Attempt external sync (Shopify). Failures are caught and recorded
 *      on the invoice row so /api/admin/reconcile can retry — they
 *      never block returning 200 to Xendit (which would cause noisy retries).
 *   5. Mark webhook event as processed.
 */
export async function POST(req: Request) {
  // 1. Token verification
  const token = req.headers.get('x-callback-token');
  if (!token || token !== process.env.XENDIT_WEBHOOK_TOKEN) {
    console.warn('[xendit-webhook] Invalid token');
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  const event: WebhookEvent = await req.json();
  const eventId =
    event.id ??
    `${event.event}-${event.data?.id ?? 'unknown'}-${event.created ?? Date.now()}`;
  const eventType = event.event ?? 'unknown';

  const admin = createAdminClient();

  // 2. Dedupe — insert into xendit_webhook_events; PK collision = duplicate
  const { error: dedupeErr } = await admin
    .from('xendit_webhook_events')
    .insert({ id: eventId, event_type: eventType, payload: event as any });

  if (dedupeErr) {
    if (dedupeErr.code === '23505') {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error('[xendit-webhook] Dedupe error:', dedupeErr);
    return NextResponse.json({ error: 'Storage error' }, { status: 500 });
  }

  // 3-4. Process the event
  try {
    await handleEvent(eventType, event.data ?? {}, admin);
    await admin
      .from('xendit_webhook_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', eventId);
  } catch (err) {
    // Critical handler failure (NOT just Shopify sync — Shopify failures
    // are caught inside handleEvent and recorded on the invoice). Still
    // return 200 so Xendit doesn't endlessly retry; the error is logged
    // for reconciliation.
    console.error('[xendit-webhook] Handler error:', err);
    await admin
      .from('xendit_webhook_events')
      .update({ error: String(err) })
      .eq('id', eventId);
    return NextResponse.json({ ok: false, error: 'Processing failed' });
  }

  return NextResponse.json({ ok: true });
}

async function handleEvent(type: string, data: any, admin: Admin): Promise<void> {
  // Per Xendit payload schema:
  //   - recurring.plan.*  → data.id IS the plan ID
  //   - recurring.cycle.* → data.id is the CYCLE ID; plan ID is in data.recurring_plan_id
  // So plan-event handlers fall back to data.id; cycle-event handlers must
  // read data.recurring_plan_id (NEVER data.id) to look up the subscription.
  const planId =
    type.startsWith('recurring.cycle.')
      ? data.recurring_plan_id
      : data.recurring_plan_id ?? data.id;

  if (!planId) {
    console.warn('[xendit-webhook] No plan ID in event:', type);
    return;
  }

  // Lookup subscription. Include all fields needed for Shopify sync.
  const { data: sub } = await admin
    .from('subscriptions')
    .select(
      'id, status, plan_code, amount, currency, shopify_customer_id, shopify_customer_email, xendit_plan_id, metadata'
    )
    .eq('xendit_plan_id', planId)
    .maybeSingle();

  if (!sub) {
    console.warn('[xendit-webhook] Subscription not found for plan:', planId);
    return;
  }

  switch (type) {
    case 'recurring.plan.activated': {
      // Plan is activated after first successful charge. We update sub state
      // and tag the customer here, but DO NOT create a Shopify order from
      // this event — its payload only carries the plan ID, not a cycle ID,
      // so creating an order here would corrupt cycle-level idempotency.
      // The matching `recurring.cycle.succeeded` event (fires alongside)
      // carries the cycle ID and is the sole entry point for Shopify order
      // creation.
      let nextExecutionAt = data.schedule?.next_execution_at ?? null;

      if (!nextExecutionAt) {
        try {
          const plan = await getRecurringPlan(planId);
          nextExecutionAt = plan.schedule?.next_execution_at ?? null;
        } catch (err) {
          console.warn('[xendit-webhook] Could not refetch plan schedule:', err);
        }
      }

      await admin
        .from('subscriptions')
        .update({
          status: 'ACTIVE',
          current_period_start: new Date().toISOString(),
          current_period_end: nextExecutionAt,
        })
        .eq('id', sub.id);

      await applyCustomerTag(admin, sub.id, sub.shopify_customer_id, MEMBER_TAG, 'add');
      break;
    }

    case 'recurring.plan.inactivated': {
      await admin
        .from('subscriptions')
        .update({ status: 'CANCELED', canceled_at: new Date().toISOString() })
        .eq('id', sub.id);
      await applyCustomerTag(admin, sub.id, sub.shopify_customer_id, MEMBER_TAG, 'remove');
      break;
    }

    case 'recurring.cycle.created': {
      // Cycle exists in Xendit but charge not yet attempted. Pre-create
      // invoice row as PENDING; later cycle.succeeded will update it.
      // For cycle events, data.id IS the cycle ID.
      const cycleId = data.id;
      if (!cycleId) break;

      await admin
        .from('subscription_invoices')
        .upsert(
          {
            subscription_id: sub.id,
            xendit_cycle_id: cycleId,
            amount: data.amount ?? sub.amount,
            currency: data.currency ?? sub.currency,
            status: 'PENDING',
            raw_payload: data,
          },
          { onConflict: 'xendit_cycle_id', ignoreDuplicates: false }
        );
      break;
    }

    case 'recurring.cycle.succeeded': {
      // SOLE entry point for Shopify order creation. The cycle ID
      // (data.id for this event) is the idempotency key.
      await admin
        .from('subscriptions')
        .update({
          status: 'ACTIVE',
          current_period_start: data.cycle_date ?? new Date().toISOString(),
          current_period_end: data.next_cycle_date ?? null,
        })
        .eq('id', sub.id);

      await syncSucceededCycle(admin, sub, data);
      await applyCustomerTag(admin, sub.id, sub.shopify_customer_id, MEMBER_TAG, 'add');
      break;
    }

    case 'recurring.cycle.retrying': {
      await admin
        .from('subscriptions')
        .update({ status: 'PAST_DUE' })
        .eq('id', sub.id);
      break;
    }

    case 'recurring.cycle.failed': {
      await admin
        .from('subscriptions')
        .update({ status: 'CANCELED', canceled_at: new Date().toISOString() })
        .eq('id', sub.id);

      // For cycle events, data.id IS the cycle ID (verified above).
      const cycleId = data.id;
      const paymentId = data.payment_id ?? null;

      if (cycleId) {
        await admin.from('subscription_invoices').upsert(
          {
            subscription_id: sub.id,
            xendit_cycle_id: cycleId,
            xendit_payment_id: paymentId,
            amount: data.amount ?? sub.amount,
            currency: data.currency ?? sub.currency,
            status: 'FAILED',
            failure_reason: data.failure_code ?? data.failure_reason ?? null,
            shopify_sync_status: 'SKIPPED',         // no order for failed cycles
            raw_payload: data,
          },
          { onConflict: 'xendit_cycle_id' }
        );
      }

      await applyCustomerTag(admin, sub.id, sub.shopify_customer_id, MEMBER_TAG, 'remove');
      break;
    }

    case 'payment.succeeded':
    case 'payment.failed': {
      // These events fire alongside recurring.cycle.* for the same charge.
      // We intentionally ignore them: handling here would either duplicate
      // work or use wrong IDs (data.id is payment ID, not cycle ID).
      // Source of truth is the recurring.cycle.* event.
      break;
    }

    default:
      console.log('[xendit-webhook] Unhandled event:', type);
  }
}

/**
 * Idempotently insert/update an invoice for a succeeded cycle, then
 * attempt to create the corresponding Shopify order. On Shopify
 * failure, persist the error and leave shopify_sync_status='FAILED'
 * so /api/admin/reconcile can retry later.
 */
async function syncSucceededCycle(admin: Admin, sub: any, data: any): Promise<void> {
  // For recurring.cycle.succeeded, data.id IS the cycle ID. Payment ID is
  // a separate field. We use cycle ID as the idempotency key (matches the
  // tag we set on the Shopify order).
  const cycleId = data.id;
  const paymentId = data.payment_id ?? null;
  const amount = data.amount ?? sub.amount;

  if (!cycleId) {
    console.warn('[xendit-webhook] cycle.succeeded without cycle ID', data);
    return;
  }

  // Upsert invoice in SUCCEEDED state. Returning the row so we have its id.
  const { data: invoiceRow, error: upsertErr } = await admin
    .from('subscription_invoices')
    .upsert(
      {
        subscription_id: sub.id,
        xendit_cycle_id: cycleId,
        xendit_payment_id: paymentId,
        amount,
        currency: data.currency ?? sub.currency,
        status: 'SUCCEEDED',
        payment_method: data.payment_method?.type ?? data.channel_code ?? null,
        paid_at: new Date().toISOString(),
        raw_payload: data,
      },
      { onConflict: 'xendit_cycle_id' }
    )
    .select('id, shopify_sync_status, shopify_order_id, shopify_sync_attempts')
    .single();

  if (upsertErr || !invoiceRow) {
    console.error('[xendit-webhook] Invoice upsert failed:', upsertErr);
    throw upsertErr ?? new Error('Invoice upsert returned no row');
  }

  // If already synced (e.g. webhook re-delivery after first success), skip.
  if (invoiceRow.shopify_sync_status === 'SYNCED' && invoiceRow.shopify_order_id) {
    return;
  }

  // Attempt Shopify order creation. Caught errors do NOT propagate.
  try {
    const order = await createPaidOrder({
      shopifyCustomerId: sub.shopify_customer_id,
      email: sub.shopify_customer_email,
      amount,
      currency: data.currency ?? sub.currency,
      planName: sub.metadata?.plan_name ?? sub.plan_code,
      planCode: sub.plan_code,
      xenditCycleId: cycleId,
      xenditPlanId: sub.xendit_plan_id,
      xenditPaymentId: paymentId,
      cycleDate: data.cycle_date,
    });

    await admin
      .from('subscription_invoices')
      .update({
        shopify_order_id: String(order.id),
        shopify_order_name: order.name,
        shopify_sync_status: 'SYNCED',
        shopify_synced_at: new Date().toISOString(),
        shopify_sync_attempts: (invoiceRow.shopify_sync_attempts ?? 0) + 1,
        shopify_sync_error: null,
      })
      .eq('id', invoiceRow.id);
  } catch (err) {
    const message =
      err instanceof ShopifyError
        ? `${err.status}: ${err.body}`.slice(0, 1000)
        : String(err).slice(0, 1000);
    console.error('[xendit-webhook] Shopify order sync failed:', message);
    await admin
      .from('subscription_invoices')
      .update({
        shopify_sync_status: 'FAILED',
        shopify_sync_attempts: (invoiceRow.shopify_sync_attempts ?? 0) + 1,
        shopify_sync_error: message,
      })
      .eq('id', invoiceRow.id);
    // Do NOT re-throw — webhook should ack so Xendit stops retrying.
    // /api/admin/reconcile will handle retry.
  }
}

/**
 * Apply or remove a customer tag in Shopify. Updates the subscription
 * row's shopify_tag_status so we can audit and reconcile.
 */
async function applyCustomerTag(
  admin: Admin,
  subId: string,
  shopifyCustomerId: string,
  tag: string,
  action: 'add' | 'remove'
): Promise<void> {
  try {
    if (action === 'add') {
      await addCustomerTag(shopifyCustomerId, tag);
    } else {
      await removeCustomerTag(shopifyCustomerId, tag);
    }
    await admin
      .from('subscriptions')
      .update({
        shopify_tag_status: action === 'add' ? 'TAGGED' : 'UNTAGGED',
        shopify_tag_last_attempt_at: new Date().toISOString(),
        shopify_tag_error: null,
      })
      .eq('id', subId);
  } catch (err) {
    const message =
      err instanceof ShopifyError
        ? `${err.status}: ${err.body}`.slice(0, 1000)
        : String(err).slice(0, 1000);
    console.error('[xendit-webhook] Customer tag failed:', message);
    await admin
      .from('subscriptions')
      .update({
        shopify_tag_status: 'FAILED',
        shopify_tag_last_attempt_at: new Date().toISOString(),
        shopify_tag_error: message,
      })
      .eq('id', subId);
  }
}
