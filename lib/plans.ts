export type PlanCode = 'pro_monthly' | 'pro_yearly' | 'business_monthly' | 'business_yearly';

export type Plan = {
  code: PlanCode;
  name: string;
  description: string;
  amount: number;
  currency: 'IDR';
  interval: 'MONTH' | 'YEAR';
  intervalCount: number;
  features: string[];
  trialDays?: number;
};

export const PLANS: Record<PlanCode, Plan> = {
  pro_monthly: {
    code: 'pro_monthly',
    name: 'Pro',
    description: 'Pro Plan - Bulanan',
    amount: 99_000,
    currency: 'IDR',
    interval: 'MONTH',
    intervalCount: 1,
    features: [
      'Unlimited projects',
      'Priority support',
      '100 GB storage',
    ],
  },
  pro_yearly: {
    code: 'pro_yearly',
    name: 'Pro',
    description: 'Pro Plan - Tahunan (hemat 17%)',
    amount: 990_000,
    currency: 'IDR',
    interval: 'YEAR',
    intervalCount: 1,
    features: [
      'Semua fitur Pro Bulanan',
      'Hemat 2 bulan',
    ],
  },
  business_monthly: {
    code: 'business_monthly',
    name: 'Business',
    description: 'Business Plan - Bulanan',
    amount: 299_000,
    currency: 'IDR',
    interval: 'MONTH',
    intervalCount: 1,
    features: [
      'Semua fitur Pro',
      'Team collaboration',
      'Advanced analytics',
      'SLA 99.9%',
    ],
  },
  business_yearly: {
    code: 'business_yearly',
    name: 'Business',
    description: 'Business Plan - Tahunan (hemat 17%)',
    amount: 2_990_000,
    currency: 'IDR',
    interval: 'YEAR',
    intervalCount: 1,
    features: [
      'Semua fitur Business Bulanan',
      'Hemat 2 bulan',
    ],
  },
};

export function getPlan(code: string): Plan | null {
  return PLANS[code as PlanCode] ?? null;
}

export function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount);
}
