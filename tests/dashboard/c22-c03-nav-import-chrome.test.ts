import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex } from "../helpers/source-anchor";
import { dataHealthRowLabel } from "@/app/dashboard/components/MobileNavDrawer";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("C22 mobile nav", () => {
  it("bottom-nav Research opens Feeds, Notes keeps its own view", () => {
    const src = read("app/dashboard/components/MobileBottomNav.tsx");
    const i = anchorIndex(src, 'name: "Research"');
    expect(src.slice(i, i + 400)).toContain('href: "/dashboard/research?view=feeds"');
    anchorIndex(src, 'href: "/dashboard/research?view=notes"');
    anchorIndex(src, "activeUnlessSearchParam: { key: \"view\", value: \"notes\" }");
  });
  it("drawer carries the theme toggle and a data-health row; header wrapper unchanged", () => {
    const src = read("app/dashboard/components/MobileNavDrawer.tsx");
    anchorIndex(src, "<ThemeToggle />");
    anchorIndex(src, 'href="/dashboard/data-health"');
    const layout = read("app/dashboard/layout.tsx");
    anchorIndex(layout, '<div className="hidden md:inline-flex"><ThemeToggle /></div>');
  });
  it("data-health row label shows score and cap, never the reason", () => {
    expect(dataHealthRowLabel(null)).toBe("Data health");
    expect(dataHealthRowLabel({ overallScore: 80, capReason: null })).toBe("Data health · 80%");
    expect(dataHealthRowLabel({ overallScore: 40, capReason: "secret detail" })).toBe(
      "Data health · 40% (capped)",
    );
  });
  it("titles: root template and analysis sub-view titles", () => {
    anchorIndex(read("app/layout.tsx"), 'template: "%s · Portfolio Desk"');
    const a = read("app/dashboard/analysis/page.tsx");
    anchorIndex(a, "export async function generateMetadata");
    anchorIndex(a, 'diagnostics: "Analysis · Diagnostics"');
  });
  it("settings gear reaches 44px on touch", () => {
    const src = read("app/dashboard/components/SettingsModal.tsx");
    const i = anchorIndex(src, 'aria-label="Settings"');
    expect(src.slice(i - 300, i)).toContain("pointer-coarse:after:-inset-3.5");
  });
});

describe("C03 import history and guide", () => {
  const h = read("app/dashboard/components/ImportHistory.tsx");
  it("Undo sits in the column right after File", () => {
    const file = anchorIndex(h, ">\n                  File\n");
    const undoTh = anchorIndex(h, ">Undo</th>");
    const type = anchorIndex(h, ">\n                  Type\n");
    expect(file).toBeLessThan(undoTh);
    expect(undoTh).toBeLessThan(type);
    const fileTd = anchorIndex(h, "title={batch.filename");
    const undoBtn = anchorIndex(h, "onClick={() => handleUndo(batch)}");
    const typeTd = anchorIndex(h, "SOURCE_LABELS[batch.source_type] ?? batch.source_type}\n");
    expect(fileTd).toBeLessThan(undoBtn);
    expect(undoBtn).toBeLessThan(typeTd);
  });
  it("undo confirm says where the snapshot is and that restore is a terminal script", () => {
    anchorIndex(h, "undo-recovery");
    anchorIndex(h, "scripts/restore-import-batch.ts");
    expect(h).not.toContain("can be restored if needed");
  });
  it("guide states the header is positional", () => {
    const g = read("app/dashboard/components/CanonicalCsvGuide.tsx");
    anchorIndex(g, "HEADER IS POSITIONAL");
  });
});
