import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { runReconcile, STALE_RESERVATION_HOURS } from './shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Operator-facing reconciliation endpoint.
 *
 * Auth:
 *   - Manual call:  Authorization: Bearer <ADMIN_RECONCILE_TOKEN>
 *   - Vercel Cron:  uses /api/admin/reconcile/cron (separate route) with
 *                   CRON_SECRET
 *
 * GET  /api/admin/reconcile         → audit report (counts + stale reservations)
 * POST /api/admin/reconcile         → retry failed Shopify syncs + tag fixes + cleanup
 * POST /api/admin/reconcile?dry=1   → report what would be retried, do nothing
 *
 * Safe to call repeatedly. Operations are idempotent (Shopify order dedupe
 * by tag, Shopify tag mutations are idempotent, reservation cleanup uses
 * created_at threshold).
 */

function authorize(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  if (!provided) return false;

  const expected = env.ADMIN_RECONCILE_TOKEN;
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  const { count: pendingInvoices } = await admin
    .from('subscription_invoices')
    .select('id', { count: 'exact', head: true })
    .in('shopify_sync_status', ['PENDING', 'FAILED'])
    .eq('status', 'SUCCEEDED');

  const { count: failedTags } = await admin
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('shopify_tag_status', 'FAILED');

  const staleCutoff = new Date(
    Date.now() - STALE_RESERVATION_HOURS * 3600 * 1000,
  ).toISOString();
  const { count: staleReservations } = await admin
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'PENDING')
    .like('xendit_plan_id', 'pending-%')
    .lt('created_at', staleCutoff);

  return NextResponse.json({
    invoices_needing_sync: pendingInvoices ?? 0,
    subscriptions_with_failed_tag: failedTags ?? 0,
    stale_reservations: staleReservations ?? 0,
  });
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const admin = createAdminClient();
  const result = await runReconcile(admin, { dryRun });
  return NextResponse.json(result);
}
