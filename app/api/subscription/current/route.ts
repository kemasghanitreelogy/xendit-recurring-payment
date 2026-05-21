import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAppProxy } from '@/lib/shopify-proxy';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InvoiceRow = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  payment_method: string | null;
  paid_at: string | null;
  created_at: string;
  shopify_order_id: string | null;
  shopify_order_name: string | null;
  shopify_sync_status: string;
};

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
  if (ctx.shopDomain && ctx.shopDomain !== env.SHOPIFY_STORE_DOMAIN) {
    return NextResponse.json({ error: 'Shop mismatch' }, { status: 403 });
  }
  if (!ctx.shopifyCustomerId) {
    return NextResponse.json({ subscription: null, invoices: [] });
  }

  const admin = createAdminClient();

  const { data: sub } = await admin
    .from('subscriptions')
    .select(
      'id, plan_code, status, amount, currency, interval, current_period_start, current_period_end, canceled_at, metadata, created_at',
    )
    .eq('shopify_customer_id', ctx.shopifyCustomerId)
    .in('status', ['ACTIVE', 'PAST_DUE', 'PENDING'])
    .order('created_at', { ascending: false })
    .maybeSingle();

  let invoices: InvoiceRow[] = [];
  if (sub) {
    const { data: rows } = await admin
      .from('subscription_invoices')
      .select(
        'id, amount, currency, status, payment_method, paid_at, created_at, shopify_order_id, shopify_order_name, shopify_sync_status',
      )
      .eq('subscription_id', sub.id)
      .order('created_at', { ascending: false })
      .limit(12);
    invoices = (rows ?? []) as InvoiceRow[];
  }

  return NextResponse.json({ subscription: sub, invoices });
}
