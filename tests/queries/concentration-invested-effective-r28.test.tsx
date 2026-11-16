/**
 * Owner ruling 28 = B (2026-11-16): the effective number of positions
 * (1 / Herfindahl) counts cash as dilution since the 2026-11-15 ruling, so it
 * is no longer a count of names. Both figures are shown:
 *  - whole portfolio: weights over the whole book, cash in the denominator;
 *  - invested only: weights over the invested (non-cash) holdings alone.
 * Plus two follow-ups on the same card: an all-cash scope says "All cash"
 * instead of 0, and borrowed cash (a negative cash equivalent) gets one
 * plain line.
 *
 * Synthetic tickers and round figures only. The card is rendered with
 * renderToStaticMarkup (precedent tests/dashboard/concentration-cash-line-k5);
 * RiskMetrics fetches in an effect, so it is source-pinned.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getConcentrationMetrics, type ConcentrationMetrics, type ClassificationCoverage } from "@/lib/queries/analysis";
import { computeConcentration } from "@/lib/compute/risk";
import { splitConcentrationUniverse, type ConcentrationPosition } from "@/lib/queries/concentration-universe";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const privacy = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: privacy.on, setPrivate: () => {}, toggle: () => {} }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/analysis",
}));

import {
  ClassificationCard,
  EFFECTIVE_WHOLE_LABEL,
  EFFECTIVE_INVESTED_LABEL,
  ALL_CASH_EFFECTIVE_VALUE,
  NEGATIVE_CASH_SENTENCE,
} from "@/app/dashboard/components/analysis/ClassificationCard";
import { ToastProvider } from "@/app/dashboard/components/Toast";

let nextId = 1;
const pos = (symbol: string, marketValue: number, isCashEquivalent = false): ConcentrationPosition => ({
  securityId: nextId++,
  symbol,
  securityName: symbol,
  marketValue,
  priced: true,
  valuedAfterAsOf: false,
  isCashEquivalent,
});

describe("splitConcentrationUniverse: invested-only Herfindahl", () => {
  it("with no cash the two indexes are equal", () => {
    const s = splitConcentrationUniverse([pos("ZZA", 600), pos("ZZB", 300), pos("ZZC", 100)]);
    // 0.6^2 + 0.3^2 + 0.1^2 = 0.46
    expect(s.herfindahl).toBeCloseTo(0.46, 12);
    expect(s.investedHerfindahl).toBeCloseTo(0.46, 12);
  });

  it("with cash the whole-portfolio index is diluted and the invested index is not", () => {
    // Invested 1,000 (600/300/100) plus 1,000 cash: whole book 2,000.
    const s = splitConcentrationUniverse([
      pos("ZZA", 600),
      pos("ZZB", 300),
      pos("ZZC", 100),
      pos("ZZM", 1_000, true),
    ]);
    // Whole: 0.3^2 + 0.15^2 + 0.05^2 = 0.115 = (1/2)^2 x 0.46
    expect(s.herfindahl).toBeCloseTo(0.115, 12);
    // Invested: weights over 1,000 only = 0.46
    expect(s.investedHerfindahl).toBeCloseTo(0.46, 12);
    // So the whole-portfolio effective count is the larger one.
    expect(1 / s.herfindahl!).toBeGreaterThan(1 / s.investedHerfindahl!);
    expect(1 / s.herfindahl!).toBeCloseTo(8.695652173913, 9);
    expect(1 / s.investedHerfindahl!).toBeCloseTo(2.173913043478, 9);
  });

  it("a short counts at its size in the invested denominator too", () => {
    const s = splitConcentrationUniverse([pos("ZZA", 300), pos("ZZB", -100), pos("ZZM", 400, true)]);
    // Whole gross 800: (300/800)^2 + (100/800)^2 = 0.15625
    expect(s.herfindahl).toBeCloseTo(0.15625, 12);
    // Invested gross 400: 0.75^2 + 0.25^2 = 0.625
    expect(s.investedHerfindahl).toBeCloseTo(0.625, 12);
  });

  it("borrowed cash is in neither denominator", () => {
    const s = splitConcentrationUniverse([pos("ZZA", 100), pos("ZZB", 100), pos("ZZN", -50, true)]);
    expect(s.herfindahl).toBeCloseTo(0.5, 12);
    expect(s.investedHerfindahl).toBeCloseTo(0.5, 12);
  });

  it("all cash, or empty: both null", () => {
    expect(splitConcentrationUniverse([pos("ZZM", 500, true)]).investedHerfindahl).toBeNull();
    expect(splitConcentrationUniverse([]).investedHerfindahl).toBeNull();
  });
});

describe("both concentration readers publish the invested figure and borrowed cash", () => {
  let db: Database.Database;
  let acct: number;

  function seed(symbol: string, quantity: number, price: number, cash = false) {
    const id = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, fund_category, multiplier) VALUES (?, ?, ?, ?, 1)",
      )
      .run(symbol, `${symbol} Test`, cash ? "Mutual Fund" : "Stock", cash ? "Cash Equivalent" : null)
      .lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-03-02')",
    ).run(acct, id, quantity, Math.abs(quantity * price));
    db.prepare(
      "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-03-02', 'test')",
    ).run(id, price);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO accounts (name) VALUES ('R28 Test')").run();
    acct = (db.prepare("SELECT id FROM accounts WHERE name = 'R28 Test'").get() as { id: number }).id;
  });

  it("a book with cash: whole hhi diluted, invested hhi not, both readers agree", () => {
    seed("ZZA", 60, 10);
    seed("ZZB", 30, 10);
    seed("ZZC", 10, 10);
    seed("ZZM", 1_000, 1, true);
    const m = getConcentrationMetrics(db);
    expect(m.hhi).toBeCloseTo(0.115, 12);
    expect(m.invested_hhi).toBeCloseTo(0.46, 12);
    expect(m.negative_cash).toEqual({ market_value: 0, holding_count: 0 });
    const r = computeConcentration(db);
    expect(r.herfindahl).toBeCloseTo(m.hhi, 12);
    expect(r.investedHerfindahl).toBeCloseTo(m.invested_hhi, 12);
    expect(r.negativeCashHoldingCount).toBe(0);
  });

  it("a book with no cash: the two are equal", () => {
    seed("ZZA", 60, 10);
    seed("ZZB", 40, 10);
    const m = getConcentrationMetrics(db);
    expect(m.invested_hhi).toBeCloseTo(m.hhi, 12);
  });

  it("borrowed cash is reported on its own", () => {
    seed("ZZA", 60, 10);
    seed("ZZN", -200, 1, true);
    const m = getConcentrationMetrics(db);
    expect(m.negative_cash).toEqual({ market_value: -200, holding_count: 1 });
    expect(computeConcentration(db).negativeCashHoldingCount).toBe(1);
  });

  it("an all-cash book: hhi and invested hhi are both 0", () => {
    seed("ZZM", 1_000, 1, true);
    const m = getConcentrationMetrics(db);
    expect(m.hhi).toBe(0);
    expect(m.invested_hhi).toBe(0);
    expect(m.top_positions).toEqual([]);
  });
});

function coverage(): ClassificationCoverage {
  return { total: 3, classified: 3, unclassified: 0, coverage_pct: 100, by_source: [], unclassified_securities: [] };
}

function concentration(over: Partial<ConcentrationMetrics> = {}): ConcentrationMetrics {
  return {
    hhi: 0.115,
    effective_positions: 8.7,
    invested_hhi: 0.46,
    top_positions: [{ symbol: "ZZA", security_name: "ZZA Test", market_value: 600, weight_pct: 30 }],
    cash: { market_value: 1_000, weight_pct: 50, holding_count: 1 },
    negative_cash: { market_value: 0, holding_count: 0 },
    warnings: [],
    ...over,
  };
}

function render(c: ConcentrationMetrics): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <ClassificationCard concentration={c} coverage={coverage()} />
    </ToastProvider>,
  );
}

function tile(html: string): string {
  const start = html.indexOf("Effective Positions");
  return html.slice(start, html.indexOf("Classification Coverage", start));
}

describe("Concentration Metrics card: Effective Positions tile", () => {
  beforeEach(() => {
    privacy.on = false;
  });

  it("shows the whole-portfolio and invested-only figures with their labels", () => {
    const t = tile(render(concentration()));
    expect(t).toContain(EFFECTIVE_WHOLE_LABEL);
    expect(t).toContain(EFFECTIVE_INVESTED_LABEL);
    expect(t).toContain(">9<"); // round(1 / 0.115) = 9
    expect(t).toContain(">2<"); // round(1 / 0.46) = 2
  });

  it("masks both figures in privacy mode", () => {
    privacy.on = true;
    const t = tile(render(concentration()));
    expect(t).not.toContain(">9<");
    expect(t).not.toContain(">2<");
    expect(t).toContain("•••");
  });

  it("an all-cash scope reads 'All cash', never 0", () => {
    const t = tile(
      render(
        concentration({
          hhi: 0,
          effective_positions: 0,
          invested_hhi: 0,
          top_positions: [],
          cash: { market_value: 1_000, weight_pct: 100, holding_count: 1 },
        }),
      ),
    );
    expect(t).toContain(ALL_CASH_EFFECTIVE_VALUE);
    expect(t).not.toContain(">0<");
    expect(t).not.toContain(EFFECTIVE_INVESTED_LABEL);
  });

  it("borrowed cash gets one plain line; none when there is no borrowing", () => {
    expect(render(concentration())).not.toContain(NEGATIVE_CASH_SENTENCE);
    const html = render(concentration({ negative_cash: { market_value: -200, holding_count: 1 } }));
    expect(html).toContain(NEGATIVE_CASH_SENTENCE);
  });
});

describe("Risk Decomposition card shows the invested-only count and the borrowing line", () => {
  const src = readFileSync("app/dashboard/components/RiskMetrics.tsx", "utf8");
  it("reads the invested Herfindahl through the shared effective-position helper", () => {
    anchorIndex(src, "effectivePositionsFromHHI(metrics.investedHerfindahl)");
    anchorIndex(src, "EFFECTIVE_INVESTED_LABEL");
  });
  it("draws the borrowing line from negativeCashHoldingCount", () => {
    anchorIndex(src, "metrics.negativeCashHoldingCount");
    anchorIndex(src, "NEGATIVE_CASH_SENTENCE");
  });
});
