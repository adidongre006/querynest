import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const backend = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");

// CSP: Next injects small inline scripts for hydration, so 'unsafe-inline' is needed for
// scripts unless you add per-request nonces (the stricter upgrade). Everything else is
// locked to our own origin. No remote images: weather icons are bundled lucide icons.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next's built-in gzip buffers proxied streams, which would make answers arrive all at
  // once. The CDN/host (Vercel, nginx, Cloudflare) compresses static assets instead.
  compress: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    // The browser only ever talks to this origin; the backend URL never reaches it.
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default config;
