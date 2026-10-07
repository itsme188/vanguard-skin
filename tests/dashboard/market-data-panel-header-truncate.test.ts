import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// QA finding: mobile-security-chart-header--meta-strip-zero-width-no-min-w-0
// (resolves the desktop half too: security-detail-header--strip-clips-sector-type-no-ellipsis-regression-2)
//
// The dark chart module's header strip left group (SYMBOL · NAME · TYPE ·
// SECTOR · ASSET CLASS) is a flex child with no min-w-0. A flex child's
// min-width defaults to auto, so it can't shrink below its content: at
// narrow viewports it can collapse to zero width (text fully invisible)
// while at wider ones with less free space it hard-clips mid-word against
// the panel's own `overflow-hidden` edge, with no ellipsis, because
// text-overflow:ellipsis never actually renders on a flex CONTAINER with
// multiple flex-item children — only on a block-level element whose own
// content overflows a line box. Fix: min-w-0 on the flex row so it can
// shrink, plus the actual truncate/ellipsis rule moved onto a single
// wrapping child span (blockified as the sole flex item) that holds all
// three text pieces.
//
// A full component render isn't cheap here: MarketDataPanel embeds
// LevelsPanel, which needs a mounted Next.js router (useSortParam) plus
// several other contexts (usePrivacy, useToast) — this is a source-scan
// pin instead, matching the precedent in nearby-levels-privacy.test.tsx's
// "does not import Money/Pct" backstop.
describe("MarketDataPanel header strip truncation", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/MarketDataPanel.tsx"),
    "utf8"
  );

  it("lets the left (symbol/name/type) group shrink below its content width", () => {
    expect(source).toMatch(/flex items-center gap-3 min-w-0/);
  });

  it("puts the truncate/ellipsis rule on a single child span, not the flex row itself", () => {
    expect(source).toMatch(/<span className="truncate">/);
  });
});

// QA finding: security-detail-header--strip-clips-sector-type-no-ellipsis-regression-3
// One truncate span around symbol + name + type cut the line from the right:
// a long company name pushed the type and sector off the end entirely. The
// name is now the part that gives way.
describe("MarketDataPanel header strip — the name truncates, not the type", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/MarketDataPanel.tsx"),
    "utf8"
  );
  const start = source.indexOf('<div className="flex items-center gap-3 min-w-0">');
  const row = source.slice(start, source.indexOf("<FreshnessStamp", start));

  it("finds the row (anchor has not vanished)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(row.length).toBeGreaterThan(0);
  });

  it("the symbol never shrinks", () => {
    expect(row).toMatch(/<span className="shrink-0"[^>]*>\{symbol\}<\/span>/);
  });

  it("the truncate span holds the name only", () => {
    expect(row).toMatch(/\{name && <span className="truncate">· \{name\}<\/span>\}/);
    expect(row).not.toMatch(/<span className="truncate">\s*<span/);
  });

  it("the type gives way only after the name (token flex-shrink)", () => {
    expect(row).toMatch(/flexShrink: 0\.001 \}\}>\s*· \{typeLabel\}/);
  });
});
