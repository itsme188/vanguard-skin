import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Landing review 2026-09-11, two defects in what lib/chat/tools.ts hands the
// chat model:
//
//  1. query_options_greeks returned portfolio.{totalDelta,...} at their ZERO
//     initializers when every position failed to price, with nothing saying
//     so — the model could read "0" as "the book is delta-neutral" over a
//     position whose risk is simply unknown. This is the same defect PR #73
//     fixed on the UI side (OptionsGreeksCard's coverage gate); the tool
//     payload had no equivalent.
//  2. query_release_reactions handed the raw stored snapshot to the model,
//     zero-filled legacy legs included — a {t_pre:0,t_post:0,delta_pct:0}
//     leg reads as a genuine +0.00% market reaction.

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // migration 002_seed_accounts.sql seeds id=1 Vanguard Taxable.
});

// ─── Fixtures (synthetic tickers + figures only) ─────────────────

function seedStock(id: number, symbol: string): void {
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, currency, multiplier)
     VALUES (?, ?, 'stock', 'USD', 1)`,
  ).run(id, symbol);
}

function seedCall(id: number, underlying: string, strike: number): void {
  const expiry = addDays(todayET(), 180);
  db.prepare(
    `INSERT INTO securities
       (id, symbol, security_type, option_type, strike_price, expiration_date,
        underlying_symbol, multiplier, currency)
     VALUES (?, ?, 'option', 'CALL', ?, ?, ?, 100, 'USD')`,
  ).run(id, `${underlying} CALL ${strike}`, strike, expiry, underlying);
}

function seedHolding(securityId: number, quantity: number, key: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (1, ?, ?, 0, ?, ?)`,
  ).run(securityId, quantity, todayET(), key);
}

function seedPrice(securityId: number, close: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`,
  ).run(securityId, todayET(), close);
}

type GreeksPortfolio = {
  totalDelta: number | null;
  totalGamma: number | null;
  totalTheta: number | null;
  totalVega: number | null;
  computedPositions: number;
  totalPositions: number;
  note: string | null;
};

async function runGreeks(): Promise<GreeksPortfolio> {
  const result = (await executeTool(db, "query_options_greeks", {})) as {
    error?: string;
    data: { portfolio: GreeksPortfolio };
  };
  expect(result.error).toBeUndefined();
  return result.data.portfolio;
}

describe("query_options_greeks — coverage disclosure on the tool payload", () => {
  it("nulls the four totals and notes the gap when NO position could be priced", async () => {
    // An option book that exists but has no underlying price anywhere: every
    // position hits the `!S` early continue, so the running totals are never
    // touched and stay at their 0 initializers.
    seedStock(900, "QAAA");
    seedCall(901, "QAAA", 120);
    seedHolding(901, 2, "qaaa-call");

    const portfolio = await runGreeks();

    expect(portfolio.totalPositions).toBe(1);
    expect(portfolio.computedPositions).toBe(0);
    // The zeros must NOT survive as numbers — that is the delta-neutral lie.
    expect(portfolio.totalDelta).toBeNull();
    expect(portfolio.totalGamma).toBeNull();
    expect(portfolio.totalTheta).toBeNull();
    expect(portfolio.totalVega).toBeNull();
    expect(portfolio.note).toBe("no position could be priced");
  });

  it("reports real totals with no note when every position prices", async () => {
    seedStock(900, "QAAA");
    seedPrice(900, 118);
    seedCall(901, "QAAA", 120);
    seedHolding(901, 2, "qaaa-call");

    const portfolio = await runGreeks();

    expect(portfolio.totalPositions).toBe(1);
    expect(portfolio.computedPositions).toBe(1);
    expect(typeof portfolio.totalDelta).toBe("number");
    // Long calls carry positive delta: 2 contracts x 100 share-equivalents.
    expect(portfolio.totalDelta as number).toBeGreaterThan(0);
    expect(portfolio.note).toBeNull();
  });

  it("keeps the totals but discloses partial coverage when only some positions price", async () => {
    seedStock(900, "QAAA");
    seedPrice(900, 118);
    seedCall(901, "QAAA", 120);
    seedHolding(901, 2, "qaaa-call");

    // Second underlying, deliberately unpriced.
    seedStock(902, "QBBB");
    seedCall(903, "QBBB", 50);
    seedHolding(903, 1, "qbbb-call");

    const portfolio = await runGreeks();

    expect(portfolio.totalPositions).toBe(2);
    expect(portfolio.computedPositions).toBe(1);
    expect(typeof portfolio.totalDelta).toBe("number");
    expect(portfolio.note).toBe("greeks solved for 1 of 2 positions");
  });

  it("leaves the zeros alone when there are no option positions at all", async () => {
    // Nothing to price and nothing unpriced: zero exposure is the truth here,
    // and positionCount already tells the model the book is empty.
    const result = (await executeTool(db, "query_options_greeks", {})) as {
      data: { portfolio: GreeksPortfolio; positionCount: number };
    };

    expect(result.data.positionCount).toBe(0);
    expect(result.data.portfolio.totalPositions).toBe(0);
    expect(result.data.portfolio.totalDelta).toBe(0);
    expect(result.data.portfolio.note).toBeNull();
  });
});

// ─── query_release_reactions ─────────────────────────────────────

function seedRelease(symbol: string, snapshot: string | null): void {
  db.prepare(
    `INSERT INTO calendar_events
       (source, source_key, event_type, event_date, title, symbol, actual_value,
        consensus_value, enriched_at, reaction_snapshot)
     VALUES ('manual', ?, 'earnings', ?, ?, ?, 'EPS 1.00', 'EPS 0.90',
             datetime('now'), ?)`,
  ).run(
    `test:${symbol}`,
    addDays(todayET(), -3),
    `${symbol} Q3 earnings`,
    symbol,
    snapshot,
  );
}

type ReactionLeg = { t_pre: number; t_post: number; delta_pct: number };
type DecodedRelease = {
  symbol: string | null;
  reaction: {
    spy?: ReactionLeg;
    qqq?: ReactionLeg;
    tlt?: ReactionLeg;
    t0_utc?: string;
  } | null;
};

async function runReactions(): Promise<DecodedRelease[]> {
  const result = (await executeTool(db, "query_release_reactions", {})) as {
    error?: string;
    data: { releases: DecodedRelease[]; count: number };
  };
  expect(result.error).toBeUndefined();
  return result.data.releases;
}

describe("query_release_reactions — zero-filled legs never reach the model", () => {
  it("drops a {0,0,0} sentinel leg and keeps the real one", async () => {
    seedRelease(
      "QAAA",
      JSON.stringify({
        t0_utc: "2026-09-03T20:00:00Z",
        window_min: 120,
        source: "tws",
        spy: { t_pre: 100, t_post: 101.5, delta_pct: 1.5 },
        // legacy zero-fill: no bars ever arrived for this benchmark
        qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
      }),
    );

    const [release] = await runReactions();

    expect(release.reaction?.spy?.delta_pct).toBeCloseTo(1.5, 6);
    // The fabricated flat move is absent, not reported as +0.00%.
    expect(release.reaction?.qqq).toBeUndefined();
    // Context for the surviving leg rides along.
    expect(release.reaction?.t0_utc).toBe("2026-09-03T20:00:00Z");
  });

  it("collapses a snapshot whose every leg is a sentinel to null", async () => {
    seedRelease(
      "QBBB",
      JSON.stringify({
        t0_utc: "2026-09-03T20:00:00Z",
        window_min: 120,
        source: "tws",
        spy: { t_pre: 0, t_post: 0, delta_pct: 0 },
        qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
      }),
    );

    const [release] = await runReactions();

    // No usable leg means no measurement — bare metadata would still invite
    // the model to talk about "the reaction".
    expect(release.reaction).toBeNull();
  });

  it("rejects a negative or non-finite leg the same way", async () => {
    seedRelease(
      "QCCC",
      JSON.stringify({
        t0_utc: "2026-09-03T20:00:00Z",
        window_min: 120,
        source: "tws",
        spy: { t_pre: -1, t_post: 101.5, delta_pct: 2 },
        tlt: { t_pre: 90, t_post: 91, delta_pct: null },
      }),
    );

    const [release] = await runReactions();

    expect(release.reaction).toBeNull();
  });

  it("returns null for a missing or unparseable snapshot without throwing", async () => {
    seedRelease("QDDD", null);
    seedRelease("QEEE", "{not json");

    const releases = await runReactions();

    expect(releases).toHaveLength(2);
    for (const r of releases) expect(r.reaction).toBeNull();
  });
});
