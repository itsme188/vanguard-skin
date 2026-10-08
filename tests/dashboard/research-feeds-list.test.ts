/**
 * Research -> Feeds list: the filtered marker, the Unfilter message, the
 * "N of M" line with Load more, the source filter, and the card controls.
 *
 * No DOM harness in this repo: the pure helpers are tested directly and the
 * wiring is pinned by source (anchors throw when they vanish).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  describeFeedWindow,
  describeUnfilterOutcome,
  feedTotalForSource,
  filteredMarkerText,
  isSelectableSource,
  resolveFilteredCategoryLabel,
  sourceOptionLabel,
  visibleSymbols,
  SEARCH_TOO_SHORT_HINT,
} from "@/app/dashboard/components/ResearchFeedsView";
import { widerContentWidth } from "@/app/dashboard/components/NewsletterArticleFrame";
import type { ResearchSource } from "@/lib/queries/research";

const view = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");
const frame = readFileSync("app/dashboard/components/NewsletterArticleFrame.tsx", "utf8");
const card = sliceBetween(view, "function ArticleCard({", "// ── Filtered audit list (D5)");

function source(over: Partial<ResearchSource>): ResearchSource {
  return {
    id: 1,
    name: "AAA Letter",
    sender_email: null,
    sender_pattern: null,
    subject_pattern: null,
    is_active: 1,
    fetch_frequency: "daily",
    max_age_days: 30,
    processing_prompt: null,
    website_url: null,
    allow_off_topic: null,
    earnings_rank: null,
    earnings_note: null,
    created_at: "2026-01-01 00:00:00",
    article_count: 0,
    processed_article_count: 0,
    ...over,
  };
}

describe("filtered marker on an All-articles card", () => {
  it("a filtered article is marked with the Filtered tab's own reason text", () => {
    for (const category of ["off_topic", "receipt", "enrichment_failed", "some_new_category"]) {
      expect(filteredMarkerText({ is_relevant: 0, excluded_category: category })).toBe(
        `Filtered: ${resolveFilteredCategoryLabel(category)}`,
      );
    }
    // The Filtered tab buckets a missing category as "other"; so does the marker.
    expect(filteredMarkerText({ is_relevant: 0, excluded_category: null })).toBe("Filtered: Other");
  });

  it("a normal article, or a row with no relevance data, gets no marker", () => {
    expect(filteredMarkerText({ is_relevant: 1, excluded_category: null })).toBeNull();
    expect(filteredMarkerText({ is_relevant: null })).toBeNull();
    expect(filteredMarkerText({})).toBeNull();
  });

  it("the card renders it as a warn Chip: always visible, small-text contrast tone", () => {
    const marker = sliceBetween(card, "{filteredMarker && (", ")}");
    expect(marker).toContain('<Chip tone="warn" size="xs"');
    expect(marker).toContain("{filteredMarker}");
    expect(marker).not.toMatch(/opacity-0|group-hover|hover:/);
    expect(card).toContain("const filteredMarker = filteredMarkerText(article);");
    // One label table: the marker goes through the Filtered tab's resolver.
    const helper = sliceBetween(view, "export function filteredMarkerText(", "\n}\n");
    expect(helper).toContain("resolveFilteredCategoryLabel(");
    // Chip's warn tone is the theme-aware small-text token, not raw amber.
    const chip = readFileSync("app/dashboard/components/Chip.tsx", "utf8");
    expect(chip).toContain('warn: "bg-warn/20 text-warn"');
  });
});

describe("Unfilter says where the article went", () => {
  it("a never-analysed article: in neither list until a sync analyses it", () => {
    const o = describeUnfilterOutcome(null);
    expect(o.tone).toBe("info");
    expect(o.text).toMatch(/not been analysed by AI yet/);
    expect(o.text).toMatch(/not in All articles either/);
    expect(o.text).toMatch(/next feed sync/);
    expect(o.text).toMatch(/Sync Feeds/);
  });

  it("an analysed article: back in All articles, no talk of a later sync", () => {
    const o = describeUnfilterOutcome("2026-01-02 10:00:00");
    expect(o.tone).toBe("success");
    expect(o.text).toMatch(/back in All articles/);
    expect(o.text).not.toMatch(/sync/i);
  });

  it("the success path toasts the outcome and clears the marker on the loaded card", () => {
    const handler = sliceBetween(
      view,
      "const releaseFilteredArticle = useCallback(",
      "const handleLoadMoreFiltered = useCallback(",
    );
    const success = handler.slice(anchorIndex(handler, "if (result.data.data?.requeued) {"));
    expect(success).toContain("const outcome = describeUnfilterOutcome(removed?.processed_at ?? null);");
    expect(success).toContain("toast(outcome.text, outcome.tone);");
    expect(success).toContain("{ ...a, is_relevant: 1, excluded_category: null }");
    // A re-queued article is unprocessed again: its card leaves the main list.
    const requeued = sliceBetween(success, "if (result.data.data?.requeued) {", "return;");
    expect(requeued).toContain("setArticles((prev) => prev.filter((a) => a.id !== articleId));");
  });
});

describe("the N of M line and Load more", () => {
  it("names the cap when the list is shorter than the set", () => {
    expect(describeFeedWindow({ shown: 50, total: 2000, pageLimit: 50, search: "" })).toEqual({
      text: "Showing the newest 50 of 2,000 articles",
      hasMore: true,
    });
  });

  it("a fully loaded set states its size and offers nothing more", () => {
    expect(describeFeedWindow({ shown: 12, total: 12, pageLimit: 50, search: "" })).toEqual({
      text: "12 articles",
      hasMore: false,
    });
    expect(describeFeedWindow({ shown: 1, total: 1, pageLimit: 50, search: "" }).text).toBe("1 article");
  });

  it("never prints N of fewer-than-N when the count is older than the list", () => {
    expect(describeFeedWindow({ shown: 50, total: 40, pageLimit: 50, search: "" })).toEqual({
      text: "50 articles",
      hasMore: false,
    });
  });

  it("a search names the query the list reflects; a full page means older matches may exist", () => {
    expect(describeFeedWindow({ shown: 50, total: null, pageLimit: 50, search: "zzz" })).toEqual({
      text: 'Showing the newest 50 matches for "zzz"',
      hasMore: true,
    });
    expect(describeFeedWindow({ shown: 3, total: null, pageLimit: 50, search: "zzz" })).toEqual({
      text: '3 matches for "zzz"',
      hasMore: false,
    });
    expect(describeFeedWindow({ shown: 1, total: null, pageLimit: 50, search: "zzz" }).text).toBe('1 match for "zzz"');
  });

  it("the total is the per-source feed counts for the current selection", () => {
    const sources = [
      source({ id: 1, processed_article_count: 30 }),
      source({ id: 2, processed_article_count: 7, is_active: 0 }),
    ];
    expect(feedTotalForSource(sources, null)).toBe(37);
    expect(feedTotalForSource(sources, 2)).toBe(7);
    expect(feedTotalForSource(sources, 99)).toBe(0);
  });

  it("the list renders the line and a Load more that re-reads one page longer", () => {
    expect(view).toContain("{feedWindow.text}");
    const more = sliceBetween(view, "{feedWindow.hasMore && (", ")}\n        </div>");
    expect(more).toContain("onClick={handleLoadMoreArticles}");
    const handler = sliceBetween(view, "const handleLoadMoreArticles = useCallback(", "const handleSourcesChanged");
    expect(handler).toContain("await refreshArticles({ limit: articleLimit + FEED_PAGE_SIZE });");
    expect(handler).toContain("Couldn't load more articles.");
    // A new source or search starts again at one page.
    expect(view).toContain("await refreshArticles({ sourceId: id, limit: FEED_PAGE_SIZE });");
    expect(view).toContain("await refreshArticles({ search: query, limit: FEED_PAGE_SIZE });");
    // The total is the route's own count (exact under a search too); the
    // per-source counts are the fallback only when no search or symbol narrows.
    expect(view).toContain(
      "total: feedTotal ?? (appliedSearch || symbolFilter ? null : feedTotalForSource(currentSources, sourceFilter)),",
    );
    expect(view).toContain('setFeedTotal(typeof data.total === "number" ? data.total : null);');
  });
});

describe("source filter", () => {
  it("a deactivated source that still owns feed articles stays selectable", () => {
    expect(isSelectableSource(source({ is_active: 0, processed_article_count: 4 }))).toBe(true);
    expect(isSelectableSource(source({ is_active: 1, processed_article_count: 1 }))).toBe(true);
  });

  it("a source with nothing the feed can show is not offered", () => {
    expect(isSelectableSource(source({ is_active: 1, article_count: 9, processed_article_count: 0 }))).toBe(false);
    expect(isSelectableSource(source({ processed_article_count: undefined }))).toBe(false);
  });

  it("the option shows the feed count and labels an inactive source", () => {
    expect(sourceOptionLabel(source({ article_count: 300, processed_article_count: 299 }))).toBe("AAA Letter (299)");
    expect(sourceOptionLabel(source({ is_active: 0, processed_article_count: 4 }))).toBe("AAA Letter (4) (inactive)");
    const select = sliceBetween(view, 'aria-label="Filter by source"', "</select>");
    expect(select).toContain(".filter(isSelectableSource)");
    expect(select).toContain("{sourceOptionLabel(s)}");
    expect(select).not.toContain("s.article_count");
  });
});

describe("symbols on a card", () => {
  const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];

  it("a collapsed card shows six and counts the rest", () => {
    expect(visibleSymbols(symbols, false)).toEqual({ shown: symbols.slice(0, 6), hidden: 2 });
    expect(visibleSymbols(symbols.slice(0, 6), false).hidden).toBe(0);
  });

  it("an expanded card shows every symbol, so +N more resolves", () => {
    expect(visibleSymbols(symbols, true)).toEqual({ shown: symbols, hidden: 0 });
    expect(card).toContain("showAll={expanded}");
  });
});

describe("opening and closing a card", () => {
  it("the title is a real button with aria-expanded that toggles in both states", () => {
    const title = sliceBetween(card, "<h3 ", "</h3>");
    expect(title).toContain('type="button"');
    expect(title).toContain("aria-expanded={expanded}");
    expect(title).toContain("e.stopPropagation();");
    expect(title).toContain("if (expanded) collapse();");
    expect(title).toContain("else onToggle();");
    expect(title).toContain("focus-visible:outline-2");
  });

  it("an expanded card has a Collapse control at the top as well as the bottom", () => {
    const meta = card.slice(0, anchorIndex(card, "<h3 "));
    const top = sliceBetween(meta, "{expanded && (", ")}");
    expect(top).toContain("onClick={collapse}");
    expect(top).toContain("Collapse");
    expect(card.match(/onClick=\{collapse\}/g)).toHaveLength(2);
  });

  it("collapsing brings the closed card back into view when its top is above the screen", () => {
    const collapse = sliceBetween(card, "const collapse = () => {", "};\n  const filteredMarker");
    expect(collapse).toContain("onToggle();");
    expect(collapse).toContain("el.getBoundingClientRect().top < 0");
    expect(collapse).toContain('el.scrollIntoView({ block: "start" })');
    expect(card).toContain("ref={cardRef}");
  });
});

describe("toolbar and search", () => {
  const toolbar = sliceBetween(view, "<ScrollFade className=", "</ScrollFade>");

  it("the action row is inside ScrollFade and its labels do not wrap", () => {
    expect(toolbar).toContain('scrollerClassName="scrollbar-none"');
    expect(toolbar).toContain('className="flex items-center gap-2 whitespace-nowrap');
    expect(toolbar).toContain("Sync Feeds");
    expect(toolbar).toContain(">Email</span>");
  });

  it("every toolbar button has a name that survives its label being hidden on a phone", () => {
    const buttons = toolbar.split("<button").slice(1).map((b) => b.slice(0, b.indexOf(">\n")));
    expect(buttons).toHaveLength(5);
    for (const b of buttons) expect(b).toMatch(/title=|aria-label=/);
    expect(toolbar).toContain('aria-label="Manage sources"');
  });

  it("a one-character search says the list has not changed", () => {
    expect(SEARCH_TOO_SHORT_HINT).toMatch(/at least 2 characters/);
    const hint = sliceBetween(view, "{searchQuery.length === 1 && (", ")}");
    expect(hint).toContain("{SEARCH_TOO_SHORT_HINT}");
    expect(hint).toContain('role="status"');
    // A background refresh while one character is typed re-reads the search
    // the list already reflects; it never sends the single character.
    const refresh = sliceBetween(view, "const refreshArticles = useCallback(", "const refreshSourceCounts");
    expect(refresh).toContain("const q = typed.length === 1 ? appliedSearch : typed;");
    expect(refresh).toContain("setAppliedSearch(q);");
  });
});

describe("article reader frame", () => {
  it("newsletter HTML is only ever rendered in the sandboxed, script-less iframe", () => {
    expect(view).not.toContain("dangerouslySetInnerHTML={");
    expect(frame).not.toContain("dangerouslySetInnerHTML={");
    expect(card).toContain("<NewsletterArticleFrame html={expandedHtml} />");
    const sandbox = sliceBetween(frame, 'sandbox="', '"');
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(frame).toContain("srcDoc={srcDoc}");
  });

  it("a wider-than-column email widens the frame inside ScrollFade instead of scrolling inside it", () => {
    expect(widerContentWidth(604, 352)).toBe(604);
    expect(widerContentWidth(352, 352)).toBeNull();
    expect(widerContentWidth(353, 352)).toBeNull();
    const render = frame.slice(anchorIndex(frame, "export function NewsletterArticleFrame("));
    expect(sliceBetween(render, "<ScrollFade>", "</ScrollFade>")).toContain("minWidth: contentWidth ?? undefined");
  });
});
