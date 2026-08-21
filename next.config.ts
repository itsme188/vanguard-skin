import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "@stoqey/ib"],
  // The print-watch watcher's dynamic fs paths (resolveDbDir → process.cwd())
  // make @vercel/nft trace conservatively: without these excludes the ENTIRE
  // project root — .git (45MB, read-only objects that break codesign), data/
  // (multi-GB REAL financial DB + backups), qa/ archives, tests, docs — was
  // swept into .next/standalone and would have shipped inside the signed app
  // bundle (caught 2026-08-21 when codesign failed on .git/objects). Runtime
  // file access under resolveDbDir() works regardless of tracing; nothing
  // here is needed inside the bundle.
  // NOTE: the excludes below expose a Turbopack-standalone tracing gap — the
  // app-ROUTE runtime (next-server/app-route-turbo.runtime.prod.js) stops
  // being traced once the over-broad root sweep is gone, and every packaged
  // API route 500s ("Login unavailable", 2026-08-21). outputFileTracingIncludes
  // did NOT fix it; the deterministic fix is the compiled/next-server copy in
  // package.json's electron:copy-static step. Keep that copy if these
  // excludes stay.
  outputFileTracingExcludes: {
    "*": [
      // Both bare and ./-prefixed forms: db-path.ts's static
      // `path.join(cwd, "data")` gets nft-included under a pattern shape the
      // bare glob missed (observed 2026-08-21: data/ alone survived round 1).
      ".git/**",
      "./.git/**",
      "data/**",
      "./data/**",
      "**/data/**",
      "qa/**",
      "./qa/**",
      "tests/**",
      "./tests/**",
      "docs/**",
      "./docs/**",
      "scripts/**",
      "./scripts/**",
      "dist/**",
      "./dist/**",
      "dist-electron/**",
      "./dist-electron/**",
      ".playwright-mcp/**",
      ".superpowers/**",
      "*.png",
      "*.md",
    ],
  },
};

export default nextConfig;
