import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { audit } from '@/lib/audit';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/admin/webhook-replay
// Body: { eventId: string }
//
// Disaster-recovery endpoint. Re-processes a stored webhook event by POSTing
// it back through our own /api/webhook/xendit pipeline.
//
// Why this is needed:
//   - If a Shopify rate-limit / outage causes a sync failure AND reconcile
//     also fails (e.g. dead-lettered), an operator may want to manually
//     re-trigger the original handler after fixing the upstream issue
//     (rotating API token, adjusting product config, etc.).
//   - The event is already dedupe'd in xendit_webhook_events, so we
//     temporarily clear `processed_at` and re-dispatch. The handler is
//     fully idempotent (Shopify order create deduped by cycle ID tag,
//     DB upserts deduped by xendit_cycle_id unique).
//
// Auth: Bearer ADMIN_RECONCILE_TOKEN (same as reconcile — operator-only).

function authorize(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  if (!provided) return false;
  const expected = env.ADMIN_RECONCILE_TOKEN;
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

type ReplayBody = { eventId?: string };

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ReplayBody;
  try {
    body = (await req.json()) as ReplayBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.eventId || typeof body.eventId !== 'string') {
    return NextResponse.json({ error: 'eventId required' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Fetch the stored event.
  const { data: event, error: fetchErr } = await admin
    .from('xendit_webhook_events')
    .select('id, event_type, payload, processed_at')
    .eq('id', body.eventId)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json({ error: 'DB error', detail: fetchErr.message }, { status: 500 });
  }
  if (!event) {
    return NextResponse.json({ error: 'Event not found', eventId: body.eventId }, { status: 404 });
  }

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;

  // Clear processed marker + delete the row so the handler's dedupe INSERT
  // succeeds. We re-construct it through normal flow rather than calling
  // handleEvent directly so we exercise the full path (token, parse, dedupe).
  await admin.from('xendit_webhook_events').delete().eq('id', body.eventId);

  // Dispatch internally. We could just POST to our own URL, but in a single
  // process we can fetch directly with the same headers Xendit would send.
  const appUrl = env.APP_URL;
  const dispatchRes = await fetch(`${appUrl}/api/webhook/xendit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-callback-token': env.XENDIT_WEBHOOK_TOKEN,
      'x-request-id': requestId,
      // Mark this as a replay so the handler / logs can distinguish.
      'x-replay': '1',
    },
    body: JSON.stringify(event.payload),
  });

  const dispatchBody = await dispatchRes.json().catch(() => ({}));

  audit({
    action: 'webhook.replay',
    actor: 'admin',
    targetType: 'webhook_event',
    targetId: body.eventId,
    details: {
      original_event_type: event.event_type,
      dispatch_status: dispatchRes.status,
      dispatch_body: dispatchBody,
      was_previously_processed: event.processed_at != null,
    },
    requestId,
    ipAddress: ipAddress ?? undefined,
  });

  log.info('webhook.replay', {
    eventId: body.eventId,
    dispatchStatus: dispatchRes.status,
    requestId,
  });

  return NextResponse.json({
    ok: dispatchRes.ok,
    eventId: body.eventId,
    dispatch: { status: dispatchRes.status, body: dispatchBody },
  });
}
