/**
 * Trust strip: a "Sectors classified" cell reads the stored sector-run time.
 * Data Health: a section lists held options whose underlying has no sector.
 * Source pins (no DOM harness in this repo); the figures behind both are
 * tested against a database in tests/queries and tests/securities.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const strip = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
const drawer = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");
const page = readFileSync("app/dashboard/data-health/page.tsx", "utf8");

function fnBody(src: string, name: string): string {
  const start = anchorIndex(src, `function ${name}`);
  const next = src.indexOf("\nfunction ", start + 1);
  const nextExported = src.indexOf("\nexport function ", start + 1);
  const ends = [next, nextExported, src.indexOf("\n// ── Panel config", start)].filter((i) => i !== -1);
  return src.slice(start, Math.min(...ends));
}

describe("Trust strip: sector-classify time", () => {
  it("has its own cell, fed by the stored sector-run time, not the factor time", () => {
    const at = anchorIndex(strip, 'label="Sectors classified"');
    const cell = strip.slice(at, strip.indexOf("/>", at));
    expect(cell).toContain("formatRelative(lastSectorClassification)");
    expect(cell).toContain("formatEnrichedAtET(lastSectorClassification)");
    expect(cell).toContain('togglePanel("sectorClassify")');
    // The factor cell is still there and still reads the factor time.
    anchorIndex(strip, 'label="Factors updated"');
    anchorIndex(strip, "value={formatRelative(lastClassification)}");
  });

  it("does not turn an old time into a warning: only a missing one", () => {
    anchorIndex(strip, 'const sectorClassifyTone: Tone = lastSectorClassification ? "neutral" : "warn";');
  });

  it("the loading skeleton has one box per cell", () => {
    const cells = strip.match(/<Cell\n/g) ?? [];
    expect(cells).toHaveLength(6);
    anchorIndex(strip, "Array.from({ length: 6 })");
  });

  it("the drawer has a panel for it, shown as Eastern time, in owner language", () => {
    anchorIndex(drawer, '| "sectorClassify"');
    anchorIndex(drawer, 'sectorClassify: "Sectors Last Classified"');
    anchorIndex(drawer, '{panel === "sectorClassify" && <SectorClassifyContent state={state} />}');
    const block = fnBody(drawer, "SectorClassifyContent");
    anchorIndex(block, "state.lastSectorClassification");
    anchorIndex(block, "formatEnrichedAtET(ts)");
    expect(block).not.toMatch(/\$\{ts\}/);
    // The time is a CHECK time: found in line or brought in line.
    anchorIndex(block, "Sectors last checked:");
    anchorIndex(block, "found in line or brought in line");
    // Says what does NOT move the date, and where the unresolved options are.
    anchorIndex(block, "does not move this date");
    expect(block).not.toContain("had something to change");
    anchorIndex(block, 'href="/dashboard/data-health#option-underlying-sector"');
    expect(block).not.toMatch(/scripts\//);
    expect(block).not.toMatch(/\.ts\b/);
    expect(block).not.toMatch(/settings|sector_source/);
  });
});

describe("Data Health: options whose underlying has no sector", () => {
  function section(): string {
    const at = anchorIndex(page, "Options whose underlying has no sector");
    return page.slice(page.lastIndexOf("<section", at), anchorIndex(page, "</section>", at));
  }

  it("reads the list on the server from the query module, not from a client file", () => {
    anchorIndex(page, "getOptionsWithUnsectoredUnderlying(db)");
    expect(page).toMatch(/getOptionsWithUnsectoredUnderlying,[\s\S]*?from "@\/lib\/queries\/data-health"/);
    expect(page).not.toContain('"use client"');
    // The two label helpers are local to the server page.
    anchorIndex(page, "function optionSectorGapReasonLabel");
    anchorIndex(page, "function optionSectorOriginLabel");
  });

  it("is the anchor the trust strip links to", () => {
    expect(section()).toContain('id="option-underlying-sector"');
  });

  it("links the option, and the underlying only when it has a security page", () => {
    const s = section();
    expect(s).toMatch(/<SymbolLink\s+securityId=\{o\.securityId\}\s+symbol=\{o\.symbol\}/);
    expect(s).toMatch(/o\.underlyingSecurityId != null \?/);
    expect(s).toMatch(/<SymbolLink\s+securityId=\{o\.underlyingSecurityId\}\s+symbol=\{o\.underlyingSymbol\}/);
  });

  it("prints the count through <Count>, wraps the table in ScrollFade, and says so when the list is empty", () => {
    const s = section();
    expect(s).toMatch(/<Count value=\{optionSectorGaps\.length\} \/>/);
    expect(s).not.toMatch(/>\s*\{optionSectorGaps\.length\}/);
    const table = anchorIndex(s, "<table");
    expect(s.slice(0, table).trimEnd().endsWith("<ScrollFade>")).toBe(true);
    expect(s).toContain("Every option you hold has an underlying with a sector.");
  });

  it("tells the owner the page changes no sector, and names no file or column", () => {
    const s = section();
    expect(s).toContain("Nothing on this page changes");
    expect(s).not.toMatch(/scripts\/|\.ts\b|sector_source|ai_classify/);
  });
});
