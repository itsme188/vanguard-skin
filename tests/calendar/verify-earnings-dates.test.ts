/**
 * Task 3 of the earnings date-verification plan: pure candidate selection,
 * prompt building, and verdict parsing for lib/calendar/verify-earnings-dates.ts.
 *
 * Task 4 extends this file: applyVerdict (pure DB apply-semantics) and the
 * runEarningsDateVerification orchestrator (candidates → prompt → AI fetch →
 * parse → apply → pushover summary), both network-free in tests via the
 * fetchVerdicts DI seam.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import {
  findDateVerificationCandidates,
  buildDateVerificationPrompt,
  parseDateVerdicts,
  effectiveSlot,
  applyVerdict,
  applyExactTimeVerdict,
  needsExactTime,
  runEarningsDateVerification,
  maybeRunDailyDateVerification,
  defaultFetchDateVerdicts,
  type DateVerificationCandidate,
  type DateVerdict,
} from "@/lib/calendar/verify-earnings-dates";
import {
  upsertSymbolReleaseTime,
  recordWireObservation,
  getSymbolReleaseTimeRow,
} from "@/lib/earnings/wire-times";
import { getRawAnthropicClient } from "@/lib/ai/provider";

const pushover = vi.fn(async (..._args: unknown[]) => ({ sent: true }));
vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendPushover: (...a: unknown[]) => pushover(...a),
}));
vi.mock("@/lib/ai/provider", () => ({ getRawAnthropicClient: vi.fn() }));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  pushover.mockClear();
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

function getEventRow(id: number):
  | {
      id: number;
      symbol: string | null;
      event_date: string;
      event_time: string | null;
      source: string;
      actual_value: string | null;
      date_verified_at: string | null;
      date_verification_note: string | null;
    }
  | undefined {
  return db
    .prepare(
      `SELECT id, symbol, event_date, event_time, source, actual_value,
              date_verified_at, date_verification_note
         FROM calendar_events WHERE id = ?`,
    )
    .get(id) as
    | {
        id: number;
        symbol: string | null;
        event_date: string;
        event_time: string | null;
        source: string;
        actual_value: string | null;
        date_verified_at: string | null;
        date_verification_note: string | null;
      }
    | undefined;
}

function countEventsForSymbol(symbol: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE UPPER(symbol) = ?")
      .get(symbol.toUpperCase()) as { n: number }
  ).n;
}

function countSuppressions(symbol: string, eventDate: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM calendar_event_suppressions WHERE UPPER(symbol) = ? AND event_date = ?",
      )
      .get(symbol.toUpperCase(), eventDate) as { n: number }
  ).n;
}

function toCandidate(id: number): DateVerificationCandidate {
  const row = getEventRow(id)!;
  return {
    id: row.id,
    symbol: row.symbol!,
    event_date: row.event_date,
    event_time: row.event_time,
    release_time: null,
    source: row.source,
  };
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

  // ── F7: user-authored manual rows are never the verifier's business ──────
  it("never selects a source='manual' row (user-authored / verifier-minted)", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("MANL");
    seedHolding(acct, sec, 10);

    seedEvent({ symbol: "MANL", event_date: "2026-08-04", source: "manual" });
    seedEvent({ symbol: "MANL", event_date: "2026-08-05", source: "finnhub" });

    const result = findDateVerificationCandidates(db, { now: NOW });
    expect(result.map((r) => r.event_date)).toEqual(["2026-08-05"]);
  });

  // ── F5: near-print re-open (the OCUL shape) ──────────────────────────────
  // A permanent stamp meant a row verified as "unconfirmed" at T-7 was never
  // looked at again — even though the IR announcement usually exists by T-2.
  // A stamped row whose print is within 2 days re-opens once the stamp is
  // more than 2 days old.
  it("re-opens a stamped row inside 2 days of the print when the stamp is stale", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("OCUL");
    seedHolding(acct, sec, 10);

    // T-1 print, stamped over a week ago.
    seedEvent({
      symbol: "OCUL",
      event_date: "2026-08-03",
      date_verified_at: "2026-07-25 10:00:00",
    });

    const result = findDateVerificationCandidates(db, { now: NOW });
    expect(result.map((r) => r.event_date)).toEqual(["2026-08-03"]);
  });

  it("keeps a stamped row excluded when the print is still 5 days out", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("FARP");
    seedHolding(acct, sec, 10);

    seedEvent({
      symbol: "FARP",
      event_date: "2026-08-07",
      date_verified_at: "2026-07-25 10:00:00",
    });

    expect(findDateVerificationCandidates(db, { now: NOW })).toEqual([]);
  });

  it("keeps a near-print row excluded while its stamp is still fresh", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("FRSH");
    seedHolding(acct, sec, 10);

    const id = seedEvent({ symbol: "FRSH", event_date: "2026-08-03" });
    db.prepare(`UPDATE calendar_events SET date_verified_at = datetime('now') WHERE id = ?`).run(id);

    expect(findDateVerificationCandidates(db, { now: NOW })).toEqual([]);
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
        exact_time: null,
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
      {
        symbol: "WTCH",
        confirmed_date: null,
        slot: null,
        confidence: "unconfirmed",
        source: null,
        exact_time: null,
      },
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

// ── applyVerdict ─────────────────────────────────────────────────────────

describe("applyVerdict", () => {
  it("stamps date_verified_at + note on a confirmed match (date AND slot agree)", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("HELD");
    seedHolding(acct, sec, 100);
    const id = seedEvent({ symbol: "HELD", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "HELD",
      confirmed_date: "2026-08-05",
      slot: "bmo",
      confidence: "confirmed",
      source: "ir.example.com",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("verified");
    expect(outcome.detail).toBe("confirmed via ir.example.com");

    const row = getEventRow(id)!;
    expect(row.date_verified_at).not.toBeNull();
    expect(row.date_verification_note).toBe("confirmed via ir.example.com");
    expect(row.event_date).toBe("2026-08-05");
  });

  it("date-match slot-mismatch (confirmed) → correctEarningsEventDate same date new slot; new manual row stamped verified", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("SLOT");
    seedHolding(acct, sec, 50);
    const id = seedEvent({ symbol: "SLOT", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "SLOT",
      confirmed_date: "2026-08-05",
      slot: "amc",
      confidence: "confirmed",
      source: "ir",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("slot-corrected");
    expect(outcome.detail).toBe("slot corrected bmo→amc via ir");

    // Original wrong-slot row is deleted by correctEarningsEventDate.
    expect(getEventRow(id)).toBeUndefined();

    const newRow = db
      .prepare(
        `SELECT id, event_time, date_verified_at, date_verification_note
           FROM calendar_events WHERE UPPER(symbol) = 'SLOT' AND event_date = '2026-08-05' AND source = 'manual'`,
      )
      .get() as
      | { id: number; event_time: string; date_verified_at: string | null; date_verification_note: string | null }
      | undefined;
    expect(newRow).toBeDefined();
    expect(newRow!.event_time).toBe("AMC");
    expect(newRow!.date_verified_at).not.toBeNull();
    expect(newRow!.date_verification_note).toBe("slot corrected bmo→amc via ir");
  });

  it("date mismatch (confirmed) → correction to the new date; manual row stamped; suppression present", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("MOVE");
    seedHolding(acct, sec, 20);
    const id = seedEvent({ symbol: "MOVE", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "MOVE",
      confirmed_date: "2026-08-06",
      slot: "amc",
      confidence: "confirmed",
      source: "wire story",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("date-corrected");
    expect(getEventRow(id)).toBeUndefined();

    const newRow = db
      .prepare(
        `SELECT id, event_date, date_verified_at, date_verification_note
           FROM calendar_events WHERE UPPER(symbol) = 'MOVE' AND source = 'manual'`,
      )
      .get() as
      | { id: number; event_date: string; date_verified_at: string | null; date_verification_note: string | null }
      | undefined;
    expect(newRow).toBeDefined();
    expect(newRow!.event_date).toBe("2026-08-06");
    expect(newRow!.date_verified_at).not.toBeNull();

    expect(countSuppressions("MOVE", "2026-08-05")).toBe(1);
  });

  it("unconfirmed verdict → stamps verified_at with 'unconfirmed' note, NEVER corrects (row untouched)", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("UNSR");
    seedHolding(acct, sec, 10);
    const id = seedEvent({ symbol: "UNSR", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "UNSR",
      confirmed_date: "2026-08-06",
      slot: "amc",
      confidence: "unconfirmed",
      source: "a single unconfirmed blog post",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("unverifiable");
    expect(outcome.detail).toBe("unconfirmed — left as vendor date (2026-08-06 amc suggested)");

    // Never corrects: row untouched aside from the stamp.
    expect(countEventsForSymbol("UNSR")).toBe(1);
    const row = getEventRow(id)!;
    expect(row.event_date).toBe("2026-08-05");
    expect(row.event_time).toBe("BMO");
    expect(row.date_verified_at).not.toBeNull();
    expect(row.date_verification_note).toBe(
      "unconfirmed — left as vendor date (2026-08-06 amc suggested)",
    );
  });

  it("missing verdict for a candidate → 'unverifiable', stamps with note so it is not retried daily", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("MISS");
    seedHolding(acct, sec, 10);
    const id = seedEvent({ symbol: "MISS", event_date: "2026-08-05" });
    const candidate = toCandidate(id);

    const outcome = applyVerdict(db, candidate, undefined, { apply: true });

    expect(outcome.action).toBe("unverifiable");
    expect(outcome.detail).toBe("unverifiable — no source found");

    const row = getEventRow(id)!;
    expect(row.date_verified_at).not.toBeNull();
    expect(row.date_verification_note).toBe("unverifiable — no source found");
  });

  it("correction refused (actuals landed between candidate selection and apply) → action 'refused', no stamp changes on original", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("PRNT");
    seedHolding(acct, sec, 10);
    // Candidate was selected before actuals landed; simulate the race by
    // seeding the row WITH an already-captured actual_value directly (this
    // wouldn't pass findDateVerificationCandidates' own filter, but a stale
    // in-flight candidate object can still reach applyVerdict).
    const id = seedEvent({
      symbol: "PRNT",
      event_date: "2026-08-05",
      event_time: "BMO",
      actual_value: "EPS 2.10 · Rev 900M",
    });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "PRNT",
      confirmed_date: "2026-08-06",
      slot: "amc",
      confidence: "confirmed",
      source: "ir",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("refused");
    expect(outcome.detail.length).toBeGreaterThan(0);

    const row = getEventRow(id)!;
    expect(row.date_verified_at).toBeNull();
    expect(row.date_verification_note).toBeNull();
    expect(row.event_date).toBe("2026-08-05");
  });

  // ── F2: sanity bound on confirmed_date ───────────────────────────────────
  // The model can hallucinate a date from the WRONG quarter (last quarter's
  // print, or a placeholder a year out). Either shape would move a live
  // earnings row onto a date nothing else agrees with, so an out-of-bounds
  // confirmed_date is treated as unconfirmed no matter how confident the
  // verdict claims to be.
  it("never corrects on a confirmed_date in the past (treated as unconfirmed)", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("PAST");
    seedHolding(acct, sec, 10);
    const id = seedEvent({ symbol: "PAST", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "PAST",
      confirmed_date: "2026-05-05", // last quarter's print
      slot: "amc",
      confidence: "confirmed",
      source: "ir",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("unverifiable");
    expect(outcome.detail).toContain("implausible confirmed_date 2026-05-05");

    // Row untouched apart from the stamp — no correction, no suppression.
    expect(countEventsForSymbol("PAST")).toBe(1);
    const row = getEventRow(id)!;
    expect(row.event_date).toBe("2026-08-05");
    expect(row.date_verified_at).not.toBeNull();
    expect(countSuppressions("PAST", "2026-08-05")).toBe(0);
  });

  it("never corrects on a confirmed_date far beyond the next quarter", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("FUTR");
    seedHolding(acct, sec, 10);
    const id = seedEvent({ symbol: "FUTR", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "FUTR",
      confirmed_date: "2027-08-05", // a year out
      slot: "amc",
      confidence: "confirmed",
      source: "ir",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("unverifiable");
    expect(outcome.detail).toContain("implausible confirmed_date 2027-08-05");
    expect(countEventsForSymbol("FUTR")).toBe(1);
    expect(getEventRow(id)!.event_date).toBe("2026-08-05");
  });

  it("still corrects a plausible next-quarter date inside the bound", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("OKAY");
    seedHolding(acct, sec, 10);
    const id = seedEvent({ symbol: "OKAY", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "OKAY",
      confirmed_date: "2026-08-20",
      slot: "amc",
      confidence: "confirmed",
      source: "ir",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: true, today: "2026-08-02" });

    expect(outcome.action).toBe("date-corrected");
  });

  it("apply:false (dry-run) → outcomes computed, zero DB writes", () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("DRYR");
    seedHolding(acct, sec, 10);
    const id = seedEvent({ symbol: "DRYR", event_date: "2026-08-05", event_time: "BMO" });
    const candidate = toCandidate(id);

    const verdict: DateVerdict = {
      symbol: "DRYR",
      confirmed_date: "2026-08-06",
      slot: "amc",
      confidence: "confirmed",
      source: "ir",
      exact_time: null,
    };

    const outcome = applyVerdict(db, candidate, verdict, { apply: false, today: "2026-08-02" });

    expect(outcome.action).toBe("date-corrected");

    // Zero DB writes: original row untouched, no new row, no suppression.
    expect(countEventsForSymbol("DRYR")).toBe(1);
    const row = getEventRow(id)!;
    expect(row.date_verified_at).toBeNull();
    expect(row.date_verification_note).toBeNull();
    expect(row.event_date).toBe("2026-08-05");
    expect(countSuppressions("DRYR", "2026-08-05")).toBe(0);
  });
});

// ── runEarningsDateVerification ─────────────────────────────────────────────

describe("runEarningsDateVerification", () => {
  it("no candidates → returns immediately without calling fetchVerdicts", async () => {
    const fetchVerdicts = vi.fn(async () => {
      throw new Error("should never be called");
    });

    const result = await runEarningsDateVerification(db, { now: NOW, apply: true, fetchVerdicts });

    expect(result).toEqual({ outcomes: [], corrections: 0 });
    expect(fetchVerdicts).not.toHaveBeenCalled();
  });

  it("matches a verdict to a candidate via issuerSiblings family (GOOGL verdict, GOOG candidate)", async () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("GOOG");
    seedHolding(acct, sec, 5);
    seedEvent({ symbol: "GOOG", event_date: "2026-08-05", event_time: "BMO" });

    const fetchVerdicts = vi.fn(async () =>
      JSON.stringify([
        {
          symbol: "GOOGL",
          confirmed_date: "2026-08-05",
          slot: "bmo",
          confidence: "confirmed",
          source: "ir",
        },
      ]),
    );

    const result = await runEarningsDateVerification(db, { now: NOW, apply: true, fetchVerdicts });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].candidate.symbol).toBe("GOOG");
    expect(result.outcomes[0].action).toBe("verified");
    expect(result.corrections).toBe(0);
  });

  // ── Task 2 (2026-08-05 follow-ups): exact-time verdict matching must be
  // family-aware + case-insensitive, same as the date/slot matching above.
  it("applies an exact-time verdict for one share class to the sibling class's event row (GOOGL verdict, GOOG candidate)", async () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("GOOG");
    seedHolding(acct, sec, 5);
    seedEvent({ symbol: "GOOG", event_date: "2026-08-05", event_time: "BMO" });

    // GOOG has no bounded observations / override / fresh web row yet, so it
    // is flagged needsExactTime — the AI answers with the sibling class's
    // symbol, as it's free to do (same earnings print).
    const fetchVerdicts = vi.fn(async () =>
      JSON.stringify([
        {
          symbol: "GOOGL",
          confirmed_date: "2026-08-05",
          slot: "bmo",
          confidence: "confirmed",
          source: "ir",
          exact_time: "07:05",
        },
      ]),
    );

    const result = await runEarningsDateVerification(db, { now: NOW, apply: true, fetchVerdicts });

    expect(result.outcomes[0].action).toBe("verified");
    expect(getSymbolReleaseTimeRow(db, "GOOG")).toMatchObject({
      release_time: "07:05",
      source: "web_verified",
    });
  });

  it("matches a lowercase symbol in the model verdict to the exact-time candidate (case-insensitive)", async () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("XMTR");
    seedHolding(acct, sec, 5);
    const verifyNow = new Date("2026-11-01T14:00:00Z");
    seedEvent({ symbol: "XMTR", event_date: "2026-11-05", event_time: "BMO" });

    const fetchVerdicts = vi.fn(async () =>
      JSON.stringify([
        {
          symbol: "xmtr",
          confirmed_date: "2026-11-05",
          slot: "bmo",
          confidence: "confirmed",
          source: "ew",
          exact_time: "07:05",
        },
      ]),
    );

    const result = await runEarningsDateVerification(db, {
      now: verifyNow,
      apply: true,
      fetchVerdicts,
    });

    expect(result.outcomes[0].action).toBe("verified");
    expect(getSymbolReleaseTimeRow(db, "XMTR")).toMatchObject({
      release_time: "07:05",
      source: "web_verified",
    });
  });

  it("fires one pushover summary when corrections > 0 and apply is true, with one line per correction", async () => {
    const acct = getAccount("Vanguard Taxable");
    const secA = seedSecurity("MVA");
    seedHolding(acct, secA, 5);
    seedEvent({ symbol: "MVA", event_date: "2026-08-05", event_time: "BMO" });
    const secB = seedSecurity("MVB");
    seedHolding(acct, secB, 5);
    seedEvent({ symbol: "MVB", event_date: "2026-08-06", event_time: "BMO" });

    const fetchVerdicts = vi.fn(async () =>
      JSON.stringify([
        { symbol: "MVA", confirmed_date: "2026-08-07", slot: "amc", confidence: "confirmed", source: "ir-a" },
        { symbol: "MVB", confirmed_date: "2026-08-08", slot: "amc", confidence: "confirmed", source: "ir-b" },
      ]),
    );

    const result = await runEarningsDateVerification(db, { now: NOW, apply: true, fetchVerdicts });

    expect(result.corrections).toBe(2);
    expect(pushover).toHaveBeenCalledTimes(1);
    const call = pushover.mock.calls[0][0] as { title: string; message: string };
    expect(call.title).toBe("Earnings dates corrected (2)");
    expect(call.message).toContain("MVA:");
    expect(call.message).toContain("MVB:");
    expect(call.message.split("\n")).toHaveLength(2);
  });

  it("does not push when apply is false, even though corrections would exist", async () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("NDRY");
    seedHolding(acct, sec, 5);
    seedEvent({ symbol: "NDRY", event_date: "2026-08-05", event_time: "BMO" });

    const fetchVerdicts = vi.fn(async () =>
      JSON.stringify([
        {
          symbol: "NDRY",
          confirmed_date: "2026-08-07",
          slot: "amc",
          confidence: "confirmed",
          source: "ir",
        },
      ]),
    );

    const result = await runEarningsDateVerification(db, { now: NOW, apply: false, fetchVerdicts });

    expect(result.outcomes[0].action).toBe("date-corrected");
    expect(pushover).not.toHaveBeenCalled();
  });

  it("wraps in try/catch — a throwing fetchVerdicts never throws into the caller, returns empty outcomes", async () => {
    const acct = getAccount("Vanguard Taxable");
    const sec = seedSecurity("BOOM");
    seedHolding(acct, sec, 5);
    seedEvent({ symbol: "BOOM", event_date: "2026-08-05" });

    const fetchVerdicts = vi.fn(async () => {
      throw new Error("network exploded");
    });

    const result = await runEarningsDateVerification(db, { now: NOW, apply: true, fetchVerdicts });

    expect(result).toEqual({ outcomes: [], corrections: 0 });
  });
});

// ── maybeRunDailyDateVerification ───────────────────────────────────────────
// Once-per-ET-day gate wired into the earnings-sweep cron route. Gate opens
// at 05:00 ET (BMO previews start firing ~06:25 ET, so verification must
// precede them). Always injects `runner` so these tests never touch the real
// orchestrator / network — same DI seam runEarningsDateVerification itself
// uses for fetchVerdicts.

describe("maybeRunDailyDateVerification", () => {
  it("runs once per ET day after 05:00 ET and stamps settings key earnings_date_verify_last_run", async () => {
    const runner = vi.fn(async () => ({ outcomes: [], corrections: 0 }));
    const now = new Date("2026-08-02T10:00:00Z"); // 06:00 ET (EDT, UTC-4)

    const result = await maybeRunDailyDateVerification(db, { now, runner });

    expect(result).toEqual({ ran: true });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(db, { now, apply: true });

    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get("earnings_date_verify_last_run") as { value: string } | undefined;
    expect(row?.value).toBe(todayET(now));
  });

  it("second call same day is a no-op", async () => {
    const runner = vi.fn(async () => ({ outcomes: [], corrections: 0 }));
    const now = new Date("2026-08-02T10:00:00Z"); // 06:00 ET

    const first = await maybeRunDailyDateVerification(db, { now, runner });
    const second = await maybeRunDailyDateVerification(db, { now, runner });

    expect(first).toEqual({ ran: true });
    expect(second).toEqual({ ran: false });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("before 05:00 ET does not run (BMO previews start ~06:25 — verification must precede them, so the gate opens at 05:00)", async () => {
    const runner = vi.fn(async () => ({ outcomes: [], corrections: 0 }));
    const now = new Date("2026-08-02T08:00:00Z"); // 04:00 ET

    const result = await maybeRunDailyDateVerification(db, { now, runner });

    expect(result).toEqual({ ran: false });
    expect(runner).not.toHaveBeenCalled();

    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get("earnings_date_verify_last_run") as { value: string } | undefined;
    expect(row).toBeUndefined();
  });
});

// ── Exact-time jump-start (wire-time spec 2026-08-04, Task 4) ──────────────

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

  /**
   * Suspect AMC call time (owner report, live 2026-08-26/27): the web answer
   * for an after-close name is very often the 5 PM CALL, not the print —
   * CRWD/RBRK both printed ~16:05 while the verified time said 17:00. Storing
   * it as web_verified poisons the cascade AND the pre-print floor, so the
   * writer refuses it outright; the re-resolve still runs so whatever the
   * cascade DOES believe lands on the upcoming rows.
   */
  it("refuses to store a 17:00 AMC verified time (call time, not print) but still re-resolves upcoming rows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const candidate = {
      id: 2, symbol: "CRWD", event_date: "2026-11-05", event_time: "AMC",
      release_time: "09:00", source: "finnhub",
    };
    // release_time deliberately wrong (09:00 on an AMC row) so a successful
    // re-resolve is observable.
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings','2026-11-05','AMC','09:00','CRWD','CRWD earnings','finnhub:CRWD:2026-11-05','2026-11-02')`,
    ).run();

    const ok = applyExactTimeVerdict(
      db,
      { symbol: "CRWD", confirmed_date: "2026-11-05", slot: "amc", confidence: "confirmed", source: "EarningsWhispers", exact_time: "17:00" },
      candidate,
    );

    expect(ok).toBe(false);
    expect(getSymbolReleaseTimeRow(db, "CRWD")).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/suspect call time/i);
    expect(String(warn.mock.calls[0][0])).toMatch(/CRWD/);

    // The cascade still lands on the upcoming row: 09:00 → AMC default 16:15.
    expect(
      (db.prepare("SELECT release_time FROM calendar_events WHERE symbol='CRWD'").get() as { release_time: string }).release_time,
    ).toBe("16:15");

    // Slot can come from the candidate when the verdict carries none.
    const ok2 = applyExactTimeVerdict(
      db,
      { symbol: "RBRK", confirmed_date: null, slot: null, confidence: "confirmed", source: "EarningsWhispers", exact_time: "17:15" },
      { ...candidate, symbol: "RBRK", event_time: null, release_time: "16:15" },
    );
    expect(ok2).toBe(false);
    expect(getSymbolReleaseTimeRow(db, "RBRK")).toBeNull();

    warn.mockRestore();
  });

  it("still stores a plausible AMC print time (16:05) as web_verified", () => {
    const candidate = {
      id: 3, symbol: "DDOG", event_date: "2026-11-05", event_time: "AMC",
      release_time: "16:15", source: "finnhub",
    };
    const ok = applyExactTimeVerdict(
      db,
      { symbol: "DDOG", confirmed_date: "2026-11-05", slot: "amc", confidence: "confirmed", source: "EarningsWhispers", exact_time: "16:05" },
      candidate,
    );
    expect(ok).toBe(true);
    expect(getSymbolReleaseTimeRow(db, "DDOG")).toMatchObject({
      release_time: "16:05", source: "web_verified",
    });
  });
});

// Deferred minor (2026-08-07): defaultFetchDateVerdicts shares the exact
// web_search text-block join shape that was root-caused and fixed in the
// earnings composer (lib/digest/send-earnings-email.ts::joinClaudeTextBlocks,
// join("") not join("\n")) — masked here by parseDateVerdicts' C0-control-char
// retry, but the wrong join can still plant a bare newline mid-sentence
// inside a JSON string value.
describe("defaultFetchDateVerdicts web_search text-block join", () => {
  it("joins split text blocks with no inserted newline (web_search citation boundary)", async () => {
    vi.mocked(getRawAnthropicClient).mockReturnValue({
      messages: {
        create: () =>
          Promise.resolve({
            content: [
              { type: "text", text: '[{"symbol":"XMTR","confirmed_date":"2026-11-05","slot":"bmo",' },
              { type: "text", text: '"confidence":"confirmed","source":"company IR","exact_time":null}]' },
            ],
          }),
      },
    } as never);

    const text = await defaultFetchDateVerdicts("verify XMTR");
    expect(text).not.toContain("\n");
    expect(parseDateVerdicts(text)).toEqual([
      {
        symbol: "XMTR",
        confirmed_date: "2026-11-05",
        slot: "bmo",
        confidence: "confirmed",
        source: "company IR",
        exact_time: null,
      },
    ]);
  });
});
