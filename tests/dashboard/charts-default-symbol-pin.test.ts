/**
 * Source-pin coverage for the charts-landing default-security ruling
 * (charts-landing--defaults-to-closed-foreign-symbol-with-no-bars-
 * regression-1 / ...-defaults-to-dead-402340-no-bars-regression-2). No
 * jsdom/RTL in this repo, so page.tsx (a server component) and the
 * mount-effect wiring in ChartsView.tsx (client localStorage behavior) are
 * pinned by reading the source text, per the no-DOM-test-harness
 * convention (app/dashboard/today/hub-live/expansion.ts's own test file
 * uses the same pattern for its untestable wiring).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const pageSrc = () => readFileSync("app/dashboard/charts/page.tsx", "utf8");
const viewSrc = () =>
  readFileSync("app/dashboard/components/ChartsView.tsx", "utf8");

describe("app/dashboard/charts/page.tsx no longer defaults to securities[0]", () => {
  it("calls the new largest-held-position query", () => {
    expect(pageSrc()).toContain("getDefaultChartSecurityId");
    expect(pageSrc()).toContain(
      'import {\n  getChartableSecurities,\n  getDefaultChartSecurityId,\n  getLatestPrice,\n} from "@/lib/queries/ohlcv";',
    );
  });

  it("securities[0] only survives as the alphabetical LAST-RESORT fallback, not the primary default", () => {
    const src = pageSrc();
    // The old primary default assigned straight to `defaultSecurity`; now
    // that name is reserved for the final (held-first, else-alphabetical)
    // choice, and the raw alphabetical pick lives under its own name.
    expect(src).toContain("const alphabeticalFallback =");
    expect(src).not.toMatch(/const defaultSecurity =\s*\n\s*securities\.find/);
    // The final default prefers the held id, falling back to the
    // alphabetical pick — never the reverse.
    expect(src).toMatch(
      /const defaultSecurity =\s*\n\s*\(defaultHeldId != null[\s\S]*?\?\?\s*alphabeticalFallback;/,
    );
  });

  it("threads whether the URL carried an explicit ?id= down to ChartsView", () => {
    const src = pageSrc();
    expect(src).toContain("const hasExplicitId = params.id !== undefined;");
    expect(src).toMatch(/<ChartsView[\s\S]*?hasExplicitId={hasExplicitId}/);
  });

  it("still keeps the explicit ?id= override behavior and force-dynamic", () => {
    const src = pageSrc();
    expect(src).toContain('export const dynamic = "force-dynamic";');
    expect(src).toContain(
      "selectedId && !isNaN(selectedId)\n      ? securities.find((s) => s.id === selectedId) ?? defaultSecurity\n      : defaultSecurity",
    );
  });
});

describe("app/dashboard/components/ChartsView.tsx last-viewed-symbol persistence", () => {
  it("imports the last-symbol helpers", () => {
    const src = viewSrc();
    expect(src).toMatch(
      /import\s*{\s*\n?\s*readLastChartSymbolId,\s*\n?\s*writeLastChartSymbolId,?\s*\n?\s*}\s*from\s*"\.\.\/charts\/last-symbol";/,
    );
  });

  it("writes the last-viewed id from the existing select handler", () => {
    const src = viewSrc();
    const handleSelectBody = src.slice(
      src.indexOf("const handleSelect ="),
      src.indexOf("const handleSelect =") + 400,
    );
    expect(handleSelectBody).toContain("writeLastChartSymbolId(secId);");
  });

  it("reads the last-viewed id inside a useEffect, gated on no explicit ?id=, with an empty dep array (mount-only)", () => {
    const src = viewSrc();
    expect(src).toContain('import { useEffect, useState } from "react";');
    const effectStart = src.indexOf("useEffect(() => {");
    expect(effectStart).toBeGreaterThan(-1);
    const effectBody = src.slice(effectStart, src.indexOf("}, []);", effectStart) + 10);
    expect(effectBody).toContain("if (hasExplicitId) return;");
    expect(effectBody).toContain("readLastChartSymbolId()");
    expect(effectBody).toContain("router.replace(`/dashboard/charts?id=${lastId}`");
    // Mount-only: the dependency array is empty, not `[hasExplicitId]` or similar.
    expect(src).toMatch(/}, \[\]\);/);
  });

  it("never reads localStorage during render — the read only happens inside the useEffect body", () => {
    const src = viewSrc();
    const beforeEffect = src.slice(0, src.indexOf("useEffect(() => {"));
    expect(beforeEffect).not.toContain("readLastChartSymbolId(");
  });

  it("accepts hasExplicitId as a required prop", () => {
    const src = viewSrc();
    expect(src).toContain("hasExplicitId: boolean;");
  });
});
