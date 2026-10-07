import {
  LEDGER_RECOMPUTE_ACK_FIELD,
  readLedgerRecomputeRefusal,
  readLedgerRecomputeReport,
  type LedgerCensus,
  type LedgerRecomputeReport,
} from "@/lib/compute/donation-recompute-contract";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";

/**
 * The disclose-and-confirm flow every Giving mutation goes through (owner
 * ruling 2026-10-06). No React in here, so the decisions are unit-testable:
 *
 *   1. send the change WITHOUT the acknowledgement — the server refuses it,
 *      writes nothing and answers with a census of the ledger;
 *   2. show that census and ask;
 *   3. on yes, send the same change WITH the acknowledgement and wait;
 *   4. show what the recompute moved.
 */

export type LedgerFlowPhase =
  | { kind: "idle" }
  /** The unacknowledged request is out; nothing has been written. */
  | { kind: "checking"; title: string }
  /** The server refused and told us what a recompute would rebuild. */
  | { kind: "confirm"; title: string; census: LedgerCensus; acceptedTaxYearsAffected: number }
  /** The acknowledged request is out; the mutation and the recompute are running. */
  | { kind: "running"; title: string; census: LedgerCensus }
  /** The change is saved. `recomputed` false means the ledger was NOT rebuilt. */
  | {
      kind: "done";
      title: string;
      recomputed: boolean;
      recomputeError: string | null;
      report: LedgerRecomputeReport | null;
    }
  /** Nothing was saved (`saved: "no"`), or we cannot tell (`saved: "unknown"`). */
  | { kind: "failed"; title: string; message: string; saved: "no" | "unknown" };

/** Adds the acknowledgement to a request body only when the user has confirmed. */
export function withLedgerAck<T extends Record<string, unknown>>(body: T, acknowledged: boolean): T {
  return acknowledged ? { ...body, [LEDGER_RECOMPUTE_ACK_FIELD]: true } : body;
}

/**
 * Reads the answer to either request and decides the next phase.
 *
 * `acknowledged` says which request this answers: false for the first
 * (unacknowledged) one, true for the confirmed one.
 */
export async function readLedgerFlowResponse(
  res: Response,
  title: string,
  acknowledged: boolean
): Promise<LedgerFlowPhase> {
  // readMutationResult consumes the body; the refusal's census rides in it.
  const raw: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  const result = await readMutationResult<{ data?: Record<string, unknown> }>(res);

  if (result.ok) {
    const data = result.data.data ?? {};
    const recomputed = data.recomputed === true;
    return {
      kind: "done",
      title,
      recomputed,
      recomputeError: recomputed
        ? null
        : typeof data.recomputeError === "string" && data.recomputeError.trim().length > 0
          ? data.recomputeError.trim()
          : "the server did not say why",
      report: readLedgerRecomputeReport(data.ledger),
    };
  }

  const refusal = readLedgerRecomputeRefusal(raw);
  if (refusal) {
    if (!acknowledged)
      return {
        kind: "confirm",
        title,
        census: refusal.ledger,
        acceptedTaxYearsAffected: refusal.acceptedTaxYearsAffected,
      };
    // We sent the acknowledgement and the server still asks for it: do not loop.
    return {
      kind: "failed",
      title,
      saved: "no",
      message: "The server did not accept the confirmation, so nothing was saved. Reload the page and try again.",
    };
  }
  return { kind: "failed", title, saved: "no", message: result.message };
}

/** The request never got an answer. */
export function ledgerFlowNetworkFailure(title: string, acknowledged: boolean): LedgerFlowPhase {
  if (!acknowledged) {
    return {
      kind: "failed",
      title,
      saved: "no",
      message: `${networkFailureMessage("check the ledger")} Nothing was saved.`,
    };
  }
  // The confirmed request may have reached the server before the connection
  // dropped — a recompute runs for minutes and a tunnel can time out first.
  return {
    kind: "failed",
    title,
    saved: "unknown",
    message:
      "The connection dropped before the server answered. The change may have been saved and the recompute may still be running. Wait a while, reload the page and check before trying again.",
  };
}

/** True while a request is out — the window in which a second click must do nothing. */
export function isLedgerFlowBusy(phase: LedgerFlowPhase): boolean {
  return phase.kind === "checking" || phase.kind === "running";
}

/** True when the report shows the recompute left every count and every sale row as it was. */
export function ledgerUnchanged(report: LedgerRecomputeReport): boolean {
  return (
    report.before.closedSales === report.after.closedSales &&
    report.before.openLots === report.after.openLots &&
    report.before.engineCloses === report.after.engineCloses &&
    report.saleRowsAddedOrChanged === 0 &&
    report.saleRowsRemovedOrChanged === 0 &&
    report.openLotsChanged === 0
  );
}

export interface LedgerFlowAction {
  /** What the user asked for, as a phrase that reads before "recomputes the
   *  entire tax-lot ledger": "Saving these lot assignments". */
  title: string;
  /** Sends the change. `acknowledged` false is the first, refused, request. */
  send: (acknowledged: boolean) => Promise<Response>;
  /** Called when the dialog closes. `saved` is true when the change was
   *  written, or may have been (no answer to the confirmed request). */
  onClosed?: (saved: boolean) => void;
}

/**
 * The flow's state machine, free of React so a double click, a cancel and a
 * dropped connection can be tested directly. One instance per screen control.
 *
 *   idle → checking → confirm → running → done
 *                 ↘ failed        ↘ failed
 *
 * `start` does nothing unless idle; `proceed` does nothing unless the confirm
 * step is showing; neither does anything while a request is out. So a second
 * click can never send a second recompute, and `close` cannot abandon a
 * request that is still running.
 */
export class LedgerFlowController {
  private phase: LedgerFlowPhase = { kind: "idle" };
  private action: LedgerFlowAction | null = null;
  private inFlight = false;
  private readonly listeners = new Set<() => void>();

  getPhase = (): LedgerFlowPhase => this.phase;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private show(next: LedgerFlowPhase): void {
    this.phase = next;
    for (const listener of [...this.listeners]) listener();
  }

  private async request(action: LedgerFlowAction, acknowledged: boolean): Promise<void> {
    this.inFlight = true;
    let next: LedgerFlowPhase;
    try {
      const res = await action.send(acknowledged);
      next = await readLedgerFlowResponse(res, action.title, acknowledged);
    } catch {
      // No answer, or an answer that could not be read at all.
      next = ledgerFlowNetworkFailure(action.title, acknowledged);
    }
    this.inFlight = false;
    this.show(next);
  }

  /** Returns the request's promise when it started one, null when the click was ignored. */
  start = (action: LedgerFlowAction): Promise<void> | null => {
    if (this.inFlight || this.phase.kind !== "idle") return null;
    this.action = action;
    this.show({ kind: "checking", title: action.title });
    return this.request(action, false);
  };

  proceed = (): Promise<void> | null => {
    const action = this.action;
    const current = this.phase;
    if (this.inFlight || !action || current.kind !== "confirm") return null;
    this.show({ kind: "running", title: action.title, census: current.census });
    return this.request(action, true);
  };

  /** Returns false when there was nothing to close or a request is still out. */
  close = (): boolean => {
    const current = this.phase;
    if (current.kind === "idle" || this.inFlight || isLedgerFlowBusy(current)) return false;
    const action = this.action;
    this.action = null;
    this.show({ kind: "idle" });
    // "unknown" counts as saved: the page must be re-read to find out.
    const saved = current.kind === "done" || (current.kind === "failed" && current.saved === "unknown");
    action?.onClosed?.(saved);
    return true;
  };
}
