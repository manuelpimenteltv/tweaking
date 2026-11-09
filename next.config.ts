import type { NextConfig } from "next";

/**
 * Origins the browser talks to directly for uploads, previews and downloads
 * (presigned object-storage URLs). Override with CSP_STORAGE_ORIGINS
 * (space-separated) when a CDN or custom domain fronts the bucket.
 */
function storageOrigins(): string[] {
  if (process.env.CSP_STORAGE_ORIGINS) return process.env.CSP_STORAGE_ORIGINS.split(/\s+/).filter(Boolean);
  const endpoint = process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET ?? "";
  if (endpoint) {
    const url = new URL(endpoint);
    return process.env.S3_FORCE_PATH_STYLE === "true" ? [url.origin] : [`${url.protocol}//${bucket}.${url.host}`, url.origin];
  }
  return [`https://${bucket}.s3.${process.env.S3_REGION ?? "us-east-1"}.amazonaws.com`];
}

const dev = process.env.NODE_ENV !== "production";
const storage = storageOrigins().join(" ");
const csp = [
  "default-src 'self'",
  // Next.js inlines bootstrap scripts; a nonce-based policy is planned (docs/SECURITY.md).
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${storage}`,
  `media-src 'self' blob: ${storage}`,
  `connect-src 'self' ${storage}${dev ? " ws:" : ""}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  serverExternalPackages: ["sharp", "@node-rs/argon2", "pg"],
  experimental: {
    authInterrupts: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
