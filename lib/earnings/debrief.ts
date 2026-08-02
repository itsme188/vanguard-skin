/**
 * Morning-debrief candidate selection (2026-08-02 plan, Task 1).
 *
 * This replaces the same-evening earnings "wrap" email (lib/earnings/wrap.ts)
 * with a 7:45 ET morning debrief covering yesterday's late-AMC prints
 * alongside today's-so-far BMO prints — a wrap fired at 20:00 ET necessarily
 * misses anything that reports after the deadline; the morning debrief has
 * no such cutoff because "yesterday" is over by the time it runs.
 *
 * Pure candidate selection only — no prompt building, no sending (Tasks 2
 * and 3). Two outputs:
 *   - `unsent`: events with captured actuals that still need a recap —
 *     these get full sections in the email.
 *   - `alreadyRecapped`: events whose recap already went out (locally or via
 *     the Worker cloud fallback) — these get one roster line so the debrief
 *     stays a complete "what happened" record without re-narrating names
 *     the user already got a full email about.
 *
 * Semantics mirror lib/earnings/wrap.ts::getExpectedRecapCluster (held or
 * watchlisted, family-deduped, muted/toggle-respecting, superseded rows
 * excluded) with two deliberate differences:
 *   1. Window is [yesterday ET, today ET] by event_date, not a same-day
 *      (date, slot) cluster.
 *   2. A live 'in_progress' recap claim EXCLUDES the event from `unsent`
 *      (another process — the sweep, a manual send — is actively sending
 *      it right now; the debrief must not race it or duplicate the email).
 *      wrap.ts treats an in_progress claim as a cluster MEMBER because the
 *      wrap send itself often holds that very claim; the debrief is a
 *      separate, later pass with no such self-claim to reconcile.
 */

import type Database from "better-sqlite3";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getEarningsSettings, shouldSendEarningsEmail } from "@/lib/queries/earnings-settings";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { loadIntelView, renderHeadlineTable } from "@/lib/digest/send-earnings-email";
import { getCallNoteNearDateForFamily } from "@/lib/queries/earnings-call-notes";
import { wrapSlotFor } from "@/lib/earnings/wrap";
import { demoteEmbeddedHeadings, truncateAtWordBoundary } from "@/lib/digest/call-transcripts";
import type { CalendarEvent } from "@/lib/types";

export interface DebriefCandidate {
  eventId: number;
  symbol: string;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
}

export interface DebriefRosterEntry {
  symbol: string;
  sentAt: string;
}

export interface DebriefCandidates {
  /** Full sections in the email — recap not yet sent, ready to compose. */
  unsent: DebriefCandidate[];
  /** One roster line each — recap already delivered (local or cloud). */
  alreadyRecapped: DebriefRosterEntry[];
}

/** A print must be at least this old before the debrief will cover it —
 * matches the earnings-intel "reaction ready" convention loosely, but the
 * real reason is simpler: a release_time known to be under an hour old
 * hasn't had time to generate actuals/reaction data worth debriefing, and
 * the sweep is still the right owner for same-morning immediacy. */
const MIN_MINUTES_SINCE_RELEASE = 60;

/**
 * How far back the unsent lookback reaches. The send window is a narrow 35
 * minutes (07:45–08:20 ET) and the Mac's `pmset repeat wakeorpoweron` fires
 * WEEKDAYS at 08:40 — after it — with no weekend wake at all, so a morning
 * with the Mac asleep is routine (a Friday-AMC cluster would be orphaned
 * every Saturday). With the EOD wrap retired there is no other path that
 * ever recaps a wrap-suppressed name, so a [yesterday, today] window would
 * lose those emails permanently. Three days back makes a missed morning
 * self-heal on the next one; already-sent names are excluded by the
 * earnings_emails join, so a wider window can never re-narrate anything.
 */
const UNSENT_LOOKBACK_DAYS = 3;

/**
 * Find candidates for the 7:45 ET morning debrief: held/watchlist earnings
 * events dated within the last `UNSENT_LOOKBACK_DAYS` days through today
 * (ET) with captured actuals, no completed or in-flight recap, not
 * skipped/muted/superseded, released at least `MIN_MINUTES_SINCE_RELEASE`
 * minutes ago (or with unknown release_time, which is never held back for
 * lack of data), family-deduped.
 *
 * TODAY-dated rows additionally require a completed enrichment
 * (`enriched_at IS NOT NULL`). Release-age alone is the wrong readiness
 * proxy for a same-morning print: a 06:00 BMO release clears the 60-minute
 * filter by 07:45 while its actuals/reaction capture may still be in
 * flight, and the individual recap the enrichment unlocks is strictly
 * richer than a debrief section. Yesterday-or-older rows keep the plain
 * behavior — their recap window has long closed, so the debrief is their
 * only remaining road.
 */
export function findDebriefCandidates(
  db: Database.Database,
  opts: { now?: Date } = {},
): DebriefCandidates {
  const now = opts.now ?? new Date();
  const today = todayET(now);
  const yesterday = addDays(today, -1);
  const lookbackStart = addDays(today, -UNSENT_LOOKBACK_DAYS);

  // Any recap row at all — including a live 'in_progress' claim — excludes
  // an event from `unsent`: someone else is (or already did) send it.
  const rawRows = db
    .prepare(
      `SELECT ce.id AS eventId, ce.symbol, ce.event_date, ce.event_time, ce.release_time
         FROM calendar_events ce
         LEFT JOIN earnings_emails ee ON ee.event_id = ce.id AND ee.phase = 'recap'
         LEFT JOIN earnings_email_skips es ON es.event_id = ce.id AND es.phase = 'recap'
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.symbol IS NOT NULL
          AND ce.actual_value IS NOT NULL
          AND ce.event_date BETWEEN ? AND ?
          AND (ce.event_date < ? OR ce.enriched_at IS NOT NULL)
          AND ee.id IS NULL
          AND es.id IS NULL`,
    )
    .all(lookbackStart, today, today) as DebriefCandidate[];

  const settings = getEarningsSettings(db);
  const status = getSymbolStatus(
    db,
    rawRows.map((r) => r.symbol),
  );

  let candidates = rawRows.filter((r) => {
    const st = status[r.symbol.toUpperCase()];
    if (st !== "held" && st !== "watchlist") return false;
    return shouldSendEarningsEmail(settings, r.symbol);
  });

  // Release-recency filter: a known release_time under an hour old is held
  // back for the sweep to own; unknown release_time is never held back.
  const nowMs = now.getTime();
  candidates = candidates.filter((r) => {
    if (!r.release_time) return true;
    const releaseInstant = composeReleaseInstant(r.event_date, r.release_time);
    if (!releaseInstant) return true;
    const minutesSince = (nowMs - releaseInstant.getTime()) / 60_000;
    return minutesSince >= MIN_MINUTES_SINCE_RELEASE;
  });

  // Family dedupe (GOOG/GOOGL, etc.) — keep the lowest eventId per family,
  // same tie-break convention as dedupeCrossSourceRows / dedupeByFamily.
  candidates = [...candidates].sort((a, b) => a.eventId - b.eventId);
  const seenFamilies = new Set<string>();
  const unsent: DebriefCandidate[] = [];
  for (const c of candidates) {
    const familyKey = issuerSiblings(c.symbol.toUpperCase())
      .map((s) => s.toUpperCase())
      .sort()
      .join(",");
    if (seenFamilies.has(familyKey)) continue;
    seenFamilies.add(familyKey);
    unsent.push(c);
  }

  // Roster window stays [yesterday, today] deliberately — it is a courtesy
  // "these already went out overnight" line, and a 3-day roster would list
  // names the reader got emails about days ago. Only the UNSENT lookback
  // widens (nothing else recaps those).
  const alreadyRecapped = db
    .prepare(
      `SELECT ce.symbol, ee.sent_at AS sentAt
         FROM earnings_emails ee
         JOIN calendar_events ce ON ce.id = ee.event_id
        WHERE ee.phase = 'recap'
          AND (ee.error IS NULL OR ee.error = 'sent-by-cloud')
          AND ce.event_date IN (?, ?)
        ORDER BY ee.sent_at`,
    )
    .all(yesterday, today) as DebriefRosterEntry[];

  return { unsent, alreadyRecapped };
}

// ── Task 2: deterministic per-name sections + prompt assembly ─────────────
//
// Everything below is a pure DB read / string builder — no AI calls, no
// network. Task 3 (the sender) runs `buildDebriefPrompt`'s output through
// Claude and hands the model's reply to `assembleDebriefMarkdown`.

export interface DebriefSection {
  symbol: string;
  markdown: string;
}

/**
 * Compact desk-note excerpt, mirroring the daily digest's call-transcripts
 * compact-notice rule (lib/digest/call-transcripts.ts) — the raw `guidance`
 * COLUMN on earnings_transcripts is never rendered (see the #12 convention
 * in CLAUDE.md); only the AI-written `summary` is read, and only through
 * this excerpt.
 *
 * Runs `demoteEmbeddedHeadings` first (single source, exported from
 * lib/digest/call-transcripts.ts) — the transcriptSummary prompt permits
 * "short headers" and isValidDeskNote doesn't forbid raw #/## lines, so a
 * summary can legitimately contain e.g. "## Segment detail" mid-Guidance;
 * left un-demoted, that line would render as a heading INSIDE the section
 * markdown and compete with the email's own structure — the exact failure
 * the digest's demotion pass exists to prevent. Demoting before the
 * Guidance/Tone bold-label regexes run also matches the digest's own
 * ordering (heading-styled and bold-labeled desk notes must look identical
 * to the parser).
 *
 * Truncation goes through `truncateAtWordBoundary` (the same single source in
 * lib/digest/call-transcripts.ts) rather than a raw `.slice()`: a cut landing
 * inside a `**bold**` span strands the opening marker, and briefingToHtml's
 * inline regex needs the closing marker on the same line — an unbalanced span
 * renders literal asterisks in the email.
 */
const GUIDANCE_EXCERPT_CHAR_CAP = 900; // mirrors the digest's GUIDANCE_SECTION_CHAR_CAP
const SUMMARY_EXCERPT_CHAR_CAP = 600; // mirrors the digest's SUMMARY_RENDER_CHAR_CAP

function deskNoteExcerpt(rawSummary: string): string {
  const summary = demoteEmbeddedHeadings(rawSummary);
  const m = summary.match(/\*\*Guidance\*\*[:\s]*([\s\S]*?)(?=\n\s*\*\*[A-Z]|$)/);
  const guidance = m?.[1]?.trim();
  const tone = summary.match(/\*\*Tone\*\*[:\s]*([^\n]+)/)?.[1]?.trim();
  if (guidance) {
    let out = `**Guidance:** ${truncateAtWordBoundary(guidance, GUIDANCE_EXCERPT_CHAR_CAP)}`;
    if (tone) out += `\n\n**Tone:** ${tone}`;
    return out;
  }
  // extractive-only teaser
  return truncateAtWordBoundary(summary, SUMMARY_EXCERPT_CHAR_CAP);
}

/**
 * One deterministic markdown section per candidate: heading, the same
 * code-rendered scoreboard the recap email uses, and (when present) a
 * compact desk-note excerpt from the freshest call transcript plus the
 * user's own structured call note for the issuer family. No AI content —
 * this is exactly what `buildDebriefPrompt` hands to Claude as "Data:".
 */
export function renderDebriefSections(
  db: Database.Database,
  unsent: DebriefCandidate[],
): DebriefSection[] {
  return unsent.map((candidate) => {
    const event = db
      .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
      .get(candidate.eventId) as CalendarEvent | undefined;

    if (!event) {
      // Should never happen — the candidate came straight from
      // calendar_events — but a debrief must never throw on one bad row.
      return {
        symbol: candidate.symbol,
        markdown: `### ${candidate.symbol} — ${candidate.event_date}\n\n_(event data unavailable)_`,
      };
    }

    const slot = wrapSlotFor({
      event_time: event.event_time,
      title: event.title,
      release_time: event.release_time,
    });
    const slotLabel = slot ? ` ${slot}` : "";

    const intel = loadIntelView(db, candidate.eventId, candidate.symbol);
    const scoreboard = renderHeadlineTable(event, candidate.symbol, "recap", intel);

    const parts = [`### ${candidate.symbol} — ${candidate.event_date}${slotLabel}`, "", scoreboard];

    const family = issuerSiblings(candidate.symbol.toUpperCase()).map((s) => s.toUpperCase());
    const famPlaceholders = family.map(() => "?").join(",");
    const tx = db
      .prepare(
        `SELECT summary, source, fetched_at FROM earnings_transcripts
          WHERE UPPER(ticker) IN (${famPlaceholders})
            AND summary IS NOT NULL AND summary != ''
            AND datetime(fetched_at) >= datetime(?, '-5 days')
          ORDER BY datetime(fetched_at) DESC LIMIT 1`,
      )
      .get(...family, `${candidate.event_date} 00:00:00`) as
      | { summary: string; source: string; fetched_at: string }
      | undefined;

    if (tx) {
      parts.push("", `**From the call** (desk note):\n\n${deskNoteExcerpt(tx.summary)}`);
    }

    // Freshest call note for the family — deliberately NOT passing a
    // Date-bounded, family-aware lookup — NOT getLatestCallNoteForFamily.
    // That helper (absent a `beforeDate`) returns the family's single most
    // recent note no matter its age; a debriefed print with no note yet
    // but a note from last quarter would then render that stale note as
    // "Your call note" with no qualifier, misattributing it to this print.
    // getCallNoteNearDateForFamily instead only matches a note whose
    // calendar event lands within a few days of THIS candidate's
    // event_date (either direction, so a dual-class sibling's note still
    // counts) and renders nothing when there's no match in that window —
    // silence beats misattribution.
    const callNote = getCallNoteNearDateForFamily(db, candidate.symbol, candidate.event_date);
    if (callNote && (callNote.guidance || callNote.tone || callNote.surprises)) {
      const bits: string[] = [];
      if (callNote.guidance) bits.push(`guidance ${callNote.guidance}`);
      if (callNote.tone) bits.push(`tone: ${callNote.tone}`);
      if (callNote.surprises) bits.push(`surprises: ${callNote.surprises}`);
      parts.push("", `**Your call note:** ${bits.join("; ")}`);
    }

    return { symbol: candidate.symbol, markdown: parts.join("\n") };
  });
}

/**
 * Prompt text is verbatim per the design doc — do not editorialize it.
 */
export function buildDebriefPrompt(sections: DebriefSection[], todayStr: string): string {
  return `You are writing the morning earnings debrief for ${todayStr}. The reader manages their own portfolio, watched yesterday's prints live, and already knows the headline numbers — do NOT restate beats/misses. Your job is what happened AFTER the print and what it means for today: the call (guidance, tone, surprises), the read-across between these names, and what to watch at today's open.

Write GitHub markdown. The first character of your reply must be '#'. Open with '# What changed overnight' — 3 to 6 tight bullets across all names. Then one '## {SYMBOL}' section per name, 2-4 sentences each, focused on call content and today's setup. No preamble, no closing commentary, no invented numbers — if a figure is not in the data below, do not state one.

Data:
${sections.map((s) => s.markdown).join("\n\n---\n\n")}`;
}

/**
 * Final assembly: AI synthesis first (the email's lede), then the
 * deterministic per-name scoreboards (so every number in the email is
 * independently verifiable against code-rendered data), then — only when
 * non-empty — a one-line roster of names the debrief is deliberately NOT
 * re-narrating because their recap already went out overnight.
 */
export function assembleDebriefMarkdown(
  aiMarkdown: string,
  sections: DebriefSection[],
  roster: DebriefRosterEntry[],
  dateStr: string,
): string {
  void dateStr; // The `# Earnings Debrief — {dateStr}` header is the email title, not body content.
  const scoreboards = `${aiMarkdown}\n\n---\n\n## The scoreboards\n\n${sections.map((s) => s.markdown).join("\n\n")}`;
  if (roster.length === 0) return scoreboards;
  return `${scoreboards}\n\n*Recapped individually overnight: ${roster.map((r) => r.symbol).join(" · ")}*`;
}
