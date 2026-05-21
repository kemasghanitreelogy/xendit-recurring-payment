import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = readFileSync('/Users/kemasghani/Documents/xendit-recurring-payment/.env.local', 'utf8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const checks = {};

// 1. subscriptions
{
  const { data, error, count } = await supabase
    .from('subscriptions')
    .select('id', { count: 'exact', head: true });
  checks.subscriptions = error ? `ERR ${error.message}` : `OK rows=${count}`;
}

// 2. subscription_invoices
{
  const { data, error, count } = await supabase
    .from('subscription_invoices')
    .select('id', { count: 'exact', head: true });
  checks.subscription_invoices = error ? `ERR ${error.message}` : `OK rows=${count}`;
}

// 3. xendit_webhook_events
{
  const { data, error, count } = await supabase
    .from('xendit_webhook_events')
    .select('id', { count: 'exact', head: true });
  checks.xendit_webhook_events = error ? `ERR ${error.message}` : `OK rows=${count}`;
}

// 4. invoices_needing_shopify_sync view
{
  const { data, error, count } = await supabase
    .from('invoices_needing_shopify_sync')
    .select('id', { count: 'exact', head: true });
  checks.invoices_needing_shopify_sync_view = error ? `ERR ${error.message}` : `OK rows=${count}`;
}

console.log(JSON.stringify(checks, null, 2));
