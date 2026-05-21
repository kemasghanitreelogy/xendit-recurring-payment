import { createClient } from '@supabase/supabase-js';

// Service role: bypass RLS. JANGAN dipakai di client / Server Component
// yang bisa di-render ke user. Hanya untuk webhook & background jobs.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}
