import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-side fetching of arbitrary URLs is forbidden (SSRF rule) — nothing here proxies remote hosts.
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
