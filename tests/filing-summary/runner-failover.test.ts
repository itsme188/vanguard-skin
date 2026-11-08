/**
 * Filing summary + provider failover (owner ruling 2026-11-03, option a): ONLY a
 * classified account-level failure of the pinned model, and only for an enabled
 * feature, is retried on the fallback leg; the sheet records the model that
 * actually ran; the switch lands in ai_failover_log; everything else parks or
 * counts exactly as before. Synthetic data only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import { setFailoverEnabledSource, setFailoverRecorder, type FailoverEvent } from "@/lib/ai/failover";
import { recordFailoverEvent, readFailoverLog } from "@/lib/mutations/ai-failover-log";
import { AI_UNAVAILABLE_REASON_PREFIX } from "@/lib/earnings/ai-unavailable";
import { runNextSection, startRun, type RunnerSeams } from "@/lib/filing-summary/runner";
import { insertFiling, listRuns, listSections, upsertDocument } from "@/lib/filing-summary/store";
import { getFullView } from "@/lib/filing-summary/view";
import { shareHeaderLine } from "@/lib/filing-summary/share-page";
import { ANTHROPIC_FAILURES, errorFromRealSdk } from "../helpers/ai-sdk-real-errors";
import type { FeatureKey } from "@/lib/ai/feature-keys";

const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5"];
const T0 = Date.parse("2026-10-22T20:30:00.000Z");
const EX991 =
  "<html><body><p>Synthetic Widgets Inc. reported third quarter results today.</p>" +
  "<p>Revenue rose sharply in the quarter.</p></body></html>";

function output() {
  return {
    headline: "Revenue beat",
    bullets: [
      {
        top: true,
        routine: false,
        claims: [
          {
            id: "c1",
            text: "Revenue rose.",
            citations: [{ id: "q1", document: "ex991.htm", quote: "Revenue rose sharply in the quarter.", isTableRow: false }],
            figures: [],
            comparisons: [],
            corrects: null,
          },
        ],
      },
    ],
  };
}

let db: Database.Database;
let eventId: number;
let files: Map<string, string>;
let events: FailoverEvent[];
let enabled: FeatureKey[];
let tokenN: number;

function seed(): number {
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings','2026-10-22','SYNW earnings','k1','SYNW')`,
      )
      .run().lastInsertRowid,
  );
  const { id } = insertFiling(db, {
    eventId, accession: "0000000001-26-000001", cik: "0000000001", form: "8-K", role: "earnings", items: "2.02",
    acceptedAt: "2026-10-22T20:05:00.000Z", discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted", identityReason: null, fetchState: "fetched",
  });
  files.set("/v/ex991.htm", EX991);
  upsertDocument(db, {
    filingId: id, fileName: "ex991.htm", docType: "EX-99.1", sequence: 1, status: "fetched",
    skipReason: null, sha256: null, byteLen: EX991.length, storedPath: "/v/ex991.htm",
  });
  const r = startRun(db, eventId, "auto", { catalogIds: CATALOG });
  if (!r.ok) throw new Error(r.reason);
  return r.runId;
}

const ok = { object: output(), usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" };

function seams(generate: () => Promise<unknown>, generateOn: RunnerSeams["generateOn"]) {
  const gen = vi.fn(generate);
  const on = vi.fn(generateOn);
  const s: Partial<RunnerSeams> = {
    generate: gen as unknown as RunnerSeams["generate"],
    generateOn: on,
    readDocument: (p: string) => files.get(p) ?? null,
    now: () => T0,
    token: () => `tok-${++tokenN}`,
    onSectionDone: async () => {},
  };
  return { s, gen, on };
}
const billing = async () => (await errorFromRealSdk(ANTHROPIC_FAILURES.billing400, { maxRetries: 0 })).error;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  files = new Map();
  tokenN = 0;
  events = [];
  enabled = ["printFilingSummary"];
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-not-real");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-not-real");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "");
  vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "");
  setModelCatalogSource(() => CATALOG);
  setFeatureModelOverrideSource(null);
  setFailoverEnabledSource(() => new Set(enabled));
  setFailoverRecorder((e) => {
    events.push(e);
    recordFailoverEvent(db, e);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setModelCatalogSource(null);
  setFailoverEnabledSource(null);
  setFailoverRecorder(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("account failure on the pinned model, failover enabled", () => {
  it("is served by the fallback leg: the section is done, records the model that ran, and the switch is logged", async () => {
    const runId = seed();
    const err = await billing();
    const { s, gen, on } = seams(async () => { throw err; }, async () => ({ object: ok.object, usage: ok.usage }));
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    expect(gen).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0][1]).toBe("gpt-6.1-sol"); // workhorse tier (2026-11-07), OpenAI first
    const sec = listSections(db, runId)[0];
    expect(sec).toMatchObject({ status: "done", attempts: 1, modelId: "gpt-6.1-sol", effort: null });
    expect(JSON.parse(sec.versionsJson ?? "{}").failover).toEqual({ provider: "openai", modelId: "gpt-6.1-sol", kind: "billing" });
    // The figure-binding checks still ran over the fallback's output.
    expect(sec.checkedJson).toBeTruthy();
    // ai_failover_log, via the same noteFailover path.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature: "printFilingSummary", kind: "billing", to: { provider: "openai" } });
    expect(readFailoverLog(db)[0]).toMatchObject({ feature: "printFilingSummary", to: "openai" });
  });

  it("the sheet says which model wrote it: view label, banner, and no invented effort", async () => {
    seed();
    const err = await billing();
    const { s } = seams(async () => { throw err; }, async () => ({ object: ok.object, usage: ok.usage }));
    await runNextSection(db, eventId, s);
    const view = getFullView(db, eventId, CATALOG);
    const run = view!.runs[0];
    expect(run.ranOn).toBe("OpenAI gpt-6.1-sol");
    expect(run.fallbackNote).toMatch(/Anthropic was unavailable \(credit or spend limit\).*OpenAI gpt-6\.1-sol/);
    expect(run.sections[0].ranOn).toBe("OpenAI gpt-6.1-sol");
    expect(shareHeaderLine(view!, run)).toContain("OpenAI gpt-6.1-sol");
    expect(shareHeaderLine(view!, run)).not.toMatch(/Sonnet 5\.5 high/);
  });
});

describe("everything else behaves as before", () => {
  it("not enabled: parks as AI-unavailable with no attempt spent, no fallback call", async () => {
    enabled = [];
    const runId = seed();
    const err = await billing();
    const { s, on } = seams(async () => { throw err; }, async () => ({ object: ok.object, usage: ok.usage }));
    await runNextSection(db, eventId, s);
    expect(on).not.toHaveBeenCalled();
    const sec = listSections(db, runId)[0];
    expect(sec).toMatchObject({ status: "pending", attempts: 0, errorClass: "model_error" });
    expect(sec.errorText?.startsWith(AI_UNAVAILABLE_REASON_PREFIX)).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("a request-level failure does not switch: it counts an attempt as always", async () => {
    const runId = seed();
    const tooLong = (await errorFromRealSdk(ANTHROPIC_FAILURES.promptTooLong400, { maxRetries: 0 })).error;
    const { s, on } = seams(async () => { throw tooLong; }, async () => ({ object: ok.object, usage: ok.usage }));
    await runNextSection(db, eventId, s);
    expect(on).not.toHaveBeenCalled();
    expect(listSections(db, runId)[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("a rate limit does not switch: free wait on the same provider", async () => {
    const runId = seed();
    const rl = (await errorFromRealSdk(ANTHROPIC_FAILURES.rateLimit429, { maxRetries: 0 })).error;
    const { s, on } = seams(async () => { throw rl; }, async () => ({ object: ok.object, usage: ok.usage }));
    await runNextSection(db, eventId, s);
    expect(on).not.toHaveBeenCalled();
    expect(listSections(db, runId)[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("every leg down: parks exactly as today (free wait), nothing recorded", async () => {
    const runId = seed();
    const err = await billing();
    const { s, on } = seams(async () => { throw err; }, async () => { throw await billing(); });
    await runNextSection(db, eventId, s);
    expect(on).toHaveBeenCalledTimes(1);
    const sec = listSections(db, runId)[0];
    expect(sec).toMatchObject({ status: "pending", attempts: 0 });
    expect(sec.errorText?.startsWith(AI_UNAVAILABLE_REASON_PREFIX)).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("no leg configured: parks as today without calling the fallback", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const runId = seed();
    const err = await billing();
    const { s, on } = seams(async () => { throw err; }, async () => ({ object: ok.object, usage: ok.usage }));
    await runNextSection(db, eventId, s);
    expect(on).not.toHaveBeenCalled();
    expect(listSections(db, runId)[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("a fallback that returns unusable output is not a pass: the attempt counts and the section retries", async () => {
    const runId = seed();
    const err = await billing();
    const { s } = seams(async () => { throw err; }, async () => ({ object: { nonsense: true }, usage: {} }));
    await runNextSection(db, eventId, s);
    expect(listSections(db, runId)[0]).toMatchObject({ status: "pending", attempts: 1, errorClass: "invalid_output" });
  });

  it("a primary success never touches the fallback and records the pinned model and effort", async () => {
    const runId = seed();
    const { s, on } = seams(async () => ok, async () => ({ object: ok.object, usage: ok.usage }));
    await runNextSection(db, eventId, s);
    expect(on).not.toHaveBeenCalled();
    const sec = listSections(db, runId)[0];
    expect(sec).toMatchObject({ status: "done", modelId: "claude-sonnet-5-5", effort: "high" });
    expect(JSON.parse(sec.versionsJson ?? "{}").failover).toBeUndefined();
    expect(getFullView(db, eventId, CATALOG)!.runs[0].ranOn).toBeNull();
  });
});
