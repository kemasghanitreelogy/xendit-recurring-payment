import { createAdminClient } from './supabase/admin';
import { log } from './logger';

// Token-bucket rate limiter backed by Postgres (function `consume_rate_limit`
// in migration 0003). State persists across cold starts, so this works on
// Vercel's stateless functions without any external Redis.
//
// Common configurations:
//   - subscribe per customer:  capacity=3, refillPerSec=0.05  (~1/20s, burst 3)
//   - webhook per source IP:   capacity=60, refillPerSec=2    (2/s, burst 60)
//
// Fail-open semantics: if the DB call itself fails, we LOG and allow the
// request through. Rate limiting is a defense layer, not a correctness one —
// we'd rather serve a real customer than hard-fail on a DB blip.

export type RateLimitConfig = {
  /** Max tokens in the bucket (also the burst capacity). */
  capacity: number;
  /** Tokens added per second of elapsed time. */
  refillPerSec: number;
};

export async function consumeRateLimit(
  bucketKey: string,
  cfg: RateLimitConfig,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('consume_rate_limit', {
      p_key: bucketKey,
      p_capacity: cfg.capacity,
      p_refill_per_sec: cfg.refillPerSec,
    });
    if (error) {
      log.warn('rate_limit.rpc_error', { bucketKey, error: error.message });
      return { allowed: true, reason: 'fail-open' };
    }
    return { allowed: data === true };
  } catch (err) {
    log.warn('rate_limit.exception', { bucketKey, error: String(err).slice(0, 200) });
    return { allowed: true, reason: 'fail-open' };
  }
}

/**
 * Returns the request's best-guess client IP. Honors Vercel's
 * `x-forwarded-for` (first hop), falling back to `x-real-ip`.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
