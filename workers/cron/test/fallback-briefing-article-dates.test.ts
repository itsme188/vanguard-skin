/**
 * Worker briefing prompt: an article is dated by the EASTERN day it arrived.
 *
 * `received_at` is a UTC instant. Its first ten characters are the UTC date,
 * so a newsletter received at 21:00 Eastern on Thursday was labelled Friday
 * in the prompt. Both article lists (the summary list and the full-text
 * list) now label with the Worker's `etDateOfStoredUtc`. Prompt context only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FallbackEnv } from "../src/fallback-digest";
import type { Snapshot } from "../src/state";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  jsonSchema: (s: unknown) => s,
}));
vi.mock("../src/ai", () => ({
  getModelForFeature: vi.fn(() => "mock-model"),
  generateWithFailover: vi.fn(
    async (_env: unknown, _feature: unknown, _catalog: unknown, call: (model: unknown) => Promise<unknown>) =>
      call("mock-model"),
  ),
}));
vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});
vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

import { runFallbackBriefing } from "../src/fallback-briefing";
import { loadLatestSnapshot } from "../src/state";
import { generateText } from "ai";

function makeEnv(): FallbackEnv {
  return {
    CRON_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    ANTHROPIC_API_KEY: "test-key",
    BRIEFING_EMAIL_TO: "default@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "example.com",
  } as FallbackEnv;
}

/** Source 5 is not a preferred source: it lands in the summary list. */
const summaryArticle = (id: number, received_at: string, subject: string) => ({
  id,
  source_id: 5,
  source_name: "Desk Notes",
  subject,
  received_at,
  summary: `${subject} summary`,
  key_themes: null,
  sentiment: null,
  mentioned_symbols: null,
});

/** Source 1 is a preferred source: full text, the deep-read list. */
const deepArticle = (id: number, received_at: string, subject: string) => ({
  id,
  source_id: 1,
  source_name: "Morning Letter",
  subject,
  received_at,
  raw_text: `${subject} full text`,
});

async function promptFor(recentArticlesMeta: unknown[], deepReadArticles: unknown[]): Promise<string> {
  (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
    schemaVersion: 7,
    snapshotDate: "2026-11-08",
    generatedAt: "2026-11-08T07:00:00Z",
    heldSymbols: ["ZZA"],
    briefingHoldings: [{ symbol: "ZZA", name: "ZZA Corp", sector: "Technology", netQty: 10 }],
    settings: {},
    calendarEvents: [],
    researchSources: [],
    recentArticlesMeta,
    deepReadArticles,
  } as unknown as Snapshot);
  const result = await runFallbackBriefing(makeEnv());
  expect(result.kind).toBe("success");
  const calls = (generateText as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0].prompt as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({
    text: "# Week Ahead\n\nBody.",
    finishReason: "stop",
  });
});

describe("Worker briefing prompt: article dates are Eastern days", () => {
  // 02:00 UTC Friday 6 November is 21:00 Eastern Thursday 5 November.
  it("summary list: an article received at 21:00 Eastern Thursday is dated Thursday, in both stored forms", async () => {
    const prompt = await promptFor(
      [
        summaryArticle(1, "2026-11-06T02:00:00.000Z", "ISOFORM evening"),
        summaryArticle(2, "2026-11-06 02:00:00", "SPACEFORM evening"),
      ],
      [],
    );
    expect(prompt).toContain("[2026-11-05] Desk Notes: ISOFORM evening");
    expect(prompt).toContain("[2026-11-05] Desk Notes: SPACEFORM evening");
    expect(prompt).not.toContain("[2026-11-06]");
  });

  it("full-text list: the same evening article is dated Thursday", async () => {
    const prompt = await promptFor([], [deepArticle(1, "2026-11-06T02:00:00.000Z", "DEEP evening")]);
    expect(prompt).toContain("### Morning Letter — 2026-11-05: DEEP evening");
    expect(prompt).not.toContain("2026-11-06: DEEP evening");
  });

  it("a daytime article keeps the date it always had", async () => {
    const prompt = await promptFor(
      [summaryArticle(1, "2026-11-05T15:00:00.000Z", "MIDDAY")],
      [deepArticle(2, "2026-11-05 15:00:00", "DEEP midday")],
    );
    expect(prompt).toContain("[2026-11-05] Desk Notes: MIDDAY");
    expect(prompt).toContain("### Morning Letter — 2026-11-05: DEEP midday");
  });

  it("summer time: 03:30 UTC is 23:30 Eastern the day before", async () => {
    const prompt = await promptFor([summaryArticle(1, "2026-07-10T03:30:00.000Z", "SUMMER late")], []);
    expect(prompt).toContain("[2026-07-09] Desk Notes: SUMMER late");
  });

  it("an unreadable timestamp keeps its first ten characters, as before", async () => {
    const prompt = await promptFor([summaryArticle(1, "2026-11-06 garbled", "ODD stamp")], []);
    expect(prompt).toContain("[2026-11-06] Desk Notes: ODD stamp");
  });
});
