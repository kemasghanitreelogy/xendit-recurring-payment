import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of lib/backoff.ts. Pure, no I/O.
const RETRY_BASE_SEC = 60;
const RETRY_CAP_SEC = 86_400;
const MAX_ATTEMPTS = 12;

function nextRetry(attemptsSoFar, now = new Date(), rand = Math.random) {
  if (attemptsSoFar >= MAX_ATTEMPTS) {
    return { kind: 'dead', reason: `max_attempts_${MAX_ATTEMPTS}_reached` };
  }
  const window = Math.min(RETRY_BASE_SEC * Math.pow(2, attemptsSoFar), RETRY_CAP_SEC);
  const delaySec = Math.floor(rand() * window);
  return {
    kind: 'retry',
    backoffSec: delaySec,
    nextRetryAt: new Date(now.getTime() + delaySec * 1000),
  };
}

test('backoff: dead-letter at MAX_ATTEMPTS', () => {
  assert.equal(nextRetry(12).kind, 'dead');
  assert.equal(nextRetry(99).kind, 'dead');
});

test('backoff: attempt 0 → window up to 60s', () => {
  // With rand()=0.999, delay should be 59 (just under window).
  const r = nextRetry(0, new Date(0), () => 0.999);
  assert.equal(r.kind, 'retry');
  assert.ok(r.backoffSec <= 60);
});

test('backoff: window doubles each attempt up to cap', () => {
  // Use rand=1 - eps so we observe ~full window.
  const rand = () => 0.9999;
  const a1 = nextRetry(0, new Date(0), rand).backoffSec;
  const a2 = nextRetry(1, new Date(0), rand).backoffSec;
  const a3 = nextRetry(2, new Date(0), rand).backoffSec;
  assert.ok(a2 > a1);
  assert.ok(a3 > a2);
});

test('backoff: capped at 24h (86400s)', () => {
  const r = nextRetry(11, new Date(0), () => 0.9999);
  assert.ok(r.backoffSec <= 86400);
});

test('backoff: nextRetryAt is in the future', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const r = nextRetry(3, now, () => 0.5);
  assert.ok(r.nextRetryAt.getTime() >= now.getTime());
});

test('backoff: jitter produces variance', () => {
  const samples = new Set();
  for (let i = 0; i < 50; i++) samples.add(nextRetry(3).backoffSec);
  // With real Math.random, we should see plenty of distinct values.
  assert.ok(samples.size > 10, `only ${samples.size} unique samples`);
});
