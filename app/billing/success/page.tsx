// Return URL dari Xendit hosted page setelah pembayaran sukses.
// Customer disuruh balik ke Shopify customer account untuk lihat status sub.

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN ?? '';

export default function SuccessPage() {
  const backHref = SHOPIFY_DOMAIN ? `https://${SHOPIFY_DOMAIN}/account` : '/';

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-md text-center">
        <div className="text-6xl mb-4">✅</div>
        <h1 className="text-3xl font-bold mb-2">Pembayaran Berhasil!</h1>
        <p className="text-gray-600 mb-6">
          Subscription kamu sedang diaktifkan. Kamu akan menerima email
          konfirmasi dalam beberapa menit, dan akses akan terbuka setelah
          status terupdate (biasanya &lt; 1 menit).
        </p>
        <a
          href={backHref}
          className="inline-block rounded-lg bg-black text-white px-6 py-3 font-medium"
        >
          Kembali ke Akun
        </a>
      </div>
    </div>
  );
}
