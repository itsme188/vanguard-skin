/**
 * Filtered tab: "Enrichment failed" rows offer Retry enrichment, and both
 * Retry and Unfilter give honest feedback.
 *
 * Finding: research-feeds--billing-outage-burned-enrich-retry-cap-no-retry-when-credit-returns.
 * No DOM harness in this repo, so these are source pins (anchors throw when
 * they vanish). The behaviour behind the routes is tested for real in
 * tests/mutations/research-articles-requeue.test.ts and
 * tests/gmail/enrichment-account-level-failure.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const view = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");
const retryRoute = readFileSync("app/api/research/articles/[id]/retry-enrichment/route.ts", "utf8");
const unfilterRoute = readFileSync("app/api/research/articles/[id]/unfilter/route.ts", "utf8");

describe("Filtered row action", () => {
  const row = view.slice(anchorIndex(view, "function FilteredArticleRow({"));

  it("an enrichment_failed row gets Retry enrichment; every other row keeps Unfilter", () => {
    expect(row).toContain("const enrichmentFailed = article.excluded_category === ENRICHMENT_FAILED_CATEGORY;");
    expect(view).toContain('const ENRICHMENT_FAILED_CATEGORY = "enrichment_failed";');

    const branch = sliceBetween(row, "{enrichmentFailed ? (", "</button>\n      )}");
    const [retrySide, unfilterSide] = branch.split(") : (");
    expect(retrySide).toContain("onClick={() => onRetryEnrichment(article.id)}");
    expect(retrySide).toContain("Retry enrichment");
    expect(retrySide).not.toContain("onUnfilter(");
    expect(unfilterSide).toContain("onClick={() => onUnfilter(article.id)}");
    expect(unfilterSide).toContain("Unfilter");
    expect(unfilterSide).not.toContain("onRetryEnrichment(");
  });

  it("the action is a real button with visible text (no hover-only affordance, no caret glyph)", () => {
    const branch = sliceBetween(row, "{enrichmentFailed ? (", "</button>\n      )}");
    expect(branch.match(/<button\n\s+type="button"/g)).toHaveLength(2);
    expect(branch).not.toMatch(/opacity-0|group-hover|[▾▸▼▲⌄›»]/);
    expect(branch).not.toMatch(/text-ink-(?:dim|faint)\/\d/);
  });

  it("the list passes the retry handler down to each row", () => {
    const list = sliceBetween(view, "function FilteredArticlesList({", "function FilteredArticleRow({");
    expect(list).toContain("onRetryEnrichment={onRetryEnrichment}");
    expect(view).toContain("onRetryEnrichment={handleRetryEnrichment}");
  });
});

describe("the shared handler behind Unfilter and Retry", () => {
  const handler = sliceBetween(
    view,
    "const releaseFilteredArticle = useCallback(",
    "const handleLoadMoreFiltered = useCallback(",
  );

  it("each action posts to its own route", () => {
    expect(handler).toContain("apiFetch(`/api/research/articles/${articleId}/${copy.endpoint}`");
    const copy = sliceBetween(view, "const FILTERED_ROW_ACTION_COPY", "};");
    expect(copy).toContain('unfilter: { endpoint: "unfilter"');
    expect(copy).toContain('retry: { endpoint: "retry-enrichment"');
    expect(handler).toContain('releaseFilteredArticle(articleId, "unfilter")');
    expect(handler).toContain('releaseFilteredArticle(articleId, "retry")');
  });

  it("reads the response through readMutationResult, never a bare res.ok", () => {
    expect(handler).toContain("await readMutationResult<");
    expect(handler).not.toMatch(/if \(res\.ok\)/);
    expect(handler).not.toMatch(/err(?:or)?\.message/);
  });

  it("a refusal is explained in words and the list is reloaded", () => {
    const refusal = sliceBetween(handler, "if (!result.ok) {", "return;");
    expect(refusal).toContain("toast(`Couldn't ${copy.verb} the article: ${result.message} It stays in the filtered list.`, \"error\")");
    expect(refusal).toContain("setFilteredArticles(data.data ?? [])");
  });

  it("a request that never arrived restores the row, its counts, and says so", () => {
    const failure = handler.slice(anchorIndex(handler, "} catch {"));
    expect(failure).toContain("setFilteredArticles(before.articles);");
    expect(failure).toContain("setFilteredCount(before.count);");
    expect(failure).toContain("setFilteredCategoryCounts(before.categoryCounts);");
    expect(failure).toContain("networkFailureMessage(`${copy.verb} the article`)");
    // The snapshot is taken before the optimistic removal.
    expect(anchorIndex(handler, "const before = {")).toBeLessThan(
      anchorIndex(handler, "setFilteredArticles((prev) => prev.filter("),
    );
  });

  it("a re-queue tells the user where the article went and when it will be analysed", () => {
    const success = sliceBetween(handler, "if (result.data.data?.requeued) {", "} catch {");
    expect(success).toContain('toast(REQUEUED_FOR_ENRICHMENT_NOTICE, "success")');
    const notice = sliceBetween(view, "const REQUEUED_FOR_ENRICHMENT_NOTICE =", ";\n");
    expect(notice).toMatch(/Queued for enrichment/);
    expect(notice).toMatch(/next feed sync/);
    expect(notice).toMatch(/Sync Feeds/);
    expect(notice).toMatch(/fails again it comes back to this list/);
  });
});

describe("routes are thin wrappers over the mutations", () => {
  it("retry-enrichment calls retryArticleEnrichment and explains each refusal", () => {
    expect(retryRoute).toContain('import { retryArticleEnrichment } from "@/lib/mutations/research-articles";');
    expect(retryRoute).toContain("retryArticleEnrichment(db, articleId)");
    const notFound = sliceBetween(retryRoute, 'if (status === "not_found") {', "}\n");
    expect(notFound).toContain("status: 404");
    const notFailed = sliceBetween(retryRoute, 'if (status === "not_failed") {', "return Response.json({ success: true");
    expect(notFailed).toContain("status: 409");
    expect(notFailed).toContain("nothing to retry");
    expect(retryRoute).toContain("Response.json({ success: true, data: { requeued: true } })");
    // No AI call and no SQL in the route itself.
    expect(retryRoute).not.toMatch(/generateObjectForFeature|processUnprocessedArticles|\.prepare\(/);
  });

  it("unfilter reports whether the article was re-queued", () => {
    expect(unfilterRoute).toContain("unfilterArticle(db, articleId)");
    expect(unfilterRoute).toContain("Response.json({ success: true, data: { requeued: result.requeued } })");
  });
});
