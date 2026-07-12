/**
 * Tests for the cloud-side level scan (Tier 4a — close Pushover-when-Mac-asleep gap).
 *
 * We test the orchestrator via mocked snapshot loader + price fetcher + push sender,
 * plus the pure `isLevelCrossed` helper for direction semantics.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isLevelCrossed, runLevelScan } from "../src/level-scan";
import type { Snapshot, SecurityLevelRow } from "../src/state";

function lvl(overrides: Partial<SecurityLevelRow> = {}): SecurityLevelRow {
  return {
    id: 1,
    security_id: 10,
    symbol: "AAPL",
    level_type: "support",
    price: 150,
    direction: "bullish",
    source: "user",
    source_author: "Me",
    expires_at: null,
    ...overrides,
  };
}

function makeSnapshot(levels: SecurityLevelRow[]): Snapshot {
  return {
    schemaVersion: 4,
    snapshotDate: "2026-05-11",
    generatedAt: "2026-05-11T02:00:00Z",
    heldSymbols: ["AAPL"],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
    securityLevels: levels,
  };
}

interface FakeKV {
  store: Map<string, string>;
  get: KVNamespace["get"];
  put: KVNamespace["put"];
  delete: KVNamespace["delete"];
  list: KVNamespace["list"];
}

function makeKV(seed: Record<string, string> = {}): FakeKV {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: (async (k: string) => store.get(k) ?? null) as any,
    put: (async (k: string, v: string) => {
      store.set(k, v);
    }) as any,
    delete: (async (k: string) => {
      store.delete(k);
    }) as any,
    list: (async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    }) as any,
  };
}

function makeEnv(seed: Record<string, string> = {}, snapshot: Snapshot | null = null) {
  const kv = makeKV(seed);
  const env: any = {
    CRON_KV: kv,
    ARCHIVE: {},
    PUSHOVER_APP_TOKEN: "t",
    PUSHOVER_USER_KEY: "u",
  };
  return { env, kv, snapshot };
}

describe("isLevelCrossed", () => {
  it("support fires when price falls to or below level", () => {
    expect(isLevelCrossed({ level_type: "support", price: 150 }, 149)).toBe(true);
    expect(isLevelCrossed({ level_type: "support", price: 150 }, 150)).toBe(true);
    expect(isLevelCrossed({ level_type: "support", price: 150 }, 151)).toBe(false);
  });

  it("entry / scale_in / stop also fire on downward cross (same semantics as Mac findCrossedLevels)", () => {
    expect(isLevelCrossed({ level_type: "entry", price: 100 }, 99)).toBe(true);
    expect(isLevelCrossed({ level_type: "scale_in", price: 100 }, 99)).toBe(true);
    expect(isLevelCrossed({ level_type: "stop", price: 100 }, 99)).toBe(true);
  });

  it("resistance fires when price rises to or above level", () => {
    expect(isLevelCrossed({ level_type: "resistance", price: 200 }, 201)).toBe(true);
    expect(isLevelCrossed({ level_type: "resistance", price: 200 }, 200)).toBe(true);
    expect(isLevelCrossed({ level_type: "resistance", price: 200 }, 199)).toBe(false);
  });

  it("exit also fires on upward cross", () => {
    expect(isLevelCrossed({ level_type: "exit", price: 250 }, 251)).toBe(true);
  });

  it("unknown level_type never fires (defensive default)", () => {
    expect(isLevelCrossed({ level_type: "unknown", price: 100 }, 50)).toBe(false);
    expect(isLevelCrossed({ level_type: "unknown", price: 100 }, 150)).toBe(false);
  });

  it("price >50% away from the level never crosses (mis-scaled level guard, mirrors Mac)", () => {
    // Real incident: SPX-scale 7100/7150 "supports" stored on SPY at ~$748.
    expect(isLevelCrossed({ level_type: "support", price: 7100 }, 748)).toBe(false);
    expect(isLevelCrossed({ level_type: "support", price: 7150 }, 748)).toBe(false);
    // Inverted scale error (level 10× too small) also suppressed.
    expect(isLevelCrossed({ level_type: "resistance", price: 75 }, 748)).toBe(false);
    // A deep-but-plausible hit inside the band still fires.
    expect(isLevelCrossed({ level_type: "stop", price: 100 }, 51)).toBe(true);
  });
});

describe("runLevelScan — gating", () => {
  it("skips when mac-recent-scan KV marker is present (Mac is alive)", async () => {
    const { env } = makeEnv({ "mac-recent-scan": "2026-05-11T16:00:00Z" });
    const result = await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([lvl()]),
      fetchPrice: async () => ({ price: 100, tMs: Date.now() }),
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
    });
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.results[0].outcome).toBe("mac_already_scanning");
  });

  it("skips cleanly when snapshot has no securityLevels (back-compat with v1-v3 snapshots)", async () => {
    const { env } = makeEnv();
    const result = await runLevelScan(env, {
      loadSnapshot: async () => ({ ...makeSnapshot([]), securityLevels: undefined }),
      fetchPrice: async () => ({ price: 100, tMs: Date.now() }),
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
    });
    expect(result.fired).toBe(0);
    expect(result.results[0].reason).toBe("no_levels_in_snapshot");
  });

  it("skips cleanly when no snapshot is found in R2", async () => {
    const { env } = makeEnv();
    const result = await runLevelScan(env, {
      loadSnapshot: async () => null,
      fetchPrice: async () => ({ price: 100, tMs: Date.now() }),
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
    });
    expect(result.fired).toBe(0);
    expect(result.results[0].reason).toBe("no_snapshot");
  });

  it("filters expired levels before scanning", async () => {
    const { env } = makeEnv();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const expired = lvl({ id: 1, expires_at: yesterday });
    const live = lvl({ id: 2, expires_at: today });
    let priceFetches = 0;
    const result = await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([expired, live]),
      fetchPrice: async () => {
        priceFetches++;
        return { price: 100, tMs: Date.now() };
      },
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
    });
    // Both expired+live point at AAPL — but expired is filtered before fetch,
    // so we still fetch AAPL once for the live level. scanned should be 1 (only live).
    expect(priceFetches).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.fired).toBe(1);
  });
});

describe("runLevelScan — fan-out", () => {
  it("fires Pushover + writes KV marker on first crossing; dedups on repeat tick", async () => {
    const { env, kv } = makeEnv();
    const supportLevel = lvl({ id: 42, level_type: "support", price: 150 });
    const sent: any[] = [];
    const snapshot = makeSnapshot([supportLevel]);

    // Price drops below level → should fire
    const r1 = await runLevelScan(env, {
      loadSnapshot: async () => snapshot,
      fetchPrice: async () => ({ price: 149.5, tMs: Date.now() }),
      sendPush: async (_env, args) => {
        sent.push(args);
        return { sent: true };
      },
      pacingMs: 0,
    });
    expect(r1.fired).toBe(1);
    expect(r1.deduped).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ symbol: "AAPL", levelType: "support", triggeredPrice: 149.5 });
    expect(kv.store.has("cloud-fired-level-42")).toBe(true);

    // Second tick — same crossing — should dedup
    const r2 = await runLevelScan(env, {
      loadSnapshot: async () => snapshot,
      fetchPrice: async () => ({ price: 149.5, tMs: Date.now() }),
      sendPush: async (_env, args) => {
        sent.push(args);
        return { sent: true };
      },
      pacingMs: 0,
    });
    expect(r2.fired).toBe(0);
    expect(r2.deduped).toBe(1);
    expect(sent).toHaveLength(1); // still 1 — no duplicate push
  });

  it("does not write KV marker in dryRun mode", async () => {
    const { env, kv } = makeEnv();
    const supportLevel = lvl({ id: 99, level_type: "support", price: 150 });
    await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([supportLevel]),
      fetchPrice: async () => ({ price: 100, tMs: Date.now() }),
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
      dryRun: true,
    });
    expect(kv.store.has("cloud-fired-level-99")).toBe(false);
  });

  it("does not fire when price is on the wrong side of the level", async () => {
    const { env } = makeEnv();
    const resistance = lvl({ id: 5, level_type: "resistance", price: 200 });
    const result = await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([resistance]),
      fetchPrice: async () => ({ price: 195, tMs: Date.now() }), // below resistance → no fire
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
    });
    expect(result.fired).toBe(0);
    expect(result.scanned).toBe(1);
  });

  it("skips a level when Yahoo returns null (graceful no_price fallthrough)", async () => {
    const { env } = makeEnv();
    const result = await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([lvl({ id: 7 })]),
      fetchPrice: async () => null,
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
    });
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.results[0].reason).toBe("no_price");
  });

  it("dedups multiple crossings on the same symbol independently per levelId", async () => {
    const { env } = makeEnv();
    const a = lvl({ id: 100, symbol: "AAPL", level_type: "support", price: 150 });
    const b = lvl({ id: 200, symbol: "AAPL", level_type: "support", price: 145 });
    const result = await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([a, b]),
      fetchPrice: async () => ({ price: 140, tMs: Date.now() }), // crosses both
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
    });
    expect(result.fired).toBe(2);
    expect(result.scanned).toBe(2);
  });
});
