// Full E2E suite. Each block prints a single line: "PASS|FAIL  <name>  <details>"
// Exit non-zero if any FAIL.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(
  '/Users/kemasghani/Documents/xendit-recurring-payment/.env.local',
  'utf8',
);
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const PROXY_SECRET = process.env.SHOPIFY_APP_PROXY_SECRET;
const WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN;
const RECONCILE_TOKEN = process.env.ADMIN_RECONCILE_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const XENDIT_KEY = process.env.XENDIT_SECRET_KEY;

// Inject a CRON_SECRET for the test run if not already set, so the cron
// endpoint test can authenticate. (Production sets this in Vercel env.)
const CRON_SECRET = process.env.CRON_SECRET ?? 'test_cron_secret_for_e2e_only';
if (!process.env.CRON_SECRET) process.env.CRON_SECRET = CRON_SECRET;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

let failures = 0;
const results = [];
function record(name, ok, info = '') {
  results.push({ name, ok, info });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}\t${info}`);
}

function signParams(params) {
  // Mirror lib/shopify-proxy.ts exactly: alphabetical sort, "k=v" concat (no sep).
  const entries = [];
  for (const [k, v] of params) {
    if (k === 'signature') continue;
    entries.push([k, v]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const msg = entries.map(([k, v]) => `${k}=${v}`).join('');
  return crypto.createHmac('sha256', PROXY_SECRET).update(msg).digest('hex');
}

function buildSignedUrl(path, extraParams, customerId) {
  const u = new URL(`${APP_URL}${path}`);
  if (customerId) u.searchParams.set('logged_in_customer_id', String(customerId));
  u.searchParams.set('shop', SHOPIFY_STORE);
  u.searchParams.set('path_prefix', '/apps/xendit');
  u.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  for (const [k, v] of Object.entries(extraParams ?? {})) u.searchParams.set(k, v);
  u.searchParams.set('signature', signParams(u.searchParams));
  return u.toString();
}

async function shopifyAdmin(path, init) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}${path}`,
    { ...init, headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json', ...(init?.headers ?? {}) } },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function xenditApi(path, init) {
  const res = await fetch(`https://api.xendit.co${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${XENDIT_KEY}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// =================================================================
// SECTION 1: AUTH & VALIDATION
// =================================================================

// 1.1 /api/subscribe without signature → 401
{
  const res = await fetch(`${APP_URL}/api/subscribe?plan_code=pro_monthly`);
  record('subscribe.no-sig.401', res.status === 401, `got ${res.status}`);
}

// 1.2 /api/subscribe with bad signature → 401
{
  const u = new URL(`${APP_URL}/api/subscribe`);
  u.searchParams.set('plan_code', 'pro_monthly');
  u.searchParams.set('shop', SHOPIFY_STORE);
  u.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  u.searchParams.set('signature', 'deadbeef'.repeat(8));
  const res = await fetch(u.toString());
  record('subscribe.bad-sig.401', res.status === 401, `got ${res.status}`);
}

// 1.3 /api/subscribe with stale timestamp (signed) → 401
{
  const u = new URL(`${APP_URL}/api/subscribe`);
  u.searchParams.set('plan_code', 'pro_monthly');
  u.searchParams.set('shop', SHOPIFY_STORE);
  u.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000) - 600)); // 10min old
  u.searchParams.set('signature', signParams(u.searchParams));
  const res = await fetch(u.toString());
  record('subscribe.stale-ts.401', res.status === 401, `got ${res.status}`);
}

// 1.4 /api/subscribe signed but no customer → redirect to login
{
  const url = buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, null);
  const res = await fetch(url, { redirect: 'manual' });
  const ok = res.status === 307 || res.status === 302;
  const loc = res.headers.get('location') ?? '';
  record(
    'subscribe.no-customer.redirect-login',
    ok && loc.includes('/account/login'),
    `status=${res.status} loc=${loc}`,
  );
}

// 1.5 /api/subscribe signed with customer but bad plan → 400
{
  const url = buildSignedUrl('/api/subscribe', { plan_code: 'bogus' }, '9999999999');
  const res = await fetch(url);
  record('subscribe.bad-plan.400', res.status === 400, `got ${res.status}`);
}

// 1.6 /api/subscription/current unsigned → 401
{
  const res = await fetch(`${APP_URL}/api/subscription/current`);
  record('current.no-sig.401', res.status === 401, `got ${res.status}`);
}

// 1.7 /api/subscription/current signed but no customer → 200, null subscription
{
  const url = buildSignedUrl('/api/subscription/current', {}, null);
  const res = await fetch(url);
  const body = await res.json();
  record(
    'current.no-customer.null',
    res.status === 200 && body.subscription === null,
    `status=${res.status} sub=${body.subscription}`,
  );
}

// 1.8 /api/subscription/cancel signed but no active sub → 404
{
  const url = buildSignedUrl('/api/subscription/cancel', {}, '9876543210');
  const res = await fetch(url, { method: 'POST' });
  record('cancel.no-active.404', res.status === 404, `got ${res.status}`);
}

// 1.9 /api/webhook/xendit without token → 401
{
  const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'noop', id: 'evt_unauth' }),
  });
  record('webhook.no-token.401', res.status === 401, `got ${res.status}`);
}

// 1.10 /api/webhook/xendit with wrong token → 401
{
  const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-callback-token': 'wrong' },
    body: JSON.stringify({ event: 'noop', id: 'evt_unauth2' }),
  });
  record('webhook.bad-token.401', res.status === 401, `got ${res.status}`);
}

// 1.11 /api/admin/reconcile unauth → 401 (GET)
{
  const res = await fetch(`${APP_URL}/api/admin/reconcile`);
  record('reconcile.no-auth.401', res.status === 401, `got ${res.status}`);
}

// 1.12 /api/admin/reconcile with right token → 200, returns counts
{
  const res = await fetch(`${APP_URL}/api/admin/reconcile`, {
    headers: { Authorization: `Bearer ${RECONCILE_TOKEN}` },
  });
  const body = await res.json();
  const ok =
    res.status === 200 &&
    typeof body.invoices_needing_sync === 'number' &&
    typeof body.subscriptions_with_failed_tag === 'number';
  record('reconcile.auth.200', ok, `status=${res.status} body=${JSON.stringify(body)}`);
}

// 1.13 /api/admin/reconcile with bad token (wrong length) → 401
{
  const res = await fetch(`${APP_URL}/api/admin/reconcile`, {
    headers: { Authorization: `Bearer short-token` },
  });
  record('reconcile.bad-len.401', res.status === 401, `got ${res.status}`);
}

// 1.14 /api/admin/reconcile with bad token (same length) → 401
{
  const bad = 'x'.repeat(RECONCILE_TOKEN.length);
  const res = await fetch(`${APP_URL}/api/admin/reconcile`, {
    headers: { Authorization: `Bearer ${bad}` },
  });
  record('reconcile.bad-token.401', res.status === 401, `got ${res.status}`);
}

// 1.15 /api/admin/reconcile/cron without CRON_SECRET header → 401
{
  const res = await fetch(`${APP_URL}/api/admin/reconcile/cron`);
  // Either 401 (if CRON_SECRET configured server-side) or 503 (not configured)
  record('reconcile.cron.unauth', res.status === 401 || res.status === 503, `got ${res.status}`);
}

// 1.16 /api/admin/reconcile/cron with CRON_SECRET → 200, runs reconcile
{
  const res = await fetch(`${APP_URL}/api/admin/reconcile/cron`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const body = await res.json().catch(() => ({}));
  record(
    'reconcile.cron.authorized',
    res.status === 200 && body.source === 'cron',
    `status=${res.status} body=${JSON.stringify(body).slice(0, 150)}`,
  );
}

// 1.17 /api/admin/reconcile/cron with admin token (should reject — cron path
//      requires CRON_SECRET specifically)
{
  const res = await fetch(`${APP_URL}/api/admin/reconcile/cron`, {
    headers: { Authorization: `Bearer ${RECONCILE_TOKEN}` },
  });
  record(
    'reconcile.cron.rejects-admin-token',
    res.status === 401,
    `got ${res.status}`,
  );
}

// 1.18 Subscribe with shop domain that doesn't match SHOPIFY_STORE_DOMAIN → 403
{
  const u = new URL(`${APP_URL}/api/subscribe`);
  u.searchParams.set('plan_code', 'pro_monthly');
  u.searchParams.set('shop', 'wrong-store.myshopify.com');
  u.searchParams.set('path_prefix', '/apps/xendit');
  u.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  u.searchParams.set('logged_in_customer_id', '9999999999');
  u.searchParams.set('signature', signParams(u.searchParams));
  const res = await fetch(u.toString());
  record('subscribe.shop-mismatch.403', res.status === 403, `got ${res.status}`);
}

// 1.19 /api/health → 200 with backlog counts
{
  const res = await fetch(`${APP_URL}/api/health`);
  const body = await res.json();
  const ok =
    res.status === 200 &&
    body.ok === true &&
    body.checks?.db === 'ok' &&
    typeof body.backlog?.pending_invoices === 'number';
  record('health.200', ok, `status=${res.status} body=${JSON.stringify(body).slice(0, 150)}`);
}

// 1.20 Middleware adds X-Request-Id to every response
{
  const res = await fetch(`${APP_URL}/api/health`);
  const id = res.headers.get('x-request-id');
  record('middleware.request-id', !!id && id.length > 0, `id=${id}`);
}

// 1.21 Middleware honors inbound X-Request-Id (when format is valid)
{
  const sentId = 'qa-trace-12345';
  const res = await fetch(`${APP_URL}/api/health`, {
    headers: { 'x-request-id': sentId },
  });
  record(
    'middleware.request-id-propagation',
    res.headers.get('x-request-id') === sentId,
    `sent=${sentId} got=${res.headers.get('x-request-id')}`,
  );
}

// 1.22 Middleware sets baseline security headers
{
  const res = await fetch(`${APP_URL}/api/health`);
  const hsts = res.headers.get('strict-transport-security');
  const xfo = res.headers.get('x-frame-options');
  const xcto = res.headers.get('x-content-type-options');
  record(
    'middleware.security-headers',
    hsts?.includes('max-age') && xfo === 'DENY' && xcto === 'nosniff',
    `hsts=${hsts?.slice(0, 30)} xfo=${xfo} xcto=${xcto}`,
  );
}

// 1.23 Webhook replay: unauth → 401
{
  const res = await fetch(`${APP_URL}/api/admin/webhook-replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: 'whatever' }),
  });
  record('webhook-replay.no-auth.401', res.status === 401, `got ${res.status}`);
}

// 1.24 Webhook replay: nonexistent event → 404
{
  const res = await fetch(`${APP_URL}/api/admin/webhook-replay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RECONCILE_TOKEN}`,
    },
    body: JSON.stringify({ eventId: 'evt_does_not_exist_anywhere' }),
  });
  record('webhook-replay.nonexistent.404', res.status === 404, `got ${res.status}`);
}

// =================================================================
// SECTION 2: FULL SUBSCRIBE FLOW (creates real Xendit plan, then cleans up)
// =================================================================

// Create a dedicated test Shopify customer (or reuse if exists)
const TEST_EMAIL = `qa+xendit-test-${Date.now()}@treelogy.com`;
let testCustomerId = null;
{
  const { status, body } = await shopifyAdmin('/customers.json', {
    method: 'POST',
    body: JSON.stringify({
      customer: {
        first_name: 'QA',
        last_name: 'Test',
        email: TEST_EMAIL,
        verified_email: true,
        tags: 'qa-test',
        email_marketing_consent: { state: 'not_subscribed' },
      },
    }),
  });
  if (status === 201 && body?.customer?.id) {
    testCustomerId = String(body.customer.id);
    record('shopify.create-test-customer', true, `id=${testCustomerId}`);
  } else {
    record('shopify.create-test-customer', false, `status=${status} body=${JSON.stringify(body).slice(0, 300)}`);
  }
}

let subscribeRedirectLoc = null;
let xenditPlanIdForCleanup = null;

if (testCustomerId) {
  // 2.1 /api/subscribe full flow → 307 redirect to Xendit checkout
  const url = buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, testCustomerId);
  const res = await fetch(url, { redirect: 'manual' });
  subscribeRedirectLoc = res.headers.get('location') ?? '';
  const isXenditCheckout =
    (res.status === 307 || res.status === 302) &&
    /xendit/i.test(subscribeRedirectLoc);
  record(
    'subscribe.full-flow.302-to-xendit',
    isXenditCheckout,
    `status=${res.status} loc=${subscribeRedirectLoc.slice(0, 120)}`,
  );

  // 2.2 DB row created with status PENDING
  const { data: subRow } = await supabase
    .from('subscriptions')
    .select('id, status, plan_code, xendit_plan_id, xendit_customer_id')
    .eq('shopify_customer_id', testCustomerId)
    .maybeSingle();
  if (subRow) {
    xenditPlanIdForCleanup = subRow.xendit_plan_id;
    record(
      'db.sub-row-created',
      subRow.status === 'PENDING' && subRow.plan_code === 'pro_monthly',
      `status=${subRow.status} plan=${subRow.plan_code} xendit_plan=${subRow.xendit_plan_id}`,
    );
  } else {
    record('db.sub-row-created', false, 'no row found');
  }

  // 2.3 Idempotency — second click should redirect back to Shopify "already" page
  if (subRow) {
    const url2 = buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, testCustomerId);
    const res2 = await fetch(url2, { redirect: 'manual' });
    const loc2 = res2.headers.get('location') ?? '';
    const ok = (res2.status === 307 || res2.status === 302) && /subscription=already/.test(loc2);
    record(
      'subscribe.duplicate.already-redirect',
      ok,
      `status=${res2.status} loc=${loc2.slice(0, 150)}`,
    );
  }

  // 2.4 /api/subscription/current now returns the PENDING sub
  if (subRow) {
    const url3 = buildSignedUrl('/api/subscription/current', {}, testCustomerId);
    const res3 = await fetch(url3);
    const body3 = await res3.json();
    record(
      'current.returns-pending-sub',
      res3.status === 200 && body3.subscription?.status === 'PENDING',
      `status=${res3.status} sub_status=${body3.subscription?.status}`,
    );
  }

  // =================================================================
  // SECTION 3: WEBHOOK HANDLER
  // =================================================================
  if (xenditPlanIdForCleanup) {
    const planId = xenditPlanIdForCleanup;

    // 3.1 recurring.plan.activated → status ACTIVE
    {
      const evt = {
        id: `evt_qa_activated_${Date.now()}`,
        event: 'recurring.plan.activated',
        created: new Date().toISOString(),
        business_id: 'qa',
        data: {
          id: planId,
          status: 'ACTIVE',
          schedule: { next_execution_at: '2026-06-21T00:00:00Z' },
        },
      };
      const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
        body: JSON.stringify(evt),
      });
      const body = await res.json();
      record('webhook.plan.activated.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

      // Verify DB
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status, current_period_end')
        .eq('xendit_plan_id', planId)
        .single();
      record(
        'webhook.plan.activated.db-active',
        sub?.status === 'ACTIVE' && sub?.current_period_end != null,
        `status=${sub?.status} period_end=${sub?.current_period_end}`,
      );
    }

    // 3.2 Duplicate event dedupe
    {
      const evt = {
        id: 'evt_qa_dedupe_unique',
        event: 'recurring.plan.activated',
        created: new Date().toISOString(),
        business_id: 'qa',
        data: { id: planId },
      };
      const headers = { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN };
      const first = await fetch(`${APP_URL}/api/webhook/xendit`, { method: 'POST', headers, body: JSON.stringify(evt) });
      const firstBody = await first.json();
      const second = await fetch(`${APP_URL}/api/webhook/xendit`, { method: 'POST', headers, body: JSON.stringify(evt) });
      const secondBody = await second.json();
      record(
        'webhook.dedupe',
        first.status === 200 && firstBody.ok === true && !firstBody.duplicate &&
          second.status === 200 && secondBody.duplicate === true,
        `first=${JSON.stringify(firstBody)} second=${JSON.stringify(secondBody)}`,
      );
    }

    // 3.3 recurring.cycle.succeeded → invoice created, attempt Shopify order
    const cycleId = `qa_cycle_${Date.now()}`;
    {
      const evt = {
        id: `evt_qa_cycle_succeeded_${Date.now()}`,
        event: 'recurring.cycle.succeeded',
        created: new Date().toISOString(),
        business_id: 'qa',
        data: {
          id: cycleId,
          recurring_plan_id: planId,
          customer_id: 'qa-customer',
          amount: 99000,
          currency: 'IDR',
          cycle_date: new Date().toISOString(),
          next_cycle_date: '2026-06-21T00:00:00Z',
          payment_method: { type: 'CARD' },
          payment_id: 'pay_qa_test',
        },
      };
      const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
        body: JSON.stringify(evt),
      });
      const body = await res.json();
      record('webhook.cycle.succeeded.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

      // Verify invoice row created
      const { data: inv } = await supabase
        .from('subscription_invoices')
        .select('status, shopify_sync_status, shopify_order_id, shopify_sync_error')
        .eq('xendit_cycle_id', cycleId)
        .single();
      record(
        'webhook.cycle.succeeded.invoice',
        inv?.status === 'SUCCEEDED',
        `status=${inv?.status} sync=${inv?.shopify_sync_status} order=${inv?.shopify_order_id} err=${(inv?.shopify_sync_error ?? '').slice(0, 200)}`,
      );

      // Shopify order ideally SYNCED
      record(
        'webhook.cycle.succeeded.shopify-order',
        inv?.shopify_sync_status === 'SYNCED' && inv?.shopify_order_id,
        `sync=${inv?.shopify_sync_status} order=${inv?.shopify_order_id} err=${(inv?.shopify_sync_error ?? '').slice(0, 200)}`,
      );
    }

    // 3.4 Idempotent — same cycle ID delivered again, no duplicate order
    {
      const evt = {
        id: `evt_qa_cycle_dup_${Date.now()}`,
        event: 'recurring.cycle.succeeded',
        created: new Date().toISOString(),
        business_id: 'qa',
        data: {
          id: cycleId,
          recurring_plan_id: planId,
          amount: 99000,
          currency: 'IDR',
          cycle_date: new Date().toISOString(),
          payment_method: { type: 'CARD' },
        },
      };
      const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
        body: JSON.stringify(evt),
      });
      const body = await res.json();
      record('webhook.cycle.idempotent.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

      // Should still be one row for this cycle
      const { data: invs } = await supabase
        .from('subscription_invoices')
        .select('id')
        .eq('xendit_cycle_id', cycleId);
      record(
        'webhook.cycle.idempotent.no-dup',
        invs?.length === 1,
        `rows=${invs?.length}`,
      );
    }

    // 3.4b Out-of-order cycle.created must NOT regress invoice SUCCEEDED → PENDING
    {
      const evt = {
        id: `evt_qa_late_created_${Date.now()}`,
        event: 'recurring.cycle.created',
        created: new Date().toISOString(),
        business_id: 'qa',
        data: {
          id: cycleId,
          recurring_plan_id: planId,
          amount: 99000,
          currency: 'IDR',
        },
      };
      const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
        body: JSON.stringify(evt),
      });
      const body = await res.json();
      record('webhook.late-created.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

      const { data: inv } = await supabase
        .from('subscription_invoices')
        .select('status, shopify_order_id')
        .eq('xendit_cycle_id', cycleId)
        .single();
      record(
        'webhook.late-created.no-regression',
        inv?.status === 'SUCCEEDED' && inv?.shopify_order_id != null,
        `status=${inv?.status} order=${inv?.shopify_order_id}`,
      );
    }

    // 3.5 customer multi-tag added (subscriber + pro-member + plan-pro_monthly)
    {
      const { body } = await shopifyAdmin(`/customers/${testCustomerId}.json?fields=id,tags`, {});
      const tags = body?.customer?.tags ?? '';
      const tagList = tags.split(',').map((t) => t.trim());
      const expected = ['subscriber', 'pro-member', 'plan-pro_monthly'];
      const allPresent = expected.every((t) => tagList.includes(t));
      record(
        'shopify.multi-tag-applied',
        allPresent,
        `tags="${tags}" expected=${expected.join('|')}`,
      );
    }

    // 3.6 retrying → PAST_DUE
    {
      const evt = {
        id: `evt_qa_retrying_${Date.now()}`,
        event: 'recurring.cycle.retrying',
        created: new Date().toISOString(),
        business_id: 'qa',
        data: { id: `qa_cycle_retry_${Date.now()}`, recurring_plan_id: planId },
      };
      const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
        body: JSON.stringify(evt),
      });
      const body = await res.json();
      record('webhook.retrying.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('xendit_plan_id', planId)
        .single();
      record('webhook.retrying.past-due', sub?.status === 'PAST_DUE', `status=${sub?.status}`);
    }

    // 3.7 inactivated → CANCELED + untag
    {
      const evt = {
        id: `evt_qa_inactivated_${Date.now()}`,
        event: 'recurring.plan.inactivated',
        created: new Date().toISOString(),
        business_id: 'qa',
        data: { id: planId, status: 'INACTIVE' },
      };
      const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
        body: JSON.stringify(evt),
      });
      const body = await res.json();
      record('webhook.inactivated.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status, canceled_at')
        .eq('xendit_plan_id', planId)
        .single();
      record(
        'webhook.inactivated.canceled',
        sub?.status === 'CANCELED' && sub?.canceled_at != null,
        `status=${sub?.status} canceled_at=${sub?.canceled_at}`,
      );

      // All membership tags removed
      const { body: shopBody } = await shopifyAdmin(`/customers/${testCustomerId}.json?fields=id,tags`, {});
      const remaining = shopBody?.customer?.tags ?? '';
      const noMembership =
        !/(\bsubscriber\b|\bpro-member\b|\bplan-pro_monthly\b)/.test(remaining);
      record(
        'shopify.all-membership-tags-removed',
        noMembership,
        `tags="${remaining}"`,
      );
    }
  }
}

// =================================================================
// SECTION 4: CONCURRENT SUBSCRIBE — orphan-plan resistance
// =================================================================
// Race condition test: two parallel subscribe clicks must NOT both create
// real Xendit plans. The reservation row's unique constraint should block
// the second click before it touches Xendit.
{
  const { status: cs, body: cb } = await shopifyAdmin('/customers.json', {
    method: 'POST',
    body: JSON.stringify({
      customer: {
        first_name: 'QA',
        last_name: 'Race',
        email: `qa+race-${Date.now()}@treelogy.com`,
        verified_email: true,
        tags: 'qa-test',
      },
    }),
  });
  if (cs === 201 && cb?.customer?.id) {
    const raceCustomerId = String(cb.customer.id);
    const url1 = buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, raceCustomerId);
    const url2 = buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, raceCustomerId);
    const [r1, r2] = await Promise.all([
      fetch(url1, { redirect: 'manual' }),
      fetch(url2, { redirect: 'manual' }),
    ]);
    const loc1 = r1.headers.get('location') ?? '';
    const loc2 = r2.headers.get('location') ?? '';
    const xenditCount = [loc1, loc2].filter((l) => /linking\.xendit\.co/.test(l)).length;
    const alreadyCount = [loc1, loc2].filter((l) => /subscription=already/.test(l)).length;

    record(
      'subscribe.race.one-checkout-one-already',
      xenditCount === 1 && alreadyCount === 1,
      `xendit_links=${xenditCount} already_redirects=${alreadyCount} loc1=${loc1.slice(0, 60)} loc2=${loc2.slice(0, 60)}`,
    );

    // Cleanup
    const { data: subRows } = await supabase
      .from('subscriptions')
      .select('id, xendit_plan_id')
      .eq('shopify_customer_id', raceCustomerId);
    for (const s of subRows ?? []) {
      if (!s.xendit_plan_id.startsWith('pending-')) {
        try {
          await xenditApi(`/recurring/plans/${s.xendit_plan_id}/deactivate`, { method: 'POST' });
        } catch {}
      }
      await supabase.from('subscription_invoices').delete().eq('subscription_id', s.id);
    }
    await supabase.from('subscriptions').delete().eq('shopify_customer_id', raceCustomerId);
    await shopifyAdmin(`/customers/${raceCustomerId}.json`, { method: 'DELETE' });
  } else {
    record('subscribe.race.one-checkout-one-already', false, `couldn't create race customer: ${cs}`);
  }
}

// =================================================================
// SECTION 5: PENDING-sub cancel + reservation cleanup
// =================================================================
{
  const { status: cs, body: cb } = await shopifyAdmin('/customers.json', {
    method: 'POST',
    body: JSON.stringify({
      customer: {
        first_name: 'QA',
        last_name: 'PendingCancel',
        email: `qa+pending-${Date.now()}@treelogy.com`,
        verified_email: true,
        tags: 'qa-test',
      },
    }),
  });
  if (cs === 201 && cb?.customer?.id) {
    const pcId = String(cb.customer.id);
    // Create a reservation row directly (simulates an abandoned checkout
    // path: row exists with pending- placeholder IDs).
    await supabase.from('subscriptions').insert({
      shopify_customer_id: pcId,
      shopify_customer_email: 'placeholder@reserved.local',
      xendit_customer_id: `pending-test-${Date.now()}`,
      xendit_plan_id: `pending-test-${Date.now()}`,
      xendit_reference_id: `pending-test-${Date.now()}`,
      plan_code: 'pro_monthly',
      amount: 99000,
      currency: 'IDR',
      interval: 'MONTH',
      interval_count: 1,
      status: 'PENDING',
    });

    // Now hit cancel — should delete the reservation row immediately
    const cancelUrl = buildSignedUrl('/api/subscription/cancel', {}, pcId);
    const cres = await fetch(cancelUrl, { method: 'POST' });
    const cbody = await cres.json();
    record(
      'cancel.pending-reservation.200',
      cres.status === 200 && cbody.ok === true && cbody.was === 'reservation',
      `status=${cres.status} body=${JSON.stringify(cbody)}`,
    );

    const { data: after } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('shopify_customer_id', pcId)
      .maybeSingle();
    record('cancel.pending-reservation.row-deleted', after === null, `row=${JSON.stringify(after)}`);

    await shopifyAdmin(`/customers/${pcId}.json`, { method: 'DELETE' });
  }
}

// =================================================================
// SECTION 6: Audit log captures cron reconcile run
// =================================================================
{
  // Trigger one cron run, then verify an audit row was created.
  const before = Date.now();
  await fetch(`${APP_URL}/api/admin/reconcile/cron`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  // Allow a moment for the audit row to flush.
  await new Promise((r) => setTimeout(r, 500));
  const { data: rows } = await supabase
    .from('audit_log')
    .select('action, actor, occurred_at')
    .eq('action', 'reconcile.run')
    .eq('actor', 'cron')
    .gte('occurred_at', new Date(before - 1000).toISOString())
    .order('occurred_at', { ascending: false })
    .limit(1);
  record(
    'audit.reconcile-run-logged',
    rows?.length === 1,
    `rows=${rows?.length ?? 0}`,
  );
}

// =================================================================
// SECTION 7: Webhook replay round-trip
// =================================================================
{
  // Insert a fake processed event, then replay it.
  const fakeEventId = `evt_qa_replay_${Date.now()}`;
  await supabase.from('xendit_webhook_events').insert({
    id: fakeEventId,
    event_type: 'recurring.plan.activated',
    payload: {
      id: fakeEventId,
      event: 'recurring.plan.activated',
      data: { id: 'repl_does_not_exist_for_replay_test' },
    },
    processed_at: new Date().toISOString(),
  });
  const res = await fetch(`${APP_URL}/api/admin/webhook-replay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RECONCILE_TOKEN}`,
    },
    body: JSON.stringify({ eventId: fakeEventId }),
  });
  const body = await res.json();
  // Handler will return ok because the plan ID doesn't exist — that's a warn,
  // not an error. The replay round-trip itself should succeed (200 dispatch).
  record(
    'webhook-replay.dispatch.ok',
    res.status === 200 && body.dispatch?.status === 200,
    `status=${res.status} dispatch=${JSON.stringify(body.dispatch).slice(0, 120)}`,
  );

  // Verify audit entry exists
  await new Promise((r) => setTimeout(r, 300));
  const { data: auditRows } = await supabase
    .from('audit_log')
    .select('id')
    .eq('action', 'webhook.replay')
    .eq('target_id', fakeEventId)
    .limit(1);
  record('webhook-replay.audit-row', auditRows?.length === 1, `rows=${auditRows?.length}`);

  // Cleanup replay artifacts (the replay re-creates the row through dispatch)
  await supabase.from('xendit_webhook_events').delete().eq('id', fakeEventId);
  await supabase.from('audit_log').delete().eq('target_id', fakeEventId);
}

// =================================================================
// CLEANUP
// =================================================================
if (xenditPlanIdForCleanup) {
  try {
    const r = await xenditApi(`/recurring/plans/${xenditPlanIdForCleanup}/deactivate`, { method: 'POST' });
    record('cleanup.xendit.deactivate', r.status === 200 || /INACTIVE/.test(JSON.stringify(r.body)), `status=${r.status}`);
  } catch (e) {
    record('cleanup.xendit.deactivate', false, String(e).slice(0, 200));
  }
}

if (testCustomerId) {
  // 1. Clean DB rows tied to this test customer
  const { data: subToDelete } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('shopify_customer_id', testCustomerId);
  for (const s of subToDelete ?? []) {
    await supabase.from('subscription_invoices').delete().eq('subscription_id', s.id);
  }
  await supabase.from('subscriptions').delete().eq('shopify_customer_id', testCustomerId);
  // Wipe QA webhook events (any id starting with evt_qa_)
  await supabase.from('xendit_webhook_events').delete().like('id', 'evt_qa_%');
  // Wipe rate-limit + audit rows from QA noise so subsequent runs start clean.
  await supabase.from('rate_limit_counters').delete().like('bucket_key', 'webhook:%');
  await supabase.from('rate_limit_counters').delete().like('bucket_key', 'subscribe:%');

  // 2. Delete Shopify orders for this customer (required before customer delete)
  const ordersRes = await shopifyAdmin(
    `/customers/${testCustomerId}/orders.json?status=any&limit=50`,
    {},
  );
  for (const o of ordersRes.body?.orders ?? []) {
    await shopifyAdmin(`/orders/${o.id}.json`, { method: 'DELETE' });
  }

  // 3. Delete the customer (retry — Shopify takes a moment to release the
  //    customer after orders are deleted)
  let del = { status: 0 };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    del = await shopifyAdmin(`/customers/${testCustomerId}.json`, { method: 'DELETE' });
    if (del.status === 200) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  record(
    'cleanup.shopify.delete-test-customer',
    del.status === 200,
    `status=${del.status} orders_cleaned=${ordersRes.body?.orders?.length ?? 0}`,
  );
}

console.log('---');
console.log(`SUMMARY: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
