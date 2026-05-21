import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createOrGetCustomer, createRecurringPlan, XenditError } from '@/lib/xendit';
import { getPlan } from '@/lib/plans';
import { verifyAppProxy } from '@/lib/shopify-proxy';
import { getCustomer, ShopifyError } from '@/lib/shopify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/subscribe?plan_code=pro_monthly
 *
 * This route is called via Shopify App Proxy, e.g.
 *   https://<store>.myshopify.com/apps/xendit/subscribe?plan_code=pro_monthly
 *
 * Shopify injects: shop, path_prefix, timestamp, logged_in_customer_id, signature.
 * We verify the signature, look up the Shopify customer, create a Xendit
 * recurring plan, and return a 302 redirect to the Xendit hosted checkout page.
 *
 * Idempotency:
 *   - If the customer already has an active/pending sub, return 302 to /billing/already.
 *   - The DB insert uses partial unique index on shopify_customer_id which
 *     prevents duplicate rows even under concurrent calls.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  // 1. Verify App Proxy signature (rejects unsigned or stale requests)
  const ctx = verifyAppProxy(params);
  if (!ctx) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  // 2. Require an authenticated Shopify customer
  if (!ctx.shopifyCustomerId) {
    return NextResponse.redirect(
      `https://${ctx.shopDomain}/account/login?return_url=/products`
    );
  }

  // 3. Validate plan
  const planCode = params.get('plan_code');
  const plan = getPlan(planCode ?? '');
  if (!plan) {
    return new NextResponse('Invalid plan code', { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const supabase = createAdminClient();

  // Helper: redirect customer back into the Shopify store. Falls back to
  // our /billing/already page if we couldn't verify the shop domain.
  const shopDomain = ctx.shopDomain || process.env.SHOPIFY_STORE_DOMAIN || '';
  const backToShopify = (qs: string) =>
    shopDomain
      ? NextResponse.redirect(`https://${shopDomain}/account?${qs}`)
      : NextResponse.redirect(`${appUrl}/billing/already?${qs}`);

  try {
    // 4. Reject duplicate active/pending subscription for this customer
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id, status, plan_code')
      .eq('shopify_customer_id', ctx.shopifyCustomerId)
      .in('status', ['ACTIVE', 'PAST_DUE', 'PENDING'])
      .maybeSingle();

    if (existing) {
      return backToShopify(`subscription=already&status=${existing.status}`);
    }

    // 5. Fetch customer details from Shopify (for email + name)
    const shopifyCustomer = await getCustomer(ctx.shopifyCustomerId);

    const givenName =
      shopifyCustomer.first_name ?? shopifyCustomer.email.split('@')[0];
    const surname = shopifyCustomer.last_name ?? undefined;

    // 6. Create or fetch Xendit customer (reference_id is stable per Shopify customer)
    const xenditCustomer = await createOrGetCustomer({
      referenceId: `shopify-${ctx.shopifyCustomerId}`,
      email: shopifyCustomer.email,
      givenName,
      surname,
    });

    // 7. Create Xendit recurring plan
    const referenceId = `sub-${ctx.shopifyCustomerId}-${Date.now()}`;
    const xenditPlan = await createRecurringPlan({
      customerId: xenditCustomer.id,
      referenceId,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      description: plan.description,
      successUrl: `${appUrl}/billing/success?plan=${plan.code}`,
      failureUrl: `${appUrl}/billing/failed?plan=${plan.code}`,
      trialDays: plan.trialDays,
    });

    // 8. Persist subscription as PENDING. Partial unique index prevents
    //    duplicate active subs even if user double-clicks.
    const { error: insertErr } = await supabase.from('subscriptions').insert({
      shopify_customer_id: ctx.shopifyCustomerId,
      shopify_customer_email: shopifyCustomer.email,
      shopify_customer_name:
        [shopifyCustomer.first_name, shopifyCustomer.last_name]
          .filter(Boolean)
          .join(' ') || null,
      xendit_customer_id: xenditCustomer.id,
      xendit_plan_id: xenditPlan.id,
      xendit_reference_id: referenceId,
      plan_code: plan.code,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
      interval_count: plan.intervalCount,
      status: 'PENDING',
      metadata: { plan_name: plan.name, shop_domain: ctx.shopDomain },
    });

    if (insertErr) {
      // 23505 = unique violation. Likely a concurrent request beat us;
      // surface a friendly redirect rather than 500.
      if (insertErr.code === '23505') {
        return backToShopify('subscription=already&status=PENDING');
      }
      console.error('[/api/subscribe] DB insert failed:', insertErr);
      return new NextResponse('Failed to save subscription', { status: 500 });
    }

    // 9. Find checkout URL from Xendit response
    const checkoutAction = xenditPlan.actions?.find((a) => a.url_type === 'WEB');
    if (!checkoutAction) {
      console.error('[/api/subscribe] No checkout URL from Xendit', xenditPlan);
      return new NextResponse('No checkout URL', { status: 502 });
    }

    return NextResponse.redirect(checkoutAction.url);
  } catch (err) {
    console.error('[/api/subscribe] error:', err);
    if (err instanceof XenditError) {
      return new NextResponse(`Payment provider error (${err.code ?? err.status})`, {
        status: 502,
      });
    }
    if (err instanceof ShopifyError) {
      return new NextResponse(`Shopify error (${err.status})`, { status: 502 });
    }
    return new NextResponse('Internal server error', { status: 500 });
  }
}
