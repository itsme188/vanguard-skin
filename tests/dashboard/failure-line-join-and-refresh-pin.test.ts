/**
 * Review items from the 2026-10-09 failure-line sweep. SOURCE SCANS (this
 * repo has no DOM harness):
 *
 *  1. A failure line that puts a sentence after the server's own text joins
 *     the two through `joinSentences`, so text without a full stop does not
 *     run into the next sentence.
 *  2. The alerts page's respond() re-reads through `refreshAfterWrite`, like
 *     its sibling paths, so a failed re-read is never an unhandled rejection.
 *  3. The Plaid section: a failed re-read after a finished sync has its own
 *     line and never replaces the section (which would hide "Synced N
 *     holdings" and invite a second sync).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const JOINED_FILES = [
  "app/dashboard/alerts/page.tsx",
  "app/dashboard/components/CorporateActionsSection.tsx",
  "app/dashboard/components/AiModelsSection.tsx",
  "app/dashboard/components/PlaidSection.tsx",
  "app/dashboard/components/DigestCatchup.tsx",
  "app/dashboard/components/analysis/TrustStripDrawer.tsx",
  "app/dashboard/plaid-link/page.tsx",
  "app/dashboard/components/ResearchFeedsView.tsx",
  "app/dashboard/today/EarningsDeleteButton.tsx",
  "app/dashboard/today/FirstPassRead.tsx",
];

describe("server text followed by a sentence is joined through joinSentences", () => {
  for (const file of JOINED_FILES) {
    it(`${file}: no "\${...message} Sentence" template`, () => {
      const src = read(file);
      // `${result.message} Nothing was changed.` and the multi-line form
      // `${ result.ok ? "..." : result.message\n } The override ...`.
      expect(src).not.toMatch(/\.message\s*\}\s+[A-Z]/);
      expect(src).toContain('from "@/lib/ui/join-sentences"');
      expect(src).toContain("joinSentences(");
    });
  }
});

describe("alerts page: respond() re-reads through refreshAfterWrite", () => {
  const src = read("app/dashboard/alerts/page.tsx");
  const body = sliceBetween(src, "async function respond(", "async function restoreToPending(");

  it("awaits refreshAfterWrite and has no bare refresh()", () => {
    expect(body).toContain("await refreshAfterWrite();");
    expect(body).not.toMatch(/(^|[^.\w])refresh\(\)/);
  });
});

describe("Plaid section: a failed re-read after a finished sync", () => {
  const src = read("app/dashboard/components/PlaidSection.tsx");
  const reread = sliceBetween(src, "async function refreshAfterWrite(", "async function saveMapping(");
  const sync = sliceBetween(src, "async function handleSync(", "if (!payload && !loadError)");

  it("has its own line and never sets the load error that replaces the section", () => {
    expect(reread).toContain("setRefreshError(");
    expect(reread).not.toContain("setLoadError(");
    expect(src).toContain(
      "The sync finished; the list could not be refreshed. Reload to see it.",
    );
  });

  it("a good re-read clears that line", () => {
    expect(reread).toContain("setRefreshError(null)");
  });

  it("the sync handler re-reads through it, after the success line is set", () => {
    const success = anchorIndex(sync, 'kind: "success"');
    const call = anchorIndex(sync, "refreshAfterWrite()");
    expect(call).toBeGreaterThan(success);
    expect(sync).not.toContain("setLoadError(");
    expect(sync).not.toMatch(/[^\w]load\(\)/);
  });

  it("the line renders beside the sync result, not in place of it", () => {
    const syncBlock = src.slice(anchorIndex(src, "{syncStatus && ("));
    expect(syncBlock).toContain("{refreshError && (");
  });

  it("only the first load can replace the section", () => {
    expect(src.match(/setLoadError\(/g)?.length).toBe(2);
  });
});
