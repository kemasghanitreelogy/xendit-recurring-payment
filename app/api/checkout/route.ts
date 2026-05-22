import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  createOrGetCustomer,
  createRecurringPlan,
  deactivateRecurringPlan,
  XenditError,
} from '@/lib/xendit';
import { verifyAppProxy } from '@/lib/shopify-proxy';
import {
  getCustomer,
  getVariantsByIds,
  getSellingPlansByIds,
  ShopifyError,
} from '@/lib/shopify';
import {
  parseLineItems,
  validateCart,
  assertUniformSubscriptionInterval,
  type ValidatedCart,
} from '@/lib/cart';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { consumeRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/checkout
 *
 * Cart-based checkout entry point. Called from the Shopify theme via the
 * App Proxy (so query params are HMAC-signed and `logged_in_customer_id`
 * can be trusted). The REQUEST BODY is NOT signed — every price and
 * selling-plan claim is validated against the Shopify Admin API before
 * any Xendit object is created.
 *
 * Currently supported cart types:
 *   PURE_SUBSCRIPTION → Xendit Recurring Plan (sub_total)     → subscriptions
 *   MIXED             → Xendit Recurring Plan
 *                       cycle 1 amount = sub + onetime
 *                       cycle 2+       = sub only (PATCHed after cycle 1 webhook)
 *                                                             → subscriptions
 *
 * Pure-one-time carts are deliberately rejected with `USE_NATIVE_CHECKOUT`
 * so the theme can fall back to Shopify's native checkout. Reason: the
 * Xendit invoice webhook URL at this store is already wired to a different
 * backend (api.treelogy.com), and Xendit allows only one URL per event
 * type. Adding a second invoice consumer here would clash with that
 * existing integration, and one-time payments don't need recurring
 * primitives anyway. The invoice handler in /api/webhook/xendit and the
 * checkout_orders table are kept as dormant code for a future split.
 *
 * Response: 200 JSON { redirect_url: "https://checkout.xendit.co/..." }.
 * The theme reads `redirect_url` and `window.location.assign()`s it.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  // 1. App Proxy signature — proves the request was forwarded by Shopify.
  const ctx = verifyAppProxy(params);
  if (!ctx) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  if (ctx.shopDomain && ctx.shopDomain !== env.SHOPIFY_STORE_DOMAIN) {
    log.warn('checkout.shop_mismatch', {
      received: ctx.shopDomain,
      expected: env.SHOPIFY_STORE_DOMAIN,
    });
    return NextResponse.json({ error: 'Shop mismatch' }, { status: 403 });
  }

  if (!ctx.shopifyCustomerId) {
    return NextResponse.json(
      { error: 'Login required', login_url: `https://${ctx.shopDomain}/account/login` },
      { status: 401 },
    );
  }

  // 2. Per-customer rate limit. Tighter than /subscribe because this
  //    endpoint does more work (Shopify lookups + Xendit object creation).
  const rl = await consumeRateLimit(`checkout:${ctx.shopifyCustomerId}`, {
    capacity: 5,
    refillPerSec: 0.1,
  });
  if (!rl.allowed) {
    log.warn('checkout.rate_limited', { shopifyCustomerId: ctx.shopifyCustomerId });
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // 3. Parse body. App Proxy does NOT sign the body, so we have to
  //    treat every field as untrusted and validate against Shopify.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const bodyObj = (body ?? {}) as Record<string, unknown>;
  const rawItems = (bodyObj.line_items ?? bodyObj.items) as unknown;
  const items = parseLineItems(rawItems);
  if (!items || items.length === 0) {
    return NextResponse.json({ error: 'Missing or invalid line_items' }, { status: 400 });
  }

  // 4. Fetch variant info (authoritative prices + allowed selling plans).
  const variantIds = items.map((i) => String(i.variant_id));
  let variants;
  try {
    variants = await getVariantsByIds(variantIds);
  } catch (err) {
    log.error('checkout.variants_fetch_failed', { error: String(err).slice(0, 500) });
    return NextResponse.json({ error: 'Failed to load product catalog' }, { status: 502 });
  }

  const validation = validateCart(items, variants);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error.message, code: validation.error.code, detail: validation.error.detail },
      { status: 400 },
    );
  }
  const cart = validation.cart;

  // 4a. Pure one-time carts route to native Shopify checkout — see the file
  //     header for why. We fail FAST here, before any Xendit calls, so the
  //     theme can redirect without latency.
  if (cart.type === 'PURE_ONETIME') {
    log.info('checkout.pure_onetime_redirect_to_native', {
      shopifyCustomerId: ctx.shopifyCustomerId,
      itemCount: cart.lineItems.length,
      grandTotal: cart.grandTotal,
    });
    return NextResponse.json(
      {
        error: 'One-time carts use Shopify native checkout',
        code: 'USE_NATIVE_CHECKOUT',
        native_checkout_path: '/checkout',
      },
      { status: 400 },
    );
  }

  // 5. For carts with subscription items, fetch all selling plans and
  //    enforce a uniform billing interval (Xendit Recurring = one schedule
  //    per plan).
  let recurringSchedule: { interval: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'; intervalCount: number } | null = null;
  if (cart.subscriptionItems.length > 0) {
    const sellingPlanIds = [
      ...new Set(cart.subscriptionItems.map((li) => li.sellingPlanId!).filter(Boolean)),
    ];
    let plans;
    try {
      plans = await getSellingPlansByIds(sellingPlanIds);
    } catch (err) {
      log.error('checkout.selling_plans_fetch_failed', { error: String(err).slice(0, 500) });
      return NextResponse.json({ error: 'Failed to load selling plans' }, { status: 502 });
    }
    if (plans.length === 0) {
      return NextResponse.json(
        { error: 'Selling plan not found', code: 'SELLING_PLAN_NOT_FOUND' },
        { status: 400 },
      );
    }
    const planMap = new Map(plans.map((p) => [p.id, p]));
    const uniform = assertUniformSubscriptionInterval(cart.subscriptionItems, planMap);
    if (!uniform) {
      return NextResponse.json(
        {
          error:
            'Subscription items in cart have different billing intervals. ' +
            'Please checkout one subscription frequency at a time.',
          code: 'MIXED_INTERVALS',
        },
        { status: 400 },
      );
    }
    recurringSchedule = { interval: uniform.interval as never, intervalCount: uniform.intervalCount };
  }

  // 6. Resolve Shopify customer details (for email + Xendit customer setup).
  let shopifyCustomer;
  try {
    shopifyCustomer = await getCustomer(ctx.shopifyCustomerId);
  } catch (err) {
    log.error('checkout.shopify_customer_failed', { error: String(err).slice(0, 500) });
    return NextResponse.json({ error: 'Failed to load customer' }, { status: 502 });
  }
  const givenName = shopifyCustomer.first_name ?? shopifyCustomer.email.split('@')[0];
  const surname = shopifyCustomer.last_name ?? undefined;

  // 7. Create/get Xendit customer.
  let xenditCustomer;
  try {
    xenditCustomer = await createOrGetCustomer({
      referenceId: `shopify-${ctx.shopifyCustomerId}`,
      email: shopifyCustomer.email,
      givenName,
      surname,
    });
  } catch (err) {
    log.error('checkout.xendit_customer_failed', { error: String(err).slice(0, 500) });
    if (err instanceof XenditError) {
      return NextResponse.json(
        { error: `Payment provider error (${err.code ?? err.status})` },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: 'Payment setup failed' }, { status: 502 });
  }

  const appUrl = env.APP_URL;
  const supabase = createAdminClient();
  const shopDomain = ctx.shopDomain || env.SHOPIFY_STORE_DOMAIN;

  // Persist the validated cart on the DB row so the webhook handlers can
  // rebuild Shopify line items without re-fetching anything from the theme.
  const cartSnapshot = {
    type: cart.type,
    line_items: cart.lineItems.map((li) => ({
      variant_id: li.variantId,
      product_id: li.productId,
      quantity: li.quantity,
      unit_price: li.unitPrice,
      title: li.title,
      is_subscription: li.isSubscription,
      selling_plan_id: li.sellingPlanId,
      requires_shipping: li.requiresShipping,
      taxable: li.taxable,
      image_url: li.imageUrl,
    })),
    subscription_total: cart.subscriptionTotal,
    onetime_total: cart.onetimeTotal,
    grand_total: cart.grandTotal,
    currency: cart.currency,
    shop_domain: shopDomain,
  };

  // 8. Dispatch — only reachable for PURE_SUBSCRIPTION and MIXED. PURE_ONETIME
  //    was redirected to native checkout above, so recurringSchedule must be set.
  if (!recurringSchedule) {
    return NextResponse.json({ error: 'Internal cart classification error' }, { status: 500 });
  }

  try {
    return await handleSubscription(supabase, {
      shopifyCustomer,
      ctx,
      xenditCustomer,
      cart,
      cartSnapshot,
      schedule: recurringSchedule,
      appUrl,
    });
  } catch (err) {
    log.error('checkout.dispatch_failed', { error: String(err).slice(0, 500) });
    if (err instanceof XenditError) {
      return NextResponse.json(
        { error: `Payment provider error (${err.code ?? err.status})` },
        { status: 502 },
      );
    }
    if (err instanceof ShopifyError) {
      return NextResponse.json({ error: `Shopify error (${err.status})` }, { status: 502 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ============================================================
// PURE_SUBSCRIPTION + MIXED — Xendit Recurring Plan
// ============================================================

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

async function handleSubscription(
  supabase: SupabaseAdmin,
  args: {
    shopifyCustomer: Awaited<ReturnType<typeof getCustomer>>;
    ctx: NonNullable<ReturnType<typeof verifyAppProxy>>;
    xenditCustomer: Awaited<ReturnType<typeof createOrGetCustomer>>;
    cart: ValidatedCart;
    cartSnapshot: Record<string, unknown>;
    schedule: { interval: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'; intervalCount: number };
    appUrl: string;
  },
): Promise<NextResponse> {
  const { shopifyCustomer, ctx, xenditCustomer, cart, cartSnapshot, schedule, appUrl } = args;
  const cartType: 'PURE_SUBSCRIPTION' | 'MIXED' =
    cart.type === 'MIXED' ? 'MIXED' : 'PURE_SUBSCRIPTION';

  // First-cycle amount: bundle subscription + one-time. After cycle 1
  // succeeds, the webhook PATCHes the plan amount to subscription_total
  // for cycles 2+.
  const firstCycleAmount = cart.grandTotal;
  const recurringAmount = cart.subscriptionTotal;

  // Reserve a PENDING row first so the partial-unique-active-sub index
  // rejects concurrent double-clicks immediately.
  const reservationId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const { data: reservation, error: reserveErr } = await supabase
    .from('subscriptions')
    .insert({
      shopify_customer_id: ctx.shopifyCustomerId,
      shopify_customer_email: `placeholder-${reservationId}@reserved.local`,
      xendit_customer_id: reservationId,
      xendit_plan_id: reservationId,
      xendit_reference_id: reservationId,
      plan_code: 'cart',
      amount: firstCycleAmount,
      currency: cart.currency,
      interval: schedule.interval,
      interval_count: schedule.intervalCount,
      status: 'PENDING',
      cart_type: cartType,
      cart_snapshot: cartSnapshot,
      subscription_amount: recurringAmount,
      onetime_amount: cart.onetimeTotal,
      amount_adjusted: cartType === 'PURE_SUBSCRIPTION',
      metadata: { shop_domain: ctx.shopDomain, reservation: true },
    })
    .select('id')
    .single();

  if (reserveErr) {
    if (reserveErr.code === '23505') {
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('shopify_customer_id', ctx.shopifyCustomerId)
        .in('status', ['ACTIVE', 'PAST_DUE', 'PENDING'])
        .maybeSingle();
      return NextResponse.json(
        {
          error: 'You already have a subscription in progress',
          code: 'DUPLICATE_SUBSCRIPTION',
          status: existing?.status ?? 'PENDING',
        },
        { status: 409 },
      );
    }
    log.error('checkout.reserve_failed', { error: reserveErr.message });
    return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
  }

  const rollback = async () => {
    await supabase.from('subscriptions').delete().eq('id', reservation.id);
  };

  const referenceId = `sub-${ctx.shopifyCustomerId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  let xenditPlan;
  try {
    xenditPlan = await createRecurringPlan({
      customerId: xenditCustomer.id,
      referenceId,
      amount: firstCycleAmount,
      currency: cart.currency,
      interval: schedule.interval,
      intervalCount: schedule.intervalCount,
      description:
        cartType === 'MIXED'
          ? `First charge: ${cart.subscriptionItems.length} subscription + ${cart.onetimeItems.length} one-time items. Renews at ${recurringAmount} ${cart.currency}/${schedule.interval.toLowerCase()}.`
          : `${cart.subscriptionItems.length} subscription items, ${recurringAmount} ${cart.currency}/${schedule.interval.toLowerCase()}.`,
      successUrl: `${appUrl}/billing/success?type=${cartType.toLowerCase()}&ref=${referenceId}`,
      failureUrl: `${appUrl}/billing/failed?type=${cartType.toLowerCase()}&ref=${referenceId}`,
      items: cart.lineItems.map((li) => ({
        type: 'PHYSICAL_PRODUCT',
        name: li.title,
        net_unit_amount: li.unitPrice,
        quantity: li.quantity,
        url: li.imageUrl ?? undefined,
      })),
      metadata: {
        shopify_customer_id: ctx.shopifyCustomerId!,
        cart_type: cartType,
      },
    });
  } catch (err) {
    await rollback();
    throw err;
  }

  const checkoutAction = xenditPlan.actions?.find((a) => a.url_type === 'WEB');
  if (!checkoutAction) {
    log.error('checkout.no_checkout_url', { planId: xenditPlan.id });
    await deactivateRecurringPlan(xenditPlan.id).catch(() => {});
    await rollback();
    return NextResponse.json({ error: 'No checkout URL returned' }, { status: 502 });
  }

  const { error: promoteErr } = await supabase
    .from('subscriptions')
    .update({
      shopify_customer_email: shopifyCustomer.email,
      shopify_customer_name:
        [shopifyCustomer.first_name, shopifyCustomer.last_name].filter(Boolean).join(' ') || null,
      xendit_customer_id: xenditCustomer.id,
      xendit_plan_id: xenditPlan.id,
      xendit_reference_id: referenceId,
      metadata: { shop_domain: ctx.shopDomain, cart_type: cartType },
    })
    .eq('id', reservation.id);

  if (promoteErr) {
    log.error('checkout.promote_failed', { error: promoteErr.message });
    await deactivateRecurringPlan(xenditPlan.id).catch(() => {});
    await rollback();
    return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
  }

  return NextResponse.json({
    redirect_url: checkoutAction.url,
    xendit_plan_id: xenditPlan.id,
    type: cartType.toLowerCase(),
    first_cycle_amount: firstCycleAmount,
    recurring_amount: recurringAmount,
    interval: schedule.interval,
    interval_count: schedule.intervalCount,
  });
}
