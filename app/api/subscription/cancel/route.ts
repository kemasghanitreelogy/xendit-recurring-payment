import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { deactivateRecurringPlan, XenditError } from '@/lib/xendit';
import { verifyAppProxy } from '@/lib/shopify-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/subscription/cancel
 *
 * Called via Shopify App Proxy. Verifies HMAC + logged_in_customer_id,
 * then deactivates the customer's active Xendit plan. Status update
 * in our DB happens via the recurring.plan.inactivated webhook
 * (single write path = single source of truth).
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const ctx = verifyAppProxy(url.searchParams);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
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
      .in('status', ['ACTIVE', 'PAST_DUE'])
      .maybeSingle();

    if (!sub) {
      return NextResponse.json({ error: 'No active subscription' }, { status: 404 });
    }

    await deactivateRecurringPlan(sub.xendit_plan_id);
    // Status flip + customer untag happens in the webhook handler when
    // Xendit fires recurring.plan.inactivated. Don't double-write here.

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[/api/subscription/cancel] error:', err);
    if (err instanceof XenditError) {
      return NextResponse.json({ error: 'Payment provider error' }, { status: 502 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
