import { describe, it, expect } from "vitest";
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

