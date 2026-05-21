// Return URL dari Xendit kalau pembayaran gagal. Reservation row di Supabase
// auto-cleaned setelah 24 jam (lihat reconcile shared.ts), atau bisa di-cancel
// manual oleh customer via /account.

import { getPlan } from '@/lib/plans';

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN ?? '';

export default async function FailedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const params = await searchParams;
  const plan = params.plan ? getPlan(params.plan) : null;
  const retryHref = plan
    ? `/apps/xendit/subscribe?plan_code=${encodeURIComponent(plan.code)}`
    : null;
  const storeHref = SHOPIFY_DOMAIN ? `https://${SHOPIFY_DOMAIN}/products` : '/';
  const accountHref = SHOPIFY_DOMAIN ? `https://${SHOPIFY_DOMAIN}/account` : '/';

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm p-8 text-center">
        <div className="text-6xl mb-4">❌</div>
        <h1 className="text-3xl font-bold mb-2">Pembayaran Gagal</h1>
        <p className="text-gray-600 mb-6 text-sm">
          Pembayaran kamu tidak berhasil diproses. Penyebab umum:
        </p>

        <ul className="text-left text-sm text-gray-600 mb-6 space-y-2 inline-block">
          <li>• Saldo / limit kartu tidak mencukupi</li>
          <li>• OTP 3DS tidak ter-verifikasi</li>
          <li>• Bank menolak transaksi (hubungi bank kamu)</li>
          <li>• Sesi checkout sudah expired</li>
        </ul>

        <div className="flex flex-col gap-2">
          {retryHref && SHOPIFY_DOMAIN && (
            <a
              href={`https://${SHOPIFY_DOMAIN}${retryHref}`}
              className="rounded-lg bg-black text-white px-6 py-3 font-medium hover:bg-gray-800"
            >
              Coba Bayar Lagi
            </a>
          )}
          <a
            href={accountHref}
            className="rounded-lg border border-gray-300 text-gray-700 px-6 py-3 font-medium hover:bg-gray-50"
          >
            Lihat Akun
          </a>
          <a href={storeHref} className="text-sm text-gray-500 mt-2">
            Kembali ke Toko
          </a>
        </div>

        <p className="text-xs text-gray-400 mt-6">
          Tidak ada biaya yang dipotong dari kartu kamu untuk transaksi gagal ini.
        </p>
      </div>
    </div>
  );
}
