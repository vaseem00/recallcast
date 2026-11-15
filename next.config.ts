import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy. Every script, style and font is served by this app (next/font
 * self-hosts the fonts). 'unsafe-inline' scripts are needed for Next's inline bootstrap
 * scripts because there is no nonce setup; dev also needs 'unsafe-eval' (React Refresh) and
 * ws: for HMR. Thumbnails are the only third-party images: both YouTube providers (Data API
 * and mock) return i.ytimg.com URLs; *.ytimg.com covers the i9./s. variants and yt3.ggpht.com
 * channel art in case the Data API returns it.
 *
 * Episodes play in YouTube's IFrame player: the API script comes from www.youtube.com (it
 * pulls its widget script from www.youtube.com/s/player/... and s.ytimg.com), and the player
 * iframe runs on www.youtube-nocookie.com (privacy-enhanced mode). Referrer-Policy must keep
 * sending the origin: the embed refuses to play without a referrer (error 153).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://www.youtube.com https://s.ytimg.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://yt3.ggpht.com",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
  "media-src 'self' blob:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-Frame-Options", value: "DENY" },
  // HSTS only in production builds: on http://localhost it would be ignored at best and, on a
  // custom local hostname, pin the browser to https.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  // cacheComponents is intentionally OFF: the spec requires `export const runtime = "nodejs"`
  // in route handlers, which Cache Components rejects, and this app is auth/cookie-driven
  // (dynamic by nature). Classic dynamic rendering keeps cookies()/headers() simple.

  // Self-contained server in .next/standalone (server.js + traced node_modules) for the
  // Docker image. See Dockerfile and docs/deploy.md.
  output: "standalone",

  poweredByHeader: false,

  // youtubei.js ships large dynamic code (protobuf, JS interpreter for signatures);
  // load it from node_modules at runtime instead of bundling it. Being external, it is
  // traced into .next/standalone/node_modules like any other runtime dependency.
  serverExternalPackages: ["youtubei.js"],

  // node:sqlite is NOT listed here on purpose: src/lib/db.ts loads it with
  // process.getBuiltinModule("node:sqlite"), which bundlers never see.

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
