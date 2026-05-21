import { NextResponse, type NextRequest } from 'next/server';

// Lightweight middleware applied to ALL routes.
//
//  - Generates / propagates an X-Request-Id so logs across hops are correlatable.
//    Honors the inbound header if Vercel / a proxy already set one.
//  - Sets baseline security headers. We're a backend-ish service (mostly API
//    routes + a tiny status page), so we lock the page down hard:
//    * Strict-Transport-Security: 2 years preload-eligible
//    * Referrer-Policy: no-referrer (we never need outgoing referrers)
//    * X-Content-Type-Options: nosniff
//    * X-Frame-Options: DENY (no need to be embedded)
//    * Permissions-Policy: turn off everything
//
//  - We deliberately do NOT add a CSP here. The /billing pages are static
//    plain HTML with inline CSS; adding a strict CSP would require nonce
//    plumbing through the App Router for ~3 marketing pages — bad ratio.

function genRequestId(): string {
  // Native UUID v4. Crypto from globalThis works on the Next/Vercel runtime.
  return crypto.randomUUID();
}

export function middleware(req: NextRequest) {
  const incoming = req.headers.get('x-request-id');
  const requestId = incoming && /^[a-zA-Z0-9._-]{1,128}$/.test(incoming) ? incoming : genRequestId();

  // Forward the id into the request so route handlers can read it from the
  // header. (We can't mutate process.env; we propagate via headers.)
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set('x-request-id', requestId);

  const res = NextResponse.next({ request: { headers: reqHeaders } });

  res.headers.set('X-Request-Id', requestId);
  res.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload',
  );
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
  return res;
}

// Skip middleware for Next's own internal assets to keep static perf.
export const config = {
  matcher: [
    /*
     * Match all paths except:
     *  - _next/static     (build outputs)
     *  - _next/image      (image optimization)
     *  - favicon.ico
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
