/**
 * URL filters that links from other pages carry:
 *   /dashboard/research?view=feeds&symbol=X      (+ &article=<id>)
 *   /dashboard/research?view=documents&symbol=X
 *   /dashboard/alerts?view=...&symbol=X
 *
 * No DOM harness in this repo: the pure helpers are run, and the wiring is
 * pinned by source (anchors throw when they vanish).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  describeFeedWindow,
  resolveLinkedArticle,
  syncCompletionFeedback,
  FEED_CAP_NOTICE,
  FEED_MAX_LIMIT,
} from "@/app/dashboard/components/ResearchFeedsView";
import { initialDocumentSymbol } from "@/app/dashboard/components/ResearchDocumentsView";
import { matchesSymbolScope, parseSymbolScope } from "@/app/dashboard/alerts/page";

const feeds = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");
const docs = readFileSync("app/dashboard/components/ResearchDocumentsView.tsx", "utf8");
const page = readFileSync("app/dashboard/research/page.tsx", "utf8");
const alerts = readFileSync("app/dashboard/alerts/page.tsx", "utf8");
const articlesRoute = readFileSync("app/api/research/articles/route.ts", "utf8");

describe("feeds: exact N of M from the route's total", () => {
  it("a search with a known total says how many matches exist", () => {
    expect(describeFeedWindow({ shown: 50, total: 120, pageLimit: 50, search: "zzz" })).toEqual({
      text: 'Showing the newest 50 of 120 matches for "zzz"',
      hasMore: true,
    });
    // A full page that IS the whole set offers nothing more.
    expect(describeFeedWindow({ shown: 50, total: 50, pageLimit: 50, search: "zzz" })).toEqual({
      text: '50 matches for "zzz"',
      hasMore: false,
    });
    expect(describeFeedWindow({ shown: 0, total: 0, pageLimit: 50, search: "zzz" }).hasMore).toBe(false);
  });

  it("never prints N of fewer-than-N under a search either", () => {
    expect(describeFeedWindow({ shown: 50, total: 40, pageLimit: 50, search: "zzz" })).toEqual({
      text: '50 matches for "zzz"',
      hasMore: false,
    });
  });

  it("the cap matches the route's, and Load more gives way to a line at the cap", () => {
    expect(articlesRoute).toContain(`const MAX_LIMIT = ${FEED_MAX_LIMIT};`);
    expect(FEED_CAP_NOTICE).toContain(String(FEED_MAX_LIMIT));
    expect(FEED_CAP_NOTICE).toMatch(/search/);
    const more = sliceBetween(feeds, "{feedWindow.hasMore && (", ")}\n        </div>");
    const capped = sliceBetween(more, "{articleLimit >= FEED_MAX_LIMIT ? (", ") : (");
    expect(capped).toContain("{FEED_CAP_NOTICE}");
    expect(capped).not.toContain("<button");
    expect(more.slice(anchorIndex(more, ") : ("))).toContain("onClick={handleLoadMoreArticles}");
  });
});

describe("feeds: symbol filter", () => {
  it("uses the route's securityId filter, so list and total share one predicate", () => {
    const refresh = sliceBetween(feeds, "const refreshArticles = useCallback(", "const refreshSourceCounts");
    expect(refresh).toContain(
      'if (symbolFilter?.securityId) params.set("securityId", String(symbolFilter.securityId));',
    );
    // An unknown symbol never falls back to the unfiltered feed.
    expect(refresh).toContain("if (symbolFilter && symbolFilter.securityId === null) return;");
    // The route hands ONE filter object to the list and the count.
    expect(articlesRoute).toContain("getRecentArticles(db, { ...filter, limit: clampLimit(limit, 50) })");
    expect(articlesRoute).toContain("countRecentArticles(db, filter)");
  });

  it("the page resolves the symbol case-insensitively and counts on the list's filter", () => {
    expect(page).toContain('const symbolParam = (params.symbol ?? "").trim().toUpperCase();');
    expect(page).toContain("getSecurityBySymbolCI(db, symbolParam)?.id ?? null");
    expect(page).toContain("feedArticles = getRecentArticles(db, { ...feedFilter, limit: 50 });");
    expect(page).toContain("feedTotal = countRecentArticles(db, feedFilter);");
    const view = sliceBetween(page, "<ResearchFeedsView", "/>");
    expect(view).toContain("key={symbolParam}");
    expect(view).toContain("symbolFilter={feedSymbolFilter}");
    expect(view).toContain("initialTotal={feedTotal}");
  });

  it("the active symbol is a visible chip whose clear button removes the URL param", () => {
    const chip = sliceBetween(feeds, "{symbolFilter && (", "{linkedRequest.kind");
    expect(chip).toContain("Symbol: {symbolFilter.symbol}");
    expect(chip).toContain('onClick={() => removeUrlParam("symbol")}');
    expect(chip).toContain("aria-label={`Clear the ${symbolFilter.symbol} symbol filter`}");
    const remove = sliceBetween(feeds, "const removeUrlParam = useCallback(", "[router, searchParams]");
    expect(remove).toContain("params.delete(name);");
    expect(remove).toContain("router.replace(");
  });
});

describe("feeds: sync status carries an account-level AI failure", () => {
  it("no failure: the usual transient line", () => {
    expect(syncCompletionFeedback(3, null)).toEqual({ text: "Done — 3 new articles", tone: "progress" });
    expect(syncCompletionFeedback(1, undefined).text).toBe("Done — 1 new article");
    expect(syncCompletionFeedback(0, "  ")).toEqual({
      text: "Up to date — no new articles",
      tone: "progress",
    });
  });

  it("a failure message is appended and sticky (error tone never auto-dismisses)", () => {
    const out = syncCompletionFeedback(2, "AI analysis stopped early: example reason.");
    expect(out.tone).toBe("error");
    expect(out.text).toBe("Done — 2 new articles. AI analysis stopped early: example reason.");
    expect(syncCompletionFeedback(0, "Example reason.").text).toBe(
      "Up to date — no new articles. Example reason.",
    );
  });

  it("the handler reads it on both the process and the complete event", () => {
    const handler = sliceBetween(feeds, "const handleSync = useCallback(", "const handleFilterChange");
    const processDone = sliceBetween(
      handler,
      'data.phase === "process" && data.status === "done"',
      'data.phase === "complete"',
    );
    expect(processDone).toContain("data.accountFailureMessage");
    expect(processDone).toContain("setSyncFeedback(errorFeedback(");
    const complete = sliceBetween(handler, 'data.phase === "complete"', 'data.phase === "error"');
    expect(complete).toContain("syncCompletionFeedback(");
    expect(complete).toContain("data.accountFailureMessage ?? accountFailure");
  });
});

describe("feeds: deep link to one article", () => {
  const row = { id: 7, processed_at: "2026-01-02 10:00:00", is_relevant: 1 };

  it("no param, or a blank one, asks for nothing", () => {
    expect(resolveLinkedArticle(null, null)).toEqual({ kind: "none" });
    expect(resolveLinkedArticle("  ", row)).toEqual({ kind: "none" });
  });

  it("an analysed article opens, filtered or not (the card carries the Filtered marker)", () => {
    expect(resolveLinkedArticle("7", row)).toEqual({ kind: "open", id: 7 });
    expect(resolveLinkedArticle("7", { ...row, is_relevant: 0 })).toEqual({ kind: "open", id: 7 });
  });

  it("a missing, malformed or not-yet-analysed article says so plainly", () => {
    const missing = resolveLinkedArticle("99", null);
    expect(missing.kind).toBe("notice");
    expect(missing.kind === "notice" && missing.text).toMatch(/Article 99 was not found/);
    const bad = resolveLinkedArticle("7abc", row);
    expect(bad.kind === "notice" && bad.text).toMatch(/not valid/);
    const queued = resolveLinkedArticle("7", { ...row, processed_at: null });
    expect(queued.kind === "notice" && queued.text).toMatch(/not been analysed by AI yet/);
    const filtered = resolveLinkedArticle("7", { ...row, processed_at: null, is_relevant: 0 });
    expect(filtered.kind === "notice" && filtered.text).toMatch(/Filtered tab/);
  });

  it("opens once on mount, scrolled to the card, pinned when not among the loaded rows", () => {
    const effect = sliceBetween(feeds, "const linkedOpenedRef = useRef(false);", "}, [linkedId]);");
    expect(effect).toContain("if (linkedId === null || linkedOpenedRef.current) return;");
    expect(effect).toContain("void handleExpand(linkedId);");
    expect(effect).toContain("document.getElementById(`feed-article-${linkedId}`)?.scrollIntoView(");
    expect(feeds).toContain("id={`feed-article-${article.id}`}");
    expect(feeds).toContain("!articles.some((a) => a.id === linkedId)");
    expect(feeds).toContain('{viewMode === "all" && pinnedArticle && (');
  });

  it("the page loads the one row and never hands the stored body to the client", () => {
    const load = sliceBetween(page, "const row = getArticleById(db, Number(articleParam));", "feedSources =");
    expect(load).not.toMatch(/raw_text|raw_html|\.\.\.row/);
    expect(load).toContain("processed_at: row.processed_at,");
    expect(load).toContain("is_relevant: row.is_relevant,");
  });
});

describe("documents: initial symbol from the URL", () => {
  it("seeds the view's one symbol filter, trimmed and upper-cased", () => {
    expect(initialDocumentSymbol(" aaa ")).toBe("AAA");
    expect(initialDocumentSymbol(null)).toBe("");
    expect(initialDocumentSymbol(undefined)).toBe("");
    expect(docs).toContain("useState(() => initialDocumentSymbol(initialSymbol))");
    // Still the one filter the fetch already had.
    expect(docs).toContain('if (symbol) params.set("symbol", symbol);');
    expect(page).toContain("<ResearchDocumentsView key={symbolParam} initialSymbol={symbolParam} />");
  });

  it("the active symbol is a visible chip; clearing empties the box and the URL param", () => {
    const clear = sliceBetween(docs, "const clearSymbol = useCallback(", "[router, searchParams]");
    expect(clear).toContain('setSymbol("");');
    expect(clear).toContain('params.delete("symbol");');
    expect(clear).toContain("router.replace(");
    const chip = sliceBetween(docs, "{symbol && (", "{loading && documents.length === 0");
    expect(chip).toContain("Symbol: {symbol}");
    expect(chip).toContain("onClick={clearSymbol}");
  });
});

describe("alerts: ?symbol= scopes the lists on screen", () => {
  it("parses the param: trimmed, upper-case, blank is no scope", () => {
    expect(parseSymbolScope(" aaa ")).toBe("AAA");
    expect(parseSymbolScope("")).toBeNull();
    expect(parseSymbolScope("   ")).toBeNull();
    expect(parseSymbolScope(null)).toBeNull();
  });

  it("matches the whole symbol, case-insensitively; no scope matches every row", () => {
    expect(matchesSymbolScope("aaa", "AAA")).toBe(true);
    expect(matchesSymbolScope(" AAA ", "AAA")).toBe(true);
    expect(matchesSymbolScope("AAAB", "AAA")).toBe(false);
    expect(matchesSymbolScope("AA", "AAA")).toBe(false);
    expect(matchesSymbolScope(null, "AAA")).toBe(false);
    expect(matchesSymbolScope(null, null)).toBe(true);
    expect(matchesSymbolScope("ZZZ", null)).toBe(true);
  });

  it("the stream, the armed list and the conflicts list are narrowed; the source lists are not", () => {
    expect(alerts).toContain('const symbolScope = parseSymbolScope(searchParams.get("symbol"));');
    const scoped = sliceBetween(alerts, "const scopedItems = useMemo<StreamItem[]>(", "const sortedItems = useMemo");
    expect(scoped).toContain("streamItems.filter(");
    expect(scoped).toContain("armedLevels.filter((l) => matchesSymbolScope(l.symbol, symbolScope))");
    expect(scoped).toContain("conflicts.filter((c) => matchesSymbolScope(c.symbol, symbolScope))");
    expect(alerts).toContain("<ArmedLevelsList levels={scopedArmedLevels} />");
    expect(alerts).toContain("<ConflictsList conflicts={scopedConflicts} onConfirmed={refresh} />");
  });

  it("no count badge changes meaning: badges read the unscoped lists", () => {
    const counts = sliceBetween(alerts, "const reviewCount =", "const isPending");
    expect(counts).toContain("const reviewCount = reviewLevels.length;");
    expect(counts).toContain("const armedCount = armedLevels.length;");
    expect(counts).toContain("const conflictCount = conflicts.length;");
    expect(alerts).toContain("const totalPending = pendingAlertCount + reviewCount;");
    // The fetches are not narrowed either.
    const refresh = sliceBetween(alerts, "const refresh = useCallback(", "}, [filter]);");
    expect(refresh).not.toContain("symbolScope");
  });

  it("a visible chip says how many of the tab's rows match, and clears through the router", () => {
    const chip = sliceBetween(alerts, "{symbolScope && (", "<SortPicker options={SORT_OPTIONS}");
    expect(chip).toContain("Symbol: {symbolScope}");
    expect(chip).toContain("onClick={clearSymbolScope}");
    expect(chip).toContain("<Count value={tabShown} /> of <Count value={tabTotal} />");
    expect(chip).toContain("Approve all still approves every pending level");
    const clear = sliceBetween(alerts, "function clearSymbolScope() {", "function selectFilter(");
    expect(clear).toContain('params.delete("symbol");');
    expect(clear).toContain("router.replace(");
    // Switching tabs keeps the symbol: only `view` is dropped.
    const select = sliceBetween(alerts, "function selectFilter(", "const refresh = useCallback(");
    expect(select).not.toContain('params.delete("symbol")');
  });
});
