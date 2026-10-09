/**
 * Tests for the cloud-side level scan (Tier 4a — close Pushover-when-Mac-asleep gap).
 *
 * We test the orchestrator via mocked snapshot loader + price fetcher + push sender,
 * plus the pure `isLevelCrossed` helper for direction semantics.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isLevelCrossed, runLevelScan, CLOUD_FIRED_MARKER_TTL_SECONDS } from "../src/level-scan";
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

  it("filters expired levels before scanning, on the Eastern date", async () => {
    const { env } = makeEnv();
    // 21:30 Eastern on 2026-10-07; the UTC date is already 2026-10-08.
    const now = new Date("2026-10-08T01:30:00Z");
    const expired = lvl({ id: 1, expires_at: "2026-10-06" });
    // Expires today in Eastern terms. A UTC date compare called it expired.
    const live = lvl({ id: 2, expires_at: "2026-10-07" });
    let priceFetches = 0;
    const result = await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([expired, live]),
      fetchPrice: async () => {
        priceFetches++;
        return { price: 100, tMs: now.getTime() };
      },
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
      now,
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

  it("passes armed_crossed_at through to the push sender as armedCrossedAt", async () => {
    const { env } = makeEnv();
    const supportLevel = lvl({ id: 43, level_type: "support", price: 150, armed_crossed_at: "2026-08-10 12:00:00" });
    const sent: any[] = [];
    await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([supportLevel]),
      fetchPrice: async () => ({ price: 149.5, tMs: Date.now() }),
      sendPush: async (_env, args) => {
        sent.push(args);
        return { sent: true };
      },
      pacingMs: 0,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].armedCrossedAt).toBe("2026-08-10 12:00:00");
  });

  it("passes armedCrossedAt as null when the level has no stamp", async () => {
    const { env } = makeEnv();
    const supportLevel = lvl({ id: 44, level_type: "support", price: 150 });
    const sent: any[] = [];
    await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([supportLevel]),
      fetchPrice: async () => ({ price: 149.5, tMs: Date.now() }),
      sendPush: async (_env, args) => {
        sent.push(args);
        return { sent: true };
      },
      pacingMs: 0,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].armedCrossedAt).toBeNull();
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

/**
 * Once-a-day guard (ruling 2026-10-08). The Mac allows one alert per level per
 * EASTERN day. The Worker used a KV marker that lived a rolling 24 hours, so a
 * level that crossed again the next morning was held back in the cloud while
 * the Mac would have alerted. The guard now reads the last fire from the
 * snapshot row (`triggered_at`) or from its own KV marker and blocks only when
 * that fire was on the current Eastern day.
 */
describe("runLevelScan — once per Eastern day", () => {
  const LEVEL_ID = 77;

  async function scanAt(
    now: Date,
    level: SecurityLevelRow,
    seed: Record<string, string> = {},
    snapshotOverrides: Partial<Snapshot> = {},
  ) {
    const kv = makeKV(seed);
    const puts: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }> = [];
    kv.put = (async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      puts.push({ key, value, opts });
      kv.store.set(key, value);
    }) as any;
    const env: any = { CRON_KV: kv, ARCHIVE: {}, PUSHOVER_APP_TOKEN: "t", PUSHOVER_USER_KEY: "u" };
    const sent: any[] = [];
    const result = await runLevelScan(env, {
      loadSnapshot: async () => ({ ...makeSnapshot([level]), ...snapshotOverrides }),
      fetchPrice: async () => ({ price: 149.5, tMs: now.getTime() }),
      sendPush: async (_env, args) => {
        sent.push(args);
        return { sent: true };
      },
      pacingMs: 0,
      now,
    });
    return { result, sent, puts, kv };
  }

  function marker(fields: Record<string, unknown>): Record<string, string> {
    return {
      [`cloud-fired-level-${LEVEL_ID}`]: JSON.stringify({
        levelId: LEVEL_ID,
        securityId: 10,
        symbol: "AAPL",
        levelType: "support",
        levelPrice: 150,
        triggeredPrice: 149.5,
        sourceAuthor: "Me",
        ...fields,
      }),
    };
  }

  // 10:00 Eastern (EDT) on Thursday 2026-10-08.
  const MORNING = new Date("2026-10-08T14:00:00Z");

  it("snapshot says the level fired earlier on the same Eastern day: held back", async () => {
    const level = lvl({ id: LEVEL_ID, triggered_at: "2026-10-08T13:35:00.000Z" });
    const { result, sent, puts } = await scanAt(MORNING, level);
    expect(result.fired).toBe(0);
    expect(result.deduped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("reads the SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) form of triggered_at the same way", async () => {
    const sameDay = lvl({ id: LEVEL_ID, triggered_at: "2026-10-08 13:35:00" });
    expect((await scanAt(MORNING, sameDay)).result.deduped).toBe(1);
    // 00:30 UTC on the 8th is 20:30 Eastern on the 7th: an earlier Eastern day.
    const eveningBefore = lvl({ id: LEVEL_ID, triggered_at: "2026-10-08 00:30:00" });
    expect((await scanAt(MORNING, eveningBefore)).result.fired).toBe(1);
  });

  it("fired yesterday afternoon, crosses again this morning (under 24 hours): fires", async () => {
    // 15:00 Eastern on the 7th, 19 hours before the scan.
    const level = lvl({ id: LEVEL_ID, triggered_at: "2026-10-07T19:00:00.000Z" });
    const { result, sent } = await scanAt(MORNING, level);
    expect(result.fired).toBe(1);
    expect(result.deduped).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("a fire at 20:30 Eastern shares the UTC date with the next morning but not the Eastern day: fires", async () => {
    const level = lvl({ id: LEVEL_ID, triggered_at: "2026-10-08T00:30:00.000Z" });
    const { result } = await scanAt(MORNING, level);
    expect(result.fired).toBe(1);
  });

  it("a KV marker from the same Eastern day holds the level back", async () => {
    const level = lvl({ id: LEVEL_ID });
    const { result, sent } = await scanAt(
      MORNING,
      level,
      marker({ triggeredAt: "2026-10-08T13:40:00.000Z", firedAt: "2026-10-08T13:45:00.000Z" }),
    );
    expect(result.fired).toBe(0);
    expect(result.deduped).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("a marker left from yesterday (the old 24-hour kind, no firedAt) no longer blocks", async () => {
    const level = lvl({ id: LEVEL_ID });
    const { result, sent, kv } = await scanAt(
      MORNING,
      level,
      marker({ triggeredAt: "2026-10-07T19:00:00.000Z" }),
    );
    expect(result.fired).toBe(1);
    expect(sent).toHaveLength(1);
    // The marker is replaced by today's fire.
    const stored = JSON.parse(kv.store.get(`cloud-fired-level-${LEVEL_ID}`)!);
    expect(stored.firedAt).toBe(MORNING.toISOString());
  });

  it("the marker's own fire time decides, not a stale quote time", async () => {
    // The quote's timestamp is yesterday (a thinly traded name), but the
    // Worker alerted today: the level must not alert again every 15 minutes.
    const level = lvl({ id: LEVEL_ID });
    const { result } = await scanAt(
      MORNING,
      level,
      marker({ triggeredAt: "2026-10-07T19:59:00.000Z", firedAt: "2026-10-08T13:45:00.000Z" }),
    );
    expect(result.fired).toBe(0);
    expect(result.deduped).toBe(1);
  });

  // The marker lives 7 days, so an unreadable one must not silence the level
  // for a week: it costs at most one extra alert, and the fire overwrites it.
  it("a marker that cannot be read does not hold the level back, and the fire replaces it", async () => {
    const level = lvl({ id: LEVEL_ID });
    const { result, puts } = await scanAt(MORNING, level, {
      [`cloud-fired-level-${LEVEL_ID}`]: "not json",
    });
    expect(result.fired).toBe(1);
    expect(result.deduped).toBe(0);
    expect(puts).toHaveLength(1);
    expect(() => JSON.parse(String(puts[0].value))).not.toThrow();
  });

  it("the marker is kept 7 days for the Mac to reconcile; its lifetime is not the guard", async () => {
    expect(CLOUD_FIRED_MARKER_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    const level = lvl({ id: LEVEL_ID });
    const { puts } = await scanAt(MORNING, level);
    expect(puts).toHaveLength(1);
    expect(puts[0].opts?.expirationTtl).toBe(CLOUD_FIRED_MARKER_TTL_SECONDS);
    expect(JSON.parse(puts[0].value).earlier).toBeUndefined();
  });

  it("a second cross on the same Eastern day is held, hours later and after the UTC date has rolled", async () => {
    const level = lvl({ id: LEVEL_ID });
    const first = await scanAt(MORNING, level);
    expect(first.result.fired).toBe(1);
    const seed = Object.fromEntries(first.kv.store);
    // 15:45 Eastern the same day.
    const afternoon = await scanAt(new Date("2026-10-08T19:45:00Z"), level, seed);
    expect(afternoon.result.fired).toBe(0);
    expect(afternoon.result.deduped).toBe(1);
    expect(afternoon.puts).toHaveLength(0);
    // 21:30 Eastern the same day: the UTC date is already the 9th.
    const evening = await scanAt(new Date("2026-10-09T01:30:00Z"), level, seed);
    expect(evening.result.fired).toBe(0);
    expect(evening.result.deduped).toBe(1);
  });

  it("a marker from two days ago does not block, and is left in place while the level is not crossed", async () => {
    const old = marker({ triggeredAt: "2026-10-06T18:00:00.000Z", firedAt: "2026-10-06T18:00:05.000Z" });
    const kv = makeKV(old);
    const env: any = { CRON_KV: kv, ARCHIVE: {}, PUSHOVER_APP_TOKEN: "t", PUSHOVER_USER_KEY: "u" };
    const result = await runLevelScan(env, {
      loadSnapshot: async () => makeSnapshot([lvl({ id: LEVEL_ID })]),
      fetchPrice: async () => ({ price: 155, tMs: MORNING.getTime() }), // above the support: no cross
      sendPush: async () => ({ sent: true }),
      pacingMs: 0,
      now: MORNING,
    });
    expect(result.fired).toBe(0);
    // Still there, unchanged, under the key the Mac's reconcile lists.
    expect(kv.store.get(`cloud-fired-level-${LEVEL_ID}`)).toBe(old[`cloud-fired-level-${LEVEL_ID}`]);
    const listed = await kv.list({ prefix: "cloud-fired-level-" });
    expect(listed.keys.map((k) => k.name)).toEqual([`cloud-fired-level-${LEVEL_ID}`]);
  });

  it("when the level fires again, the unreconciled record from two days ago rides along in the new marker", async () => {
    const level = lvl({ id: LEVEL_ID });
    const { result, kv, puts } = await scanAt(
      MORNING,
      level,
      marker({ triggeredAt: "2026-10-06T18:00:00.000Z", firedAt: "2026-10-06T18:00:05.000Z", triggeredPrice: 148 }),
    );
    expect(result.fired).toBe(1);
    expect(puts[0].opts?.expirationTtl).toBe(CLOUD_FIRED_MARKER_TTL_SECONDS);
    const stored = JSON.parse(kv.store.get(`cloud-fired-level-${LEVEL_ID}`)!);
    expect(stored.firedAt).toBe(MORNING.toISOString());
    expect(stored.earlier).toEqual([
      expect.objectContaining({ firedAt: "2026-10-06T18:00:05.000Z", triggeredPrice: 148, levelId: LEVEL_ID }),
    ]);
    expect(stored.earlier[0].earlier).toBeUndefined();
  });

  it("carried records accumulate oldest first, and one older than the 7-day lifetime is dropped", async () => {
    const level = lvl({ id: LEVEL_ID });
    const seed = marker({
      triggeredAt: "2026-10-07T18:00:00.000Z",
      firedAt: "2026-10-07T18:00:05.000Z",
      earlier: [
        { levelId: LEVEL_ID, securityId: 10, triggeredAt: "2026-09-29T18:00:00.000Z", firedAt: "2026-09-29T18:00:05.000Z", triggeredPrice: 147 },
        { levelId: LEVEL_ID, securityId: 10, triggeredAt: "2026-10-06T18:00:00.000Z", firedAt: "2026-10-06T18:00:05.000Z", triggeredPrice: 148 },
      ],
    });
    const { kv } = await scanAt(MORNING, level, seed);
    const stored = JSON.parse(kv.store.get(`cloud-fired-level-${LEVEL_ID}`)!);
    expect(stored.earlier.map((r: { firedAt: string }) => r.firedAt)).toEqual([
      "2026-10-06T18:00:05.000Z",
      "2026-10-07T18:00:05.000Z",
    ]);
  });

  it("a version-11 snapshot row (no currency, no triggered_at) still scans and fires in dollars", async () => {
    const level = lvl({ id: LEVEL_ID });
    expect("currency" in level).toBe(false);
    expect("triggered_at" in level).toBe(false);
    const { result, sent } = await scanAt(MORNING, level, {}, { schemaVersion: 11 });
    expect(result.fired).toBe(1);
    expect(sent[0].currency ?? null).toBeNull();
  });

  it("a version-12 row carries its currency to the push and to the KV record", async () => {
    const level = lvl({ id: LEVEL_ID, symbol: "ZZJ", currency: "JPY", price: 150, triggered_at: null });
    const { sent, puts } = await scanAt(MORNING, level, {}, { schemaVersion: 12 });
    expect(sent[0]).toMatchObject({ symbol: "ZZJ", currency: "JPY", triggeredPrice: 149.5 });
    expect(JSON.parse(puts[0].value)).toMatchObject({ currency: "JPY", levelPrice: 150 });
  });
});
