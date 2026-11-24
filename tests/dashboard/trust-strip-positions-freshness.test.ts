/**
 * Trust strip "Positions as of" (2026-11-23) and the scope-change reset
 * (handoff bug 16). Source pins: the repo has no DOM test harness.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const strip = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
const drawer = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");

describe("TrustStrip: Positions as of", () => {
  it("is the first cell of the strip", () => {
    const positions = anchorIndex(strip, 'label="Positions as of"');
    const factor = anchorIndex(strip, 'label="Factor coverage"');
    expect(positions).toBeLessThan(factor);
    // No other cell sits before it.
    expect(strip.slice(0, positions).match(/<Cell\b/g)?.length).toBe(1);
  });

  it("reads the shared label helper and masks the leftover count", () => {
    expect(strip).toContain('from "@/lib/ui/positions-freshness-label"');
    const cell = sliceBetween(strip, 'label="Positions as of"', 'label="Factor coverage"');
    expect(cell).toContain("<PrivateText>{positionsCell.countText}</PrivateText>");
    expect(cell).toContain('togglePanel("positionsFreshness")');
  });
});

describe("TrustStrip: a scope change never shows the previous scope's figures", () => {
  it("keeps the loaded state with its scope and reads it only for the current scope", () => {
    expect(strip).toContain("loaded && loaded.scope === scopeKey ? loaded.state : null");
    expect(strip).toContain("errorFor && errorFor.scope === scopeKey ? errorFor.message : null");
  });

  it("drops a late answer for an older request", () => {
    const fetchBlock = sliceBetween(strip, "const fetchState = useCallback(", "}, [scope]);");
    expect(fetchBlock).toContain("const seq = ++requestSeq.current;");
    expect(fetchBlock.match(/if \(seq !== requestSeq\.current\) return;/g)?.length).toBe(2);
    // Every write in the fetch goes through the scope-keyed setters.
    expect(fetchBlock).not.toContain("setState(");
    expect(fetchBlock).not.toContain("setLoadError(");
  });
});

describe("TrustStripDrawer: Positions as of panel", () => {
  it("is a drawer panel with its own title and content", () => {
    expect(drawer).toContain('| "positionsFreshness"');
    expect(drawer).toContain('positionsFreshness: "Positions As Of"');
    expect(drawer).toContain('{panel === "positionsFreshness" && <PositionsFreshnessContent state={state} />}');
  });

  it("names leftovers, statement rows and the Plaid session fact; counts are masked", () => {
    const body = sliceBetween(drawer, "function PositionsFreshnessContent(", "// ── Panel config");
    expect(body).toContain("Not in the latest sync, still counted as held");
    expect(body).toContain("From the ");
    expect(body).toContain("Plaid positions describe the previous trading session.");
    expect(body).toContain("<Count value={acct.leftover.count} />");
    expect(body).toContain("<Count value={acct.statementRows.count} />");
  });
});
