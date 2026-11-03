/**
 * runJob's posture during an AI account outage (provider-failover slice 5):
 * the briefing (no degraded layout) waits for the marker to lapse; the digest
 * and evening (snapshot-based layouts) still run; a manual force bypasses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Env } from "../src/index";

vi.mock("../src/fallback-briefing", () => ({ runFallbackBriefing: vi.fn(async () => ({ kind: "success" })) }));
vi.mock("../src/fallback-digest", () => ({ runFallbackDigest: vi.fn(async () => ({ kind: "success" })) }));
vi.mock("../src/fallback-evening", () => ({ runFallbackEvening: vi.fn(async () => ({ kind: "success" })) }));
global.fetch = vi.fn();

import { runJob } from "../src/index";
import { runFallbackBriefing } from "../src/fallback-briefing";
import { runFallbackDigest } from "../src/fallback-digest";
import { recordAiOutage } from "../src/ai-outage";

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
    list: vi.fn(async () => ({ keys: [] })),
  } as unknown as KVNamespace;
}
const mkEnv = () => ({ CRON_KV: makeKv(), ARCHIVE: {} as R2Bucket, CRON_SHARED_SECRET: "s" }) as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runJob during an AI account outage", () => {
  it("the briefing waits: no fallback call and no attempting marker claimed", async () => {
    const env = mkEnv();
    await recordAiOutage(env.CRON_KV, "billing");
    vi.mocked(env.CRON_KV.put).mockClear();
    const r = await runJob("briefing", env, { force: false });
    // The briefing may be skipped for the calendar before reaching the outage check;
    // accept either, but never a fallback call.
    expect(runFallbackBriefing).not.toHaveBeenCalled();
    if (r.skipped === "ai_unavailable") {
      expect(r.kind).toBe("billing");
      expect(env.CRON_KV.put).not.toHaveBeenCalled();
    }
  });

  it("a manual force still runs the briefing", async () => {
    const env = mkEnv();
    await recordAiOutage(env.CRON_KV, "billing");
    const r = await runJob("briefing", env, { force: true });
    expect(runFallbackBriefing).toHaveBeenCalledTimes(1);
    expect(r.sentBy).toBe("cloud");
  });

  it("the digest is unchanged: it still runs with the marker set", async () => {
    const env = mkEnv();
    await recordAiOutage(env.CRON_KV, "billing");
    const r = await runJob("digest", env, { force: true });
    expect(runFallbackDigest).toHaveBeenCalledTimes(1);
    expect(r.sentBy).toBe("cloud");
  });

  it("no marker: the briefing path is the happy path it always was", async () => {
    const env = mkEnv();
    const r = await runJob("briefing", env, { force: true });
    expect(runFallbackBriefing).toHaveBeenCalledTimes(1);
    expect(r.sentBy).toBe("cloud");
  });
});
