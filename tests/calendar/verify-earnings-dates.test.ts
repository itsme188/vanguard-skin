/**
 * Task 3 of the earnings date-verification plan: pure candidate selection,
 * prompt building, and verdict parsing for lib/calendar/verify-earnings-dates.ts.
 *
 * No Claude calls / no orchestrator here — that's Task 4. This file tests only
 * the pure functions: findDateVerificationCandidates, buildDateVerificationPrompt,
 * parseDateVerdicts, effectiveSlot.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findDateVerificationCandidates,
  buildDateVerificationPrompt,
  parseDateVerdicts,
  effectiveSlot,
  type DateVerificationCandidate,
} from "@/lib/calendar/verify-earnings-dates";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ── Seeding helpers (mirrors tests/queries/earnings-hub.test.ts idiom) ──────

function getAccount(name: string): number {
  const row = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (!row) throw new Error(`No account ${name} (default seed missing?)`);
  return row.id;
}

function seedSecurity(symbol: string, type = "stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`, type).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, qty: number, asOf = "2026-08-01"): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)",
  ).run(accountId, securityId, qty, asOf);
}

function seedWatchlist(securityId: number, active = 1): void {
  db.prepare("INSERT INTO watchlist (security_id, is_active) VALUES (?, ?)").run(
    securityId,
    active,
  );
}

function seedReaderPair(reporter: string, target: string): void {
  db.prepare(
    `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, hypothesis, weight, created_at)
     VALUES (?, ?, 'test hypothesis', 1.0, datetime('now'))`,
  ).run(reporter, target);
}

let eventCounter = 0;
function seedEvent(overrides: {
  symbol: string | null;
  event_date: string;
  event_time?: string | null;
  release_time?: string | null;
  source?: string;
  event_type?: string;
  superseded?: number;
  actual_value?: string | null;
  date_verified_at?: string | null;
}): number {
  eventCounter += 1;
  const sourceKey = `test:${overrides.symbol ?? "macro"}:${overrides.event_date}:${eventCounter}`;
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          superseded, actual_value, date_verified_at, source_key, week_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.source ?? "finnhub",
      overrides.event_type ?? "earnings",
      overrides.event_date,
      overrides.event_time ?? "BMO",
      overrides.release_time ?? null,
      `${overrides.symbol ?? "macro"} earnings`,
      overrides.symbol ?? null,
      overrides.superseded ?? 0,
      overrides.actual_value ?? null,
      overrides.date_verified_at ?? null,
      sourceKey,
      "2026-08-03",
    ).lastInsertRowid as number;
}

const NOW = new Date("2026-08-02T14:00:00Z"); // ET Sunday-ish; horizon math uses todayET

// ── findDateVerificationCandidates ──────────────────────────────────────────

describe("findDateVerificationCandidates", () => {
  it("selects held + watchlist + read-through-reporter earnings inside the horizon", () => {
    const acct = getAccount("Vanguard Taxable");

    const heldSec = seedSecurity("HELD");
    seedHolding(acct, heldSec, 100);
    seedEvent({ symbol: "HELD", event_date: "2026-08-05" });

    const watchSec = seedSecurity("WTCH");
    seedWatchlist(watchSec);
    seedEvent({ symbol: "WTCH", event_date: "2026-08-06" });

    // Not held, not watchlisted, but a read-through reporter of a target.
    seedReaderPair("RPTR", "HELD");
    seedEvent({ symbol: "RPTR", event_date: "2026-08-04" });

    // Neither held, watchlisted, nor a reporter — must be excluded.
    seedSecurity("NONE");
    seedEvent({ symbol: "NONE", event_date: "2026-08-04" });

    const result = findDateVerificationCandidates(db, { now: NOW });
    const symbols = result.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["HELD", "RPTR", "WTCH"]);
  });

  it("skips rows with actuals, superseded rows, already-verified rows, out-of-horizon rows", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("SKIP");
    seedHolding(acct, sec, 10);

    // Valid candidate — the control.
    seedEvent({ symbol: "SKIP", event_date: "2026-08-04" });
    // Already has a captured actual.
    seedEvent({ symbol: "SKIP", event_date: "2026-08-05", actual_value: "EPS 1.20 · Rev 500M" });
    // Superseded row (non-canonical duplicate in a cross-check cluster).
    seedEvent({ symbol: "SKIP", event_date: "2026-08-06", superseded: 1 });
    // Already verified.
    seedEvent({
      symbol: "SKIP",
      event_date: "2026-08-07",
      date_verified_at: "2026-08-01 10:00:00",
    });
    // Out of horizon (default horizonDays=7 from 2026-08-02 → 2026-08-09).
    seedEvent({ symbol: "SKIP", event_date: "2026-08-20" });

    const result = findDateVerificationCandidates(db, { now: NOW });
    expect(result.map((r) => r.event_date)).toEqual(["2026-08-04"]);
  });

  it("family-dedupes (GOOG/GOOGL) keeping the earliest-id row", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("GOOG");
    seedHolding(acct, sec, 5);

    seedEvent({ symbol: "GOOG", event_date: "2026-08-04" });
    seedEvent({ symbol: "GOOGL", event_date: "2026-08-04" });

    const result = findDateVerificationCandidates(db, { now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("GOOG");
  });

  it("caps at limit ordered by event_date asc", () => {
    const acct = getAccount("Vanguard Taxable");
    for (const [symbol, date] of [
      ["AAA", "2026-08-06"],
      ["BBB", "2026-08-04"],
      ["CCC", "2026-08-05"],
    ] as const) {
      const sec = seedSecurity(symbol);
      seedHolding(acct, sec, 1);
      seedEvent({ symbol, event_date: date });
    }

    const result = findDateVerificationCandidates(db, { now: NOW, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.event_date)).toEqual(["2026-08-04", "2026-08-05"]);
  });
});

// ── effectiveSlot ────────────────────────────────────────────────────────

describe("effectiveSlot", () => {
  it("derives bmo from event_time BMO, amc from AMC, falls back to release_time, null when neither", () => {
    expect(effectiveSlot({ event_time: "BMO", release_time: null })).toBe("bmo");
    expect(effectiveSlot({ event_time: "AMC", release_time: null })).toBe("amc");
    expect(effectiveSlot({ event_time: null, release_time: "08:00" })).toBe("bmo");
    expect(effectiveSlot({ event_time: null, release_time: "16:15" })).toBe("amc");
    expect(effectiveSlot({ event_time: null, release_time: null })).toBe(null);
    expect(effectiveSlot({ event_time: "TAS", release_time: null })).toBe(null);
  });
});

// ── buildDateVerificationPrompt ─────────────────────────────────────────────

describe("buildDateVerificationPrompt", () => {
  it("renders the exact prompt shape with per-candidate slot lines", () => {
    const candidates: DateVerificationCandidate[] = [
      {
        id: 1,
        symbol: "HELD",
        event_date: "2026-08-05",
        event_time: "BMO",
        release_time: null,
        source: "finnhub",
      },
      {
        id: 2,
        symbol: "WTCH",
        event_date: "2026-08-06",
        event_time: null,
        release_time: null,
        source: "nasdaq",
      },
    ];

    const prompt = buildDateVerificationPrompt(candidates, "2026-08-02");

    expect(prompt).toContain("Today is 2026-08-02.");
    expect(prompt).toContain("- HELD — vendor says 2026-08-05, bmo");
    expect(prompt).toContain("- WTCH — vendor says 2026-08-06, unknown slot");
    expect(prompt).toContain("Respond ONLY with a JSON array");
    expect(prompt).toContain('"confidence":"confirmed" ONLY with an explicit company announcement');
    expect(prompt).toContain("NEVER invent a date.");
  });
});

// ── parseDateVerdicts ────────────────────────────────────────────────────

describe("parseDateVerdicts", () => {
  it("parses a clean JSON array", () => {
    const text = JSON.stringify([
      {
        symbol: "HELD",
        confirmed_date: "2026-08-05",
        slot: "bmo",
        confidence: "confirmed",
        source: "ir.example.com",
      },
    ]);
    const result = parseDateVerdicts(text);
    expect(result).toEqual([
      {
        symbol: "HELD",
        confirmed_date: "2026-08-05",
        slot: "bmo",
        confidence: "confirmed",
        source: "ir.example.com",
      },
    ]);
  });

  it("survives a prose preamble before the array (extractJsonArray)", () => {
    const text =
      'I checked each company\'s investor relations page. Here is the result:\n' +
      JSON.stringify([
        {
          symbol: "WTCH",
          confirmed_date: null,
          slot: null,
          confidence: "unconfirmed",
          source: null,
        },
      ]);
    const result = parseDateVerdicts(text);
    expect(result).toEqual([
      { symbol: "WTCH", confirmed_date: null, slot: null, confidence: "unconfirmed", source: null },
    ]);
  });

  it("survives raw control chars inside strings (C0 collapse retry)", () => {
    // A real unescaped newline inside a JSON string literal — JSON.parse
    // rejects this with "Bad control character in string literal"; the C0
    // collapse retry turns it into whitespace and the parse succeeds.
    const text =
      '[{"symbol":"HELD","confirmed_date":"2026-08-05","slot":"bmo","confidence":"confirmed","source":"press release\nsecond line"}]';
    const result = parseDateVerdicts(text);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("HELD");
    expect(result[0].confirmed_date).toBe("2026-08-05");
  });

  it("drops malformed entries (bad date shape, unknown slot) instead of throwing", () => {
    const text = JSON.stringify([
      {
        symbol: "GOOD",
        confirmed_date: "2026-08-05",
        slot: "bmo",
        confidence: "confirmed",
        source: "ir",
      },
      {
        symbol: "BADDATE",
        confirmed_date: "08/05/2026",
        slot: "bmo",
        confidence: "confirmed",
        source: "ir",
      },
      {
        symbol: "BADSLOT",
        confirmed_date: "2026-08-05",
        slot: "pre-market",
        confidence: "confirmed",
        source: "ir",
      },
    ]);
    expect(() => parseDateVerdicts(text)).not.toThrow();
    const result = parseDateVerdicts(text);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("GOOD");
  });
});
