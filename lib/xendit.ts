const BASE = process.env.XENDIT_API_URL ?? 'https://api.xendit.co';
const SECRET = process.env.XENDIT_SECRET_KEY!;

if (!SECRET) {
  throw new Error('XENDIT_SECRET_KEY is not set');
}

const authHeader = `Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`;

export class XenditError extends Error {
  constructor(public status: number, public body: string, public code?: string) {
    super(`Xendit API ${status}: ${body}`);
    this.name = 'XenditError';
  }
}

async function xenditFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
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
  // Cek apakah customer sudah ada
  const existing = await xenditFetch<{ data: XenditCustomer[] }>(
    `/customers?reference_id=${encodeURIComponent(input.referenceId)}`
  );
  if (existing.data?.length > 0) return existing.data[0];

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
      metadata: {
        source: 'nextjs-app',
      },
    }),
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
