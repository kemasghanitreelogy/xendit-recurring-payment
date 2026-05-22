import { NextResponse, after } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRecurringPlan, updateRecurringPlanAmount, XenditError } from '@/lib/xendit';
import {
  addCustomerTag,
  removeCustomerTag,
  createPaidOrder,
  createCartOrder,
  ShopifyError,
  type CartLineItemSnapshot,
} from '@/lib/shopify';
import { membershipTagsForPlan } from '@/lib/plans';
import { env } from '@/lib/env';
import { log, alert } from '@/lib/logger';
import { nextRetry } from '@/lib/backoff';
import { consumeRateLimit, clientIp } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============================================================
// Payload schema (typed extraction, no external deps)
// ============================================================
type WebhookEvent = {
  id?: string;
  event?: string;
  created?: string;
  business_id?: string;
  data?: Record<string, unknown>;
};

type EventData = {
  id?: string;                // plan ID for recurring.plan.*, cycle ID for recurring.cycle.*
  recurring_plan_id?: string; // cycle.* events carry the plan ID here
  customer_id?: string;
  amount?: number;
  currency?: string;
  cycle_date?: string;
  next_cycle_date?: string;
  payment_method?: { type?: string };
  channel_code?: string;
  payment_id?: string;
  failure_code?: string;
  failure_reason?: string;
  schedule?: { next_execution_at?: string };
  // Invoice events (one-time path)
  external_id?: string;
  status?: string;
  paid_at?: string;
  payment_channel?: string;
  payer_email?: string;
};

function parseEvent(raw: unknown): WebhookEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    id: typeof r.id === 'string' ? r.id : undefined,
    event: typeof r.event === 'string' ? r.event : undefined,
    created: typeof r.created === 'string' ? r.created : undefined,
    business_id: typeof r.business_id === 'string' ? r.business_id : undefined,
    data:
      typeof r.data === 'object' && r.data !== null
        ? (r.data as Record<string, unknown>)
        : undefined,
  };
}

function asData(d: Record<string, unknown> | undefined): EventData {
  if (!d) return {};
  return d as EventData;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Xendit webhook handler.
 *
 * Order of operations is critical:
 *   1. Verify token (constant-time compare).
 *   2. Dedupe via xendit_webhook_events PK (idempotent).
 *   3. Update DB state (single source of truth) BEFORE any external call.
 *   4. Attempt external sync (Shopify). Failures are caught and recorded
 *      on the invoice row so /api/admin/reconcile can retry — they
 *      never block returning 200 to Xendit (which would cause noisy retries).
 *   5. Mark webhook event as processed.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);

  // 0a. Optional IP allowlist — if configured, reject anything not from Xendit.
  //     Layered on top of x-callback-token so a leaked token isn't sufficient.
  const allowed = env.XENDIT_WEBHOOK_IPS;
  if (allowed.length > 0 && !allowed.includes(ip)) {
    log.warn('webhook.ip_not_allowed', { ip });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 0b. Rate-limit per source IP. Generous bucket so legitimate Xendit retries
  //     flow freely (default 60 burst, 2/sec sustained). DB-backed so it
  //     persists across cold starts. Fail-open if DB blip.
  const rl = await consumeRateLimit(`webhook:${ip}`, { capacity: 60, refillPerSec: 2 });
  if (!rl.allowed) {
    log.warn('webhook.rate_limited', { ip });
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  // 1. Constant-time token verification — prevents timing-based brute force.
  const provided = req.headers.get('x-callback-token') ?? '';
  const expected = env.XENDIT_WEBHOOK_TOKEN;
  const tokenOk =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!tokenOk) {
    log.warn('webhook.invalid_token', { ip });
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = parseEvent(rawBody);
  if (!event) {
    return NextResponse.json({ error: 'Invalid payload shape' }, { status: 400 });
  }

  const data = asData(event.data);
  const eventId =
    event.id ?? `${event.event}-${data.id ?? 'unknown'}-${event.created ?? Date.now()}`;
  const eventType = event.event ?? 'unknown';

  const admin = createAdminClient();

  // 2. Dedupe — insert into xendit_webhook_events; PK collision = duplicate
  const { error: dedupeErr } = await admin
    .from('xendit_webhook_events')
    .insert({ id: eventId, event_type: eventType, payload: event });

  if (dedupeErr) {
    if (dedupeErr.code === '23505') {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    log.error('webhook.dedupe_failed', { eventId, eventType, error: dedupeErr.message });
    return NextResponse.json({ error: 'Storage error' }, { status: 500 });
  }

  // 3-4. Process the event
  try {
    await handleEvent(eventType, data, admin);
    await admin
      .from('xendit_webhook_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', eventId);
  } catch (err) {
    // Critical handler failure (NOT just Shopify sync — Shopify failures
    // are caught inside handleEvent and recorded on the invoice). Still
    // return 200 so Xendit doesn't endlessly retry; the error is recorded
    // for reconciliation AND we fire an alert so a human notices.
    const message = String(err).slice(0, 1000);
    log.error('webhook.handler_failed', { eventId, eventType, error: message });
    await admin
      .from('xendit_webhook_events')
      .update({ error: message })
      .eq('id', eventId);
    after(() => alert('Xendit webhook handler crashed', { eventId, eventType, error: message }));
    return NextResponse.json({ ok: false, error: 'Processing failed' });
  }

  return NextResponse.json({ ok: true });
}

type CartSnapshotLine = {
  variant_id: string;
  product_id?: string;
  quantity: number;
  unit_price: number;
  title: string;
  is_subscription: boolean;
  selling_plan_id: string | null;
  requires_shipping?: boolean;
  taxable?: boolean;
  image_url?: string | null;
};

type CartSnapshot = {
  type: 'PURE_SUBSCRIPTION' | 'MIXED' | 'PURE_ONETIME';
  line_items: CartSnapshotLine[];
  subscription_total: number;
  onetime_total: number;
  grand_total: number;
  currency: string;
  shop_domain?: string;
};

type SubscriptionRow = {
  id: string;
  status: string;
  plan_code: string;
  amount: number;
  currency: string;
  shopify_customer_id: string;
  shopify_customer_email: string;
  xendit_plan_id: string;
  metadata: { plan_name?: string; shop_domain?: string } | null;
  cart_type: 'PURE_SUBSCRIPTION' | 'MIXED' | null;
  cart_snapshot: CartSnapshot | null;
  subscription_amount: number | null;
  onetime_amount: number;
  amount_adjusted: boolean;
};

async function handleEvent(type: string, data: EventData, admin: Admin): Promise<void> {
  // Invoice events live in their own table (checkout_orders) and don't
  // intersect with the recurring/subscriptions pipeline. Route them
  // before the plan-ID lookup below.
  if (type.startsWith('invoice.')) {
    await handleInvoiceEvent(type, data, admin);
    return;
  }

  // Per Xendit payload schema:
  //   - recurring.plan.*  → data.id IS the plan ID
  //   - recurring.cycle.* → data.id is the CYCLE ID; plan ID is in data.recurring_plan_id
  const planId = type.startsWith('recurring.cycle.')
    ? data.recurring_plan_id
    : data.recurring_plan_id ?? data.id;

  if (!planId) {
    log.warn('webhook.no_plan_id', { type });
    return;
  }

  const { data: sub } = await admin
    .from('subscriptions')
    .select(
      'id, status, plan_code, amount, currency, shopify_customer_id, shopify_customer_email, xendit_plan_id, metadata, cart_type, cart_snapshot, subscription_amount, onetime_amount, amount_adjusted',
    )
    .eq('xendit_plan_id', planId)
    .maybeSingle<SubscriptionRow>();

  if (!sub) {
    log.warn('webhook.subscription_not_found', { type, planId });
    return;
  }

  const memberTags = membershipTagsForPlan(sub.plan_code);

  switch (type) {
    case 'recurring.plan.activated': {
      // Plan is activated after first successful charge. We update sub state
      // and tag the customer here, but DO NOT create a Shopify order from
      // this event — its payload only carries the plan ID, not a cycle ID,
      // so creating an order here would corrupt cycle-level idempotency.
      // The matching `recurring.cycle.succeeded` event (fires alongside)
      // carries the cycle ID and is the sole entry point for Shopify order
      // creation.
      const nextFromPayload = data.schedule?.next_execution_at ?? null;

      await admin
        .from('subscriptions')
        .update({
          status: 'ACTIVE',
          current_period_start: new Date().toISOString(),
          current_period_end: nextFromPayload,
        })
        .eq('id', sub.id);

      // If Xendit didn't include `next_execution_at`, refetch the plan to
      // backfill it — but do this AFTER returning so the webhook doesn't
      // block on extra network calls (Xendit's webhook timeout is tight).
      if (!nextFromPayload) {
        after(async () => {
          try {
            const plan = await getRecurringPlan(planId);
            const next = plan.schedule?.next_execution_at;
            if (next) {
              await admin
                .from('subscriptions')
                .update({ current_period_end: next })
                .eq('id', sub.id);
            }
          } catch (err) {
            log.warn('webhook.refetch_plan_failed', { planId, error: String(err).slice(0, 200) });
          }
        });
      }

      await applyCustomerTags(admin, sub.id, sub.shopify_customer_id, memberTags, 'add');
      break;
    }

    case 'recurring.plan.inactivated': {
      await admin
        .from('subscriptions')
        .update({ status: 'CANCELED', canceled_at: new Date().toISOString() })
        .eq('id', sub.id);
      await applyCustomerTags(admin, sub.id, sub.shopify_customer_id, memberTags, 'remove');
      break;
    }

    case 'recurring.cycle.created': {
      // Cycle exists in Xendit but charge not yet attempted. Pre-create
      // invoice row as PENDING — but ONLY if no row exists yet. Without this
      // guard, an out-of-order `cycle.created` arriving AFTER its matching
      // `cycle.succeeded` would regress the invoice from SUCCEEDED → PENDING,
      // corrupting the customer's invoice history.
      const cycleId = data.id;
      if (!cycleId) break;

      const { data: existing } = await admin
        .from('subscription_invoices')
        .select('id')
        .eq('xendit_cycle_id', cycleId)
        .maybeSingle();
      if (existing) break;

      await admin
        .from('subscription_invoices')
        .insert({
          subscription_id: sub.id,
          xendit_cycle_id: cycleId,
          amount: data.amount ?? sub.amount,
          currency: data.currency ?? sub.currency,
          status: 'PENDING',
          raw_payload: data,
        })
        .then((r) => {
          // Race: another worker may have created the row between our SELECT
          // and INSERT. Unique constraint catches it; we ignore that case.
          if (r.error && r.error.code !== '23505') throw r.error;
        });
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
      await applyCustomerTags(admin, sub.id, sub.shopify_customer_id, memberTags, 'add');
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

      const cycleId = data.id;
      const paymentId = data.payment_id ?? null;

      if (cycleId) {
        // Same guard as cycle.created: only write a FAILED row if the cycle
        // hasn't already been recorded as SUCCEEDED (which would mean
        // out-of-order delivery and the failed event is stale).
        const { data: existing } = await admin
          .from('subscription_invoices')
          .select('id, status')
          .eq('xendit_cycle_id', cycleId)
          .maybeSingle();

        if (!existing) {
          const insertRes = await admin.from('subscription_invoices').insert({
            subscription_id: sub.id,
            xendit_cycle_id: cycleId,
            xendit_payment_id: paymentId,
            amount: data.amount ?? sub.amount,
            currency: data.currency ?? sub.currency,
            status: 'FAILED',
            failure_reason: data.failure_code ?? data.failure_reason ?? null,
            shopify_sync_status: 'SKIPPED',
            raw_payload: data,
          });
          if (insertRes.error && insertRes.error.code !== '23505') throw insertRes.error;
        } else if (existing.status !== 'SUCCEEDED') {
          await admin
            .from('subscription_invoices')
            .update({
              status: 'FAILED',
              failure_reason: data.failure_code ?? data.failure_reason ?? null,
              shopify_sync_status: 'SKIPPED',
              raw_payload: data,
            })
            .eq('id', existing.id);
        } else {
          log.warn('webhook.cycle_failed_after_succeeded', {
            cycleId,
            planId,
            note: 'ignoring stale failed event',
          });
        }
      }

      await applyCustomerTags(admin, sub.id, sub.shopify_customer_id, memberTags, 'remove');
      break;
    }

    case 'payment.succeeded':
    case 'payment.failed':
      // These events fire alongside recurring.cycle.* for the same charge.
      // We intentionally ignore them: handling here would either duplicate
      // work or use wrong IDs (data.id is payment ID, not cycle ID).
      // Source of truth is the recurring.cycle.* event.
      break;

    default:
      log.info('webhook.unhandled_event', { type });
  }
}

/**
 * Build the line items to put on the Shopify Order for a given cycle.
 *
 * - First cycle of a MIXED cart      → ALL items (subscription + one-time addon)
 * - Subsequent cycles of MIXED       → subscription items only
 * - PURE_SUBSCRIPTION (any cycle)    → all items (all are subscription)
 * - Legacy (no cart_snapshot)        → null — caller falls back to createPaidOrder
 */
function cycleLineItems(
  sub: SubscriptionRow,
  isFirstCycle: boolean,
): CartLineItemSnapshot[] | null {
  const snap = sub.cart_snapshot;
  if (!snap || !Array.isArray(snap.line_items)) return null;

  const includeOneTime = sub.cart_type === 'MIXED' ? isFirstCycle : true;
  const items = snap.line_items.filter((li) => includeOneTime || li.is_subscription);

  return items.map<CartLineItemSnapshot>((li) => ({
    variant_id: li.variant_id,
    quantity: li.quantity,
    price: li.unit_price,
    title: li.title,
    is_subscription: li.is_subscription,
    requires_shipping: li.requires_shipping,
    taxable: li.taxable,
  }));
}

/**
 * Idempotently insert/update an invoice for a succeeded cycle, then
 * attempt to create the corresponding Shopify order. On Shopify
 * failure, persist the error and leave shopify_sync_status='FAILED'
 * so /api/admin/reconcile can retry later.
 *
 * Cart-aware: if the subscription was created via /api/checkout (cart_snapshot
 * present), the Shopify order line items are rebuilt from the snapshot.
 * For a MIXED cart's first cycle, the addon items are included; after that
 * cycle succeeds, the plan amount is PATCHed to subscription_amount and
 * subsequent cycles bill only the subscription items.
 */
async function syncSucceededCycle(
  admin: Admin,
  sub: SubscriptionRow,
  data: EventData,
): Promise<void> {
  const cycleId = data.id;
  const paymentId = data.payment_id ?? null;
  const amount = data.amount ?? sub.amount;

  if (!cycleId) {
    log.warn('webhook.cycle_succeeded_no_id', { planId: sub.xendit_plan_id });
    return;
  }

  // First-cycle detection. For MIXED carts this drives both:
  //   1. which line items appear on the Shopify order
  //   2. whether to PATCH the plan amount down to subscription_amount
  // We use `amount_adjusted=false` AND a quick count of prior SUCCEEDED
  // invoices for this subscription. Either signal alone is fragile under
  // retries (e.g. amount PATCH failed last time → flag still false even
  // though the first cycle already created an order).
  const { count: prevSucceeded } = await admin
    .from('subscription_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('subscription_id', sub.id)
    .eq('status', 'SUCCEEDED')
    .neq('xendit_cycle_id', cycleId);

  const isFirstCycle = (prevSucceeded ?? 0) === 0;

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
        is_first_cycle: isFirstCycle,
        line_items: cycleLineItems(sub, isFirstCycle),
        raw_payload: data,
      },
      { onConflict: 'xendit_cycle_id' },
    )
    .select('id, shopify_sync_status, shopify_order_id, shopify_sync_attempts')
    .single();

  if (upsertErr || !invoiceRow) {
    log.error('webhook.invoice_upsert_failed', { cycleId, error: upsertErr?.message });
    throw upsertErr ?? new Error('Invoice upsert returned no row');
  }

  if (invoiceRow.shopify_sync_status === 'SYNCED' && invoiceRow.shopify_order_id) {
    // Order already created. Even so, MIXED carts still need the plan
    // amount mutation for cycles 2+. Run it (idempotent) if not yet done.
    await mutatePlanAmountIfNeeded(admin, sub, isFirstCycle);
    return;
  }

  try {
    const lineItems = cycleLineItems(sub, isFirstCycle);
    let order;
    if (lineItems && lineItems.length > 0) {
      order = await createCartOrder({
        shopifyCustomerId: sub.shopify_customer_id,
        email: sub.shopify_customer_email,
        currency: data.currency ?? sub.currency,
        lineItems,
        idempotencyKey: cycleId,
        noteAttributes: [
          { name: 'xendit_cycle_id', value: cycleId },
          { name: 'xendit_plan_id', value: sub.xendit_plan_id },
          ...(paymentId ? [{ name: 'xendit_payment_id', value: paymentId }] : []),
          ...(data.cycle_date ? [{ name: 'cycle_date', value: data.cycle_date }] : []),
          { name: 'cart_type', value: sub.cart_type ?? 'LEGACY' },
          { name: 'is_first_cycle', value: String(isFirstCycle) },
        ],
        note: `Xendit recurring (${sub.cart_type}). Cycle ${cycleId} on plan ${sub.xendit_plan_id}.${
          isFirstCycle && sub.cart_type === 'MIXED' ? ' First cycle includes one-time addon items.' : ''
        }`,
        tags: ['xendit-recurring', sub.cart_type === 'MIXED' ? 'xendit-mixed' : 'xendit-subscription'],
      });
    } else {
      // Legacy plan-code path — single-line placeholder order.
      order = await createPaidOrder({
        shopifyCustomerId: sub.shopify_customer_id,
        email: sub.shopify_customer_email,
        amount,
        currency: data.currency ?? sub.currency,
        planName: sub.metadata?.plan_name ?? sub.plan_code,
        planCode: sub.plan_code,
        xenditCycleId: cycleId,
        xenditPlanId: sub.xendit_plan_id,
        xenditPaymentId: paymentId ?? undefined,
        cycleDate: data.cycle_date,
      });
    }

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

    // After cycle-1 order is safely created, drop the plan amount for MIXED.
    // Runs AFTER order creation so a failed PATCH never blocks the customer's
    // first-cycle fulfilment; reconcile picks up unfinished mutations.
    await mutatePlanAmountIfNeeded(admin, sub, isFirstCycle);
  } catch (err) {
    const message =
      err instanceof ShopifyError
        ? `${err.status}: ${err.body}`.slice(0, 1000)
        : String(err).slice(0, 1000);
    log.error('webhook.shopify_order_failed', { cycleId, error: message });

    // Schedule next retry using exponential backoff. We pass attemptsSoFar=1
    // (this was the first attempt and it just failed). Reconcile will pick it
    // up at next_retry_at.
    const decision = nextRetry(1);
    const update =
      decision.kind === 'dead'
        ? {
            shopify_sync_status: 'DEAD',
            shopify_sync_dead_letter: true,
            shopify_sync_attempts: 1,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: null,
          }
        : {
            shopify_sync_status: 'FAILED',
            shopify_sync_attempts: 1,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: decision.nextRetryAt.toISOString(),
          };
    await admin
      .from('subscription_invoices')
      .update(update)
      .eq('id', invoiceRow.id);

    // Fire-and-forget alert so a human notices a money-relevant failure.
    after(() =>
      alert('Shopify order sync FAILED — auto-retrying via reconcile', {
        invoiceId: invoiceRow.id,
        cycleId,
        error: message,
        nextRetryAt: decision.kind === 'retry' ? decision.nextRetryAt.toISOString() : 'DEAD',
      }),
    );
    // Do NOT re-throw — webhook should ack so Xendit stops retrying.
  }
}

/**
 * For MIXED carts, after the first cycle successfully charges (sub + addon)
 * we drop the recurring plan's per-cycle amount to subscription_amount so
 * cycle 2+ bills just the subscription items.
 *
 * Idempotent: checks `amount_adjusted` first. If the PATCH fails (network
 * blip, Xendit 5xx) the subscription row stays at amount_adjusted=false and
 * /api/admin/reconcile retries on its next pass.
 */
async function mutatePlanAmountIfNeeded(
  admin: Admin,
  sub: SubscriptionRow,
  isFirstCycle: boolean,
): Promise<void> {
  if (sub.cart_type !== 'MIXED') return;
  if (sub.amount_adjusted) return;
  if (!isFirstCycle) return;
  if (!sub.subscription_amount || sub.subscription_amount === sub.amount) {
    // Nothing to adjust — first cycle was already at the recurring price.
    await admin
      .from('subscriptions')
      .update({ amount_adjusted: true })
      .eq('id', sub.id);
    return;
  }

  try {
    await updateRecurringPlanAmount(sub.xendit_plan_id, sub.subscription_amount);
    await admin
      .from('subscriptions')
      .update({
        amount: sub.subscription_amount,
        amount_adjusted: true,
      })
      .eq('id', sub.id);
  } catch (err) {
    const message =
      err instanceof XenditError
        ? `${err.status}: ${err.body}`.slice(0, 500)
        : String(err).slice(0, 500);
    log.error('webhook.plan_amount_patch_failed', {
      planId: sub.xendit_plan_id,
      targetAmount: sub.subscription_amount,
      error: message,
    });
    // Fire-and-forget alert; reconcile will retry from amount_adjusted=false.
    after(() =>
      alert('Xendit plan amount mutation FAILED — reconcile will retry', {
        subscriptionId: sub.id,
        planId: sub.xendit_plan_id,
        targetAmount: sub.subscription_amount,
        error: message,
      }),
    );
    // Do NOT throw — first-cycle order has already been created; the only
    // remaining issue is that cycle 2+ might bill the wrong amount unless
    // reconcile catches it before then. Subscription intervals (>= 1 day,
    // typically 1+ month) give plenty of time.
  }
}

// ============================================================
// INVOICE EVENTS (one-time `checkout_orders` path) — DORMANT
//
// As of 2026-05-22 this code path is NOT exercised in production:
// the store's `invoice.paid` webhook in Xendit is wired to a different
// backend (api.treelogy.com), and PURE_ONETIME carts at /api/checkout
// are deliberately redirected to Shopify's native checkout (see the
// USE_NATIVE_CHECKOUT branch in app/api/checkout/route.ts).
//
// The handler + the `checkout_orders` table are kept as plumbing for
// a future split where invoices created by THIS backend (e.g. via a
// separate Xendit sub-account) could be webhooked back here. If that
// never happens, this whole block — plus the checkout_orders table —
// can be deleted in a follow-up migration. Until then it is dead but
// type-safe and tested code.
// ============================================================

type CheckoutOrderRow = {
  id: string;
  status: string;
  shopify_customer_id: string;
  shopify_customer_email: string;
  xendit_invoice_id: string;
  amount: number;
  currency: string;
  cart_snapshot: CartSnapshot;
  shopify_sync_status: string;
  shopify_sync_attempts: number;
  shopify_order_id: string | null;
};

async function handleInvoiceEvent(type: string, data: EventData, admin: Admin): Promise<void> {
  const invoiceId = data.id;
  if (!invoiceId) {
    log.warn('webhook.invoice_no_id', { type });
    return;
  }

  const { data: order } = await admin
    .from('checkout_orders')
    .select(
      'id, status, shopify_customer_id, shopify_customer_email, xendit_invoice_id, amount, currency, cart_snapshot, shopify_sync_status, shopify_sync_attempts, shopify_order_id',
    )
    .eq('xendit_invoice_id', invoiceId)
    .maybeSingle<CheckoutOrderRow>();

  if (!order) {
    log.warn('webhook.checkout_order_not_found', { type, invoiceId });
    return;
  }

  if (type === 'invoice.expired' || (type === 'invoice.paid' && data.status === 'EXPIRED')) {
    await admin
      .from('checkout_orders')
      .update({ status: 'EXPIRED', raw_payload: data })
      .eq('id', order.id);
    return;
  }

  // invoice.paid (status PAID/SETTLED) → mark paid, then attempt Shopify order
  await admin
    .from('checkout_orders')
    .update({
      status: 'PAID',
      paid_at: data.paid_at ?? new Date().toISOString(),
      raw_payload: data,
    })
    .eq('id', order.id);

  if (order.shopify_sync_status === 'SYNCED' && order.shopify_order_id) {
    return;
  }

  try {
    const lineItems = (order.cart_snapshot.line_items ?? []).map<CartLineItemSnapshot>((li) => ({
      variant_id: li.variant_id,
      quantity: li.quantity,
      price: li.unit_price,
      title: li.title,
      is_subscription: li.is_subscription,
      requires_shipping: li.requires_shipping,
      taxable: li.taxable,
    }));

    if (lineItems.length === 0) {
      throw new Error('checkout_order cart_snapshot has no line items');
    }

    const shopifyOrder = await createCartOrder({
      shopifyCustomerId: order.shopify_customer_id,
      email: order.shopify_customer_email,
      currency: order.currency,
      lineItems,
      idempotencyKey: invoiceId,
      noteAttributes: [
        { name: 'xendit_invoice_id', value: invoiceId },
        { name: 'cart_type', value: 'PURE_ONETIME' },
        ...(data.payment_channel ? [{ name: 'payment_channel', value: data.payment_channel }] : []),
      ],
      note: `Xendit one-time invoice ${invoiceId}.`,
      tags: ['xendit-onetime'],
    });

    await admin
      .from('checkout_orders')
      .update({
        shopify_order_id: String(shopifyOrder.id),
        shopify_order_name: shopifyOrder.name,
        shopify_sync_status: 'SYNCED',
        shopify_synced_at: new Date().toISOString(),
        shopify_sync_attempts: (order.shopify_sync_attempts ?? 0) + 1,
        shopify_sync_error: null,
      })
      .eq('id', order.id);
  } catch (err) {
    const message =
      err instanceof ShopifyError
        ? `${err.status}: ${err.body}`.slice(0, 1000)
        : String(err).slice(0, 1000);
    log.error('webhook.checkout_order_shopify_failed', { invoiceId, error: message });

    const decision = nextRetry(1);
    const update =
      decision.kind === 'dead'
        ? {
            shopify_sync_status: 'DEAD',
            shopify_sync_dead_letter: true,
            shopify_sync_attempts: 1,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: null,
          }
        : {
            shopify_sync_status: 'FAILED',
            shopify_sync_attempts: 1,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: decision.nextRetryAt.toISOString(),
          };
    await admin.from('checkout_orders').update(update).eq('id', order.id);

    after(() =>
      alert('Checkout order Shopify sync FAILED — auto-retrying via reconcile', {
        checkoutOrderId: order.id,
        invoiceId,
        error: message,
        nextRetryAt: decision.kind === 'retry' ? decision.nextRetryAt.toISOString() : 'DEAD',
      }),
    );
    // Do not re-throw — webhook acks so Xendit stops retrying.
  }
}

async function applyCustomerTags(
  admin: Admin,
  subId: string,
  shopifyCustomerId: string,
  tags: string[],
  action: 'add' | 'remove',
): Promise<void> {
  try {
    if (action === 'add') {
      await addCustomerTag(shopifyCustomerId, tags);
    } else {
      await removeCustomerTag(shopifyCustomerId, tags);
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
    log.error('webhook.customer_tag_failed', { subId, action, error: message });
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
