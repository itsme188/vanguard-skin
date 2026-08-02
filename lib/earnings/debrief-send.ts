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
 * Gate: an Intl-derived ET wall-clock window (07:45–08:20) plus a
 * once-per-ET-day settings key (`last_debrief_date`), stamped BEFORE compose
 * — same stamp-before-push discipline as the daily date-verification gate in
 * lib/calendar/verify-earnings-dates.ts::maybeRunDailyDateVerification — so
 * the 15-min sweep tick can only ever produce one debrief attempt per
 * morning, even if composing/sending throws.
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
  // Stamp BEFORE compose: one attempt per ET day even if everything below
  // throws — the next 15-min sweep tick must not retry into the digest window.
  setDebriefLastRunDay(db, today);

  const { unsent, alreadyRecapped } = findDebriefCandidates(db, { now });
  if (unsent.length === 0) {
    return { sent: false, covered: [], skippedReason: "no-candidates" };
  }

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
    claims.push({ candidate, token: claim.token });
  }
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
    // whichever name the user opens.
    for (const c of claims) {
      recordDebriefAudit(db, { eventId: c.candidate.eventId, recipient, aiOutputMd: markdown });
    }

    return { sent: true, covered: claimedCandidates.map((c) => c.symbol) };
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
