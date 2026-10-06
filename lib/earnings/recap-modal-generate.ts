/**
 * The "gen recap" generate flow behind POST /api/earnings/recap-modal
 * (TODO 2026-08-28 pairing follow-up (1), DECIDED Option 1 in full).
 *
 * The route is a thin SSE wrapper; this module owns the run:
 *
 *   enriching  → one single-event enrichment pass (optional)
 *   generating → the AI compose, attempt 1
 *   retrying   → the AI compose again, at most once
 *
 * RETRY CAP. The decision reads "server retry cap of 2 total attempts": the
 * AI step runs at most TWICE per click (one automatic retry), never more.
 * A new click is a new run with a fresh budget.
 *
 * CANCELLATION. The caller's AbortSignal is checked before every phase and
 * raced against the in-flight compose, and it is handed to the composer so
 * the provider request itself can be torn down. An aborted run never
 * retries, never reports a result, and throws `RecapGenerateAborted`.
 *
 * NOTHING IS STORED by the compose: this is a preview surface (no email, no
 * audit row), so a failed or cancelled run leaves the recap state exactly as
 * it was. The enrichment pass writes vendor actuals when it finds them —
 * idempotent facts about the print, not a recap — and only runs when the
 * run was not already cancelled.
 */

import type Database from "better-sqlite3";
import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import { describePrePrintFloor } from "@/lib/earnings/pre-print-floor";
import {
  composeEarningsEmail,
  EarningsEmailError,
  EarningsOutputTruncatedError,
  EarningsRefusalError,
} from "@/lib/digest/send-earnings-email";
import {
  classifyAnthropicError,
  classifyAnthropicErrorMessage,
  type AnthropicErrorClassification,
} from "@/lib/ai/classify-anthropic-error";
import type { CalendarEvent } from "@/lib/types";

/** Total attempts at the AI step per click — the first try plus ONE retry. */
export const RECAP_MAX_ATTEMPTS = 2;

export type RecapProgressPhase = "enriching" | "generating" | "retrying";

export interface RecapProgress {
  phase: RecapProgressPhase;
  /** Plain words, safe to show the user verbatim. */
  message: string;
  attempt?: number;
  maxAttempts?: number;
}

/** The terminal payload — byte-for-byte what the JSON response used to be. */
export type RecapModalPayload =
  | {
      success: true;
      html: string;
      title: string;
      eventDate: string | null;
      symbol: string;
      phase: "recap";
      markdown: string;
      enriched: { actual: string | null; reaction: unknown } | null;
    }
  | {
      success: false;
      prePrint: true;
      code: "pre_print";
      error: string;
      opensAt: string | null;
    }
  | { success: false; notReady: true; error: string };

export class RecapGenerateAborted extends Error {
  constructor() {
    super("Recap generation was cancelled.");
    this.name = "RecapGenerateAborted";
  }
}

/** A failure whose `message` is already plain language for the user. */
export class RecapGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecapGenerateError";
  }
}

export interface GenerateRecapOpts {
  runEnrichmentFirst: boolean;
  signal: AbortSignal;
  onProgress: (progress: RecapProgress) => void;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RecapGenerateAborted();
}

/** Settles (by rejecting) the moment the signal aborts. */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RecapGenerateAborted());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // The race below may leave this promise unobserved once compose wins.
  promise.catch(() => {});
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

function classifyVendor(err: unknown): AnthropicErrorClassification | null {
  return (
    classifyAnthropicError(err) ??
    (err instanceof Error ? classifyAnthropicErrorMessage(err.message) : null)
  );
}

/** Kinds a second attempt cannot fix — retrying only delays the answer. */
const NO_RETRY_KINDS = new Set(["billing", "auth", "model_capability"]);

function isRetryable(err: unknown): boolean {
  // Domain refusals this pipeline raised on purpose (not found, not an
  // earnings event, no actuals yet) will fail identically every time.
  if (err instanceof EarningsEmailError && err.status < 500) return false;
  // A refusal is the model's answer, not a transport fault — asking again
  // bills again for the same answer.
  if (err instanceof EarningsRefusalError) return false;
  // Truncated at the TOP output rung: the compose already escalated through
  // every rung, so a retry would re-run the whole ladder (up to six AI
  // requests for one click instead of two).
  if (err instanceof EarningsOutputTruncatedError) return false;
  const vendor = classifyVendor(err);
  if (vendor && NO_RETRY_KINDS.has(vendor.kind)) return false;
  return true;
}

/**
 * Plain-language copy for a failed run. Raw upstream text (vendor envelopes,
 * request ids, model ids) never reaches the client — it stays in the server
 * log; only our own domain sentences pass through.
 */
export function recapFailureMessage(err: unknown, attempts: number): string {
  if (err instanceof RecapGenerateError) return err.message;
  if (err instanceof EarningsEmailError && err.status < 500) return err.message;
  if (err instanceof EarningsRefusalError) {
    return "The AI declined to write this recap. Nothing was saved or sent.";
  }
  if (err instanceof EarningsOutputTruncatedError) {
    return "The recap came back cut off even at the largest size, so it was discarded. Nothing was saved or sent.";
  }
  const vendor = classifyVendor(err);
  if (vendor) return vendor.userMessage;
  const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
  return `Couldn't write the recap${tries}. Nothing was saved or sent — try again in a minute.`;
}

export async function generateRecapForModal(
  db: Database.Database,
  eventId: number,
  opts: GenerateRecapOpts,
): Promise<RecapModalPayload> {
  const { signal, onProgress } = opts;
  let enriched: { actual: string | null; reaction: unknown } | null = null;

  throwIfAborted(signal);

  if (opts.runEnrichmentFirst) {
    onProgress({ phase: "enriching", message: "Checking for the reported results…" });
    try {
      const results = await runEnrichment(db, { eventId });
      const r = results[0];
      // Pre-print floor (2026-08-28): the runner fetched/wrote/pushed
      // nothing. Refuse the compose too rather than narrating a print that
      // has not happened — a recap composed off a stale or absent actual is
      // exactly the wrong-numbers failure the floor exists to prevent.
      if (r?.reason === "pre_print" && r.prePrint) {
        // `opensAt` is the instant the caller is waiting for: the slot-window
        // floor when the slot basis refused the row, else the recorded
        // release instant. Null when neither could be composed.
        const opensAt = r.prePrint.floor ?? r.prePrint.release;
        return {
          success: false,
          prePrint: true,
          code: "pre_print",
          error:
            describePrePrintFloor(r.prePrint.eventDate, r.prePrint) +
            " Enrichment and the recap stay locked until then.",
          opensAt: opensAt ? opensAt.toISOString() : null,
        };
      }
      if (r) {
        enriched = { actual: r.actual, reaction: r.reaction };
      }
    } catch (err) {
      // Enrichment failures shouldn't block compose — the AI prompt has
      // a fallback web_search ask for missing actuals.
      console.warn(`[recap-modal] Enrichment for event ${eventId} failed:`, err);
    }
    // The single-event pass is one unit of work and takes no signal: a cancel
    // that lands during it takes effect here, before the AI step. Any actuals
    // it stored are idempotent vendor facts about the print, not a recap.
    throwIfAborted(signal);
  }

  // The composer forwards `signal` to the provider request, so a cancel
  // tears the AI call down; the race below also ends THIS run at once.
  const composeOpts = { signal };

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= RECAP_MAX_ATTEMPTS; attempt++) {
    // Never start (or restart) the AI step for a run that was cancelled.
    throwIfAborted(signal);
    onProgress(
      attempt === 1
        ? {
            phase: "generating",
            message: "Writing the recap — this usually takes 30 to 90 seconds…",
            attempt,
            maxAttempts: RECAP_MAX_ATTEMPTS,
          }
        : {
            phase: "retrying",
            message: `The first try failed — retrying (attempt ${attempt} of ${RECAP_MAX_ATTEMPTS})…`,
            attempt,
            maxAttempts: RECAP_MAX_ATTEMPTS,
          },
    );

    const aborted = abortRejection(signal);
    try {
      const pending = composeEarningsEmail(db, eventId, "recap", composeOpts);
      // If the abort wins the race, the orphaned compose must not surface
      // as an unhandled rejection.
      pending.catch(() => {});
      const composed = await Promise.race([pending, aborted.promise]);
      // A result that lands after a cancel is dropped, not reported.
      throwIfAborted(signal);
      const event = db
        .prepare(`SELECT event_date FROM calendar_events WHERE id = ?`)
        .get(eventId) as Pick<CalendarEvent, "event_date"> | undefined;
      return {
        success: true,
        html: composed.html,
        title: composed.title,
        eventDate: event?.event_date ?? null,
        symbol: composed.symbol,
        phase: "recap",
        markdown: composed.markdown,
        enriched,
      };
    } catch (err) {
      // A cancel is never a failure to retry — whatever the in-flight call
      // threw on its way down.
      if (err instanceof RecapGenerateAborted || signal.aborted) {
        throw new RecapGenerateAborted();
      }
      // The no-actuals-yet guard (409) is the EXPECTED outcome of clicking
      // "gen" before a company reports — a structured flag, not an error,
      // with the internals (event id, API paths) kept out of the copy.
      if (err instanceof EarningsEmailError && err.status === 409) {
        return {
          success: false,
          notReady: true,
          error:
            "Not reported yet — the recap unlocks once actuals land, or after you save reported actuals in the bogeys editor.",
        };
      }
      console.error(
        `[recap-modal] Compose attempt ${attempt} of ${RECAP_MAX_ATTEMPTS} failed for event ${eventId}:`,
        err,
      );
      lastError = err;
      if (!isRetryable(err)) {
        throw new RecapGenerateError(recapFailureMessage(err, attempt));
      }
    } finally {
      aborted.dispose();
    }
  }

  throw new RecapGenerateError(recapFailureMessage(lastError, RECAP_MAX_ATTEMPTS));
}
