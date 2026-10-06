/**
 * Source-pin regression guard for finding
 * `data-health-discrepancies--privacy-masks-public-close-prices-keeps-symbol-and-diff-pct`.
 * The Cross-Source Discrepancies table compares a named ticker's public close
 * price across two sources. Wrapping those cells in <Money> masked them under
 * privacy mode while the symbol and Diff % stayed visible, hiding nothing
 * private and gutting the panel. Public market data uses the plain formatters.
 * The Snapshot Reconciliation totals are portfolio-derived and stay <Money>.
 *
 * No DOM harness in this repo, so this reads the source and slices it by the
 * section comments.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/DataHealthView.tsx"),
  "utf8",
);

const start = anchorIndex(src, "{/* Cross-Source Discrepancies */}");
const end = anchorIndex(src, "{/* Snapshot Reconciliation */}");
const discrepancies = src.slice(start, end);
const reconciliation = src.slice(end);

describe("DataHealthView discrepancy prices are public market data", () => {
  it("locates both sections", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("does not wrap priceA / priceB in <Money>", () => {
    expect(discrepancies).not.toMatch(/<Money[^>]*d\.price[AB]/);
  });

  it("renders priceA / priceB through the plain precise formatter", () => {
    expect(discrepancies).toMatch(/formatUSDPrecise\(\s*d\.priceA\s*\)/);
    expect(discrepancies).toMatch(/formatUSDPrecise\(\s*d\.priceB\s*\)/);
  });

  it("keeps Snapshot Reconciliation totals on <Money>", () => {
    expect(reconciliation).toMatch(/<Money[^>]*r\.snapshotTotal/);
    expect(reconciliation).toMatch(/<Money[^>]*r\.computedTotal/);
  });
});
