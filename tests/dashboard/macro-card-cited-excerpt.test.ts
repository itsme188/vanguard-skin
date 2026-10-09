import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import {
  citedSourceHref,
  citedSourceLabel,
  droppedThemesNote,
  hasCitedExcerpt,
} from "@/app/dashboard/components/analysis/MacroOverlayCard";
import {
  MACRO_INPUTS_NOTE,
  MACRO_INPUTS_NOTE_LEGACY,
  inputsCountLabel,
  macroInputsNote,
} from "@/app/dashboard/components/analysis/MacroThemeReceiptDrawer";

// Owner ruling 2026-10-08: each theme names the input it cites and quotes it;
// the card shows the quoted sentence under the theme. No DOM harness in this
// repo: pure helpers are tested directly, the JSX is pinned by a source scan.

const CARD = readFileSync("app/dashboard/components/analysis/MacroOverlayCard.tsx", "utf8");
const DRAWER = readFileSync("app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx", "utf8");

describe("Macro card: the cited sentence under each theme", () => {
  it("a theme has a quote to show only when it carries a non-blank one", () => {
    expect(hasCitedExcerpt({ cited_excerpt: "Orders rose for a third straight quarter." })).toBe(true);
    expect(hasCitedExcerpt({ cited_excerpt: "   " })).toBe(false);
    // A theme cached before citations existed.
    expect(hasCitedExcerpt({})).toBe(false);
  });

  it("an article citation links to that one article; an event or alert has no page to open", () => {
    expect(citedSourceHref({ cited_kind: "article", cited_id: 12 })).toBe("/dashboard/research?view=feeds&article=12");
    expect(citedSourceHref({ cited_kind: "event", cited_id: 12 })).toBeNull();
    expect(citedSourceHref({ cited_kind: "alert", cited_id: 12 })).toBeNull();
    expect(citedSourceHref({ cited_kind: "article" })).toBeNull();
    expect(citedSourceHref({})).toBeNull();
  });

  it("names the source by its title, and by its kind when the title is missing", () => {
    expect(citedSourceLabel({ cited_kind: "article", cited_title: "ZZA raises its outlook" })).toBe("ZZA raises its outlook");
    expect(citedSourceLabel({ cited_kind: "event", cited_title: " CPI Release " })).toBe("CPI Release");
    expect(citedSourceLabel({ cited_kind: "article" })).toBe("cited article");
    expect(citedSourceLabel({ cited_kind: "event" })).toBe("cited calendar event");
    expect(citedSourceLabel({ cited_kind: "alert" })).toBe("cited level alert");
    expect(citedSourceLabel({})).toBe("cited source");
  });

  it("the quote renders in the theme row, after the summary, with its source", () => {
    const row = sliceBetween(CARD, "{data.themes.map((t, i) => (", "</ul>");
    const summaryAt = anchorIndex(row, "{t.summary}");
    const quoteAt = anchorIndex(row, "{t.cited_excerpt}");
    expect(quoteAt).toBeGreaterThan(summaryAt);
    const block = row.slice(anchorIndex(row, "{hasCitedExcerpt(t) && ("), anchorIndex(row, "factor: {FACTOR_LABELS"));
    expect(block).toContain("{t.cited_excerpt}");
    expect(block).toContain("citedSourceHref(t)");
    expect(block).toContain("citedSourceLabel(t)");
    // Readable at 11px: not the faintest ink.
    expect(block).toContain("text-ink-dim");
  });

  it("the AI-written summary goes through the privacy wrapper", () => {
    expect(CARD).toContain("<PrivateText>{t.summary}</PrivateText>");
  });

  it("says so when some themes were dropped by the check, and nothing when none were", () => {
    expect(droppedThemesNote(0)).toBeNull();
    expect(droppedThemesNote(undefined)).toBeNull();
    expect(droppedThemesNote(1)).toBe("1 more theme was generated but could not be verified against its source, so it is not shown.");
    expect(droppedThemesNote(2)).toBe("2 more themes were generated but could not be verified against their sources, so they are not shown.");
    expect(CARD).toContain("droppedThemesNote(data.sourceSummary?.droppedThemes)");
  });

  it("carries the route's third outcome on the response type", () => {
    expect(CARD).toMatch(/reason\?\s*:\s*"daily"\s*\|\s*"last_attempt_failed"\s*\|\s*"none_verified"/);
  });
});

describe("Macro inputs drawer describes what was sent", () => {
  it("a summary written since the ruling is described as what the model was sent", () => {
    const note = macroInputsNote({ articles: [], events: [], alerts: [], totals: { articles: 0, events: 0, alerts: 0 } });
    expect(note).toBe(MACRO_INPUTS_NOTE);
    expect(note).toMatch(/sent to the model/);
    expect(note).toMatch(/names you hold first/);
    expect(note).toMatch(/same list sits behind every theme/);
    expect(note).not.toMatch(/up to 10 of each/);
    expect(note).not.toMatch(/not recorded/);
  });

  it("an older cached summary keeps the old, still-true description", () => {
    const note = macroInputsNote({ articles: [], events: [], alerts: [] });
    expect(note).toBe(MACRO_INPUTS_NOTE_LEGACY);
    expect(note).toMatch(/up to 10 of each/);
    expect(note).toMatch(/not recorded/);
  });

  it("each section says how many were sent out of the week's total", () => {
    expect(inputsCountLabel(21, 70)).toBe("21 sent of 70 this week");
    expect(inputsCountLabel(3, 3)).toBe("3");
    expect(inputsCountLabel(10, undefined)).toBe("10");
    // A total smaller than the list is not a total: show the list length only.
    expect(inputsCountLabel(10, 4)).toBe("10");
    expect(DRAWER).toContain("inputsCountLabel(sourceSummary.articles.length, sourceSummary.totals?.articles)");
    expect(DRAWER).toContain("inputsCountLabel(sourceSummary.events.length, sourceSummary.totals?.events)");
    expect(DRAWER).toContain("inputsCountLabel(sourceSummary.alerts.length, sourceSummary.totals?.alerts)");
    expect(DRAWER).toContain("{macroInputsNote(sourceSummary)}");
  });
});
