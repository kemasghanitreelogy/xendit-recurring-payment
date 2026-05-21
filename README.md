# Xendit × Shopify Recurring Bridge

Backend service yang menjembatani **Shopify storefront** dengan **Xendit Recurring Payments API** untuk auto subscription di Indonesia (di mana Shopify native tidak mendukung Xendit recurring).

Customer login di Shopify → klik tombol Subscribe → bayar di Xendit hosted page → backend auto-sync Shopify Order + tag customer. Mendukung Kartu Kredit/Debit, OVO, DANA, ShopeePay, LinkAja, BCA OneKlik, BRI/Mandiri Direct Debit.

> 📘 **Untuk panduan setup lengkap (Shopify Custom App, App Proxy, deployment), lihat [INTEGRATION.md](./INTEGRATION.md).**

---

## Daftar Isi

1. [Arsitektur & Flow](#1-arsitektur--flow)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [API Endpoints](#4-api-endpoints)
5. [Webhook Events Reference](#5-webhook-events-reference)
6. [State Machine](#6-state-machine)
7. [Data Integrity Guarantees](#7-data-integrity-guarantees)
8. [Quick Start](#8-quick-start)
9. [Troubleshooting](#9-troubleshooting)
10. [FAQ](#10-faq)
11. [References](#11-references)

---

## 1. Arsitektur & Flow

### Flow Subscribe

```
┌────────────────┐     ┌──────────────────┐     ┌──────────┐     ┌──────────┐
│   Shopify      │     │  Next.js Backend │     │  Xendit  │     │ Supabase │
│  Storefront    │     │     (Vercel)     │     │   API    │     │    DB    │
└───────┬────────┘     └────────┬─────────┘     └────┬─────┘     └────┬─────┘
        │                       │                    │                │
        │ 1. Click Subscribe    │                    │                │
        │  /apps/xendit/        │                    │                │
        │  subscribe?plan=...   │                    │                │
        ├──────────────────────▶│                    │                │
        │ (App Proxy adds:      │                    │                │
        │  logged_in_customer_  │                    │                │
        │  id + HMAC signature) │                    │                │
        │                       │                    │                │
        │                       │ 2. Verify HMAC     │                │
        │                       │                    │                │
        │                       │ 3. GET customer    │                │
        │                       │    (Shopify Admin) │                │
        │                       │                    │                │
        │                       │ 4. Create Xendit   │                │
        │                       │    customer + plan │                │
        │                       ├───────────────────▶│                │
        │                       │◀───────────────────┤                │
        │                       │   plan_id +        │                │
        │                       │   checkout_url     │                │
        │                       │                    │                │
        │                       │ 5. INSERT sub      │                │
        │                       │    (PENDING)       │                │
        │                       ├──────────────────────────────────▶│
        │                       │                    │                │
        │ 6. 302 → Xendit       │                    │                │
        │◀──────────────────────┤                    │                │
        │                       │                    │                │
        │ 7. Pilih metode bayar (Card/OVO/DANA/etc.)│                │
        ├──────────────────────────────────────────▶│                │
        │                       │                    │                │
        │ 8. Redirect ke success_url                 │                │
        │◀───────────────────────────────────────────┤                │
        │                       │                    │                │
        │                       │ 9. Webhook         │                │
        │                       │   recurring.plan.  │                │
        │                       │   activated +      │                │
        │                       │   recurring.cycle. │                │
        │                       │   succeeded        │                │
        │                       │◀───────────────────┤                │
        │                       │                    │                │
        │                       │ 10. UPDATE sub     │                │
        │                       │    + Create        │                │
        │                       │    Shopify Order   │                │
        │                       │    + Tag customer  │                │
        │                       ├──────────────────────────────────▶│
        │                       │                    │                │
        │  11. customer.tags    │                    │                │
        │      contains         │                    │                │
        │      'pro-member'     │                    │                │
        │                       │                    │                │
        │  ── Tiap Bulan ──     │                    │                │
        │                       │                    │                │
        │                       │ 12. Xendit auto-   │                │
        │                       │     charge         │                │
        │                       │ 13. Webhook        │                │
        │                       │   recurring.cycle. │                │
        │                       │   succeeded        │                │
        │                       │◀───────────────────┤                │
        │                       │ 14. New Shopify    │                │
        │                       │     Order (paid)   │                │
        │                       │     +tag refresh   │                │
```

### Komponen

| Komponen | Tugas |
|----------|-------|
| **Shopify Storefront** | UI tombol Subscribe (Liquid), customer identity, account page |
| **Shopify App Proxy** | Forward request ke backend + inject `logged_in_customer_id` + HMAC sign |
| **Next.js Backend** | Orchestrator: verify HMAC → Xendit API → Supabase DB → Shopify Admin API |
| **Xendit** | Hosted checkout, auto-charge tiap bulan, webhook event source |
| **Supabase (Postgres only)** | Source of truth subscription state, dedupe webhook events |
| **Shopify Admin API** | Create Order (paid) + tag customer (`pro-member`) |

---

## 2. Tech Stack

- **Next.js 15** App Router (Node.js runtime, no Edge)
- **TypeScript** strict mode
- **Supabase Postgres** sebagai DB (no Supabase Auth — auth via Shopify customer)
- **Xendit Recurring API v2** (IDR only)
- **Shopify Admin API 2024-10** (REST untuk order create, GraphQL untuk tag + order search)
- **Shopify App Proxy** dengan HMAC SHA256 signature verification (5-min timestamp window)
- **Vercel** deployment target (Fluid Compute Node.js)

---

## 3. Project Structure

```
xendit-recurring-subscription/
├── README.md                              ← you are here
├── INTEGRATION.md                         ← setup step-by-step
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── .env.example                           ← template (no real values)
├── .gitignore
│
├── app/
│   ├── layout.tsx
│   ├── page.tsx                           ← landing/status page
│   ├── globals.css
│   ├── api/
│   │   ├── subscribe/route.ts             ← Shopify App Proxy → Xendit checkout
│   │   ├── subscription/
│   │   │   ├── cancel/route.ts            ← Shopify App Proxy → Xendit deactivate
│   │   │   └── current/route.ts           ← Shopify App Proxy → DB read
│   │   ├── webhook/xendit/route.ts        ← Xendit webhook (atomic sync)
│   │   └── admin/reconcile/route.ts       ← Bearer-token; retry failed syncs
│   └── billing/
│       ├── success/page.tsx               ← Xendit success return URL
│       ├── failed/page.tsx                ← Xendit failure return URL
│       └── already/page.tsx               ← Fallback for duplicate sub
│
├── lib/
│   ├── plans.ts                           ← Plan config + IDR formatter
│   ├── xendit.ts                          ← Xendit API client
│   ├── shopify.ts                         ← Shopify Admin API (REST + GraphQL)
│   ├── shopify-proxy.ts                   ← App Proxy HMAC verify
│   └── supabase/admin.ts                  ← service-role DB client
│
├── supabase/
│   └── migrations/0001_init.sql           ← schema + indexes + RLS
│
└── shopify/                               ← upload ke Shopify theme
    ├── subscribe-button.liquid            ← snippet untuk product page
    └── customer-subscription.liquid       ← snippet untuk customer account
```

---

## 4. API Endpoints

| Method | Path | Authentication | Purpose |
|--------|------|----------------|---------|
| `GET`  | `/api/subscribe?plan_code=...` | Shopify App Proxy HMAC | Create Xendit plan + 302 to checkout |
| `POST` | `/api/subscription/cancel` | Shopify App Proxy HMAC | Deactivate active plan |
| `GET`  | `/api/subscription/current` | Shopify App Proxy HMAC | Return current sub + invoices for Liquid |
| `POST` | `/api/webhook/xendit` | `x-callback-token` header | Webhook event handler |
| `GET`  | `/api/admin/reconcile` | `Authorization: Bearer <token>` | Audit count of failed syncs |
| `POST` | `/api/admin/reconcile[?dry=1]` | `Authorization: Bearer <token>` | Retry failed Shopify orders + tags |

Semua endpoint pakai Node.js runtime (`runtime = 'nodejs'`) — bukan Edge.

---

## 5. Webhook Events Reference

| Xendit Event | Trigger | DB Action | Shopify Action |
|--------------|---------|-----------|----------------|
| `recurring.plan.activated` | Plan aktif setelah first charge sukses | `status=ACTIVE`, set `current_period_*` | Add tags `subscriber`, `${tier}-member`, `plan-${plan_code}` |
| `recurring.plan.inactivated` | Plan di-cancel (manual atau habis retry) | `status=CANCELED`, `canceled_at=now()` | Remove tag |
| `recurring.cycle.created` | Cycle baru dibuat (sebelum charge) | Insert invoice `status=PENDING` | — |
| `recurring.cycle.succeeded` | Charge sukses | Upsert invoice `SUCCEEDED`, refresh `period_end` | **Create paid Order** + refresh tags |
| `recurring.cycle.retrying` | Charge gagal, akan retry (default 3x) | `status=PAST_DUE` | — (tags tetap, customer keep access) |
| `recurring.cycle.failed` | Semua retry habis | `status=CANCELED`, invoice `FAILED` | Remove tags |
| `payment.succeeded` | Generic payment event | (ignored — overlap with `recurring.cycle.succeeded`) | — |
| `payment.failed` | Generic payment event | (ignored — overlap with `recurring.cycle.failed`) | — |

### Important Field Mapping (per Xendit Schema)

- **`recurring.plan.*` events**: `data.id` = plan ID
- **`recurring.cycle.*` events**: `data.id` = cycle ID, `data.recurring_plan_id` = plan ID
- **`payment.*` events**: `data.id` = payment ID (intentionally ignored — see source comment)

Source of truth untuk Shopify order creation = **`recurring.cycle.succeeded` only**. Cycle ID dipakai sebagai idempotency key (di-tag ke Shopify order sebagai `xendit_cycle_id=<id>` dan di-unique-constrain di DB).

### Webhook Payload Example

```json
{
  "id": "evt_abc123",
  "event": "recurring.cycle.succeeded",
  "created": "2026-05-21T00:00:00Z",
  "business_id": "biz_xyz",
  "data": {
    "id": "rpc_def456",
    "recurring_plan_id": "rp_abc789",
    "customer_id": "cust_xxx",
    "amount": 99000,
    "currency": "IDR",
    "cycle_date": "2026-05-21T00:00:00Z",
    "next_cycle_date": "2026-06-21T00:00:00Z",
    "payment_method": { "type": "CARD" }
  }
}
```

---

## 6. State Machine

```
           ┌─────────┐
           │ PENDING │ ← INSERT saat /api/subscribe sukses create Xendit plan
           └────┬────┘
                │ recurring.plan.activated (first charge success)
                ▼
           ┌─────────┐
      ┌───▶│ ACTIVE  │
      │    └────┬────┘
      │         │ recurring.cycle.retrying (charge gagal, akan retry)
      │         ▼
      │    ┌──────────┐
      │    │ PAST_DUE │ ← customer KEEP tag selama retry window
      │    └────┬─────┘
      │         │
      │ ┌───────┴───────┐
      │ │               │
      │ │ retry sukses  │ retry habis (cycle.failed)
      │ │               │ atau cancel manual (plan.inactivated)
      └─┘               ▼
                   ┌──────────┐
                   │ CANCELED │ ← tag dihapus
                   └──────────┘
```

`PAUSED` ada di schema tapi tidak dipakai di flow standard — disediakan kalau later butuh pause/resume manual via Xendit API.

---

## 7. Data Integrity Guarantees

Sistem ini dirancang untuk **zero data miss & zero duplicate**:

| Risiko | Proteksi |
|--------|----------|
| Webhook duplicated (Xendit retry) | `xendit_webhook_events.id` PRIMARY KEY → 23505 catch |
| Duplicate Shopify Order per cycle | `subscription_invoices.xendit_cycle_id` UNIQUE + Shopify GraphQL tag lookup di `lib/shopify.ts:findOrderByXenditCycle` |
| Two active subs untuk same customer | Partial UNIQUE `idx_subs_shopify_customer_active` (status in ACTIVE/PAST_DUE/PENDING) |
| Race condition concurrent subscribe click | DB unique violation (23505) → graceful redirect ke Shopify account |
| Shopify API down saat webhook | Invoice tetap saved dengan `shopify_sync_status='FAILED'` + error message → `/api/admin/reconcile` retry |
| Webhook handler crash mid-process | DB writes happen BEFORE external API calls → state recoverable dari DB |
| Unauthorized webhook | `x-callback-token` verified |
| Unauthorized subscribe request | Shopify App Proxy HMAC verified (constant-time compare) + 5-min timestamp window |
| Unauthorized reconcile call | `Authorization: Bearer` (constant-time compare) |
| Timing attack pada signature | `crypto.timingSafeEqual` di semua HMAC compare |

### Audit Queries (di Supabase SQL Editor)

```sql
-- 1. Invoice yang sukses bayar tapi belum sync ke Shopify
select * from public.invoices_needing_shopify_sync;

-- 2. Customer dengan tag yang gagal di-apply
select id, shopify_customer_id, status, shopify_tag_status, shopify_tag_error
from public.subscriptions
where shopify_tag_status = 'FAILED';

-- 3. Webhook events yang gagal diproses
select id, event_type, error, received_at
from public.xendit_webhook_events
where error is not null
order by received_at desc;

-- 4. Cek duplicate cycle (harusnya selalu 0 berkat UNIQUE)
select xendit_cycle_id, count(*)
from public.subscription_invoices
where xendit_cycle_id is not null
group by xendit_cycle_id having count(*) > 1;
```

---

## 8. Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup env (jangan commit nilai sebenarnya — pakai .env.local)
cp .env.example .env.local
# Edit .env.local: isi Xendit, Supabase, Shopify credentials

# 3. Apply DB schema
# Copy isi supabase/migrations/0001_init.sql → run di Supabase SQL Editor

# 4. Run dev server
npm run dev
# Server jalan di http://localhost:3000

# 5. Typecheck
npm run typecheck
```

**Setup full integration (Shopify Custom App, App Proxy, deployment) → ikuti [INTEGRATION.md](./INTEGRATION.md).**

---

## 9. Troubleshooting

### `Invalid signature` saat hit `/api/subscribe`
1. `SHOPIFY_APP_PROXY_SECRET` di env match dengan "API secret key" di Custom App
2. App Proxy URL di Shopify config menunjuk ke domain backend yang benar
3. Customer benar-benar masuk via Shopify proxy URL `/apps/xendit/subscribe...` (bukan direct hit ke backend)

### Webhook tidak masuk
1. Cek **Xendit Dashboard → Webhooks → Logs** untuk retry history
2. Verify `XENDIT_WEBHOOK_TOKEN` di env = Verification Token di Xendit dashboard
3. Pastikan return 2xx dari endpoint (webhook handler return 200 bahkan saat Shopify sync gagal — by design)
4. Test manual: `curl -X POST <url>/api/webhook/xendit -H "x-callback-token: <token>" -d '{}'`

### Shopify Order tidak ke-create padahal pembayaran sukses
1. Query Supabase: `select shopify_sync_status, shopify_sync_error from subscription_invoices where xendit_payment_id = 'xxx'`
2. Common root causes di `shopify_sync_error`:
   - `401`: Shopify token expired/scope kurang → re-install Custom App + tambah scope
   - `422`: invalid customer ID atau payload → check error body
   - `429`: rate limited → tunggu, lalu reconcile
3. Setelah fix: `curl -X POST -H "Authorization: Bearer $ADMIN_RECONCILE_TOKEN" <url>/api/admin/reconcile`

### `current_period_end` null setelah ACTIVE
Xendit kadang tidak kirim `next_execution_at` di `recurring.plan.activated`. Handler sudah auto-refetch via `getRecurringPlan`. Kalau masih null, manual update:
```sql
update public.subscriptions
set current_period_end = '<date>'
where id = '<sub_id>';
```

### Customer komplain bayar tapi tidak dapat akses
Lihat runbook lengkap di [INTEGRATION.md §8](./INTEGRATION.md#8-operational-runbook).

### Test card Stripe (`4242 ...`) tidak work di Xendit
Pakai test card Xendit: `4000 0000 0000 0002` (success), CVV `123`, exp future date, OTP `112233`.

---

## 10. FAQ

**Q: Apakah perlu PCI-DSS compliance?**
A: Tidak. Card data tidak pernah menyentuh backend ini — customer input card langsung di Xendit hosted page. Xendit PCI-DSS Level 1 certified.

**Q: Bagaimana cara kasih akses gated content di Shopify?**
A: Backend auto-add 3 tag per subscriber (lihat `lib/plans.ts:membershipTagsForPlan`):
- `subscriber` — universal, dipakai untuk gate apapun yang paid-only
- `pro-member` / `business-member` — tier-based (derive dari prefix `plan_code`)
- `plan-${plan_code}` — exact plan (e.g. `plan-business_yearly`) untuk discount rule per-tier

Contoh Liquid: `{% if customer.tags contains 'business-member' %}<unlock business content>{% endif %}`

**Q: Bisa kasih free trial?**
A: Bisa. Tambah `trialDays?: number` di `lib/plans.ts` plan definition. Xendit akan mundurin first charge sesuai trial period, tapi customer tetap input payment method di awal.

**Q: Bisa proration (upgrade/downgrade mid-cycle)?**
A: Xendit tidak handle proration otomatis. Workflow manual: cancel plan lama → create plan baru dengan amount yang sudah di-proration. Backend ini saat ini tidak expose endpoint upgrade — perlu ditambah kalau dibutuhkan.

**Q: Bisa multi-currency?**
A: Xendit Indonesia hanya support IDR untuk recurring. USD/SGD harus pakai Xendit Singapore/Philippines (different API endpoint).

**Q: Apakah ada hard limit charge attempt?**
A: Default 3 retry (interval DAY). Configurable via `schedule.total_retry` di `lib/xendit.ts:createRecurringPlan`.

**Q: Tiap cycle bikin Shopify Order baru — apakah ini desain yang benar?**
A: Ya. Tiap charge = 1 Shopify order baru. Manfaat: revenue tracking akurat per cycle, customer dapat email order confirmation tiap billing, MRR/retention report di Shopify Analytics jadi valid. Tag `xendit-recurring` + `subscription-<plan>` membantu filter di report.

**Q: Apakah customer bisa update payment method tanpa cancel + re-subscribe?**
A: Belum di-implement. Xendit punya API `POST /recurring/plans/{id}/update_payment_method` yang return hosted URL untuk update. Bisa ditambah kalau dibutuhkan — pattern-nya sama dengan flow subscribe.

**Q: Apakah saya butuh Shopify Plus?**
A: Tidak. Custom App + App Proxy tersedia di semua plan Shopify (Basic, Shopify, Advanced, Plus). Shopify Subscriptions API (yang requires Plus) tidak dipakai di sini — kita pakai pendekatan "manual order creation via Admin API".

**Q: Bagaimana refund?**
A: Refund via Xendit Admin (uangnya ada di Xendit). Lalu manual refund Shopify Order untuk bookkeeping (zero-amount refund untuk catat status, atau full refund kalau Shopify Payments terlibat untuk syncing). Future enhancement: webhook `recurring.refund` → otomatis refund Shopify order.

---

## 11. References

### Xendit
- [Recurring Payments API v2](https://developers.xendit.co/api-reference/#recurring-payments)
- [Customer API](https://developers.xendit.co/api-reference/#customers)
- [Webhook Reference](https://developers.xendit.co/api-reference/#webhooks)
- [Test Cards (Sandbox)](https://docs.xendit.co/credit-cards/integrations/testing)

### Shopify
- [Admin API REST 2024-10](https://shopify.dev/docs/api/admin-rest)
- [Admin API GraphQL 2024-10](https://shopify.dev/docs/api/admin-graphql)
- [App Proxy](https://shopify.dev/docs/apps/build/online-store/display-dynamic-data)
- [Liquid Reference](https://shopify.dev/docs/api/liquid)

### Supabase
- [Postgres Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

### Next.js
- [App Router Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)

---

## Changelog

- **2026-05-21** — QA pass + Shopify integration. Major refactor dari standalone SaaS pattern (versi initial) ke Shopify×Xendit bridge. Drop Supabase Auth. Add `lib/shopify.ts`, `lib/shopify-proxy.ts`, `/api/admin/reconcile`. Bug fixes: event-ID extraction per Xendit schema, partial→full UNIQUE indexes for upsert ON CONFLICT, REST→GraphQL untuk Shopify order tag search, anchorDate clone, broken billing links.
- **2026-05-20** — Initial: SaaS pattern dengan Supabase Auth + Next.js 15 App Router. (Superseded — lihat refactor 2026-05-21.)
