-- ============================================================
-- Xendit Recurring × Shopify Bridge — Schema
--
-- Design principles:
-- 1. DB is source of truth for subscription state.
-- 2. Idempotency enforced by UNIQUE constraints, not by code.
-- 3. Every row that maps to external entity (Shopify order, Xendit
--    cycle, Xendit payment) tracks sync status + retry metadata
--    so a failed external call never causes silent data loss.
-- 4. RLS deny-by-default. Backend uses service_role only.
-- ============================================================

-- ============================================================
-- TABLE: subscriptions
-- One active subscription per Shopify customer enforced by
-- partial unique index. No Supabase Auth dependency.
-- ============================================================
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),

  -- Shopify customer identity (numeric ID as text for safety)
  shopify_customer_id text not null,
  shopify_customer_email text not null,
  shopify_customer_name text,

  -- Xendit identifiers
  xendit_customer_id text not null,
  xendit_plan_id text unique not null,
  xendit_reference_id text unique not null,

  -- Plan snapshot (so historical rows don't break when PLANS{} changes)
  plan_code text not null,
  amount integer not null,
  currency text not null default 'IDR',
  interval text not null check (interval in ('MONTH', 'YEAR', 'WEEK', 'DAY')),
  interval_count integer not null default 1,

  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED')),

  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  trial_ends_at timestamptz,

  -- Track whether customer tag was applied to Shopify customer
  shopify_tag_status text not null default 'PENDING'
    check (shopify_tag_status in ('PENDING', 'TAGGED', 'UNTAGGED', 'FAILED')),
  shopify_tag_last_attempt_at timestamptz,
  shopify_tag_error text,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_subs_shopify_customer on public.subscriptions(shopify_customer_id);
create index idx_subs_plan on public.subscriptions(xendit_plan_id);
create index idx_subs_status on public.subscriptions(status);

-- Prevent two active/pending subs for same Shopify customer
create unique index idx_subs_shopify_customer_active
  on public.subscriptions(shopify_customer_id)
  where status in ('ACTIVE', 'PAST_DUE', 'PENDING');

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create trigger trg_subs_updated
  before update on public.subscriptions
  for each row execute function public.set_updated_at();


-- ============================================================
-- TABLE: subscription_invoices
-- One row per billing cycle. Each row maps 1:1 to one
-- Shopify Order via shopify_order_id (set after successful sync).
-- ============================================================
create table public.subscription_invoices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,

  -- Xendit identifiers (unique constraints prevent duplicates from retries)
  xendit_payment_id text unique,
  xendit_cycle_id text,

  amount integer not null,
  currency text not null default 'IDR',
  status text not null
    check (status in ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED')),

  payment_method text,
  paid_at timestamptz,
  failure_reason text,

  -- Shopify Order sync tracking
  shopify_order_id text,                          -- Shopify numeric order ID
  shopify_order_name text,                        -- e.g. "#1042"
  shopify_sync_status text not null default 'PENDING'
    check (shopify_sync_status in ('PENDING', 'SYNCED', 'FAILED', 'SKIPPED')),
  shopify_sync_attempts integer not null default 0,
  shopify_sync_error text,
  shopify_synced_at timestamptz,

  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Each Xendit cycle becomes at most one invoice (idempotency).
-- Note: full UNIQUE (no WHERE) is required so PostgreSQL can use it as
-- the conflict target for INSERT ... ON CONFLICT (xendit_cycle_id).
-- NULL values do not collide in UNIQUE (NULL != NULL semantics).
create unique index idx_inv_xendit_cycle_unique
  on public.subscription_invoices(xendit_cycle_id);

-- Each Shopify order is referenced at most once. Same rationale.
create unique index idx_inv_shopify_order_unique
  on public.subscription_invoices(shopify_order_id);

create index idx_inv_sub on public.subscription_invoices(subscription_id);
create index idx_inv_payment on public.subscription_invoices(xendit_payment_id);
create index idx_inv_sync_status on public.subscription_invoices(shopify_sync_status)
  where shopify_sync_status in ('PENDING', 'FAILED');

create trigger trg_inv_updated
  before update on public.subscription_invoices
  for each row execute function public.set_updated_at();


-- ============================================================
-- TABLE: xendit_webhook_events
-- Dedupe + audit log for incoming Xendit webhooks
-- ============================================================
create table public.xendit_webhook_events (
  id text primary key,                            -- Xendit event ID
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  received_at timestamptz not null default now()
);

create index idx_webhook_type on public.xendit_webhook_events(event_type);
create index idx_webhook_received on public.xendit_webhook_events(received_at desc);


-- ============================================================
-- ROW LEVEL SECURITY
-- RLS is deny-by-default. Backend uses service_role which
-- bypasses RLS. No policies needed for end-user access since
-- end users hit Shopify, not Supabase directly.
-- ============================================================
alter table public.subscriptions enable row level security;
alter table public.subscription_invoices enable row level security;
alter table public.xendit_webhook_events enable row level security;


-- ============================================================
-- VIEW: subscriptions_needing_shopify_sync
-- Returns invoices that succeeded at Xendit but haven't been
-- synced to Shopify (or sync failed). Used by /api/admin/reconcile.
-- ============================================================
create or replace view public.invoices_needing_shopify_sync as
select i.*, s.shopify_customer_id, s.shopify_customer_email, s.plan_code
from public.subscription_invoices i
join public.subscriptions s on s.id = i.subscription_id
where i.status = 'SUCCEEDED'
  and i.shopify_sync_status in ('PENDING', 'FAILED');
