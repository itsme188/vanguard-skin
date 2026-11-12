/**
 * query_data_confidence (Portfolio Assistant plan, Task 6; P3).
 *
 * Protects: the trust verdict the chat gives is the header indicator's own
 * (getDataConfidence), always for the whole portfolio, with the engine's text
 * passed through unchanged (dollar amounts included; owner ruling
 * 2026-11-12: the chat is read by the owner only). Bound: a book of two held
 * names, one priced today and one 30 days stale, scores price freshness 50
 * with "1/2 securities have recent prices"; a scoped chat gets the same
 * whole-portfolio result with covers_every_account true and a scope_note
 * naming the chat's accounts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/queries/data-confidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/data-confidence")>();
  return { ...actual, getDataConfidence: vi.fn(actual.getDataConfidence) };
});

import { getDataConfidence } from "@/lib/queries/data-confidence";
import { queryDataConfidenceTool, WHOLE_PORTFOLIO_SCOPE_NOTE } from "@/lib/chat/composite/data-confidence";
import { COMPOSITE_MAX_JSON_CHARS } from "@/lib/chat/composite/shared";
import { addDays, todayET } from "@/lib/calendar/date-utils";

const NOW = new Date("2026-03-02T15:00:00Z");
const TODAY = "2026-03-02";
let db: Database.Database;

function held(symbol: string, accountId: number, priceDate: string): void {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', 'USD')")
    .run(symbol, `${symbol} Co`).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 10, 100, ?, ?)",
  ).run(accountId, id, TODAY, `h-${symbol}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 10)").run(id, priceDate);
}

type Out = {
  error?: string;
  overall: { score: number; level: string };
  cap_reason: string | null;
  dimensions: Record<string, { score: number; reason: string; action_needed: boolean }>;
  actions: { severity: string; action: string }[];
  actions_total: number;
  integrity: { critical: number; warnings: number; lot_drift_checked: boolean };
  scope: { all_accounts: boolean };
  covers_every_account: boolean;
  scope_note?: string;
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(getDataConfidence).mockClear();
  held("FRSH", 1, TODAY);
  held("OLDP", 3, "2026-01-31");
});

describe("query_data_confidence", () => {
  it("returns the engine's scores (parity)", () => {
    const out = queryDataConfidenceTool.run(db, {}, { accountIds: undefined, today: TODAY, now: NOW }) as Out;
    const engine = getDataConfidence(db, NOW);
    expect(out.overall).toEqual({ score: engine.overallScore, level: engine.overallLevel });
    expect(out.dimensions.price_freshness.score).toBe(engine.priceFreshness.score);
    expect(out.dimensions.holdings_recency.score).toBe(engine.holdingsRecency.score);
    expect(out.dimensions.cash_accuracy.score).toBe(engine.cashAccuracy.score);
    expect(out.dimensions.enrichment.score).toBe(engine.enrichmentCompleteness.score);
    expect(out.dimensions.valuation_coverage.score).toBe(engine.valuationCoverage.score);
    expect(out.actions_total).toBe(engine.actions.length);
    expect(out.integrity.critical).toBe(engine.integrity.critical.length);
    expect(out.integrity.warnings).toBe(engine.integrity.warnings.length);
    expect(out.integrity.lot_drift_checked).toBe(engine.integrity.lotDriftChecked);
  });

  it("matches the hand-worked price freshness", () => {
    const out = queryDataConfidenceTool.run(db, {}, { accountIds: undefined, today: TODAY, now: NOW }) as Out;
    expect(out.dimensions.price_freshness.score).toBe(50);
    expect(out.dimensions.price_freshness.reason).toBe("1/2 securities have recent prices");
    expect(out.scope.all_accounts).toBe(true);
  });

  it("a scoped chat gets the whole-portfolio result, labelled as covering every account", () => {
    const all = queryDataConfidenceTool.run(db, {}, { accountIds: undefined, today: TODAY, now: NOW }) as Out;
    expect(all.covers_every_account).toBe(true);
    expect(all.scope_note).toBeUndefined();

    const one = queryDataConfidenceTool.run(db, {}, { accountIds: [3], accountName: "IBKR", today: TODAY, now: NOW }) as Out;
    expect(one.error).toBeUndefined();
    expect(one.covers_every_account).toBe(true);
    expect(one.scope.all_accounts).toBe(true);
    expect(one.scope_note).toBe(WHOLE_PORTFOLIO_SCOPE_NOTE("IBKR"));
    expect(one.scope_note).toBe(
      "Data confidence covers every account, not only this chat's scope (IBKR). Items that belong to an account name it.",
    );
    // The same figures as the all-accounts answer: nothing is filtered.
    const { scope_note: _note, ...rest } = one;
    expect(rest).toEqual(all);
    expect(JSON.stringify(one)).toContain("FRSH");

    const two = queryDataConfidenceTool.run(db, {}, { accountIds: [1, 3], today: TODAY, now: NOW }) as Out;
    expect(two.error).toBeUndefined();
    expect(two.scope_note).toBe(WHOLE_PORTFOLIO_SCOPE_NOTE("Vanguard Taxable, IBKR"));
  });

  it("a scope with no account answers without calling the engine", () => {
    const empty = queryDataConfidenceTool.run(db, {}, { accountIds: [], today: TODAY, now: NOW });
    expect(empty).toEqual({ error: "No account is in this chat's scope." });
    expect(getDataConfidence).not.toHaveBeenCalled();
  });

  it("passes dollar amounts in the engine's text through unchanged", () => {
    const actual = getDataConfidence(db, NOW);
    const amountText = "Cash moved $1,234.56 on 2026-02-03 and -$12k later; 3 of 40 names";
    vi.mocked(getDataConfidence).mockReturnValueOnce({
      ...actual,
      capReason: amountText,
      cashAccuracy: { ...actual.cashAccuracy, detail: amountText },
      actions: [{ ...(actual.actions[0] ?? { severity: "warning" }), message: amountText } as (typeof actual.actions)[number]],
      integrity: {
        ...actual.integrity,
        warnings: [{ ...(actual.integrity.warnings[0] ?? {}), reason: amountText } as (typeof actual.integrity.warnings)[number]],
      },
    });
    const out = queryDataConfidenceTool.run(db, {}, { accountIds: undefined, today: TODAY, now: NOW }) as Out & {
      items: { integrity_findings: { shown: { reason: string }[] } };
    };
    expect(out.cap_reason).toBe(amountText);
    expect(out.dimensions.cash_accuracy.reason).toBe(amountText);
    expect(out.actions[0].action).toBe(amountText);
    expect(out.items.integrity_findings.shown.map((f) => f.reason)).toContain(amountText);
    expect(JSON.stringify(out)).not.toContain("amount omitted");
  });

  it("writes nothing and stays under the size cap with 60 positions", () => {
    for (let i = 0; i < 60; i++) held(`Z${i}`, 1 + (i % 3), i % 2 ? TODAY : "2025-12-01");
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const out = queryDataConfidenceTool.run(db, {}, { accountIds: undefined, today: TODAY, now: NOW });
    const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(JSON.stringify(out).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
  });
});

describe("query_data_confidence names the items (Q12)", () => {
  const today = todayET();
  type Items = {
    stale_prices: { window_days: number; count: number; shown: { symbol: string; last_price_date: string | null; days_since: number | null }[]; list_info?: { truncated: boolean } };
    holdings_by_account: { account: string; latest_date: string | null; positions: number }[];
    held_without_transactions: { count: number; shown: string[] };
    missing_contract_data: { count: number; shown: string[] };
    integrity_findings: { count: number };
  };

  function heldOn(symbol: string, accountId: number, priceDate: string | null): void {
    const id = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', 'USD')")
      .run(symbol, `${symbol} Co`).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 10, 100, ?, ?)",
    ).run(accountId, id, today, `hq-${symbol}`);
    if (priceDate) db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 10)").run(id, priceDate);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    heldOn("FRSH", 1, today);
    heldOn("OLDP", 3, addDays(today, -30));
    heldOn("NOPR", 3, null);
  });

  it("lists the stale and unpriced held securities, never-priced then oldest first, matching the score's count", () => {
    const out = queryDataConfidenceTool.run(db, {}, { accountIds: undefined, today }) as { items: Items };
    const engine = getDataConfidence(db);
    expect(out.items.stale_prices.shown).toEqual([
      { symbol: "NOPR", last_price_date: null, days_since: null },
      { symbol: "OLDP", last_price_date: addDays(today, -30), days_since: 30 },
    ]);
    expect(out.items.stale_prices.count).toBe(engine.priceFreshness.totalHeld - engine.priceFreshness.pricedRecent);
    expect(out.items.stale_prices.window_days).toBe(3);
    expect(out.items.holdings_by_account.map((a) => a.account).sort()).toEqual(engine.holdingsRecency.perAccount.map((a) => a.name).sort());
    expect(out.items.held_without_transactions.shown).toEqual(["FRSH", "NOPR", "OLDP"]);
    expect(out.items.missing_contract_data.count).toBe(engine.enrichmentCompleteness.missing.length);
    expect(out.items.integrity_findings.count).toBe(engine.integrity.critical.length + engine.integrity.warnings.length);
  });

  it("caps each list with list_info", () => {
    for (let i = 0; i < 30; i++) heldOn(`ST${i}`, 1, addDays(today, -10 - i));
    const out = queryDataConfidenceTool.run(db, {}, { accountIds: undefined, today }) as { items: Items };
    expect(out.items.stale_prices.shown).toHaveLength(10);
    expect(out.items.stale_prices.count).toBe(32);
    expect(out.items.stale_prices.list_info?.truncated).toBe(true);
    expect(out.items.stale_prices.shown[1].symbol).toBe("ST29");
  });
});
