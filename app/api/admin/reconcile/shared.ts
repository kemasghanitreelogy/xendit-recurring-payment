// Shared reconciliation logic used by both the operator-facing POST endpoint
// (`/api/admin/reconcile`) and the Vercel-Cron-triggered GET endpoint
// (`/api/admin/reconcile/cron`). Keeping the work here makes both surfaces
// behavior-equivalent and avoids divergent retry policy over time.

import {
  createPaidOrder,
  createCartOrder,
  addCustomerTag,
  removeCustomerTag,
  ShopifyError,
  type CartLineItemSnapshot,
} from '@/lib/shopify';
import { updateRecurringPlanAmount, XenditError } from '@/lib/xendit';
import { membershipTagsForPlan } from '@/lib/plans';
import { log, alert } from '@/lib/logger';
import { nextRetry, MAX_ATTEMPTS } from '@/lib/backoff';
import { audit } from '@/lib/audit';
import type { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

export const MAX_RETRIES_PER_RUN = 200;
export const STALE_RESERVATION_HOURS = 24;

export type ReconcileResult = {
  dry_run: boolean;
  invoice_sync: {
    attempted: number;
    succeeded: number;
    failed: number;
    dead_lettered: number;
    errors: string[];
  };
  checkout_order_sync: {
    attempted: number;
    succeeded: number;
    failed: number;
    dead_lettered: number;
    errors: string[];
  };
  plan_amount_fix: { attempted: number; succeeded: number; failed: number; errors: string[] };
  tag_fix: { attempted: number; succeeded: number; failed: number; errors: string[] };
  reservation_cleanup: { attempted: number; succeeded: number };
  webhook_retention: { purged: number };
};

export async function runReconcile(
  admin: Admin,
  opts: { dryRun: boolean; actor?: 'cron' | 'admin' },
): Promise<ReconcileResult> {
  const { dryRun, actor = 'admin' } = opts;
  const result: ReconcileResult = {
    dry_run: dryRun,
    invoice_sync: { attempted: 0, succeeded: 0, failed: 0, dead_lettered: 0, errors: [] },
    checkout_order_sync: { attempted: 0, succeeded: 0, failed: 0, dead_lettered: 0, errors: [] },
    plan_amount_fix: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    tag_fix: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    reservation_cleanup: { attempted: 0, succeeded: 0 },
    webhook_retention: { purged: 0 },
  };

  // 1. Retry failed/pending invoice → Shopify order syncs
  const { data: invoices } = await admin
    .from('invoices_needing_shopify_sync')
    .select('*')
    .limit(MAX_RETRIES_PER_RUN);

  for (const inv of invoices ?? []) {
    result.invoice_sync.attempted += 1;
    if (dryRun) continue;

    try {
      const { data: sub } = await admin
        .from('subscriptions')
        .select('xendit_plan_id, metadata, plan_code, cart_type, cart_snapshot')
        .eq('id', inv.subscription_id)
        .single();

      // Use the per-cycle line_items snapshot saved by the webhook if present
      // (cart-based flow). Falls back to the legacy single-line createPaidOrder
      // for old subscriptions created via /api/subscribe with a static plan code.
      const invLineItems = (inv.line_items ?? null) as CartLineItemSnapshot[] | null;

      let order;
      if (invLineItems && invLineItems.length > 0) {
        order = await createCartOrder({
          shopifyCustomerId: inv.shopify_customer_id,
          email: inv.shopify_customer_email,
          currency: inv.currency,
          lineItems: invLineItems,
          idempotencyKey: inv.xendit_cycle_id,
          noteAttributes: [
            { name: 'xendit_cycle_id', value: inv.xendit_cycle_id },
            { name: 'xendit_plan_id', value: sub?.xendit_plan_id ?? '' },
            ...(inv.xendit_payment_id
              ? [{ name: 'xendit_payment_id', value: inv.xendit_payment_id }]
              : []),
            { name: 'cart_type', value: sub?.cart_type ?? 'LEGACY' },
            { name: 'reconciled', value: 'true' },
          ],
          note: `Xendit recurring (${sub?.cart_type ?? 'legacy'}). Cycle ${inv.xendit_cycle_id} reconciled retry.`,
          tags: ['xendit-recurring', 'reconciled'],
        });
      } else {
        order = await createPaidOrder({
          shopifyCustomerId: inv.shopify_customer_id,
          email: inv.shopify_customer_email,
          amount: inv.amount,
          currency: inv.currency,
          planName: sub?.metadata?.plan_name ?? sub?.plan_code ?? inv.plan_code,
          planCode: inv.plan_code,
          xenditCycleId: inv.xendit_cycle_id,
          xenditPlanId: sub?.xendit_plan_id ?? '',
          xenditPaymentId: inv.xendit_payment_id ?? undefined,
        });
      }

      await admin
        .from('subscription_invoices')
        .update({
          shopify_order_id: String(order.id),
          shopify_order_name: order.name,
          shopify_sync_status: 'SYNCED',
          shopify_synced_at: new Date().toISOString(),
          shopify_sync_attempts: (inv.shopify_sync_attempts ?? 0) + 1,
          shopify_sync_error: null,
        })
        .eq('id', inv.id);

      result.invoice_sync.succeeded += 1;
    } catch (err) {
      const message =
        err instanceof ShopifyError
          ? `${err.status}: ${err.body}`.slice(0, 500)
          : String(err).slice(0, 500);
      const attemptsSoFar = (inv.shopify_sync_attempts ?? 0) + 1;
      const decision = nextRetry(attemptsSoFar);
      if (decision.kind === 'dead') {
        // Retries exhausted — mark dead-letter and alert. Customer has been
        // charged at Xendit but no Shopify order will ever auto-create.
        // A human MUST act (manual create + reconcile reset).
        await admin
          .from('subscription_invoices')
          .update({
            shopify_sync_status: 'DEAD',
            shopify_sync_dead_letter: true,
            shopify_sync_attempts: attemptsSoFar,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: null,
          })
          .eq('id', inv.id);
        result.invoice_sync.dead_lettered += 1;
        result.invoice_sync.errors.push(`invoice ${inv.id} DEAD: ${message}`);
        audit({
          action: 'invoice.dead_letter',
          actor: 'system',
          targetType: 'invoice',
          targetId: inv.id,
          details: { attempts: attemptsSoFar, reason: decision.reason, error: message },
        });
        alert('Invoice DEAD-LETTERED after max retries', {
          invoiceId: inv.id,
          attempts: attemptsSoFar,
          error: message,
        }).catch(() => {});
      } else {
        await admin
          .from('subscription_invoices')
          .update({
            shopify_sync_status: 'FAILED',
            shopify_sync_attempts: attemptsSoFar,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: decision.nextRetryAt.toISOString(),
          })
          .eq('id', inv.id);
        result.invoice_sync.failed += 1;
        result.invoice_sync.errors.push(
          `invoice ${inv.id}: ${message} (retry in ~${decision.backoffSec}s)`,
        );
      }
    }
  }

  // 1b. Retry failed/pending checkout_orders → Shopify order syncs (PURE_ONETIME)
  const { data: pendingCheckoutOrders } = await admin
    .from('checkout_orders_needing_shopify_sync')
    .select('*')
    .limit(MAX_RETRIES_PER_RUN);

  for (const co of pendingCheckoutOrders ?? []) {
    result.checkout_order_sync.attempted += 1;
    if (dryRun) continue;

    try {
      const snap = co.cart_snapshot as {
        line_items: Array<{
          variant_id: string;
          quantity: number;
          unit_price: number;
          title: string;
          is_subscription: boolean;
          requires_shipping?: boolean;
          taxable?: boolean;
        }>;
      };
      const lineItems: CartLineItemSnapshot[] = (snap.line_items ?? []).map((li) => ({
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

      const order = await createCartOrder({
        shopifyCustomerId: co.shopify_customer_id,
        email: co.shopify_customer_email,
        currency: co.currency,
        lineItems,
        idempotencyKey: co.xendit_invoice_id,
        noteAttributes: [
          { name: 'xendit_invoice_id', value: co.xendit_invoice_id },
          { name: 'cart_type', value: 'PURE_ONETIME' },
          { name: 'reconciled', value: 'true' },
        ],
        note: `Xendit one-time invoice ${co.xendit_invoice_id} reconciled retry.`,
        tags: ['xendit-onetime', 'reconciled'],
      });

      await admin
        .from('checkout_orders')
        .update({
          shopify_order_id: String(order.id),
          shopify_order_name: order.name,
          shopify_sync_status: 'SYNCED',
          shopify_synced_at: new Date().toISOString(),
          shopify_sync_attempts: (co.shopify_sync_attempts ?? 0) + 1,
          shopify_sync_error: null,
        })
        .eq('id', co.id);
      result.checkout_order_sync.succeeded += 1;
    } catch (err) {
      const message =
        err instanceof ShopifyError
          ? `${err.status}: ${err.body}`.slice(0, 500)
          : String(err).slice(0, 500);
      const attemptsSoFar = (co.shopify_sync_attempts ?? 0) + 1;
      const decision = nextRetry(attemptsSoFar);
      if (decision.kind === 'dead') {
        await admin
          .from('checkout_orders')
          .update({
            shopify_sync_status: 'DEAD',
            shopify_sync_dead_letter: true,
            shopify_sync_attempts: attemptsSoFar,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: null,
          })
          .eq('id', co.id);
        result.checkout_order_sync.dead_lettered += 1;
        result.checkout_order_sync.errors.push(`checkout_order ${co.id} DEAD: ${message}`);
        audit({
          action: 'checkout_order.dead_letter',
          actor: 'system',
          targetType: 'checkout_order',
          targetId: co.id,
          details: { attempts: attemptsSoFar, reason: decision.reason, error: message },
        });
        alert('Checkout order DEAD-LETTERED after max retries', {
          checkoutOrderId: co.id,
          attempts: attemptsSoFar,
          error: message,
        }).catch(() => {});
      } else {
        await admin
          .from('checkout_orders')
          .update({
            shopify_sync_status: 'FAILED',
            shopify_sync_attempts: attemptsSoFar,
            shopify_sync_error: message,
            last_retry_at: new Date().toISOString(),
            next_retry_at: decision.nextRetryAt.toISOString(),
          })
          .eq('id', co.id);
        result.checkout_order_sync.failed += 1;
        result.checkout_order_sync.errors.push(
          `checkout_order ${co.id}: ${message} (retry in ~${decision.backoffSec}s)`,
        );
      }
    }
  }

  // 1c. Finish unfinished plan amount mutations (MIXED carts where the
  //     first cycle succeeded + Shopify order was created, but the PATCH
  //     to drop the plan amount to subscription_amount failed mid-webhook).
  //     Without this, cycle 2 would bill the first-cycle amount (sub + addon)
  //     instead of just the subscription portion.
  const { data: pendingAmountFix } = await admin
    .from('subscriptions')
    .select('id, xendit_plan_id, subscription_amount, amount, cart_type')
    .eq('cart_type', 'MIXED')
    .eq('amount_adjusted', false)
    .eq('status', 'ACTIVE')
    .limit(MAX_RETRIES_PER_RUN);

  for (const sub of pendingAmountFix ?? []) {
    result.plan_amount_fix.attempted += 1;
    if (dryRun) continue;
    if (!sub.subscription_amount || sub.subscription_amount === sub.amount) {
      // No drop needed (first cycle equalled recurring price) — just flip the flag.
      await admin.from('subscriptions').update({ amount_adjusted: true }).eq('id', sub.id);
      result.plan_amount_fix.succeeded += 1;
      continue;
    }
    try {
      await updateRecurringPlanAmount(sub.xendit_plan_id, sub.subscription_amount);
      await admin
        .from('subscriptions')
        .update({ amount: sub.subscription_amount, amount_adjusted: true })
        .eq('id', sub.id);
      result.plan_amount_fix.succeeded += 1;
    } catch (err) {
      const message =
        err instanceof XenditError
          ? `${err.status}: ${err.body}`.slice(0, 500)
          : String(err).slice(0, 500);
      result.plan_amount_fix.failed += 1;
      result.plan_amount_fix.errors.push(`subscription ${sub.id}: ${message}`);
    }
  }

  // 2. Retry failed customer tag operations
  const { data: brokenTagSubs } = await admin
    .from('subscriptions')
    .select('id, shopify_customer_id, status, plan_code')
    .eq('shopify_tag_status', 'FAILED')
    .limit(MAX_RETRIES_PER_RUN);

  for (const sub of brokenTagSubs ?? []) {
    result.tag_fix.attempted += 1;
    if (dryRun) continue;

    const tags = membershipTagsForPlan(sub.plan_code);
    const shouldHaveTag = sub.status === 'ACTIVE' || sub.status === 'PAST_DUE';
    try {
      if (shouldHaveTag) {
        await addCustomerTag(sub.shopify_customer_id, tags);
      } else {
        await removeCustomerTag(sub.shopify_customer_id, tags);
      }
      await admin
        .from('subscriptions')
        .update({
          shopify_tag_status: shouldHaveTag ? 'TAGGED' : 'UNTAGGED',
          shopify_tag_last_attempt_at: new Date().toISOString(),
          shopify_tag_error: null,
        })
        .eq('id', sub.id);
      result.tag_fix.succeeded += 1;
    } catch (err) {
      const message =
        err instanceof ShopifyError
          ? `${err.status}: ${err.body}`.slice(0, 500)
          : String(err).slice(0, 500);
      await admin
        .from('subscriptions')
        .update({
          shopify_tag_status: 'FAILED',
          shopify_tag_last_attempt_at: new Date().toISOString(),
          shopify_tag_error: message,
        })
        .eq('id', sub.id);
      result.tag_fix.failed += 1;
      result.tag_fix.errors.push(`subscription ${sub.id}: ${message}`);
    }
  }

  // 3. Clean up stale reservation rows from /api/subscribe that never made it
  //    to a real Xendit plan (customer abandoned checkout).
  const staleCutoff = new Date(
    Date.now() - STALE_RESERVATION_HOURS * 3600 * 1000,
  ).toISOString();
  const { data: stale } = await admin
    .from('subscriptions')
    .select('id')
    .eq('status', 'PENDING')
    .like('xendit_plan_id', 'pending-%')
    .lt('created_at', staleCutoff);

  result.reservation_cleanup.attempted = stale?.length ?? 0;
  if (!dryRun && stale?.length) {
    const ids = stale.map((s) => s.id);
    const { error: delErr } = await admin.from('subscriptions').delete().in('id', ids);
    if (!delErr) result.reservation_cleanup.succeeded = ids.length;
  }

  // 4. Purge old fully-processed webhook events (90-day retention)
  if (!dryRun) {
    const { data: purgedCount, error: purgeErr } = await admin.rpc('purge_old_webhook_events', {
      p_retention_days: 90,
    });
    if (purgeErr) {
      log.warn('reconcile.purge_failed', { error: purgeErr.message });
    } else {
      result.webhook_retention.purged = (purgedCount as number) ?? 0;
    }
  }

  if (
    result.invoice_sync.failed > 0 ||
    result.invoice_sync.dead_lettered > 0 ||
    result.checkout_order_sync.failed > 0 ||
    result.checkout_order_sync.dead_lettered > 0 ||
    result.plan_amount_fix.failed > 0 ||
    result.tag_fix.failed > 0
  ) {
    log.warn('reconcile.backlog_remaining', { ...result });
    if (!dryRun) {
      alert('Reconcile run completed with failures', {
        invoice_failed: result.invoice_sync.failed,
        invoice_dead: result.invoice_sync.dead_lettered,
        checkout_failed: result.checkout_order_sync.failed,
        checkout_dead: result.checkout_order_sync.dead_lettered,
        plan_amount_failed: result.plan_amount_fix.failed,
        tag_failed: result.tag_fix.failed,
      }).catch(() => {});
    }
  }

  if (!dryRun) {
    audit({
      action: 'reconcile.run',
      actor,
      details: {
        invoice_sync: result.invoice_sync,
        checkout_order_sync: result.checkout_order_sync,
        plan_amount_fix: result.plan_amount_fix,
        tag_fix: result.tag_fix,
        reservation_cleanup: result.reservation_cleanup,
        webhook_retention: result.webhook_retention,
      },
    });
  }

  return result;
}
