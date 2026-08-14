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
  {
    files: ["app/**/*.{ts,tsx}"],
    plugins: { local: { rules: { "no-raw-api-fetch": noRawApiFetch } } },
    rules: { "local/no-raw-api-fetch": "error" },
  },
]);

export default eslintConfig;
