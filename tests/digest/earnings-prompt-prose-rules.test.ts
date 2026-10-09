import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  renderPreviewPrompt,
  renderRecapPrompt,
  type EarningsPreviewContext,
  type EarningsRecapContext,
} from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";

/**
 * Tests for Task 5 prose + attribution rules.
 *
 * The earnings preview + recap prompts guide the AI on:
 *   - System-rendered "## Sheet bogeys — by source" table (never re-list, cite sources in-cell)
 *   - Per-source bogey attribution with source labels in parentheses
 *   - Numbered-list format for "## What to watch on the call" section
 *   - Framing-sentence rule for "## The setup" section (open with model's own framing)
 *   - Section prose style (1-3 flowing paragraphs, bullets only, no filler openers)
 *
 * These tests grep for the pinned phrase text to verify the prompt rules are present
 * and match the documented intent.
 */

function makeEvent(symbol: string): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-08-06",
    title: `${symbol} earnings`,
    source_key: `finnhub:${symbol}:2026-08-06`,
    fetched_at: "2026-08-01 00:00:00",
    created_at: "2026-08-01 00:00:00",
    description: null,
    expected_impact: null,
    consensus_estimate: "EPS 1.42 · Rev $10.5B",
    actual_value: null,
    consensus_value: null,
    previous_value: null,
    reaction_snapshot: null,
    enriched_at: null,
    symbol,
    security_id: null,
    ib_con_id: null,
    week_of: "2026-08-04",
    raw_json: null,
    event_time: null,
    release_time: "08:00 ET",
  } as CalendarEvent;
}

function makePreviewContext(symbol: string = "AAPL"): EarningsPreviewContext {
  return {
    symbol,
    family: [symbol],
    event: makeEvent(symbol),
    positions: [],
    longShares: 0,
    shortShares: 0,
    longContracts: 0,
    shortContracts: 0,
    userNotes: [],
    recentArticles: [],
    recommendationTrend: null,
    priceTarget: null,
    ratingChanges: null,
    recentPressReleases: null,
    priorTranscript: null,
    bogeys: [],
    readThroughs: [],
    priorCallNote: null,
  };
}

function makeRecapContext(symbol: string = "AAPL"): EarningsRecapContext {
  return {
    ...makePreviewContext(symbol),
    reactionSnapshotMarkdown: null,
    freshPressReleases: null,
    callNote: null,
  };
}

describe("earnings prompt prose rules — attribution + section style", () => {
  it("preview prompt references the system-rendered sheet bogeys table", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    expect(prompt).toContain("Sheet bogeys — by source");
  });

  it("preview prompt instructs to cite source labels in-cell", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    expect(prompt).toMatch(/cite the source label in-cell/i);
  });

  it("preview prompt forbids merging disagreeing sources", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    expect(prompt).toMatch(/never (silently )?merge/i);
  });

  it("preview prompt specifies section prose style (1-3 paragraphs)", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    expect(prompt).toMatch(/1[-–]3 flowing paragraphs/i);
  });

  it("preview prompt specifies bullets only for enumerable items", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    expect(prompt).toMatch(/bullets only/i);
  });

  it("preview prompt forbids filler openers", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    expect(prompt).toMatch(/no filler openers/i);
  });

  it("preview prompt specifies numbered-list format for 'What to watch on the call'", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    // The rule should specify numbered markdown list format
    expect(prompt).toMatch(/numbered markdown list/i);
  });

  it("preview prompt specifies framing-sentence rule for 'The setup'", () => {
    const prompt = renderPreviewPrompt(makePreviewContext());
    // Should open with a framing sentence in model's own words before citing
    expect(prompt).toMatch(/open with one sentence in your own words/i);
  });

  it("recap prompt carries the attribution rule", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).toMatch(/cite the source label/i);
  });

  it("recap prompt does NOT contain 'Section style (strict)' — prose style is preview-only", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).not.toContain("Section style (strict)");
    expect(prompt).not.toContain("flowing paragraphs");
  });
});

describe("recap prompt — no reaction is captured yet", () => {
  it("tells the model the reaction is not captured and not to search for it", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).toContain("Reaction snapshot not yet captured.");
    expect(prompt).toMatch(/Do NOT use web_search to find a price or a move/);
    expect(prompt).toMatch(/do not quote an after-hours price or a stock move from any source/);
    expect(prompt).not.toContain("If you can determine after-hours / immediate reaction from web_search");
  });

  it("the reaction section and the position section do not ask for a price it does not have", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).toMatch(/## The reaction\\?`\*\* — when no reaction snapshot is given above, write one line/);
    expect(prompt).not.toContain("at the reaction-snapshot price?");
  });

  it("still allows web_search for guidance and sell-side notes", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).toMatch(/Use web_search aggressively/);
    expect(prompt).toMatch(/web_search for analyst notes/);
  });

  it("with a snapshot, the prompt prints it and keeps the reaction section", () => {
    const prompt = renderRecapPrompt({
      ...makeRecapContext(),
      reactionSnapshotMarkdown: "AAPL +1.2% vs SPY +0.1%",
    });
    expect(prompt).toContain("## Market reaction (T+2h, captured automatically)");
    expect(prompt).toContain("AAPL +1.2% vs SPY +0.1%");
    expect(prompt).not.toContain("Reaction snapshot not yet captured.");
  });
});

// Sprint unit 4d: with no reaction snapshot the prompt used to open by calling
// the reader someone "who just digested the print and the immediate market
// reaction", and told the model the scoreboard shows "stock + SPY + QQQ
// reactions". Both sentences now speak of a reaction only when one was
// measured. The measured prompt must not move by a single byte.
describe("recap prompt — the intro and the scoreboard sentence follow the snapshot", () => {
  const INTRO_WITH = "who just digested the print and the immediate market reaction.";
  const SCOREBOARD_WITH =
    "(it shows EPS / Revenue / expected-vs-realized move / avg historical move / stock + SPY + QQQ reactions)";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no snapshot: the intro does not say the reaction was digested", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).not.toContain("immediate market reaction");
    expect(prompt).toContain(
      "Goal: brief him as a colleague who just digested the print. The market reaction has not been captured yet.",
    );
  });

  it("no snapshot: the scoreboard sentence does not promise reaction figures", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).not.toContain("stock + SPY + QQQ reactions");
    expect(prompt).not.toContain("expected-vs-realized move");
    expect(prompt).toContain(
      "(it shows EPS / Revenue / expected move / avg historical move; its reaction rows are blank because no reaction has been captured yet)",
    );
  });

  it("with a snapshot: both sentences read exactly as before", () => {
    const prompt = renderRecapPrompt({
      ...makeRecapContext(),
      reactionSnapshotMarkdown: "- AAPL: +1.20%\n- SPY: +0.10%",
    });
    expect(prompt).toContain(INTRO_WITH);
    expect(prompt).toContain(SCOREBOARD_WITH);
    expect(prompt).not.toContain("has not been captured yet");
  });

  it("with a snapshot: the whole prompt is byte-identical to the prompt before this change", () => {
    // The prompt prints the current year in one search hint; freeze the clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T22:00:00Z"));
    const prompt = renderRecapPrompt({
      ...makeRecapContext(),
      reactionSnapshotMarkdown: "- AAPL: +1.20%\n- SPY: +0.10%",
    });
    // sha256 of the prompt rendered by the code as it stood BEFORE unit 4d
    // (recorded by running this case against the unchanged file).
    expect(createHash("sha256").update(prompt, "utf8").digest("hex")).toBe(
      "4c14d8f52db251c88910c75b6ac79f53484252eaaa847da072c9754af6dd095d",
    );
  });

  it("the two prompts differ ONLY in those two sentences and the reaction block", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T22:00:00Z"));
    const withSnap = renderRecapPrompt({
      ...makeRecapContext(),
      reactionSnapshotMarkdown: "- AAPL: +1.20%",
    });
    const without = renderRecapPrompt(makeRecapContext());
    const rebuilt = without
      .replace(
        "who just digested the print. The market reaction has not been captured yet.",
        INTRO_WITH,
      )
      .replace(
        "(it shows EPS / Revenue / expected move / avg historical move; its reaction rows are blank because no reaction has been captured yet)",
        SCOREBOARD_WITH,
      )
      .replace(
        /\n## Market reaction\nReaction snapshot not yet captured\.[^\n]*\n/,
        "\n## Market reaction (T+2h, captured automatically)\n- AAPL: +1.20%\n",
      );
    expect(rebuilt).toBe(withSnap);
  });
});
