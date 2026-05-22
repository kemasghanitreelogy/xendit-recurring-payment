# Setup Guide — Shopify × Xendit Recurring Bridge

End-to-end checklist untuk deploy backend ini + integrate dengan Shopify store kamu.

> **What's new (2026-05-22)**: cart-based checkout (`/api/checkout`) menggantikan flow plan_code statis. Backend sekarang baca isi cart Shopify dan klasifikasi: PURE_SUBSCRIPTION + MIXED diarahkan ke Xendit Recurring (mixed bundle one-time addon di cycle 1); PURE_ONETIME dipantulin balik ke native Shopify checkout untuk menghindari benturan dengan webhook invoice `api.treelogy.com`. Detail di **§ 3.6 Cart-based Checkout Flow** dan **§ 5.6 Invoice Webhook Conflict**.

## Arsitektur Singkat

```
[Shopify Storefront]
  Customer klik tombol Checkout (theme JS POST /cart.js → /apps/xendit/checkout)
        │
        ▼
[Shopify App Proxy] → forward + HMAC-sign query
        │
        │ POST body { line_items: [...] }
        ▼
[Next.js Backend /api/checkout (Vercel)]
  - Verify App Proxy HMAC
  - Validate cart line items via Shopify Admin API (anti-tamper)
  - Classify cart: PURE_ONETIME | PURE_SUBSCRIPTION | MIXED
  ─────────────────────────────────────────────────────────────
  PURE_ONETIME → 400 { code: USE_NATIVE_CHECKOUT, native_checkout_path: "/checkout" }
                 theme redirect ke Shopify native checkout
  ─────────────────────────────────────────────────────────────
  PURE_SUBSCRIPTION → Xendit Recurring Plan (amount = sub total)
                      INSERT subscriptions (PENDING)
                      return { redirect_url }
  ─────────────────────────────────────────────────────────────
  MIXED → Xendit Recurring Plan (amount = sub + onetime, FULL_AMOUNT)
          INSERT subscriptions (PENDING, cart_type=MIXED)
          return { redirect_url, first_cycle_amount, recurring_amount }
        │
        ▼
[Xendit Hosted Page] customer bayar (1x card capture)
        │
        ▼
[Xendit Webhook] → /api/webhook/xendit
  - Verify token + dedupe via xendit_webhook_events
  - recurring.cycle.succeeded:
      • Rebuild Shopify line items dari cart_snapshot
      • First MIXED cycle → include one-time addon items
      • Cycles 2+ → subscription items only
      • Create Shopify Order (idempotent via cycle ID tag)
      • For MIXED first cycle: PATCH plan amount → subscription_amount
      • Tag customer (subscriber, pro-member, etc.)
        │
        ▼
[Shopify Order created + Customer tagged]
  - Order muncul di Shopify Admin dengan exact line items dari cart customer
  - customer.tags contains 'subscriber' → unlock Liquid content
```

### Mengapa PURE_ONETIME dipantulin ke native checkout

Store ini sudah punya webhook `invoice.paid` di Xendit yang ke-routing ke
`https://api.treelogy.com/...` (integrasi existing). Xendit cuma boleh 1
URL per event type. Daripada bikin konflik routing atau memindahkan
ownership invoice handling, PURE_ONETIME cart (gak ada item subscription
sama sekali) tetap pakai native Shopify checkout yang udah jalan dengan
Xendit Payment Gateway. Backend Vercel ini fokus 100% ke yang Shopify+native
gak bisa handle: recurring/subscription billing.

---

## 1. Setup Supabase

### 1.1 Create Project
1. Login [supabase.com](https://supabase.com) → New Project → region **Singapore**
2. Catat **Project URL** dan **service_role key** dari Settings → API
3. **Tidak perlu** anon key — backend hanya pakai service_role

### 1.2 Apply Schema
Apply migrasi **secara berurutan** (Supabase SQL Editor → paste → Run untuk masing-masing file):

1. `supabase/migrations/0001_init.sql` — schema dasar (subscriptions, invoices, webhook events)
2. `supabase/migrations/0002_security_hardening.sql` — RLS deny-by-default + security_invoker views
3. `supabase/migrations/0003_world_class.sql` — retry backoff, rate-limit table, audit log
4. `supabase/migrations/0004_cart_based_checkout.sql` — cart-aware extension (cart_snapshot, checkout_orders, dll)

Verify hasil di Table Editor:
- **6 tabel**: `subscriptions`, `subscription_invoices`, `xendit_webhook_events`, `checkout_orders`, `audit_log`, `rate_limit_counters`
- **2 view**: `invoices_needing_shopify_sync`, `checkout_orders_needing_shopify_sync`
- Semua tabel RLS enabled

Catatan kolom dari 0004 di `subscriptions`:
- `cart_type` — `PURE_SUBSCRIPTION` | `MIXED`
- `cart_snapshot` jsonb — line items lengkap untuk rebuild Shopify order tiap cycle
- `subscription_amount` — target charge untuk cycles 2+ (sama dengan `amount` untuk PURE_SUBSCRIPTION; lebih kecil dari `amount` untuk MIXED)
- `onetime_amount` — bagian one-time addon yang cuma di-bill di cycle 1 (0 untuk PURE_SUBSCRIPTION)
- `amount_adjusted` — flag set true setelah Xendit plan amount di-PATCH ke `subscription_amount` post first cycle

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

Cukup **satu** webhook URL untuk semua event `recurring.*`. Tab Settings →
Developers → Webhooks, lalu di section **RECURRING**:

1. Field "Recurring" URL: `https://your-domain.vercel.app/api/webhook/xendit`
2. **Test and save** — should return `200 {"ok": true}` (cold-start ~5s pertama kali)
3. Verification token: Settings → Developers → Webhooks → **View Webhook Verification Token** → copy → `.env.local` sebagai `XENDIT_WEBHOOK_TOKEN`

Single field "Recurring" itu nge-cover semua sub-event yang diproses handler:
`recurring.plan.activated`, `recurring.plan.inactivated`, `recurring.cycle.created`,
`recurring.cycle.succeeded`, `recurring.cycle.retrying`, `recurring.cycle.failed`,
plus `payment.succeeded` / `payment.failed` yang otomatis di-ignore (sole entry
point untuk Shopify order creation = `recurring.cycle.succeeded`, lihat
`app/api/webhook/xendit/route.ts`).

### 2.3 Invoice Webhook — JANGAN diubah (lihat § 5.6)

Section **INVOICES** ("Invoices paid") boleh tetap ke URL existing
(`api.treelogy.com`). Backend Vercel ini gak butuh invoice events karena
PURE_ONETIME cart di-pantulin ke native Shopify checkout. Detail kenapa
di § 5.6.

> Kalau di masa depan lo butuh PURE_ONETIME via custom Xendit Invoice
> (mis. ada produk yang gak mau lewat Shopify checkout), opsinya: bikin
> Xendit sub-account terpisah dengan webhook URL terisolasi, atau bikin
> forwarder di `api.treelogy.com` yang ngirim copy invoice payload ke
> Vercel. Kode handler-nya udah ready (dormant) di webhook route.

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

### 4.1 Upload Snippets

Online Store → Themes → Edit code → Snippets → Add a new snippet:

| Snippet name | Source file | Tujuan |
|---|---|---|
| `checkout-via-xendit` | `shopify/checkout-via-xendit.liquid` | **Tombol checkout cart-aware** (recommended baru) |
| `subscribe-button` | `shopify/subscribe-button.liquid` | _Legacy:_ tombol per-product berbasis plan_code (masih jalan, tapi gak dipakai untuk cart-based flow) |
| `customer-subscription` | `shopify/customer-subscription.liquid` | Detail subscription di customer account page |

Wajib: `checkout-via-xendit` + `customer-subscription`. Optional/legacy: `subscribe-button`.

### 4.2 Wire tombol di Cart Drawer / Cart Page

Tombol Xendit checkout cuma muncul kalo cart punya minimal 1 subscription item.
Logic-nya ada 2 layer:

**Theme-side (rekomendasi)** — sebelum render tombol Xendit, cek isi cart:

```liquid
{% comment %}
  Render tombol Xendit kalo cart ada selling_plan_allocation, kalo nggak
  pakai native CHECK OUT default.
{% endcomment %}
{% assign has_subscription = false %}
{% for item in cart.items %}
  {% if item.selling_plan_allocation %}
    {% assign has_subscription = true %}
    {% break %}
  {% endif %}
{% endfor %}

{% if has_subscription %}
  {% render 'checkout-via-xendit', label: 'Checkout — Subscription' %}
{% else %}
  <button type="submit" name="checkout" class="btn btn--primary">Check out</button>
{% endif %}
```

**Backend-side (safety net)** — jika theme keliru forward PURE_ONETIME cart ke
`/api/checkout`, backend balas `400 { code: "USE_NATIVE_CHECKOUT", native_checkout_path: "/checkout" }`
dan JS di `checkout-via-xendit.liquid` otomatis redirect ke `/checkout` (lihat
`shopify/checkout-via-xendit.liquid` — JS handler udah include fallback ini).

### 4.3 Render di Customer Account Page
Di `templates/customers/account.liquid`, tambah di section yang kamu mau:

```liquid
{% render 'customer-subscription' %}
```

### 4.4 Subscription Product di Shopify Admin

Cart-based flow gak butuh "product placeholder" lagi — backend pakai
variant_id dan price dari Shopify Admin (authoritative). Yang lo perlu:

1. **Produk subscription real** yang lo jual di store (mis. Treelogy Test 45g)
2. **Selling Plan Group** ke-attach ke variant tersebut, mis. "Deliver every 3 months — 15% off"
3. Make sure selling plan billing policy = recurring (bukan one-time), interval = MONTH/WEEK/DAY/YEAR, intervalCount sesuai bisnis lo
4. Test: buka product page → confirm pilihan subscription muncul di varian selector

Cart line item dari Shopify AJAX `/cart.js` akan otomatis include
`selling_plan_allocation.selling_plan.id` kalo customer pilih opsi subscription.
JS di `checkout-via-xendit.liquid` baca itu dan kirim ke backend.

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

### 5.6 Invoice Webhook Conflict (PURE_ONETIME)

Konteks: di Treelogy, Xendit `invoice.paid` webhook udah ke-set ke
`https://api.treelogy.com/...` untuk handler invoice existing. Xendit cuma boleh
satu consumer per event type. Solusi yang ke-deploy:

- **Backend Vercel ini gak handle invoice events**. Webhook handler invoice
  (`handleInvoiceEvent` di `app/api/webhook/xendit/route.ts`) dan tabel
  `checkout_orders` tetap ada sebagai dormant plumbing untuk future split.
- **PURE_ONETIME cart** (semua line item gak ada `selling_plan_id`) di-reject
  di `/api/checkout` dengan response `400 { code: "USE_NATIVE_CHECKOUT", native_checkout_path: "/checkout" }`.
- **Theme JS** di `checkout-via-xendit.liquid` ngebaca code itu dan auto-redirect
  ke `/checkout` (Shopify native checkout, yang udah pakai Xendit Payment Gateway).

Future migration: kalau lo butuh PURE_ONETIME lewat Vercel backend (mis. payment
method khusus, custom hosted page), aktivasi dengan: (a) Xendit sub-account
terpisah → webhook URL terisolasi, atau (b) `api.treelogy.com` forward duplicate
payload ke Vercel `/api/webhook/xendit`. Handler dormant sudah type-safe, tinggal
remove the early `USE_NATIVE_CHECKOUT` branch + restore `handleOneTime` dispatch
di `/api/checkout`.

---

## 6. Test End-to-End

### 6.1 Test PURE_SUBSCRIPTION Flow (cart cuma subscription items)
1. Login sebagai customer di Shopify storefront
2. Add to cart: produk yang punya selling plan (mis. Test 45g — Deliver every 3 months)
3. Buka cart drawer → klik tombol Xendit checkout
4. Theme POST `/cart.js` content → `/apps/xendit/checkout` (App Proxy)
5. Backend response `{ redirect_url: "https://checkout.xendit.co/..." }`
6. Theme redirect → bayar pakai test card:
   - Card: `4000 0000 0000 0002`
   - CVV: `123`, Exp: `12/30`, 3DS OTP: `112233`
7. Setelah sukses → redirect ke `/billing/success?type=pure_subscription`

### 6.2 Test MIXED Cart Flow (subscription + one-time addon)
1. Add to cart: 1 produk subscription + 1 produk one-time (mis. Moringa Oil)
2. Cart total = Rp X (subscription) + Rp Y (one-time)
3. Klik tombol Xendit checkout
4. Backend response include `first_cycle_amount` (= X + Y) dan `recurring_amount` (= X only)
5. Redirect ke Xendit hosted page — total yang ditagih = `first_cycle_amount`
6. Bayar → success
7. Cek Shopify Admin: 1 order baru dengan **semua** line items (sub + one-time)
8. Tunggu cycle 2 (atau trigger manual via Xendit Dashboard → Recurring → Force next cycle)
9. Cycle 2 invoice ke-charge = `recurring_amount` (= X saja, tanpa one-time)
10. Shopify Admin: order cycle 2 cuma punya subscription line items

### 6.3 Test PURE_ONETIME Cart (must NOT call Xendit)
1. Add to cart: cuma produk one-time (gak ada selling plan)
2. Klik tombol Xendit (kalau theme keliru render-nya untuk PURE_ONETIME)
3. Backend response `400 { code: "USE_NATIVE_CHECKOUT" }`
4. Theme JS auto-redirect ke `/checkout` (Shopify native)
5. Customer bayar lewat Shopify Payment Gateway (Xendit gateway native) seperti biasa
6. Order di Shopify gak punya tag `xendit-recurring` (karena lewat checkout normal)

### 6.4 Verify Webhook + Sync (untuk PURE_SUBSCRIPTION & MIXED)
Tunggu ~10 detik setelah bayar, cek:

**Supabase:**
- `subscriptions` row baru, `status=ACTIVE`, `cart_type=PURE_SUBSCRIPTION` atau `MIXED`, `cart_snapshot` jsonb berisi line items
- `subscription_invoices` row baru cycle 1, `status=SUCCEEDED`, `shopify_sync_status=SYNCED`, `shopify_order_id` terisi, `is_first_cycle=true`, `line_items` jsonb
- MIXED only: setelah cycle 1 sukses, `subscriptions.amount_adjusted=true` dan `subscriptions.amount=subscription_amount` (turun dari `first_cycle_amount`)
- `xendit_webhook_events` rows baru per event, `processed_at` terisi

**Shopify Admin:**
- Orders → ada order baru, status **Paid**, line items match cart customer
- Customer → tags include `subscriber`, `pro-member`, `plan-cart` (atau equivalent)

### 6.5 Test Customer Account
1. Buka `/account` di Shopify
2. Section `customer-subscription` harus tampilkan plan info + tagihan berikutnya + riwayat
3. Klik **Batalkan** → konfirmasi → tunggu webhook `recurring.plan.inactivated` → status berubah jadi `CANCELED` + tag `subscriber` hilang

### 6.6 Test Reconciliation
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

Audit endpoint juga melaporkan:
- `invoices_needing_sync` — subscription_invoices yang status SUCCEEDED tapi belum sync ke Shopify
- `checkout_orders_needing_sync` — checkout_orders yang PAID tapi belum sync (dormant — selalu 0 untuk sekarang)
- `subscriptions_pending_plan_amount_fix` — MIXED subscription yang first cycle udah sukses tapi Xendit plan amount PATCH belum berhasil
- `subscriptions_with_failed_tag` — Shopify customer tag mutation gagal
- `stale_reservations` — PENDING reservation > 24 jam yang belum jadi real subscription

---

## 7. Data Integrity Guarantees

### Design Decisions

1. **Single source of truth for Shopify order creation = `recurring.cycle.succeeded`** (only). Other related events (`recurring.plan.activated`, `payment.succeeded`) are explicitly **not** used for order creation — their payloads don't carry a reliable cycle ID, so using them would corrupt the cycle-level idempotency key.

2. **Cycle ID is the idempotency key.** Stored as:
   - DB: UNIQUE column `subscription_invoices.xendit_cycle_id`
   - Shopify: order tag `xendit_cycle_id=<id>` (queried via Shopify GraphQL Orders search — REST `/orders.json` does NOT support tag filtering)

3. **DB writes happen before external API calls.** If Shopify is down during a webhook, the invoice row still gets inserted with `shopify_sync_status='FAILED'` + error message. The webhook returns 200 (so Xendit doesn't retry storm), and `/api/admin/reconcile` handles retry.

4. **Cart snapshot is captured at checkout time.** Once cart is validated, the full line items (with variant IDs, unit prices, titles) are stored on `subscriptions.cart_snapshot`. Webhook handlers rebuild Shopify Order line items from this snapshot — even if the original Shopify variants are later renamed, repriced, or deleted, the historical cycle still creates an order matching what the customer originally agreed to.

5. **MIXED cart plan amount mutation is best-effort + reconciled.** First cycle of MIXED bills (sub + addon) → after `recurring.cycle.succeeded` webhook, backend PATCHes Xendit plan amount to `subscription_amount` only. If that PATCH fails (network blip, Xendit 5xx), `subscriptions.amount_adjusted` stays `false` and reconcile job retries on next pass (every 15 min via GHA cron). Subscription intervals (>= 1 day, typically months) give plenty of headroom.

6. **Server-side cart validation defeats client-side tampering.** App Proxy HMAC signs query params but NOT the request body, so the theme can post anything as `line_items`. Backend cross-checks every `variant_id` against Shopify Admin GraphQL — unit prices and allowed `selling_plan_id`s come from Shopify, not the theme.

### Protection Matrix

| Risk | Protection |
|------|------------|
| Webhook duplicated by Xendit retry | `xendit_webhook_events.id` PK (unique) |
| Duplicate Shopify order for same cycle | `subscription_invoices.xendit_cycle_id` UNIQUE constraint + Shopify GraphQL tag lookup before create |
| Two active subs for same customer | Partial unique index `idx_subs_shopify_customer_active` |
| Race when concurrent checkout clicks | DB constraint (23505) → graceful 409 `DUPLICATE_SUBSCRIPTION` response |
| Shopify API down during webhook | Invoice saved with `shopify_sync_status=FAILED` + error → reconcile retries with exponential backoff |
| Webhook handler crash mid-process | DB writes first, external calls last → state recoverable from DB |
| Wrong event-ID extraction (plan vs cycle vs payment) | Source-level branching: `recurring.cycle.*` reads `data.recurring_plan_id`; `data.id` is the cycle ID for those events |
| Unauthorized webhook | `x-callback-token` verified (constant-time) |
| Unauthorized checkout request | Shopify App Proxy HMAC verified (constant-time) + 5-min timestamp window |
| Unauthorized reconcile call | Bearer token (constant-time compare) |
| Tag mutation silent failure | GraphQL `userErrors` checked; throws `ShopifyError` if non-empty |
| Client-side cart price tampering | Backend cross-checks every variant via Shopify Admin GraphQL — theme cannot override unit price or selling_plan_id |
| MIXED cart cycle-2 over-charge | Plan amount PATCH after first cycle + reconcile retries if PATCH fails (`amount_adjusted` flag) |
| Cart with mixed billing intervals | Backend rejects with `MIXED_INTERVALS` (Xendit recurring = one schedule per plan) |
| PURE_ONETIME bypassing native checkout | Theme JS handles `USE_NATIVE_CHECKOUT` response code → auto-redirect to `/checkout` |

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

-- 5. Cek MIXED subscription yang first-cycle PATCH belum jalan
--    (Reconcile akan retry; manual fix kalau backlog lama)
select id, shopify_customer_id, amount, subscription_amount, amount_adjusted, created_at
from public.subscriptions
where cart_type = 'MIXED' and amount_adjusted = false and status = 'ACTIVE';

-- 6. Audit cart_snapshot — pastikan setiap subscription cart-based punya snapshot
select id, cart_type, jsonb_array_length(cart_snapshot->'line_items') as item_count
from public.subscriptions
where cart_snapshot is not null
order by created_at desc limit 20;

-- 7. (Dormant) cek checkout_orders — selalu 0 row sampai PURE_ONETIME via Vercel diaktifkan
select count(*) from public.checkout_orders;
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
- [ ] Xendit webhook **RECURRING** section URL pakai domain production (`https://your-domain/api/webhook/xendit`)
- [ ] Xendit webhook **INVOICES** section gak diubah (tetap `api.treelogy.com`) — biarin existing integration jalan, PURE_ONETIME tetap lewat native Shopify checkout
- [ ] App Proxy URL pakai domain production
- [ ] `NEXT_PUBLIC_APP_URL` set ke production domain
- [ ] `ADMIN_RECONCILE_TOKEN` random + simpan aman
- [ ] `.env.local` di-gitignore (sudah default)
- [ ] Old/exposed keys sudah di-rotate
- [ ] Shopify Custom App scope minimal (cuma 4 scope yang disebut di atas)
- [ ] Migrasi `0001` → `0004` udah ke-apply ke Supabase production
- [ ] Theme udah pasang `checkout-via-xendit.liquid` snippet + conditional render berdasarkan `cart.items[].selling_plan_allocation`
- [ ] Selling Plan Group ke-attach ke variant subscription yang relevan di Shopify Admin
- [ ] Test full PURE_SUBSCRIPTION → bayar → cycle 2 di production
- [ ] Test MIXED cart → bayar → confirm cycle 2 amount = subscription_amount only
- [ ] Test PURE_ONETIME cart → confirm tombol fall-through ke `/checkout` native
- [ ] Setup cron (Vercel Cron / GitHub Actions) untuk auto-run `/api/admin/reconcile` setiap 15 menit (sudah ke-setup di `.github/workflows/reconcile.yml`)
- [ ] Setup alert kalau `invoices_needing_shopify_sync` > 0 selama > 1 jam atau `subscriptions_pending_plan_amount_fix` > 0 selama > 30 menit
