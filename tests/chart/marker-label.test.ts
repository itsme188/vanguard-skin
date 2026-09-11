import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markerTypeLabel } from "@/lib/chart/marker-label";

// deep-QA: charts-txn-markers--raw-enum-transaction-type-labels-underscores
// SecurityChart's transaction-overlay markerText() used to render t.type raw,
// so option legs printed "BUY_TO_CLOSE 50" / "SELL_TO_OPEN 50" beside plain
// equity's "BUY 100" / "SELL 50" — the only surface in the app leaking the
// underscore enum form. markerTypeLabel keeps the uppercase marker
// vocabulary (space is tight) but swaps underscores for spaces.
describe("markerTypeLabel", () => {
  it("replaces underscores with spaces for option-leg types", () => {
    expect(markerTypeLabel("BUY_TO_CLOSE")).toBe("BUY TO CLOSE");
    expect(markerTypeLabel("SELL_TO_OPEN")).toBe("SELL TO OPEN");
    expect(markerTypeLabel("BUY_TO_COVER")).toBe("BUY TO COVER");
  });

  it("leaves plain equity types unchanged", () => {
    expect(markerTypeLabel("BUY")).toBe("BUY");
    expect(markerTypeLabel("SELL")).toBe("SELL");
  });

  it("trims and collapses repeated spaces/underscores", () => {
    expect(markerTypeLabel("  BUY_TO_CLOSE  ")).toBe("BUY TO CLOSE");
    expect(markerTypeLabel("BUY__TO_CLOSE")).toBe("BUY TO CLOSE");
  });

  it("returns an empty string for empty/undefined input", () => {
    expect(markerTypeLabel("")).toBe("");
    expect(markerTypeLabel(undefined as unknown as string)).toBe("");
  });
});

// Source-scan: no jsdom/RTL harness in this repo (see CLAUDE.md testing
// conventions) — pin the wiring by reading the component source directly.
describe("SecurityChart.tsx wiring", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "app/dashboard/components/SecurityChart.tsx",
    ),
    "utf8",
  );

  it("imports markerTypeLabel from the shared helper", () => {
    expect(source).toMatch(
      /import\s*\{\s*markerTypeLabel\s*\}\s*from\s*["']@\/lib\/chart\/marker-label["']/,
    );
  });

  it("no longer interpolates t.type directly in markerText", () => {
    const match = source.match(
      /function markerText\([\s\S]*?\n\}/,
    );
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).not.toMatch(/\$\{t\.type\}/);
    expect(body).not.toMatch(/return t\.type;/);
    expect(body).toContain("markerTypeLabel(t.type)");
  });
});
