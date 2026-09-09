import type { NextConfig } from "next";
import { dirname } from "path";
import { fileURLToPath } from "url";

// F-04: security headers on every path. Production CSP is script-strict:
// Next.js App Router ships its bootstrap/hydration payload via INLINE <script>
// tags (no nonce middleware in P0), hence the narrow 'unsafe-inline' in
// script-src — no eval, no external origins, zero third-party scripts
// (asserted by tests/unit/static-safety.test.ts and the e2e smoke).
// DEV-ONLY exception: `next dev` React Refresh runtime evaluates strings
// (CSP EvalError breaks hydration), so 'unsafe-eval' is added when
// NODE_ENV !== 'production' and is ABSENT from production responses.
// style-src 'unsafe-inline' covers Next's inline style preloads; object-src,
// base-uri and frame-ancestors are locked down.
const isDevServer = process.env.NODE_ENV !== 'production';
const CSP = [
  "default-src 'self'",
  isDevServer
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" // dev only: React Refresh — see note above
    : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to the app dir: the parent workspace dir
  // contains an unrelated package-lock.json that Next would otherwise warn about.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
  // Server-side fetching of arbitrary URLs is forbidden (SSRF rule) — nothing here proxies remote hosts.
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 blocks cross-origin access to dev resources (/_next/hmr) by default;
  // the e2e suite targets 127.0.0.1, which no longer matches the implicit
  // localhost allowlist. Dev-only setting — no effect on production builds.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
