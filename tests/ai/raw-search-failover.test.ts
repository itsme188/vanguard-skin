/**
 * Raw-client web-search call sites joined to the failover executor
 * (raw-SDK wiring, 2026-11-03): earningsDateVerification and sectorVerification.
 * The primary is the raw @anthropic-ai/sdk client (mocked at the factory); the
 * fallback leg is the AI SDK (generateText mocked).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APIError } from "@anthropic-ai/sdk";

const { createMock, generateTextMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  generateTextMock: vi.fn(),
}));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateText: generateTextMock }));
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  getRawAnthropicClient: () => ({ messages: { create: createMock } }),
}));

import { defaultFetchDateVerdicts } from "@/lib/calendar/verify-earnings-dates";
import { defaultFetchVerdicts } from "@/lib/securities/verify-sector-tags";
import { failOverRawSearchCall } from "@/lib/ai/raw-search-failover";
import {
  FAILOVER_ELIGIBLE_CEILING,
  FAILOVER_PARKED,
  failoverTriggerKind,
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
const rateLimit = () => rawErr(429, "rate_limit_error", "slow down");
const badRequest = () => rawErr(400, "invalid_request_error", "prompt is too long: 300000 tokens");

const SITES = [
  {
    name: "verify-earnings-dates (earningsDateVerification)",
    feature: "earningsDateVerification" as const,
    openaiModel: "gpt-6.1-sol", // workhorse
    call: () => defaultFetchDateVerdicts("verify these dates"),
  },
  {
    name: "verify-sector-tags (sectorVerification)",
    feature: "sectorVerification" as const,
    openaiModel: "gpt-6-astra", // frontier
    call: () =>
      defaultFetchVerdicts([{ symbol: "ACME", name: "Acme Corp", industry: null, fund_category: null, sector: null } as never]),
  },
];

let events: FailoverEvent[] = [];
let enabled: FeatureKey[] = [];

beforeEach(() => {
  createMock.mockReset();
  generateTextMock.mockReset();
  events = [];
  enabled = ["earningsDateVerification", "sectorVerification"];
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-not-real");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-not-real");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "");
  vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "");
  setFeatureModelOverrideSource(null);
  setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  setFailoverEnabledSource(() => new Set(enabled));
  setFailoverRecorder((e) => events.push(e));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setFailoverEnabledSource(null);
  setFailoverRecorder(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("trigger classification (no second classifier)", () => {
  it("a raw SDK error reads through the shared raw classifier: billing / auth switch, nothing else", () => {
    expect(failoverTriggerKind(billing())).toBe("billing");
    expect(failoverTriggerKind(rawErr(401, "authentication_error", "invalid x-api-key"))).toBe("auth");
    expect(failoverTriggerKind(rateLimit())).toBeNull();
    expect(failoverTriggerKind(badRequest())).toBeNull();
    expect(failoverTriggerKind(rawErr(529, "overloaded_error", "Overloaded"))).toBeNull();
  });
});

describe.each(SITES)("$name", (site) => {
  it("primary success is untouched: no fallback call", async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: "text", text: "[{\"symbol\":\"ACME\"}]" }] });
    const out = await site.call();
    expect(out).toContain("ACME");
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("account failure + enabled: served by OpenAI with its web-search tool, switch recorded", async () => {
    createMock.mockRejectedValueOnce(billing());
    generateTextMock.mockResolvedValueOnce({ text: "[{\"symbol\":\"ACME\"}]", finishReason: "stop" });
    const out = await site.call();
    expect(out).toContain("ACME");
    const call = generateTextMock.mock.calls[0][0];
    expect(call.model.modelId).toBe(site.openaiModel);
    expect(Object.keys(call.tools)).toEqual(["web_search"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature: site.feature, kind: "billing", to: { provider: "openai" } });
  });

  it("not enabled: the ORIGINAL error is rethrown untouched, no fallback", async () => {
    enabled = [];
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    await expect(site.call()).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it.each([["rate limit", rateLimit], ["bad request", badRequest]])("%s does not switch", async (_n, make) => {
    const err = make();
    createMock.mockRejectedValueOnce(err);
    await expect(site.call()).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("all legs down: the original error is rethrown; the Cloudflare route is never used (no search tool)", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_WORKERS_AI_TOKEN", "tok");
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    generateTextMock.mockRejectedValueOnce(rawErr(401, "authentication_error", "bad openai key"));
    await expect(site.call()).rejects.toBe(err);
    expect(generateTextMock).toHaveBeenCalledTimes(1); // OpenAI only
    expect(events).toHaveLength(0);
  });

  it("no leg configured: the original error, no fallback call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    await expect(site.call()).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("a fallback that returns nothing or refuses parks on the original error", async () => {
    const err = billing();
    createMock.mockRejectedValueOnce(err);
    generateTextMock.mockResolvedValueOnce({ text: "  ", finishReason: "stop" });
    await expect(site.call()).rejects.toBe(err);
    createMock.mockRejectedValueOnce(err);
    generateTextMock.mockResolvedValueOnce({ text: "x", finishReason: "content-filter" });
    await expect(site.call()).rejects.toBe(err);
  });
});

describe("the ceiling holds for the shared helper", () => {
  it.each([...FAILOVER_PARKED])("%s never fails over, even if forced into the rollout set", async (feature) => {
    enabled = [...FAILOVER_PARKED, ...FAILOVER_ELIGIBLE_CEILING];
    const err = billing();
    await expect(failOverRawSearchCall(feature, err, { prompt: "p", maxOutputTokens: 100 })).rejects.toBe(err);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("scope pin: the parked raw sites are not wired", () => {
  it.each([
    "lib/calendar/enrich-actuals.ts",
    "lib/calendar/macro-events.ts",
    "lib/etf/sector-weights.ts",
    "lib/digest/send-earnings-email.ts",
    "lib/earnings/extract-bogeys.ts",
    "lib/research-documents/extract.ts",
    "lib/import/parsers/vanguard-pdf.ts",
  ])("%s does not import the raw-search failover", (file) => {
    expect(fs.readFileSync(path.join(process.cwd(), file), "utf8")).not.toMatch(/raw-search-failover/);
  });
});
