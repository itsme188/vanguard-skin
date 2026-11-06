/**
 * T1 slice 2: basis-aware scoring. A GAAP actual is never scored against an
 * adjusted bogey (and the reverse); unknown basis scores nothing; an unscored
 * pair prints both figures with their bases and no delta. Synthetic figures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  basesMatch,
  basisWord,
  scoreEligibility,
  scoreWhenBasisMatches,
  epsRowScoring,
} from "@/lib/earnings/basis-scoring";
import { resolveEpsActualBasis } from "@/lib/earnings/headline-basis";
import { renderHeadlineTable } from "@/lib/digest/send-earnings-email";
import { upsertPrint, upsertLines } from "@/lib/print-watch/store";
import { factsFromLines } from "@/lib/print-watch/read-facts";
import { compileContracts } from "@/lib/print-watch/contracts";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const baseEvent = {
  consensus_estimate: "EPS 1.00 · Rev 1000000000",
  consensus_value: null,
  reaction_snapshot: null,
};

describe("the equivalence rule", () => {
  it("(b) adjusted vs adjusted and (c) GAAP vs GAAP match", () => {
    expect(basesMatch("non_gaap", "non_gaap")).toBe(true);
    expect(basesMatch("gaap", "gaap")).toBe(true);
  });
  it("(a) GAAP vs adjusted never matches, either way round", () => {
    expect(basesMatch("gaap", "non_gaap")).toBe(false);
    expect(basesMatch("non_gaap", "gaap")).toBe(false);
  });
  it("(d) an unknown basis matches nothing, even itself", () => {
    expect(basesMatch(null, "non_gaap")).toBe(false);
    expect(basesMatch("gaap", null)).toBe(false);
    expect(basesMatch(null, null)).toBe(false);
  });
  it("na matches any known basis; the vendor feed matches adjusted and itself, never GAAP", () => {
    expect(basesMatch("na", "gaap")).toBe(true);
    expect(basesMatch("non_gaap", "na")).toBe(true);
    expect(basesMatch("vendor", "vendor")).toBe(true);
    expect(basesMatch("vendor", "non_gaap")).toBe(true);
    expect(basesMatch("gaap", "vendor")).toBe(false);
    expect(basesMatch("vendor", "gaap")).toBe(false);
  });
  it("the shared gate computes only when bases match", () => {
    expect(scoreWhenBasisMatches("non_gaap", "non_gaap", () => 5)).toBe(5);
    expect(scoreWhenBasisMatches("gaap", "non_gaap", () => 5)).toBeNull();
  });
  it("the note names both bases; an unknown one says so", () => {
    const g = scoreEligibility("EPS", "gaap", "non_gaap");
    expect(g.scored).toBe(false);
    expect(g.scored === false && g.note).toMatch(/actual is GAAP; the bogey is adjusted/);
    const u = scoreEligibility("EPS", "non_gaap", null);
    expect(u.scored === false && u.note).toMatch(/unknown basis/);
    expect(basisWord("vendor")).toMatch(/basis unspecified/);
  });
});

describe("the recap scoreboard", () => {
  const row = (actual: string, stamped: boolean) => ({
    ...baseEvent,
    actual_value: actual,
    manual_actuals_at: stamped ? "2026-11-04 21:00:00" : null,
    vendor_actual_value: null,
  });

  it("(a) a GAAP actual vs the adjusted consensus: both figures shown, no delta, labelled", () => {
    const md = renderHeadlineTable(row("EPS 0.40 · Rev 1100000000", true), "XMPL", "recap", null, {
      epsActualBasis: "gaap",
    });
    expect(md).toMatch(/\| \*\*EPS\*\* \| 1\.00 \| 0\.40 \| — \|/);
    expect(md).toMatch(/EPS not scored: the actual is GAAP; the bogey is vendor feed/);
    expect(md).toMatch(/Actuals basis: EPS is GAAP/);
    // Revenue has no GAAP/adjusted distinction: still scored.
    expect(md).toMatch(/\| \*\*Revenue\*\* \|.*\| \+10\.0% \|/);
  });

  it("(b) an adjusted actual is scored as today", () => {
    const md = renderHeadlineTable(row("EPS 1.10 · Rev 1100000000", true), "XMPL", "recap", null, {
      epsActualBasis: "non_gaap",
    });
    expect(md).toMatch(/\| \*\*EPS\*\* \| 1\.00 \| 1\.10 \| \+10\.0% \|/);
    expect(md).not.toMatch(/not scored/);
  });

  it("a vendor actual vs the vendor consensus is scored as today, with no option passed", () => {
    const md = renderHeadlineTable(row("EPS 1.10 · Rev 1100000000", false), "XMPL", "recap", null);
    expect(md).toMatch(/\| \*\*EPS\*\* \| 1\.00 \| 1\.10 \| \+10\.0% \|/);
  });

  it("a stamped row with no option follows the 2026-10-08 ruling (adjusted) and scores", () => {
    const md = renderHeadlineTable(row("EPS 1.10 · Rev 1100000000", true), "XMPL", "recap", null);
    expect(md).toMatch(/\+10\.0%/);
  });
});

describe("display rows", () => {
  it("a GAAP row is unscored with the note; others follow the stamp", () => {
    expect(epsRowScoring({ eps_actual_basis: "gaap" }).scored).toBe(false);
    expect(epsRowScoring({ eps_actual_basis: "non_gaap" }).scored).toBe(true);
    expect(epsRowScoring({ manual_actuals_at: null }).scored).toBe(true);
    expect(epsRowScoring({ manual_actuals_at: "2026-11-04 21:00:00" }).scored).toBe(true);
  });
});

// ── DB-backed: the basis of the stored actual, and the sheet path ─────────
let db: Database.Database;
let eventId: number;
let printId: number;

function line(metricId: string, over: Partial<PrintWatchLine> = {}): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: metricId,
      definition: "d",
      basis: metricId === "eps_gaap_q" ? "gaap" : metricId === "eps_adj_q" ? "non_gaap" : "na",
      period: "Q",
      currency: "USD",
      unit: metricId === "revenue_q" ? "usd" : "per_share",
      kind: "point",
      segment: null,
    },
    expected: null,
    state: "accepted",
    value: null,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, actual_value, manual_actuals_at)
         VALUES ('manual','earnings','2026-11-04','X','XMPL','k1','EPS 0.40 · Rev 1100000000', datetime('now'))`,
      )
      .run().lastInsertRowid,
  );
  printId = upsertPrint(db, eventId, "XMPL", "2026-11-04", "16:05");
});
afterEach(() => db.close());

describe("the basis of the stored actual", () => {
  const ev = () => ({ id: eventId, actual_value: "EPS 0.40 · Rev 1100000000", manual_actuals_at: "x" });

  it("a promote that fell back to the GAAP line reads as GAAP", () => {
    upsertLines(db, printId, [
      line("eps_adj_q", { state: "blank", value: null }),
      line("eps_gaap_q", { value: 0.4 }),
      line("revenue_q", { value: 1_100_000_000 }),
    ]);
    expect(resolveEpsActualBasis(db, ev())).toBe("gaap");
  });

  it("a promote from the adjusted line reads as adjusted", () => {
    upsertLines(db, printId, [
      line("eps_adj_q", { value: 0.4 }),
      line("eps_gaap_q", { value: 0.1 }),
    ]);
    expect(resolveEpsActualBasis(db, ev())).toBe("non_gaap");
  });

  it("no sheet (hand-entered) follows the ruling: adjusted; an unstamped row is the vendor's", () => {
    db.prepare(`DELETE FROM print_watch_prints WHERE id = ?`).run(printId);
    expect(resolveEpsActualBasis(db, ev())).toBe("non_gaap");
    expect(resolveEpsActualBasis(db, { ...ev(), manual_actuals_at: null })).toBe("vendor");
  });
});

describe("the sheet path is basis-matched by construction", () => {
  it("(e) an accepted adjusted line scores against its bogey; a GAAP line never carries a bogey", () => {
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, revenue_consensus_usd)
       VALUES (?, 'manual', 'curated', 1.0, 1000000000)`,
    ).run(eventId);
    const { contracts, expected } = compileContracts(db, eventId, "XMPL");
    expect(expected["eps_gaap_q"]).toBeUndefined();
    expect(expected["eps_adj_q"]?.value).toBe(1);
    expect(contracts.find((c) => c.metric_id === "eps_adj_q")?.basis).toBe("non_gaap");
    const facts = factsFromLines(
      [
        line("eps_adj_q", { value: 1.1, expected: expected["eps_adj_q"] }),
        line("eps_gaap_q", { value: 0.4 }),
      ],
      null,
    );
    expect(facts.find((f) => f.metric_id === "eps_adj_q")?.verdict).toBe("beat");
    expect(facts.find((f) => f.metric_id === "eps_gaap_q")?.verdict).toBe("n/a");
  });
});
