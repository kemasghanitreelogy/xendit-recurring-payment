// Shared reconciliation logic used by both the operator-facing POST endpoint
// (`/api/admin/reconcile`) and the Vercel-Cron-triggered GET endpoint
// (`/api/admin/reconcile/cron`). Keeping the work here makes both surfaces
// behavior-equivalent and avoids divergent retry policy over time.

import {
  createPaidOrder,
  addCustomerTag,
  removeCustomerTag,
  ShopifyError,
} from '@/lib/shopify';
import { membershipTagsForPlan } from '@/lib/plans';
import { log, alert } from '@/lib/logger';
import type { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

export const MAX_RETRIES_PER_RUN = 200;
export const STALE_RESERVATION_HOURS = 24;

export type ReconcileResult = {
  dry_run: boolean;
  invoice_sync: { attempted: number; succeeded: number; failed: number; errors: string[] };
  tag_fix: { attempted: number; succeeded: number; failed: number; errors: string[] };
  reservation_cleanup: { attempted: number; succeeded: number };
};

export async function runReconcile(
  admin: Admin,
  opts: { dryRun: boolean },
): Promise<ReconcileResult> {
  const { dryRun } = opts;
  const result: ReconcileResult = {
    dry_run: dryRun,
    invoice_sync: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    tag_fix: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    reservation_cleanup: { attempted: 0, succeeded: 0 },
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
        .select('xendit_plan_id, metadata, plan_code')
        .eq('id', inv.subscription_id)
        .single();

      const order = await createPaidOrder({
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
      await admin
        .from('subscription_invoices')
        .update({
          shopify_sync_status: 'FAILED',
          shopify_sync_attempts: (inv.shopify_sync_attempts ?? 0) + 1,
          shopify_sync_error: message,
        })
        .eq('id', inv.id);
      result.invoice_sync.failed += 1;
      result.invoice_sync.errors.push(`invoice ${inv.id}: ${message}`);
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

  if (result.invoice_sync.failed > 0 || result.tag_fix.failed > 0) {
    log.warn('reconcile.backlog_remaining', { ...result });
    if (!dryRun) {
      alert('Reconcile run completed with failures', {
        invoice_failed: result.invoice_sync.failed,
        tag_failed: result.tag_fix.failed,
      }).catch(() => {});
    }
  }

  return result;
}
