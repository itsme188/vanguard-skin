/**
 * A re-armed level (active, auto-approved, last-fired fields kept from an
 * earlier day) must fire on BOTH scanners.
 *
 * Both sides run for real:
 *  - Mac: detectAndFireAlerts over the in-memory database.
 *  - Worker: runLevelScan over the snapshot row that the snapshot writer's own
 *    query (buildSnapshot) produces for that level, with an injected snapshot
 *    loader, price fetch, push sender and a fake KV.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAlerts, getLevelById } from "@/lib/queries/security-levels";
import { reactivateLevel, triggerLevel, upsertLevel } from "@/lib/mutations/security-levels";
import { detectAndFireAlerts } from "@/lib/alerts/detect";
import { buildSnapshot } from "@/scripts/snapshot-state-to-r2";
import { runLevelScan } from "../../workers/cron/src/level-scan";
import type { Snapshot as WorkerSnapshot } from "../../workers/cron/src/state";

const SYMBOL = "ZZG2P";
const PRIOR_FIRE = "2099-01-01T15:00:00.000Z";
const PRICE_DATE = "2099-01-02";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // The Mac push sender is fire-and-forget; make sure it can never reach out.
  vi.stubEnv("PUSHOVER_APP_TOKEN", "");
  vi.stubEnv("PUSHOVER_USER_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function seedFiredLevel(): { secId: number; levelId: number } {
  const secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(SYMBOL, `${SYMBOL} Corp`).lastInsertRowid as number;
  const levelId = upsertLevel(db, {
    security_id: secId,
    level_type: "resistance",
    price: 100,
    price_source: "static",
  });
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 120, 'manual')"
  ).run(secId, PRICE_DATE);
  // It fired on an earlier day: paused, with the last-fired record kept.
  triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 110, triggeredAt: PRIOR_FIRE });
  return { secId, levelId };
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  };
}

async function runWorker(snapshot: WorkerSnapshot) {
  const kv = fakeKv();
  const sent: Array<{ symbol: string; triggeredPrice: number }> = [];
  const result = await runLevelScan(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { CRON_KV: kv, ARCHIVE: {}, PUSHOVER_APP_TOKEN: "t", PUSHOVER_USER_KEY: "u" } as any,
    {
      loadSnapshot: async () => snapshot,
      fetchPrice: async (symbol) => (symbol === SYMBOL ? { price: 120, tMs: 0 } : null),
      sendPush: async (_env, args) => {
        sent.push(args);
        return { sent: true };
      },
      pacingMs: 0,
    }
  );
  return { result, sent, kv };
}

function workerSnapshot(): WorkerSnapshot {
  return buildSnapshot(db) as unknown as WorkerSnapshot;
}

describe("a re-armed level with a last-fired record: Mac scan and Worker scan agree", () => {
  it("while still paused after the earlier fire, neither side scans it", async () => {
    const { levelId } = seedFiredLevel();

    const snapshot = workerSnapshot();
    expect((snapshot.securityLevels ?? []).map((l) => l.id)).not.toContain(levelId);
    const worker = await runWorker(snapshot);
    expect(worker.result.fired).toBe(0);
    expect(worker.sent).toHaveLength(0);

    const mac = detectAndFireAlerts(db);
    expect(mac.fired).toBe(0);
    expect(getAlerts(db)).toHaveLength(1);
  });

  it("once re-armed, both sides fire although triggered_at is still set", async () => {
    const { levelId } = seedFiredLevel();
    expect(reactivateLevel(db, levelId, { force: true }).ok).toBe(true);
    const rearmed = getLevelById(db, levelId)!;
    expect(rearmed.is_active).toBe(1);
    expect(rearmed.triggered_at).toBe(PRIOR_FIRE);

    // Worker side: the row comes from the snapshot writer's own query.
    const snapshot = workerSnapshot();
    const row = (snapshot.securityLevels ?? []).find((l) => l.id === levelId);
    expect(row).toMatchObject({ symbol: SYMBOL, level_type: "resistance", price: 100 });
    const worker = await runWorker(snapshot);
    expect(worker.result.fired).toBe(1);
    expect(worker.result.results).toEqual([
      expect.objectContaining({ levelId, outcome: "fired", triggeredPrice: 120 }),
    ]);
    expect(worker.sent).toEqual([
      expect.objectContaining({ symbol: SYMBOL, triggeredPrice: 120 }),
    ]);
    expect(worker.kv.store.has(`cloud-fired-level-${levelId}`)).toBe(true);

    // Mac side: the real scan over the same database.
    const mac = detectAndFireAlerts(db);
    expect(mac.fired).toBe(1);
    expect(mac.deduped).toBe(0);
    expect(getAlerts(db)).toHaveLength(2);
    const after = getLevelById(db, levelId)!;
    expect(after.is_active).toBe(0);
    expect(after.triggered_price).toBe(120);
  });

  it("the forced re-arm stamp reaches the push text on both sides", async () => {
    const { levelId } = seedFiredLevel();
    reactivateLevel(db, levelId, { force: true });
    const stamp = getLevelById(db, levelId)!.armed_crossed_at;
    expect(stamp).not.toBeNull();

    const worker = await runWorker(workerSnapshot());
    expect(worker.sent[0]).toMatchObject({ armedCrossedAt: stamp });
  });
});
