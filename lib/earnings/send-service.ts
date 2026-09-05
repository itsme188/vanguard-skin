/**
 * The canonical earnings send path (live print v2 slice E, spec §4.5).
 *
 * EVERY earnings email the Mac sends goes through `sendEarningsCandidate`: the
 * 15-minute sweep loop, the "send recap now" nudge on Today, and the manual
 * POST /api/earnings/email. It owns the claim (moved out of the sender
 * internals), the KV marker dance, the provider call and every state
 * transition on the audit row. Two callers keep their own claims because they
 * batch several events into ONE email and must claim them all before
 * composing: lib/earnings/debrief-send.ts and lib/earnings/wrap-send.ts. Both
 * deliver (or, for the retired wrap, must be ported to deliver) through
 * `deliverClaimedBatch` below, so the lifecycle itself is still single-sourced.
 * tests/repo/one-claim-owner.test.ts pins that allowlist, with a justification
 * per entry.
 *
 * The lifecycle, and why each step is where it is:
 *
 *  1. recipient — no recipient is a REFUSAL, not a failure; nothing is written.
 *  1b. cloud pre-check — AUTOMATIC modes only (sweep, nudge). The Worker
 *      fallback may already have delivered this very email while the Mac slept,
 *      and the sweep's KV→audit backfill may not have run yet. This moved out
 *      of the sweep loop (R-E6) so the NUDGE gets it too — a desk press could
 *      otherwise duplicate a cloud send. `manual` skips it on purpose: a human
 *      refiring is asking for a second copy.
 *  2. claim     — `automatic` for the sweep and the nudge (never refires a
 *                 completed row), `manual` for the human route.
 *  3. setRunning— AWAITED (spec §4.5 "Marker writes are awaited"); the sweep
 *                 used to fire these and forget, which is how a marker could
 *                 land after the send it was supposed to precede.
 *  4. compose   — the AI composer, or the deterministic reporter composer.
 *                 `not_ready` releases the claim and refuses (a benign
 *                 coordination outcome the sweep logs as a skip).
 *  5. sending   — the Message-ID is minted HERE, before the wire, and stored
 *                 with the row. Compare-and-set: if the claim was lost between
 *                 (2) and here, NOTHING is sent.
 *  6. provider  — raced against SEND_TIMEOUT_MS. Three endings:
 *                   accepted  → markEmailSent (CAS). 0 rows means the reaper
 *                               already called it delivery-unknown → report
 *                               that and NEVER resend (spec §7).
 *                   ambiguous → markEmailDeliveryUnknown. The reaper exists for
 *                               the process-death case only; when WE are still
 *                               alive we book the terminal state ourselves.
 *                   definitive→ release (fresh) or restore (refire) → failed,
 *                               retryable on the next tick.
 *  7. finally   — clearRunning, awaited, exactly once.
 *
 * Steps 5–7 live in `deliverClaimedBatch`, which takes N already-claimed
 * members and one composed email, because the morning debrief staples several
 * names into a single message and must run the identical choreography.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sendEmail, type SendEmailResult } from "@/lib/email";
import {
  claimEarningsEmailSlot,
  composeEarningsEmail,
  EarningsEmailError,
  getSendRow,
  markEmailDeliveryUnknown,
  markEmailSending,
  markEmailSent,
  releaseEarningsEmailClaim,
  restorePriorDelivered,
  SEND_TIMEOUT_MS,
  type ComposeEarningsResult,
  type SendEarningsEmailOpts,
  type SendEarningsEmailResult,
} from "@/lib/digest/send-earnings-email";
import { composeReporterRecapEmail } from "@/lib/earnings/reporter-recap";
import { DELIVERY_UNKNOWN, IN_PROGRESS, sentByFor } from "@/lib/earnings/email-states";
import {
  checkEarningsCloudMarker,
  clearEarningsRunningMarker,
  setEarningsRunningMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";
import { recordCloudSentAudit } from "@/lib/mutations/earnings-emails";

/**
 * The provider call's deadline. Declared in lib/digest/send-earnings-email.ts
 * next to SENDING_STALE_MINUTES (the reaper's threshold has to sit beside the
 * deadline it must never beat, and the reverse import would be a cycle — M-E5)
 * and re-exported here so every consumer reads it from the service.
 */
export { SEND_TIMEOUT_MS } from "@/lib/digest/send-earnings-email";

export type SendMode = "sweep" | "nudge" | "manual";

export interface SendCandidate {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  /** Deterministic read-through reporter recap (no AI) instead of the recap composer. */
  reporterRecap?: boolean;
}

/**
 * The state words below are referenced as `typeof <const>` rather than
 * retyped, so this file spells no sentinel by hand (the vocabulary lives in
 * lib/earnings/email-states.ts and tests/repo/no-handrolled-email-states.test.ts
 * enforces it). The resolved unions are identical to the literals.
 */
export type SendOutcome =
  | {
      outcome: "sent";
      sentTo: string;
      providerMessageId: string;
      title: string;
      modelOutputChars: number;
      symbol: string;
    }
  | { outcome: typeof IN_PROGRESS }
  | { outcome: "already_sent"; sentAt: string; sentBy: "local" | "cloud" }
  /** `note` says WHY it is unknown — timeout, ambiguous provider failure,
   *  post-accept persistence failure, or a reaper flip (contract §3). */
  | {
      outcome: typeof DELIVERY_UNKNOWN;
      providerMessageId: string | null;
      since: string;
      note?: string;
    }
  | { outcome: "refused"; reason: string; status: number }
  | { outcome: "failed"; reason: string; status: number };

export interface ComposedSend {
  symbol: string;
  title: string;
  subject: string;
  html: string;
  aiMarkdown: string;
  markdownChars: number;
  promptHash: string | null;
}

export interface SendServiceSeams {
  sendEmail?: typeof sendEmail;
  compose?: typeof composeEarningsEmail;
  composeReporter?: typeof composeReporterRecapEmail;
  now?: () => Date;
  markers?: {
    setRunning: (phase: "preview" | "recap", eventId: number) => Promise<unknown>;
    clearRunning: (phase: "preview" | "recap", eventId: number) => Promise<unknown>;
    writeMacSent: (phase: "preview" | "recap", eventId: number) => Promise<unknown>;
  };
  /** Cloud-marker pre-flight (R-E6) — consulted in `sweep` and `nudge` only. */
  checkCloudMarker?: typeof checkEarningsCloudMarker;
  recordCloudSent?: typeof recordCloudSentAudit;
  timeoutMs?: number;
}

/** One claimed (event, phase) that a single outbound email covers. */
export interface BatchMember {
  eventId: number;
  phase: "preview" | "recap";
  token: string;
  mode: "fresh" | "refire";
  /** Refire only — the row identity the claim saw, for the CAS and the restore. */
  priorError?: string | null;
  priorSentAt?: string;
}

export interface DeliverBatchInput {
  members: BatchMember[];
  recipient: string;
  subject: string;
  html: string;
  aiInputHash: string | null;
  aiOutputMd: string;
  /** Default: minted here. Every member shares it — one email, one id. */
  providerMessageId?: string;
}

export type BatchOutcome =
  | { outcome: "sent"; providerMessageId: string; providerResponse: string; delivered: BatchMember[] }
  | {
      outcome: typeof DELIVERY_UNKNOWN;
      providerMessageId: string;
      since: string;
      note: string;
      members: BatchMember[];
    }
  | { outcome: "failed"; reason: string; status: number; providerMessageId: string | null };

/**
 * nodemailer 8.0.4 error codes that can only mean "the message MIGHT have been
 * transmitted" — and only then when the failure happened at the DATA phase,
 * i.e. while the body was on the wire (smtp-connection/index.js:859-884 sets
 * `code` and `command`). Everything else — an explicit server refusal
 * (EENVELOPE / EMESSAGE / EAUTH / EPROTOCOL), a DNS or connect failure before
 * DATA, or a plain Error with no code at all (a missing RESEND_API_KEY, say) —
 * is a DEFINITIVE non-delivery, so the claim is released and the next tick
 * retries. Wedging a recap that certainly never left is worse than one extra
 * attempt; the opposite mistake sends the email twice.
 */
export const SEND_UNKNOWN_CODES: readonly string[] = ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "ESTREAM"];

export function isAmbiguousSendFailure(err: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  const e = err as { code?: unknown; command?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : null;
  const command = typeof e?.command === "string" ? e.command : null;
  if (code === null) return false;
  return SEND_UNKNOWN_CODES.includes(code) && command === "DATA";
}

const DEFAULT_MARKERS = {
  setRunning: setEarningsRunningMarker,
  clearRunning: clearEarningsRunningMarker,
  writeMacSent: writeMacSentEarningsMarker,
};

function mintMessageId(): string {
  return `<${randomUUID()}@${process.env.RESEND_FROM_DOMAIN ?? "unset.invalid"}>`;
}

async function raceWithDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  // A rejection that arrives AFTER the deadline already won the race would be
  // an unhandled rejection; swallow it here, the outcome is already decided.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`provider call exceeded ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Cut and pasted from the retired private sendEarningsEmail — do NOT retype the
// escapes (see the "Unicode-escape write hazard" note: an editor can turn a
// typed backslash-u escape into raw bytes).
const PHASE_EMOJI = { preview: "\u{1F50D}", recap: "\u{1F4CA}" } as const;

function fromAiCompose(r: ComposeEarningsResult, phase: "preview" | "recap"): ComposedSend {
  return {
    symbol: r.symbol,
    title: r.title,
    subject: `${PHASE_EMOJI[phase]} ${r.title}`,
    html: r.html,
    aiMarkdown: r.aiMarkdown,
    markdownChars: r.markdown.length,
    promptHash: r.promptHash,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Put a claimed member back the way the claim found it. */
function undoMember(db: Database.Database, m: BatchMember): void {
  if (m.mode === "refire") {
    restorePriorDelivered(db, m.eventId, m.phase, m.token, m.priorError ?? null, m.priorSentAt ?? "");
  } else {
    releaseEarningsEmailClaim(db, m.eventId, m.phase, m.token);
  }
}

/**
 * Run a seam without letting it break the send. Marker failures are fail-open
 * by architecture ruling R-E6, and the cloud pre-check degrades to "unknown".
 *
 * The call goes INSIDE the try deliberately (review M-1): the older shape
 * `Promise.resolve(seam(...)).catch(...)` evaluates `seam(...)` BEFORE
 * `Promise.resolve` ever wraps it, so a seam that throws SYNCHRONOUSLY sails
 * straight past that `.catch`. The three production markers are `async`, which
 * turns a throw into a rejection and hides the hole; a non-async seam — a test
 * double, or a later rewrite — would not.
 */
async function safeSeam<T>(what: string, run: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.warn(`[send-service] seam ${what} failed (ignored, fail-open per R-E6):`, err);
    return fallback;
  }
}

/**
 * The `sent_at` a delivery-unknown outcome reports, GUARDED (R-E-C10).
 *
 * One of the three call sites sits inside the post-accept catch — the handler
 * whose entire job is "the provider accepted and something after that threw;
 * never surface a 500" (R-E5 / spec §7). The realistic trigger for that catch
 * is a SQLite fault out of `markEmailSent` (the suite injects SQLITE_BUSY), and
 * the SAME fault can make this SELECT throw. Unguarded, that exception escapes
 * the catch, the sweep's per-candidate backstop books `ok:false, status:500`,
 * and the one thing R-E5 forbids happens anyway.
 *
 * No double-send can result either way (`bookUnknown` has already flipped the
 * row and written the mac-sent marker, and the reaper self-heals), so this is
 * reporting hygiene — but it is the last line that could still produce a
 * post-accept 500. The fallback is `""`, exactly what the outcome already
 * carries when the row cannot be found, so the shape never changes.
 */
function safeSentAt(db: Database.Database, m: BatchMember): string {
  try {
    return getSendRow(db, m.eventId, m.phase)?.sent_at ?? "";
  } catch (err) {
    console.warn(`[send-service] could not re-read sent_at for ${m.phase} ${m.eventId}:`, err);
    return "";
  }
}

/**
 * Book members terminal-unknown and CLAIM THE PHASE for each (R-E4).
 *
 * nodemailer has no way to abort an in-flight `sendMail`: after our deadline
 * elapses the promise and its socket keep running until nodemailer's own
 * timeouts, and the message may well be delivered. So an unknown ending is not
 * "nothing happened" — it is "we do not know", and the only safe reading is
 * "assume it went out". Writing the mac-sent marker BEFORE the caller clears
 * the running marker is what stops the Worker fallback from sending a second
 * copy of a recap that did arrive. Both writes are best-effort (marker failures
 * are fail-open by architecture — see the recorded disagreement on Codex #6);
 * the DB flip is what actually blocks a local resend.
 */
async function bookUnknown(
  db: Database.Database,
  members: BatchMember[],
  markers: NonNullable<SendServiceSeams["markers"]>,
  note: string,
): Promise<void> {
  for (const m of members) {
    try {
      markEmailDeliveryUnknown(db, m.eventId, m.phase, m.token);
    } catch (err) {
      console.warn(
        `[send-service] could not book ${m.phase} ${m.eventId} terminal-unknown (${note}):`,
        err,
      );
    }
    await safeSeam("writeMacSent", () => markers.writeMacSent(m.phase, m.eventId), null);
  }
}

/**
 * Steps 5–7 of the send lifecycle, for N already-claimed members covered by ONE
 * outbound email.
 *
 * This is the ONLY implementation of "a claim becomes a delivered email".
 * `sendEarningsCandidate` calls it with a single member; the morning debrief
 * (lib/earnings/debrief-send.ts) calls it with N, because one stapled email
 * covers several names. Before slice E the debrief had its own copy of this
 * choreography and it skipped the in-flight state, the message id, the timeout
 * classification and the terminal-unknown ending entirely.
 *
 * Steps 1–4 (recipient, claim, running marker, compose) belong to the CALLER:
 * a batch composes once for N members, and the running marker is owned by
 * whoever set it — `sendEarningsCandidate` clears it in its own `finally`.
 *
 * Every member moves to the in-flight state with the SAME Message-ID before the
 * wire, and afterwards every member takes the same classification. A member
 * whose CAS fails is DROPPED with a warning rather than aborting the batch —
 * the email still names it, but another process owns its row and we may not
 * write it (this is the same "a per-member conflict drops that member, never
 * the batch" rule debrief-send.ts has always followed). Zero surviving members
 * means nothing is sent at all.
 */
export async function deliverClaimedBatch(
  db: Database.Database,
  input: DeliverBatchInput,
  seams: SendServiceSeams = {},
): Promise<BatchOutcome> {
  const send = seams.sendEmail ?? sendEmail;
  const markers = seams.markers ?? DEFAULT_MARKERS;
  const timeoutMs = seams.timeoutMs ?? SEND_TIMEOUT_MS;
  const providerMessageId = input.providerMessageId ?? mintMessageId();

  // (5) in flight — the id goes on every row BEFORE it goes on the wire.
  const owned: BatchMember[] = [];
  for (const m of input.members) {
    const ok = markEmailSending(db, m.eventId, m.phase, m.token, {
      mode: m.mode,
      recipient: input.recipient,
      aiInputHash: input.aiInputHash,
      aiOutputMd: input.aiOutputMd,
      providerMessageId,
      priorError: m.priorError,
      priorSentAt: m.priorSentAt,
    });
    if (ok) owned.push(m);
    else {
      console.warn(
        `[send-service] ${m.phase} ${m.eventId}: the audit row changed under this send — dropped from the batch`,
      );
    }
  }
  if (owned.length === 0) {
    return {
      outcome: "failed",
      reason: "The email row changed under this send — refresh and try again.",
      status: 409,
      providerMessageId: null,
    };
  }

  // (6) ONE provider call for the whole batch, raced against the deadline.
  let timedOut = false;
  let info: SendEmailResult;
  try {
    info = await raceWithDeadline(
      Promise.resolve(
        send({
          to: input.recipient,
          subject: input.subject,
          html: input.html,
          fromLocalPart: "earnings",
          messageId: providerMessageId,
        }),
      ),
      timeoutMs,
      () => {
        timedOut = true;
      },
    );
  } catch (err) {
    if (isAmbiguousSendFailure(err, timedOut)) {
      const note = timedOut
        ? `the provider call exceeded ${timeoutMs}ms and was never answered`
        : `ambiguous provider failure during DATA: ${errText(err)}`;
      await bookUnknown(db, owned, markers, note);
      return {
        outcome: DELIVERY_UNKNOWN,
        providerMessageId,
        since: safeSentAt(db, owned[0]),
        note,
        members: owned,
      };
    }
    for (const m of owned) undoMember(db, m);
    return { outcome: "failed", reason: `Send failed: ${errText(err)}`, status: 500, providerMessageId };
  }

  // (7) POST-ACCEPT. The provider said yes. From here nothing may throw out of
  // this function (R-E5 / spec §7: "provider accepted a recap but the audit
  // commit failed → delivery unknown, no automatic resend"). A SQLite error
  // here used to become an unexpected 500 while the marker was cleared, and the
  // next tick would send the same email again.
  try {
    const delivered: BatchMember[] = [];
    const lost: BatchMember[] = [];
    for (const m of owned) {
      const ok = markEmailSent(db, m.eventId, m.phase, m.token, {
        recipient: input.recipient,
        aiInputHash: input.aiInputHash,
        aiOutputMd: input.aiOutputMd,
        providerResponse: info.response,
      });
      (ok ? delivered : lost).push(m);
    }
    if (lost.length > 0) {
      // The reaper flipped these rows while the provider was answering. The
      // email went out; do NOT resend it, and claim the phase for them too.
      await bookUnknown(db, lost, markers, "the stale-send reaper flipped this row while the provider was answering");
    }
    if (delivered.length === 0) {
      return {
        outcome: DELIVERY_UNKNOWN,
        providerMessageId,
        since: safeSentAt(db, owned[0]),
        note: "the stale-send reaper flipped this row while the provider was answering",
        members: owned,
      };
    }
    for (const m of delivered) {
      await safeSeam("writeMacSent", () => markers.writeMacSent(m.phase, m.eventId), null);
    }
    return { outcome: "sent", providerMessageId, providerResponse: info.response, delivered };
  } catch (err) {
    const note = `post-accept persistence failed: ${errText(err)}`;
    await bookUnknown(db, owned, markers, note);
    return {
      outcome: DELIVERY_UNKNOWN,
      providerMessageId,
      since: safeSentAt(db, owned[0]),
      note,
      members: owned,
    };
  }
}

export async function sendEarningsCandidate(
  db: Database.Database,
  candidate: SendCandidate,
  opts: { mode: SendMode; recipient?: string; footerNote?: string; seams?: SendServiceSeams },
): Promise<SendOutcome> {
  const seams = opts.seams ?? {};
  const compose = seams.compose ?? composeEarningsEmail;
  const composeReporter = seams.composeReporter ?? composeReporterRecapEmail;
  const markers = seams.markers ?? DEFAULT_MARKERS;
  const checkCloud = seams.checkCloudMarker ?? checkEarningsCloudMarker;
  const recordCloud = seams.recordCloudSent ?? recordCloudSentAudit;
  const { eventId, phase } = candidate;

  // (1) recipient
  const recipient = opts.recipient || process.env.BRIEFING_EMAIL_TO;
  if (!recipient) {
    return {
      outcome: "refused",
      reason: "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      status: 400,
    };
  }

  // (1b) cloud pre-check — automatic modes only (R-E6)
  if (opts.mode !== "manual") {
    const marker = await safeSeam("checkCloudSent", () => checkCloud(phase, eventId), null);
    if (marker?.sentBy != null) {
      // Only a CLOUD send needs a local audit row; sentBy "mac" means a local
      // row (or a permanent skip) already exists — reporting is enough. The
      // row itself, not the marker, decides WHO sent it: recordCloudSentAudit
      // is a DO NOTHING upsert, so an existing local row always wins.
      if (marker.sentBy === "cloud") recordCloud(db, eventId, phase);
      const row = getSendRow(db, eventId, phase);
      return {
        outcome: "already_sent",
        sentAt: row?.sent_at ?? "",
        sentBy: sentByFor(row?.error ?? null),
      };
    }
  }

  // (2) claim
  const claim = claimEarningsEmailSlot(db, eventId, phase, recipient, {
    mode: opts.mode === "manual" ? "manual" : "automatic",
  });
  if (!claim.claimed) {
    if (claim.reason === IN_PROGRESS) return { outcome: IN_PROGRESS };
    const row = getSendRow(db, eventId, phase);
    if (claim.reason === DELIVERY_UNKNOWN) {
      // A row the reaper (or an earlier attempt) already booked terminal.
      // Claim the phase for the cloud too, so the fallback never resends it
      // (R-E4 — the reaper itself writes no KV; this is where that happens).
      await safeSeam("writeMacSent", () => markers.writeMacSent(phase, eventId), null);
      return {
        outcome: DELIVERY_UNKNOWN,
        providerMessageId: row?.provider_message_id ?? null,
        since: row?.sent_at ?? "",
        note: "a previous attempt ended without a provider answer",
      };
    }
    return { outcome: "already_sent", sentAt: row?.sent_at ?? "", sentBy: sentByFor(row?.error ?? null) };
  }
  const token = claim.token as string;
  const claimMode = claim.mode;

  let cleared = false;
  const clearOnce = async (): Promise<void> => {
    if (cleared) return;
    cleared = true;
    await safeSeam("clearRunning", () => markers.clearRunning(phase, eventId), null);
  };

  try {
    // (3) running marker — awaited
    await safeSeam("setRunning", () => markers.setRunning(phase, eventId), null);

    // (4) compose
    let composed: ComposedSend;
    try {
      if (candidate.reporterRecap) {
        const r = await composeReporter(db, eventId);
        composed = {
          symbol: r.symbol,
          title: r.title,
          subject: r.subject,
          html: r.html,
          aiMarkdown: r.aiMarkdown,
          markdownChars: r.markdown.length,
          promptHash: r.promptHash,
        };
      } else {
        composed = fromAiCompose(await compose(db, eventId, phase, { footerNote: opts.footerNote }), phase);
      }
    } catch (err) {
      undoMember(db, {
        eventId,
        phase,
        token,
        mode: claimMode,
        priorError: claim.priorError,
        priorSentAt: claim.priorSentAt,
      });
      if (err instanceof EarningsEmailError) {
        return err.code === "not_ready"
          ? { outcome: "refused", reason: err.message, status: err.status }
          : { outcome: "failed", reason: err.message, status: err.status };
      }
      return { outcome: "failed", reason: errText(err), status: 500 };
    }

    // (5)-(7) — the ONE lifecycle primitive, with a batch of one.
    const res = await deliverClaimedBatch(
      db,
      {
        members: [
          {
            eventId,
            phase,
            token,
            mode: claimMode,
            priorError: claim.priorError,
            priorSentAt: claim.priorSentAt,
          },
        ],
        recipient,
        subject: composed.subject,
        html: composed.html,
        aiInputHash: composed.promptHash,
        aiOutputMd: composed.aiMarkdown,
      },
      seams,
    );

    switch (res.outcome) {
      case "sent":
        await clearOnce();
        return {
          outcome: "sent",
          sentTo: recipient,
          providerMessageId: res.providerMessageId,
          title: composed.title,
          modelOutputChars: composed.markdownChars,
          symbol: composed.symbol,
        };
      case DELIVERY_UNKNOWN:
        return {
          outcome: DELIVERY_UNKNOWN,
          providerMessageId: res.providerMessageId,
          since: res.since,
          note: res.note,
        };
      case "failed":
        return { outcome: "failed", reason: res.reason, status: res.status };
    }
  } finally {
    await clearOnce();
  }
}

// ── Manual entry points (moved here from lib/digest/send-earnings-email.ts to
//    keep the module graph a DAG — see M-E19) ─────────────────────────────
//
// They preserve today's contract exactly: a `SendEarningsEmailResult` on
// success, an `EarningsEmailError` with today's status for everything else,
// so POST /api/earnings/email and its tests are unchanged apart from the
// import path.

async function sendManual(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  opts: SendEarningsEmailOpts,
): Promise<SendEarningsEmailResult> {
  const ev = db
    .prepare(`SELECT symbol FROM calendar_events WHERE id = ?`)
    .get(eventId) as { symbol: string | null } | undefined;
  if (!ev) throw new EarningsEmailError(`Event ${eventId} not found.`, 404);
  if (!ev.symbol) throw new EarningsEmailError(`Event ${eventId} has no symbol.`, 400);

  const res = await sendEarningsCandidate(
    db,
    { eventId, symbol: ev.symbol.toUpperCase(), phase },
    { mode: "manual", recipient: opts.recipient, footerNote: opts.footerNote },
  );

  switch (res.outcome) {
    case "sent":
      return {
        success: true,
        eventId,
        symbol: res.symbol,
        phase,
        sentTo: res.sentTo,
        title: res.title,
        modelOutputChars: res.modelOutputChars,
      };
    case IN_PROGRESS:
      throw new EarningsEmailError(
        `Event ${eventId} ${phase} is already being sent by another process — skipping duplicate.`,
        409,
        "claim_held",
      );
    case "refused":
      throw new EarningsEmailError(res.reason, res.status, res.status === 409 ? "not_ready" : undefined);
    case "failed":
      throw new EarningsEmailError(res.reason, res.status);
    case DELIVERY_UNKNOWN:
      throw new EarningsEmailError(
        `Event ${eventId} ${phase}: the provider never confirmed delivery (message ${res.providerMessageId ?? "unknown"}, since ${res.since}). Check the mailbox or the Resend log before sending again.`,
        409,
      );
    case "already_sent":
      // Unreachable in manual mode (it always claims) — defensive.
      throw new EarningsEmailError(`Event ${eventId} ${phase} was already sent at ${res.sentAt}.`, 409);
  }
}

export async function sendEarningsPreview(
  db: Database.Database,
  eventId: number,
  opts: SendEarningsEmailOpts = {},
): Promise<SendEarningsEmailResult> {
  return sendManual(db, eventId, "preview", opts);
}

export async function sendEarningsRecap(
  db: Database.Database,
  eventId: number,
  opts: SendEarningsEmailOpts = {},
): Promise<SendEarningsEmailResult> {
  return sendManual(db, eventId, "recap", opts);
}
