import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
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
