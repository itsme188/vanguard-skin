import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { recompileContracts, retiredMetricId } from "@/lib/print-watch/recompile";
import { upsertLines, getSheet } from "@/lib/print-watch/store";
import { compileContracts } from "@/lib/print-watch/contracts";
import { reconcile } from "@/lib/print-watch/reconcile";
import type { PrintWatchLine, TaggedCandidate } from "@/lib/print-watch/types";

const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
const metric = (o: Record<string, unknown> = {}) => ({
  id: A, label: "Net new ARR", definition: "Sequential change in ARR.",
  unit: "usd", kind: "point", period: "Q", basis: "na", ...o,
});

/** One tagged candidate as the parser would have written it into the pool. */
const candidate = (o: Partial<TaggedCandidate> = {}): TaggedCandidate => ({
  metric_id: `x_${A}_Q`, value: 275_000_000, value_high: null,
  raw_text: "$275.0 million", snippet: "net new ARR of $275.0 million",
  location_hint: null, not_disclosed: false,
  doc_id: 7, representation: "repA", weak_pair: false, ...o,
});

let seq = 0;

function fixture(extra: unknown[] | null) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // `source_key` is UNIQUE NOT NULL on calendar_events (migration 013), so it
  // is supplied here rather than defaulted — each fixture DB is fresh, but the
  // counter keeps the value honest if one ever seeds two events.
  seq += 1;
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source, source_key)
     VALUES ('2026-09-10','earnings','XMPL1 Q3','XMPL1','manual', ?)`,
  ).run(`manual:XMPL1:earnings:2026-09-10:${seq}`);
  const eventId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, revenue_consensus_usd, extra_metrics_json)
     VALUES (?, 'manual', 'Sheet A', 0.46, 3850000000, ?)`,
  ).run(eventId, extra === null ? null : JSON.stringify(extra));
  db.prepare(
    `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', 'window_open')`,
  ).run(eventId);
  const printId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  return { db, eventId, printId };
}

/** Seeds the sheet exactly as the watcher would: every compiled contract as a
 *  pending line. */
function seedSheet(db: Database.Database, printId: number, eventId: number) {
  const { contracts, expected } = compileContracts(db, eventId, "XMPL1");
  const lines: PrintWatchLine[] = contracts.map((c) => ({
    metric_id: c.metric_id, contract: c, expected: expected[c.metric_id] ?? null,
    state: "pending", value: null, value_high: null, snippet: null,
    source_doc_id: null, candidates_json: "[]",
  }));
  upsertLines(db, printId, lines);
}

describe("retiredMetricId", () => {
  it("takes the first free ordinal for the base id", () => {
    expect(retiredMetricId("revenue_q", new Set())).toBe("revenue_q~retired~0");
    expect(retiredMetricId("revenue_q", new Set(["revenue_q~retired~0"]))).toBe("revenue_q~retired~1");
  });
});

describe("recompileContracts", () => {
  it("reports nothing to do when the bogeys have not changed", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    const r = recompileContracts(db, printId);
    expect(r).toEqual({ added: [], updated: [], retired: [], deleted: [], conflicts: [] });
    db.close();
  });

  it("inserts a newly defined extra metric as a pending line", () => {
    const { db, eventId, printId } = fixture(null);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric()]), eventId);
    const r = recompileContracts(db, printId);
    expect(r.added).toEqual([`x_${A}_Q`]);
    const line = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q`)!;
    expect(line.state).toBe("pending");
    expect(line.contract.label).toBe("Net new ARR");
    db.close();
  });

  it("updates label, definition and expected in place when no semantic field moved", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ label: "Net new ARR (renamed)", consensus: 300_000_000 })]), eventId);
    const r = recompileContracts(db, printId);
    expect(r).toMatchObject({ added: [], retired: [], deleted: [], updated: [`x_${A}_Q`] });
    const line = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q`)!;
    expect(line.contract.label).toBe("Net new ARR (renamed)");
    expect(line.expected).toMatchObject({ value: 300_000_000 });
    db.close();
  });

  it("overwrites a semantic change IN PLACE when the line carries no evidence", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ unit: "pct" })]), eventId);
    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([]);
    expect(r.updated).toEqual([`x_${A}_Q`]);
    expect(getSheet(db, printId).filter((l) => l.metric_id.includes("~retired~"))).toEqual([]);
    expect(getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q`)!.contract.unit).toBe("percent");
    db.close();
  });

  it("RENAMES and retires a semantically-changed line that carries evidence, and compiles a fresh pending one", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ basis: "non_gaap" })]), eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);
    expect(r.added).toEqual([`x_${A}_Q`]);

    const sheet = getSheet(db, printId);
    const old = sheet.find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    expect(old.state).toBe("retired");
    expect(old.value).toBe(275_000_000);              // evidence preserved
    expect(old.contract.basis).toBe("na");            // the definition it was measured under
    const fresh = sheet.find((l) => l.metric_id === `x_${A}_Q`)!;
    expect(fresh.state).toBe("pending");
    expect(fresh.value).toBeNull();
    expect(fresh.contract.basis).toBe("non_gaap");
    db.close();
  });

  it("DELETES an uncompiled line that carries no evidence at all", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);                 // x_<A>_Q is compiled and pending
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.deleted).toEqual([`x_${A}_Q`]);
    expect(r.retired).toEqual([]);
    expect(getSheet(db, printId).some((l) => l.metric_id.startsWith("x_"))).toBe(false);
    db.close();
  });

  it("RETIRES an uncompiled line whose ONLY evidence is a snippet (Codex 5b)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET snippet = 'net new ARR of $275 million' WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);
    expect(r.deleted).toEqual([]);
    const old = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    expect(old.state).toBe("retired");
    expect(old.snippet).toBe("net new ARR of $275 million");
    db.close();
  });

  it("RETIRES on an audit trail or a range high alone, not just on a value", () => {
    for (const [column, value] of [["audit_json", `'[{"at":"2026-09-10T20:06:00Z","what":"accepted"}]'`], ["value_high", "4.1e9"]] as const) {
      const { db, eventId, printId } = fixture([metric()]);
      seedSheet(db, printId, eventId);
      db.prepare(`UPDATE print_watch_lines SET ${column} = ${value} WHERE print_id = ? AND metric_id = ?`)
        .run(printId, `x_${A}_Q`);
      db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);
      expect(recompileContracts(db, printId).retired, column).toEqual([`x_${A}_Q~retired~0`]);
      db.close();
    }
  });

  it("carries the candidate ARCHIVE across a retire-rename (Codex 5a)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(
      `INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason)
       VALUES (?, ?, '{"value":275000000}', 'duplicate-document')`,
    ).run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ basis: "non_gaap" })]), eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);
    const archived = db
      .prepare(`SELECT metric_id FROM print_watch_candidate_archive WHERE print_id = ?`)
      .all(printId) as Array<{ metric_id: string }>;
    expect(archived.map((a) => a.metric_id)).toEqual([`x_${A}_Q~retired~0`]);
    db.close();
  });

  it("an ARCHIVE row alone is not evidence ON the line: the line is deleted and the archive keeps the old id (Codex 5c)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);                 // the line's own columns stay empty
    db.prepare(
      `INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason)
       VALUES (?, ?, '{"value":1}', 'duplicate-document')`,
    ).run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.deleted).toEqual([`x_${A}_Q`]);
    expect(r.retired).toEqual([]);
    const archived = db
      .prepare(`SELECT metric_id FROM print_watch_candidate_archive WHERE print_id = ?`)
      .all(printId) as Array<{ metric_id: string }>;
    expect(archived.map((a) => a.metric_id)).toEqual([`x_${A}_Q`]);
    db.close();
  });

  it("a retired row SURVIVES a later writeLines-equivalent upsert of the live contracts (the M-F9 invariant)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ kind: "range" })]), eventId);
    recompileContracts(db, printId);

    // The watcher's own path: recompute from the CURRENT contracts and upsert.
    seedSheet(db, printId, eventId);

    const old = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    expect(old.state).toBe("retired");
    expect(old.value).toBe(275_000_000);
    db.close();
  });

  it("re-tags a retired row's candidate pool so it can never manufacture a green on the fresh line (review Critical 1)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET candidates_json = ? WHERE print_id = ? AND metric_id = ?`)
      .run(JSON.stringify([candidate({ doc_id: 7 })]), printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ basis: "non_gaap" })]), eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);

    const sheet = getSheet(db, printId);
    const old = sheet.find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    const pool = JSON.parse(old.candidates_json) as TaggedCandidate[];
    // (a) the pool follows the retired row, reading preserved verbatim …
    expect(pool.map((c) => c.metric_id)).toEqual([`x_${A}_Q~retired~0`]);
    expect(pool[0].value).toBe(275_000_000);
    expect(pool[0].snippet).toBe("net new ARR of $275.0 million");
    // (b) … and nothing under the fresh line's id survives in it.
    expect(pool.some((c) => c.metric_id === `x_${A}_Q`)).toBe(false);

    // The consequence, driven through the real machinery: collectCandidates
    // (watcher.ts) pools the WHOLE sheet, retired rows included, and reconcile
    // buckets by the candidate's own metric_id. A SECOND document agreeing
    // with the stale GAAP reading must NOT green the fresh non-GAAP line.
    const pooled = sheet.flatMap((l) => JSON.parse(l.candidates_json) as TaggedCandidate[]);
    const { contracts, expected } = compileContracts(db, eventId, "XMPL1");
    const live = reconcile(contracts, expected, [...pooled, candidate({ doc_id: 8 })], [])
      .find((l) => l.metric_id === `x_${A}_Q`)!;
    expect(live.state).toBe("single_source");                        // not "agreed"
    expect(JSON.parse(live.candidates_json) as TaggedCandidate[]).toHaveLength(1);
    db.close();
  });

  it("leaves an UNREADABLE candidate pool exactly as stored and still retires the row", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET candidates_json = '{not json' WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);
    expect(getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q~retired~0`)!.candidates_json)
      .toBe("{not json");
    db.close();
  });

  it("RETIRES a line whose ONLY evidence is a candidate pool; an empty or blank pool is NOT evidence", () => {
    for (const [pool, verdict] of [
      [`[{"metric_id":"x_${A}_Q","value":275000000,"doc_id":7}]`, "retired"],
      ["[]", "deleted"],
      ["   ", "deleted"],
    ] as const) {
      const { db, eventId, printId } = fixture([metric()]);
      seedSheet(db, printId, eventId);
      db.prepare(`UPDATE print_watch_lines SET candidates_json = ? WHERE print_id = ? AND metric_id = ?`)
        .run(pool, printId, `x_${A}_Q`);
      db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

      const r = recompileContracts(db, printId);
      expect(r.retired, pool).toEqual(verdict === "retired" ? [`x_${A}_Q~retired~0`] : []);
      expect(r.deleted, pool).toEqual(verdict === "deleted" ? [`x_${A}_Q`] : []);
      db.close();
    }
  });

  it("a SECOND retirement of the same base takes ~retired~1 and leaves ~retired~0 untouched", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ basis: "non_gaap" })]), eventId);
    expect(recompileContracts(db, printId).retired).toEqual([`x_${A}_Q~retired~0`]);

    // the replacement line earns its own evidence, then the definition moves again
    db.prepare(`UPDATE print_watch_lines SET snippet = 'net new ARR of $280.0 million' WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ basis: "non_gaap", unit: "pct" })]), eventId);
    expect(recompileContracts(db, printId).retired).toEqual([`x_${A}_Q~retired~1`]);

    const sheet = getSheet(db, printId);
    const first = sheet.find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    expect(first.state).toBe("retired");
    expect(first.value).toBe(275_000_000);
    expect(first.contract.basis).toBe("na");
    const second = sheet.find((l) => l.metric_id === `x_${A}_Q~retired~1`)!;
    expect(second.state).toBe("retired");
    expect(second.snippet).toBe("net new ARR of $280.0 million");
    expect(second.contract.basis).toBe("non_gaap");
    db.close();
  });

  it("passes the compiler's conflicts straight through and compiles no line for them", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', 'Sheet B', ?)`,
    ).run(eventId, JSON.stringify([metric({ unit: "pct" })]));
    const r = recompileContracts(db, printId);
    expect(r.conflicts).toEqual([{ id: A, fields: ["unit"] }]);
    expect(r.deleted).toEqual([`x_${A}_Q`]);
    db.close();
  });

  it("survives a print that vanishes: an unknown id returns the empty report from INSIDE the transaction (F-S6)", () => {
    const { db } = fixture(null);
    expect(recompileContracts(db, 9999)).toEqual({ added: [], updated: [], retired: [], deleted: [], conflicts: [] });
    db.close();
  });
});

describe("writeLines is serialised against recompileContracts (R-F4)", () => {
  const src = readFileSync("lib/print-watch/watcher.ts", "utf8");
  const body = src.slice(src.indexOf("function writeLines("), src.indexOf("type ParsePassResult"));
  it("slices the real function body, not the rest of the file (anchor guard)", () => {
    // If either anchor vanished the slice would run to EOF and every assertion
    // below would pass vacuously against unrelated code.
    expect(body.length).toBeGreaterThan(200);
    expect(body.length).toBeLessThan(4000);
  });
  it("wraps compile → getSheet → reconcile → upsertLines in ONE immediate transaction", () => {
    expect(body).toMatch(/db\.transaction\(/);
    expect(body).toMatch(/\.immediate\(\)/);
    const tx = body.indexOf("db.transaction(");
    expect(body.indexOf("compileContracts(")).toBeGreaterThan(tx);
    expect(body.indexOf("upsertLines(")).toBeGreaterThan(tx);
  });
  it("keeps the lease claim OUTSIDE the transaction (it is the cross-process arbiter, not the write)", () => {
    expect(body.indexOf("claimLease(db)")).toBeLessThan(body.indexOf("db.transaction("));
  });
});

/** The recompile half of the R-F4 race, and the F-S6 read placement. Both are
 *  invisible to a single-threaded in-memory test — only a source scan can fail
 *  when someone drops `.immediate()` or hoists the print read back out. */
describe("recompileContracts is ONE immediate transaction with the print read inside it (R-F4 / F-S6)", () => {
  const src = readFileSync("lib/print-watch/recompile.ts", "utf8");
  const body = src.slice(src.indexOf("export function recompileContracts("));
  it("slices the real function body (anchor guard)", () => {
    expect(body.length).toBeGreaterThan(200);
  });
  it("opens an IMMEDIATE transaction", () => {
    expect(body).toMatch(/db\.transaction\(/);
    expect(body).toMatch(/\.immediate\(\)/);
  });
  it("reads the print INSIDE that transaction (F-S6)", () => {
    const tx = body.indexOf("db.transaction(");
    expect(tx).toBeGreaterThan(-1);
    expect(body.indexOf("getPrintById(")).toBeGreaterThan(tx);
  });
});
