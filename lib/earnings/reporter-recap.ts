/**
 * Read-through reporter recap email (feedback #3, 2026-08-03).
 *
 * A pure read-through reporter (NOT held / NOT watchlist — e.g. PRLB) whose
 * print moves a held target (XMTR) gets a lean recap-style email at FIRST
 * ACTUALS — the first 15-min sweep tick after Finnhub posts the print
 * (~T+15–30 min, before the open for a BMO name). The reaction snapshot is
 * deliberately NOT waited for; the email says it's pending and the in-app
 * viewer (which rebuilds the scoreboard live from calendar_events) shows it
 * once enrichment completes.
 *
 * PURELY DETERMINISTIC BY USER DECISION — zero AI anywhere. Scoreboard,
 * beat/miss Δ, the user's own hypothesis text verbatim, target presence.
 * Nothing to time out, nothing to hallucinate; the PRLB 7/31 miss was a
 * timeliness failure, not an interpretation gap.
 *
 * Spec: docs/superpowers/specs/2026-08-03-reporter-recap-design.md
 */

import type Database from "better-sqlite3";
import {
  renderHeadlineTable,
  getCrossAccountPositions,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";
import { withClusterManualActuals } from "@/lib/queries/manual-actuals-cluster";
import { getLiveReadThroughsForReporter } from "@/lib/alerts/read-through-push";
import { formatPositionPresence } from "@/lib/digest/presence-only-position";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { checkPrePrintFloor } from "@/lib/earnings/pre-print-floor";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { todayET } from "@/lib/calendar/date-utils";
import type { CalendarEvent } from "@/lib/types";

export interface ReporterRecapPair {
  target: string;
  /** "held" | "watchlist" — loose string to match PrintPushReadThrough. */
  targetStatus: string;
  hypothesis: string | null;
  /** Target's own next scheduled print, when on the calendar. */
  nextPrint: { date: string; slot: string | null } | null;
  /** Direction-only presence lines for the target's positions (may be empty). */
  positionLines: string[];
}

export interface ReporterRecapContent {
  subject: string;
  markdown: string;
}

/**
 * Plausibility gate: ANY flagged figure withholds the whole email —
 * isPlausibleEarnings is conjunctive (EPS ratio, EPS sign-flip, Rev ratio),
 * so a plausible-EPS / implausible-Rev print is withheld entirely rather
 * than shipping a partially-blanked scoreboard. Better no email than a
 * wrong one; the benign not_ready retry ages out of the [yesterday, today]
 * window silently (see the console.warn at the send site).
 *
 * EXCEPT for a manually-stamped row: manual_actuals_at means the desk typed
 * the figure in through POST /api/earnings/actuals, so it is an override,
 * never a scrape failure — same rule the read surfaces apply
 * (lib/earnings/actuals-display.ts::actualsAreImplausible). An empty or
 * figure-less actual is still unusable, stamp or no stamp.
 */
export function reporterActualsUsable(
  event: Pick<CalendarEvent, "consensus_estimate" | "consensus_value" | "actual_value"> &
    Partial<Pick<CalendarEvent, "manual_actuals_at">>,
): boolean {
  if (!event.actual_value) return false;
  const actual = parseFinnhubFigure(event.actual_value);
  if (actual.eps == null && actual.revenue == null) return false;
  return !actualsAreImplausible(
    event.consensus_value ?? event.consensus_estimate,
    event.actual_value,
    event.manual_actuals_at,
  );
}

function fmtEtClock(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function fmtShortDate(iso: string): string {
  const [y, m, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Pure composer — deterministic markdown from the event row + resolved pairs.
 * Exported for tests; composeReporterRecapEmail resolves the inputs.
 */
export function composeReporterRecap(
  event: Pick<
    CalendarEvent,
    | "symbol"
    | "event_date"
    | "release_time"
    | "consensus_estimate"
    | "consensus_value"
    | "actual_value"
    | "reaction_snapshot"
  >,
  pairs: ReporterRecapPair[],
): ReporterRecapContent {
  const symbol = (event.symbol ?? "").toUpperCase();
  const targets = pairs.map((p) => p.target).join(" · ");
  const subject = `📡 ${symbol} printed — read-through to ${targets}`;

  const parts: string[] = [];
  parts.push(`# ${symbol} — ${fmtShortDate(event.event_date)} print`);
  parts.push(renderHeadlineTable(event, symbol, "recap"));

  if (!event.reaction_snapshot) {
    const release =
      event.release_time != null
        ? composeReleaseInstant(event.event_date, event.release_time)
        : null;
    const eta = release ? ` (~${fmtEtClock(new Date(release.getTime() + 2 * 60 * 60 * 1000))} ET)` : "";
    parts.push(
      `*Reaction snapshot pending${eta} — the in-app viewer updates once enrichment completes.*`,
    );
  }

  for (const p of pairs) {
    const lines: string[] = [];
    const next = p.nextPrint
      ? ` — reports ${fmtShortDate(p.nextPrint.date)}${p.nextPrint.slot ? ` (${p.nextPrint.slot})` : ""}; this print lands first`
      : "";
    lines.push(`## Read-through: ${p.target} (${p.targetStatus})${next}`);
    if (p.hypothesis) {
      // Multi-line hypotheses need every line quoted or the blockquote breaks.
      lines.push(`> ${p.hypothesis.replace(/\n/g, "\n> ")}`);
    } else {
      lines.push(`> (no hypothesis recorded for this pair — add one on the read-through pair)`);
    }
    if (p.positionLines.length > 0) {
      lines.push(`Positions: ${p.positionLines.join(" · ")}`);
    }
    parts.push(lines.join("\n\n"));
  }

  parts.push(
    `*Deterministic read-through notice — no AI interpretation. The hypothesis text above is your own; the full recap pipeline does not cover ${symbol} (not held/watchlist).*`,
  );

  return { subject, markdown: parts.join("\n\n") };
}

/** Resolve the target's next scheduled earnings print (family-aware). */
export function getNextPrintForTarget(
  db: Database.Database,
  target: string,
  today: string,
): { date: string; slot: string | null } | null {
  const family = issuerSiblings(target).map((s) => s.toUpperCase());
  const placeholders = family.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT event_date, event_time FROM calendar_events
        WHERE event_type = 'earnings'
          AND COALESCE(superseded, 0) = 0
          AND UPPER(symbol) IN (${placeholders})
          AND event_date >= ?
          AND actual_value IS NULL
        ORDER BY event_date ASC
        LIMIT 1`,
    )
    .get(...family, today) as { event_date: string; event_time: string | null } | undefined;
  if (!row) return null;
  const slot = row.event_time ? row.event_time.trim().toUpperCase() : null;
  return { date: row.event_date, slot: slot === "BMO" || slot === "AMC" ? slot : null };
}

/**
 * What one composed reporter recap is. The service (lib/earnings/send-service.ts)
 * turns this into an email: it owns the recipient, the claim, the markers, the
 * provider call and the audit row. This module owns the CONTENT and the gates.
 */
export interface ReporterRecapComposed {
  symbol: string;
  title: string;
  /** Already carries its own glyph — the service must not prefix another. */
  subject: string;
  html: string;
  markdown: string;
  /** Same string as `markdown`: this road is deterministic, so what is stored
   *  as the audit's "AI output" IS the whole email body. */
  aiMarkdown: string;
  /** Always null — nothing was prompted, so there is no prompt to hash. */
  promptHash: null;
  targets: string[];
}

/**
 * Compose the reporter recap for one event. COMPOSER ONLY (slice E): the claim,
 * the recipient, the provider call and the audit row moved to the canonical
 * send service, so a withheld recap now writes nothing at all — there is no
 * claim to release, which is exactly the failure mode the old release/catch
 * pair existed to undo.
 *
 * Every gate is unchanged and still throws EarningsEmailError with the benign
 * 409 `not_ready` code: the service releases the fresh claim and reports
 * `refused`, which the sweep books as a skip, not a failure — the same net
 * effect as before.
 */
export async function composeReporterRecapEmail(
  db: Database.Database,
  eventId: number,
): Promise<ReporterRecapComposed> {
  // Cluster-scoped acceptance stamp — reporterActualsUsable below bypasses
  // the plausibility gate on it, and it can sit on a superseded twin of this
  // same print (lib/queries/manual-actuals-cluster.ts).
  const event = withClusterManualActuals(
    db,
    db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(eventId) as
      | CalendarEvent
      | undefined,
  );
  if (!event || !event.symbol) {
    throw new EarningsEmailError(`Event ${eventId} not found or symbol-less.`, 404);
  }
  const symbol = event.symbol.toUpperCase();

  if (!reporterActualsUsable(event)) {
    // Benign: flagged/empty actuals retry on later ticks — a corrected
    // Finnhub row re-opens the road, and so does a manual override, which
    // stamps manual_actuals_at and therefore bypasses the plausibility gate
    // outright (reporterActualsUsable). No audit row written.
    // Loud breadcrumb: a real basis-mismatch print would otherwise age out
    // of the [yesterday, today] window with zero operator trace (the
    // blocked-recap Pushover only covers held names).
    console.warn(
      `[reporter-recap] ${symbol} withheld — actuals missing or flagged implausible (retries until the window closes).`,
    );
    throw new EarningsEmailError(
      `Actuals for ${symbol} are missing or flagged implausible — reporter recap withheld.`,
      409,
      "not_ready",
    );
  }

  // Pre-print floor (review hardening; single source of truth in
  // lib/earnings/pre-print-floor.ts — the manual-actuals save endpoint
  // shares this exact condition): a manual actuals typo (or a wrong vendor
  // actual) on an event whose recorded release instant is still in the
  // FUTURE must not fire an email presenting it as a real print. The AI
  // recap road gets this structurally from its enriched_at gate; this road
  // fires on bare actual_value, so guard explicitly. Unknown release
  // instants pass — actual_value on a date-windowed row is otherwise
  // trusted, same assumption as the IMAX already-reported guard.
  if (checkPrePrintFloor(event).isPrePrint) {
    throw new EarningsEmailError(
      `${symbol} has actuals recorded but its release instant is in the future — likely a pre-print entry; withheld.`,
      409,
      "not_ready",
    );
  }

  const live = getLiveReadThroughsForReporter(db, symbol);
  if (live.length === 0) {
    throw new EarningsEmailError(
      `No live read-through pairs for ${symbol} — nothing to report.`,
      409,
      "not_ready",
    );
  }

  const today = todayET();
  const pairs: ReporterRecapPair[] = live.map((p) => ({
    target: p.target,
    targetStatus: p.targetStatus,
    hypothesis: p.hypothesis,
    nextPrint: getNextPrintForTarget(db, p.target, today),
    positionLines: getCrossAccountPositions(db, [...issuerSiblings(p.target)]).map((pos) =>
      formatPositionPresence({
        symbol: pos.symbol,
        accountName: pos.account_name,
        quantity: pos.quantity,
        securityType: pos.security_type,
        optionMeta:
          pos.security_type.toLowerCase() === "option"
            ? {
                underlyingSymbol: pos.underlying_symbol,
                strikePrice: pos.strike_price,
                expirationDate: pos.expiration_date,
                optionType: pos.option_type,
              }
            : null,
      }),
    ),
  }));

  const content = composeReporterRecap(event, pairs);
  const footer = `Read-through reporter recap — deterministic, sent at first actuals. Reaction + enriched scoreboard live in the in-app viewer.`;
  const html = briefingToHtml(content.markdown, content.subject, footer);

  return {
    symbol,
    title: content.subject,
    subject: content.subject,
    html,
    markdown: content.markdown,
    aiMarkdown: content.markdown,
    promptHash: null,
    targets: pairs.map((p) => p.target),
  };
}
