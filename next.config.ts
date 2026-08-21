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
  // DO NOT add outputFileTracingExcludes here. Attempted 2026-08-21 to keep
  // data/.git out of standalone: the glob semantics matched EVERY nested
  // "dist"/"tests" dir too, gutting node_modules/@stoqey/ib/dist (packaged
  // Today page black-screened) and next/dist compiled runtimes (every API
  // route 500'd). The bundle gate lives in electron-builder.yml's
  // extraResources filter instead - full tracing here, filtering at pack.
};

export default nextConfig;
