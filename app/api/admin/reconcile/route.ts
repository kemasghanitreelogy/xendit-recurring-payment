import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  createPaidOrder,
  addCustomerTag,
  removeCustomerTag,
  ShopifyError,
} from '@/lib/shopify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MEMBER_TAG = 'pro-member';
const MAX_RETRIES_PER_RUN = 50;       // cap per invocation to bound runtime

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Admin reconciliation endpoint.
 *
 * Auth: Bearer token matching ADMIN_RECONCILE_TOKEN. Constant-time compare.
 *
 * GET  /api/admin/reconcile         → audit report (counts of failed/pending syncs)
 * POST /api/admin/reconcile         → retry failed Shopify order syncs + tag fixes
 * POST /api/admin/reconcile?dry=1   → report what would be retried, do nothing
 *
 * Safe to call repeatedly. Operations are idempotent:
 *   - Order creation deduped by xendit_cycle_id tag on Shopify side
 *   - Tag add/remove is naturally idempotent in Shopify
 */

function authorize(req: Request): boolean {
  const expected = process.env.ADMIN_RECONCILE_TOKEN;
  if (!expected) return false;

  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  if (!provided) return false;

  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8')
  );
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  const { count: pendingInvoices } = await admin
    .from('subscription_invoices')
    .select('id', { count: 'exact', head: true })
    .in('shopify_sync_status', ['PENDING', 'FAILED'])
    .eq('status', 'SUCCEEDED');

  const { count: failedTags } = await admin
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('shopify_tag_status', 'FAILED');

  return NextResponse.json({
    invoices_needing_sync: pendingInvoices ?? 0,
    subscriptions_with_failed_tag: failedTags ?? 0,
  });
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const admin = createAdminClient();

  const result = {
    dry_run: dryRun,
    invoice_sync: { attempted: 0, succeeded: 0, failed: 0, errors: [] as string[] },
    tag_fix: { attempted: 0, succeeded: 0, failed: 0, errors: [] as string[] },
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
      // Fetch full subscription row for the fields createPaidOrder needs
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
    .select('id, shopify_customer_id, status')
    .eq('shopify_tag_status', 'FAILED')
    .limit(MAX_RETRIES_PER_RUN);

  for (const sub of brokenTagSubs ?? []) {
    result.tag_fix.attempted += 1;
    if (dryRun) continue;

    const shouldHaveTag = sub.status === 'ACTIVE' || sub.status === 'PAST_DUE';
    try {
      if (shouldHaveTag) {
        await addCustomerTag(sub.shopify_customer_id, MEMBER_TAG);
      } else {
        await removeCustomerTag(sub.shopify_customer_id, MEMBER_TAG);
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

  return NextResponse.json(result);
}
