/**
 * POST /api/research/sync: when the AI pass left articles queued because of
 * an ACCOUNT-level failure (out of credit, bad key, rate limit, outage, no
 * connection: lib/gmail/enrichment-failure.ts decides), the stream says so in
 * plain words. The route only reads what processUnprocessedArticles returns
 * (`deferred`); it does not classify anything itself.
 *
 * Same mocking shape as tests/api/routes.test.ts. All counts are invented.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { __resetResearchSyncLockForTests } from "@/lib/research/sync-lock";

const hoisted = vi.hoisted(() => ({
  processUnprocessedArticles: vi.fn(async (): Promise<Record<string, number>> => ({ processed: 0, failed: 0, deferred: 0 })),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/alerts/extract-newsletter-levels", () => ({
  extractLevelsFromNewArticles: vi.fn(async () => ({ articlesScanned: 0, levelsInserted: 0, levelsSkipped: 0 })),
}));
vi.mock("@/lib/earnings/extract-newsletter-bogeys", () => ({
  extractBogeysFromNewArticles: vi.fn(async () => ({ articlesScanned: 0, bogeysStored: 0, eventsMatched: 0 })),
}));
vi.mock("@/lib/gmail/auth", () => ({
  isGmailConfigured: vi.fn(() => true),
  getGmailClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/gmail/fetch", () => ({
  fetchNewArticles: vi.fn(async () => ({ fetched: 0, sources: [] })),
  backfillArticleHtml: vi.fn(async () => ({ updated: 0 })),
  backfillSourceUrls: vi.fn(() => 0),
}));
vi.mock("@/lib/gmail/process", () => ({
  processUnprocessedArticles: hoisted.processUnprocessedArticles,
}));
vi.mock("@/lib/research/reconcile-cloud-fetched", () => ({
  reconcileCloudFetchedNewsletters: vi.fn(async () => ({ reconciled: 0, skipped_already_in_db: 0 })),
  postMacRecentNewsletterSyncMarker: vi.fn(async () => undefined),
}));

type SyncEvent = Record<string, unknown> & { phase: string; status?: string };

async function runSync(): Promise<SyncEvent[]> {
  const mod = await import("@/app/api/research/sync/route");
  const res = await mod.POST(new NextRequest("http://localhost/api/research/sync", { method: "POST" }));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text
    .split("\n\n")
    .map((frame) => frame.match(/^data: (.+)$/m)?.[1])
    .filter((json): json is string => json !== undefined)
    .map((json) => JSON.parse(json) as SyncEvent);
}

const processDone = (events: SyncEvent[]) => events.find((e) => e.phase === "process" && e.status === "done")!;
const complete = (events: SyncEvent[]) => events.find((e) => e.phase === "complete")!;

beforeEach(() => {
  __resetResearchSyncLockForTests();
  hoisted.processUnprocessedArticles.mockReset();
  delete process.env.CRON_SHARED_SECRET;
});

describe("POST /api/research/sync: account-level AI failure", () => {
  it("a pass that stopped on two account-level failures names the AI account, not the articles", async () => {
    hoisted.processUnprocessedArticles.mockResolvedValue({ processed: 0, failed: 2, deferred: 2 });

    const events = await runSync();
    const done = processDone(events);

    expect(done).toMatchObject({ processed: 0, failed: 2, deferred: 2, stoppedOnAccountFailure: true });
    const message = done.accountFailureMessage as string;
    expect(message).toMatch(/stopped early/);
    expect(message).toMatch(/AI service/);
    expect(message).toMatch(/out of credit/);
    expect(message).toMatch(/API key/);
    expect(message).toMatch(/connect/);
    expect(message).toMatch(/Nothing is wrong with the articles/);
    expect(message).toMatch(/next sync/);
    // The closing event carries it too: the client's last line is the one that stays on screen.
    expect(complete(events).accountFailureMessage).toBe(message);
  });

  it("one deferred article is reported without claiming the pass stopped", async () => {
    hoisted.processUnprocessedArticles.mockResolvedValue({ processed: 0, failed: 1, deferred: 1 });

    const done = processDone(await runSync());

    expect(done).toMatchObject({ deferred: 1, stoppedOnAccountFailure: false });
    expect(done.accountFailureMessage).toMatch(/^1 article was not analysed/);
    expect(done.accountFailureMessage).not.toMatch(/stopped early/);
    expect(done.accountFailureMessage).toMatch(/Nothing is wrong with the article\b/);
  });

  it("ordinary article failures carry no account message", async () => {
    hoisted.processUnprocessedArticles.mockResolvedValue({ processed: 3, failed: 2, deferred: 0 });

    const events = await runSync();

    expect(processDone(events)).toMatchObject({ processed: 3, failed: 2, deferred: 0, stoppedOnAccountFailure: false });
    expect(processDone(events).accountFailureMessage).toBeNull();
    expect(complete(events).accountFailureMessage).toBeNull();
  });

  it("a result with no deferred count reads as none deferred", async () => {
    hoisted.processUnprocessedArticles.mockResolvedValue({ processed: 1, failed: 0 });

    const done = processDone(await runSync());

    expect(done).toMatchObject({ processed: 1, failed: 0, deferred: 0 });
    expect(done.accountFailureMessage).toBeNull();
  });
});
