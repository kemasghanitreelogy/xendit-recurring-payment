-- ============================================================
-- 0003_world_class.sql
--
-- Adds production-grade primitives that aren't tied to any paid service:
--
--   * Exponential backoff for retry scheduling
--   * Dead-letter status when retries exhausted
--   * Token-bucket rate-limit storage
--   * Append-only audit log for admin actions
--   * Retention helpers (purge old webhook events)
--
-- All changes are additive and backwards compatible with the existing
-- handlers. The migration is idempotent — safe to re-run.
-- ============================================================


-- ============================================================
-- 1. Retry tracking on subscription_invoices
-- ============================================================
alter table public.subscription_invoices
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_retry_at timestamptz,
  add column if not exists shopify_sync_dead_letter boolean not null default false;

-- Allow DEAD as a sync status. Existing rows keep their current value.
do $$
begin
  alter table public.subscription_invoices
    drop constraint if exists subscription_invoices_shopify_sync_status_check;
  alter table public.subscription_invoices
    add constraint subscription_invoices_shopify_sync_status_check
    check (shopify_sync_status in ('PENDING','SYNCED','FAILED','SKIPPED','DEAD'));
exception when others then null;
end $$;

-- Index for "ready to retry now" scans: only failed rows that are eligible.
create index if not exists idx_inv_ready_for_retry
  on public.subscription_invoices(next_retry_at)
  where shopify_sync_status = 'FAILED' and shopify_sync_dead_letter = false;

-- Update the reconciliation view to honor the retry schedule + dead-letter flag.
-- security_invoker is inherited from migration 0002.
create or replace view public.invoices_needing_shopify_sync
with (security_invoker = true) as
select i.*, s.shopify_customer_id, s.shopify_customer_email, s.plan_code
from public.subscription_invoices i
join public.subscriptions s on s.id = i.subscription_id
where i.status = 'SUCCEEDED'
  and i.shopify_sync_status in ('PENDING', 'FAILED')
  and i.shopify_sync_dead_letter = false
  and (i.next_retry_at is null or i.next_retry_at <= now());


-- ============================================================
-- 2. Rate-limit storage (token bucket per identity key)
-- ============================================================
create table if not exists public.rate_limit_counters (
  -- key = e.g. `subscribe:<shopify_customer_id>` or `webhook:<ip>`
  bucket_key text primary key,
  tokens integer not null,
  capacity integer not null,
  refill_rate_per_sec real not null,
  last_refill timestamptz not null default now()
);

alter table public.rate_limit_counters enable row level security;

drop policy if exists rate_limit_counters_deny_all on public.rate_limit_counters;
create policy rate_limit_counters_deny_all on public.rate_limit_counters
  for all to anon, authenticated using (false) with check (false);

-- Atomic consume-or-deny operation. Returns true if a token was consumed,
-- false if the bucket was empty. Refills tokens linearly based on elapsed
-- time since `last_refill`, capped at `capacity`.
--
-- Caller invokes via Supabase RPC: `supabase.rpc('consume_rate_limit', {
--   p_key: 'subscribe:123', p_capacity: 5, p_refill_per_sec: 0.1
-- })`
create or replace function public.consume_rate_limit(
  p_key text,
  p_capacity integer,
  p_refill_per_sec real
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_tokens integer;
  v_last timestamptz;
  v_elapsed real;
  v_refilled integer;
begin
  -- Atomic upsert + lock — anything else hitting the same key blocks here.
  insert into public.rate_limit_counters
    (bucket_key, tokens, capacity, refill_rate_per_sec, last_refill)
  values (p_key, p_capacity, p_capacity, p_refill_per_sec, v_now)
  on conflict (bucket_key) do update set
    capacity = excluded.capacity,
    refill_rate_per_sec = excluded.refill_rate_per_sec
  returning tokens, last_refill into v_tokens, v_last;

  -- Refill based on elapsed seconds.
  v_elapsed := greatest(extract(epoch from (v_now - v_last))::real, 0.0);
  v_refilled := least(p_capacity, v_tokens + floor(v_elapsed * p_refill_per_sec)::integer);

  if v_refilled <= 0 then
    -- Still empty; just update last_refill so the elapsed clock resets cleanly.
    update public.rate_limit_counters
      set last_refill = v_now
      where bucket_key = p_key;
    return false;
  end if;

  update public.rate_limit_counters
    set tokens = v_refilled - 1,
        last_refill = v_now
    where bucket_key = p_key;
  return true;
end;
$$;


-- ============================================================
-- 3. Audit log — append-only record of every admin action
-- ============================================================
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  -- 'reconcile.run', 'webhook.replay', 'subscription.force_cancel', etc.
  action text not null,
  -- 'cron', 'admin', 'system'
  actor text not null,
  target_type text,        -- 'subscription', 'invoice', 'webhook_event', null
  target_id text,
  details jsonb not null default '{}'::jsonb,
  request_id text,
  ip_address text
);

create index if not exists idx_audit_occurred on public.audit_log(occurred_at desc);
create index if not exists idx_audit_action on public.audit_log(action);
create index if not exists idx_audit_target on public.audit_log(target_type, target_id);

alter table public.audit_log enable row level security;
drop policy if exists audit_log_deny_all on public.audit_log;
create policy audit_log_deny_all on public.audit_log
  for all to anon, authenticated using (false) with check (false);


-- ============================================================
-- 4. Retention helper — delete fully-processed webhook events older than N days
-- ============================================================
create or replace function public.purge_old_webhook_events(p_retention_days integer default 90)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.xendit_webhook_events
   where processed_at is not null
     and received_at < now() - make_interval(days => p_retention_days)
   returning 1 into v_deleted;
  -- The `delete ... returning` only returns the LAST row; use the row-count
  -- diagnostic instead so we report the real total.
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
