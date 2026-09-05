/**
 * "Send recap now" gate (live print v2 slice E, spec §4.5: "Refuses with domain
 * copy unless the headline pair is accepted and promoted").
 *
 * THREE conditions, all about the SAME print:
 *
 *  1. ACCEPTED — the sheet carries an accepted EPS line (adjusted preferred,
 *     GAAP as the fallback) and an accepted revenue_q, each with a real number.
 *     The two halves are checked IN THAT ORDER (R-E-C3): the EPS line is chosen
 *     by accepted-ness ALONE, and only the CHOSEN line is then required to
 *     carry a number — never "the first EPS line that happens to have one".
 *     That is the promote gate's own rule, re-stated here rather than imported:
 *     it lives in app/api/print-watch/accept/route.ts (a route) and
 *     app/dashboard/today/PrintWatchPanel.tsx (a client component), and slice E
 *     may import neither. tests/earnings/recap-nudge-gate.test.ts drives the
 *     accept route over a matrix and asserts the two answers agree.
 *  2. PROMOTED — the promote actually landed on the event: a cluster-scoped
 *     manual_actuals_at stamp AND a non-null actual_value. The recap composer
 *     reads its scoreboard from calendar_events, and CLAUDE.md's standing rule
 *     is that a recap requires actual_value — enriched_at is not enough. Better
 *     no email than a wrong one.
 *  3. STILL THE SAME PAIR (R-E3) — the stamp and the value prove that A promote
 *     happened, not that THIS pair produced it. A "Save actuals" entry in
 *     BogeysEditModal stamps the same two columns; so does a promote that was
 *     followed by accepting a different EPS candidate, or a re-import that
 *     re-stamped the event. The gate therefore RE-DERIVES what promoting the
 *     currently accepted pair would write and refuses when that differs from
 *     what the event stores.
 *
 * The copy is quoted verbatim from the E/F outputs contract §3; slice F renders
 * `reason` as-is, so these strings are the user interface.
 *
 * PURE READ. `evaluatePrintOutputs` (Task 7) calls this from a GET route body,
 * so nothing here may write — `withClusterManualActuals` heals its argument in
 * memory only.
 */
import type Database from "better-sqlite3";
import { getPrintById, getSheet } from "@/lib/print-watch/store";
import { withClusterManualActuals } from "@/lib/queries/manual-actuals-cluster";
import { mergeFinnhubActual } from "@/lib/format/finnhub-figure";
import type { PrintWatchLine } from "@/lib/print-watch/types";
import type { CalendarEvent } from "@/lib/types";

export const GATE_NO_PRINT = "No print for this event.";
export const GATE_NOT_ACCEPTED =
  "Accept the headline pair first — EPS (adjusted or GAAP) and revenue must both be accepted with a reported value.";
export const GATE_NOT_PROMOTED =
  "Promote the headline pair first — the recap reads EPS and revenue from the event, and nothing has been promoted yet.";
export const GATE_NO_ACTUAL =
  "The recap needs a reported actual on the event — promote the headline pair first.";
export const GATE_PAIR_CHANGED =
  "The accepted pair changed since the last promote — promote the headline pair again before sending.";

export type RecapNudgeGate =
  | { ok: true; eventId: number; symbol: string }
  | { ok: false; reason: string };

/** Accepted-ness ALONE — which line the promote commits to. */
function isAccepted(line: PrintWatchLine | undefined): boolean {
  return !!line && line.state === "accepted";
}

/** An accepted line that carries a real number — the type predicate narrows
 *  `value` to `number` so the pair below needs no assertion. */
function acceptedWithValue(
  line: PrintWatchLine | undefined,
): line is PrintWatchLine & { value: number } {
  return !!line && line.state === "accepted" && line.value !== null;
}

/**
 * The accepted headline pair's NUMBERS — adjusted EPS preferred, GAAP as the
 * fallback, plus revenue_q; both must be accepted and both must carry a value.
 * (A `blank` line is a real answer — "not disclosed" — but it has no number,
 * and the accept route refuses to promote one for exactly that reason.)
 *
 * R-E-C3 — the TWO STEPS ARE ORDERED, and the order is the route's:
 * app/api/print-watch/accept/route.ts commits to eps_adj_q if it is ACCEPTED
 * (whatever its value), else to eps_gaap_q if that is accepted, and only THEN
 * refuses when the CHOSEN line has no number. Picking "the first EPS line that
 * is accepted AND carries a number" instead would diverge on a state the desk
 * really reaches: `blank` is an acceptable accept state and markLineAccepted
 * flips state without touching value, so "adjusted EPS was not disclosed, GAAP
 * carries the number" leaves eps_adj_q accepted with value NULL beside a good
 * eps_gaap_q. There the route commits to adj and 400s while a fallback rule
 * would silently report the pair complete — the gate saying "you may send"
 * where the app itself refuses to promote is precisely the failure this gate
 * exists to prevent, and it would also make condition 3 below (which re-derives
 * what a promote of the CHOSEN pair would write) compare the wrong pair.
 */
export function acceptedHeadlinePair(
  lines: PrintWatchLine[],
): { eps: number; revenue: number } | null {
  const byId = new Map(lines.map((l) => [l.metric_id, l]));
  const epsLine = isAccepted(byId.get("eps_adj_q"))
    ? byId.get("eps_adj_q")
    : isAccepted(byId.get("eps_gaap_q"))
      ? byId.get("eps_gaap_q")
      : undefined;
  const revLine = byId.get("revenue_q");
  // Step 1: both halves accepted at all (the route's complete-pair guard).
  if (!epsLine || !isAccepted(revLine)) return null;
  // Step 2: the CHOSEN lines carry numbers (the route's reported-value guard).
  if (!acceptedWithValue(epsLine) || !acceptedWithValue(revLine)) return null;
  return { eps: epsLine.value, revenue: revLine.value };
}

/** Unchanged predicate, now expressed in terms of the pair. */
export function hasAcceptedHeadlinePair(lines: PrintWatchLine[]): boolean {
  return acceptedHeadlinePair(lines) !== null;
}

export function evaluateRecapNudge(db: Database.Database, printId: number): RecapNudgeGate {
  const print = getPrintById(db, printId);
  if (!print) return { ok: false, reason: GATE_NO_PRINT };

  const pair = acceptedHeadlinePair(getSheet(db, printId));
  if (!pair) return { ok: false, reason: GATE_NOT_ACCEPTED };

  // Cluster-scoped: a promote's stamp can sit on a superseded twin of this same
  // print (lib/queries/manual-actuals-cluster.ts), exactly as the recap
  // composer's own getEventByIdRow reads it.
  const event = withClusterManualActuals(
    db,
    db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(print.event_id) as
      | CalendarEvent
      | undefined,
  );
  if (!event) return { ok: false, reason: GATE_NO_PRINT };
  if (!event.manual_actuals_at) return { ok: false, reason: GATE_NOT_PROMOTED };
  if (!event.actual_value) return { ok: false, reason: GATE_NO_ACTUAL };

  // R-E3: `manual_actuals_at` + `actual_value` prove that A promote happened —
  // not that THIS pair produced it. A "Save actuals" entry in BogeysEditModal
  // stamps the same two columns, and so does a promote that was followed by
  // accepting a different EPS candidate, or by a re-import that re-stamped the
  // event. Re-derive what promoting the CURRENT pair would write and compare.
  //
  // mergeFinnhubActual is the exact formatter the promote path uses
  // (saveManualActuals -> mergeFinnhubActual), so merging today's pair into the
  // stored string is a no-op precisely when the stored string already reflects
  // that pair. One formatter, one source of truth, no new column — and the
  // comparison is deliberately made at the formatter's own precision, because
  // that is exactly the precision the recap will narrate.
  //
  // R-E-C4 — compare NORMALISED forms, not raw strings. `mergeFinnhubActual`
  // renders revenue as `Rev 100000000`, but other writers of this same column
  // use `toLocaleString("en-US")` (lib/calendar/enrich-actuals.ts,
  // workers/cron/src/enrich-actuals.ts), and commas are a live production shape
  // for actual_value. The LOCAL enrichment road cannot clobber a promote, but
  // the cloud one can: lib/calendar/cloud-reconcile.ts writes
  // `actual_value = COALESCE(?, actual_value)` with no manual_actuals_at guard,
  // so a Worker tick after a local promote can rewrite the IDENTICAL pair with
  // separators. Raw equality would then answer "the accepted pair changed" when
  // it did not, wedging the button with copy that misdescribes the state.
  // Running the stored string back through the same formatter costs nothing:
  // parseFinnhubFigure already strips separators, so every genuinely different
  // pair still differs, and free text that parses to neither field normalises
  // to null and still refuses.
  const wouldWrite = mergeFinnhubActual(event.actual_value, {
    eps: pair.eps,
    revenue: pair.revenue,
  });
  const storedNormalized = mergeFinnhubActual(event.actual_value, {});
  if (wouldWrite !== storedNormalized) {
    return { ok: false, reason: GATE_PAIR_CHANGED };
  }

  return { ok: true, eventId: print.event_id, symbol: print.symbol.toUpperCase() };
}
