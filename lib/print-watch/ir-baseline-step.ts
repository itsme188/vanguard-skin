/**
 * The `ir_baseline` prepare step (spec §4.2, slice B Task 12).
 *
 * At ARM time, record every link the stored IR page currently matches, so the
 * window poll treats only LATER links as tonight's print. Keyed by EVENT
 * (plan M5), because "what was already on the page" is a fact about this
 * print, not about the company.
 *
 * A late "go" never re-baselines: once a completed marker exists for the
 * configured page, the step short-circuits. Re-running is otherwise free —
 * the side effect is one idempotent transaction (links + marker together, via
 * `recordIrBaseline`), so an aborted or superseded invocation can only repeat
 * a write, never half-record one.
 *
 * The WATCHER never baselines (M5). If the event is armed after the page has
 * already carried tonight's release, this step is what would have caught it;
 * with no baseline the watcher falls back on the strict period gate instead.
 *
 * NEITHER DOES THIS STEP, ONCE THE WINDOW IS OPEN (C1 / ruling R-C15). Slice C
 * gave the desk a press that ARMS the event at the print minute, and a press
 * enqueues these steps: taking a baseline then would record TONIGHT'S release
 * as "what the page already had", and the watcher — which seeds its seen-set
 * from `print_watch_ir_seen` on every runtime it builds, in this process or the
 * next one — would filter the real release out for the rest of the night while
 * the lane read "ok — N matching links, 0 new". So the step reads the print row
 * at RUN time and, once `effectiveWindow` has opened, completes as a no-op with
 * a note. `done`, not `failed`: nothing went wrong and there is nothing to
 * retry — the honest state is B's own "no baseline (armed late) — period gate
 * filtering" fallback, which is exactly what an empty seen-set produces.
 *
 * Registration lives in the earnings bootstrap (Task 13), NOT here: nothing in
 * this file may register at module-evaluation time, or the import cycle
 * prepare-armed-event → registry-bootstrap → print-watch → prepare-armed-event
 * is traversed eagerly and hits an uninitialised binding.
 */
import type Database from "better-sqlite3";
import { hardenedFetchBytes } from "./url-fetch";
import { redactUrl } from "./hardened-fetch";
import { pollIrPage, isAllowedIrLinkHost } from "./ir-page-adapter";
import { getPrintByEventId, getPrintWatchSource, hasIrBaseline, recordIrBaseline } from "./store";
import { effectiveWindow } from "./window";
import { stableHash, type PrepareStepDefinition } from "@/lib/earnings/prepare-armed-event";

export const IR_BASELINE_STEP_NAME = "ir_baseline";

/**
 * The one definition of "which stored page this baseline was taken from".
 *
 * Exported because the WATCHER lane asks the same question (`hasIrBaseline`
 * with this fingerprint) — two hand-rolled `stableHash([...])` calls would
 * drift the moment either side added a field, and the watcher would then
 * re-baseline mid-window. Deliberately the URL ALONE: a changed
 * `link_must_contain` narrows what we notice, it does not make last quarter's
 * posts new, and widening the key would silently discard a live baseline.
 */
export function irBaselineFingerprint(irPageUrl: string | null): string {
  return stableHash([irPageUrl]);
}

function symbolOf(db: Database.Database, eventId: number): string | null {
  const row = db.prepare(`SELECT symbol FROM calendar_events WHERE id = ?`).get(eventId) as
    | { symbol: string | null }
    | undefined;
  return row?.symbol ?? null;
}

/** The stored page's URL never reaches an error message verbatim — it is
 *  user-entered and can carry a token in the query string (M19). */
function redactedError(err: unknown, irPageUrl: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  // split/join, not replace: a `$&` sequence inside the redacted URL would be
  // a substitution pattern in a replace() replacement string.
  return raw.split(irPageUrl).join(redactUrl(irPageUrl)).slice(0, 300);
}

export function buildIrBaselineStep(
  seams: { fetchBytes?: typeof hardenedFetchBytes } = {},
): PrepareStepDefinition {
  const fetchBytes = seams.fetchBytes ?? hardenedFetchBytes;
  return {
    fingerprint: (db, eventId) => {
      const symbol = symbolOf(db, eventId);
      const source = symbol ? getPrintWatchSource(db, symbol) : null;
      return irBaselineFingerprint(source?.ir_page_url ?? null);
    },
    run: async (db, eventId, ctx) => {
      // [R13] Nothing is fetched or written on an invocation the runner has
      // already given up on.
      if (ctx.signal.aborted) return { status: "pending", reason: "aborted" };

      const symbol = symbolOf(db, eventId);
      const source = symbol ? getPrintWatchSource(db, symbol) : null;
      // No stored page is a PRECONDITION, not an attempt: the desk simply has
      // not configured this name yet. `pending` costs no attempt, and the row
      // becomes runnable the moment PUT /sources drifts the fingerprint.
      if (!source) {
        return { status: "pending", reason: `no IR page configured for ${symbol ?? "this event"}` };
      }

      const fingerprint = irBaselineFingerprint(source.ir_page_url);
      if (hasIrBaseline(db, eventId, fingerprint)) {
        return { status: "done", note: "baseline already recorded" };
      }

      // [R-C15] The window is read from the ROW, here, not from anything
      // captured when the step was enqueued: the press that arms an event
      // stamps `forced_open_at` in the same transaction that enqueues these
      // steps, and a press in ANOTHER process is a row this one has not seen
      // yet either. `now >= startMs` rather than "contains now" on purpose — a
      // window that has already CLOSED has had tonight's release on the page
      // for even longer, and a baseline taken then would blind the extension or
      // the re-press that follows it. RESIDUAL: an event armed from the
      // worksheet (no press) whose print row `ensurePrintWatch` has not created
      // yet has no window to read, and baselines as before — that is B's
      // original arm path, and the press path (the one that arms AT the print)
      // always writes the print row and the stamp before these steps run.
      const print = getPrintByEventId(db, eventId);
      const window = print ? effectiveWindow(print) : null;
      if (window && ctx.now() >= window.startMs) {
        return { status: "done", note: "window already open — no baseline possible" };
      }

      let irHost: string;
      try {
        irHost = new URL(source.ir_page_url).hostname;
      } catch {
        return { status: "failed", error: `stored IR page is not a URL (${redactUrl(source.ir_page_url)})` };
      }
      // M17: the fixed-host policy rides on the page fetch AND every redirect
      // hop of it — `hardenedFetchBytes` applies `allowHost` per hop.
      const allowHost = (h: string) => isAllowedIrLinkHost(`https://${h}/`, irHost);
      const seen = new Set<string>();
      try {
        await pollIrPage(
          {
            symbol: source.symbol,
            irPageUrl: source.ir_page_url,
            linkMustContain: source.link_must_contain,
          },
          seen,
          // [R13] The runner's cancellation reaches the SOCKET, not just the
          // checks around it: an invocation the runner has raced and moved on
          // from must not hold a hung newsroom open for the rest of the
          // fetch's own 20-second budget while its successor is already
          // running.
          (url, opts) => fetchBytes(url, { ...opts, allowHost, signal: ctx.signal }),
          { baseline: true },
        );
      } catch (err) {
        return { status: "failed", error: redactedError(err, source.ir_page_url) };
      }

      // [R13] The deadline may have fired while the page was in flight; the
      // runner has raced this invocation and moved on, so do not stamp a
      // COMPLETED baseline off it — the successor re-takes a fresh one.
      if (ctx.signal.aborted) return { status: "pending", reason: "aborted" };

      const links = [...seen];
      // ONE transaction for the links AND the completion marker (M5). An empty
      // page is a complete baseline too — 0 links is a fact, not a retry.
      recordIrBaseline(db, eventId, fingerprint, links);
      return { status: "done", note: `${links.length} link(s) baselined` };
    },
  };
}

/** The production definition. Creating it is side-effect-free — Task 13's
 *  `registerPrintWatch()` is what puts it in the registry. */
export const IR_BASELINE_STEP: PrepareStepDefinition = buildIrBaselineStep();
