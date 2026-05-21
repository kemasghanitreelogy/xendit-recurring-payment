import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

// Service role: bypass RLS. JANGAN dipakai di client / Server Component
// yang bisa di-render ke user. Hanya untuk webhook & background jobs.
export function createAdminClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
