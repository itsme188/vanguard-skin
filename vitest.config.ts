import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    // Pins DATABASE_PATH at a per-worker scratch file BEFORE any test module
    // loads, so importing the db singleton (which migrates at module load)
    // can never reach the real data/vanguard.db. See
    // tests/repo/tests-never-touch-live-db.test.ts.
    setupFiles: ["./tests/setup/db-guard.ts"],
    // Only the repo's own tests/ tree. Build artifacts embed stale COPIES of
    // these files (.next/standalone, dist/mac-arm64 .app bundle) and sibling
    // worktree checkouts under .claude/ carry their own — running those
    // executes OLD test code against CURRENT lib and fails as phantoms.
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/.claude/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
