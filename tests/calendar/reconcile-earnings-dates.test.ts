import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

interface SeedRow {
  source: string;
  symbol: string;
  date: string;
  epsActual?: number | null;
  actualValue?: string | null;
  dateStatus?: string | null;
}

function seed(r: SeedRow): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, actual_value, date_status, raw_json)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.source,
      r.date,
      `${r.symbol} earnings`,
      r.symbol,
      `${r.source}:${r.symbol}:${r.date}`,
      r.actualValue ?? null,
      r.dateStatus ?? null,
      JSON.stringify({ entry: { epsActual: r.epsActual ?? null } }),
    ).lastInsertRowid as number;
}

function row(id: number) {
  return db
    .prepare(
      "SELECT source, event_date, date_status, date_conflict_with, superseded FROM calendar_events WHERE id = ?",
    )
    .get(id) as {
    source: string;
    event_date: string;
    date_status: string | null;
    date_conflict_with: string | null;
    superseded: number;
  };
}

const TODAY = "2026-06-08";

describe("reconcileEarningsDates", () => {
  it("marks confirmed when both sources agree on a future date", () => {
    const f = seed({ source: "finnhub", symbol: "AAPL", date: "2026-06-12" });
    const n = seed({ source: "nasdaq", symbol: "AAPL", date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(f).date_status).toBe("confirmed");
    expect(row(f).superseded).toBe(0);
    expect(row(n).superseded).toBe(1); // duplicate of the canonical row
  });

  it("flags a future-vs-future disagreement as conflict, Nasdaq provisional", () => {
    const f = seed({ source: "finnhub", symbol: "NVDA", date: "2026-06-11" });
    const n = seed({ source: "nasdaq", symbol: "NVDA", date: "2026-06-13" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(n).date_status).toBe("conflict");
    expect(row(n).superseded).toBe(0); // Nasdaq is the provisional canonical
    expect(row(n).date_conflict_with).toBe("finnhub:2026-06-11");
    expect(row(f).superseded).toBe(1);
  });

  it("auto-resolves a past-with-actuals date over a future ghost (the RBRK case)", () => {
    // Finnhub says Mon Jun 8 (future ghost); Nasdaq says Thu Jun 4 with a
    // reported actual → demonstrably happened, so Jun 4 wins silently.
    const ghost = seed({ source: "finnhub", symbol: "RBRK", date: "2026-06-08" });
    const real = seed({ source: "nasdaq", symbol: "RBRK", date: "2026-06-04", epsActual: -0.19 });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(real).date_status).toBe("confirmed");
    expect(row(real).superseded).toBe(0);
    expect(row(ghost).superseded).toBe(1); // ghost dies → drops off "this week"
  });

  it("marks single when only one source has the name", () => {
    const f = seed({ source: "finnhub", symbol: "TSLA", date: "2026-06-12" });
    reconcileEarningsDates(db, { today: TODAY });
    expect(row(f).date_status).toBe("single");
    expect(row(f).superseded).toBe(0);
  });

  it("locks a user-confirmed/manual date and supersedes conflicting sync rows, idempotently", () => {
    const manual = seed({ source: "manual", symbol: "META", date: "2026-06-10", dateStatus: "user_confirmed" });
    const finn = seed({ source: "finnhub", symbol: "META", date: "2026-06-15" });

    reconcileEarningsDates(db, { today: TODAY });
    expect(row(manual).date_status).toBe("user_confirmed");
    expect(row(manual).superseded).toBe(0);
    expect(row(manual).event_date).toBe("2026-06-10"); // user date untouched
    expect(row(finn).superseded).toBe(1);

    // Re-run (simulating the next sync) must not revert anything.
    reconcileEarningsDates(db, { today: TODAY });
    expect(row(manual).date_status).toBe("user_confirmed");
    expect(row(manual).event_date).toBe("2026-06-10");
    expect(row(finn).superseded).toBe(1);
  });

  it("clusters dual-class siblings (GOOG/GOOGL) as one event", () => {
    const goog = seed({ source: "finnhub", symbol: "GOOG", date: "2026-06-12" });
    const googl = seed({ source: "nasdaq", symbol: "GOOGL", date: "2026-06-12" });
    reconcileEarningsDates(db, { today: TODAY });
    // Same event, agreeing date → confirmed + one superseded.
    const states = [row(goog), row(googl)];
    expect(states.filter((s) => s.superseded === 0)).toHaveLength(1);
    expect(states.find((s) => s.superseded === 0)!.date_status).toBe("confirmed");
  });
});

// ── Enrichment carry-forward on supersession ────────────────────────
//
// QA finding (2026-07-02/03): confirming a conflicting date created a fresh
// manual event and orphaned the known consensus, user-entered actuals,
// reaction snapshot, sent-email audit rows, bogeys, and skips on the
// superseded event — the row regressed to "Consensus not yet published" and
// the sweep cron could re-send a duplicate preview. Supersession must be
// data-preserving: enrichment COALESCEs forward, child rows re-point.

function enrich(
  id: number,
  e: {
    consensusEstimate?: string;
    consensusValue?: string;
    actualValue?: string;
    reactionSnapshot?: string;
    enrichedAt?: string;
  },
) {
  db.prepare(
    `UPDATE calendar_events SET
       consensus_estimate = COALESCE(?, consensus_estimate),
       consensus_value = COALESCE(?, consensus_value),
       actual_value = COALESCE(?, actual_value),
       reaction_snapshot = COALESCE(?, reaction_snapshot),
       enriched_at = COALESCE(?, enriched_at)
     WHERE id = ?`,
  ).run(
    e.consensusEstimate ?? null,
    e.consensusValue ?? null,
    e.actualValue ?? null,
    e.reactionSnapshot ?? null,
    e.enrichedAt ?? null,
    id,
  );
}

function enrichment(id: number) {
  return db
    .prepare(
      `SELECT consensus_estimate, consensus_value, actual_value, reaction_snapshot, enriched_at
       FROM calendar_events WHERE id = ?`,
    )
    .get(id) as {
    consensus_estimate: string | null;
    consensus_value: string | null;
    actual_value: string | null;
    reaction_snapshot: string | null;
    enriched_at: string | null;
  };
}

describe("reconcileEarningsDates — enrichment carry-forward", () => {
  it("carries consensus/actuals/reaction/enriched_at from superseded rows onto the canonical", () => {
    const nasdaq = seed({ source: "nasdaq", symbol: "NKE", date: "2026-06-09" });
    enrich(nasdaq, {
      consensusEstimate: "EPS 0.11 · Rev 10.7B",
      consensusValue: "EPS 0.11",
      actualValue: "EPS 0.14 · Rev 11.50B",
      reactionSnapshot: '{"source":"yahoo","spy":0.4}',
      enrichedAt: "2026-06-09 21:00:00",
    });
    const manual = seed({ source: "manual", symbol: "NKE", date: "2026-06-09", dateStatus: "user_confirmed" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(nasdaq).superseded).toBe(1);
    const m = enrichment(manual);
    expect(m.consensus_estimate).toBe("EPS 0.11 · Rev 10.7B");
    expect(m.consensus_value).toBe("EPS 0.11");
    expect(m.actual_value).toBe("EPS 0.14 · Rev 11.50B");
    expect(m.reaction_snapshot).toBe('{"source":"yahoo","spy":0.4}');
    expect(m.enriched_at).toBe("2026-06-09 21:00:00");
  });

  it("never overwrites the canonical's own non-NULL enrichment", () => {
    const finn = seed({ source: "finnhub", symbol: "TER", date: "2026-06-12" });
    enrich(finn, { consensusValue: "EPS 9.99" });
    const manual = seed({ source: "manual", symbol: "TER", date: "2026-06-12", dateStatus: "user_confirmed" });
    enrich(manual, { consensusValue: "EPS 1.23" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(enrichment(manual).consensus_value).toBe("EPS 1.23");
  });

  it("re-points earnings_emails, earnings_bogeys, and earnings_email_skips to the canonical", () => {
    const nasdaq = seed({ source: "nasdaq", symbol: "NKE", date: "2026-06-09" });
    const manual = seed({ source: "manual", symbol: "NKE", date: "2026-06-09", dateStatus: "user_confirmed" });
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md) VALUES (?, 'preview', 'x@y.com', 'md')",
    ).run(nasdaq);
    db.prepare(
      "INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', 'me', 0.14)",
    ).run(nasdaq);
    db.prepare("INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')").run(nasdaq);

    reconcileEarningsDates(db, { today: TODAY });

    expect(
      (db.prepare("SELECT event_id FROM earnings_emails WHERE phase='preview'").get() as { event_id: number })
        .event_id,
    ).toBe(manual);
    expect(
      (db.prepare("SELECT event_id FROM earnings_bogeys").get() as { event_id: number }).event_id,
    ).toBe(manual);
    expect(
      (db.prepare("SELECT event_id FROM earnings_email_skips").get() as { event_id: number }).event_id,
    ).toBe(manual);
  });

  it("keeps the canonical's audit row when re-pointing would violate UNIQUE(event_id, phase)", () => {
    const nasdaq = seed({ source: "nasdaq", symbol: "NKE", date: "2026-06-09" });
    const manual = seed({ source: "manual", symbol: "NKE", date: "2026-06-09", dateStatus: "user_confirmed" });
    const ins = db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md) VALUES (?, 'preview', 'x@y.com', ?)",
    );
    ins.run(nasdaq, "old-md");
    ins.run(manual, "canonical-md");

    expect(() => reconcileEarningsDates(db, { today: TODAY })).not.toThrow();

    const canonicalRow = db
      .prepare("SELECT ai_output_md FROM earnings_emails WHERE event_id = ? AND phase='preview'")
      .get(manual) as { ai_output_md: string };
    expect(canonicalRow.ai_output_md).toBe("canonical-md");
    // The colliding superseded-side row stays put for audit.
    const oldRow = db
      .prepare("SELECT ai_output_md FROM earnings_emails WHERE event_id = ? AND phase='preview'")
      .get(nasdaq) as { ai_output_md: string };
    expect(oldRow.ai_output_md).toBe("old-md");
  });
});

describe("reconcileEarningsDates — manual future row vs reported quarter (qa:today-earningshub-add-ticker--manual-future-event-supersedes-reported-quarter)", () => {
  it("a manual FUTURE row never supersedes a reported print in the same proximity cluster", () => {
    // META really printed 2026-06-01 (actual captured); the user then adds a
    // manual 2026-06-10 row for "next quarter" — 9 days apart, so proximity
    // clustering would have merged them and the manual rung would have stolen
    // the actual/reaction/audit rows onto the future event.
    const reported = seed({
      source: "finnhub",
      symbol: "META",
      date: "2026-06-01",
      actualValue: "EPS 6.18 \u00b7 Rev 60.80B",
      epsActual: 6.18,
    });
    const manual = seed({ source: "manual", symbol: "META", date: "2026-06-10" });
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md) VALUES (?, 'recap', 'x@y.com', 'md')",
    ).run(reported);

    reconcileEarningsDates(db, { today: TODAY });

    // The reported quarter stays canonical with its own data + audit rows.
    expect(row(reported).superseded).toBe(0);
    expect(row(reported).date_status).toBe("confirmed");
    const rep = db
      .prepare("SELECT actual_value FROM calendar_events WHERE id = ?")
      .get(reported) as { actual_value: string | null };
    expect(rep.actual_value).toContain("6.18");
    expect(
      (db.prepare("SELECT event_id FROM earnings_emails WHERE phase='recap'").get() as { event_id: number })
        .event_id,
    ).toBe(reported);

    // The user's future event survives as its own cluster, not superseded,
    // and carries NO migrated enrichment from last quarter.
    expect(row(manual).superseded).toBe(0);
    expect(row(manual).date_status).toBe("user_confirmed");
    const man = db
      .prepare("SELECT actual_value, reaction_snapshot FROM calendar_events WHERE id = ?")
      .get(manual) as { actual_value: string | null; reaction_snapshot: string | null };
    expect(man.actual_value).toBeNull();
    expect(man.reaction_snapshot).toBeNull();

    // Idempotent on re-run.
    reconcileEarningsDates(db, { today: TODAY });
    expect(row(reported).superseded).toBe(0);
    expect(row(manual).superseded).toBe(0);
  });

  it("a manual row that is ITSELF the reported print still wins the whole cluster", () => {
    // Verifier/user-corrected rows land as source='manual'; once the print is
    // captured on them they remain the locked canonical over vendor dups.
    const manual = seed({
      source: "manual",
      symbol: "WMT",
      date: "2026-06-04",
      actualValue: "EPS 0.61 \u00b7 Rev 168B",
    });
    const finn = seed({ source: "finnhub", symbol: "WMT", date: "2026-06-05" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(manual).date_status).toBe("user_confirmed");
    expect(row(finn).superseded).toBe(1);
  });

  it("a vendor future ghost still folds into the reported row when no manual row exists (RBRK class preserved)", () => {
    const reported = seed({
      source: "finnhub",
      symbol: "RBRK",
      date: "2026-06-04",
      epsActual: 0.33,
    });
    const ghost = seed({ source: "nasdaq", symbol: "RBRK", date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(reported).superseded).toBe(0);
    expect(row(reported).date_status).toBe("confirmed");
    expect(row(ghost).superseded).toBe(1);
  });
});

describe("reconcileEarningsDates — stale prior-quarter row must not shadow an agreeing pair", () => {
  // NBIS 2026-08-10: finnhub 07-29 (wrong-date phantom, no actuals) sits exactly
  // CLUSTER_PROXIMITY_DAYS before nasdaq 08-12, so all three rows cluster.
  // find-first picked the 07-29 phantom as "the" finnhub claim and manufactured
  // a conflict even though a live finnhub row AGREES with nasdaq at 08-12.
  it("confirms on any finnhub/nasdaq date agreement even with an older finnhub phantom in the cluster", () => {
    const phantom = seed({ source: "finnhub", symbol: "NBIS", date: "2026-07-29" });
    const nasdaq = seed({ source: "nasdaq", symbol: "NBIS", date: "2026-08-12" });
    const agreeing = seed({ source: "finnhub", symbol: "NBIS", date: "2026-08-12" });

    reconcileEarningsDates(db, { today: "2026-08-10" });

    expect(row(agreeing).date_status).toBe("confirmed");
    expect(row(agreeing).superseded).toBe(0);
    expect(row(agreeing).date_conflict_with).toBeNull();
    expect(row(nasdaq).superseded).toBe(1);
    expect(row(phantom).superseded).toBe(1);
  });

  it("points a genuine disagreement at the LATEST finnhub claim, never the phantom", () => {
    const phantom = seed({ source: "finnhub", symbol: "NBIS", date: "2026-07-29" });
    const nasdaq = seed({ source: "nasdaq", symbol: "NBIS", date: "2026-08-12" });
    seed({ source: "finnhub", symbol: "NBIS", date: "2026-08-11" });

    reconcileEarningsDates(db, { today: "2026-08-10" });

    expect(row(nasdaq).date_status).toBe("conflict");
    expect(row(nasdaq).date_conflict_with).toBe("finnhub:2026-08-11");
    expect(row(phantom).superseded).toBe(1);
  });
});
