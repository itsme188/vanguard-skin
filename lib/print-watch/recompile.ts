/**
 * Explicit, transactional recompile of one print's sheet (spec §4.7: "When a
 * semantic field changes on an `id` with evidence, the existing line is marked
 * `retired` (evidence preserved) and a new line is compiled.
 * `recompileContracts(db, printId)` is explicit and transactional.").
 *
 * WHY THE RENAME. `print_watch_lines`' primary key is (print_id, metric_id)
 * (migration 089), so a retired row and its replacement cannot share a key.
 * The retired row therefore takes `<metric_id>~retired~<n>` and keeps every
 * column it had. That is safe because `upsertLines` (store.ts) is a pure
 * per-row INSERT … ON CONFLICT DO UPDATE that never deletes and never touches
 * a metric_id absent from its input, and `~retired~` ids are never compiled —
 * so no later parse can resurrect or clobber one.
 *
 * `retractDocument` (delivery.ts) already treats 'retired' like 'accepted':
 * evidence is trimmed, the reading is left alone.
 *
 * A retired row's stored `contract_json` still names the PRE-rename metric_id,
 * by design — that is the definition the reading was measured under. Readers
 * that treat a `contract.metric_id` / row-key mismatch as "contract drift"
 * (delivery.ts, store.ts `clearLineAccepted`) must carve `retired` out FIRST,
 * as `delivery.ts` already does; it is not drift.
 *
 * KNOWN BEHAVIOUR CHANGE (recorded, not a bug): the watcher's pre-print re-arm
 * refreshes contracts only while the sheet is `untouched`
 * (`sheet.every(l => l.state === 'pending' && l.candidates_json === '[]')`), so
 * once a retired row exists that refresh stops firing for the print.
 * `recompileContracts` is the explicit path for that refresh, and retirement
 * requires evidence — which already makes the sheet "touched" in practice.
 *
 * `updated` may name a row whose stored `contract_json` differs from the fresh
 * one ONLY in JSON key order (rows written by `upsertLines` before slice F
 * serialised the contract in a different field order). That is an in-place
 * rewrite of identical semantics, not a change — do not chase it as a bug.
 *
 * `writeLines` (watcher.ts) wraps its own compile→reconcile→upsert in the same
 * kind of immediate transaction (R-F4), which is what stops a stale watcher
 * write from reverting a recompiled row across processes.
 */
import type Database from "better-sqlite3";
import { compileContracts } from "./contracts";
import { getPrintById } from "./store";
import type { ExpectedValue, LineContract } from "./types";

export interface RecompileReport {
  added: string[];
  updated: string[];
  retired: string[];
  deleted: string[];
  conflicts: Array<{ id: string; fields: string[] }>;
}

/** The four fields that make a line a DIFFERENT measurement. Label, definition
 *  and the expected numbers may change freely — they are presentation and
 *  bogey, not identity. */
const SEMANTIC: Array<keyof LineContract> = ["unit", "kind", "basis", "period"];

export function retiredMetricId(base: string, taken: ReadonlySet<string>): string {
  for (let n = 0; ; n += 1) {
    const candidate = `${base}~retired~${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface Row {
  metric_id: string;
  contract_json: string;
  expected_json: string | null;
  state: string;
  value: number | null;
  value_high: number | null;
  snippet: string | null;
  candidates_json: string;
  audit_json: string | null;
}

/**
 * "This row has been measured, so its reading must survive a definition
 * change." EVERY persisted trace counts, not just the three the first draft
 * named: a line can carry a high end of a range, a verbatim snippet, or an
 * audit trail of an acceptance that was later withdrawn, with `value` null.
 * Deleting any of those loses the record of what was read off the wire.
 *
 * An archived CANDIDATE is deliberately NOT evidence on the line: rows in
 * `print_watch_candidate_archive` are candidates the line never adopted (they
 * are archived by migration 089's document-identity rebuild and by the
 * candidate-fate path), so a line whose only trace is an archive row was never
 * measured and is deleted — its archive rows simply stay under the old id.
 *
 * The candidate-pool check is deliberately TEXTUAL and conservative: anything
 * that is neither empty nor the literal `[]` counts, so an unreadable pool is
 * still treated as a trace and retained rather than deleted. Every writer in
 * the repo emits either `JSON.stringify(candidates)` (upsertLines) or the
 * literal `"[]"` (pendingLines), so no real writer produces a spaced empty
 * array.
 */
function hasEvidence(row: Row): boolean {
  if (row.state === "accepted") return true;
  if (row.value !== null) return true;
  if (row.value_high !== null) return true;
  if (row.snippet !== null) return true;
  if (row.audit_json !== null) return true;
  const trimmed = row.candidates_json.trim();
  return trimmed !== "" && trimmed !== "[]";
}

function semanticallySame(stored: string, next: LineContract): boolean {
  let parsed: LineContract;
  try {
    parsed = JSON.parse(stored) as LineContract;
  } catch {
    return false; // unreadable contract is never "the same measurement"
  }
  return SEMANTIC.every((f) => parsed[f] === next[f]);
}

/**
 * Re-tags every candidate INSIDE a retiring row's pool to the row's new id.
 *
 * WHY (review round 1, Critical 1). The retire renames the row KEY and the
 * archive rows, but the `metric_id` recorded on each candidate object inside
 * `candidates_json` is a separate copy — and the fresh line takes the base id
 * back in the same transaction. `collectCandidates` (watcher.ts) walks the
 * WHOLE sheet with no state filter and pools every candidate it finds;
 * `reconcile` then buckets purely by the candidate's own `metric_id`. So a
 * stale candidate measured under the OLD contract would be handed to the new
 * line, and a second document agreeing with it would turn that line `agreed`
 * (green) under a definition it was never measured against — a manufactured
 * verification, which is the one failure this sheet exists to prevent.
 *
 * Re-tagging keeps the reading verbatim under the retired id, where no
 * compiled contract can ever claim it.
 *
 * @returns the rewritten JSON, or null when nothing needs rewriting or the
 *   pool cannot be read. An unreadable pool is left exactly as stored — the
 *   same stance `collectCandidates` takes: a corrupt pool costs that metric
 *   its history, never the run.
 */
function retagCandidatePool(candidatesJson: string, from: string, to: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidatesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let changed = false;
  const retagged = parsed.map((c) => {
    if (c !== null && typeof c === "object" && !Array.isArray(c) && (c as { metric_id?: unknown }).metric_id === from) {
      changed = true;
      return { ...(c as Record<string, unknown>), metric_id: to };
    }
    return c;
  });
  return changed ? JSON.stringify(retagged) : null;
}

/** Re-derives one print's sheet from its bogey rows. One immediate
 *  transaction; a print that does not exist returns an all-empty report. */
export function recompileContracts(db: Database.Database, printId: number): RecompileReport {
  const empty = (): RecompileReport => ({ added: [], updated: [], retired: [], deleted: [], conflicts: [] });

  const run = db.transaction((): RecompileReport => {
    // F-S6: INSIDE the transaction. A print deleted by a concurrent event merge
    // between an outside check and these INSERTs would fail the foreign key
    // instead of returning the honest "nothing to do" this function promises.
    const print = getPrintById(db, printId);
    if (!print) return empty();

    const { contracts, expected, conflicts } = compileContracts(db, print.event_id, print.symbol);
    const byId = new Map<string, LineContract>(contracts.map((c) => [c.metric_id, c]));

    const rows = db
      .prepare(
        `SELECT metric_id, contract_json, expected_json, state, value, value_high, snippet, candidates_json, audit_json
           FROM print_watch_lines WHERE print_id = ? ORDER BY metric_id`,
      )
      .all(printId) as Row[];
    const taken = new Set(rows.map((r) => r.metric_id));

    const setContract = db.prepare(
      `UPDATE print_watch_lines SET contract_json = ?, expected_json = ?, updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    );
    const rename = db.prepare(
      `UPDATE print_watch_lines SET metric_id = ?, state = 'retired', updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    );
    // Codex 5: archived candidates were measured under the OLD definition and
    // belong to the retired row. Leaving them on the live id would hand the
    // fresh line evidence gathered against a contract it does not have.
    const renameArchive = db.prepare(
      `UPDATE print_watch_candidate_archive SET metric_id = ? WHERE print_id = ? AND metric_id = ?`,
    );
    const retagPool = db.prepare(
      `UPDATE print_watch_lines SET candidates_json = ? WHERE print_id = ? AND metric_id = ?`,
    );
    const remove = db.prepare(`DELETE FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`);
    const insert = db.prepare(
      `INSERT INTO print_watch_lines
         (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, '[]', datetime('now'))`,
    );

    const report: RecompileReport = { added: [], updated: [], retired: [], deleted: [], conflicts };
    const expectedJson = (id: string): string | null => {
      const e: ExpectedValue | undefined = expected[id];
      return e ? JSON.stringify(e) : null;
    };
    /** One retirement: rename the line, the archive rows AND the candidate
     *  objects inside the row's own pool — all three carry the old id, and the
     *  fresh line is about to take that id back (see `retagCandidatePool`). */
    const retire = (row: Row): string => {
      const renamed = retiredMetricId(row.metric_id, taken);
      taken.add(renamed);
      rename.run(renamed, printId, row.metric_id);
      renameArchive.run(renamed, printId, row.metric_id);
      const retagged = retagCandidatePool(row.candidates_json, row.metric_id, renamed);
      if (retagged !== null) retagPool.run(retagged, printId, renamed);
      report.retired.push(renamed);
      return renamed;
    };

    for (const row of rows) {
      // A row already retired by an earlier recompile is history: never
      // re-examined, never re-retired, never deleted.
      if (row.metric_id.includes("~retired~")) continue;

      const next = byId.get(row.metric_id);
      if (!next) {
        if (hasEvidence(row)) retire(row);
        else {
          remove.run(printId, row.metric_id);
          report.deleted.push(row.metric_id);
        }
        continue;
      }

      byId.delete(row.metric_id); // consumed — whatever is left is new
      const nextContract = JSON.stringify(next);
      const nextExpected = expectedJson(row.metric_id);

      if (semanticallySame(row.contract_json, next)) {
        if (row.contract_json !== nextContract || row.expected_json !== nextExpected) {
          setContract.run(nextContract, nextExpected, printId, row.metric_id);
          report.updated.push(row.metric_id);
        }
        continue;
      }

      if (hasEvidence(row)) {
        retire(row);
        insert.run(printId, row.metric_id, nextContract, nextExpected);
        report.added.push(row.metric_id);
      } else {
        setContract.run(nextContract, nextExpected, printId, row.metric_id);
        report.updated.push(row.metric_id);
      }
    }

    for (const [metricId, contract] of byId) {
      insert.run(printId, metricId, JSON.stringify(contract), expectedJson(metricId));
      report.added.push(metricId);
    }

    report.added.sort();
    report.updated.sort();
    report.retired.sort();
    report.deleted.sort();
    return report;
  });

  return run.immediate();
}
