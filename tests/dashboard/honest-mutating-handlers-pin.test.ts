import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// U21 (2026-10-05): every mutating handler goes through the shared result
// reader, explains failures in domain language and never swallows an error.
const dir = join(process.cwd(), "app/dashboard/components");
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const HELPER_USERS = [
  "LevelsPanel.tsx",
  "AddLevelPopover.tsx",
  "WatchlistButton.tsx",
  "ImportHistory.tsx",
  "ReconciliationTable.tsx",
  "TwsStatus.tsx",
  "EarningsEmailsSection.tsx",
  "SendDigestPanel.tsx",
  "ResearchFeedsView.tsx",
  "ResearchDocumentsView.tsx",
  "SettingsModal.tsx",
  "TranscriptCard.tsx",
];
// NotesAmbient already routes through describeNoteSaveFailure (the notes copy).
const ALL = [...HELPER_USERS, "NotesAmbient.tsx", "TradeReviewView.tsx"];

describe("honest mutating handlers (U21)", () => {
  it.each(HELPER_USERS)("%s imports the shared mutation-result helper", (f) => {
    expect(read(f)).toMatch(/from "@\/lib\/ui\/mutation-result"/);
  });

  it("NotesAmbient keeps the notes-specific failure copy", () => {
    expect(read("NotesAmbient.tsx")).toMatch(/describeNoteSaveFailure/);
  });

  it.each(ALL)("%s has no empty catch block", (f) => {
    // Truly empty, or a bare "ignore" marker. A catch whose comment explains a
    // deliberate skip (malformed SSE line, background enrichment) is allowed.
    expect(read(f)).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*(\/\*\s*ignore\s*\*\/\s*)?\}/);
  });

  it("LevelsPanel pause/reactivate/delete no longer gate on a bare res.ok", () => {
    const src = read("LevelsPanel.tsx");
    expect(src).not.toMatch(/if \(res\.ok\) toast\(/);
    expect(src).toMatch(/Couldn't pause the level/);
    expect(src).toMatch(/Couldn't reactivate the level/);
    expect(src).toMatch(/Couldn't delete the level/);
  });

  it.each(["AddLevelPopover.tsx", "WatchlistButton.tsx", "ReconciliationTable.tsx", "TranscriptCard.tsx"])(
    "%s does not render raw exception text",
    (f) => {
      expect(read(f)).not.toMatch(/err instanceof Error \? err\.message/);
      expect(read(f)).not.toMatch(/e instanceof Error \? e\.message/);
    },
  );

  it("TradeReviewView success banner renders tradeCount/winRate through privacy components", () => {
    const src = read("TradeReviewView.tsx");
    expect(src).toMatch(/<Count value=\{data\.data\.tradeCount\}/);
    expect(src).toMatch(/<Pct value=\{data\.data\.winRate \* 100\}/);
    expect(src).not.toMatch(/\$\{data\.data\.tradeCount\}/);
  });

  it("SendDigestPanel close button has an aria-label and a 44px touch target", () => {
    const src = read("SendDigestPanel.tsx");
    expect(src).toMatch(/aria-label="Close send email panel"/);
    expect(src).toMatch(/p-3\.5 -m-3\.5/);
  });

  it("SecurityEarningsEmails surfaces delivery_unknown with the shared Chip", () => {
    const src = read("SecurityEarningsEmails.tsx");
    expect(src).toMatch(/e\.delivery_unknown === 1/);
    expect(src).toMatch(/<Chip\s+tone="warn"/);
    expect(src).not.toMatch(/"delivery_unknown"/);
  });
});
