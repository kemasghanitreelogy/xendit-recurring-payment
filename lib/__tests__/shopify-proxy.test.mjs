import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Re-implementation of the verifyAppProxy contract, isolated so we can test
// the HMAC algorithm without spinning up Next. Must match lib/shopify-proxy.ts
// byte-for-byte: alphabetical key sort, "k=v" concat with no separator.
function verifyAppProxy(searchParams, secret, nowMs = Date.now()) {
  const signature = searchParams.get('signature');
  if (!signature) return null;
  const entries = [];
  for (const [k, v] of searchParams) {
    if (k === 'signature') continue;
    entries.push([k, v]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = entries.map(([k, v]) => `${k}=${v}`).join('');
  const computed = crypto.createHmac('sha256', secret).update(message).digest('hex');
  if (computed.length !== signature.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(computed, 'utf8'), Buffer.from(signature, 'utf8'));
  if (!ok) return null;
  const ts = Number(searchParams.get('timestamp') ?? 0);
  if (!ts || Math.abs(nowMs / 1000 - ts) > 300) return null;
  return {
    shopifyCustomerId: searchParams.get('logged_in_customer_id') || null,
    shopDomain: searchParams.get('shop') ?? '',
    pathPrefix: searchParams.get('path_prefix') ?? '',
    timestamp: ts,
  };
}

function sign(params, secret) {
  const entries = [];
  for (const [k, v] of params) {
    if (k === 'signature') continue;
    entries.push([k, v]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const msg = entries.map(([k, v]) => `${k}=${v}`).join('');
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

const SECRET = 'shpss_test_secret_for_hmac_unit_test';

test('verifyAppProxy: valid signed request', () => {
  const p = new URLSearchParams();
  p.set('shop', 'store.myshopify.com');
  p.set('path_prefix', '/apps/xendit');
  p.set('timestamp', String(Math.floor(Date.now() / 1000)));
  p.set('logged_in_customer_id', '12345');
  p.set('signature', sign(p, SECRET));
  const ctx = verifyAppProxy(p, SECRET);
  assert.ok(ctx);
  assert.equal(ctx.shopifyCustomerId, '12345');
  assert.equal(ctx.shopDomain, 'store.myshopify.com');
});

test('verifyAppProxy: missing signature returns null', () => {
  const p = new URLSearchParams();
  p.set('shop', 'store.myshopify.com');
  p.set('timestamp', String(Math.floor(Date.now() / 1000)));
  assert.equal(verifyAppProxy(p, SECRET), null);
});

test('verifyAppProxy: tampered param fails', () => {
  const p = new URLSearchParams();
  p.set('shop', 'store.myshopify.com');
  p.set('timestamp', String(Math.floor(Date.now() / 1000)));
  p.set('logged_in_customer_id', '12345');
  p.set('signature', sign(p, SECRET));
  // Now mutate after signing.
  p.set('logged_in_customer_id', '99999');
  assert.equal(verifyAppProxy(p, SECRET), null);
});

test('verifyAppProxy: stale timestamp (>5min) fails', () => {
  const p = new URLSearchParams();
  p.set('shop', 'store.myshopify.com');
  p.set('timestamp', String(Math.floor(Date.now() / 1000) - 600));
  p.set('signature', sign(p, SECRET));
  assert.equal(verifyAppProxy(p, SECRET), null);
});

test('verifyAppProxy: wrong secret fails', () => {
  const p = new URLSearchParams();
  p.set('shop', 'store.myshopify.com');
  p.set('timestamp', String(Math.floor(Date.now() / 1000)));
  p.set('signature', sign(p, 'different_secret'));
  assert.equal(verifyAppProxy(p, SECRET), null);
});

test('verifyAppProxy: key sort independent of insertion order', () => {
  // Two params built in opposite order must produce the same signature.
  const p1 = new URLSearchParams();
  p1.set('shop', 'store.myshopify.com');
  p1.set('timestamp', '1700000000');
  const p2 = new URLSearchParams();
  p2.set('timestamp', '1700000000');
  p2.set('shop', 'store.myshopify.com');
  assert.equal(sign(p1, SECRET), sign(p2, SECRET));
});
