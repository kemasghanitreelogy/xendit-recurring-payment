// Return URL dari Xendit hosted page kalau pembayaran gagal.

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN ?? '';

export default function FailedPage() {
  const backHref = SHOPIFY_DOMAIN
    ? `https://${SHOPIFY_DOMAIN}/products`
    : '/';

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-md text-center">
        <div className="text-6xl mb-4">❌</div>
        <h1 className="text-3xl font-bold mb-2">Pembayaran Gagal</h1>
        <p className="text-gray-600 mb-6">
          Maaf, pembayaran kamu tidak berhasil diproses. Silakan coba lagi
          atau gunakan metode pembayaran lain.
        </p>
        <a
          href={backHref}
          className="inline-block rounded-lg bg-black text-white px-6 py-3 font-medium"
        >
          Kembali ke Toko
        </a>
      </div>
    </div>
  );
}
