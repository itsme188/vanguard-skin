import { describe, it, expect } from "vitest";
import {
  bogeysPrintedInPrompt,
  topicWatchLines,
  type BogeyPromptFields,
} from "@/lib/earnings/bogey-prompt-entries";
import {
  renderPreviewPrompt,
  renderRecapPrompt,
  type EarningsPreviewContext,
  type EarningsRecapContext,
} from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";

/**
 * Owner ruling 2026-10-20 (TODO w5): the preview email lists the watch lines
 * that carry no number, as well as the numbered ones. They are listed in their
 * own prompt block, never as a bogey entry, so a row holding only such lines
 * still makes no bogey claim. The recap prompt is unchanged.
 */

const ID_CHINA = "11111111-1111-4111-8111-111111111111";
const ID_GM = "22222222-2222-4222-8222-222222222222";

function spec(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label,
    definition: "As reported in the release.",
    unit: "pct",
    kind: "point",
    period: "Q",
    basis: "na",
    ...extra,
  };
}

function row(specs: unknown[] | string | null): BogeyPromptFields {
  return {
    eps_consensus: null,
    eps_whisper: null,
    revenue_consensus_usd: null,
    revenue_whisper_usd: null,
    expected_move_pct: null,
    eps_consensus_vendor: null,
    segment_breakdown_json: null,
    guidance_notes: null,
    notes: null,
    extra_metrics_json: specs === null || typeof specs === "string" ? specs : JSON.stringify(specs),
  };
}

describe("topicWatchLines", () => {
  it("lists a line with no figure, with its period", () => {
    expect(topicWatchLines([row([spec(ID_CHINA, "Greater China revenue growth")])])).toEqual([
      "Greater China revenue growth (this quarter)",
    ]);
  });

  it("names the period and basis the same way the numbered lines do", () => {
    const lines = topicWatchLines([
      row([spec(ID_GM, "Gross margin", { period: "NQ_guide", kind: "range", basis: "non_gaap" })]),
    ]);
    expect(lines).toEqual(["Gross margin (next-quarter guide, non-GAAP)"]);
  });

  it("skips a line that carries a figure (it prints as a numbered line)", () => {
    expect(topicWatchLines([row([spec(ID_GM, "Gross margin", { consensus: 41.5 })])])).toEqual([]);
  });

  it("lists a line once when several sources name it", () => {
    const lines = topicWatchLines([
      row([spec(ID_CHINA, "Greater China revenue growth")]),
      row([spec(ID_CHINA, "Greater China revenue growth")]),
    ]);
    expect(lines).toEqual(["Greater China revenue growth (this quarter)"]);
  });

  it("drops a line another source gives a figure for", () => {
    const lines = topicWatchLines([
      row([spec(ID_GM, "Gross margin")]),
      row([spec(ID_GM, "Gross margin", { whisper: 42 })]),
    ]);
    expect(lines).toEqual([]);
  });

  it("lists nothing from an unreadable stored value", () => {
    expect(topicWatchLines([row("{not json"), row(null)])).toEqual([]);
  });
});

describe("a row holding only topic lines is still not a bogey entry", () => {
  it("bogeysPrintedInPrompt leaves it out", () => {
    expect(bogeysPrintedInPrompt([row([spec(ID_CHINA, "Greater China revenue growth")])])).toEqual([]);
  });
});

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

function previewCtx(topicLines?: string[]): EarningsPreviewContext {
  return {
    symbol: "NKE",
    family: ["NKE"],
    event: makeEvent("NKE"),
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
    topicWatchLines: topicLines,
  };
}

const HEADING = "## Watch lines with no bogey yet";

describe("preview prompt lists topic watch lines", () => {
  it("prints each line and asks for a table row per line", () => {
    const prompt = renderPreviewPrompt(previewCtx(["Greater China revenue growth (this quarter)"]));
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain("- Greater China revenue growth (this quarter)");
    expect(prompt).toMatch(/MUST get its own row in your "Line-by-line bogies" table/);
    expect(prompt).toMatch(/Never invent a number/);
  });

  it("makes no curated-bogeys claim when only topic lines exist", () => {
    const prompt = renderPreviewPrompt(previewCtx(["Greater China revenue growth (this quarter)"]));
    expect(prompt).not.toContain("## Bogeys (");
  });

  it("prints no block when there are no topic lines", () => {
    expect(renderPreviewPrompt(previewCtx([]))).not.toContain(HEADING);
    expect(renderPreviewPrompt(previewCtx(undefined))).not.toContain(HEADING);
  });

  it("leaves the recap prompt unchanged", () => {
    const recap: EarningsRecapContext = {
      ...previewCtx(["Greater China revenue growth (this quarter)"]),
      reactionSnapshotMarkdown: null,
      freshPressReleases: null,
      callNote: null,
    };
    expect(renderRecapPrompt(recap)).not.toContain(HEADING);
  });
});
