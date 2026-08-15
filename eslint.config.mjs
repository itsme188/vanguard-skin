import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noRawApiFetch from "./eslint-rules/no-raw-api-fetch.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Packaged-app trust boundary (#35, task 8) — forbid raw mutating fetch()
  // in client code; lib/http/apiFetch.ts is the only sanctioned way to
  // attach the CSRF header. Tasks 9-12 migrate the existing call sites
  // area-by-area, so this WILL report many pre-existing violations until
  // that lands — expected, not a regression from this change.
  //
  // app/api/** is excluded: those are SERVER route handlers, not browser
  // code. Rule branch (a) flags any literal unsafe `method:` regardless of
  // URL, so a route handler doing a server-side POST to an external
  // service (no browser cookie jar, nothing to attach) would otherwise be
  // false-flagged into a wrapper that only makes sense client-side.
  //
  // lib/hooks/** is included alongside app/**: the #35 final review found
  // three "use client" hooks there making raw mutating fetch()s to /api/*
  // that Tasks 9-12 never touched (those only swept app/**). Scoped to
  // lib/hooks/ specifically, NOT all of lib/** — most of lib/ is
  // server-only code (lib/tws, lib/ai, lib/email, lib/apis, lib/storage,
  // lib/ibkr, ...) that legitimately makes raw fetch() calls to EXTERNAL
  // services with no browser cookie jar; widening the glob further would
  // false-flag those.
  {
    files: ["app/**/*.{ts,tsx}", "lib/hooks/**/*.{ts,tsx}"],
    ignores: ["app/api/**"],
    plugins: { local: { rules: { "no-raw-api-fetch": noRawApiFetch } } },
    rules: { "local/no-raw-api-fetch": "error" },
  },
]);

export default eslintConfig;
