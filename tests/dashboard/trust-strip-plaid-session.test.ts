/**
 * Analysis trust strip: Plaid session dating (plan v4, unit U4).
 *
 *   - A Plaid-fed account's positions are judged against
 *     `expectedPlaidSession(now)` and warn only when the newest COVERED
 *     session (a Plaid book or a statement holdings book) is older.
 *   - The strip's Plaid lines: old dating (Legacy / Mixed), an unreadable
 *     dating setting, an account held back by older rows (A6), and a repeat
 *     read. Silent for an IBKR-only scope and for a defined empty scope.
 *
 * Migrated in-memory schema; synthetic securities, invented dates (2027) and
 * round numbers only. Accounts 1 (Vanguard Taxable), 2 (Vanguard Roth IRA)
 * and 3 (IBKR) come from the migrations.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPositionsFreshness } from "@/lib/queries/positions-freshness";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import {
  plaidAccountFreshnessNote,
  plaidTrustLines,
  positionsFreshnessCell,
} from "@/lib/ui/positions-freshness-label";

// Monday 2027-02-08 (Eastern standard time, UTC-5). Previous sessions:
// Friday 02-05, Thursday 02-04.
const TODAY = "2027-02-08";
const AT_0800 = new Date("2027-02-08T13:00:00Z"); // 08:00 Eastern: expected 02-05
const AT_0735 = new Date("2027-02-08T12:35:00Z"); // 07:35 Eastern: expected 02-04

const TAXABLE = 1;
const ROTH = 2;
const IBKR = 3;

let db: Database.Database;
let nextSecurityId = 500;

function security(symbol: string, type = "Stock"): number {
  const id = nextSecurityId++;
  db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (?, ?, ?)`).run(
    id,
    symbol,
    type,
  );
  return id;
}

function hold(acct: number, sec: number, date: string, key: string, qty = 100): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(acct, sec, date, qty, key);
}

function snapshot(acct: number, date: string, total: number, cash: number, source = "plaid"): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(acct, date, total, cash, source);
}

function setting(key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

/** A new-format Plaid book: snapshot plus `plaid:s:` holdings on `session`. */
function newBook(acct: number, sec: number, session: string, total = 10000, cash = 500, qty = 100) {
  snapshot(acct, session, total, cash);
  hold(acct, sec, session, `plaid:s:${acct}:${sec}:${session}`, qty);
}

/** A legacy Plaid book: dated on the run day, old key. */
function legacyBook(acct: number, sec: number, runDay: string, total = 10000, cash = 500) {
  snapshot(acct, runDay, total, cash);
  hold(acct, sec, runDay, `plaid:${acct}:${sec}:${runDay}`);
}

function accountName(id: number): string {
  return (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(id) as { name: string }).name;
}

const LEGACY_LINE =
  "Vanguard daily history still uses the old dating (one session late); repair pending.";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextSecurityId = 500;
});

describe("Plaid freshness against the expected session", () => {
  it("a Plaid book on the expected session is good", () => {
    const a = security("FAKE1");
    setting("plaid_dating_version", "2");
    newBook(TAXABLE, a, "2027-02-05");
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    const acct = f.accounts[0];
    expect(acct.plaid).toEqual({
      newestCoveredSession: "2027-02-05",
      expectedSession: "2027-02-05",
      stale: false,
    });
    expect(acct.level).toBe("good");
    expect(f.level).toBe("good");
    expect(plaidAccountFreshnessNote(acct)).toBeNull();
  });

  it("a Plaid book older than the expected session warns, and says which close is missing", () => {
    const a = security("FAKE1");
    setting("plaid_dating_version", "2");
    newBook(TAXABLE, a, "2027-02-04");
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    const acct = f.accounts[0];
    expect(acct.plaid?.stale).toBe(true);
    expect(acct.level).toBe("warn");
    expect(f.level).toBe("warn");
    const note =
      "Vanguard's newest stored session is the Feb 4 close. The morning read should have stored the Feb 5 close.";
    expect(plaidAccountFreshnessNote(acct)).toBe(note);
    const cell = positionsFreshnessCell(f);
    expect(cell.tone).toBe("warn");
    expect(cell.hint).toBe(note);
  });

  it("no warn before 07:40 when the newest Plaid session is the expected one", () => {
    const a = security("FAKE1");
    setting("plaid_dating_version", "2");
    newBook(TAXABLE, a, "2027-02-04");
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0735 });
    expect(f.accounts[0].plaid?.expectedSession).toBe("2027-02-04");
    expect(f.accounts[0].plaid?.stale).toBe(false);
    expect(f.level).toBe("good");
  });

  it("a statement holdings book on the expected session counts as covered", () => {
    const a = security("FAKE1");
    setting("plaid_dating_version", "2");
    newBook(TAXABLE, a, "2027-02-04");
    // The statement covers 02-05, so the refresh skipped that session on
    // purpose (A5). The statement row is now the counted row.
    hold(TAXABLE, a, "2027-02-05", `vanguard-pdf:holding:${TAXABLE}:FAKE1:2027-02-05`);
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    const acct = f.accounts[0];
    expect(acct.liveRowCount).toBe(0);
    expect(acct.plaid?.newestCoveredSession).toBe("2027-02-05");
    expect(acct.plaid?.stale).toBe(false);
    expect(acct.level).toBe("good");
    expect(f.level).toBe("good");
    const cell = positionsFreshnessCell(f);
    expect(cell.dateText).toBe("Feb 5 statement");
    expect(cell.tone).toBe("good");
  });

  it("an IBKR account keeps the one-trading-day rule and has no Plaid facts", () => {
    const a = security("FAKE2");
    hold(IBKR, a, "2027-02-05", `tws-${IBKR}-${a}-2027-02-05`);
    const f = getPositionsFreshness(db, [IBKR], TODAY, { now: AT_0800 });
    expect(f.accounts[0].plaid).toBeNull();
    expect(f.accounts[0].level).toBe("good");
    expect(f.plaid.accountIds).toEqual([]);
    expect(plaidTrustLines(f)).toEqual([]);
  });

  it("getAnalysisTrustState passes the instant through", () => {
    const a = security("FAKE1");
    setting("plaid_dating_version", "2");
    newBook(TAXABLE, a, "2027-02-04");
    const early = getAnalysisTrustState(db, [TAXABLE], TODAY, AT_0735).positionsFreshness;
    const late = getAnalysisTrustState(db, [TAXABLE], TODAY, AT_0800).positionsFreshness;
    expect(early.plaid.expectedSession).toBe("2027-02-04");
    expect(early.level).toBe("good");
    expect(late.plaid.expectedSession).toBe("2027-02-05");
    expect(late.level).toBe("warn");
  });
});

describe("old-dating lines (section B)", () => {
  it("Legacy: the Legacy line on a Vanguard scope; silent for IBKR only and for an empty scope", () => {
    const a = security("FAKE1");
    const b = security("FAKE2");
    legacyBook(TAXABLE, a, "2027-02-05");
    hold(IBKR, b, "2027-02-05", `tws-${IBKR}-${b}-2027-02-05`);

    const vanguard = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(vanguard.plaid.datingState).toBe("legacy");
    expect(plaidTrustLines(vanguard)).toEqual([
      { key: "plaid-dating-legacy", level: "warn", text: LEGACY_LINE },
    ]);

    const ibkrOnly = getPositionsFreshness(db, [IBKR], TODAY, { now: AT_0800 });
    expect(plaidTrustLines(ibkrOnly)).toEqual([]);

    const none = getPositionsFreshness(db, [], TODAY, { now: AT_0800 });
    expect(none.plaid.accountIds).toEqual([]);
    expect(plaidTrustLines(none)).toEqual([]);

    const every = getPositionsFreshness(db, undefined, TODAY, { now: AT_0800 });
    expect(plaidTrustLines(every).map((l) => l.text)).toEqual([LEGACY_LINE]);
  });

  it("Mixed: names the earliest first new-format session in scope", () => {
    const a = security("FAKE1");
    legacyBook(TAXABLE, a, "2027-02-03");
    newBook(TAXABLE, a, "2027-02-04", 10100);
    newBook(TAXABLE, a, "2027-02-05", 10200);
    setting("plaid_dating_first_session", JSON.stringify({ accounts: { "1": "2027-02-04" } }));

    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(f.plaid.datingState).toBe("mixed");
    expect(plaidTrustLines(f)).toEqual([
      {
        key: "plaid-dating-mixed",
        level: "warn",
        text: "Vanguard daily history before Feb 4 still uses the old dating; repair pending.",
      },
    ]);
  });

  it("Mixed with an account in scope that has no new-format rows yet: the Legacy wording", () => {
    const a = security("FAKE1");
    const b = security("FAKE2");
    legacyBook(TAXABLE, a, "2027-02-03");
    newBook(TAXABLE, a, "2027-02-05", 10100);
    legacyBook(ROTH, b, "2027-02-03");
    setting("plaid_dating_first_session", JSON.stringify({ accounts: { "1": "2027-02-05" } }));

    const f = getPositionsFreshness(db, [TAXABLE, ROTH], TODAY, { now: AT_0800 });
    expect(f.plaid.datingState).toBe("mixed");
    expect(f.plaid.everyAccountHasFirstSession).toBe(false);
    expect(plaidTrustLines(f).map((l) => l.text)).toEqual([LEGACY_LINE]);
  });

  it("Fresh and Repaired: no old-dating line", () => {
    const a = security("FAKE1");
    newBook(TAXABLE, a, "2027-02-05");
    // A new-format book with its map entry and no old-format row anywhere.
    setting("plaid_dating_first_session", JSON.stringify({ accounts: { "1": "2027-02-05" } }));
    const fresh = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(fresh.plaid.datingState).toBe("fresh");
    expect(plaidTrustLines(fresh)).toEqual([]);

    setting("plaid_dating_version", "2");
    const repaired = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(repaired.plaid.datingState).toBe("repaired");
    expect(plaidTrustLines(repaired)).toEqual([]);
  });

  it("a damaged dating setting gives a warn line and never throws", () => {
    const a = security("FAKE1");
    newBook(TAXABLE, a, "2027-02-05");
    setting("plaid_dating_first_session", "{not json");

    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(f.plaid.datingState).toBe("unreadable");
    expect(f.plaid.datingError).toContain("not valid JSON");
    const lines = plaidTrustLines(f);
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe("plaid-dating-unreadable");
    expect(lines[0].level).toBe("warn");
    expect(lines[0].text).toContain("Plaid dating setting cannot be read");
    // Freshness itself is still worked out.
    expect(f.accounts[0].plaid?.stale).toBe(false);
    // And the whole trust state still loads.
    expect(() => getAnalysisTrustState(db, [TAXABLE], TODAY, AT_0800)).not.toThrow();

    setting("plaid_dating_first_session", "{}");
    setting("plaid_dating_version", "9");
    expect(getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 }).plaid.datingState).toBe(
      "unreadable",
    );
  });
});

describe("held-back account line (A6)", () => {
  it("an account with no new-format entry and old rows dated after the expected session", () => {
    const a = security("FAKE1");
    // An old-format read dated on its run day, 02-08, is after the 02-05
    // session the morning read should store: the refresh skips the account.
    legacyBook(TAXABLE, a, "2027-02-08");
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(f.plaid.transitionHolds).toEqual([
      { accountId: TAXABLE, accountName: accountName(TAXABLE), session: "2027-02-05" },
    ]);
    expect(plaidTrustLines(f)).toEqual([
      { key: "plaid-dating-legacy", level: "warn", text: LEGACY_LINE },
      {
        key: `plaid-hold-${TAXABLE}`,
        level: "warn",
        text: `Plaid's figures for ${accountName(TAXABLE)} for the Feb 5 close cannot be stored yet: older rows dated after that session still need the repair.`,
      },
    ]);
  });

  it("no hold when the old rows are not after the expected session, or the account has an entry", () => {
    const a = security("FAKE1");
    legacyBook(TAXABLE, a, "2027-02-05");
    expect(
      getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 }).plaid.transitionHolds,
    ).toEqual([]);

    const b = security("FAKE2");
    legacyBook(ROTH, b, "2027-02-08");
    setting("plaid_dating_first_session", JSON.stringify({ accounts: { "2": "2027-02-04" } }));
    expect(
      getPositionsFreshness(db, [ROTH], TODAY, { now: AT_0800 }).plaid.transitionHolds,
    ).toEqual([]);
  });

  it("no hold once repaired", () => {
    const a = security("FAKE1");
    legacyBook(TAXABLE, a, "2027-02-08");
    setting("plaid_dating_version", "2");
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(f.plaid.transitionHolds).toEqual([]);
    expect(plaidTrustLines(f)).toEqual([]);
  });
});

describe("repeat-read line (section C)", () => {
  it("two identical newest books give one warn line with the exact wording", () => {
    const a = security("FAKE1");
    setting("plaid_dating_version", "2");
    newBook(TAXABLE, a, "2027-02-04", 10000, 500, 100);
    newBook(TAXABLE, a, "2027-02-05", 10000, 500, 100);
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(plaidTrustLines(f)).toEqual([
      {
        key: `plaid-repeat-${TAXABLE}`,
        level: "warn",
        text: `Plaid's figures for ${accountName(TAXABLE)} for the Feb 5 close are identical to the Feb 4 close; Vanguard may not have updated them.`,
      },
    ]);
    // IBKR-only scope stays silent.
    expect(plaidTrustLines(getPositionsFreshness(db, [IBKR], TODAY, { now: AT_0800 }))).toEqual([]);
  });

  it("a changed quantity is not a repeat read", () => {
    const a = security("FAKE1");
    setting("plaid_dating_version", "2");
    newBook(TAXABLE, a, "2027-02-04", 10000, 500, 100);
    newBook(TAXABLE, a, "2027-02-05", 10000, 500, 110);
    const f = getPositionsFreshness(db, [TAXABLE], TODAY, { now: AT_0800 });
    expect(plaidTrustLines(f)).toEqual([]);
  });
});

describe("source pins: the strip and drawer render only the helper's words", () => {
  const root = join(__dirname, "..", "..");
  const strip = readFileSync(join(root, "app/dashboard/components/analysis/TrustStrip.tsx"), "utf8");
  const drawer = readFileSync(
    join(root, "app/dashboard/components/analysis/TrustStripDrawer.tsx"),
    "utf8",
  );
  const label = readFileSync(join(root, "lib/ui/positions-freshness-label.ts"), "utf8");

  it("TrustStrip renders plaidTrustLines output", () => {
    expect(strip).toMatch(/import \{[^}]*plaidTrustLines[^}]*\} from "@\/lib\/ui\/positions-freshness-label"/);
    expect(strip).toContain("plaidTrustLines(positionsFreshness)");
    expect(strip).toContain("{line.text}");
    expect(strip).not.toContain("old dating");
    expect(strip).not.toContain("may not have updated");
  });

  it("TrustStripDrawer renders the same lines and the per-account note", () => {
    expect(drawer).toContain("plaidTrustLines(positionsFreshness)");
    expect(drawer).toContain("plaidAccountFreshnessNote(acct)");
    expect(drawer).toContain("{line.text}");
    expect(drawer).not.toContain("old dating");
  });

  it("the words module imports types only (safe for the client strip)", () => {
    const imports = label.match(/^import .*$/gm) ?? [];
    for (const line of imports) expect(line.startsWith("import type")).toBe(true);
  });

  it("the trust state still reaches the strip through the API route", () => {
    expect(strip).toContain("/api/analysis/trust-state");
    expect(strip.startsWith('"use client"')).toBe(true);
  });
});
