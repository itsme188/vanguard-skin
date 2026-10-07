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
    const line = sliceBetween(src, "expiredOptionContractCount", "<TaxReportCard");
    expect(line).toContain("<Count");
    expect(line).toContain("expiredOptionContractCount");
    expect(line).toContain('"contract"');
    expect(line).toContain('"contracts"');
    expect(line).toContain("expiredOptionSymbols");
    expect(line).toContain("<PrivateText");
    expect(src).toContain("getExpiredOptionLotsAwaitingClose");
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

  it("security detail names expired option lots awaiting a closing entry", () => {
    const src = securityPageSrc();
    const block = sliceBetween(src, "expiredOptionLotsAwaitingClose", "{/* Closed Sales */}");
    expect(block).toContain("awaiting a closing entry");
    expect(block).toContain("<Count");
    expect(securityQuerySrc()).toContain("getExpiredOptionLotsAwaitingClose");
  });
});
