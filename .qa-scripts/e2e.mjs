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
// SECTION 8: Webhook negative paths
// =================================================================

// 8.1 valid token + invalid JSON body → 400
{
  const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
    body: 'not-valid-json{',
  });
  record('webhook.invalid-json.400', res.status === 400, `got ${res.status}`);
}

// 8.2 valid token + JSON that isn't an object → 400 invalid payload shape
{
  const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
    body: JSON.stringify('plain-string-not-object'),
  });
  record('webhook.bad-payload-shape.400', res.status === 400, `got ${res.status}`);
}

// 8.3 unknown event type → still 200 (ack-and-log behavior so Xendit stops retrying)
{
  const evt = {
    id: `evt_qa_unknown_${Date.now()}`,
    event: 'recurring.totally.unknown',
    created: new Date().toISOString(),
    business_id: 'qa',
    data: { id: 'noop' },
  };
  const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
    body: JSON.stringify(evt),
  });
  const body = await res.json();
  record(
    'webhook.unknown-event.200',
    res.status === 200 && body.ok === true,
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
}

// =================================================================
// SECTION 9: recurring.cycle.failed → sub CANCELED + FAILED invoice + tags removed
// =================================================================
{
  let cfId = null;
  let cfSub = null;
  try {
    const { status: cs, body: cb } = await shopifyAdmin('/customers.json', {
      method: 'POST',
      body: JSON.stringify({
        customer: {
          first_name: 'QA',
          last_name: 'CycleFailed',
          email: `qa+cycle-failed-${Date.now()}@treelogy.com`,
          verified_email: true,
          tags: 'qa-test',
        },
      }),
    });
    if (cs !== 201 || !cb?.customer?.id) {
      record('webhook.cycle.failed.setup', false, `customer create failed: ${cs}`);
    } else {
      cfId = String(cb.customer.id);
      const subRes = await fetch(
        buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, cfId),
        { redirect: 'manual' },
      );
      const subLoc = subRes.headers.get('location') ?? '';
      if (!/xendit/i.test(subLoc)) {
        record('webhook.cycle.failed.setup', false, `subscribe failed: ${subRes.status} ${subLoc.slice(0, 80)}`);
      } else {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('id, xendit_plan_id')
          .eq('shopify_customer_id', cfId)
          .single();
        cfSub = sub;
        record('webhook.cycle.failed.setup', true, `sub=${sub?.id}`);

        // Activate (tags applied)
        await fetch(`${APP_URL}/api/webhook/xendit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
          body: JSON.stringify({
            id: `evt_qa_cf_act_${Date.now()}`,
            event: 'recurring.plan.activated',
            created: new Date().toISOString(),
            business_id: 'qa',
            data: { id: sub.xendit_plan_id, schedule: { next_execution_at: '2026-06-21T00:00:00Z' } },
          }),
        });

        // Now send cycle.failed
        const cycleId = `qa_cycle_failed_${Date.now()}`;
        const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
          body: JSON.stringify({
            id: `evt_qa_cf_${Date.now()}`,
            event: 'recurring.cycle.failed',
            created: new Date().toISOString(),
            business_id: 'qa',
            data: {
              id: cycleId,
              recurring_plan_id: sub.xendit_plan_id,
              amount: 99000,
              currency: 'IDR',
              failure_code: 'CARD_DECLINED',
              payment_id: 'pay_qa_failed',
            },
          }),
        });
        const body = await res.json();
        record('webhook.cycle.failed.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

        const { data: subAfter } = await supabase
          .from('subscriptions')
          .select('status, canceled_at')
          .eq('id', sub.id)
          .single();
        record(
          'webhook.cycle.failed.sub-canceled',
          subAfter?.status === 'CANCELED' && subAfter?.canceled_at != null,
          `status=${subAfter?.status} canceled_at=${subAfter?.canceled_at}`,
        );

        const { data: inv } = await supabase
          .from('subscription_invoices')
          .select('status, shopify_sync_status, failure_reason')
          .eq('xendit_cycle_id', cycleId)
          .single();
        record(
          'webhook.cycle.failed.invoice-FAILED',
          inv?.status === 'FAILED' &&
            inv?.shopify_sync_status === 'SKIPPED' &&
            inv?.failure_reason === 'CARD_DECLINED',
          `status=${inv?.status} sync=${inv?.shopify_sync_status} reason=${inv?.failure_reason}`,
        );

        const { body: shopBody } = await shopifyAdmin(`/customers/${cfId}.json?fields=id,tags`, {});
        const remaining = shopBody?.customer?.tags ?? '';
        const noMembership = !/(\bsubscriber\b|\bpro-member\b|\bplan-pro_monthly\b)/.test(remaining);
        record('webhook.cycle.failed.tags-removed', noMembership, `tags="${remaining}"`);
      }
    }
  } finally {
    if (cfSub?.xendit_plan_id && !cfSub.xendit_plan_id.startsWith('pending-')) {
      try {
        await xenditApi(`/recurring/plans/${cfSub.xendit_plan_id}/deactivate`, { method: 'POST' });
      } catch {}
    }
    if (cfSub?.id) {
      await supabase.from('subscription_invoices').delete().eq('subscription_id', cfSub.id);
      await supabase.from('subscriptions').delete().eq('id', cfSub.id);
    }
    if (cfId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const d = await shopifyAdmin(`/customers/${cfId}.json`, { method: 'DELETE' });
        if (d.status === 200) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// =================================================================
// SECTION 10: Cancel ACTIVE subscription → real Xendit deactivate
// =================================================================
{
  let acId = null;
  let acSub = null;
  try {
    const { status: cs, body: cb } = await shopifyAdmin('/customers.json', {
      method: 'POST',
      body: JSON.stringify({
        customer: {
          first_name: 'QA',
          last_name: 'ActiveCancel',
          email: `qa+active-cancel-${Date.now()}@treelogy.com`,
          verified_email: true,
          tags: 'qa-test',
        },
      }),
    });
    if (cs !== 201 || !cb?.customer?.id) {
      record('cancel.active.setup', false, `customer create failed: ${cs}`);
    } else {
      acId = String(cb.customer.id);
      const subRes = await fetch(
        buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, acId),
        { redirect: 'manual' },
      );
      const subLoc = subRes.headers.get('location') ?? '';
      if (!/xendit/i.test(subLoc)) {
        record('cancel.active.setup', false, `subscribe failed: ${subRes.status} ${subLoc.slice(0, 80)}`);
      } else {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('id, xendit_plan_id')
          .eq('shopify_customer_id', acId)
          .single();
        acSub = sub;
        record('cancel.active.setup', true, `sub=${sub?.id}`);

        // Activate to ACTIVE state
        await fetch(`${APP_URL}/api/webhook/xendit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
          body: JSON.stringify({
            id: `evt_qa_ac_act_${Date.now()}`,
            event: 'recurring.plan.activated',
            created: new Date().toISOString(),
            business_id: 'qa',
            data: { id: sub.xendit_plan_id, schedule: { next_execution_at: '2026-06-21T00:00:00Z' } },
          }),
        });

        // Cancel via signed proxy URL
        const cres = await fetch(buildSignedUrl('/api/subscription/cancel', {}, acId), { method: 'POST' });
        const cbody = await cres.json();
        record(
          'cancel.active.200',
          cres.status === 200 && cbody.ok === true && cbody.was !== 'reservation',
          `status=${cres.status} body=${JSON.stringify(cbody)}`,
        );

        // Verify the Xendit plan is now INACTIVE
        const xRes = await xenditApi(`/recurring/plans/${sub.xendit_plan_id}`, {});
        record(
          'cancel.active.xendit-inactive',
          xRes.status === 200 && xRes.body?.status === 'INACTIVE',
          `xendit_status=${xRes.body?.status}`,
        );
      }
    }
  } finally {
    if (acSub?.id) {
      await supabase.from('subscription_invoices').delete().eq('subscription_id', acSub.id);
      await supabase.from('subscriptions').delete().eq('id', acSub.id);
    }
    if (acId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const d = await shopifyAdmin(`/customers/${acId}.json`, { method: 'DELETE' });
        if (d.status === 200) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// =================================================================
// SECTION 11: Reconcile retry — Shopify-down recovery (money-correctness)
// Simulates: charge succeeded at Xendit, but Shopify createOrder failed
// when the webhook fired. The invoice sits as SUCCEEDED+sync=FAILED with
// next_retry_at in the past → reconcile POST must pick it up and SYNC.
// =================================================================
{
  let rcId = null;
  let rcSub = null;
  let rcCycleId = null;
  try {
    const { status: cs, body: cb } = await shopifyAdmin('/customers.json', {
      method: 'POST',
      body: JSON.stringify({
        customer: {
          first_name: 'QA',
          last_name: 'Reconcile',
          email: `qa+reconcile-${Date.now()}@treelogy.com`,
          verified_email: true,
          tags: 'qa-test',
        },
      }),
    });
    if (cs !== 201 || !cb?.customer?.id) {
      record('reconcile.retry.setup', false, `customer create failed: ${cs}`);
    } else {
      rcId = String(cb.customer.id);
      const subRes = await fetch(
        buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, rcId),
        { redirect: 'manual' },
      );
      const subLoc = subRes.headers.get('location') ?? '';
      if (!/xendit/i.test(subLoc)) {
        record('reconcile.retry.setup', false, `subscribe failed: ${subRes.status} ${subLoc.slice(0, 80)}`);
      } else {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('id, xendit_plan_id')
          .eq('shopify_customer_id', rcId)
          .single();
        rcSub = sub;

        // Activate (no Shopify order created — plan.activated only tags)
        await fetch(`${APP_URL}/api/webhook/xendit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
          body: JSON.stringify({
            id: `evt_qa_rc_act_${Date.now()}`,
            event: 'recurring.plan.activated',
            created: new Date().toISOString(),
            business_id: 'qa',
            data: { id: sub.xendit_plan_id, schedule: { next_execution_at: '2026-06-21T00:00:00Z' } },
          }),
        });

        // Inject the failed-sync invoice manually.
        // Cycle ID stays short: Shopify tags must be ≤40 chars and we prepend
        // `xendit_cycle_` (13 chars) when tagging the order for idempotency.
        rcCycleId = `qa_rc_${Date.now()}`;
        const { error: insErr } = await supabase
          .from('subscription_invoices')
          .insert({
            subscription_id: sub.id,
            xendit_cycle_id: rcCycleId,
            xendit_payment_id: 'pay_qa_reconcile',
            amount: 99000,
            currency: 'IDR',
            status: 'SUCCEEDED',
            payment_method: 'CARD',
            paid_at: new Date().toISOString(),
            shopify_sync_status: 'FAILED',
            shopify_sync_attempts: 1,
            shopify_sync_error: 'simulated Shopify outage',
            last_retry_at: new Date(Date.now() - 60000).toISOString(),
            next_retry_at: new Date(Date.now() - 1000).toISOString(),
            raw_payload: { simulated: true },
          });
        if (insErr) {
          record('reconcile.retry.setup', false, `invoice insert: ${insErr.message}`);
        } else {
          record('reconcile.retry.setup', true, `failed invoice cycle=${rcCycleId}`);

          // GET audit shows backlog
          const getRes = await fetch(`${APP_URL}/api/admin/reconcile`, {
            headers: { Authorization: `Bearer ${RECONCILE_TOKEN}` },
          });
          const getBody = await getRes.json();
          record(
            'reconcile.audit.shows-backlog',
            getRes.status === 200 && getBody.invoices_needing_sync >= 1,
            `body=${JSON.stringify(getBody)}`,
          );

          // Dry-run must not mutate
          const dryRes = await fetch(`${APP_URL}/api/admin/reconcile?dry=1`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${RECONCILE_TOKEN}` },
          });
          const dryBody = await dryRes.json();
          record(
            'reconcile.dry-run.200',
            dryRes.status === 200 &&
              dryBody.dry_run === true &&
              (dryBody.invoice_sync?.attempted ?? 0) >= 1,
            `status=${dryRes.status} invoice_sync=${JSON.stringify(dryBody.invoice_sync)}`,
          );
          const { data: dryInv } = await supabase
            .from('subscription_invoices')
            .select('shopify_sync_status, shopify_order_id, shopify_sync_attempts')
            .eq('xendit_cycle_id', rcCycleId)
            .single();
          record(
            'reconcile.dry-run.no-mutation',
            dryInv?.shopify_sync_status === 'FAILED' &&
              dryInv?.shopify_order_id == null &&
              dryInv?.shopify_sync_attempts === 1,
            `sync=${dryInv?.shopify_sync_status} order=${dryInv?.shopify_order_id} attempts=${dryInv?.shopify_sync_attempts}`,
          );

          // Real retry — should create Shopify order
          const retryRes = await fetch(`${APP_URL}/api/admin/reconcile`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${RECONCILE_TOKEN}` },
          });
          const retryBody = await retryRes.json();
          record(
            'reconcile.retry.200',
            retryRes.status === 200 && (retryBody.invoice_sync?.succeeded ?? 0) >= 1,
            `status=${retryRes.status} invoice_sync=${JSON.stringify(retryBody.invoice_sync).slice(0, 200)}`,
          );

          const { data: afterInv } = await supabase
            .from('subscription_invoices')
            .select('shopify_sync_status, shopify_order_id, shopify_sync_error, shopify_sync_attempts')
            .eq('xendit_cycle_id', rcCycleId)
            .single();
          record(
            'reconcile.retry.invoice-SYNCED',
            afterInv?.shopify_sync_status === 'SYNCED' &&
              afterInv?.shopify_order_id != null &&
              afterInv?.shopify_sync_error == null,
            `sync=${afterInv?.shopify_sync_status} order=${afterInv?.shopify_order_id} err=${(afterInv?.shopify_sync_error ?? '').slice(0, 100)}`,
          );
        }
      }
    }
  } finally {
    if (rcSub?.xendit_plan_id && !rcSub.xendit_plan_id.startsWith('pending-')) {
      try {
        await xenditApi(`/recurring/plans/${rcSub.xendit_plan_id}/deactivate`, { method: 'POST' });
      } catch {}
    }
    if (rcId) {
      // Delete any Shopify order created by the reconcile retry
      const ordersRes = await shopifyAdmin(`/customers/${rcId}/orders.json?status=any&limit=50`, {});
      for (const o of ordersRes.body?.orders ?? []) {
        await shopifyAdmin(`/orders/${o.id}.json`, { method: 'DELETE' });
      }
    }
    if (rcSub?.id) {
      await supabase.from('subscription_invoices').delete().eq('subscription_id', rcSub.id);
      await supabase.from('subscriptions').delete().eq('id', rcSub.id);
    }
    if (rcId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const d = await shopifyAdmin(`/customers/${rcId}.json`, { method: 'DELETE' });
        if (d.status === 200) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// =================================================================
// SECTION 11b: Long-cycle-ID regression — real Xendit cycle IDs are
// UUID-shaped (~37 chars). Before the cycleIdTag() fix in lib/shopify.ts,
// `xendit_cycle_<uuid>` overflowed Shopify's 40-char tag limit and threw
// 422 "Order tags is invalid". This locks in the fix.
// =================================================================
{
  let lcId = null;
  let lcSub = null;
  let lcCycleId = null;
  try {
    const { status: cs, body: cb } = await shopifyAdmin('/customers.json', {
      method: 'POST',
      body: JSON.stringify({
        customer: {
          first_name: 'QA',
          last_name: 'LongCycle',
          email: `qa+long-cycle-${Date.now()}@treelogy.com`,
          verified_email: true,
          tags: 'qa-test',
        },
      }),
    });
    if (cs !== 201 || !cb?.customer?.id) {
      record('long-cycle.setup', false, `customer create failed: ${cs}`);
    } else {
      lcId = String(cb.customer.id);
      const subRes = await fetch(
        buildSignedUrl('/api/subscribe', { plan_code: 'pro_monthly' }, lcId),
        { redirect: 'manual' },
      );
      const subLoc = subRes.headers.get('location') ?? '';
      if (!/xendit/i.test(subLoc)) {
        record('long-cycle.setup', false, `subscribe failed: ${subRes.status} ${subLoc.slice(0, 80)}`);
      } else {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('id, xendit_plan_id')
          .eq('shopify_customer_id', lcId)
          .single();
        lcSub = sub;

        // Activate
        await fetch(`${APP_URL}/api/webhook/xendit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
          body: JSON.stringify({
            id: `evt_qa_lc_act_${Date.now()}`,
            event: 'recurring.plan.activated',
            created: new Date().toISOString(),
            business_id: 'qa',
            data: { id: sub.xendit_plan_id, schedule: { next_execution_at: '2026-06-21T00:00:00Z' } },
          }),
        });

        // Realistic UUID-shaped Xendit cycle ID (37 chars — overflows old format).
        lcCycleId = `pacy_${crypto.randomUUID()}`;
        record('long-cycle.fixture-len', lcCycleId.length >= 37, `cycleId=${lcCycleId} (${lcCycleId.length} chars)`);

        // Send cycle.succeeded with that ID — must trigger real Shopify order
        const res = await fetch(`${APP_URL}/api/webhook/xendit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
          body: JSON.stringify({
            id: `evt_qa_lc_${Date.now()}`,
            event: 'recurring.cycle.succeeded',
            created: new Date().toISOString(),
            business_id: 'qa',
            data: {
              id: lcCycleId,
              recurring_plan_id: sub.xendit_plan_id,
              amount: 99000,
              currency: 'IDR',
              cycle_date: new Date().toISOString(),
              payment_method: { type: 'CARD' },
              payment_id: 'pay_qa_lc',
            },
          }),
        });
        const body = await res.json();
        record('long-cycle.webhook.200', res.status === 200 && body.ok === true, `body=${JSON.stringify(body)}`);

        const { data: inv } = await supabase
          .from('subscription_invoices')
          .select('status, shopify_sync_status, shopify_order_id, shopify_sync_error')
          .eq('xendit_cycle_id', lcCycleId)
          .single();
        record(
          'long-cycle.shopify-order-created',
          inv?.shopify_sync_status === 'SYNCED' && inv?.shopify_order_id != null,
          `sync=${inv?.shopify_sync_status} order=${inv?.shopify_order_id} err=${(inv?.shopify_sync_error ?? '').slice(0, 100)}`,
        );

        // Re-send same cycle.succeeded with same ID — must NOT create duplicate order
        const res2 = await fetch(`${APP_URL}/api/webhook/xendit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-callback-token': WEBHOOK_TOKEN },
          body: JSON.stringify({
            id: `evt_qa_lc_dup_${Date.now()}`,
            event: 'recurring.cycle.succeeded',
            created: new Date().toISOString(),
            business_id: 'qa',
            data: {
              id: lcCycleId,
              recurring_plan_id: sub.xendit_plan_id,
              amount: 99000,
              currency: 'IDR',
              payment_method: { type: 'CARD' },
            },
          }),
        });
        const body2 = await res2.json();
        record('long-cycle.idempotent.200', res2.status === 200 && body2.ok === true, `body=${JSON.stringify(body2)}`);
        // Should still be exactly one Shopify order for this customer
        const ordersRes = await shopifyAdmin(`/customers/${lcId}/orders.json?status=any&limit=10`, {});
        const orderCount = ordersRes.body?.orders?.length ?? 0;
        record('long-cycle.idempotent.no-dup-order', orderCount === 1, `order_count=${orderCount}`);
      }
    }
  } finally {
    if (lcSub?.xendit_plan_id && !lcSub.xendit_plan_id.startsWith('pending-')) {
      try {
        await xenditApi(`/recurring/plans/${lcSub.xendit_plan_id}/deactivate`, { method: 'POST' });
      } catch {}
    }
    if (lcId) {
      const ordersRes = await shopifyAdmin(`/customers/${lcId}/orders.json?status=any&limit=50`, {});
      for (const o of ordersRes.body?.orders ?? []) {
        await shopifyAdmin(`/orders/${o.id}.json`, { method: 'DELETE' });
      }
    }
    if (lcSub?.id) {
      await supabase.from('subscription_invoices').delete().eq('subscription_id', lcSub.id);
      await supabase.from('subscriptions').delete().eq('id', lcSub.id);
    }
    if (lcId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const d = await shopifyAdmin(`/customers/${lcId}.json`, { method: 'DELETE' });
        if (d.status === 200) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// =================================================================
// SECTION 12: Subscribe per-customer rate-limit (5 burst → 6th = 429)
// Uses a fake customer-id (passes signature) with a bogus plan code so
// each allowed request returns 400 quickly; the 6th hits the empty bucket.
// =================================================================
{
  const fakeRateId = String(99000000 + Math.floor(Math.random() * 999999));
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const u = buildSignedUrl(
      '/api/subscribe',
      { plan_code: 'qa-bogus-plan-rate-limit' },
      fakeRateId,
    );
    const r = await fetch(u, { redirect: 'manual' });
    statuses.push(r.status);
  }
  const last = statuses[statuses.length - 1];
  const firstFive = statuses.slice(0, 5);
  record(
    'subscribe.rate-limit.6th-429',
    last === 429 && firstFive.every((s) => s !== 429),
    `statuses=${statuses.join(',')}`,
  );
  // Cleanup bucket immediately so re-runs aren't sticky
  await supabase
    .from('rate_limit_counters')
    .delete()
    .eq('bucket_key', `subscribe:${fakeRateId}`);
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
