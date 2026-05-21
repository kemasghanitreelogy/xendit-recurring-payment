import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { deactivateRecurringPlan, XenditError } from '@/lib/xendit';
import { verifyAppProxy } from '@/lib/shopify-proxy';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/subscription/cancel
 *
 * Called via Shopify App Proxy. Verifies HMAC + logged_in_customer_id, then
 * deactivates the customer's current Xendit plan. Accepted statuses: ACTIVE,
 * PAST_DUE, and PENDING — PENDING is included so a customer who abandoned
 * the hosted checkout can free up the partial-unique slot before retrying.
 *
 * Status update in our DB happens via the recurring.plan.inactivated webhook
 * (single write path = single source of truth). For PENDING subs (where the
 * Xendit plan may not yet have been "activated"), Xendit's deactivate call
 * still works and fires the same webhook.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const ctx = verifyAppProxy(url.searchParams);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  if (ctx.shopDomain && ctx.shopDomain !== env.SHOPIFY_STORE_DOMAIN) {
    return NextResponse.json({ error: 'Shop mismatch' }, { status: 403 });
  }
  if (!ctx.shopifyCustomerId) {
    return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
  }

  const admin = createAdminClient();

  try {
    const { data: sub } = await admin
      .from('subscriptions')
      .select('id, xendit_plan_id, status')
      .eq('shopify_customer_id', ctx.shopifyCustomerId)
      .in('status', ['ACTIVE', 'PAST_DUE', 'PENDING'])
      .maybeSingle();

    if (!sub) {
      return NextResponse.json({ error: 'No active subscription' }, { status: 404 });
    }

    // If this is a reservation row (placeholder Xendit IDs from /api/subscribe),
    // there's no real Xendit plan to deactivate — just delete the row so the
    // customer can resubscribe immediately.
    if (sub.xendit_plan_id.startsWith('pending-')) {
      await admin.from('subscriptions').delete().eq('id', sub.id);
      return NextResponse.json({ ok: true, was: 'reservation' });
    }

    await deactivateRecurringPlan(sub.xendit_plan_id);
    // Status flip + customer untag happens in the webhook handler when
    // Xendit fires recurring.plan.inactivated. Don't double-write here.

    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error('cancel.error', { error: String(err).slice(0, 500) });
    if (err instanceof XenditError) {
      return NextResponse.json({ error: 'Payment provider error' }, { status: 502 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
