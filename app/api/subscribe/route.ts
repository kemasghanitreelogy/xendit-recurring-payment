import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  createOrGetCustomer,
  createRecurringPlan,
  deactivateRecurringPlan,
  XenditError,
} from '@/lib/xendit';
import { getPlan } from '@/lib/plans';
import { verifyAppProxy } from '@/lib/shopify-proxy';
import { getCustomer, ShopifyError } from '@/lib/shopify';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { consumeRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/subscribe?plan_code=pro_monthly
 *
 * Called via Shopify App Proxy. Shopify injects: shop, path_prefix, timestamp,
 * logged_in_customer_id, signature. We verify the signature, look up the
 * Shopify customer, create a Xendit recurring plan, and 302 to the Xendit
 * hosted checkout page.
 *
 * Concurrency model:
 *   We RESERVE a subscription row (status=PENDING, placeholder external IDs)
 *   BEFORE calling Xendit so the partial-unique index on shopify_customer_id
 *   blocks the second concurrent click immediately. Only one tab will call
 *   Xendit and create a real plan; the other returns the "already subscribed"
 *   redirect. If Xendit subsequently fails, we delete the reservation so the
 *   customer can retry.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  // 1. Verify App Proxy signature (rejects unsigned or stale requests)
  const ctx = verifyAppProxy(params);
  if (!ctx) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  // 2. Fail loud on shop-domain mismatch — surfaces App Proxy misconfiguration
  //    (e.g. shared secret pasted into wrong store) immediately.
  if (ctx.shopDomain && ctx.shopDomain !== env.SHOPIFY_STORE_DOMAIN) {
    log.warn('subscribe.shop_mismatch', {
      received: ctx.shopDomain,
      expected: env.SHOPIFY_STORE_DOMAIN,
    });
    return new NextResponse('Shop mismatch', { status: 403 });
  }

  // 3. Require an authenticated Shopify customer
  if (!ctx.shopifyCustomerId) {
    return NextResponse.redirect(
      `https://${ctx.shopDomain}/account/login?return_url=/products`,
    );
  }

  // 3a. Per-customer rate-limit: prevents a logged-in user from accidentally
  //     (or maliciously) hammering the Xendit + Shopify APIs by holding the
  //     subscribe button. 5-burst, refill ~1 per 20s — generous for humans,
  //     tight for bots.
  const rl = await consumeRateLimit(`subscribe:${ctx.shopifyCustomerId}`, {
    capacity: 5,
    refillPerSec: 0.05,
  });
  if (!rl.allowed) {
    log.warn('subscribe.rate_limited', { shopifyCustomerId: ctx.shopifyCustomerId });
    return new NextResponse('Too many requests, please wait a moment', { status: 429 });
  }

  // 4. Validate plan
  const planCode = params.get('plan_code');
  const plan = getPlan(planCode ?? '');
  if (!plan) {
    return new NextResponse('Invalid plan code', { status: 400 });
  }

  const appUrl = env.APP_URL;
  const supabase = createAdminClient();

  const shopDomain = ctx.shopDomain || env.SHOPIFY_STORE_DOMAIN;
  const backToShopify = (qs: string) =>
    NextResponse.redirect(`https://${shopDomain}/account?${qs}`);

  // Placeholder IDs make the reservation row distinct from real Xendit data.
  // The `pending-…` prefix won't collide with real Xendit IDs (which start
  // with `repl_` / `cust-` etc.) and lets us identify abandoned reservations.
  const reservationId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // 5. Reserve a PENDING row first — the partial unique index will reject a
  //    concurrent second click immediately.
  const { data: reservation, error: reserveErr } = await supabase
    .from('subscriptions')
    .insert({
      shopify_customer_id: ctx.shopifyCustomerId,
      shopify_customer_email: `placeholder-${reservationId}@reserved.local`,
      xendit_customer_id: reservationId,
      xendit_plan_id: reservationId,
      xendit_reference_id: reservationId,
      plan_code: plan.code,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
      interval_count: plan.intervalCount,
      status: 'PENDING',
      metadata: { plan_name: plan.name, shop_domain: ctx.shopDomain, reservation: true },
    })
    .select('id, xendit_plan_id')
    .single();

  if (reserveErr) {
    // 23505 = unique violation → existing ACTIVE/PAST_DUE/PENDING sub
    if (reserveErr.code === '23505') {
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('shopify_customer_id', ctx.shopifyCustomerId)
        .in('status', ['ACTIVE', 'PAST_DUE', 'PENDING'])
        .maybeSingle();
      return backToShopify(`subscription=already&status=${existing?.status ?? 'PENDING'}`);
    }
    log.error('subscribe.reserve_failed', { error: reserveErr.message });
    return new NextResponse('Failed to save subscription', { status: 500 });
  }

  // Helper: roll back the reservation if anything downstream fails.
  const rollback = async () => {
    await supabase.from('subscriptions').delete().eq('id', reservation.id);
  };

  try {
    // 6. Fetch customer details from Shopify (for email + name)
    const shopifyCustomer = await getCustomer(ctx.shopifyCustomerId);
    const givenName =
      shopifyCustomer.first_name ?? shopifyCustomer.email.split('@')[0];
    const surname = shopifyCustomer.last_name ?? undefined;

    // 7. Create or fetch Xendit customer
    const xenditCustomer = await createOrGetCustomer({
      referenceId: `shopify-${ctx.shopifyCustomerId}`,
      email: shopifyCustomer.email,
      givenName,
      surname,
    });

    // 8. Create Xendit recurring plan
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

    const checkoutAction = xenditPlan.actions?.find((a) => a.url_type === 'WEB');
    if (!checkoutAction) {
      log.error('subscribe.no_checkout_url', { planId: xenditPlan.id });
      // Deactivate the orphaned plan so it doesn't sit in Xendit forever.
      await deactivateRecurringPlan(xenditPlan.id).catch(() => {});
      await rollback();
      return new NextResponse('No checkout URL', { status: 502 });
    }

    // 9. Promote the reservation to a real row with the actual Xendit IDs +
    //    customer details. We use UPDATE instead of INSERT so the partial
    //    unique index stays unchanged (still only one row per customer).
    const { error: updateErr } = await supabase
      .from('subscriptions')
      .update({
        shopify_customer_email: shopifyCustomer.email,
        shopify_customer_name:
          [shopifyCustomer.first_name, shopifyCustomer.last_name]
            .filter(Boolean)
            .join(' ') || null,
        xendit_customer_id: xenditCustomer.id,
        xendit_plan_id: xenditPlan.id,
        xendit_reference_id: referenceId,
        metadata: { plan_name: plan.name, shop_domain: ctx.shopDomain },
      })
      .eq('id', reservation.id);

    if (updateErr) {
      log.error('subscribe.promote_failed', { error: updateErr.message });
      await deactivateRecurringPlan(xenditPlan.id).catch(() => {});
      await rollback();
      return new NextResponse('Failed to save subscription', { status: 500 });
    }

    return NextResponse.redirect(checkoutAction.url);
  } catch (err) {
    await rollback();
    log.error('subscribe.error', { error: String(err).slice(0, 500) });
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
