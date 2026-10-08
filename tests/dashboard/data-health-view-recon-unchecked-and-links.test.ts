/**
 * QA findings
 *   data-health-recon-flags--zero-count-ignores-115-unreconciled-snapshots
 *   data-health--47-symbol-cells-dead-text-while-siblings-link-to-hub
 *
 * View side of two data-health fixes:
 *  - the Recon Flags card and the Snapshot Reconciliation panel disclose how
 *    many statement snapshots were never compared, reading the count off the
 *    summary (same predicate as the rows; pinned on real rows in
 *    tests/queries/data-health-panel-identities.test.ts);
 *  - the Cross-Source Discrepancies symbol cell links to the security hub.
 *
 * DataHealthView is "use client" with no DOM harness in this repo — pinned
 * with a source scan, same pattern as
 * tests/dashboard/data-health-reconciliation-disclosure.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const source = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/DataHealthView.tsx"),
  "utf8",
);

describe("DataHealthView — Recon Flags card discloses never-compared snapshots", () => {
  const cardStart = anchorIndex(source, 'label="Recon Flags"');
  const card = source.slice(cardStart, anchorIndex(source, "/>", cardStart));

  it("the card's sub-line reads the unchecked count off the summary", () => {
    expect(card).toMatch(/sub=\{reconCardSub \|\| undefined\}/);
    const subDef = sliceBetween(source, "const reconCardSub", ".join(");
    expect(subDef).toMatch(
      /summary\.totalReconciliationUnchecked > 0\s*\?\s*`\$\{summary\.totalReconciliationUnchecked\} not compared`/,
    );
  });

  it("is green only when there are no flags AND nothing unchecked", () => {
    expect(card).not.toMatch(
      /color=\{summary\.totalReconciliationFlags === 0 \? "up" : "down"\}/,
    );
    expect(card).toMatch(/color=\{reconCardColor\}/);
    const colorDef = sliceBetween(source, "const reconCardColor", ";");
    expect(colorDef).toMatch(/summary\.totalReconciliationFlags > 0\s*\?\s*"down"/);
    expect(colorDef).toMatch(/summary\.totalReconciliationUnchecked > 0\s*\?\s*"gold"/);
    expect(colorDef).toMatch(/:\s*"up"/);
  });
});

describe("DataHealthView — Snapshot Reconciliation panel discloses never-compared snapshots", () => {
  const panel = sliceBetween(
    source,
    "{/* Snapshot Reconciliation */}",
    "{/* FX Rates */}",
  );

  it("states the unchecked count out of the full snapshot count, gated on there being any", () => {
    expect(panel).toMatch(/\{summary\.totalReconciliationUnchecked > 0 && \(/);
    expect(panel).toMatch(/\{summary\.totalReconciliationUnchecked\} of\{" "\}\s*\n?\s*\{summary\.totalReconciliationSnapshots\}/);
    expect(panel).toMatch(/never compared/);
  });

  it("labels an uncompared row instead of a bare dash in Diff %", () => {
    expect(panel).toMatch(/not compared/);
  });
});

describe("DataHealthView — Cross-Source Discrepancies symbols link to the hub", () => {
  const panel = sliceBetween(
    source,
    "{/* Cross-Source Discrepancies */}",
    "{/* Snapshot Reconciliation */}",
  );

  it("imports SymbolLink", () => {
    expect(source).toMatch(/import \{ SymbolLink \} from "\.\/SymbolLink";/);
  });

  it("renders the symbol through SymbolLink with the row's securityId", () => {
    expect(panel).toMatch(/<SymbolLink\s+securityId=\{d\.securityId\}\s+symbol=\{d\.symbol\}/);
    // The dead-text cell is gone.
    expect(panel).not.toMatch(/<td className="px-5 py-2 font-mono text-ink">\{d\.symbol\}<\/td>/);
  });
});
