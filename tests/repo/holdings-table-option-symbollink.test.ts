/**
 * QA finding
 * accounts-holdings-single--option-rows-plain-text-no-symbollink-regression-1:
 * app/dashboard/components/HoldingsTable.tsx (the single-account Holdings
 * table on /dashboard/accounts?id=N) rendered every option-contract row's
 * symbol cell as a bare `<span>{underlying}</span>` with no link to the
 * contract's security hub — a regression against the project convention
 * that every symbol on a user-visible surface links to
 * /dashboard/security/[id] via SymbolLink (see components/SymbolLink.tsx).
 * The All Accounts table (AllHoldingsTable.tsx) already links every row
 * (option or not) through SymbolLink; this fix brings the per-account
 * table's option branch into line, keeping the contract-description
 * sub-span (underlying/strike/type/expiry) as-is.
 *
 * This is a source-pin test (no DOM harness in this repo — see
 * tests/repo/holdings-table-quantity-unit-helper.test.ts precedent): it
 * asserts the option branch renders <SymbolLink for the primary symbol,
 * and that no bare `<span>{...}</span>` option-symbol branch remains.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("HoldingsTable — option rows link the symbol via SymbolLink", () => {
  const src = readFileSync("app/dashboard/components/HoldingsTable.tsx", "utf8");

  it("option branch renders <SymbolLink for the underlying/symbol", () => {
    expect(src).toMatch(
      /security_type\?\.toLowerCase\(\) === "option" \? \(\s*<>\s*<SymbolLink[\s\S]{0,200}underlying_symbol \?\? holding\.symbol/
    );
  });

  it("option branch passes the row's security_id to SymbolLink", () => {
    expect(src).toMatch(/<SymbolLink[\s\S]{0,120}securityId=\{holding\.security_id\}/);
  });

  it("no longer renders a bare <span> for the option symbol (regression guard)", () => {
    expect(src).not.toMatch(/<span>\{holding\.underlying_symbol \?\? holding\.symbol\}<\/span>/);
  });

  it("keeps the contract-description sub-span untouched", () => {
    expect(src).toMatch(
      /<span className="ml-1\.5 text-xs text-ink-faint font-normal">\s*\{formatOptionDescription\(holding\)\}\s*<\/span>/
    );
  });
});
