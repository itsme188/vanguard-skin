/**
 * The chat's return tool (query_twr) gives the money-weighted return for the
 * WHOLE named scope, the same figure /api/compute/xirr and the Performance
 * page give.
 *
 * Defect: the tool resolved `account_name` to ONE account (the first name
 * match) and passed that single id to computeXirr, so a scope word that
 * names two accounts answered for the first one only.
 *
 * Every figure is invented (the layout follows tests/compute/xirr-scope-u13).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";
import { resolveAccountScopeIds } from "@/lib/chat/account-scope";
import { computeXirr } from "@/lib/compute/xirr";
import { resolveScope } from "@/lib/queries/accounts";

// Migration 002 seeds Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
const TAXABLE = 1;
const ROTH = 2;
const IBKR = 3;

let db: Database.Database;
let ibkrTwo: number;

function seedSnapshot(
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  deposits: number | null = null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, source, deposits_withdrawals)
     VALUES (?, ?, ?, 'canonical', ?)`,
  ).run(accountId, monthEndDate, totalValue, deposits);
}

interface ToolResult {
  data: { xirr: ReturnType<typeof computeXirr> };
}

async function chatXirr(accountName?: string) {
  const input: Record<string, unknown> = { period: "inception" };
  if (accountName !== undefined) input.account_name = accountName;
  const result = (await executeTool(db, "query_twr", input)) as ToolResult;
  return result.data.xirr;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // A second account whose name puts it in the "ibkr" scope.
  ibkrTwo = db.prepare("INSERT INTO accounts (name) VALUES ('IBKR Two')").run()
    .lastInsertRowid as number;

  seedSnapshot(IBKR, "2025-03-31", 100000);
  seedSnapshot(IBKR, "2025-04-30", 134640, 30000);
  seedSnapshot(ibkrTwo, "2025-03-31", 50000);
  seedSnapshot(ibkrTwo, "2025-04-30", 48675);
  seedSnapshot(ROTH, "2025-03-31", 20000);
  seedSnapshot(ROTH, "2025-04-30", 20400);
  seedSnapshot(TAXABLE, "2025-03-31", 70000);
  seedSnapshot(TAXABLE, "2025-04-30", 70700, 500);
});

describe("query_twr: the money-weighted return covers the whole named scope", () => {
  it("a scope word naming two accounts returns ONE return over both, not the first account's", async () => {
    const scopeIds = resolveScope(db, "ibkr");
    expect(scopeIds).toEqual([IBKR, ibkrTwo]);

    const got = await chatXirr("ibkr");
    const whole = computeXirr(db, { accountIds: [IBKR, ibkrTwo] });
    const firstOnly = computeXirr(db, { accountId: IBKR });

    expect(whole).not.toBeNull();
    expect(got).toEqual(whole);
    // The old answer was the first account alone, a different rate.
    expect(firstOnly!.xirr).not.toBeCloseTo(whole!.xirr!, 4);
    expect(got!.xirr).not.toBeCloseTo(firstOnly!.xirr!, 4);
    expect(got!.perAccount.map((a) => a.accountId)).toEqual([IBKR, ibkrTwo]);
  });

  it("agrees with what /api/compute/xirr computes for the same scope word", async () => {
    // The route: computeXirr(db, { startDate, endDate, accountIds: resolveScope(db, scope) }).
    for (const scope of ["ibkr", "roth", "taxable"]) {
      expect(await chatXirr(scope)).toEqual(
        computeXirr(db, { accountIds: resolveScope(db, scope) }),
      );
    }
  });

  it("a one-account name returns exactly what the single-id call returned", async () => {
    const cases: Array<[string, number]> = [
      ["Vanguard Roth IRA", ROTH],
      ["roth", ROTH],
      ["Vanguard Taxable", TAXABLE],
      ["taxable", TAXABLE],
      // The bare word "vanguard": the tool's own single-account lookup (which
      // sets the window and the time-weighted return in the same answer)
      // picks the Roth, while the scope rule says Vanguard Taxable. Until
      // that lookup follows the scope rule, the money-weighted return stays
      // on the SAME account as the rest of the answer: unchanged, and never
      // two returns for two different accounts side by side.
      ["vanguard", ROTH],
      // An exact account name is that account even when a longer name contains it.
      ["IBKR", IBKR],
      ["IBKR Two", ibkrTwo],
    ];
    for (const [name, id] of cases) {
      const got = await chatXirr(name);
      const before = computeXirr(db, { accountId: id });
      expect(before).not.toBeNull();
      expect(JSON.stringify(got)).toBe(JSON.stringify(before));
    }
  });

  it("both returns in one answer describe the same account for every one-account name", async () => {
    interface Both {
      data: {
        twr: { perAccount: Array<{ accountId: number }> } | null;
        xirr: { perAccount: Array<{ accountId: number }> } | null;
      };
    }
    for (const name of ["Vanguard Roth IRA", "roth", "Vanguard Taxable", "taxable", "vanguard", "IBKR Two"]) {
      const r = (await executeTool(db, "query_twr", {
        period: "inception",
        account_name: name,
      })) as Both;
      expect(r.data.xirr!.perAccount).toHaveLength(1);
      expect(r.data.twr!.perAccount.map((a) => a.accountId)).toEqual(
        r.data.xirr!.perAccount.map((a) => a.accountId),
      );
    }
  });

  it("no account name is the whole portfolio, unchanged", async () => {
    expect(JSON.stringify(await chatXirr())).toBe(JSON.stringify(computeXirr(db, {})));
  });
});

describe("resolveAccountScopeIds", () => {
  it("exact name is one account; a scope word is its whole list; nothing matched is every account", () => {
    expect(resolveAccountScopeIds(db, undefined)).toBeUndefined();
    expect(resolveAccountScopeIds(db, "IBKR")).toEqual([IBKR]);
    expect(resolveAccountScopeIds(db, "ibkr")).toEqual([IBKR, ibkrTwo]);
    expect(resolveAccountScopeIds(db, "vanguard")).toEqual([TAXABLE]);
    expect(resolveAccountScopeIds(db, "Roth")).toEqual([ROTH]);
    expect(resolveAccountScopeIds(db, "no such account")).toBeUndefined();
  });
});
