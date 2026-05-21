export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold mb-4">
        Xendit × Shopify Recurring Bridge
      </h1>
      <p className="text-gray-600 mb-2">
        Backend service untuk auto recurring subscription Shopify lewat Xendit.
        Halaman ini hanya untuk monitoring — entry point untuk customer ada di
        Shopify storefront via tombol Subscribe.
      </p>
      <p className="text-sm text-gray-500 mt-8">
        Endpoint utama:
      </p>
      <ul className="text-sm text-gray-500 list-disc list-inside mt-2 space-y-1">
        <li><code>GET /api/subscribe</code> — via Shopify App Proxy</li>
        <li><code>POST /api/webhook/xendit</code> — webhook handler</li>
        <li><code>POST /api/subscription/cancel</code> — via App Proxy</li>
        <li><code>GET /api/subscription/current</code> — via App Proxy</li>
        <li><code>GET/POST /api/admin/reconcile</code> — Bearer-token protected</li>
      </ul>
    </main>
  );
}
