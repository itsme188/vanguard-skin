import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { clampToolInputToScope } from "@/lib/chat/scope";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { computeTwr } from "@/lib/compute/twr";
import {
  resolvePerformanceWindow,
  latestStatementAnchor,
} from "@/lib/compute/performance-window";

/** Owner rulings 2026-10-08. All figures are invented round numbers. */

let db: Database.Database;
// Migration 002 seeds: Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'Stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

/** Eleven recent days of closes so the SPY-anchored pair is fresh on any run date. */
function seedRecentDays(securityId: number, base: number, step: number): void {
  const today = todayET();
  for (let i = 0; i <= 11; i++) {
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(
      securityId,
      addDays(today, -i),
      base - i * step,
    );
  }
}

function seedHolding(accountId: number, securityId: number, quantity: number): void {
  // Old enough to be in the book at any prior pair date.
  const date = addDays(todayET(), -30);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, quantity, date, `test:${accountId}:${securityId}`);
}

interface SnapshotRow {
  symbol: string;
  kind: string;
  position?: string;
  accounts?: string[];
  quantity?: number;
}

describe("query_market_snapshot: account scope", () => {
  const tool = CHAT_TOOLS.find((t) => t.name === "query_market_snapshot")!;

  it("declares account_name and closes the schema to other properties", () => {
    const schema = tool.input_schema as {
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(schema.properties.account_name).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("no longer offers a 'mixed' position and tells the model to report the tool's day effect", () => {
    const description = tool.description ?? "";
    // 'mixed' survives only as a day_effect_basis value, never as a position.
    expect(description).toContain("`position` is 'long' or 'short'");
    expect(description).not.toContain("'long' | 'short' | 'mixed'");
    expect(description).toContain("day_effect");
    expect(description.toLowerCase()).toContain("never multiply");
  });

  it("is clamped to the chat's account by the existing clamp, overriding the model's value", () => {
    const out = clampToolInputToScope(
      { account_name: "IBKR" },
      tool.input_schema as { properties?: Record<string, unknown> },
      "Vanguard Taxable",
    );
    expect(out.account_name).toBe("Vanguard Taxable");
  });

  it("returns only the named account's legs", async () => {
    const spy = seedSecurity("SPY");
    seedRecentDays(spy, 600, 2);
    const zza = seedSecurity("ZZA");
    seedRecentDays(zza, 100, 1);
    seedHolding(1, zza, 100);
    seedHolding(3, zza, -40);
    const zzb = seedSecurity("ZZB");
    seedRecentDays(zzb, 50, 1);
    seedHolding(2, zzb, 30);

    const all = (await executeTool(db, "query_market_snapshot", {})) as {
      data: { moves: SnapshotRow[] };
    };
    const allHeld = all.data.moves.filter((m) => m.kind === "holding");
    expect(allHeld.filter((m) => m.symbol === "ZZA").map((m) => m.position).sort()).toEqual([
      "long",
      "short",
    ]);
    expect(allHeld.some((m) => m.symbol === "ZZB")).toBe(true);

    // The model's loose spelling resolves like every other tool's.
    const scoped = (await executeTool(db, "query_market_snapshot", { account_name: "ibkr" })) as {
      data: { moves: SnapshotRow[] };
    };
    const held = scoped.data.moves.filter((m) => m.kind === "holding");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ symbol: "ZZA", position: "short", accounts: ["IBKR"], quantity: -40 });
  });
});

describe("query_twr: the window is the Performance view's window", () => {
  function seedStatement(accountId: number, monthEnd: string, value: number): void {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (?, ?, ?, 'manual')`,
    ).run(accountId, monthEnd, value);
  }

  /** The last `count` month-ends strictly before this month, oldest first. */
  function recentMonthEnds(count: number): string[] {
    const [y, m] = todayET().split("-").map(Number);
    const out: string[] = [];
    for (let i = count; i >= 1; i--) {
      out.push(new Date(Date.UTC(y, m - 1 - i + 1, 0)).toISOString().slice(0, 10));
    }
    return out;
  }

  interface TwrToolResult {
    data: {
      window: {
        period: string;
        start_date: string | null;
        end_date: string;
        ends_at_last_statement: boolean;
        note: string;
      };
      twr: unknown;
      xirr: unknown;
    };
  }

  it("1Y with a statement anchor: a full year ending at the last statement", async () => {
    const ends = recentMonthEnds(15);
    ends.forEach((d, i) => seedStatement(1, d, 100000 + i * 1000));
    const today = todayET();
    const anchor = latestStatementAnchor(db, [1], today);
    expect(anchor).toBe(ends[ends.length - 1]);
    const expected = resolvePerformanceWindow("1y", { today, lastStatementAnchor: anchor });

    const result = (await executeTool(db, "query_twr", {
      period: "1y",
      account_name: "Vanguard Taxable",
    })) as TwrToolResult;

    expect(result.data.window.start_date).toBe(expected.startDate);
    expect(result.data.window.end_date).toBe(anchor);
    expect(result.data.window.ends_at_last_statement).toBe(true);
    // The opening anchor is the statement twelve months before the last one.
    expect(result.data.window.start_date).toBe(ends[ends.length - 13]);
    expect(result.data.window.note).toContain(anchor!);
    // And the figure is the one the Performance view computes for that window.
    expect(result.data.twr).toEqual(
      computeTwr(db, { startDate: expected.chainStartDate, endDate: expected.endDate, accountId: 1 }),
    );
  });

  it("1Y with no statement: the period rolls with today (Eastern)", async () => {
    const today = todayET();
    const expected = resolvePerformanceWindow("1y", { today, lastStatementAnchor: null });

    const result = (await executeTool(db, "query_twr", { period: "1y" })) as TwrToolResult;

    expect(result.data.window.start_date).toBe(expected.startDate);
    expect(result.data.window.end_date).toBe(today);
    expect(result.data.window.ends_at_last_statement).toBe(false);
  });

  it("portfolio-wide 1Y ends at the last month every account has a statement for", async () => {
    const ends = recentMonthEnds(15);
    ends.forEach((d, i) => seedStatement(1, d, 100000 + i * 1000));
    // The second account's newest statement is one month older.
    ends.slice(0, -1).forEach((d, i) => seedStatement(3, d, 50000 + i * 500));
    const today = todayET();
    const anchor = latestStatementAnchor(db, undefined, today);
    expect(anchor).toBe(ends[ends.length - 2]);

    const result = (await executeTool(db, "query_twr", { period: "1y" })) as TwrToolResult;
    expect(result.data.window.end_date).toBe(anchor);
    expect(result.data.window.start_date).toBe(ends[ends.length - 14]);
  });

  it("YTD and inception are unchanged: they run to today", async () => {
    const today = todayET();
    const ytd = (await executeTool(db, "query_twr", { period: "ytd" })) as TwrToolResult;
    expect(ytd.data.window.start_date).toBe(`${today.slice(0, 4)}-01-01`);
    expect(ytd.data.window.end_date).toBe(today);
    const all = (await executeTool(db, "query_twr", { period: "inception" })) as TwrToolResult;
    expect(all.data.window.start_date).toBeNull();
    expect(all.data.window.end_date).toBe(today);
  });
});
