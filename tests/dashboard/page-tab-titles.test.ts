/**
 * Per-page browser-tab titles (QA finding
 * page-head--same-tab-title-every-route-no-manifest-or-touch-icon, option 1).
 * The root layout carries the "%s · Portfolio Desk" template; each server
 * page names itself. The security hub's title never carries the symbol: a tab
 * title is readable over the shoulder even in privacy mode.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

function page(dir: string): string {
  return readFileSync(join(process.cwd(), "app/dashboard", dir, "page.tsx"), "utf8");
}

describe("dashboard pages name their browser tab", () => {
  it("the root layout carries the title template", () => {
    anchorIndex(readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8"), 'template: "%s · Portfolio Desk"');
  });

  it.each([
    ["accounts", "Accounts"],
    ["charts", "Charts"],
    ["import", "Import"],
    ["data-health", "Data Health"],
    ["security/[id]", "Security"],
  ])("%s has a static title and stays force-dynamic", (dir, title) => {
    const src = page(dir);
    anchorIndex(src, `export const metadata = { title: "${title}" };`);
    anchorIndex(src, 'export const dynamic = "force-dynamic";');
    expect(src).not.toContain('"use client"');
  });

  it.each([
    ["today", ['"Today · Week Ahead"', '"Today"']],
    ["research", ['"Research · Feeds"', '"Research · Documents"', '"Research"']],
  ])("%s names its sub-views and stays force-dynamic", (dir, titles) => {
    const src = page(dir);
    const start = anchorIndex(src, "export async function generateMetadata(");
    const fn = src.slice(start, anchorIndex(src, "export default", start));
    for (const title of titles) anchorIndex(fn, title);
    anchorIndex(src, 'export const dynamic = "force-dynamic";');
  });

  it("the security hub builds no title from the security", () => {
    const src = page("security/[id]");
    expect(src).not.toContain("generateMetadata");
  });
});
