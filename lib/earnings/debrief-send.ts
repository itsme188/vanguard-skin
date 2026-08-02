/**
 * Morning-debrief SENDER (2026-08-02 plan, Task 3) — the gated, claimed,
 * audited action half of the feature whose pure candidate-selection +
 * deterministic section/prompt building live in lib/earnings/debrief.ts
 * (Tasks 1+2). Task 4 wires this into the earnings sweep.
 *
 * Claim choreography mirrors lib/earnings/wrap-send.ts::runSlotWrap — claim
 * every candidate's recap slot BEFORE composing, release fresh (token-owned)
 * claims on any failure so the sweep never leaks a claim into the 30-min
 * 'in_progress' blackout — with one deliberate difference: a per-member claim
 * conflict here just DROPS that member rather than aborting the whole batch.
 * The EOD wrap staples every member into one indivisible email, so a single
 * conflict has to abort-and-retry the lot; the morning debrief has no such
 * all-or-nothing constraint (each name's section stands alone), so punishing
 * the other ready names for one concurrent sender winning a race on a single
 * event would only delay debriefs that could have gone out fine.
 *
 * Mac↔cloud marker dance (2026-08-02 fix wave, F2): because the debrief
 * writes per-member `recap` audit rows, it owns the same KV coordination the
 * wrap did — a cloud-marker READ per claimed member before compose (a recap
 * the Worker already delivered is dropped, its claim released and a
 * sent-by-cloud audit row recorded in its place) and a mac-sent WRITE per
 * covered member after the send, so the Worker's recap fallback backs off.
 * Both helpers no-op gracefully when WORKER_MARKER_URL is unset.
 *
 * Gate: an Intl-derived ET wall-clock window (07:45–08:20) plus a
 * once-per-ET-day settings key (`last_debrief_date`), stamped BEFORE compose
 * — same stamp-before-push discipline as the daily date-verification gate in
 * lib/calendar/verify-earnings-dates.ts::maybeRunDailyDateVerification — so
 * the 15-min sweep tick can only ever produce one debrief attempt per
 * morning, even if composing/sending throws. The stamp sits BELOW the
 * no-candidates return (F4): a candidate-less tick must not burn the day,
 * since actuals landing mid-window should still get this morning's debrief.
 */
import type Database from "better-sqlite3";
import {
  findDebriefCandidates,
  renderDebriefSections,
  buildDebriefPrompt,
  assembleDebriefMarkdown,
  type DebriefCandidate,
} from "@/lib/earnings/debrief";
import {
  claimEarningsEmailSlot,
  releaseEarningsEmailClaim,
} from "@/lib/digest/send-earnings-email";
import {
  checkEarningsCloudMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";
import { recordCloudSentAudit } from "@/lib/mutations/earnings-emails";
import { generateTextForFeature } from "@/lib/ai/generate";
import { stripModelPreamble } from "@/lib/ai/strip-preamble";
import { sendEmail } from "@/lib/email";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { todayET } from "@/lib/calendar/date-utils";

const WINDOW_START_MIN = 465; // 07:45 ET
const WINDOW_END_MIN = 500; // 08:20 ET (exclusive)
const DEBRIEF_LAST_RUN_SETTINGS_KEY = "last_debrief_date";

export interface DebriefResult {
  sent: boolean;
  /** Symbols that got a full section in the sent email. Empty when nothing sent. */
  covered: string[];
  skippedReason?: "outside-window" | "already-ran-today" | "no-candidates" | "claims-conflict";
}

interface FreshClaim {
  candidate: DebriefCandidate;
  token: string;
}

export async function runMorningDebrief(
  db: Database.Database,
  opts: {
    now?: Date;
    force?: boolean;
    recipient?: string;
    /** DI seam for tests — defaults to generateTextForFeature("earningsDebrief", ...). */
    generate?: (prompt: string) => Promise<string>;
  } = {},
): Promise<DebriefResult> {
  const now = opts.now ?? new Date();

  if (!opts.force && !inSendWindow(now)) {
    return { sent: false, covered: [], skippedReason: "outside-window" };
  }

  const today = todayET(now);
  if (getDebriefLastRunDay(db) === today) {
    return { sent: false, covered: [], skippedReason: "already-ran-today" };
  }

  const { unsent, alreadyRecapped } = findDebriefCandidates(db, { now });
  if (unsent.length === 0) {
    // Deliberately BEFORE the day-key stamp: a candidate-less tick must not
    // burn the day. The sweep ticks every 15 min, so the window holds two or
    // three passes — actuals landing at 07:52 after an empty 07:45 tick still
    // get a debrief this morning instead of waiting a full day.
    return { sent: false, covered: [], skippedReason: "no-candidates" };
  }

  // Stamp BEFORE compose: one debrief ATTEMPT per ET day even if everything
  // below throws — the next 15-min sweep tick must not retry into the digest
  // window.
  setDebriefLastRunDay(db, today);

  const recipient = opts.recipient || process.env.BRIEFING_EMAIL_TO;
  if (!recipient) {
    console.warn(
      "[debrief] No recipient configured (opts.recipient / BRIEFING_EMAIL_TO env) — skipping send.",
    );
    return { sent: false, covered: [] };
  }

  // Claim every candidate's recap slot BEFORE composing anything. A per-member
  // conflict (live 'in_progress' claim held by another process, or a refire —
  // the recap was already completed between findDebriefCandidates and here)
  // just drops that member; it never aborts the batch (see file header).
  const claims: FreshClaim[] = [];
  for (const candidate of unsent) {
    const claim = claimEarningsEmailSlot(db, candidate.eventId, "recap", recipient);
    if (!claim.claimed || claim.mode !== "fresh" || !claim.token) continue;

    // Symmetric cloud-marker read, mirroring the retired wrap's per-member
    // exclusion (wrap-send.ts::runSlotWrap): the Worker fallback may have
    // delivered this very recap while the Mac slept, and the sweep's KV→audit
    // backfill may not have run yet — without this read the debrief would
    // re-narrate a name the user already got an email about. A cloud-owned
    // member releases the fresh claim taken a line ago and records the same
    // sent-by-cloud audit row the sweep writes, which also keeps it out of
    // tomorrow's candidate set.
    const marker = await checkEarningsCloudMarker("recap", candidate.eventId).catch(() => null);
    if (marker?.sentBy != null) {
      releaseEarningsEmailClaim(db, candidate.eventId, "recap", claim.token);
      // Only a CLOUD send needs a local audit row; sentBy "mac" means a local
      // row already exists (or a stale marker) — dropping is enough.
      if (marker.sentBy === "cloud") {
        recordCloudSentAudit(db, candidate.eventId, "recap");
      }
      continue;
    }

    claims.push({ candidate, token: claim.token });
  }
  // Also the "every member was cloud-delivered" outcome — nothing left to
  // narrate either way, and the day key above is already stamped.
  if (claims.length === 0) {
    return { sent: false, covered: [], skippedReason: "claims-conflict" };
  }

  try {
    const claimedCandidates = claims.map((c) => c.candidate);
    const sections = renderDebriefSections(db, claimedCandidates);
    const prompt = buildDebriefPrompt(sections, today);
    const generate = opts.generate ?? defaultGenerate;
    const rawAiText = await generate(prompt);
    const aiMarkdown = stripModelPreamble(rawAiText);
    const markdown = assembleDebriefMarkdown(aiMarkdown, sections, alreadyRecapped, today);

    const title = `Earnings Debrief — ${formatDebriefDateLabel(now)}`;
    const subject = `☕ ${title}`;
    const html = briefingToHtml(markdown, title);

    await sendEmail({ to: recipient, subject, html, fromLocalPart: "earnings" });

    // Success: convert every fresh claim into a completed audit row. Every
    // covered name shares the same email, so every row shares the same
    // ai_output_md — the in-app viewer then shows the full debrief for
    // whichever name the user opens. Each name also gets its own mac-sent KV
    // marker (same per-member choreography the retired wrap used) so the
    // Worker's recap fallback backs off for a name the Mac just covered.
    for (const c of claims) {
      recordDebriefAudit(db, { eventId: c.candidate.eventId, recipient, aiOutputMd: markdown });
      await writeMacSentEarningsMarker("recap", c.candidate.eventId).catch(() => null);
    }

    const covered = claimedCandidates.map((c) => c.symbol);
    console.log(`[debrief] sent — covered ${covered.length} name(s): ${covered.join(", ")}`);
    return { sent: true, covered };
  } catch (err) {
    // Never throw to the sweep: release every fresh claim so the members
    // return to candidacy on the next findDebriefCandidates call (tomorrow —
    // the day key above stays stamped, so there's no retry today).
    releaseFreshClaims(db, claims);
    console.warn(
      "[debrief] compose/send failed; released fresh claim(s):",
      err instanceof Error ? err.message : err,
    );
    return { sent: false, covered: [] };
  }
}

async function defaultGenerate(prompt: string): Promise<string> {
  const res = await generateTextForFeature("earningsDebrief", { prompt, maxOutputTokens: 4096 });
  return res.text;
}

function releaseFreshClaims(db: Database.Database, claims: FreshClaim[]): void {
  for (const c of claims) {
    releaseEarningsEmailClaim(db, c.candidate.eventId, "recap", c.token);
  }
}

// Same upsert shape as recordWrapAudit (module-private in wrap-send.ts) /
// recordEarningsEmailAudit (module-private in send-earnings-email.ts):
// converts the 'in_progress' claim row into a completed row (error = NULL).
// UNIQUE(event_id, phase) makes it idempotent.
function recordDebriefAudit(
  db: Database.Database,
  input: { eventId: number; recipient: string; aiOutputMd: string },
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
     VALUES (?, 'recap', ?, datetime('now'), NULL, ?, NULL)
     ON CONFLICT(event_id, phase) DO UPDATE SET
       recipient = excluded.recipient,
       sent_at = excluded.sent_at,
       ai_input_hash = excluded.ai_input_hash,
       ai_output_md = excluded.ai_output_md,
       error = excluded.error`,
  ).run(input.eventId, input.recipient, input.aiOutputMd);
}

// ─── Window + once-per-day gate ────────────────────────────────────────────

function inSendWindow(now: Date): boolean {
  const minutes = etMinutesOfDay(now);
  return minutes >= WINDOW_START_MIN && minutes < WINDOW_END_MIN;
}

function etMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  // hour12:false can format midnight as "24" under some ICU builds.
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function formatDebriefDateLabel(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(now);
}

function getDebriefLastRunDay(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(DEBRIEF_LAST_RUN_SETTINGS_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null; // settings table absent (minimal test DBs)
  }
}

function setDebriefLastRunDay(db: Database.Database, day: string): void {
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(DEBRIEF_LAST_RUN_SETTINGS_KEY, day);
  } catch {
    // settings table absent (minimal test DBs) — best-effort, never throw
  }
}
