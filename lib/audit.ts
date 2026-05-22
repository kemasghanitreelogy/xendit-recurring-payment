import { createAdminClient } from './supabase/admin';
import { log } from './logger';

// Append-only audit trail. Best-effort: a failure to write the audit row
// never propagates — observability shouldn't break the request path.
//
// Categories of audit events we care about for payments compliance:
//   - reconcile.run               (cron + manual reconciliation)
//   - webhook.replay              (operator re-runs a processed event)
//   - subscription.force_cancel   (operator override)
//   - subscription.reservation_cleaned (auto)
//   - invoice.dead_letter         (retries exhausted)

export type AuditEntry = {
  action: string;
  actor: 'system' | 'cron' | 'admin' | 'shopify' | 'xendit';
  targetType?: 'subscription' | 'invoice' | 'webhook_event' | 'customer' | 'checkout_order';
  targetId?: string;
  details?: Record<string, unknown>;
  requestId?: string;
  ipAddress?: string;
};

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('audit_log').insert({
      action: entry.action,
      actor: entry.actor,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      request_id: entry.requestId ?? null,
      ip_address: entry.ipAddress ?? null,
    });
    if (error) {
      log.warn('audit.write_failed', { action: entry.action, error: error.message });
    }
  } catch (err) {
    log.warn('audit.exception', { action: entry.action, error: String(err).slice(0, 200) });
  }
}
