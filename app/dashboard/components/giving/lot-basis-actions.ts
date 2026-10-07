import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { parseDbTimestamp, todayET } from "@/lib/calendar/date-utils";
import type { GivingFlaggedLot } from "@/lib/queries/giving-view";

/**
 * The requests and wording behind the Giving page's "basis verified" control
 * (owner request 2026-10-07). No React here, so the tests can drive these
 * against the real route.
 *
 * Unlike every other Giving write, these two requests carry no
 * ledger-recompute acknowledgement and do not go through
 * LedgerRecomputeDialog: a marker changes no tax input and nothing is
 * recomputed (see the route's header comment).
 */

/** Matches SOURCE_NOTE_MAX_LENGTH in lib/mutations/lot-basis-verifications.ts
 *  (a server module this client file must not import). A test pins the two. */
export const SOURCE_NOTE_MAX_LENGTH = 200;

export type LotBasisFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** `message` on success is something worth telling the user (or null). */
export type LotBasisActionResult = { ok: true; message: string | null } | { ok: false; message: string };

export const NOTHING_TO_UNDO_MESSAGE = "Nothing to undo: this lot was not marked verified.";

export function basisVerifiedUrl(acquisitionTransactionId: number): string {
  return `/api/donations/lots/${acquisitionTransactionId}/basis-verified`;
}

/** Why this note cannot be saved, in plain words, or null when it can. */
export function sourceNoteProblem(note: string): string | null {
  const trimmed = note.trim();
  if (trimmed.length === 0) return "Say what you checked the basis against.";
  if (trimmed.length > SOURCE_NOTE_MAX_LENGTH) {
    return `Keep the source to ${SOURCE_NOTE_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export async function sendMarkBasisVerified(
  fetcher: LotBasisFetch,
  acquisitionTransactionId: number,
  sourceNote: string
): Promise<LotBasisActionResult> {
  let res: Response;
  try {
    res = await fetcher(basisVerifiedUrl(acquisitionTransactionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceNote }),
    });
  } catch {
    return { ok: false, message: networkFailureMessage("mark the basis verified") };
  }
  const result = await readMutationResult(res);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: null };
}

export async function sendUnmarkBasisVerified(
  fetcher: LotBasisFetch,
  acquisitionTransactionId: number
): Promise<LotBasisActionResult> {
  let res: Response;
  try {
    res = await fetcher(basisVerifiedUrl(acquisitionTransactionId), { method: "DELETE" });
  } catch {
    return { ok: false, message: networkFailureMessage("undo the basis verification") };
  }
  const result = await readMutationResult<{ data?: { removed?: unknown } }>(res);
  if (!result.ok) return { ok: false, message: result.message };
  // The marker was already gone (another window, or a second click that got
  // through): say so instead of pretending something was undone.
  return { ok: true, message: result.data.data?.removed === true ? null : NOTHING_TO_UNDO_MESSAGE };
}

/**
 * One request at a time, decided outside React so it does not depend on
 * render timing: two clicks in one frame both reach the same guard and the
 * second gets null.
 */
export function createBusyGuard(): { run<T>(task: () => Promise<T>): Promise<T> | null } {
  let busy = false;
  return {
    run<T>(task: () => Promise<T>): Promise<T> | null {
      if (busy) return null;
      busy = true;
      return task().finally(() => {
        busy = false;
      });
    },
  };
}

/** The marker's date as an Eastern-time calendar day (YYYY-MM-DD), or null. */
export function verifiedOnET(verifiedAt: string | null): string | null {
  if (verifiedAt == null) return null;
  const parsed = parseDbTimestamp(verifiedAt);
  return parsed ? todayET(parsed) : null;
}

export const LOT_BASIS_CHIP_LABEL: Record<GivingFlaggedLot["state"], string> = {
  implausible: "basis implausible, verify",
  verified: "basis verified",
  "verified-stale": "basis changed since verified, verify again",
};

/** "Source: final K-1, 2020 · verified 2026-10-07", for the chip's tooltip
 *  and the line under it. Null when the lot has no marker. */
export function verificationSummary(lot: Pick<GivingFlaggedLot, "sourceNote" | "verifiedAt">): string | null {
  if (lot.sourceNote == null) return null;
  const on = verifiedOnET(lot.verifiedAt);
  return on ? `Source: ${lot.sourceNote} · verified ${on}` : `Source: ${lot.sourceNote}`;
}
