-- ============================================================
-- 0002_security_hardening.sql
--
-- Resolves Supabase database linter findings from 0001:
--   * 0011_function_search_path_mutable on set_updated_at
--   * 0010_security_definer_view on invoices_needing_shopify_sync
--   * 0008_rls_enabled_no_policy on subscriptions / invoices / webhook_events
--
-- Net effect: no behavioural change for the backend (service_role still
-- bypasses RLS). Anon / authenticated keys are explicitly denied, the
-- reconciliation view runs with the caller's permissions, and the
-- updated_at trigger function has a locked search_path.
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace view public.invoices_needing_shopify_sync
with (security_invoker = true) as
select i.*, s.shopify_customer_id, s.shopify_customer_email, s.plan_code
from public.subscription_invoices i
join public.subscriptions s on s.id = i.subscription_id
where i.status = 'SUCCEEDED'
  and i.shopify_sync_status in ('PENDING', 'FAILED');

create policy subscriptions_deny_all on public.subscriptions
  for all to anon, authenticated using (false) with check (false);

create policy subscription_invoices_deny_all on public.subscription_invoices
  for all to anon, authenticated using (false) with check (false);

create policy xendit_webhook_events_deny_all on public.xendit_webhook_events
  for all to anon, authenticated using (false) with check (false);
