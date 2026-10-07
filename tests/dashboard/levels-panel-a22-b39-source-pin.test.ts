import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * Wiring pins for the 2026-10-07 levels-panel units (there is no DOM harness;
 * the pure rules are tested in levels-panel-row-status.test.ts and
 * tests/levels/narrative-guard.test.ts).
 */
describe("LevelsPanel suggestion cards, full level set and row extras (source pin)", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");
  const suggested = sliceBetween(src, "function SuggestedLevels(", "function LevelsLoadError(");
  const panel = src.slice(anchorIndex(src, "export function LevelsPanel("));

  // security-detail-levels--suggestion-narrative-contradicts-chip-accept-
  // persists-regression-3 / ...narrative-magnitude-contradiction-regression-7
  it("a card's text and the ACCEPT thesis are the one composed string", () => {
    expect(src).toMatch(
      /import \{ composeLevelNarrative, resolveAcceptedThesis \} from "@\/lib\/levels\/narrative-guard";/,
    );
    expect(suggested).toMatch(/composeLevelNarrative\(sug, data\?\.currentPrice \?\? null\)/);
    expect(suggested).toMatch(/thesis: resolveAcceptedThesis\(sug, data\?\.currentPrice \?\? null\)/);
    // Both card variants print the composed string and nothing else.
    expect(suggested.split("{displayNarrative(sug)}").length - 1).toBe(2);
    // The fact sentence shows even before (or without) a model sentence.
    expect(suggested).not.toMatch(/\{sug\.narrative && \(/);
    // The raw model sentence is never rendered or sent.
    expect(suggested).not.toMatch(/\{sug\.narrative\}/);
    expect(suggested).not.toMatch(/thesis: sug\.narrative/);
  });

  // security-detail-suggested-levels--narrative-ai-failure-swallowed-no-
  // marker-regression-1
  it("a failed narrative is named on the card, in both variants", () => {
    expect(suggested.split("AI commentary unavailable").length - 1).toBe(2);
    expect(suggested.split("{narrativeUnavailable(sug) && (").length - 1).toBe(2);
    expect(suggested).toMatch(
      /sug\.narrative == null && \(sug\.narrativeUnavailable === true \|\| narrativeRequestFailed\)/,
    );
    // A failed POST (non-2xx or thrown) sets the flag instead of vanishing.
    const post = sliceBetween(suggested, "if (needsNarratives) {", "} finally {");
    expect(post.split("setNarrativeRequestFailed(true)").length - 1).toBe(2);
  });

  // security-detail-levels--show-inactive-toggle-drops-suggestions-regression-1
  it("the suggestion de-dupe reads the full level set, not the displayed rows", () => {
    const refresh = sliceBetween(panel, "const refresh = useCallback(async () => {", "}, [securityId, showInactive]);");
    expect(refresh).toMatch(/activeOnly=\$\{!showInactive\}/);
    expect(refresh).toMatch(/if \(!showInactive\) \{/);
    expect(refresh).toMatch(/\/api\/levels\?securityId=\$\{securityId\}&activeOnly=false/);
    expect(refresh).toMatch(/setAllLevels\(full\)/);
    // A failed full-set read is reported, never treated as "nothing hidden".
    const fullRead = sliceBetween(refresh, "if (!showInactive) {", "full = fullJson.levels;");
    expect(fullRead).toMatch(/!fullRes\.ok \|\| !fullJson\?\.success/);
    expect(fullRead).toMatch(/setLoadError\("Levels could not be loaded"\)/);
    expect(panel).toMatch(/userLevels=\{allLevels \?\? levels\}/);
    expect(panel).not.toMatch(/userLevels=\{levels\}/);
  });

  // security-detail-levels--empty-state-hides-inactive-and-pending-review-levels
  it("the empty state names what the default view hides and offers Show inactive", () => {
    expect(panel).toMatch(
      /!showInactive && levels\.length === 0 \? hiddenLevelsSummary\(allLevels \?\? \[\]\) : null/,
    );
    expect(panel).toContain("`No armed levels · ${hiddenSummary}`");
    expect(panel).toContain("`No armed levels. ${hiddenSummary}.`");
    expect(panel.split("onClick={() => setShowInactive(true)}").length - 1).toBe(2);
    // The plain copy is still what a security with no levels at all gets.
    expect(panel).toContain("No active levels · accept a suggestion or add your own");
    expect(panel).toContain("No levels set. Add one above.");
  });

  // security-detail-levels--status-sort-pill-orders-by-is-active-not-visible-status
  it("the Status pill sorts on the visible status rank", () => {
    expect(panel).toMatch(/levelSort\.field === "is_active"\s*\?\s*levelStatusRank\(l\)/);
    expect(panel).toMatch(/compareValues\(sortValue\(a\), sortValue\(b\), levelSort\.dir\)/);
  });

  // security-detail-levels--rows-show-no-date-duplicate-contradictory-levels
  // security-detail-levels--expiry-and-timeframe-write-only-no-edit-control
  it("every row prints the added date, timeframe and expiry line, in both variants", () => {
    expect(panel).toMatch(/const today = todayET\(\);/);
    expect(panel.split("const meta = levelRowMeta(l, today);").length - 1).toBe(2);
    expect(panel.split('{meta.join(" · ")}').length - 1).toBe(2);
    // Always visible text — not a hover-only title.
    expect(panel).not.toMatch(/title=\{meta/);
    // The date is the Eastern date of the stored stamp, never a UTC slice.
    const helper = sliceBetween(src, "export function levelRowMeta(", "/** The two refusals");
    expect(helper).toMatch(/lastFiredDateET\(l\.created_at\)/);
    expect(helper).not.toMatch(/created_at\.slice|created_at\.substring/);
  });

  // security-detail-levels--pending-review-rows-no-approve-reject-on-hub
  // (owner ruling 2026-09-14: link to the inbox, no second review surface)
  it("a pending-review row links to the alerts inbox and the panel has no approve / reject of its own", () => {
    expect(panel.split('href="/dashboard/alerts?view=review"').length - 1).toBe(2);
    expect(panel.split("{pendingReview && (").length - 1).toBe(2);
    expect(panel.split('const pendingReview = levelRowStatus(l) === "pending_review";').length - 1).toBe(2);
    // The only review write this panel makes is Re-queue (back to pending).
    expect(src.split('"/api/levels/review"').length - 1).toBe(1);
    expect(src).toMatch(/JSON\.stringify\(\{ id, status: "pending_review" \}\)/);
    expect(src).not.toMatch(/status: "(auto_approved|approved|rejected)"/);
  });
});
