/**
 * Security page pending chips and note (source pin). Moved here from
 * tests/dashboard/tax-lots-pending-statement.test.tsx by ruling R16 (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 10) and rewritten for the reason-driven chip: the chip stands in for
 * the unrealized figure, and its label and title come from the copy helpers.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");

describe("Security detail open lots (source pin)", () => {
  const start = anchorIndex(src, "{/* Tax Lots */}");
  const block = src.slice(start);

  it("shows the reason's chip in place of the unrealized figure for a pending lot", () => {
    expect(block).toMatch(
      /\{lot\.pending_statement \? \(\s*<Chip tone="neutral" size="xs" title=\{pendingChipTitle\(lot\.pending_statement_reason \?\? "awaiting_statement"\)\}>\s*\{pendingChipLabel\(lot\.pending_statement_reason \?\? "awaiting_statement"\)\}\s*<\/Chip>\s*\) : \(\s*<Money value=\{lot\.unrealized_gain\} fallback="–" \/>\s*\)\}/
    );
  });

  it("the phone-width repeat of the chip reads the same helpers", () => {
    expect(block).toMatch(
      /\{lot\.pending_statement && \(\s*<span className="block md:hidden[^"]*">\s*<Chip tone="neutral" size="xs" wrap title=\{pendingChipTitle\(lot\.pending_statement_reason \?\? "awaiting_statement"\)\}>\s*\{pendingChipLabel\(lot\.pending_statement_reason \?\? "awaiting_statement"\)\}/
    );
  });

  it("no fixed pending chip label or title remains on the page", () => {
    expect(src).not.toContain("PENDING_STATEMENT_CHIP_LABEL");
    expect(src).not.toContain("PENDING_STATEMENT_TITLE");
  });
});

describe("Security detail lots-without-position note (source pin)", () => {
  it("words the note from the account's pending reason through the copy module", () => {
    expect(src).toMatch(
      /\{orphan\.allPendingStatement\s*\?\s*lotsWithoutPositionNote\(orphan\.pendingReason \?\? "awaiting_statement"\)/
    );
    expect(src).toMatch(
      /import \{[^}]*lotsWithoutPositionNote[^}]*\} from "\.\.\/\.\.\/components\/pending-statement-copy";/
    );
  });

  it("no hand-written live-data sentence is left beside the helper", () => {
    expect(src).not.toContain("The broker's live data shows the position closed; the lots stay open until");
  });
});
