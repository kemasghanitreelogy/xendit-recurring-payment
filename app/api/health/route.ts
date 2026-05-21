import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Returns 200 only when all dependencies are reachable. Used by external
// uptime monitors (Better Stack, UptimeRobot, etc.) and by the adaptive
// GitHub Actions cron to decide whether to even attempt a reconcile run.
//
// The check is intentionally cheap: a single Supabase select that touches
// the DB connection pool. We do NOT call Xendit or Shopify from here — those
// are external dependencies that can blip without breaking *our* service,
// and pinging them on every health probe would create unnecessary load.
//
// Response shape:
//   { ok, version, checks: { db: 'ok' | 'fail' }, backlog: { pending_invoices, dead_invoices, failed_tags } }

type HealthResponse = {
  ok: boolean;
  ts: string;
  checks: { db: 'ok' | 'fail' };
  backlog: {
    pending_invoices: number;
    dead_invoices: number;
    failed_tags: number;
  };
  error?: string;
};

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const admin = createAdminClient();
  const ts = new Date().toISOString();

  try {
    // Single round-trip pulls all three backlog counts via the head-count
    // mechanism — no row data transferred, just COUNT.
    const [pending, dead, failedTags] = await Promise.all([
      admin
        .from('subscription_invoices')
        .select('id', { count: 'exact', head: true })
        .in('shopify_sync_status', ['PENDING', 'FAILED'])
        .eq('status', 'SUCCEEDED'),
      admin
        .from('subscription_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('shopify_sync_status', 'DEAD'),
      admin
        .from('subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('shopify_tag_status', 'FAILED'),
    ]);

    const anyError = pending.error ?? dead.error ?? failedTags.error;
    if (anyError) {
      return NextResponse.json(
        {
          ok: false,
          ts,
          checks: { db: 'fail' },
          backlog: { pending_invoices: 0, dead_invoices: 0, failed_tags: 0 },
          error: anyError.message,
        },
        { status: 503 },
      );
    }

    const body: HealthResponse = {
      ok: true,
      ts,
      checks: { db: 'ok' },
      backlog: {
        pending_invoices: pending.count ?? 0,
        dead_invoices: dead.count ?? 0,
        failed_tags: failedTags.count ?? 0,
      },
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        ts,
        checks: { db: 'fail' },
        backlog: { pending_invoices: 0, dead_invoices: 0, failed_tags: 0 },
        error: String(err).slice(0, 200),
      },
      { status: 503 },
    );
  }
}
