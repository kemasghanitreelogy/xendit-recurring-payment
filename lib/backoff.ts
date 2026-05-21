// Exponential backoff with full jitter (AWS-recommended algorithm).
//
// Schedule (for base=60s, cap=86400s = 24h):
//   attempt 1 →   0–60s
//   attempt 2 →   0–120s
//   attempt 3 →   0–240s
//   attempt 4 →   0–480s
//   ...
//   attempt 11 → 0–61440s
//   attempt 12+ → 0–86400s (cap)
//
// At attempt >= MAX_ATTEMPTS we stop and mark dead-letter. The cap of 24h
// matches our Vercel daily safety-net cron — so even if exponential backoff
// were to push beyond 24h, the safety cron still picks the row up.

export const RETRY_BASE_SEC = 60;        // 1 minute
export const RETRY_CAP_SEC = 86_400;     // 24 hours
export const MAX_ATTEMPTS = 12;          // -> after ~24h cumulative, give up

export type RetryDecision =
  | { kind: 'retry'; nextRetryAt: Date; backoffSec: number }
  | { kind: 'dead'; reason: string };

/**
 * Given the count of attempts so far (NOT including the upcoming one),
 * decide whether to schedule another retry and when.
 *
 * @param attemptsSoFar  e.g. 0 = never tried; 1 = first attempt just failed
 * @param now            for testability
 */
export function nextRetry(attemptsSoFar: number, now: Date = new Date()): RetryDecision {
  if (attemptsSoFar >= MAX_ATTEMPTS) {
    return { kind: 'dead', reason: `max_attempts_${MAX_ATTEMPTS}_reached` };
  }
  // Exponential window. attemptsSoFar=1 → window 120s, attemptsSoFar=2 → 240s.
  const window = Math.min(RETRY_BASE_SEC * Math.pow(2, attemptsSoFar), RETRY_CAP_SEC);
  // Full jitter: pick uniformly in [0, window]. Prevents thundering herd
  // when many invoices fail simultaneously (e.g. Shopify regional outage).
  const delaySec = Math.floor(Math.random() * window);
  return {
    kind: 'retry',
    backoffSec: delaySec,
    nextRetryAt: new Date(now.getTime() + delaySec * 1000),
  };
}
