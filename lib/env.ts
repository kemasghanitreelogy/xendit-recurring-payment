// Centralized env access. Each accessor reads + validates lazily on first
// call, so importing a module that uses env (e.g. `lib/xendit.ts`) doesn't
// blow up at build-time or cold start if Vercel's env is partially configured.
//
// `assertProdEnv()` is a startup-time check that can be called from any
// request handler to fail loud if a required variable is missing.

function read(name: string, opts: { allowEmpty?: boolean } = {}): string {
  const v = process.env[name];
  if (v === undefined || (!opts.allowEmpty && v === '')) {
    throw new Error(
      `Missing required env var: ${name}. ` +
        `Set it in .env.local for local dev or in the Vercel Project Settings → Environment Variables for deployments.`,
    );
  }
  return v;
}

function readOptional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export const env = {
  // Xendit
  get XENDIT_SECRET_KEY() {
    return read('XENDIT_SECRET_KEY');
  },
  get XENDIT_WEBHOOK_TOKEN() {
    return read('XENDIT_WEBHOOK_TOKEN');
  },
  get XENDIT_API_URL() {
    return readOptional('XENDIT_API_URL') ?? 'https://api.xendit.co';
  },

  // Supabase
  get SUPABASE_URL() {
    return read('NEXT_PUBLIC_SUPABASE_URL');
  },
  get SUPABASE_SERVICE_ROLE_KEY() {
    return read('SUPABASE_SERVICE_ROLE_KEY');
  },

  // Shopify
  get SHOPIFY_STORE_DOMAIN() {
    return read('SHOPIFY_STORE_DOMAIN');
  },
  get SHOPIFY_ADMIN_TOKEN() {
    return read('SHOPIFY_ADMIN_TOKEN');
  },
  get SHOPIFY_APP_PROXY_SECRET() {
    return read('SHOPIFY_APP_PROXY_SECRET');
  },
  get SHOPIFY_API_VERSION() {
    return readOptional('SHOPIFY_API_VERSION') ?? '2024-10';
  },

  // App
  get APP_URL() {
    const url = read('NEXT_PUBLIC_APP_URL');
    // Hard guard: don't ship localhost to Xendit's success/failure return URLs.
    if (process.env.VERCEL_ENV === 'production' && /localhost|127\.0\.0\.1/.test(url)) {
      throw new Error(
        `NEXT_PUBLIC_APP_URL is set to "${url}" in a production deployment. ` +
          `Customers redirected back from Xendit will fail to reach this app. ` +
          `Set NEXT_PUBLIC_APP_URL to your public domain (e.g. https://app.example.com).`,
      );
    }
    return url;
  },

  // Admin
  get ADMIN_RECONCILE_TOKEN() {
    return read('ADMIN_RECONCILE_TOKEN');
  },

  // Optional alerting webhook (Slack/Discord-compatible JSON POST URL).
  // If unset, alerts log to stderr only.
  get ALERT_WEBHOOK_URL() {
    return readOptional('ALERT_WEBHOOK_URL');
  },

  // Vercel cron secret — Vercel automatically signs cron requests with this
  // header so we can authorize them without leaking a long-lived token in URL.
  get CRON_SECRET() {
    return readOptional('CRON_SECRET');
  },
};
