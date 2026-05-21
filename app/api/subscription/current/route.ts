import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAppProxy } from '@/lib/shopify-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/subscription/current
 *
 * Called via Shopify App Proxy from the Shopify customer account page
 * (Liquid template) to render subscription status + invoices.
 * Returns null subscription if the customer has none.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ctx = verifyAppProxy(url.searchParams);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  if (!ctx.shopifyCustomerId) {
    return NextResponse.json({ subscription: null, invoices: [] });
  }

  const admin = createAdminClient();

  const { data: sub } = await admin
    .from('subscriptions')
    .select(
      'id, plan_code, status, amount, currency, interval, current_period_start, current_period_end, canceled_at, metadata, created_at'
    )
    .eq('shopify_customer_id', ctx.shopifyCustomerId)
    .in('status', ['ACTIVE', 'PAST_DUE', 'PENDING'])
    .order('created_at', { ascending: false })
    .maybeSingle();

  let invoices: any[] = [];
  if (sub) {
    const { data: rows } = await admin
      .from('subscription_invoices')
      .select(
        'id, amount, currency, status, payment_method, paid_at, created_at, shopify_order_id, shopify_order_name, shopify_sync_status'
      )
      .eq('subscription_id', sub.id)
      .order('created_at', { ascending: false })
      .limit(12);
    invoices = rows ?? [];
  }

  return NextResponse.json({ subscription: sub, invoices });
}
