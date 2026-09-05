/**
 * What the two buttons on an armed print's row should look like (live print v2
 * slice E; contract §2). Slice F renders this object and nothing else — it never
 * re-derives a gate, so the button's disabled state and the route's refusal can
 * never disagree.
 *
 * Store reads only. GET /api/print-watch/status is a pure read
 * (tests/api/no-state-changing-get.test.ts), and this function is what that GET
 * calls, so it must never write.
 */
import type Database from "better-sqlite3";
import { getPrintById, getSheet } from "@/lib/print-watch/store";
import { getSendRow } from "@/lib/digest/send-earnings-email";
import { sendStateFor, type DeliveryStateWord } from "@/lib/earnings/email-states";
import { evaluateRecapNudge } from "@/lib/earnings/recap-nudge-gate";

/**
 * The contract (§2) spells this union out literally:
 *
 *   "unsent" | "in-flight" | "sent" | "sent-by-cloud" | "delivery-unknown"
 *
 * and it is written here as `"unsent" | DeliveryStateWord` because those are the
 * SAME FIVE VALUES — `DeliveryStateWord` (lib/earnings/email-states.ts) is
 * exactly the four delivery words `sendStateFor` can return, and "unsent" is
 * the fifth case this module adds for "no row at all".
 *
 * Two reasons the alias is written rather than the literals:
 *  1. `tests/repo/no-handrolled-email-states.test.ts` fails on the string
 *     literal `"sent-by-cloud"` anywhere under lib/** or app/api/** outside the
 *     vocabulary module — and the display word for a cloud send happens to be
 *     byte-identical to the DB sentinel (unlike "in-flight"/"delivery-unknown",
 *     which are deliberately different strings from 'sending'/'delivery_unknown').
 *  2. It makes `state` below provably total: every `DeliveryStateWord` is a
 *     `RecapSendState`, so the assignment needs no cast and no default arm.
 *
 * tests/earnings/print-outputs.test.ts pins the five members at compile time
 * (a `Record<RecapSendState, true>`, which rejects both a missing and an extra
 * member) so this equivalence can never silently drift from the contract.
 */
export type RecapSendState = "unsent" | DeliveryStateWord;

export interface PrintOutputs {
  printSheet: {
    /** true when at least one non-retired line carries a `value` (spec §4.5). */
    enabled: boolean;
    /** Domain copy when disabled, else null. */
    reason: string | null;
  };
  sendRecap: {
    /** true when the gate passes AND state is "unsent". */
    enabled: boolean;
    /** Gate refusal copy, or the state word when not unsent, else null. */
    reason: string | null;
    state: RecapSendState;
    /** Set when state is "delivery-unknown" or "sent" (local). */
    providerMessageId: string | null;
  };
}

export const PRINT_SHEET_DISABLED =
  "No line has a value yet — the sheet prints once the first figure lands.";

export function evaluatePrintOutputs(db: Database.Database, printId: number): PrintOutputs {
  const print = getPrintById(db, printId);
  const lines = print ? getSheet(db, printId) : [];
  // A retired line keeps its historical value as an audit trail (089) but is
  // never coverage — the sheet must not become printable because of one.
  const hasValue = lines.some((l) => l.state !== "retired" && l.value !== null);

  const gate = evaluateRecapNudge(db, printId);
  const row = print ? getSendRow(db, print.event_id, "recap") : null;
  const state: RecapSendState = row === null ? "unsent" : sendStateFor(row.error);
  // Only a LOCAL send records the id: a cloud row was composed by the Worker and
  // a live-claim row has not reached the provider yet.
  const providerMessageId =
    state === "delivery-unknown" || state === "sent" ? (row?.provider_message_id ?? null) : null;

  return {
    printSheet: { enabled: hasValue, reason: hasValue ? null : PRINT_SHEET_DISABLED },
    sendRecap: {
      enabled: gate.ok && state === "unsent",
      // A state that is not "unsent" outranks the gate: "sent" is the useful
      // sentence, and a sent recap has by definition already passed the gate.
      reason: state !== "unsent" ? state : gate.ok ? null : gate.reason,
      state,
      providerMessageId,
    },
  };
}
