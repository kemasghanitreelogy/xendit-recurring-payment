import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { runReconcile } from '../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/admin/reconcile/cron
 *
 * Triggered by Vercel Cron every 15 minutes (configured in vercel.json).
 * Vercel injects `Authorization: Bearer ${CRON_SECRET}` automatically when
 * CRON_SECRET is set in project env. We constant-time compare it.
 *
 * The actual retry logic lives in `../shared.ts` so both this endpoint and
 * the operator-facing POST handler share the same implementation.
 */
export async function GET(req: Request) {
  const expected = env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured — set it in Vercel env to enable scheduled reconciliation.' },
      { status: 503 },
    );
  }

  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  const ok =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const result = await runReconcile(admin, { dryRun: false, actor: 'cron' });
  return NextResponse.json({ source: 'cron', ...result });
}
