# Workflow: Xendit Recurring Subscription — Next.js + Supabase

> ⚠️ **SUPERSEDED (2026-05-21).** Plan ini dibuat untuk pattern **SaaS standalone**
> (Supabase Auth + pricing page + billing dashboard) sebelum klarifikasi bahwa
> tujuan sebenarnya adalah **Shopify×Xendit bridge**. Setelah refactor besar,
> sebagian besar file di plan ini sudah dihapus/diganti:
>
> - ❌ `app/pricing/page.tsx`, `app/billing/page.tsx`, `middleware.ts`
>   (Shopify Liquid + customer tag menggantikan)
> - ❌ `lib/supabase/server.ts`, `lib/supabase/client.ts`
>   (no Supabase Auth)
> - ✅ `lib/xendit.ts`, `lib/plans.ts`, `lib/supabase/admin.ts` (tetap)
> - ➕ Ditambahkan: `lib/shopify.ts`, `lib/shopify-proxy.ts`,
>   `app/api/admin/reconcile/route.ts`, `shopify/*.liquid`
>
> Untuk arsitektur dan setup terkini: lihat `README.md` dan `INTEGRATION.md`.
> Dokumen ini dipertahankan sebagai historical artifact.

---

**Source PRD**: `README.md`
**Strategy**: Systematic
**Depth**: Deep
**Generated**: 2026-05-20
**Superseded**: 2026-05-21 (Shopify integration refactor)

---

## 1. Goals & Scope

Bangun aplikasi **Next.js 15 (App Router) + TypeScript + Supabase** yang implement
**auto recurring subscription** via **Xendit Recurring Payments API**, mendukung Card,
e-wallet (OVO/DANA/ShopeePay/LinkAja), Direct Debit, dan Virtual Account.

### Out of Scope (untuk versi awal)
- Auth UI (login/signup) — diasumsikan sudah ada via Supabase Auth standar
- Email notification system (selain yang otomatis dari Xendit)
- Invoice PDF generator
- Admin / MRR dashboard
- Rate limiting (Upstash Redis) — masuk Production Checklist

---

## 2. Phase Breakdown

### Phase 0 — Project Scaffolding (Foundation)
| Task | Output | Depends on |
|------|--------|------------|
| 0.1 Init Next.js 15 + TypeScript + Tailwind | `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs` | — |
| 0.2 Tambah dependency Supabase | `@supabase/supabase-js`, `@supabase/ssr` | 0.1 |
| 0.3 Setup folder struktur sesuai §6 README | `app/`, `lib/` tree | 0.1 |
| 0.4 Buat `.env.example` + `.gitignore` | env template (no secrets) | 0.1 |
| 0.5 Buat layout root + globals.css | `app/layout.tsx`, `app/globals.css`, `app/page.tsx` | 0.1 |

**Quality Gate**: `pnpm dev` boot tanpa error, `tsc --noEmit` lulus.

---

### Phase 1 — Library Layer (Backend Primitives)
| Task | Output | Depends on |
|------|--------|------------|
| 1.1 Supabase clients | `lib/supabase/{server,client,admin}.ts` | 0.x |
| 1.2 Plan config + IDR formatter | `lib/plans.ts` | 0.x |
| 1.3 Xendit API client (Customer + Recurring Plan + helpers) | `lib/xendit.ts` | 0.x |

**Quality Gate**:
- Types compile (`tsc --noEmit`)
- `XenditError` di-export sebagai class (bukan type-only)
- Module boundaries jelas: `admin.ts` cuma untuk server-side service-role usage

---

### Phase 2 — Database Schema (Supabase)
| Task | Output | Depends on |
|------|--------|------------|
| 2.1 SQL migration file dari §4.2 README | `supabase/migrations/0001_init.sql` | — |
| 2.2 Verify RLS policies (read own only, service-role bypass) | doc note in migration | 2.1 |
| 2.3 (Optional) seed minimal user untuk dev test | `supabase/seed.sql` | 2.1 |

**Quality Gate**: SQL idempotent? Kalau pakai `create table` (bukan `create table if not exists`),
harus jalan di project Supabase baru tanpa error.

---

### Phase 3 — API Routes (Server)
| Task | Output | Depends on |
|------|--------|------------|
| 3.1 `POST /api/subscribe` | `app/api/subscribe/route.ts` | 1.1, 1.2, 1.3 |
| 3.2 `POST /api/webhook/xendit` (token verify + dedupe + dispatch) | `app/api/webhook/xendit/route.ts` | 1.1, 1.3, 2.1 |
| 3.3 `POST /api/subscription/cancel` | `app/api/subscription/cancel/route.ts` | 1.1, 1.3 |
| 3.4 `GET /api/subscription/current` | `app/api/subscription/current/route.ts` | 1.1 |

**Quality Gate**:
- Webhook respond < 5s, idempotent via `xendit_webhook_events` PK
- Service-role client hanya di webhook handler
- Semua error path return JSON shape `{ error: string, code?: string }`

---

### Phase 4 — Frontend Pages
| Task | Output | Depends on |
|------|--------|------------|
| 4.1 Pricing page | `app/pricing/page.tsx` | 1.2, 3.1 |
| 4.2 Billing success/failed | `app/billing/success/page.tsx`, `app/billing/failed/page.tsx` | 0.5 |
| 4.3 Billing dashboard | `app/billing/page.tsx` | 1.2, 3.3, 3.4 |

**Quality Gate**:
- Tailwind class render benar
- Subscribe button states (loading/disabled/error) handled
- Server Component vs Client Component dipisah dengan benar (`'use client'` cuma yang butuh)

---

### Phase 5 — Middleware (Route Protection)
| Task | Output | Depends on |
|------|--------|------------|
| 5.1 Middleware untuk `/dashboard/*` dan `/pro-feature/*` | `middleware.ts` (root) | 1.1, 2.1 |
| 5.2 Verify matcher config + redirect behavior | inline | 5.1 |

**Quality Gate**: User tanpa active sub → redirect ke `/pricing`. Tanpa auth → ke `/login`.

---

### Phase 6 — Local Testing Setup
| Task | Output | Depends on |
|------|--------|------------|
| 6.1 Dokumen `scripts/curl-webhook.sh` untuk test webhook manual | helper | 3.2 |
| 6.2 README quickstart untuk ngrok + sandbox card | tambahan note | semua |

---

## 3. Dependency Graph (Critical Path)

```
[0.1 init] → [0.3 folders] ┬→ [1.1 supabase] ┬→ [3.1 subscribe] → [4.1 pricing]
                            │                   │
                            ├→ [1.2 plans] ─────┼→ [3.4 current]  → [4.3 billing]
                            │                   │
                            └→ [1.3 xendit] ────┼→ [3.3 cancel]   ↑
                                                │                  │
                            [2.1 sql] ──────────┴→ [3.2 webhook] ──┘
                                                                   ↓
                                                            [5.1 middleware]
```

Critical path: **0.1 → 0.3 → 1.x → 3.x → 4.x**. Phase 2 (SQL) bisa paralel dengan 1.x.

---

## 4. Validation Checklist (per Phase)

### Phase 0
- [ ] `next dev` jalan di :3000
- [ ] TypeScript strict mode enabled
- [ ] `.env.local` ada di `.gitignore`

### Phase 1
- [ ] `createOrGetCustomer` cek existing dulu (no duplicate)
- [ ] `createRecurringPlan` set `total_retry: 3`, `retry_interval: DAY`
- [ ] `XenditError` instanceof check works

### Phase 2
- [ ] 3 tabel terbuat: `subscriptions`, `subscription_invoices`, `xendit_webhook_events`
- [ ] Partial unique index aktif di `subscriptions(user_id) where status in active`
- [ ] RLS enabled di semua tabel
- [ ] View `active_subscriptions` accessible by authenticated role

### Phase 3
- [ ] `/api/subscribe` cek existing active sub → return 409
- [ ] `/api/webhook` reject kalau token mismatch → 401
- [ ] Webhook duplicate insert → return `{ ok: true, duplicate: true }`
- [ ] All 8 event types di-handle (activated, inactivated, cycle.*, payment.*)

### Phase 4
- [ ] Pricing page render 4 plan dari `PLANS`
- [ ] Click subscribe → redirect ke Xendit hosted page
- [ ] Billing page handle null sub (empty state)
- [ ] Cancel button confirm dialog muncul

### Phase 5
- [ ] User non-auth ke `/dashboard` → `/login`
- [ ] User auth tanpa sub ke `/dashboard` → `/pricing`
- [ ] User auth dengan sub ke `/dashboard` → lewat

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Card data masuk ke server | Pakai Xendit hosted checkout, redirect URL only |
| Webhook double-processed | PK `xendit_webhook_events.id` + 23505 catch |
| Race condition multi-subscribe | Partial unique index `idx_subs_user_active` |
| `next_execution_at` null di `plan.activated` | Workaround: re-fetch plan via `getRecurringPlan` di webhook handler |
| Service-role key bocor ke client | Strict separation: `admin.ts` hanya di-import di `route.ts` server-side |
| Xendit retry timeout (>5s) | Webhook handler async-light: insert + dispatch, no heavy work |

---

## 6. Deliverables (Files yang akan dibuat)

```
xendit-recurring-subscription/
├── README.md                              (existing)
├── package.json                           (new)
├── tsconfig.json                          (new)
├── next.config.ts                         (new)
├── postcss.config.mjs                     (new)
├── tailwind.config.ts                     (new)
├── .env.example                           (new)
├── .gitignore                             (new)
├── middleware.ts                          (new)
├── app/
│   ├── layout.tsx                         (new)
│   ├── page.tsx                           (new)
│   ├── globals.css                        (new)
│   ├── pricing/page.tsx                   (new)
│   ├── billing/page.tsx                   (new)
│   ├── billing/success/page.tsx           (new)
│   ├── billing/failed/page.tsx            (new)
│   └── api/
│       ├── subscribe/route.ts             (new)
│       ├── subscription/cancel/route.ts   (new)
│       ├── subscription/current/route.ts  (new)
│       └── webhook/xendit/route.ts        (new)
├── lib/
│   ├── plans.ts                           (new)
│   ├── xendit.ts                          (new)
│   └── supabase/
│       ├── server.ts                      (new)
│       ├── client.ts                      (new)
│       └── admin.ts                       (new)
└── supabase/
    └── migrations/
        └── 0001_init.sql                  (new)
```

Total: ~22 file baru.

---

## 7. Next Step

Jalankan `/sc:implement` untuk eksekusi plan ini phase-by-phase, atau jalankan tiap phase
manual mulai dari Phase 0.
