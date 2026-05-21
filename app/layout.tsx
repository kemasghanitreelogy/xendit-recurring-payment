import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Xendit Recurring Subscription',
  description: 'Auto recurring subscription dengan Next.js + Xendit + Supabase',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body className="bg-white text-gray-900 antialiased">{children}</body>
    </html>
  );
}
