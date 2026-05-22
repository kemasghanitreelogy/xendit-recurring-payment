-- ============================================================
-- 0004_cart_based_checkout.sql
--
-- Adds cart-based checkout (replaces fixed plan codes). The Shopify
-- theme posts the entire cart (line items) to /api/checkout; the
-- backend decides whether to create:
--   - Xendit Invoice           (pure one-time cart)
--   - Xendit Recurring Plan    (pure subscription cart)
--   - Xendit Recurring Plan    (mixed: cycle 1 = sub + addon, cycle 2+ = sub only)
--
-- Migration is additive. Old `plan_code` paths keep working — the
-- column stays NOT NULL, and cart-based rows use the literal value
-- 'cart' so existing tag/membership logic still has a key to read.
-- ============================================================

-- ============================================================
-- 1. Subscriptions: cart metadata + dynamic-amount tracking
-- ============================================================
alter table public.subscriptions
  add column if not exists cart_type text
    check (cart_type in ('PURE_SUBSCRIPTION', 'MIXED')),
  -- Original cart payload as posted by the theme (after server-side
  -- price validation). Kept verbatim so we can rebuild the Shopify
  -- order line items for every recurring cycle.
  add column if not exists cart_snapshot jsonb,
  -- Subscription-portion total per cycle. For PURE_SUBSCRIPTION this
  -- equals `amount`. For MIXED this equals what cycle 2+ should bill.
  add column if not exists subscription_amount integer,
  -- One-time addon portion. Only non-zero for MIXED. Charged in cycle 1
  -- bundled with subscription_amount; not charged in subsequent cycles.
  add column if not exists onetime_amount integer not null default 0,
  -- Set true once we've successfully PATCHed the Xendit plan amount
  -- down from (sub + addon) to (sub only) after cycle 1 succeeds.
  -- Used by reconcile to retry the PATCH if it failed mid-webhook.
  add column if not exists amount_adjusted boolean not null default false;

-- ============================================================
-- 2. One-time checkout orders (separate from subscriptions)
--
-- Pure-one-time carts don't have any subscription semantics — no
-- recurring plan, no tag, no cycle history. Putting them in
-- `subscriptions` would corrupt the partial-unique-active-sub
-- index (a customer can have many concurrent one-time orders).
-- ============================================================
create table if not exists public.checkout_orders (
  id uuid primary key default gen_random_uuid(),

  shopify_customer_id text not null,
  shopify_customer_email text not null,
  shopify_customer_name text,

  xendit_customer_id text not null,
  xendit_invoice_id text unique not null,
  xendit_reference_id text unique not null,

  amount integer not null,
  currency text not null default 'IDR',

  status text not null default 'PENDING'
    check (status in ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),

  cart_snapshot jsonb not null,
  paid_at timestamptz,

  -- Shopify Order sync tracking (mirrors subscription_invoices columns
  -- so reconcile logic can be parameterised over either table).
  shopify_order_id text,
  shopify_order_name text,
  shopify_sync_status text not null default 'PENDING'
    check (shopify_sync_status in ('PENDING', 'SYNCED', 'FAILED', 'SKIPPED', 'DEAD')),
  shopify_sync_attempts integer not null default 0,
  shopify_sync_error text,
  shopify_synced_at timestamptz,
  shopify_sync_dead_letter boolean not null default false,
  next_retry_at timestamptz,
  last_retry_at timestamptz,

  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_checkout_orders_customer
  on public.checkout_orders(shopify_customer_id);
create index if not exists idx_checkout_orders_status
  on public.checkout_orders(status);
create unique index if not exists idx_checkout_orders_shopify_order_unique
  on public.checkout_orders(shopify_order_id);
create index if not exists idx_checkout_orders_sync
  on public.checkout_orders(shopify_sync_status)
  where shopify_sync_status in ('PENDING', 'FAILED');
create index if not exists idx_checkout_orders_ready_for_retry
  on public.checkout_orders(next_retry_at)
  where shopify_sync_status = 'FAILED' and shopify_sync_dead_letter = false;

drop trigger if exists trg_checkout_orders_updated on public.checkout_orders;
create trigger trg_checkout_orders_updated
  before update on public.checkout_orders
  for each row execute function public.set_updated_at();

alter table public.checkout_orders enable row level security;
drop policy if exists checkout_orders_deny_all on public.checkout_orders;
create policy checkout_orders_deny_all on public.checkout_orders
  for all to anon, authenticated using (false) with check (false);


-- ============================================================
-- 3. Invoice line-item snapshot for recurring cycles
--
-- The recurring webhook needs to know WHICH Shopify variants to put
-- on the order it creates. For the first cycle of a MIXED cart, the
-- line items must include the one-time addon products too. We snapshot
-- the expected line items per cycle so the Shopify order matches the
-- customer's original cart contents.
-- ============================================================
alter table public.subscription_invoices
  add column if not exists line_items jsonb,
  add column if not exists is_first_cycle boolean not null default false;


-- ============================================================
-- 4. Reconciliation view extension — include checkout_orders
-- ============================================================
create or replace view public.checkout_orders_needing_shopify_sync
with (security_invoker = true) as
select *
from public.checkout_orders
where status = 'PAID'
  and shopify_sync_status in ('PENDING', 'FAILED')
  and shopify_sync_dead_letter = false
  and (next_retry_at is null or next_retry_at <= now());
