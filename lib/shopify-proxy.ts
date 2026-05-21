import crypto from 'node:crypto';
import { env } from './env';

// ============================================================
// Shopify App Proxy HMAC verification
//
// When a customer hits `https://store.myshopify.com/apps/<prefix>/...`,
// Shopify proxies the request to our backend and signs it with the
// Custom App's shared secret. The signature is in the `signature`
// query parameter. We MUST verify before trusting any params,
// especially `logged_in_customer_id`.
//
// Algorithm (per Shopify docs):
//   1. Remove `signature` from query params.
//   2. Sort remaining params alphabetically by key.
//   3. Concatenate as `key=value` (no separator between pairs).
//   4. HMAC-SHA256 with the shared secret, hex-encoded.
//   5. Constant-time compare with the `signature` value.
// ============================================================

export type AppProxyContext = {
  shopifyCustomerId: string | null;
  shopDomain: string;
  pathPrefix: string;
  timestamp: number;
};

/**
 * Verify and parse an App Proxy request. Returns the verified
 * context (incl. authenticated customer ID) or null if the
 * signature is invalid or missing.
 *
 * IMPORTANT: this function ONLY trusts query params after signature
 * verification. Do not read params from `URL` before calling this.
 */
export function verifyAppProxy(searchParams: URLSearchParams): AppProxyContext | null {
  const signature = searchParams.get('signature');
  if (!signature) return null;

  // Build the message string from all params except `signature`.
  // Per Shopify docs: alphabetical sort by key, concatenate "key=value".
  const entries: Array<[string, string]> = [];
  searchParams.forEach((value, key) => {
    if (key === 'signature') return;
    entries.push([key, value]);
  });
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = entries.map(([k, v]) => `${k}=${v}`).join('');

  const computed = crypto
    .createHmac('sha256', env.SHOPIFY_APP_PROXY_SECRET)
    .update(message)
    .digest('hex');

  // Constant-time compare to prevent timing attacks.
  // Both strings must be equal length first.
  if (computed.length !== signature.length) return null;
  const ok = crypto.timingSafeEqual(
    Buffer.from(computed, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
  if (!ok) return null;

  // Timestamp check — reject requests older than 5 minutes to
  // limit replay-attack window. Shopify includes `timestamp`
  // (unix seconds) in every signed request.
  const tsStr = searchParams.get('timestamp');
  const ts = tsStr ? Number(tsStr) : 0;
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return null;

  return {
    shopifyCustomerId: searchParams.get('logged_in_customer_id') || null,
    shopDomain: searchParams.get('shop') ?? '',
    pathPrefix: searchParams.get('path_prefix') ?? '',
    timestamp: ts,
  };
}
