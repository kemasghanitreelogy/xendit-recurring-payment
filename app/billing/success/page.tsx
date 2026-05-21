// Return URL dari Xendit setelah pembayaran sukses. Webhook bisa belum
// landing saat customer lihat halaman ini (timing race), jadi kita kasih
// tahu mereka tunggu sebentar + arahkan ke account page.

import { getPlan, formatIDR } from '@/lib/plans';

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN ?? '';

export default async function SuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const params = await searchParams;
  const plan = params.plan ? getPlan(params.plan) : null;
  const backHref = SHOPIFY_DOMAIN ? `https://${SHOPIFY_DOMAIN}/account` : '/';

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm p-8 text-center">
        <div className="text-6xl mb-4">✅</div>
        <h1 className="text-3xl font-bold mb-2">Pembayaran Berhasil!</h1>

        {plan && (
          <div className="my-6 inline-block rounded-lg border border-gray-200 px-4 py-3 text-left text-sm">
            <div className="font-medium">{plan.name}</div>
            <div className="text-gray-600">
              {formatIDR(plan.amount)} / {plan.interval === 'MONTH' ? 'bulan' : 'tahun'}
            </div>
          </div>
        )}

        <p className="text-gray-600 mb-6 text-sm">
          Subscription kamu sedang diaktifkan. Akses biasanya terbuka dalam{' '}
          <strong>&lt; 1 menit</strong> setelah konfirmasi pembayaran dari Xendit.
          Kalau setelah 5 menit masih belum aktif, refresh halaman akun atau hubungi support.
        </p>

        <a
          href={backHref}
          className="inline-block rounded-lg bg-black text-white px-6 py-3 font-medium hover:bg-gray-800"
        >
          Lihat status akun →
        </a>

        <p className="text-xs text-gray-400 mt-6">
          Email konfirmasi akan dikirim ke alamat yang terdaftar di akun Shopify kamu.
        </p>
      </div>
    </div>
  );
}
