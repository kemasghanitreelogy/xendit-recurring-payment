import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of lib/cart.ts. Pure functions, no I/O.
// Kept in sync with the TS source manually; any change to cart.ts must
// be mirrored here. See lib/__tests__/backoff.test.mjs for the same pattern.

const XENDIT_MIN_AMOUNT_IDR = 10_000;

function parseLineItems(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const li of raw) {
    if (typeof li !== 'object' || li === null) return null;
    const variantId = li.variant_id ?? li.id;
    const quantity = Number(li.quantity);
    if ((typeof variantId !== 'string' && typeof variantId !== 'number') || !variantId) {
      return null;
    }
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) {
      return null;
    }
    const spRaw = li.selling_plan_id ?? li.selling_plan ?? null;
    let sellingPlanId = null;
    if (typeof spRaw === 'string' || typeof spRaw === 'number') {
      sellingPlanId = spRaw === '' ? null : spRaw;
    } else if (spRaw && typeof spRaw === 'object') {
      const inner = spRaw.id;
      if (typeof inner === 'string' || typeof inner === 'number') sellingPlanId = inner;
    }
    out.push({ variant_id: variantId, quantity, selling_plan_id: sellingPlanId });
  }
  return out;
}

function validateCart(items, variants) {
  if (items.length === 0) {
    return { ok: false, error: { code: 'EMPTY_CART', message: 'Cart is empty' } };
  }
  const byVariant = new Map(variants.map((v) => [v.variantId, v]));
  let currency = null;
  const validated = [];
  for (const item of items) {
    const variantId = String(item.variant_id);
    const v = byVariant.get(variantId);
    if (!v) {
      return { ok: false, error: { code: 'VARIANT_NOT_FOUND', message: 'variant not found' } };
    }
    if (currency && currency !== v.currencyCode) {
      return { ok: false, error: { code: 'CURRENCY_MISMATCH', message: 'mixed currencies' } };
    }
    currency = v.currencyCode;
    const sellingPlanId = item.selling_plan_id == null ? null : String(item.selling_plan_id);
    if (sellingPlanId && !v.sellingPlanIds.includes(sellingPlanId)) {
      return { ok: false, error: { code: 'SELLING_PLAN_NOT_ALLOWED', message: 'plan not allowed' } };
    }
    const lineTotal = v.price * item.quantity;
    validated.push({
      variantId,
      quantity: item.quantity,
      unitPrice: v.price,
      lineTotal,
      isSubscription: !!sellingPlanId,
      sellingPlanId,
    });
  }
  const subs = validated.filter((li) => li.isSubscription);
  const ones = validated.filter((li) => !li.isSubscription);
  const subscriptionTotal = subs.reduce((s, li) => s + li.lineTotal, 0);
  const onetimeTotal = ones.reduce((s, li) => s + li.lineTotal, 0);
  const grandTotal = subscriptionTotal + onetimeTotal;
  let type;
  if (subs.length === 0) type = 'PURE_ONETIME';
  else if (ones.length === 0) type = 'PURE_SUBSCRIPTION';
  else type = 'MIXED';
  if (grandTotal < XENDIT_MIN_AMOUNT_IDR) {
    return { ok: false, error: { code: 'AMOUNT_TOO_SMALL', message: 'below minimum' } };
  }
  return {
    ok: true,
    cart: {
      type,
      lineItems: validated,
      subscriptionItems: subs,
      onetimeItems: ones,
      subscriptionTotal,
      onetimeTotal,
      grandTotal,
      currency: currency ?? 'IDR',
    },
  };
}

function assertUniformSubscriptionInterval(items, sellingPlans) {
  const subs = items.filter((li) => li.isSubscription && li.sellingPlanId);
  if (subs.length === 0) return null;
  const first = sellingPlans.get(subs[0].sellingPlanId);
  if (!first) return null;
  for (const li of subs.slice(1)) {
    const sp = sellingPlans.get(li.sellingPlanId);
    if (!sp) continue;
    if (sp.interval !== first.interval || sp.intervalCount !== first.intervalCount) {
      return null;
    }
  }
  return first;
}

const variant = (id, price, sellingPlanIds = []) => ({
  variantId: id,
  price,
  currencyCode: 'IDR',
  sellingPlanIds,
});

test('parseLineItems: rejects non-array', () => {
  assert.equal(parseLineItems({}), null);
  assert.equal(parseLineItems('foo'), null);
  assert.equal(parseLineItems(null), null);
});

test('parseLineItems: accepts top-level selling_plan_id', () => {
  const out = parseLineItems([{ variant_id: '123', quantity: 2, selling_plan_id: '999' }]);
  assert.equal(out[0].selling_plan_id, '999');
});

test('parseLineItems: rejects bad quantities', () => {
  assert.equal(parseLineItems([{ variant_id: '1', quantity: 0 }]), null);
  assert.equal(parseLineItems([{ variant_id: '1', quantity: -1 }]), null);
  assert.equal(parseLineItems([{ variant_id: '1', quantity: 101 }]), null);
});

test('validateCart: PURE_ONETIME classification', () => {
  const r = validateCart(
    [{ variant_id: '1', quantity: 1 }, { variant_id: '2', quantity: 2 }],
    [variant('1', 50_000), variant('2', 100_000)],
  );
  assert.equal(r.ok, true);
  assert.equal(r.cart.type, 'PURE_ONETIME');
  assert.equal(r.cart.grandTotal, 250_000);
});

test('validateCart: PURE_SUBSCRIPTION classification', () => {
  const r = validateCart(
    [{ variant_id: '1', quantity: 1, selling_plan_id: '999' }],
    [variant('1', 85_000, ['999'])],
  );
  assert.equal(r.ok, true);
  assert.equal(r.cart.type, 'PURE_SUBSCRIPTION');
  assert.equal(r.cart.subscriptionTotal, 85_000);
});

test('validateCart: MIXED classification (Treelogy real cart shape)', () => {
  // Mirrors the screenshot: Test 45g sub Rp 85.000 + Moringa Oil one-time Rp 470.000
  const r = validateCart(
    [
      { variant_id: 'sub-1', quantity: 1, selling_plan_id: 'plan-3mo' },
      { variant_id: 'one-1', quantity: 1 },
    ],
    [variant('sub-1', 85_000, ['plan-3mo']), variant('one-1', 470_000)],
  );
  assert.equal(r.ok, true);
  assert.equal(r.cart.type, 'MIXED');
  assert.equal(r.cart.subscriptionTotal, 85_000);
  assert.equal(r.cart.onetimeTotal, 470_000);
  assert.equal(r.cart.grandTotal, 555_000);
});

test('validateCart: rejects selling_plan not on variant', () => {
  const r = validateCart(
    [{ variant_id: '1', quantity: 1, selling_plan_id: '999' }],
    [variant('1', 85_000, ['888'])],
  );
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SELLING_PLAN_NOT_ALLOWED');
});

test('validateCart: rejects unknown variant', () => {
  const r = validateCart([{ variant_id: '999', quantity: 1 }], []);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'VARIANT_NOT_FOUND');
});

test('validateCart: rejects empty cart', () => {
  const r = validateCart([], []);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'EMPTY_CART');
});

test('validateCart: rejects amount below Xendit minimum', () => {
  const r = validateCart([{ variant_id: '1', quantity: 1 }], [variant('1', 500)]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'AMOUNT_TOO_SMALL');
});

test('assertUniformSubscriptionInterval: uniform → returns interval', () => {
  const items = [
    { isSubscription: true, sellingPlanId: 'A' },
    { isSubscription: true, sellingPlanId: 'B' },
  ];
  const plans = new Map([
    ['A', { interval: 'MONTH', intervalCount: 3 }],
    ['B', { interval: 'MONTH', intervalCount: 3 }],
  ]);
  assert.deepEqual(assertUniformSubscriptionInterval(items, plans), {
    interval: 'MONTH',
    intervalCount: 3,
  });
});

test('assertUniformSubscriptionInterval: non-uniform → null', () => {
  const items = [
    { isSubscription: true, sellingPlanId: 'A' },
    { isSubscription: true, sellingPlanId: 'B' },
  ];
  const plans = new Map([
    ['A', { interval: 'MONTH', intervalCount: 1 }],
    ['B', { interval: 'MONTH', intervalCount: 3 }],
  ]);
  assert.equal(assertUniformSubscriptionInterval(items, plans), null);
});
