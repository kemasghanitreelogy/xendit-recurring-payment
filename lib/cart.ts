// ============================================================
// Cart payload schema + classification
//
// Theme posts a JSON body to /apps/xendit/checkout containing the
// /cart.js contents. We DO NOT trust the body for unit prices — every
// line item is validated against the Shopify Admin API before any
// Xendit object is created.
//
// Cart types:
//   PURE_ONETIME      every line item has no selling_plan_id
//   PURE_SUBSCRIPTION every line item has a selling_plan_id
//   MIXED             some line items have a selling_plan_id, some don't
//
// MIXED carts are billed as a single Xendit Recurring Plan whose first
// cycle bundles subscription + one-time items; after cycle 1 succeeds
// the plan amount is mutated down to the subscription-only total (see
// /api/webhook/xendit, `recurring.cycle.succeeded`).
// ============================================================

import type { ShopifyVariantInfo } from './shopify';

export type IncomingLineItem = {
  variant_id: string | number;
  quantity: number;
  // null/undefined = one-time; numeric ID (Shopify Subscriptions native) = subscription
  selling_plan_id?: string | number | null;
};

export type CartType = 'PURE_ONETIME' | 'PURE_SUBSCRIPTION' | 'MIXED';

export type ValidatedLineItem = {
  variantId: string;
  productId: string;
  quantity: number;
  unitPrice: number;            // IDR, from Shopify (authoritative)
  lineTotal: number;            // unitPrice * quantity
  title: string;
  isSubscription: boolean;
  sellingPlanId: string | null;
  requiresShipping: boolean;
  taxable: boolean;
  imageUrl: string | null;
};

export type ValidatedCart = {
  type: CartType;
  lineItems: ValidatedLineItem[];
  subscriptionItems: ValidatedLineItem[];
  onetimeItems: ValidatedLineItem[];
  subscriptionTotal: number;    // sum of subscription line totals
  onetimeTotal: number;         // sum of one-time line totals
  grandTotal: number;
  currency: string;
};

export type CartValidationError = {
  code:
    | 'EMPTY_CART'
    | 'BAD_QUANTITY'
    | 'BAD_VARIANT'
    | 'VARIANT_NOT_FOUND'
    | 'SELLING_PLAN_NOT_ALLOWED'
    | 'CURRENCY_MISMATCH'
    | 'AMOUNT_TOO_SMALL';
  message: string;
  detail?: Record<string, unknown>;
};

const XENDIT_MIN_AMOUNT_IDR = 10_000; // Xendit Invoice/Recurring minimum

/**
 * Parse the raw `line_items` array from the theme into a typed shape.
 * Returns null if the payload is structurally invalid (e.g. not an array,
 * missing required fields).
 *
 * No external calls here — only shape validation. Use `validateCart` for
 * price/variant validation against Shopify.
 */
export function parseLineItems(raw: unknown): IncomingLineItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: IncomingLineItem[] = [];
  for (const li of raw) {
    if (typeof li !== 'object' || li === null) return null;
    const r = li as Record<string, unknown>;
    const variantId = r.variant_id ?? r.id;
    const quantity = Number(r.quantity);
    if ((typeof variantId !== 'string' && typeof variantId !== 'number') || !variantId) {
      return null;
    }
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) {
      return null;
    }
    const spRaw = r.selling_plan_id ?? r.selling_plan ?? null;
    let sellingPlanId: string | number | null = null;
    if (typeof spRaw === 'string' || typeof spRaw === 'number') {
      sellingPlanId = spRaw === '' ? null : spRaw;
    } else if (spRaw && typeof spRaw === 'object') {
      // /cart.js puts the plan under `selling_plan_allocation.selling_plan.id`
      const inner = (spRaw as Record<string, unknown>).id;
      if (typeof inner === 'string' || typeof inner === 'number') sellingPlanId = inner;
    }
    out.push({
      variant_id: variantId,
      quantity,
      selling_plan_id: sellingPlanId,
    });
  }
  return out;
}

/**
 * Validate the incoming cart against Shopify-supplied variant info.
 *
 * Caller is expected to have fetched all variants via getVariantsByIds()
 * and pass them as `variants`. We cross-check by variant ID, use the
 * Shopify-supplied price (authoritative), and confirm any selling_plan_id
 * is actually allowed on that variant.
 */
export function validateCart(
  items: IncomingLineItem[],
  variants: ShopifyVariantInfo[],
): { ok: true; cart: ValidatedCart } | { ok: false; error: CartValidationError } {
  if (items.length === 0) {
    return { ok: false, error: { code: 'EMPTY_CART', message: 'Cart is empty' } };
  }

  const byVariant = new Map(variants.map((v) => [v.variantId, v]));
  let currency: string | null = null;

  const validated: ValidatedLineItem[] = [];
  for (const item of items) {
    const variantId = String(item.variant_id);
    const v = byVariant.get(variantId);
    if (!v) {
      return {
        ok: false,
        error: {
          code: 'VARIANT_NOT_FOUND',
          message: `Variant ${variantId} not found in Shopify`,
          detail: { variantId },
        },
      };
    }

    if (currency && currency !== v.currencyCode) {
      return {
        ok: false,
        error: {
          code: 'CURRENCY_MISMATCH',
          message: `Mixed currencies in cart: ${currency} and ${v.currencyCode}`,
        },
      };
    }
    currency = v.currencyCode;

    const sellingPlanId = item.selling_plan_id == null ? null : String(item.selling_plan_id);
    if (sellingPlanId && !v.sellingPlanIds.includes(sellingPlanId)) {
      return {
        ok: false,
        error: {
          code: 'SELLING_PLAN_NOT_ALLOWED',
          message: `Selling plan ${sellingPlanId} not allowed on variant ${variantId}`,
          detail: { variantId, sellingPlanId, allowed: v.sellingPlanIds },
        },
      };
    }

    const lineTotal = v.price * item.quantity;
    validated.push({
      variantId,
      productId: v.productId,
      quantity: item.quantity,
      unitPrice: v.price,
      lineTotal,
      title: v.title,
      isSubscription: !!sellingPlanId,
      sellingPlanId,
      requiresShipping: v.requiresShipping,
      taxable: v.taxable,
      imageUrl: v.imageUrl,
    });
  }

  const subscriptionItems = validated.filter((li) => li.isSubscription);
  const onetimeItems = validated.filter((li) => !li.isSubscription);
  const subscriptionTotal = subscriptionItems.reduce((s, li) => s + li.lineTotal, 0);
  const onetimeTotal = onetimeItems.reduce((s, li) => s + li.lineTotal, 0);
  const grandTotal = subscriptionTotal + onetimeTotal;

  let type: CartType;
  if (subscriptionItems.length === 0) type = 'PURE_ONETIME';
  else if (onetimeItems.length === 0) type = 'PURE_SUBSCRIPTION';
  else type = 'MIXED';

  if (grandTotal < XENDIT_MIN_AMOUNT_IDR) {
    return {
      ok: false,
      error: {
        code: 'AMOUNT_TOO_SMALL',
        message: `Cart total ${grandTotal} below Xendit minimum ${XENDIT_MIN_AMOUNT_IDR}`,
        detail: { grandTotal, min: XENDIT_MIN_AMOUNT_IDR },
      },
    };
  }

  return {
    ok: true,
    cart: {
      type,
      lineItems: validated,
      subscriptionItems,
      onetimeItems,
      subscriptionTotal,
      onetimeTotal,
      grandTotal,
      currency: currency ?? 'IDR',
    },
  };
}

/**
 * Assert that all subscription items in a MIXED or PURE_SUBSCRIPTION cart
 * share the same billing interval. Xendit Recurring is one schedule per
 * plan — a cart with "deliver monthly" + "deliver every 3 months" can't
 * be billed as a single recurring object.
 *
 * Returns null if uniform (or no subscription items). Returns the first
 * conflicting pair if not.
 */
export function assertUniformSubscriptionInterval(
  items: ValidatedLineItem[],
  sellingPlans: Map<string, { interval: string; intervalCount: number }>,
): { interval: string; intervalCount: number } | null {
  const subs = items.filter((li) => li.isSubscription && li.sellingPlanId);
  if (subs.length === 0) return null;

  const first = sellingPlans.get(subs[0].sellingPlanId!);
  if (!first) return null;

  for (const li of subs.slice(1)) {
    const sp = sellingPlans.get(li.sellingPlanId!);
    if (!sp) continue;
    if (sp.interval !== first.interval || sp.intervalCount !== first.intervalCount) {
      return null;
    }
  }
  return first;
}
