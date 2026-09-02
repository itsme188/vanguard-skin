/**
 * Regression pin (qa:security-detail-suggested-levels--computed-from-oldest-
 * 500-bars-drops-recent-4-months): getOhlcvBars orders ASC then LIMITs, so a
 * security with >500 stored daily bars had its pivot detector fed the OLDEST
 * 500 bars instead of the newest — suggested levels came out as stale
 * supports/resistances from a regime the price left months ago, and the
 * narrator's "last 20 sessions" text was actually months-old. The route must
 * analyse the newest 500 bars (still ascending — the pivot detector and
 * narrator expect ascending order).
 *
 * Fixture shape is deliberate, not arbitrary: an OLD regime of 520 daily bars
 * (base ~140, pivot high 155 / low 125 — both within the scanner's 50%
 * plausibility band around current=100, so they're eligible to render as
 * levels) followed by a RECENT regime of 520 bars (base ~100, pivot high 110
 * / low 90). With a 500-bar window and a 520/520 split:
 *   - the OLDEST 500 bars (the bug) fall entirely inside the old regime —
 *     zero recent-regime bars are even in the window.
 *   - the NEWEST 500 bars (the fix) fall entirely inside the recent regime —
 *     zero old-regime bars are in the window.
 * A narrower split (e.g. old=300/recent=260) does NOT discriminate the bug:
 * an oldest-500 slice of a 560-bar table still pulls in 200 of the 260
 * recent bars, so recent-regime levels show up either way. The 520/520 split
 * with 20-bar margins on both sides guarantees the two windows never overlap
 * a regime boundary.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getRecentOhlcvBars } from "@/lib/queries/ohlcv";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET } from "@/app/api/suggested-levels/route";

const CURRENT = 100;
const OLD_REGIME_COUNT = 520;
const RECENT_REGIME_COUNT = 520;

function seedSecurity(db: Database.Database, symbol: string): number {
  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, currency)
     VALUES (?, ?, 'Stock', 'USD')`,
  ).run(symbol, `${symbol} test`);
  const secId = (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as {
      id: number;
    }
  ).id;

  const insBar = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  let day = 0;
  const push = (base: number, high: number, low: number) => {
    const date = new Date(Date.UTC(2023, 0, day + 1)).toISOString().slice(0, 10);
    insBar.run(secId, date, base, high, low, base);
    day++;
  };

  // Old regime: pivot highs at 155, lows at 125 — both within the scanner's
  // 50% band around current=100, so they're eligible as levels; only the
  // window (oldest vs newest 500) determines whether they get analysed.
  for (let i = 0; i < OLD_REGIME_COUNT; i++) {
    const phase = i % 10;
    push(140, phase === 4 ? 155 : 143, phase === 9 ? 125 : 137);
  }
  // Recent regime: pivot highs at 110, lows at 90.
  for (let i = 0; i < RECENT_REGIME_COUNT; i++) {
    const phase = i % 10;
    push(100, phase === 4 ? 110 : 103, phase === 9 ? 90 : 97);
  }

  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2025-01-01', ?, 'tws')",
  ).run(secId, CURRENT);
  return secId;
}

async function fetchLevels(secId: number) {
  const res = await GET(
    new Request(`http://localhost/api/suggested-levels?securityId=${secId}`) as never,
  );
  const body = await res.json();
  return body as {
    levels: Array<{ price: number; type: string }>;
    barsAnalyzed: number;
  };
}

describe("GET /api/suggested-levels — newest-window bar selection", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("journal_mode = WAL");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
  });

  it("suggests levels from the recent regime, not the old regime, and reports 500 bars analysed", async () => {
    const secId = seedSecurity(hoisted.db, "WINQA");
    const { levels, barsAnalyzed } = await fetchLevels(secId);

    expect(barsAnalyzed).toBe(500);
    expect(levels.length).toBeGreaterThan(0);

    // Recent-regime pivots (near 90 / 110) must be present — only possible if
    // the window reaches the newest bars.
    expect(
      levels.some((l) => Math.abs(l.price - 90) < 5 || Math.abs(l.price - 110) < 5),
    ).toBe(true);

    // Old-regime pivots (near 125 / 155) must be ABSENT — they're within the
    // plausibility band (so they'd render as levels if analysed), and are
    // only excluded because the window no longer reaches those dates.
    expect(
      levels.some((l) => Math.abs(l.price - 125) < 5 || Math.abs(l.price - 155) < 5),
    ).toBe(false);
  });

  it("getRecentOhlcvBars: newest-500 helper is sorted ascending, length 500, and lands entirely in the recent regime", () => {
    const secId = seedSecurity(hoisted.db, "WINPIN");
    const bars = getRecentOhlcvBars(hoisted.db, secId, "1 day", 500);

    expect(bars.length).toBe(500);

    const newestRow = hoisted.db
      .prepare(
        `SELECT MAX(bar_date) as d FROM ohlcv_bars WHERE security_id = ? AND bar_size = '1 day'`,
      )
      .get(secId) as { d: string };
    expect(bars[bars.length - 1].date).toBe(newestRow.d);

    // Sorted ascending.
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].date >= bars[i - 1].date).toBe(true);
    }

    // The entire old-regime tail (base ~140, closes >= 140) must have been
    // dropped — every bar in the window should be from the recent regime
    // (close ~100).
    for (const bar of bars) {
      expect(bar.close).toBeLessThan(120);
    }
  });
});
