/**
 * The earnings compose path joins the failover executor (owner directive
 * 2026-11-03: "make it automatic"). composeEarningsEmail backs the preview and
 * recap EMAILS and the in-app recap MODAL (lib/earnings/recap-modal-generate.ts
 * calls it), so wiring callClaude wires both. The real composer runs; only the
 * raw Anthropic client, the intel refresh and generateText are mocked.
 * Invented issuer and round figures: the repo is public.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { APIError } from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const { createMock, generateTextMock } = vi.hoisted(() => ({ createMock: vi.fn(), generateTextMock: vi.fn() }));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateText: generateTextMock }));
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  getRawAnthropicClient: () => ({ messages: { create: createMock } }),
}));
vi.mock("@/lib/earnings/intel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/intel")>()),
  ensureIntelForEvents: vi.fn(async () => undefined),
}));

import { composeEarningsEmail } from "@/lib/digest/send-earnings-email";
import { failOverRawSearchCall } from "@/lib/ai/raw-search-failover";
import {
  FAILOVER_PARKED,
  setFailoverDisabledSource,
  setFailoverEnabledSource,
  setFailoverRecorder,
  type FailoverEvent,
} from "@/lib/ai/failover";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { CREDIT_BALANCE_MESSAGE } from "../helpers/ai-sdk-real-errors";

function rawErr(status: number, type: string, message: string): APIError {
  return APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers()) as APIError;
}
const billing = () => rawErr(400, "invalid_request_error", CREDIT_BALANCE_MESSAGE);

let db: InstanceType<typeof Database>;
let eventId: number;
let events: FailoverEvent[];

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, title, symbol, source_key, week_of, consensus_estimate, actual_value)
         VALUES ('finnhub','earnings','2026-08-04','ZZA earnings','ZZA','finnhub:ZZA:2026-08-04','2026-08-03',
                 'EPS 1.00 · Rev 100M','EPS 1.10 · Rev 105M')`,
      )
      .run().lastInsertRowid,
  );
  createMock.mockReset();
  generateTextMock.mockReset();
  events = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-not-real");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-not-real");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "");
  vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "");
  setFeatureModelOverrideSource(null);
  setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  setFailoverEnabledSource(null);
  setFailoverDisabledSource(null);
  setFailoverRecorder((e) => events.push(e));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setFailoverDisabledSource(null);
  setFailoverRecorder(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(["preview", "recap"] as const)("%s compose", (phase) => {
  const feature = phase === "preview" ? "earningsPreview" : "earningsRecap";

  it("default state + account failure: served by OpenAI with the search tool, and logged", async () => {
    createMock.mockRejectedValueOnce(billing());
    generateTextMock.mockResolvedValueOnce({ text: "## The setup\n\nfallback body", finishReason: "stop" });
    const result = await composeEarningsEmail(db, eventId, phase);
    expect(result.markdown).toContain("fallback body");
    const call = generateTextMock.mock.calls[0][0];
    expect(call.model.modelId).toBe("gpt-6.1-sol"); // workhorse tier
    expect(Object.keys(call.tools)).toEqual(["web_search"]);
    expect(call.system).toMatch(/earnings briefings/); // the compose system prompt travels with it
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature, kind: "billing", to: { provider: "openai" } });
  });

  it("the in-app run's cancel signal reaches the fallback request (the recap modal passes one)", async () => {
    createMock.mockRejectedValueOnce(billing());
    generateTextMock.mockResolvedValueOnce({ text: "## The setup\n\nbody", finishReason: "stop" });
    const controller = new AbortController();
    await composeEarningsEmail(db, eventId, phase, { signal: controller.signal });
    const call = generateTextMock.mock.calls[0][0];
    expect(call.abortSignal).toBe(controller.signal);
    expect(call.maxRetries).toBe(0);
  });

  it("explicitly disabled: the IDENTICAL error is rethrown, no fallback call", async () => {
    setFailoverDisabledSource(() => new Set<FeatureKey>([feature]));
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    await expect(composeEarningsEmail(db, eventId, phase)).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it.each([
    ["rate limit", () => rawErr(429, "rate_limit_error", "slow")],
    ["bad request", () => rawErr(400, "invalid_request_error", "prompt is too long: 300000 tokens")],
  ])("%s does not switch", async (_n, make) => {
    const err = make();
    createMock.mockRejectedValueOnce(err);
    await expect(composeEarningsEmail(db, eventId, phase)).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("all legs down: the original error is rethrown (today's wording unchanged); only the search-capable leg is tried", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "tok");
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    generateTextMock.mockRejectedValueOnce(rawErr(401, "authentication_error", "bad key"));
    await expect(composeEarningsEmail(db, eventId, phase)).rejects.toBe(err);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("no search-capable leg configured (Cloudflare only): original error, no call without a search tool", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "tok");
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    await expect(composeEarningsEmail(db, eventId, phase)).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("an empty fallback answer parks on the original error, and primary success never touches the fallback", async () => {
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    generateTextMock.mockResolvedValueOnce({ text: "  ", finishReason: "stop" });
    await expect(composeEarningsEmail(db, eventId, phase)).rejects.toBe(err);
    createMock.mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "## The setup\n\nbody" }] });
    generateTextMock.mockClear();
    await composeEarningsEmail(db, eventId, phase);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("parked features never fail over, defaults or not", () => {
  it.each([...FAILOVER_PARKED])("%s is refused with no settings at all", async (feature) => {
    const err = billing();
    await expect(failOverRawSearchCall(feature, err, { prompt: "p", maxOutputTokens: 10 })).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("the recap modal reaches the same wiring through the shared composer", () => {
    const modal = fs.readFileSync(path.join(process.cwd(), "lib/earnings/recap-modal-generate.ts"), "utf8");
    const email = fs.readFileSync(path.join(process.cwd(), "lib/digest/send-earnings-email.ts"), "utf8");
    expect(modal).toContain("composeEarningsEmail(db, eventId, \"recap\", composeOpts)");
    expect(email).toContain("await callClaude(prompt, phase, opts.signal)");
    expect(email).toContain("failOverRawSearchCall(featureKey");
  });

  it("the other raw web-search sites stay unwired", () => {
    for (const f of ["lib/calendar/enrich-actuals.ts", "lib/calendar/macro-events.ts", "lib/etf/sector-weights.ts"]) {
      expect(fs.readFileSync(path.join(process.cwd(), f), "utf8")).not.toMatch(/raw-search-failover/);
    }
  });
});
