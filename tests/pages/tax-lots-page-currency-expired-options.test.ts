import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const pageSrc = () =>
  readFileSync(path.join(process.cwd(), "app/dashboard/tax-lots/page.tsx"), "utf8");
const tableSrc = () =>
  readFileSync(path.join(process.cwd(), "app/dashboard/components/TaxLotTables.tsx"), "utf8");
const securityPageSrc = () =>
  readFileSync(path.join(process.cwd(), "app/dashboard/security/[id]/page.tsx"), "utf8");
const securityQuerySrc = () =>
  readFileSync(path.join(process.cwd(), "lib/queries/security-detail.ts"), "utf8");

describe("Tax Lots page source pins — currency conversions and expired options", () => {
  it("renders a dedicated Section 988 currency-conversion block before capital open lots", () => {
    const src = pageSrc();
    const block = sliceBetween(src, "Currency conversions (Section 988, ordinary income)", "<OpenLotsTable");
    expect(block).toContain("currencyConversion");
    expect(block).toContain("TaxLotCurrencyConversionTable");
  });

  it("renders the expired-option awaiting-closing-entry line with private count text", () => {
    const src = pageSrc();
    // Anchor on the rendered line's own guard, not the first mention of the
    // variable: sliced from its declaration, the block held the declaration
    // of both names, so the name checks passed with the JSX deleted.
    const line = sliceBetween(src, "{expiredOptionContractCount > 0 && (", "<TaxReportCard");
    expect(line).toContain("<Count value={expiredOptionContractCount} />");
    // 2026-10-08: this used to pin both "contract" and "contracts". The
    // switch told a reader with amounts hidden whether the count was one,
    // so the noun now leads and is always plural.
    expect(line).toContain("Expired contracts awaiting a closing entry: <Count");
    expect(line).not.toContain('"contract"');
    expect(line).not.toContain("=== 1");
    expect(line).toContain("awaiting a closing entry");
    expect(line).toContain("<PrivateText>{expiredOptionSymbols.join(");
    // The count is distinct contracts read from the shared query, not lots.
    expect(src).toContain("getExpiredOptionLotsAwaitingClose(db)");
    expect(src).toMatch(/const expiredOptionContractCount = expiredOptionSymbols\.length;/);
  });

  it("keeps portfolio-derived quantities in the new tax-lot table behind privacy components", () => {
    const src = tableSrc();
    const start = anchorIndex(src, "export function TaxLotCurrencyConversionTable");
    const block = src.slice(start, anchorIndex(src, "export function ClosedSalesTable", start));
    expect(block).toContain("<Shares");
    expect(block).toContain("<Money");
    expect(block).toContain("<PrivateText");
  });

  it("currency-conversion block stays visible with an EmptySection and private count", () => {
    const src = tableSrc();
    const start = anchorIndex(src, "export function TaxLotCurrencyConversionTable");
    const block = src.slice(start, anchorIndex(src, "export function ClosedSalesTable", start));
    expect(block).toContain("<EmptySection");
    expect(block).toContain("<Count");
    expect(block).not.toContain("text-ink-faint/60");
  });

  it("Closed Sales stays visible as an EmptySection when the scoped year has no sales", () => {
    const src = tableSrc();
    const start = anchorIndex(src, "export function ClosedSalesTable");
    const block = src.slice(start);
    expect(block).toContain("<EmptySection");
    expect(block).toContain('title="Closed Sales"');
    expect(block).toContain("No closed sales for this scope and year.");
    expect(block).not.toContain("if (sales.length === 0) {\n    return null;");
  });

  it("Closed Sales sorts non-USD proceeds and gain/loss by USD-converted sort keys", () => {
    const src = tableSrc();
    const start = anchorIndex(src, "export function ClosedSalesTable");
    const block = src.slice(start);
    expect(block).toContain('if (field === "proceeds") return sale.proceeds_usd;');
    expect(block).toContain('if (field === "cost_basis_allocated") return sale.cost_basis_allocated_usd;');
    expect(block).toContain('if (field === "realized_gain_loss") return sale.realized_gain_loss_usd;');
  });

  it("summary open-lot counts use the privacy Count component", () => {
    const src = readFileSync(
      path.join(process.cwd(), "app/dashboard/components/TaxLotSummary.tsx"),
      "utf8"
    );
    const block = sliceBetween(src, 'label="Unrealized"', 'label={`${year} Realized`}');
    expect(block).toContain("<Count value={summary.totalOpenLots} />");
  });

  it("security detail names expired option lots awaiting a closing entry", () => {
    const src = securityPageSrc();
    const block = sliceBetween(src, "expiredOptionLotsAwaitingClose", "{/* Closed Sales */}");
    expect(block).toContain("awaiting a closing entry");
    expect(block).toContain("<Count");
    expect(securityQuerySrc()).toContain("getExpiredOptionLotsAwaitingClose");
  });
});
