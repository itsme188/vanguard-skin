import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Lets a small set of parity tests import a Mac-side module directly
      // (e.g. lib/earnings/wrap.ts) by its own "@/*" alias, mirroring
      // tsconfig.json's root-level `"@/*": ["./*"]`. Test-time resolution
      // only — the Worker bundle itself never uses "@/" imports. Every Mac
      // module reachable this way resolves to zero-import or type-only
      // ("import type Database from better-sqlite3") dependencies, so this
      // never pulls a native module into the Worker's Node test runtime.
      "@": path.resolve(__dirname, "../../"),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
