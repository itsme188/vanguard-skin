# Earnings Wire-Time Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture earnings actuals the moment they hit Finnhub (pre-release probe window) while recording observed wire times per (symbol, quarter), auto-calibrating future `release_time` resolution with a per-symbol standing override UI.

**Architecture:** New migration 076 (two tables + one column). A new `lib/earnings/wire-times.ts` owns observation recording and the release-time resolution cascade (db passed explicitly — NO registration seam; every call site already has `db` in scope, matching the repo's "every DB function takes a db parameter" convention; this deliberately simplifies the spec's override-source-seam suggestion). A new `lib/calendar/wire-probe.ts` runs a pre-release Finnhub probe pass inside `runEnrichment`. The existing daily date-verification tier additionally asks for exact report times (EarningsWhispers-preferred) for unknown symbols. `EarningsDateChip` popover gains a "Reports at" override editor backed by `POST /api/earnings/release-time`.

**Tech Stack:** TypeScript, better-sqlite3 (`:memory:` test DBs), Vitest, Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-08-04-earnings-wire-time-tracking-design.md`

## Global Constraints

- Run tests as `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run <path>` (worktrees carry no `.env.local`; 3 AI tests fail without the dummy key).
- All dates `YYYY-MM-DD`; ET wall-clock via `Intl` (`etHHMM` from `@/lib/earnings/wrap`), never the local clock; SQLite `datetime()` compares need `datetime()` on BOTH sides.
- Macro calendar rows are NEVER touched by any of this — every new query filters to earnings rows (`event_type = 'earnings'` OR `source = 'finnhub'` per existing convention) AND `symbol IS NOT NULL`.
- Table-existence tolerance: minimal test DBs may lack the new tables — wrap reads in try/catch returning empty defaults (precedent: `calendar_event_suppressions` handling in `upsertCalendarEvents`).
- Family-aware symbol lookups via `issuerSiblings` (`@/lib/securities/issuer-family`); symbols stored UPPER.
- Commit messages: write to a temp file, `git commit -F` (never inline `-m`).
- No Worker changes anywhere in this plan (spec: Worker inherits release times through data).

---

### Task 1: Migration 076 + wire-times observation primitives

**Files:**
- Create: `lib/db/migrations/076_wire_time_tracking.sql`
- Create: `lib/earnings/wire-times.ts`
- Test: `tests/earnings/wire-times.test.ts`

**Interfaces:**
- Produces: `recordWireObservation(db, obs): boolean` (true = new row inserted), `isBoundedObservation(firstSeenAt: string, lastEmptyProbeAt: string | null): boolean`, `stampEmptyProbe(db, eventId: number, at: Date): void`, `getObservationsForFamily(db, symbol: string, sinceDate: string): WireObservationRow[]`, constants `BOUNDED_MAX_GAP_MS`, `OBSERVATION_LOOKBACK_DAYS = 400`.

- [ ] **Step 1: Write the migration**

```sql
-- 076_wire_time_tracking.sql
-- Earnings wire-time tracking (spec 2026-08-04): observed print times per
-- (symbol, quarter) + per-symbol standing release-time overrides.

CREATE TABLE earnings_wire_observations (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_id INTEGER,
  first_seen_at TEXT NOT NULL,
  last_empty_probe_at TEXT,
  source TEXT NOT NULL DEFAULT 'finnhub_probe',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, event_date, source)
);

CREATE TABLE symbol_release_times (
  symbol TEXT PRIMARY KEY,
  release_time TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  verified_for_date TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE calendar_events ADD COLUMN wire_probe_empty_at TEXT;
```

- [ ] **Step 2: Write failing tests for the primitives**

```typescript
// tests/earnings/wire-times.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  recordWireObservation,
  isBoundedObservation,
  stampEmptyProbe,
  getObservationsForFamily,
} from "@/lib/earnings/wire-times";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedEvent(symbol: string, date: string): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings',?,?,?,?,?)`,
    )
    .run(date, symbol, `${symbol} earnings`, `finnhub:${symbol}:${date}`, date)
    .lastInsertRowid as number;
}

describe("recordWireObservation", () => {
  it("inserts a first sighting and is idempotent per (symbol, date, source)", () => {
    const id = seedEvent("XMTR", "2026-08-04");
    const first = recordWireObservation(db, {
      symbol: "xmtr",
      eventDate: "2026-08-04",
      eventId: id,
      firstSeenAt: "2026-08-04T11:15:00.000Z",
      lastEmptyProbeAt: "2026-08-04T11:00:00.000Z",
    });
    const second = recordWireObservation(db, {
      symbol: "XMTR",
      eventDate: "2026-08-04",
      eventId: id,
      firstSeenAt: "2026-08-04T12:00:00.000Z",
      lastEmptyProbeAt: null,
    });
    expect(first).toBe(true);
    expect(second).toBe(false); // first sighting wins
    const rows = getObservationsForFamily(db, "XMTR", "2026-01-01");
    expect(rows).toHaveLength(1);
    expect(rows[0].first_seen_at).toBe("2026-08-04T11:15:00.000Z");
    expect(rows[0].symbol).toBe("XMTR"); // stored UPPER
  });

  it("survives a DB without the observations table (minimal test DBs)", () => {
    const bare = new Database(":memory:");
    expect(
      recordWireObservation(bare, {
        symbol: "XMTR",
        eventDate: "2026-08-04",
        eventId: null,
        firstSeenAt: "2026-08-04T11:15:00.000Z",
        lastEmptyProbeAt: null,
      }),
    ).toBe(false);
    expect(getObservationsForFamily(bare, "XMTR", "2026-01-01")).toEqual([]);
  });
});

describe("isBoundedObservation", () => {
  it("bounded when the empty probe is within 30 min before first-seen", () => {
    expect(
      isBoundedObservation("2026-08-04T11:15:00.000Z", "2026-08-04T11:00:00.000Z"),
    ).toBe(true);
  });
  it("unbounded when there was no empty probe", () => {
    expect(isBoundedObservation("2026-08-04T11:15:00.000Z", null)).toBe(false);
  });
  it("unbounded when the empty probe is older than 30 min", () => {
    expect(
      isBoundedObservation("2026-08-04T11:15:00.000Z", "2026-08-04T10:30:00.000Z"),
    ).toBe(false);
  });
});

describe("stampEmptyProbe", () => {
  it("stamps wire_probe_empty_at on the event row", () => {
    const id = seedEvent("WIX", "2026-08-04");
    stampEmptyProbe(db, id, new Date("2026-08-04T11:00:00.000Z"));
    const row = db
      .prepare("SELECT wire_probe_empty_at FROM calendar_events WHERE id = ?")
      .get(id) as { wire_probe_empty_at: string | null };
    expect(row.wire_probe_empty_at).toBe("2026-08-04T11:00:00.000Z");
  });
});

describe("getObservationsForFamily", () => {
  it("walks issuer siblings (GOOG observation found via GOOGL)", () => {
    recordWireObservation(db, {
      symbol: "GOOG",
      eventDate: "2026-07-29",
      eventId: null,
      firstSeenAt: "2026-07-29T20:05:00.000Z",
      lastEmptyProbeAt: "2026-07-29T19:50:00.000Z",
    });
    expect(getObservationsForFamily(db, "GOOGL", "2026-01-01")).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests, verify they fail** (module missing)

Run: `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run tests/earnings/wire-times.test.ts`
Expected: FAIL — cannot resolve `@/lib/earnings/wire-times`.

- [ ] **Step 4: Implement `lib/earnings/wire-times.ts` (primitives only)**

```typescript
/**
 * Earnings wire-time tracking (spec 2026-08-04): observed print times per
 * (symbol, quarter) + the per-symbol release-time resolution cascade.
 *
 * "Bounded" observation = an empty probe existed <=30 min before the first
 * sighting, so the true wire time lies in a tight interval. Unbounded
 * observations (Mac woke late) prove only "at or before first_seen_at" and
 * are excluded from calibration except the pull-down rule (an early
 * sighting is proof regardless of bounding).
 *
 * All reads tolerate missing tables (minimal test DBs) — precedent:
 * calendar_event_suppressions.
 */
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export const BOUNDED_MAX_GAP_MS = 30 * 60 * 1000;
export const OBSERVATION_LOOKBACK_DAYS = 400; // ~4 quarters + slack

export interface WireObservationRow {
  id: number;
  symbol: string;
  event_date: string;
  event_id: number | null;
  first_seen_at: string; // ISO UTC
  last_empty_probe_at: string | null; // ISO UTC
  source: string;
}

export interface RecordObservationInput {
  symbol: string;
  eventDate: string;
  eventId: number | null;
  firstSeenAt: string; // ISO UTC
  lastEmptyProbeAt: string | null;
  source?: "finnhub_probe" | "web_verified" | "manual";
}

/** Insert a first sighting. Returns false on duplicate or missing table. */
export function recordWireObservation(
  db: Database.Database,
  input: RecordObservationInput,
): boolean {
  try {
    const res = db
      .prepare(
        `INSERT INTO earnings_wire_observations
           (symbol, event_date, event_id, first_seen_at, last_empty_probe_at, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, event_date, source) DO NOTHING`,
      )
      .run(
        input.symbol.trim().toUpperCase(),
        input.eventDate,
        input.eventId,
        input.firstSeenAt,
        input.lastEmptyProbeAt,
        input.source ?? "finnhub_probe",
      );
    return res.changes > 0;
  } catch {
    return false;
  }
}

export function isBoundedObservation(
  firstSeenAt: string,
  lastEmptyProbeAt: string | null,
): boolean {
  if (!lastEmptyProbeAt) return false;
  const seen = Date.parse(firstSeenAt);
  const empty = Date.parse(lastEmptyProbeAt);
  if (!Number.isFinite(seen) || !Number.isFinite(empty)) return false;
  const gap = seen - empty;
  return gap >= 0 && gap <= BOUNDED_MAX_GAP_MS;
}

/** Stamp the latest came-up-empty probe instant on the event row. */
export function stampEmptyProbe(
  db: Database.Database,
  eventId: number,
  at: Date,
): void {
  try {
    db.prepare(
      `UPDATE calendar_events SET wire_probe_empty_at = ? WHERE id = ?`,
    ).run(at.toISOString(), eventId);
  } catch {
    // column absent in a minimal test DB — observation stays unbounded
  }
}

/** All observations for the symbol's issuer family since sinceDate. */
export function getObservationsForFamily(
  db: Database.Database,
  symbol: string,
  sinceDate: string,
): WireObservationRow[] {
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, symbol, event_date, event_id, first_seen_at, last_empty_probe_at, source
         FROM earnings_wire_observations
         WHERE symbol IN (${ph}) AND event_date >= ?
         ORDER BY event_date DESC`,
      )
      .all(...family, sinceDate) as WireObservationRow[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run tests/earnings/wire-times.test.ts`
Expected: PASS. Also run `npx vitest run tests/db` (or the migrations test if present) to confirm 076 applies cleanly.

- [ ] **Step 6: Commit**

```bash
git add lib/db/migrations/076_wire_time_tracking.sql lib/earnings/wire-times.ts tests/earnings/wire-times.test.ts
git commit -F <tempfile>   # "feat(earnings): migration 076 + wire-time observation primitives"
```

---

### Task 2: Resolution cascade + insert-path integration + upcoming-events apply

**Files:**
- Modify: `lib/earnings/wire-times.ts` (append)
- Modify: `lib/mutations/calendar.ts` (both release-time derivation sites: the sync upsert at ~line 126 and `insertCalendarEvent`'s `deriveReleaseTime` at ~line 525/635)
- Test: `tests/earnings/wire-times.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 primitives; `resolveReleaseTime` + `earningsHourToReleaseTime` from `@/lib/calendar/release-times`; `etHHMM` from `@/lib/earnings/wrap`.
- Produces:
  - `resolveSymbolReleaseTime(db, symbol, slot: "bmo" | "amc" | null): { time: string; source: "user" | "web_verified" | "observed" } | null` — cascade layers 1–3.
  - `resolveEarningsReleaseTime(db, row: { event_type: string; event_time: string | null; raw_json: string | null; symbol?: string | null }): string | null` — full cascade for one earnings row (explicit HH:MM event_time still wins; then layers 1–5; then the pull-down rule when resolution reached layer ≥3).
  - `upsertSymbolReleaseTime(db, { symbol, releaseTime, source, note?, verifiedForDate? }): void`
  - `clearUserReleaseTime(db, symbol): boolean`
  - `hasBoundedObservations(db, symbol): boolean`
  - `getSymbolReleaseTimeRow(db, symbol): { symbol; release_time; source; note; verified_for_date; updated_at } | null` (family-aware)
  - `applyResolvedReleaseTimeToUpcomingEvents(db, symbol, opts?: { today?: string }): number` (rows updated)
  - Constants: `RESOLUTION_MARGIN_MIN = 10`, `EARLIEST_PLAUSIBLE_ET = "04:00"`, `LATEST_PLAUSIBLE_ET = "20:00"`.

- [ ] **Step 1: Write failing cascade tests** (append to `tests/earnings/wire-times.test.ts`)

```typescript
import {
  resolveSymbolReleaseTime,
  resolveEarningsReleaseTime,
  upsertSymbolReleaseTime,
  clearUserReleaseTime,
  hasBoundedObservations,
  applyResolvedReleaseTimeToUpcomingEvents,
} from "@/lib/earnings/wire-times";

// helper: a bounded observation whose first_seen is 07:15 ET on a summer date
// (EDT = UTC-4 → 11:15Z).
function seedBoundedObs(symbol: string, date: string, seenIsoUtc: string) {
  recordWireObservation(db, {
    symbol,
    eventDate: date,
    eventId: null,
    firstSeenAt: seenIsoUtc,
    lastEmptyProbeAt: new Date(Date.parse(seenIsoUtc) - 15 * 60_000).toISOString(),
  });
}

describe("resolveSymbolReleaseTime cascade", () => {
  it("layer 1: user override wins over everything", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:30", source: "web_verified" }); // replaced by user row (PK)
    seedBoundedObs("XMTR", "2026-05-05", "2026-05-05T11:15:00.000Z");
    expect(resolveSymbolReleaseTime(db, "XMTR", "bmo")).toEqual({ time: "07:00", source: "user" });
  });

  it("layer 2: web_verified honored only while ZERO bounded observations exist", () => {
    upsertSymbolReleaseTime(db, { symbol: "WIX", releaseTime: "07:10", source: "web_verified" });
    expect(resolveSymbolReleaseTime(db, "WIX", "bmo")).toEqual({ time: "07:10", source: "web_verified" });
    seedBoundedObs("WIX", "2026-05-05", "2026-05-05T11:15:00.000Z"); // 07:15 ET bounded
    // bounded obs now exist → web row skipped, observed-derived: 07:15 − 10m → 07:05 → floor :05
    expect(resolveSymbolReleaseTime(db, "WIX", "bmo")).toEqual({ time: "07:05", source: "observed" });
  });

  it("layer 3: earliest bounded first_seen minus 10 min, rounded down to :05", () => {
    seedBoundedObs("XMTR", "2026-05-05", "2026-05-05T11:22:00.000Z"); // 07:22 ET
    seedBoundedObs("XMTR", "2026-02-03", "2026-02-03T12:33:00.000Z"); // 07:33 ET (EST=UTC-5)
    // earliest = 07:22 → minus 10 = 07:12 → round down :05 = 07:10
    expect(resolveSymbolReleaseTime(db, "XMTR", "bmo")).toEqual({ time: "07:10", source: "observed" });
  });

  it("unbounded observations alone produce NO derived time", () => {
    recordWireObservation(db, {
      symbol: "DOCN", eventDate: "2026-05-05", eventId: null,
      firstSeenAt: "2026-05-05T11:40:00.000Z", lastEmptyProbeAt: null,
    });
    expect(resolveSymbolReleaseTime(db, "DOCN", "bmo")).toBeNull();
  });

  it("slot-mismatch guard: a morning stored time is ignored for an AMC event", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    expect(resolveSymbolReleaseTime(db, "XMTR", "amc")).toBeNull();
    expect(resolveSymbolReleaseTime(db, "XMTR", null)).toEqual({ time: "07:00", source: "user" }); // null slot → no guard
  });

  it("04:00 sanity floor on derived times", () => {
    seedBoundedObs("EARL", "2026-05-05", "2026-05-05T08:02:00.000Z"); // 04:02 ET
    expect(resolveSymbolReleaseTime(db, "EARL", "bmo")).toEqual({ time: "04:00", source: "observed" });
  });
});

describe("resolveEarningsReleaseTime full cascade", () => {
  const bmoRow = { event_type: "earnings", event_time: "BMO", raw_json: null, symbol: "XMTR" };

  it("falls through to the 08:00 BMO default with no data", () => {
    expect(resolveEarningsReleaseTime(db, bmoRow)).toBe("08:00");
  });

  it("explicit HH:MM event_time still wins over a user override", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    expect(
      resolveEarningsReleaseTime(db, { ...bmoRow, event_time: "06:45" }),
    ).toBe("06:45");
  });

  it("pull-down rule: an unbounded sighting earlier than the default pulls it down (layer >= 3 only)", () => {
    recordWireObservation(db, {
      symbol: "XMTR", eventDate: "2026-05-05", eventId: null,
      firstSeenAt: "2026-05-05T11:05:00.000Z", lastEmptyProbeAt: null, // 07:05 ET, unbounded
    });
    // default would be 08:00; unbounded 07:05 pulls down → 07:05 − 10m = 06:55
    expect(resolveEarningsReleaseTime(db, bmoRow)).toBe("06:55");
  });

  it("pull-down does NOT override a user standing override", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:30", source: "user" });
    recordWireObservation(db, {
      symbol: "XMTR", eventDate: "2026-05-05", eventId: null,
      firstSeenAt: "2026-05-05T11:05:00.000Z", lastEmptyProbeAt: null,
    });
    expect(resolveEarningsReleaseTime(db, bmoRow)).toBe("07:30");
  });

  it("legacy SYMBOL_RELEASE_TIMES_ET constant still applies (layer 4)", () => {
    expect(
      resolveEarningsReleaseTime(db, { event_type: "earnings", event_time: "AMC", raw_json: null, symbol: "AAPL" }),
    ).toBe("16:30");
  });
});

describe("applyResolvedReleaseTimeToUpcomingEvents", () => {
  it("updates future un-enriched family earnings rows, skips past/enriched/actualed rows", () => {
    const future = seedEvent("XMTR", "2027-01-15");
    db.prepare("UPDATE calendar_events SET event_time = 'BMO', release_time = '08:00' WHERE id = ?").run(future);
    const done = seedEvent("XMTR", "2027-01-16");
    db.prepare(
      "UPDATE calendar_events SET event_time = 'BMO', release_time = '08:00', actual_value = 'EPS 1.00' WHERE id = ?",
    ).run(done);
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });

    const n = applyResolvedReleaseTimeToUpcomingEvents(db, "XMTR", { today: "2026-12-01" });

    expect(n).toBe(1);
    expect(
      (db.prepare("SELECT release_time FROM calendar_events WHERE id = ?").get(future) as { release_time: string }).release_time,
    ).toBe("07:00");
    expect(
      (db.prepare("SELECT release_time FROM calendar_events WHERE id = ?").get(done) as { release_time: string }).release_time,
    ).toBe("08:00");
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail** (functions not exported)

Run: `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run tests/earnings/wire-times.test.ts`

- [ ] **Step 3: Implement the cascade** (append to `lib/earnings/wire-times.ts`)

```typescript
import { resolveReleaseTime } from "@/lib/calendar/release-times";

export const RESOLUTION_MARGIN_MIN = 10;
export const EARLIEST_PLAUSIBLE_ET = "04:00";
export const LATEST_PLAUSIBLE_ET = "20:00";

export interface SymbolReleaseTimeRow {
  symbol: string;
  release_time: string;
  source: string; // 'user' | 'web_verified'
  note: string | null;
  verified_for_date: string | null;
  updated_at: string;
}

/** ET wall-clock HH:MM for an ISO UTC instant (DST-aware, 24:00 normalized). */
export function etTimeOfInstant(isoUtc: string): string | null {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) return null;
  const hhmm = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
  return hhmm.replace(/^24/, "00");
}

function minusMarginFloored(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m - RESOLUTION_MARGIN_MIN;
  total = Math.floor(total / 5) * 5; // round DOWN to :05
  const [fh, fm] = EARLIEST_PLAUSIBLE_ET.split(":").map(Number);
  total = Math.max(total, fh * 60 + fm);
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function sameSideOfNoon(hhmm: string, slot: "bmo" | "amc" | null): boolean {
  if (slot === null) return true;
  const isMorning = hhmm < "12:00";
  return slot === "bmo" ? isMorning : !isMorning;
}

export function getSymbolReleaseTimeRow(
  db: Database.Database,
  symbol: string,
): SymbolReleaseTimeRow | null {
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    return (
      (db
        .prepare(
          `SELECT symbol, release_time, source, note, verified_for_date, updated_at
           FROM symbol_release_times WHERE symbol IN (${ph})
           ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(...family) as SymbolReleaseTimeRow | undefined) ?? null
    );
  } catch {
    return null;
  }
}

export function upsertSymbolReleaseTime(
  db: Database.Database,
  input: {
    symbol: string;
    releaseTime: string;
    source: "user" | "web_verified";
    note?: string | null;
    verifiedForDate?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO symbol_release_times (symbol, release_time, source, note, verified_for_date, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       release_time = excluded.release_time,
       source = excluded.source,
       note = excluded.note,
       verified_for_date = excluded.verified_for_date,
       updated_at = datetime('now')`,
  ).run(
    input.symbol.trim().toUpperCase(),
    input.releaseTime,
    input.source,
    input.note ?? null,
    input.verifiedForDate ?? null,
  );
}

export function clearUserReleaseTime(db: Database.Database, symbol: string): boolean {
  try {
    return (
      db
        .prepare(`DELETE FROM symbol_release_times WHERE symbol = ? AND source = 'user'`)
        .run(symbol.trim().toUpperCase()).changes > 0
    );
  } catch {
    return false;
  }
}

function lookbackSinceDate(): string {
  const d = new Date(Date.now() - OBSERVATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function hasBoundedObservations(db: Database.Database, symbol: string): boolean {
  return getObservationsForFamily(db, symbol, lookbackSinceDate()).some((o) =>
    isBoundedObservation(o.first_seen_at, o.last_empty_probe_at),
  );
}

/** Cascade layers 1–3 (user → web_verified → observed-derived). */
export function resolveSymbolReleaseTime(
  db: Database.Database,
  symbol: string,
  slot: "bmo" | "amc" | null,
): { time: string; source: "user" | "web_verified" | "observed" } | null {
  const row = getSymbolReleaseTimeRow(db, symbol);
  const bounded = getObservationsForFamily(db, symbol, lookbackSinceDate()).filter((o) =>
    isBoundedObservation(o.first_seen_at, o.last_empty_probe_at),
  );

  if (row?.source === "user" && sameSideOfNoon(row.release_time, slot)) {
    return { time: row.release_time, source: "user" };
  }
  if (row?.source === "web_verified" && bounded.length === 0 && sameSideOfNoon(row.release_time, slot)) {
    return { time: row.release_time, source: "web_verified" };
  }
  const times = bounded
    .map((o) => etTimeOfInstant(o.first_seen_at))
    .filter((t): t is string => t !== null)
    .filter((t) => sameSideOfNoon(t, slot));
  if (times.length > 0) {
    const earliest = times.reduce((a, b) => (a < b ? a : b));
    return { time: minusMarginFloored(earliest), source: "observed" };
  }
  return null;
}

/**
 * Full release-time resolution for one earnings row: explicit HH:MM
 * event_time → layers 1–3 → legacy constant + BMO/AMC defaults
 * (resolveReleaseTime) → pull-down rule (any observation earlier than a
 * layer-≥3 resolution pulls it down; user/web layers are never pulled).
 */
export function resolveEarningsReleaseTime(
  db: Database.Database,
  row: {
    event_type: string;
    event_time: string | null;
    raw_json: string | null;
    symbol?: string | null;
  },
): string | null {
  if (row.event_time && /^\d{2}:\d{2}$/.test(row.event_time)) return row.event_time;
  if (row.event_type !== "earnings" || !row.symbol) return resolveReleaseTime(row);

  const slot = ((): "bmo" | "amc" | null => {
    const et = row.event_time?.trim().toUpperCase();
    if (et === "BMO") return "bmo";
    if (et === "AMC") return "amc";
    return null;
  })();

  const fromSymbol = resolveSymbolReleaseTime(db, row.symbol, slot);
  if (fromSymbol?.source === "user" || fromSymbol?.source === "web_verified") {
    return fromSymbol.time;
  }

  let resolved = fromSymbol?.time ?? resolveReleaseTime(row);
  if (!resolved) return null;

  // Pull-down: ANY observation (bounded or not) earlier than the resolved
  // time is direct evidence — layers ≥3 only (we're past user/web above).
  const allTimes = getObservationsForFamily(db, row.symbol, lookbackSinceDate())
    .map((o) => etTimeOfInstant(o.first_seen_at))
    .filter((t): t is string => t !== null)
    .filter((t) => sameSideOfNoon(t, slot));
  const earliestSeen = allTimes.length
    ? allTimes.reduce((a, b) => (a < b ? a : b))
    : null;
  if (earliestSeen && earliestSeen < resolved) {
    resolved = minusMarginFloored(earliestSeen);
  }
  return resolved;
}

/** Re-resolve release_time for future, untouched family earnings rows. */
export function applyResolvedReleaseTimeToUpcomingEvents(
  db: Database.Database,
  symbol: string,
  opts: { today?: string } = {},
): number {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  let rows: Array<{
    id: number; event_type: string; event_time: string | null;
    raw_json: string | null; symbol: string | null; release_time: string | null;
  }>;
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT id, event_type, event_time, raw_json, symbol, release_time
         FROM calendar_events
         WHERE event_type = 'earnings' AND UPPER(symbol) IN (${ph})
           AND event_date >= ? AND actual_value IS NULL AND enriched_at IS NULL
           AND COALESCE(superseded, 0) = 0`,
      )
      .all(...family, today) as typeof rows;
  } catch {
    return 0;
  }
  let updated = 0;
  const upd = db.prepare(`UPDATE calendar_events SET release_time = ? WHERE id = ?`);
  for (const r of rows) {
    const resolved = resolveEarningsReleaseTime(db, r);
    if (resolved && resolved !== r.release_time) {
      upd.run(resolved, r.id);
      updated++;
    }
  }
  return updated;
}
```

NOTE for implementer: check whether `calendar_events` has a `superseded` column referenced as `COALESCE(superseded, 0)` — it exists (used by `getEarningsForWeekDeduped`); if the exact column name differs (`superseded` vs `superseded_at`), grep `lib/queries/calendar.ts` and match it.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Integrate into the insert paths.** In `lib/mutations/calendar.ts`:
  - At the sync-upsert derivation (~line 126), replace `resolveReleaseTime({...})` with `resolveEarningsReleaseTime(db, {...})` for earnings rows — the function itself falls back to `resolveReleaseTime` internally, so it is safe to call unconditionally where a `db` handle exists: `const releaseTime = resolveEarningsReleaseTime(db, { event_type, event_time, raw_json, symbol });` (keep the existing surrounding argument shape; import from `@/lib/earnings/wire-times`).
  - In `insertCalendarEvent` (~line 525), where `input.release_time ?? deriveReleaseTime(eventTime, symbol)` runs, change `deriveReleaseTime` to consult the cascade first: pass `db` into `deriveReleaseTime(db, eventTime, symbol)` and inside it call `resolveSymbolReleaseTime(db, symbol, eventTime === "BMO" ? "bmo" : eventTime === "AMC" ? "amc" : null)`, returning its time when non-null before the existing default logic.
  - Run the calendar mutation tests: `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run tests/calendar tests/mutations` — all pre-existing tests must stay green (no-data cascade returns the same defaults).

- [ ] **Step 6: Commit**

```bash
git add lib/earnings/wire-times.ts lib/mutations/calendar.ts tests/earnings/wire-times.test.ts
git commit -F <tempfile>   # "feat(earnings): release-time resolution cascade (user/web/observed) wired into insert paths"
```

---

### Task 3: Pre-release probe pass wired into runEnrichment

**Files:**
- Create: `lib/calendar/wire-probe.ts`
- Modify: `lib/calendar/enrichment-runner.ts` (probe pass before `findCandidates`; `wire_probe_empty_at` added to both candidate SELECTs + `EnrichmentCandidate`; observation recording at the null→non-null actual transition)
- Test: `tests/calendar/wire-probe.test.ts`

**Interfaces:**
- Consumes: `stampEmptyProbe`, `recordWireObservation`, `etTimeOfInstant` (Task 1/2); `probeFinnhubActualExists(symbol: string, eventDate: string): Promise<boolean>` from `@/lib/calendar/enrich-actuals`; `composeReleaseInstant(date, hhmm): Date | null` from `@/lib/calendar/reaction-snapshot`; `getSymbolStatus` from `@/lib/queries/briefing-symbols`; `getReadThroughReporterSymbols` from `@/lib/queries/read-through-pairs`.
- Produces: `findProbeCandidates(db, now): ProbeCandidate[]`, `runWireProbePass(db, opts): Promise<{ printedEventIds: number[] }>`, constants `PROBE_WINDOW_MS = 90*60*1000`, `MAX_PROBES_PER_TICK = 6`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/calendar/wire-probe.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findProbeCandidates, runWireProbePass } from "@/lib/calendar/wire-probe";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// 2026-06-01 is EDT (UTC-4). Release 08:00 ET = 12:00Z.
const RELEASE_DATE = "2026-06-01";
const NOW_IN_WINDOW = new Date("2026-06-01T11:00:00.000Z"); // 07:00 ET, T-60m

function seedHeldEarnings(symbol: string, releaseTime = "08:00"): number {
  const acct = db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(`a-${symbol}`) as { id: number };
  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
       VALUES (?, 'stock', 'equity', 1) RETURNING id`,
    )
    .get(symbol) as { id: number };
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 100, date('now'))`,
  ).run(acct.id, sec.id);
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings',?,?,?,?,?,?,?)`,
    )
    .run(RELEASE_DATE, "BMO", releaseTime, symbol, `${symbol} earnings`, `finnhub:${symbol}:${RELEASE_DATE}`, RELEASE_DATE)
    .lastInsertRowid as number;
}

describe("findProbeCandidates", () => {
  it("selects a held reporter inside [release-90m, release)", () => {
    const id = seedHeldEarnings("XMTR");
    const c = findProbeCandidates(db, NOW_IN_WINDOW);
    expect(c.map((x) => x.id)).toEqual([id]);
  });

  it("excludes: outside window, actual already captured, non-held, macro rows", () => {
    seedHeldEarnings("XMTR");
    // outside window (T-3h)
    expect(findProbeCandidates(db, new Date("2026-06-01T09:00:00.000Z"))).toHaveLength(0);
    // at/after release the normal road owns it
    expect(findProbeCandidates(db, new Date("2026-06-01T12:00:00.000Z"))).toHaveLength(0);
    // actual captured
    db.prepare("UPDATE calendar_events SET actual_value = 'EPS 1' WHERE symbol = 'XMTR'").run();
    expect(findProbeCandidates(db, NOW_IN_WINDOW)).toHaveLength(0);
    // non-held symbol
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings',?,?,?,?,?,?,?)`,
    ).run(RELEASE_DATE, "BMO", "08:00", "ZZZZ", "ZZZZ earnings", `finnhub:ZZZZ:${RELEASE_DATE}`, RELEASE_DATE);
    // macro row with release_time in window
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, release_time, title, source_key, week_of)
       VALUES ('fred:10','cpi',?, '07:30', 'CPI', 'fred:10:x', ?)`,
    ).run(RELEASE_DATE, RELEASE_DATE);
    expect(findProbeCandidates(db, NOW_IN_WINDOW)).toHaveLength(0);
  });

  it("caps at 6, nearest release first", () => {
    for (let i = 0; i < 8; i++) {
      seedHeldEarnings(`SY${i}`, i < 4 ? "08:00" : "07:30");
    }
    const c = findProbeCandidates(db, new Date("2026-06-01T10:45:00.000Z")); // 06:45 ET
    expect(c).toHaveLength(6);
    expect(c.slice(0, 4).every((x) => x.release_time === "07:30")).toBe(true);
  });
});

describe("runWireProbePass", () => {
  it("empty probe stamps wire_probe_empty_at, no observation row", async () => {
    const id = seedHeldEarnings("XMTR");
    const probe = vi.fn(async () => false);
    const r = await runWireProbePass(db, { now: NOW_IN_WINDOW, probe });
    expect(r.printedEventIds).toEqual([]);
    expect(probe).toHaveBeenCalledWith("XMTR", RELEASE_DATE);
    const row = db.prepare("SELECT wire_probe_empty_at FROM calendar_events WHERE id = ?").get(id) as { wire_probe_empty_at: string | null };
    expect(row.wire_probe_empty_at).toBe(NOW_IN_WINDOW.toISOString());
    expect(db.prepare("SELECT COUNT(*) n FROM earnings_wire_observations").get()).toEqual({ n: 0 });
  });

  it("positive probe pulls release_time EARLIER and returns the event id", async () => {
    const id = seedHeldEarnings("XMTR"); // recorded 08:00
    const probe = vi.fn(async () => true);
    const r = await runWireProbePass(db, { now: NOW_IN_WINDOW, probe }); // 07:00 ET
    expect(r.printedEventIds).toEqual([id]);
    const row = db.prepare("SELECT release_time FROM calendar_events WHERE id = ?").get(id) as { release_time: string };
    expect(row.release_time).toBe("07:00");
  });

  it("a probe failure is swallowed (best-effort) and the pass continues", async () => {
    seedHeldEarnings("XMTR");
    seedHeldEarnings("WIX");
    const probe = vi
      .fn(async (sym: string) => {
        if (sym === "XMTR") throw new Error("finnhub 500");
        return false;
      });
    const r = await runWireProbePass(db, { now: NOW_IN_WINDOW, probe });
    expect(r.printedEventIds).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run, verify fail** (module missing)

- [ ] **Step 3: Implement `lib/calendar/wire-probe.ts`**

```typescript
/**
 * Pre-release Finnhub probe (wire-time spec 2026-08-04): earnings reporters
 * become probe-eligible from T−90m before their resolved release_time. An
 * empty probe stamps calendar_events.wire_probe_empty_at (observation
 * bounding); the first positive probe pulls the event's release_time
 * earlier (earlier-only — evidence wins) and hands the event to the normal
 * enrichment road, which fetches actuals + fires push-at-print this tick.
 *
 * Macro rows are never candidates. Probe attempts deliberately do NOT
 * stamp enrichment_attempted_at (that would interfere with post-release
 * retry pacing); the 15-min enrichment tick is the probe's pacing.
 */
import type Database from "better-sqlite3";
import { probeFinnhubActualExists } from "./enrich-actuals";
import { composeReleaseInstant } from "./reaction-snapshot";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getReadThroughReporterSymbols } from "@/lib/queries/read-through-pairs";
import { stampEmptyProbe, etTimeOfInstant } from "@/lib/earnings/wire-times";

export const PROBE_WINDOW_MS = 90 * 60 * 1000;
export const MAX_PROBES_PER_TICK = 6;

export interface ProbeCandidate {
  id: number;
  symbol: string;
  event_date: string;
  release_time: string;
  wire_probe_empty_at: string | null;
}

export function findProbeCandidates(
  db: Database.Database,
  now: Date,
): ProbeCandidate[] {
  const nowMs = now.getTime();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let rows: Array<ProbeCandidate & { source: string; event_type: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id, symbol, event_date, release_time, wire_probe_empty_at, source, event_type
         FROM calendar_events
         WHERE (source = 'finnhub' OR event_type = 'earnings')
           AND event_type = 'earnings'
           AND symbol IS NOT NULL
           AND actual_value IS NULL
           AND enriched_at IS NULL
           AND release_time IS NOT NULL
           AND COALESCE(superseded, 0) = 0
           AND event_date BETWEEN ? AND ?`,
      )
      .all(yesterday, today) as typeof rows;
  } catch {
    return [];
  }

  const inWindow = rows.filter((r) => {
    const release = composeReleaseInstant(r.event_date, r.release_time);
    if (!release) return false;
    const delta = release.getTime() - nowMs; // >0 = pre-release
    return delta > 0 && delta <= PROBE_WINDOW_MS;
  });
  if (inWindow.length === 0) return [];

  // Held / watchlist / read-through-reporter gate (the enrichment universe).
  const status = getSymbolStatus(db, inWindow.map((r) => r.symbol));
  let reporters: Set<string>;
  try {
    reporters = new Set(
      getReadThroughReporterSymbols(db).map((s: string) => s.toUpperCase()),
    );
  } catch {
    reporters = new Set();
  }
  const gated = inWindow.filter((r) => {
    const st = status[r.symbol.toUpperCase()];
    return st === "held" || st === "watchlist" || reporters.has(r.symbol.toUpperCase());
  });

  gated.sort((a, b) => a.release_time.localeCompare(b.release_time));
  return gated.slice(0, MAX_PROBES_PER_TICK).map((r) => ({
    id: r.id,
    symbol: r.symbol,
    event_date: r.event_date,
    release_time: r.release_time,
    wire_probe_empty_at: r.wire_probe_empty_at,
  }));
}

export async function runWireProbePass(
  db: Database.Database,
  opts: {
    now?: Date;
    /** DI seam for tests; defaults to the real Finnhub probe. */
    probe?: (symbol: string, eventDate: string) => Promise<boolean>;
  } = {},
): Promise<{ printedEventIds: number[] }> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? probeFinnhubActualExists;
  const printedEventIds: number[] = [];

  for (const cand of findProbeCandidates(db, now)) {
    let exists = false;
    try {
      exists = await probe(cand.symbol, cand.event_date);
    } catch (err) {
      console.warn(`[wire-probe] ${cand.symbol} probe failed:`, err);
      continue; // best-effort — no stamp on failure (not an empty result)
    }
    if (!exists) {
      stampEmptyProbe(db, cand.id, now);
      continue;
    }
    // Print is out early: pull release_time to the observed instant
    // (earlier-only — evidence wins over any recorded slot).
    const observed = etTimeOfInstant(now.toISOString());
    if (observed && observed < cand.release_time) {
      db.prepare(`UPDATE calendar_events SET release_time = ? WHERE id = ?`).run(
        observed,
        cand.id,
      );
      console.log(
        `[wire-probe] ${cand.symbol} printed early — release_time ${cand.release_time} → ${observed}`,
      );
    }
    printedEventIds.push(cand.id);
  }
  return { printedEventIds };
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Wire into `runEnrichment` + record observations at the transition.** In `lib/calendar/enrichment-runner.ts`:
  1. Add `wire_probe_empty_at: string | null;` to `EnrichmentCandidate` and add the column to BOTH SELECTs in `findCandidates`.
  2. At the top of `runEnrichment` (after the `upgradeReactionToTws` early-return, before `findCandidates`):

```typescript
  // Wire-time probe (spec 2026-08-04): pre-release Finnhub check for
  // held/watchlist/reporter earnings inside T−90m. Early prints get their
  // release_time pulled to now and enter THIS tick's candidate list (the
  // normal window filter would make them wait for the next tick).
  let probePrinted: number[] = [];
  if (opts.eventId == null) {
    try {
      probePrinted = (await runWireProbePass(db, { now: opts.now })).printedEventIds;
    } catch (err) {
      console.warn("[enrichment] wire-probe pass failed:", err);
    }
  }

  const candidates = findCandidates(db, opts);
  for (const id of probePrinted) {
    if (candidates.some((c) => c.id === id)) continue;
    const row = findCandidates(db, { ...opts, eventId: id })[0];
    if (row) candidates.unshift(row);
  }
```

  (`findCandidates` with `eventId` fetches the row directly, bypassing the window filter — existing behavior.) Import `runWireProbePass` from `./wire-probe`. Note `findCandidates`'s two SELECTs must both carry `wire_probe_empty_at` or the eventId path returns `undefined` for it.
  3. Record the observation on the null→non-null actual transition — insert immediately BEFORE the existing push-at-print block, same guard shape:

```typescript
      // Wire-time observation (spec 2026-08-04): record the first-seen
      // instant on the null→non-null actual transition — covers both the
      // probe road (bounded via wire_probe_empty_at) and the plain
      // post-release road (typically unbounded). Best-effort.
      if (
        isEarnings &&
        event.symbol &&
        event.actual_value == null &&
        actualResult.actual != null
      ) {
        try {
          recordWireObservation(db, {
            symbol: event.symbol,
            eventDate: event.event_date,
            eventId: event.id,
            firstSeenAt: (opts.now ?? new Date()).toISOString(),
            lastEmptyProbeAt: event.wire_probe_empty_at ?? null,
          });
        } catch (err) {
          console.warn(`[wire-probe] observation record failed for ${event.id}:`, err);
        }
      }
```

  Import `recordWireObservation` from `@/lib/earnings/wire-times`.

- [ ] **Step 6: Integration test** — append to `tests/calendar/wire-probe.test.ts` a test driving `runEnrichment` end-to-end with a mocked probe + mocked `fetchActualForEvent`:

```typescript
import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import * as enrichActuals from "@/lib/calendar/enrich-actuals";

describe("runEnrichment wire-probe integration", () => {
  it("an early print is captured THIS tick with a bounded observation", async () => {
    const id = seedHeldEarnings("XMTR"); // 08:00 slot
    // Prior tick stamped an empty probe at 06:45 ET.
    db.prepare("UPDATE calendar_events SET wire_probe_empty_at = ? WHERE id = ?")
      .run("2026-06-01T10:45:00.000Z", id);
    vi.spyOn(enrichActuals, "probeFinnhubActualExists").mockResolvedValue(true);
    vi.spyOn(enrichActuals, "fetchActualForEvent").mockResolvedValue({
      actual: "EPS 0.10 · Rev 120000000",
      consensus: null,
    });

    const results = await runEnrichment(db, { now: NOW_IN_WINDOW }); // 07:00 ET

    const mine = results.find((r) => r.eventId === id);
    expect(mine?.actual).toBe("EPS 0.10 · Rev 120000000");
    const row = db
      .prepare("SELECT release_time, actual_value FROM calendar_events WHERE id = ?")
      .get(id) as { release_time: string; actual_value: string };
    expect(row.release_time).toBe("07:00"); // pulled earlier
    expect(row.actual_value).toBe("EPS 0.10 · Rev 120000000");
    const obs = db.prepare("SELECT * FROM earnings_wire_observations").all() as Array<Record<string, unknown>>;
    expect(obs).toHaveLength(1);
    expect(obs[0].last_empty_probe_at).toBe("2026-06-01T10:45:00.000Z"); // bounded
  });
});
```

  NOTE for implementer: `enrichment-runner.ts` imports `probeFinnhubActualExists` via `wire-probe.ts`'s default; the `vi.spyOn` module-namespace approach works only if `wire-probe.ts` calls `probeFinnhubActualExists` through the imported binding at call time (it does — `opts.probe ?? probeFinnhubActualExists` resolves per call). If the spy doesn't take effect under the bundler, switch the test to `vi.mock("@/lib/calendar/enrich-actuals", ...)` with `importOriginal` spread (precedent: `tests/calendar/email-sweep.test.ts` lines 83–90).

- [ ] **Step 7: Run the new tests + the pre-existing enrichment suite**

Run: `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run tests/calendar/wire-probe.test.ts tests/calendar/enrichment-runner.test.ts tests/calendar/email-sweep.test.ts`
Expected: all PASS (probe pass is a no-op in fixtures with no pre-release candidates).

- [ ] **Step 8: Commit** — "feat(earnings): pre-release wire probe — early prints captured same tick, observations recorded"

---

### Task 4: Verifier exact-time extension (EarningsWhispers jump-start)

**Files:**
- Modify: `lib/calendar/verify-earnings-dates.ts` (`DateVerdict.exact_time`, prompt, `normalizeVerdict`, new `applyExactTimeVerdict`, wiring in `runEarningsDateVerification`)
- Test: `tests/calendar/verify-earnings-dates.test.ts` (append; file exists — if named differently, grep `runEarningsDateVerification` under `tests/`)

**Interfaces:**
- Consumes: `resolveSymbolReleaseTime`, `hasBoundedObservations`, `getSymbolReleaseTimeRow`, `upsertSymbolReleaseTime`, `applyResolvedReleaseTimeToUpcomingEvents`, `EARLIEST_PLAUSIBLE_ET`, `LATEST_PLAUSIBLE_ET` (Task 2).
- Produces: `DateVerdict` gains `exact_time: string | null`; `buildDateVerificationPrompt(candidates, todayStr, needTimeSymbols?: Set<string>)`; `applyExactTimeVerdict(db, verdict: DateVerdict, candidate: DateVerificationCandidate): boolean`; `needsExactTime(db, symbol: string, eventDate: string): boolean` (exported from `verify-earnings-dates.ts`).

- [ ] **Step 1: Write failing tests** (append to the verifier test file)

```typescript
import {
  buildDateVerificationPrompt,
  parseDateVerdicts,
  applyExactTimeVerdict,
  needsExactTime,
} from "@/lib/calendar/verify-earnings-dates";
import {
  upsertSymbolReleaseTime,
  recordWireObservation,
  getSymbolReleaseTimeRow,
} from "@/lib/earnings/wire-times";

describe("exact-time jump-start (wire-time spec 2026-08-04)", () => {
  it("needsExactTime: true when no override, no bounded obs, no fresh web row", () => {
    expect(needsExactTime(db, "XMTR", "2026-11-05")).toBe(true);
  });

  it("needsExactTime: false with a user override / bounded obs / fresh web row", () => {
    upsertSymbolReleaseTime(db, { symbol: "AAA", releaseTime: "07:00", source: "user" });
    expect(needsExactTime(db, "AAA", "2026-11-05")).toBe(false);

    recordWireObservation(db, {
      symbol: "BBB", eventDate: "2026-08-04", eventId: null,
      firstSeenAt: "2026-08-04T11:15:00.000Z",
      lastEmptyProbeAt: "2026-08-04T11:00:00.000Z",
    });
    expect(needsExactTime(db, "BBB", "2026-11-05")).toBe(false);

    upsertSymbolReleaseTime(db, {
      symbol: "CCC", releaseTime: "07:10", source: "web_verified", verifiedForDate: "2026-11-05",
    });
    expect(needsExactTime(db, "CCC", "2026-11-05")).toBe(false);
    // stale web row (verified for an EARLIER print) → true again
    expect(needsExactTime(db, "CCC", "2027-02-10")).toBe(true);
  });

  it("prompt asks for exact_time only for flagged symbols and names EarningsWhispers", () => {
    const candidates = [
      { id: 1, symbol: "XMTR", event_date: "2026-11-05", event_time: "BMO", release_time: "08:00", source: "finnhub" },
      { id: 2, symbol: "AAPL", event_date: "2026-11-06", event_time: "AMC", release_time: "16:30", source: "finnhub" },
    ];
    const prompt = buildDateVerificationPrompt(candidates, "2026-11-01", new Set(["XMTR"]));
    expect(prompt).toContain("exact_time");
    expect(prompt).toContain("EarningsWhispers");
    expect(prompt).toContain("XMTR — vendor says 2026-11-05, bmo (also find the exact expected report time)");
    expect(prompt).not.toContain("AAPL — vendor says 2026-11-06, amc (also find");
  });

  it("parseDateVerdicts carries a valid exact_time through and nulls garbage", () => {
    const text = `[
      {"symbol":"XMTR","confirmed_date":"2026-11-05","slot":"bmo","confidence":"confirmed","source":"ew","exact_time":"07:05"},
      {"symbol":"WIX","confirmed_date":null,"slot":null,"confidence":"unconfirmed","source":null,"exact_time":"25:99"}
    ]`;
    const v = parseDateVerdicts(text);
    expect(v[0].exact_time).toBe("07:05");
    expect(v[1].exact_time).toBeNull();
  });

  it("applyExactTimeVerdict upserts web_verified and re-resolves upcoming rows; rejects out-of-range; never touches a user row", () => {
    const candidate = { id: 1, symbol: "XMTR", event_date: "2026-11-05", event_time: "BMO", release_time: "08:00", source: "finnhub" };
    // seed the upcoming event row so the apply pass has something to update
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings','2026-11-05','BMO','08:00','XMTR','XMTR earnings','finnhub:XMTR:2026-11-05','2026-11-02')`,
    ).run();

    const ok = applyExactTimeVerdict(
      db,
      { symbol: "XMTR", confirmed_date: "2026-11-05", slot: "bmo", confidence: "confirmed", source: "EarningsWhispers", exact_time: "07:05" },
      candidate,
    );
    expect(ok).toBe(true);
    expect(getSymbolReleaseTimeRow(db, "XMTR")).toMatchObject({
      release_time: "07:05", source: "web_verified", verified_for_date: "2026-11-05",
    });
    expect(
      (db.prepare("SELECT release_time FROM calendar_events WHERE symbol='XMTR'").get() as { release_time: string }).release_time,
    ).toBe("07:05");

    // out-of-range time rejected
    expect(
      applyExactTimeVerdict(db, { symbol: "WIX", confirmed_date: null, slot: null, confidence: "unconfirmed", source: null, exact_time: "02:00" },
        { ...candidate, symbol: "WIX" }),
    ).toBe(false);

    // user row never overwritten
    upsertSymbolReleaseTime(db, { symbol: "AAA", releaseTime: "07:00", source: "user" });
    applyExactTimeVerdict(db, { symbol: "AAA", confirmed_date: null, slot: "bmo", confidence: "confirmed", source: "ew", exact_time: "06:30" },
      { ...candidate, symbol: "AAA" });
    expect(getSymbolReleaseTimeRow(db, "AAA")).toMatchObject({ release_time: "07:00", source: "user" });
  });
});
```

(Adopt the surrounding test file's existing `db` fixture/`beforeEach`; if it uses a different seed helper for events, reuse it.)

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement.** In `lib/calendar/verify-earnings-dates.ts`:
  1. `DateVerdict` gains `exact_time: string | null;`.
  2. `normalizeVerdict` parses it: valid only when `/^\d{2}:\d{2}$/` and `>= EARLIEST_PLAUSIBLE_ET && <= LATEST_PLAUSIBLE_ET`, else `null`.
  3. `buildDateVerificationPrompt(candidates, todayStr, needTimeSymbols?: Set<string>)` — flagged candidate lines get the suffix ` (also find the exact expected report time)`; when any symbol is flagged, append to the rules paragraph:

```
For symbols marked "(also find the exact expected report time)", also report "exact_time" as the expected wall-clock ET time of the press release in 24h "HH:MM" (e.g. "07:05"). EarningsWhispers (earningswhispers.com) is the preferred source for expected report times; a company IR announcement or prior-quarter BusinessWire timestamps also count. If you cannot find a specific time, set "exact_time" to null — NEVER guess one.
```

  and extend the JSON schema line with `"exact_time":"HH:MM"`.
  4. New exports:

```typescript
export function needsExactTime(
  db: Database.Database,
  symbol: string,
  eventDate: string,
): boolean {
  if (hasBoundedObservations(db, symbol)) return false;
  const row = getSymbolReleaseTimeRow(db, symbol);
  if (row?.source === "user") return false;
  if (row?.source === "web_verified" && row.verified_for_date && row.verified_for_date >= eventDate) {
    return false;
  }
  return true;
}

export function applyExactTimeVerdict(
  db: Database.Database,
  verdict: DateVerdict,
  candidate: DateVerificationCandidate,
): boolean {
  const t = verdict.exact_time;
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return false;
  if (t < EARLIEST_PLAUSIBLE_ET || t > LATEST_PLAUSIBLE_ET) return false;
  const existing = getSymbolReleaseTimeRow(db, verdict.symbol);
  if (existing?.source === "user") return false;
  upsertSymbolReleaseTime(db, {
    symbol: verdict.symbol,
    releaseTime: t,
    source: "web_verified",
    note: verdict.source ? `verified via ${verdict.source}` : "date-verification pass",
    verifiedForDate: verdict.confirmed_date ?? candidate.event_date,
  });
  applyResolvedReleaseTimeToUpcomingEvents(db, verdict.symbol);
  return true;
}
```

  5. In `runEarningsDateVerification`, before building the prompt compute `const needTime = new Set(candidates.filter((c) => needsExactTime(db, c.symbol, c.event_date)).map((c) => c.symbol));` and pass it to `buildDateVerificationPrompt`; after verdicts are parsed and date-applied, loop `for (const v of verdicts) { const c = candidates.find((x) => x.symbol === v.symbol); if (c && needTime.has(v.symbol)) applyExactTimeVerdict(db, v, c); }` — exact-time application runs in BOTH dry-run and apply modes? NO — respect the pass's `apply` flag exactly like date corrections: only call `applyExactTimeVerdict` when `apply === true`; in dry-run, log what would be stored.

- [ ] **Step 4: Run the verifier test file + full calendar tests, verify pass**

- [ ] **Step 5: Commit** — "feat(earnings): date-verification pass jump-starts unknown release times via web search (EarningsWhispers-preferred)"

---

### Task 5: Override API route + EarningsDateChip "Reports at" editor

**Files:**
- Create: `app/api/earnings/release-time/route.ts`
- Modify: `app/dashboard/today/EarningsDateChip.tsx` (passive popover only)
- Test: `tests/earnings/release-time-route.test.ts` (test the lib functions the route composes; route stays thin)

**Interfaces:**
- Consumes: `resolveSymbolReleaseTime`, `upsertSymbolReleaseTime`, `clearUserReleaseTime`, `getSymbolReleaseTimeRow`, `getObservationsForFamily`, `applyResolvedReleaseTimeToUpcomingEvents`, `EARLIEST_PLAUSIBLE_ET`, `LATEST_PLAUSIBLE_ET`.
- Produces: `GET /api/earnings/release-time?symbol=XMTR&slot=bmo` → `{ success: true, data: { symbol, resolved: { time, source } | null, override: SymbolReleaseTimeRow | null, observations: WireObservationRow[] } }`; `POST` body `{ symbol, releaseTime: "HH:MM" | null }` → `{ success: true, data: { cleared?: boolean, updatedEvents: number } }`.

- [ ] **Step 1: Route implementation** (thin — validation + composition; in-app, no cron auth, `{success, data|error}` envelope):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  resolveSymbolReleaseTime,
  upsertSymbolReleaseTime,
  clearUserReleaseTime,
  getSymbolReleaseTimeRow,
  getObservationsForFamily,
  applyResolvedReleaseTimeToUpcomingEvents,
  EARLIEST_PLAUSIBLE_ET,
  LATEST_PLAUSIBLE_ET,
} from "@/lib/earnings/wire-times";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase();
  const slotRaw = req.nextUrl.searchParams.get("slot");
  const slot = slotRaw === "bmo" || slotRaw === "amc" ? slotRaw : null;
  if (!symbol) {
    return NextResponse.json({ success: false, error: "symbol is required" }, { status: 400 });
  }
  const db = getDb();
  const since = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return NextResponse.json({
    success: true,
    data: {
      symbol,
      resolved: resolveSymbolReleaseTime(db, symbol, slot),
      override: getSymbolReleaseTimeRow(db, symbol),
      observations: getObservationsForFamily(db, symbol, since),
    },
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { symbol?: string; releaseTime?: string | null }
    | null;
  const symbol = body?.symbol?.trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ success: false, error: "symbol is required" }, { status: 400 });
  }
  const db = getDb();
  if (body?.releaseTime == null) {
    const cleared = clearUserReleaseTime(db, symbol);
    const updatedEvents = cleared ? applyResolvedReleaseTimeToUpcomingEvents(db, symbol) : 0;
    return NextResponse.json({ success: true, data: { cleared, updatedEvents } });
  }
  const t = body.releaseTime;
  if (!/^\d{2}:\d{2}$/.test(t) || t < EARLIEST_PLAUSIBLE_ET || t > LATEST_PLAUSIBLE_ET) {
    return NextResponse.json(
      { success: false, error: `releaseTime must be HH:MM ET between ${EARLIEST_PLAUSIBLE_ET} and ${LATEST_PLAUSIBLE_ET}` },
      { status: 400 },
    );
  }
  upsertSymbolReleaseTime(db, { symbol, releaseTime: t, source: "user", note: "set in app" });
  const updatedEvents = applyResolvedReleaseTimeToUpcomingEvents(db, symbol);
  return NextResponse.json({ success: true, data: { updatedEvents } });
}
```

  NOTE for implementer: check how sibling routes obtain the db (`import { getDb } from "@/lib/db"` vs a default export) — copy `app/api/earnings/correct-date/route.ts`'s import exactly.

- [ ] **Step 2: Failing lib tests** (`tests/earnings/release-time-route.test.ts` — POST validation lives in lib usage; test the composition pieces the route relies on that aren't yet covered):

```typescript
// clearUserReleaseTime leaves web_verified rows alone; upsert user replaces web row
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertSymbolReleaseTime,
  clearUserReleaseTime,
  getSymbolReleaseTimeRow,
} from "@/lib/earnings/wire-times";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

it("clearUserReleaseTime removes only a user row", () => {
  upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:10", source: "web_verified" });
  expect(clearUserReleaseTime(db, "XMTR")).toBe(false);
  expect(getSymbolReleaseTimeRow(db, "XMTR")?.source).toBe("web_verified");

  upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
  expect(clearUserReleaseTime(db, "XMTR")).toBe(true);
  expect(getSymbolReleaseTimeRow(db, "XMTR")).toBeNull(); // PK row replaced then deleted
});
```

  Run to see it fail only if behavior is missing; if it passes immediately (Task 2 already implements), note that in the task report — the route file itself is compile-checked by `npx tsc --noEmit` and exercised in Step 4's browser verification.

- [ ] **Step 3: Chip editor.** In `EarningsDateChip.tsx`, passive (non-conflict) popover: after the "Date is wrong?" block, add a "Reports at" section. State + fetch-on-open + save/clear:

```tsx
// new state hooks (top of component, with the others)
const [rt, setRt] = useState<{
  resolved: { time: string; source: string } | null;
  override: { source: string; release_time: string } | null;
} | null>(null);
const [rtEdit, setRtEdit] = useState("");
const [rtSaving, setRtSaving] = useState(false);
const [rtMsg, setRtMsg] = useState<string | null>(null);

const slotParam = releaseTime && releaseTime < "12:00" ? "bmo" : "amc";

async function loadReleaseTime() {
  try {
    const res = await fetch(
      `/api/earnings/release-time?symbol=${encodeURIComponent(symbol)}&slot=${slotParam}`,
    );
    const body = await res.json().catch(() => null);
    if (body?.success) {
      setRt(body.data);
      setRtEdit(body.data.override?.release_time ?? body.data.resolved?.time ?? releaseTime ?? "");
    }
  } catch {
    /* popover shows the stored releaseTime fallback */
  }
}

async function saveReleaseTime(value: string | null) {
  if (rtSaving) return;
  setRtSaving(true);
  setRtMsg(null);
  try {
    const res = await fetch("/api/earnings/release-time", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, releaseTime: value }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      setRtMsg(body?.error ?? `Save failed: server returned ${res.status}.`);
      return;
    }
    setRtMsg(
      value === null
        ? `Override cleared · ${body.data.updatedEvents} upcoming event(s) re-resolved`
        : `Saved · ${body.data.updatedEvents} upcoming event(s) updated`,
    );
    await loadReleaseTime();
    startTransition(() => router.refresh());
  } catch {
    setRtMsg("Save failed: could not reach the server.");
  } finally {
    setRtSaving(false);
  }
}
```

  The passive-status open handler becomes `onClick={() => { setOpen((o) => !o); if (!open) void loadReleaseTime(); }}`. Popover JSX addition (after the fix-date row, before `confirmError`):

```tsx
<div className="mt-2 pt-1.5 border-t border-edge">
  <p className="text-[11px] text-ink mb-1">
    Reports at{" "}
    <span className="font-mono">{rt?.resolved?.time ?? releaseTime ?? "—"}</span>
    {rt?.resolved && (
      <span className="text-ink-faint"> · {rt.resolved.source}</span>
    )}
  </p>
  <div className="flex items-center gap-1">
    <input
      type="time"
      value={rtEdit}
      onChange={(e) => setRtEdit(e.target.value)}
      className="text-[10px] bg-raised rounded px-1 py-0.5 flex-1 min-w-0 text-ink"
      aria-label="Standing release-time override (ET)"
    />
    <button
      type="button"
      disabled={rtSaving || !rtEdit}
      onClick={() => saveReleaseTime(rtEdit)}
      className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 disabled:opacity-40 whitespace-nowrap"
    >
      Save
    </button>
    {rt?.override?.source === "user" && (
      <button
        type="button"
        disabled={rtSaving}
        onClick={() => saveReleaseTime(null)}
        className="text-[10px] font-mono px-1.5 py-0.5 rounded text-ink-dim bg-raised hover:bg-muted disabled:opacity-40"
      >
        Clear
      </button>
    )}
  </div>
  {rtMsg && <p className="text-[10px] text-ink-dim pt-1">{rtMsg}</p>}
</div>
```

- [ ] **Step 4: Verify** — `npx tsc --noEmit` clean; then browser-verify with the agent-browser agent against the dev server if one is running (popover opens, "Reports at" line renders, save round-trips). If no dev server is available in the worktree, note it for the final session verification instead of skipping silently.

- [ ] **Step 5: Commit** — "feat(earnings): release-time override editor in EarningsDateChip + /api/earnings/release-time"

---

### Task 6: Full-suite gate + docs

**Files:**
- Modify: `CLAUDE.md` (one convention bullet), `docs/plans/TODO.md` (close the wire-time item)

- [ ] **Step 1: Full suites**

Run: `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run` and `ANTHROPIC_API_KEY=test-not-a-real-key npx vitest run --root workers/cron` and `npx tsc --noEmit`.
Expected: all green. Fix regressions before proceeding.

- [ ] **Step 2: CLAUDE.md bullet** — add to the Conventions section, after the "Earnings release times" bullet:

```markdown
- **Wire-time tracking (migration 076, spec 2026-08-04)**: earnings release times resolve through `lib/earnings/wire-times.ts::resolveEarningsReleaseTime` — explicit HH:MM event_time → user standing override (`symbol_release_times`, source `user`, edited in the EarningsDateChip popover / `POST /api/earnings/release-time`) → `web_verified` row (EarningsWhispers jump-start via the daily date-verification pass; honored only while the symbol has ZERO bounded observations) → derived from bounded `earnings_wire_observations` (earliest first-seen − 10 min, floored to :05, 04:00 floor) → legacy `SYMBOL_RELEASE_TIMES_ET` → BMO/AMC defaults; any observation earlier than a layer-≥3 resolution pulls it down. `runEnrichment` runs a pre-release Finnhub probe (T−90m, cap 6/tick, held/watchlist/reporter only) — empty probes stamp `calendar_events.wire_probe_empty_at` (observation bounding), a positive probe pulls the event's `release_time` earlier and captures actuals SAME tick. Observations record on the null→non-null actual transition (bounded only when an empty probe ran ≤30 min prior — a late-waking Mac records honestly as "at or before"). Macro rows are untouched everywhere. Probe attempts never stamp `enrichment_attempted_at`.
```

- [ ] **Step 3: TODO.md** — flip the wire-time item to `[x]` with a one-line resolution pointing at the spec + this plan.

- [ ] **Step 4: Commit** — "docs: wire-time tracking conventions + TODO close"

---

## Self-Review Notes

- **Spec coverage**: migration/tables (T1), bounded-observation rule (T1/T3), cascade incl. slot guard + floor + pull-down (T2), insert-path integration + upcoming-events re-resolve (T2), probe window + same-tick capture + earlier-only release_time pull + push-at-print via normal road (T3), EarningsWhispers jump-start with only-when-unknown gating + freshness + range guard + apply-flag respect (T4), UI + route (T5), docs (T6). Deviation from spec noted in header: db passed explicitly instead of a registration seam (call sites all have `db`).
- **Types**: `WireObservationRow`/`RecordObservationInput`/`SymbolReleaseTimeRow`/`ProbeCandidate` defined once in their owning modules; later tasks import, never redeclare.
- **Known checks left to implementers** (explicitly marked NOTE in tasks): `superseded` column name, db import style in routes, `vi.spyOn` vs `vi.mock` for the probe seam.
