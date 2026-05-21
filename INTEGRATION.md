# Setup Guide — Shopify × Xendit Recurring Bridge

End-to-end checklist untuk deploy backend ini + integrate dengan Shopify store kamu.

## Arsitektur Singkat

```
[Shopify Storefront]
  Customer login + klik "Subscribe" di product page
        │
        │ /apps/xendit/subscribe?plan_code=pro_monthly
        ▼
[Shopify App Proxy] → forward + sign with shared secret
        │
        │ ?...&logged_in_customer_id=X&signature=Y
        ▼
[Next.js Backend (Vercel)]
  - Verify HMAC App Proxy
  - Get/create Xendit customer + plan
  - INSERT subscription (PENDING) di Supabase
  - 302 → Xendit hosted checkout
        │
        ▼
[Xendit Hosted Page] customer bayar
        │
        ▼
[Xendit Webhook] → Next.js backend
  - Verify token
  - Dedupe by event ID
  - UPDATE subscription status
  - Create Shopify Order (idempotent via cycle ID tag)
  - Tag Shopify customer (pro-member)
        │
        ▼
[Shopify Order created + Customer tagged]
  - Order muncul di Shopify Admin → counted as revenue
  - customer.tags contains 'pro-member' → unlock Liquid content
```

---

## 1. Setup Supabase

### 1.1 Create Project
1. Login [supabase.com](https://supabase.com) → New Project → region **Singapore**
2. Catat **Project URL** dan **service_role key** dari Settings → API
3. **Tidak perlu** anon key — backend hanya pakai service_role

### 1.2 Apply Schema
Copy isi `supabase/migrations/0001_init.sql` → paste ke **SQL Editor** Supabase → Run.

Verify: di Table Editor harus ada 3 tabel (`subscriptions`, `subscription_invoices`, `xendit_webhook_events`) dan 1 view (`invoices_needing_shopify_sync`).

---

## 2. Setup Xendit

### 2.1 Generate API Key
1. Dashboard Xendit → Settings → Developers → API Keys → **Generate Secret Key**
2. Nama: `treelogy-prod` (atau bebas, max 15 char)
3. Permissions yang aktifkan:
   - **Money-in products → Recurring payments → WRITE**
   - Balance → Read (opsional, untuk monitoring)
   - Transaction → Read (opsional, untuk debug)
4. Copy key (`xnd_production_xxx` atau `xnd_development_xxx`) → simpan di `.env.local` sebagai `XENDIT_SECRET_KEY`

> ⚠️ Kalau key sebelumnya sudah ter-expose di mana pun (chat, terminal, file), **rotate dulu**.

### 2.2 Setup Webhook
1. Settings → Developers → Webhooks → Recurring section → Edit
2. URL: `https://your-domain.vercel.app/api/webhook/xendit`
3. Aktifkan SEMUA event ini:
   - `recurring.plan.activated`
   - `recurring.plan.inactivated`
   - `recurring.cycle.created`
   - `recurring.cycle.succeeded`
   - `recurring.cycle.retrying`
   - `recurring.cycle.failed`
   - `payment.succeeded`
   - `payment.failed`
4. Save → copy **Verification Token** → `.env.local` sebagai `XENDIT_WEBHOOK_TOKEN`

---

## 3. Setup Shopify Custom App

### 3.1 Buat Custom App
1. Shopify Admin → Settings → **Apps and sales channels** → **Develop apps**
2. Allow custom app development (kalau belum)
3. **Create an app** → nama: `Xendit Recurring Bridge`

### 3.2 Configure Admin API Scopes
Tab **Configuration** → Admin API integration → Configure → centang minimal:
- `read_customers`, `write_customers` — untuk tag customer
- `read_orders`, `write_orders` — untuk create paid order

Save.

### 3.3 Install App + Get Access Token
1. Tab **API credentials** → **Install app**
2. Copy **Admin API access token** (format `shpat_xxxxxxxxxxxx`) → `.env.local` sebagai `SHOPIFY_ADMIN_TOKEN`
3. Copy **API secret key** (di section "App credentials") → `.env.local` sebagai `SHOPIFY_APP_PROXY_SECRET`

### 3.4 Configure App Proxy
Tab **Configuration** → App proxy → Configure:
- **Subpath prefix**: `apps`
- **Subpath**: `xendit`
- **Proxy URL**: `https://your-domain.vercel.app/api`

> Artinya: hits ke `https://yourstore.myshopify.com/apps/xendit/*` di-forward ke `https://your-domain.vercel.app/api/*`. Jadi `/apps/xendit/subscribe` → backend `/api/subscribe`.

Save.

### 3.5 Catat Store Domain
Set `SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com` di `.env.local` (tanpa `https://`, tanpa trailing slash).

---

## 4. Setup Shopify Theme

### 4.1 Upload Snippet
1. Online Store → Themes → Edit code
2. Snippets → Add a new snippet → nama `subscribe-button`
3. Paste isi `shopify/subscribe-button.liquid`
4. Save

Repeat untuk `customer-subscription` (untuk akun customer page).

### 4.2 Render di Product Page
Di `sections/main-product.liquid` (atau template product yang kamu pakai), tambah:

```liquid
{% render 'subscribe-button',
  plan_code: 'pro_monthly',
  label: 'Subscribe Pro - Rp 99.000/bulan' %}
```

### 4.3 Render di Customer Account Page
Di `templates/customers/account.liquid`, tambah di section yang kamu mau:

```liquid
{% render 'customer-subscription' %}
```

### 4.4 Buat Product Placeholder
Shopify Admin → Products → Add product:
- Title: `Pro Subscription`
- Description: bebas
- Price: 99,000 IDR
- **Track quantity: OFF**
- **This is a physical product: OFF**
- Save → catat URL handle (`/products/pro-subscription`)

---

## 5. Deploy Backend ke Vercel

### 5.1 Push ke Git
```bash
cd /Users/kemasghani/docs/xendit-recurring-subscription
git init
git add .
git commit -m "Initial: Shopify × Xendit recurring bridge"
git remote add origin <your-repo-url>
git push -u origin main
```

### 5.2 Connect Vercel
1. [vercel.com/new](https://vercel.com/new) → Import Git Repository
2. Framework Preset: Next.js (auto-detected)
3. Environment Variables — **set semua untuk Production environment**:

   **Required:**
   - `XENDIT_SECRET_KEY` (production key `xnd_production_...`)
   - `XENDIT_WEBHOOK_TOKEN`
   - `XENDIT_API_URL` = `https://api.xendit.co`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SHOPIFY_STORE_DOMAIN`
   - `SHOPIFY_ADMIN_TOKEN`
   - `SHOPIFY_APP_PROXY_SECRET`
   - `SHOPIFY_API_VERSION` = `2024-10`
   - `NEXT_PUBLIC_APP_URL` = **`https://your-project.vercel.app`** ⚠️
     (kalau lupa update dari `localhost:3000`, customer setelah bayar nyangkut. App akan throw error di production kalau ada `localhost` di URL ini.)
   - `ADMIN_RECONCILE_TOKEN` = `openssl rand -hex 32`

   **Required untuk Cron + Alerting (production):**
   - `CRON_SECRET` = `openssl rand -hex 32` (Vercel inject otomatis ke `/api/admin/reconcile/cron`)
   - `ALERT_WEBHOOK_URL` = Slack/Discord incoming webhook URL untuk alert webhook failures
4. Deploy

> 💡 **Reconciliation scheduling** (penting untuk Hobby plan)
>
> Vercel Hobby cron dibatasi **1×/hari** dengan timing precision ±59 menit ([source](https://vercel.com/docs/cron-jobs/usage-and-pricing)). 24 jam terlalu lambat untuk retry Shopify sync failures.
>
> **Solusi (sudah ter-set-up di repo ini):**
> - `vercel.json` jadwal: **harian jam 03:00 WIB** — safety net, deploy-safe di Hobby
> - `.github/workflows/reconcile.yml` jadwal: **setiap 15 menit** via GitHub Actions cron (free, hit endpoint `/api/admin/reconcile/cron` pakai `CRON_SECRET`)
>
> Setup GitHub Actions cron:
> 1. Repo → Settings → Secrets and variables → Actions → New repository secret
> 2. Tambah `APP_URL` = `https://your-project.vercel.app`
> 3. Tambah `CRON_SECRET` = **nilai yang sama persis** dengan env var `CRON_SECRET` di Vercel project
> 4. (Optional) Manual trigger: Actions tab → "Reconcile (every 15 min)" → Run workflow
>
> Kalau upgrade ke Vercel Pro nanti, edit `vercel.json` schedule jadi `*/15 * * * *` dan hapus GHA workflow.

### 5.3 Update Webhook URL + App Proxy URL
Setelah deploy berhasil, balik ke:
- **Xendit Webhook**: update URL ke `https://your-project.vercel.app/api/webhook/xendit`
- **Shopify App Proxy**: update Proxy URL ke `https://your-project.vercel.app/api`

### 5.4 (Recommended) IP allowlist webhook
Xendit publikasi IP webhook mereka. Di Vercel Project Settings → **Firewall**, tambahkan custom rule yang block traffic ke `/api/webhook/xendit` dari IP selain Xendit. Ini lapis kedua di atas `XENDIT_WEBHOOK_TOKEN` — kalau token leak, IP allowlist masih nge-block penyerang.

Daftar IP terkini: lihat [Xendit Webhook IPs](https://docs.xendit.co/xendit-api/api-changelog/webhook-ips) atau hubungi Xendit support.

### 5.5 (Recommended) Smoke test dengan dev key terlebih dahulu
Sebelum pakai `xnd_production_...`:
1. Generate `xnd_development_...` key di Xendit dashboard
2. Set di Vercel **Preview** environment (bukan Production)
3. Deploy preview, lalu test pakai test card: `4000 0000 0000 0002`, CVV `123`, OTP `112233`
4. Verify webhook flow Active → Cycle.succeeded → Shopify order created → tag applied
5. Setelah preview pass, baru flip Production env ke production key

---

## 6. Test End-to-End

### 6.1 Test Subscribe Flow
1. Login sebagai customer di Shopify storefront
2. Buka product page yang sudah ada tombol Subscribe
3. Klik **Subscribe** → harusnya redirect ke Xendit hosted page
4. Pakai test card (kalau di Test Mode):
   - Card: `4000 0000 0000 0002`
   - CVV: `123`, Exp: `12/30`, 3DS OTP: `112233`
5. Setelah sukses → redirect ke `/billing/success`

### 6.2 Verify Webhook + Sync
Tunggu ~10 detik, cek:

**Supabase:**
- `subscriptions` row baru, status `ACTIVE`
- `subscription_invoices` row baru, `status=SUCCEEDED`, `shopify_sync_status=SYNCED`, `shopify_order_id` terisi
- `xendit_webhook_events` row baru, `processed_at` terisi

**Shopify Admin:**
- Orders → harus ada order baru, status **Paid**
- Customer → tag `pro-member` ter-add

### 6.3 Test Customer Account
1. Buka `/account` di Shopify
2. Section `customer-subscription` harus tampilkan plan info + tagihan berikutnya + riwayat
3. Klik **Batalkan** → konfirmasi → tunggu webhook `recurring.plan.inactivated` → status berubah jadi CANCELED + tag `pro-member` hilang

### 6.4 Test Reconciliation
```bash
# Audit (read-only)
curl -H "Authorization: Bearer $ADMIN_RECONCILE_TOKEN" \
  https://your-project.vercel.app/api/admin/reconcile

# Dry run retry
curl -X POST -H "Authorization: Bearer $ADMIN_RECONCILE_TOKEN" \
  "https://your-project.vercel.app/api/admin/reconcile?dry=1"

# Actual retry
curl -X POST -H "Authorization: Bearer $ADMIN_RECONCILE_TOKEN" \
  https://your-project.vercel.app/api/admin/reconcile
```

---

## 7. Data Integrity Guarantees

### Design Decisions

1. **Single source of truth for Shopify order creation = `recurring.cycle.succeeded`** (only). Other related events (`recurring.plan.activated`, `payment.succeeded`) are explicitly **not** used for order creation — their payloads don't carry a reliable cycle ID, so using them would corrupt the cycle-level idempotency key.

2. **Cycle ID is the idempotency key.** Stored as:
   - DB: UNIQUE column `subscription_invoices.xendit_cycle_id`
   - Shopify: order tag `xendit_cycle_id=<id>` (queried via Shopify GraphQL Orders search — REST `/orders.json` does NOT support tag filtering)

3. **DB writes happen before external API calls.** If Shopify is down during a webhook, the invoice row still gets inserted with `shopify_sync_status='FAILED'` + error message. The webhook returns 200 (so Xendit doesn't retry storm), and `/api/admin/reconcile` handles retry.

### Protection Matrix

| Risk | Protection |
|------|------------|
| Webhook duplicated by Xendit retry | `xendit_webhook_events.id` PK (unique) |
| Duplicate Shopify order for same cycle | `subscription_invoices.xendit_cycle_id` UNIQUE constraint (full, not partial — required for `INSERT ... ON CONFLICT`) + Shopify GraphQL tag lookup before create |
| Two active subs for same customer | Partial unique index `idx_subs_shopify_customer_active` |
| Race when concurrent subscribe clicks | DB constraint (23505) → graceful redirect to Shopify account |
| Shopify API down during webhook | Invoice saved with `shopify_sync_status=FAILED` + error → `/api/admin/reconcile` retry |
| Webhook handler crash mid-process | DB writes first, external calls last → state recoverable from DB |
| Wrong event-ID extraction (plan vs cycle vs payment) | Source-level branching: `recurring.cycle.*` reads `data.recurring_plan_id` (never `data.id` as fallback); `data.id` is the cycle ID for those events |
| Unauthorized webhook | `x-callback-token` verified |
| Unauthorized subscribe request | Shopify App Proxy HMAC verified (constant-time) + 5-min timestamp window |
| Unauthorized reconcile call | Bearer token (constant-time compare) |
| Tag mutation silent failure | GraphQL `userErrors` checked; throws `ShopifyError` if non-empty |

### Audit queries (run di Supabase SQL Editor):

```sql
-- 1. Cek invoices yang sukses bayar tapi belum sync ke Shopify
select * from public.invoices_needing_shopify_sync;

-- 2. Cek customer dengan tag yang gagal di-apply
select id, shopify_customer_id, status, shopify_tag_status, shopify_tag_error
from public.subscriptions
where shopify_tag_status = 'FAILED';

-- 3. Cek webhook events yang gagal diproses
select id, event_type, error, received_at
from public.xendit_webhook_events
where error is not null
order by received_at desc;

-- 4. Cek duplicate cycle (harusnya selalu 0 karena unique index)
select xendit_cycle_id, count(*)
from public.subscription_invoices
where xendit_cycle_id is not null
group by xendit_cycle_id having count(*) > 1;
```

---

## 8. Operational Runbook

### Customer komplain bayar tapi gak dapat akses

1. Cek di Xendit dashboard → cari customer → confirm payment success
2. Cek `subscription_invoices` di Supabase pakai `shopify_customer_id` mereka
3. Kalau `shopify_sync_status = FAILED` → jalankan `POST /api/admin/reconcile`
4. Kalau `shopify_tag_status = FAILED` → reconcile juga handle ini
5. Kalau subscription belum ada sama sekali → cek `xendit_webhook_events` apakah webhook masuk

### Webhook dari Xendit tidak masuk

1. Cek Xendit dashboard → Webhooks → Logs → lihat retry history
2. Verify URL webhook = `https://your-domain.vercel.app/api/webhook/xendit`
3. Verify `XENDIT_WEBHOOK_TOKEN` di Vercel env match dengan Xendit dashboard
4. Test manual: `curl -X POST <url> -H "x-callback-token: <token>" -d '{}'`

### Shopify order tidak ke-create padahal pembayaran sukses

1. Cek di Supabase: `select * from subscription_invoices where xendit_payment_id = 'xxx'`
2. Lihat `shopify_sync_error` untuk root cause
3. Common causes:
   - `401`: token Shopify expired/wrong scope → re-install Custom App
   - `422`: invalid customer ID atau payload → check error body
   - `429`: rate limited → tunggu, lalu reconcile
4. Setelah fix, jalankan reconcile

### Cara cancel manually (override)

```sql
-- Di Supabase SQL Editor
update public.subscriptions
set status = 'CANCELED', canceled_at = now()
where shopify_customer_id = '<id>' and status in ('ACTIVE', 'PAST_DUE');
```

Lalu di Xendit dashboard → Recurring → cari plan → Deactivate. Lalu remove tag manual di Shopify customer.

---

## 9. Production Checklist

- [ ] Xendit di **Live Mode** (bukan Test Mode)
- [ ] `XENDIT_SECRET_KEY` pakai `xnd_production_xxx`
- [ ] Webhook URL pakai domain production (bukan ngrok)
- [ ] App Proxy URL pakai domain production
- [ ] `NEXT_PUBLIC_APP_URL` set ke production domain
- [ ] `ADMIN_RECONCILE_TOKEN` random + simpan aman
- [ ] `.env.local` di-gitignore (sudah default)
- [ ] Old/exposed keys sudah di-rotate
- [ ] Shopify Custom App scope minimal (cuma 4 scope yang disebut di atas)
- [ ] Test full subscribe → bayar → cancel flow di production
- [ ] Setup cron (Vercel Cron / GitHub Actions) untuk auto-run `/api/admin/reconcile` setiap 30 menit
- [ ] Setup alert kalau `invoices_needing_shopify_sync` > 0 selama > 1 jam
