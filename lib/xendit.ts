import { env } from './env';

function authHeader(): string {
  return `Basic ${Buffer.from(`${env.XENDIT_SECRET_KEY}:`).toString('base64')}`;
}

export class XenditError extends Error {
  constructor(public status: number, public body: string, public code?: string) {
    super(`Xendit API ${status}: ${body}`);
    this.name = 'XenditError';
  }
}

async function xenditFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.XENDIT_API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      ...init.headers,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    let code: string | undefined;
    try { code = JSON.parse(text).error_code; } catch {}
    throw new XenditError(res.status, text, code);
  }
  return text ? JSON.parse(text) : ({} as T);
}

// ============================================================
// CUSTOMER
// ============================================================

export type XenditCustomer = {
  id: string;
  reference_id: string;
  email: string;
};

export async function createOrGetCustomer(input: {
  referenceId: string;
  email: string;
  givenName: string;
  surname?: string;
  mobileNumber?: string;
}): Promise<XenditCustomer> {
  // Cek apakah customer sudah ada.
  // Xendit Customer API quirk: GET /customers?reference_id=X returns HTTP 400
  // with error_code=CLIENT_NOT_FOUND_ERROR when no match exists (instead of
  // an empty data array). Treat that as "doesn't exist yet" and fall through
  // to the create path. Any other error must still propagate.
  try {
    const existing = await xenditFetch<{ data: XenditCustomer[] }>(
      `/customers?reference_id=${encodeURIComponent(input.referenceId)}`
    );
    if (existing.data?.length > 0) return existing.data[0];
  } catch (err) {
    if (!(err instanceof XenditError && err.code === 'CLIENT_NOT_FOUND_ERROR')) {
      throw err;
    }
  }

  return xenditFetch<XenditCustomer>('/customers', {
    method: 'POST',
    body: JSON.stringify({
      reference_id: input.referenceId,
      type: 'INDIVIDUAL',
      email: input.email,
      mobile_number: input.mobileNumber,
      individual_detail: {
        given_names: input.givenName,
        surname: input.surname,
      },
    }),
  });
}

// ============================================================
// RECURRING PLAN
// ============================================================

export type RecurringInterval = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export type RecurringPlan = {
  id: string;
  reference_id: string;
  customer_id: string;
  status: 'REQUIRES_ACTION' | 'ACTIVE' | 'INACTIVE' | 'PENDING';
  amount: number;
  currency: string;
  actions: {
    action: string;
    url: string;
    url_type: 'WEB' | 'DEEPLINK' | 'MOBILE';
    method: string;
  }[];
  schedule?: {
    interval?: RecurringInterval;
    interval_count?: number;
    anchor_date?: string;
    next_execution_at?: string;
  };
};

export type RecurringPlanItem = {
  type?: 'DIGITAL_PRODUCT' | 'PHYSICAL_PRODUCT' | 'DIGITAL_SERVICE' | 'PHYSICAL_SERVICE' | 'FEES' | 'DISCOUNT';
  name: string;
  net_unit_amount: number;
  quantity: number;
  url?: string;
  description?: string;
};

export async function createRecurringPlan(input: {
  customerId: string;
  referenceId: string;
  amount: number;
  currency?: string;
  interval: RecurringInterval;
  intervalCount?: number;
  description: string;
  successUrl: string;
  failureUrl: string;
  anchorDate?: Date;
  trialDays?: number;
  items?: RecurringPlanItem[];
  metadata?: Record<string, string>;
}): Promise<RecurringPlan> {
  // Clone so we never mutate caller's Date.
  const anchorDate = new Date(input.anchorDate ?? Date.now());
  if (input.trialDays) {
    anchorDate.setDate(anchorDate.getDate() + input.trialDays);
  }

  return xenditFetch<RecurringPlan>('/recurring/plans', {
    method: 'POST',
    body: JSON.stringify({
      reference_id: input.referenceId,
      customer_id: input.customerId,
      recurring_action: 'PAYMENT',
      currency: input.currency ?? 'IDR',
      amount: input.amount,
      schedule: {
        reference_id: `${input.referenceId}-schedule`,
        interval: input.interval,
        interval_count: input.intervalCount ?? 1,
        anchor_date: anchorDate.toISOString(),
        retry_interval: 'DAY',
        retry_interval_count: 1,
        total_retry: 3,
        failed_attempt_notifications: [1, 2, 3],
      },
      immediate_action_type: input.trialDays ? null : 'FULL_AMOUNT',
      notification_config: {
        recurring_created: ['EMAIL'],
        recurring_succeeded: ['EMAIL'],
        recurring_failed: ['EMAIL'],
        locale: 'id',
      },
      success_return_url: input.successUrl,
      failure_return_url: input.failureUrl,
      description: input.description,
      items: input.items,
      metadata: {
        source: 'nextjs-app',
        ...(input.metadata ?? {}),
      },
    }),
  });
}

/**
 * Mutate the per-cycle charge amount on a live Xendit Recurring Plan.
 *
 * Used by the MIXED-cart flow: cycle 1 charges (subscription + one-time
 * addon) so the customer pays for everything in their cart with a single
 * card capture; after `recurring.cycle.succeeded` for that first cycle,
 * we PATCH the plan down to the subscription-only amount so cycles 2+
 * bill the recurring price the customer signed up for.
 *
 * Safe to retry — Xendit treats this as idempotent state.
 */
export async function updateRecurringPlanAmount(
  planId: string,
  amount: number,
): Promise<RecurringPlan> {
  return xenditFetch<RecurringPlan>(`/recurring/plans/${planId}`, {
    method: 'PATCH',
    body: JSON.stringify({ amount }),
  });
}

export async function getRecurringPlan(planId: string) {
  return xenditFetch<RecurringPlan>(`/recurring/plans/${planId}`);
}

export async function deactivateRecurringPlan(planId: string) {
  return xenditFetch<RecurringPlan>(`/recurring/plans/${planId}/deactivate`, {
    method: 'POST',
  });
}

export async function pauseRecurringPlan(planId: string) {
  return xenditFetch<RecurringPlan>(`/recurring/plans/${planId}/pause`, {
    method: 'POST',
  });
}

export async function resumeRecurringPlan(planId: string) {
  return xenditFetch<RecurringPlan>(`/recurring/plans/${planId}/resume`, {
    method: 'POST',
  });
}

// ============================================================
// INVOICE (one-time hosted checkout)
// ============================================================

export type XenditInvoice = {
  id: string;
  external_id: string;
  user_id: string;
  status: 'PENDING' | 'PAID' | 'SETTLED' | 'EXPIRED';
  amount: number;
  currency: string;
  invoice_url: string;
  expiry_date: string;
  payer_email?: string;
  description?: string;
  customer?: { id?: string; email?: string };
  paid_at?: string;
  payment_method?: string;
  payment_channel?: string;
};

export type XenditInvoiceItem = {
  name: string;
  quantity: number;
  price: number;
  category?: string;
  url?: string;
};

export async function createInvoice(input: {
  externalId: string;
  customerId?: string;
  amount: number;
  currency?: string;
  description: string;
  payerEmail: string;
  successUrl: string;
  failureUrl: string;
  expirySeconds?: number;
  items?: XenditInvoiceItem[];
  metadata?: Record<string, string>;
}): Promise<XenditInvoice> {
  // Invoice API lives at /v2/invoices (separate from /recurring/plans).
  return xenditFetch<XenditInvoice>('/v2/invoices', {
    method: 'POST',
    body: JSON.stringify({
      external_id: input.externalId,
      amount: input.amount,
      currency: input.currency ?? 'IDR',
      description: input.description,
      payer_email: input.payerEmail,
      customer_id: input.customerId,
      success_redirect_url: input.successUrl,
      failure_redirect_url: input.failureUrl,
      invoice_duration: input.expirySeconds ?? 24 * 60 * 60,
      items: input.items,
      metadata: {
        source: 'nextjs-app',
        ...(input.metadata ?? {}),
      },
    }),
  });
}

export async function getInvoice(invoiceId: string): Promise<XenditInvoice> {
  return xenditFetch<XenditInvoice>(`/v2/invoices/${invoiceId}`);
}
