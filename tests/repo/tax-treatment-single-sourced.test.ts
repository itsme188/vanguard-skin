/**
 * The account tax-treatment vocabulary is single-sourced (QA finding
 * tax-lots--form-8949-export-and-taxable-totals-include-roth-ira-sales,
 * ruling 2026-09-14).
 *
 * `'roth_ira'` and friends live in lib/compute/tax-treatment.ts and in
 * migration 094's CHECK constraint. Every other file asks
 * `isTaxableAccount(...)` instead of comparing a token — the same rule the
 * repo already enforces for email states and latest-holdings predicates.
 * Also pins the two behaviours a source scan can prove without a DOM
 * harness: the card's retirement branch renders BEFORE the no-sales bail and
 * carries no export buttons, and the API refuses a retirement-scoped file.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TAX_TREATMENTS,
  isTaxableAccount,
} from "@/lib/compute/tax-treatment";
import {
  excludedRetirementAccountsNote,
  RETIREMENT_ACCOUNT_COPY,
  NO_RETIREMENT_STAMP_COPY,
} from "@/app/dashboard/components/TaxReportCard";

const ROOT = path.resolve(__dirname, "../..");

/** The one module that may spell the tokens, plus the migration that pins them. */
const ALLOWED = ["lib/compute/tax-treatment.ts", "lib/db/migrations/094_accounts_tax_treatment.sql"];

const SCAN_DIRS = ["lib", "app", "scripts", "workers"];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|sql)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments may name a treatment in prose (usage lines, rationale); only CODE
 *  is held to the single-source rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^--.*$/gm, "");
}

describe("tax treatment vocabulary is single-sourced", () => {
  const nonTaxable = TAX_TREATMENTS.filter((t) => t !== "taxable");

  it("no file outside lib/compute/tax-treatment.ts spells a retirement token in code", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file);
        if (ALLOWED.includes(rel)) continue;
        const code = stripComments(fs.readFileSync(file, "utf-8"));
        for (const token of nonTaxable) {
          if (code.includes(`"${token}"`) || code.includes(`'${token}'`)) {
            offenders.push(`${rel} (${token})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("isTaxableAccount is the predicate, not a token comparison", () => {
    expect(isTaxableAccount("taxable")).toBe(true);
    expect(nonTaxable.every((t) => !isTaxableAccount(t))).toBe(true);
  });
});

describe("TaxReportCard retirement branch", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "app/dashboard/components/TaxReportCard.tsx"),
    "utf-8"
  );

  it("renders the retirement notice BEFORE the no-sales bail", () => {
    const retirementBranch = source.indexOf("if (report.retirementAccount)");
    const noSalesBail = source.indexOf("if (totalSales === 0) return null;");
    expect(retirementBranch).toBeGreaterThan(-1);
    expect(noSalesBail).toBeGreaterThan(-1);
    expect(retirementBranch).toBeLessThan(noSalesBail);
  });

  it("offers no CSV/TXF button inside the retirement branch", () => {
    const start = source.indexOf("if (report.retirementAccount)");
    const end = source.indexOf("const totalSales =", start);
    const branch = source.slice(start, end);
    expect(branch).toContain("RETIREMENT_ACCOUNT_COPY");
    expect(branch).not.toContain("handleDownload");
    expect(branch).not.toContain("TXF");
  });

  it("names the excluded accounts, pluralising correctly", () => {
    expect(excludedRetirementAccountsNote(undefined)).toBeNull();
    expect(excludedRetirementAccountsNote([])).toBeNull();
    const one = excludedRetirementAccountsNote(["Beta Plan"]);
    expect(one).toContain("Beta Plan");
    expect(one).toContain("retirement account,");
    const two = excludedRetirementAccountsNote(["Beta Plan", "Gamma Plan"]);
    expect(two).toContain("Beta Plan, Gamma Plan");
    expect(two).toContain("retirement accounts,");
  });

  it("says Form 8949 in both disclosures", () => {
    expect(RETIREMENT_ACCOUNT_COPY).toContain("Form 8949");
    expect(NO_RETIREMENT_STAMP_COPY).toContain("retirement account");
  });
});

describe("tax-report API refuses a retirement-scoped file export", () => {
  const source = fs.readFileSync(path.join(ROOT, "app/api/tax-report/route.ts"), "utf-8");

  it("409s csv/txf on report.retirementAccount with the envelope convention", () => {
    expect(source).toContain("report.retirementAccount");
    expect(source).toContain("status: 409");
    expect(source).toContain("no Form 8949 export");
    // The refusal must come before either file is generated.
    expect(source.indexOf("report.retirementAccount")).toBeLessThan(
      source.indexOf('if (format === "csv")')
    );
  });
});
