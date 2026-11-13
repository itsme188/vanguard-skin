/**
 * Mention verification cut off at the output cap (2026-11-13).
 *
 * The installed app logged "[verify-mentions] Haiku verification failed: No
 * object generated" 216 times since 2026-08-05: the verdict list (one entry
 * with a free-text reason per candidate) did not fit the old 1,024-token cap,
 * and since the cheap tier reached a thinking-by-default model the thinking
 * counts against that cap too. The call now asks for 16,000, and a reply that
 * stopped at the cap is a failure even when its text parses: verification
 * then returns null and the caller keeps the word-boundary set (no article
 * attempt is used; the article is still enriched).
 *
 * Only the network is replaced; the real gateway and AI SDK build the result.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { verifyMentions, verifyMentionsWithHaiku } from "@/lib/research/verify-mentions";
import { anthropicMessage } from "../helpers/ai-sdk-real-errors";

const VERDICTS = JSON.stringify({
  verdicts: [{ symbol: "ZZAA", keep: false, reason: "generic word" }],
});

let reply: () => Response;
let bodies: Array<Record<string, unknown>>;
let errorLog: MockInstance<typeof console.error>;
let warnLog: MockInstance<typeof console.warn>;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      return reply();
    }),
  );
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  errorLog.mockRestore();
  warnLog.mockRestore();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

const CANDIDATES = [{ symbol: "ZZAA", context: "ZZAA raised its outlook." }];

describe("researchMentionVerification: a reply cut off at the output cap", () => {
  it("asks for an output cap with room for default-on thinking", async () => {
    reply = () => anthropicMessage(VERDICTS);
    const out = await verifyMentionsWithHaiku("ZZ subject", CANDIDATES);
    expect(out?.get("ZZAA")?.keep).toBe(false);
    expect(bodies[0].max_tokens).toBeGreaterThanOrEqual(16_000);
  });

  it("a reply that stopped at the cap is a failure even when its text parses", async () => {
    reply = () => anthropicMessage(VERDICTS, "max_tokens");
    expect(await verifyMentionsWithHaiku("ZZ subject", CANDIDATES)).toBeNull();
    const logged = errorLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[verify-mentions] Haiku verification failed:");
    expect(logged).toMatch(/finish reason: length/);
  });

  it("a cut-off falls back to the word-boundary set instead of dropping mentions", async () => {
    reply = () => anthropicMessage(VERDICTS.slice(0, 30), "max_tokens");
    const out = await verifyMentions(["ZZAA"], "ZZ subject", "ZZAA raised its outlook.");
    expect(out.map((o) => o.symbol)).toEqual(["ZZAA"]);
    expect(out[0].reason).toMatch(/word-boundary only/);
  });

  it("a verdict list that is not an array is a failure, not a crash", async () => {
    reply = () => anthropicMessage(JSON.stringify({ verdicts: "ZZAA" }));
    expect(await verifyMentionsWithHaiku("ZZ subject", CANDIDATES)).toBeNull();
  });
});
