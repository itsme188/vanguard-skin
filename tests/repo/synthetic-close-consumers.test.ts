/**
 * Contract guard for engine-synthesized closes (spec 2026-10-02
 * statement-only synthetic closes §2.2, last paragraph).
 *
 * A `RECONCILE_CLOSE` row is a synthetic close minted by computeTaxLots from
 * statement evidence. Its price is the newest price on or before the
 * statement's flat date (breakeven fallback), never broker proceeds — so it
 * is ESTIMATED and NON-FILING everywhere. Every file whose CODE (comments
 * excluded) mentions `RECONCILE_CLOSE`, `is_synthetic_close` or
 * `isSyntheticClose` must be classified below:
 *
 *   engine                  — mints / deletes them (computeTaxLots only)
 *   include-with-disclosure — shows or carries them, labelled as
 *                             engine-estimated (chip, tile disclosure, flag,
 *                             labelled census line, source_key-keyed digest)
 *   exclude                 — filters them out (filing surfaces, broker
 *                             reconciliation, user activity, audits)
 *
 * A new consumer fails this test until it declares which it is; a stale
 * entry (file no longer references them) fails too, so the list stays exact.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["lib", "app", "scripts", "workers", "electron"];
const TOKEN_RE = /RECONCILE_CLOSE|is_synthetic_close|isSyntheticClose/;

type Role = "engine" | "include-with-disclosure" | "exclude";

const CONSUMERS: Record<string, { role: Role; why: string }> = {
  "lib/compute/tax-lots.ts": { role: "engine", why: "computeTaxLots wipes and re-mints them" },
  "lib/compute/tax-lot-recompute-summary.ts": {
    role: "include-with-disclosure",
    why: "reports engine closes added/removed in the recompute rehearsal summary",
  },
  "lib/compute/tax-report.ts": {
    role: "exclude",
    why: "Form 8949 rows drop them (filingOnly reader); it counts the dropped ones so the card can say how many were left out",
  },
  "lib/compute/trade-roundtrips.ts": {
    role: "include-with-disclosure",
    why: "carries isSyntheticClose on round trips; user-trade counts drop them",
  },
  "lib/compute/donation-recompute.ts": {
    role: "include-with-disclosure",
    why: "labelled 'Estimated closes' census count before and after a donation-triggered recompute",
  },
  "lib/queries/options.ts": { role: "include-with-disclosure", why: "isSyntheticClose flag on closed sales" },
  "lib/queries/security-detail.ts": {
    role: "include-with-disclosure",
    why: "is_synthetic_close drives the Estimated chip on the security hub",
  },
  "lib/queries/tax-lots.ts": {
    role: "include-with-disclosure",
    why: "flags closed sales + engine-estimated totals; excludeFiling drops them from filing surfaces",
  },
  "lib/queries/trade-reviews.ts": { role: "include-with-disclosure", why: "is_synthetic_close flag for the review view" },
  "lib/queries/transactions.ts": { role: "exclude", why: "engine-owned rows never list as user transactions" },
  "app/api/trade-review/route.ts": { role: "include-with-disclosure", why: "passes isSyntheticClose to the view" },
  "app/dashboard/components/TaxLotTables.tsx": { role: "include-with-disclosure", why: "renders the Estimated chip" },
  "app/dashboard/components/TradeReviewView.tsx": {
    role: "include-with-disclosure",
    why: "renders the synthetic-close label",
  },
  "app/dashboard/security/[id]/page.tsx": { role: "include-with-disclosure", why: "renders the Estimated chip" },
  "app/dashboard/tax-lots/page.tsx": {
    role: "include-with-disclosure",
    why: "engine-estimated tile disclosure counts them",
  },
  "scripts/rebuild-ibkr-ledger.ts": { role: "include-with-disclosure", why: "labelled census count" },
  "scripts/recompute-tax-lots-v2.ts": {
    role: "include-with-disclosure",
    why: "keys them by source_key in the idempotence digest",
  },
  "scripts/reconcile-tax-report-vs-broker.ts": { role: "exclude", why: "broker reconciliation compares real sales only" },
  "scripts/repair-split-basis-audit.ts": { role: "exclude", why: "audit excludes engine-owned rows (labelled)" },
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "dist", ".wrangler"].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments may name the type in prose; only CODE is a consumer. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function codeConsumers(): string[] {
  const found: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (TOKEN_RE.test(stripComments(fs.readFileSync(file, "utf-8")))) {
        found.push(path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
  }
  return found.sort();
}

describe("synthetic-close (RECONCILE_CLOSE) consumers are classified", () => {
  const found = codeConsumers();

  it("every code consumer declares include-with-disclosure, exclude or engine", () => {
    expect(found.filter((f) => !(f in CONSUMERS))).toEqual([]);
  });

  it("the classification has no stale entries", () => {
    expect(Object.keys(CONSUMERS).filter((f) => !found.includes(f))).toEqual([]);
  });

  it("only computeTaxLots is the engine", () => {
    expect(Object.entries(CONSUMERS).filter(([, c]) => c.role === "engine").map(([f]) => f)).toEqual([
      "lib/compute/tax-lots.ts",
    ]);
  });

  it("the filing query excludes them (the one exclusion every filing surface shares)", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib/queries/tax-lots.ts"), "utf-8");
    expect(src).toContain("t.type != 'RECONCILE_CLOSE'");
  });
});
