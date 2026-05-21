import Link from 'next/link';

export default async function AlreadyPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-md text-center">
        <div className="text-6xl mb-4">ℹ️</div>
        <h1 className="text-3xl font-bold mb-2">Subscription Aktif</h1>
        <p className="text-gray-600 mb-2">
          Kamu sudah punya subscription{' '}
          {status === 'PENDING' ? 'yang sedang diproses' : 'aktif'}.
        </p>
        <p className="text-gray-500 text-sm mb-6">
          Cek status di halaman akun Shopify kamu untuk detail tagihan
          dan riwayat pembayaran.
        </p>
        <Link
          href="/"
          className="inline-block rounded-lg bg-black text-white px-6 py-3 font-medium"
        >
          Kembali
        </Link>
      </div>
    </div>
  );
}
