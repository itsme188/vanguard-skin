/**
 * verify-bundle.js — post-pack gate for the Electron DMG (2026-08-21).
 *
 * Runs between electron-builder and electron:install. Fails the deploy when
 * the packaged app's Resources/standalone either LEAKS repo internals
 * (data/ = the real financial DB — shipped silently in every build up to
 * 2026-08-19; .git broke codesign) or is MISSING runtime pieces whose
 * absence only surfaces at request time (app-route runtime → every API
 * route 500s "Login unavailable"; @stoqey/ib/dist → Today black-screens).
 * Born from one night that hit all four failure modes.
 */
const fs = require("node:fs");
const path = require("node:path");

const standalone = path.join(
  __dirname,
  "..",
  "dist",
  "mac-arm64",
  "Vanguard Dashboard.app",
  "Contents",
  "Resources",
  "standalone",
);

const mustNotExist = ["data", ".git", "qa", "tests", "docs", ".env.local", ".env"];
const mustExist = [
  "node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js",
  "node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js",
  "node_modules/@stoqey/ib/dist/index.js",
  "node_modules/better-sqlite3/package.json",
  ".next/server/app/api/auth/login/route.js",
  ".next/server/app/api/print-watch/status/route.js",
  "server.js",
];

let failed = false;
if (!fs.existsSync(standalone)) {
  console.error(`verify-bundle: standalone not found at ${standalone}`);
  process.exit(1);
}
for (const p of mustNotExist) {
  if (fs.existsSync(path.join(standalone, p))) {
    console.error(`verify-bundle: LEAK — ${p} must not be in the bundle`);
    failed = true;
  }
}
for (const p of mustExist) {
  if (!fs.existsSync(path.join(standalone, p))) {
    console.error(`verify-bundle: MISSING — ${p} required at runtime`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("verify-bundle: OK (no leaks, runtime pieces present)");
