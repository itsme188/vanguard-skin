import type Database from "better-sqlite3";
import { fetchWshEvents } from "@/lib/tws/wsh";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";
import { fetchMacroEvents, buildHardcodedMacroEvents } from "@/lib/calendar/macro-events";
import { fetchFinnhubEarningsForSymbols, type FinnhubSymbolFailure } from "@/lib/calendar/finnhub";
import { fetchNasdaqEarningsForSymbols } from "@/lib/calendar/nasdaq";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { getHeldStockSymbols, getHeldOptionUnderlyingSymbols } from "@/lib/queries/briefing-symbols";
import { getReadThroughReporterSymbols } from "@/lib/queries/read-through-pairs";
import { getActiveWatchlistStockSymbols } from "@/lib/queries/watchlist";
import {
  upsertCalendarEvents,
  deleteUnenrichedEventsForWeek,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";
import { getIbApi, disconnectTws } from "@/lib/tws/client";
import { addDays, validateWeekOf, todayET } from "@/lib/calendar/date-utils";

/**
 * Pure (non-SSE) calendar sync for a week. Single source of truth for
 * the three-phase ingest: WSH company events → Claude macro events →
 * Finnhub portfolio earnings. Invoked by:
 *
 *  - app/api/calendar/sync/route.ts (UI / launchd, with SSE progress bridge)
 *  - lib/digest/send-briefing.ts    (Sunday 3pm cron, no progress needed)
 *
 * Why extracted: the Sunday 4/26 briefing missed PCE + Q1 GDP (released
 * Thursday 4/30) because the briefing path only ran TWS sync, not calendar
 * sync. The macro events existed in FRED but were never written to
 * calendar_events for week_of=2026-04-27. This function ensures every
 * briefing-send path gets fresh week-ahead macro data.
 *
 * Behavior matches the route exactly: each phase is wrapped in try/catch
 * so a single API failure (TWS down, FRED 5xx, Finnhub rate limit) doesn't
 * cascade — partial sync is better than no sync.
 */

export interface SyncProgressEvent {
  phase: string;
  message: string;
}

export interface SyncCalendarOpts {
  onProgress?: (event: SyncProgressEvent) => void;
  includeWsh?: boolean;     // default true; auto-skipped if no TWS connection
  includeMacro?: boolean;   // default true
  includeFinnhub?: boolean; // default true; auto-skipped if no FINNHUB_API_KEY
  includeNasdaq?: boolean;  // default true; cross-checks Finnhub earnings dates
}

export interface SyncCalendarResult {
  weekOf: string;
  startDate: string;
  endDate: string;
  wshEvents: number;
  wshNew: number;
  macroEvents: number;
  macroNew: number;
  finnhubEvents: number;
  finnhubNew: number;
  nasdaqEvents: number;
  nasdaqNew: number;
  totalSaved: number;
  newEvents: number;
  refreshedEvents: number;
  errors: string[];
  /**
   * Domain-language entries for legs that never ran at all — TWS not
   * connected, no Finnhub key configured, etc. Distinct from `errors`: a
   * skip is an expected, non-failing outcome (nothing was attempted), so it
   * must never count toward an "N failed" total. Ledger finding
   * `today-earningshub-refresh--skip-not-visible`: the wsh_skip/finnhub_skip
   * progress phases explained why nothing happened, but the complete
   * payload's `errors` came back `[]`, so a run with two unrun legs still
   * rendered "Refreshed — 1 new" with no hint anything was skipped.
   */
  skipped: string[];
  /**
   * Rows that were showing before this refresh and that it DELETED, each with
   * a short reason (owner ruling 2026-10-06, ledger finding
   * `today-earningshub-refresh--deletes-scheduled-macro-release-never-recreated`:
   * a scheduled macro release was cleaned up as an orphan and the button said
   * nothing). Read off what each source's cleanup actually removed — see
   * `writeAndCollectRemoved`. Titles and dates are public calendar data.
   */
  removed: CalendarRowChange[];
  /**
   * Earnings rows that were showing when this refresh started and that it HID
   * (superseded) — still stored, no longer on any calendar surface (owner
   * ruling 2026-10-06, ledger finding `dashboard-today-earningshub-refresh-
   * from-finnhub-refresh-silently-supersedes-a-user-added-earnings-row-the-hub`).
   */
  superseded: CalendarRowChange[];
  /**
   * Hand-entered earnings rows this refresh brought BACK beside a
   * hand-entered twin (owner ruling 2026-10-07). Only rows dated today or
   * later are ever restored.
   */
  restored: CalendarRowChange[];
}

/** One row a refresh took off the calendar, in words the desk can read. */
export interface CalendarRowChange {
  title: string;
  /** YYYY-MM-DD. */
  eventDate: string;
  /** The pipeline that owned the row: 'claude_macro' | 'finnhub' | 'nasdaq' | 'manual' | … */
  source: string;
  /** Short, domain-language, no trailing period. */
  reason: string;
}

export class SyncCalendarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncCalendarValidationError";
  }
}

/**
 * Turns the Finnhub phase's swallowed per-symbol failures into the three
 * strings the desk sees (ledger finding
 * `today-earningshub-refresh--silent-partial-failure-no-outcome-report-regression-3`).
 *
 * A 429 storm used to be completely invisible: N of M calendar fetches
 * failed, the loop kept ticking progress, and the run reported
 * "Finnhub M/M scanned" → "Refreshed — k new". A slice of the universe was
 * never looked at. Returns null for a clean scan so every message stays
 * byte-identical to the pre-fix wording when nothing failed.
 */
function describeFinnhubFailures(
  failures: FinnhubSymbolFailure[],
  total: number,
): { progressTail: string; notScanned: string; error: string } | null {
  if (failures.length === 0) return null;

  const rateLimited = failures.filter((f) => f.rateLimited).length;
  const other = failures.length - rateLimited;

  const progressTail =
    other === 0
      ? ` · ${failures.length} rate-limited`
      : rateLimited === 0
        ? ` · ${failures.length} failed`
        : ` · ${failures.length} failed (${rateLimited} rate-limited)`;

  const notScanned =
    ` · ${failures.length} of ${total} symbols not scanned` +
    (rateLimited > 0 ? " (rate-limited)" : "");

  // Domain language, no upstream body text: the desk needs to know how much
  // of the universe went unscanned and whether waiting fixes it.
  const cause =
    other === 0
      ? "rate-limited by Finnhub (429); retry in a few minutes"
      : rateLimited === 0
        ? "failed to fetch"
        : `${rateLimited} rate-limited by Finnhub (429), ${other} failed to fetch; retry in a few minutes`;

  return {
    progressTail,
    notScanned,
    error: `finnhub: ${failures.length} of ${total} symbols not scanned — ${cause}`,
  };
}

/**
 * Run one source's write step and return how many of its source_keys are
 * genuinely new — present after the step, absent before it.
 *
 * [qa:today-earningshub-refresh--outcome-line-counts-reminted-macro-rows-as-new]
 * The macro / Finnhub / Nasdaq steps delete their own un-enriched rows for the
 * week and re-insert them with the SAME source_key, so the upsert's
 * `inserted` count called every re-minted row "new" and the outcome line said
 * "N new" for an unchanged release list. The snapshot is taken before the
 * delete, so a re-mint counts as a refresh. Reporting only — the write step
 * itself is unchanged. Suppressed inputs never land, so they never count.
 */
function writeAndCountNewKeys(
  db: Database.Database,
  inputs: CalendarEventInput[],
  write: () => void,
): number {
  const keys = Array.from(new Set(inputs.map((e) => e.source_key)));
  if (keys.length === 0) {
    write();
    return 0;
  }
  const placeholders = keys.map(() => "?").join(",");
  const existing = db.prepare(
    `SELECT source_key FROM calendar_events WHERE source_key IN (${placeholders})`,
  );
  const readKeys = () =>
    new Set((existing.all(...keys) as { source_key: string }[]).map((r) => r.source_key));
  const before = readKeys();
  write();
  const after = readKeys();
  let fresh = 0;
  for (const key of after) if (!before.has(key)) fresh++;
  return fresh;
}

/**
 * Run one source's cleanup-then-write step and return the rows it REMOVED:
 * rows of that source and week that were showing before the step and whose
 * source_key is gone after it.
 *
 * Reporting only — the step itself is unchanged. It is a before/after diff of
 * the table rather than a prediction of what the delete will do, so it can
 * never name a row the delete's protections kept (released rows, rows with an
 * email / skip / bogey / probe stamp), and a row deleted and re-minted under
 * the same source_key is correctly NOT a removal. Rows already hidden
 * (`superseded`) are left out: the desk was not looking at them.
 */
function writeAndCollectRemoved(
  db: Database.Database,
  weekOf: string,
  source: "claude_macro" | "finnhub" | "nasdaq",
  reason: string,
  write: () => void,
): CalendarRowChange[] {
  const showing = db
    .prepare(
      `SELECT source_key, title, event_date FROM calendar_events
        WHERE week_of = ? AND source = ? AND COALESCE(superseded, 0) = 0
        ORDER BY event_date ASC, id ASC`,
    )
    .all(weekOf, source) as { source_key: string; title: string; event_date: string }[];
  write();
  if (showing.length === 0) return [];
  const stillStored = db.prepare("SELECT 1 FROM calendar_events WHERE source_key = ?");
  return showing
    .filter((r) => stillStored.get(r.source_key) === undefined)
    .map((r) => ({ title: r.title, eventDate: r.event_date, source, reason }));
}

/**
 * Write the hardcoded macro rows (FOMC + ISM/UMich/Conference Board) for a
 * week when the full macro fetch failed. Upsert only — idempotent on
 * source_key, never deletes, never calls a network or an AI.
 *
 * A non-FRED indicator that the normal road already wrote for this week is
 * skipped: that road may have moved it to a publisher-rescheduled date, and
 * re-adding the unverified hardcoded date beside it would show the release
 * twice. Never throws — a fallback failure must not mask the original error.
 */
function writeHardcodedMacroFallback(
  db: Database.Database,
  startDate: string,
  endDate: string,
  weekOf: string,
): { written: number; fresh: number } {
  try {
    const { events, nonFredKeyPrefixes } = buildHardcodedMacroEvents(startDate, endDate, weekOf);
    const hasPrefix = db.prepare(
      `SELECT 1 FROM calendar_events
        WHERE week_of = ? AND substr(source_key, 1, ?) = ? LIMIT 1`,
    );
    const toWrite = events.filter((e) => {
      const prefix = nonFredKeyPrefixes.get(e.source_key);
      if (!prefix) return true; // FOMC — keyed on the meeting date itself
      return hasPrefix.get(weekOf, prefix.length, prefix) === undefined;
    });
    if (toWrite.length === 0) return { written: 0, fresh: 0 };
    const fresh = writeAndCountNewKeys(db, toWrite, () => {
      upsertCalendarEvents(db, toWrite);
    });
    return { written: toWrite.length, fresh };
  } catch (err) {
    console.warn(
      `[calendar-sync] hardcoded macro fallback failed: ${err instanceof Error ? err.message : err}`,
    );
    return { written: 0, fresh: 0 };
  }
}

export async function syncCalendarForWeek(
  db: Database.Database,
  weekOf: string,
  opts: SyncCalendarOpts = {},
): Promise<SyncCalendarResult> {
  const validationError = validateWeekOf(weekOf);
  if (validationError) {
    throw new SyncCalendarValidationError(validationError);
  }

  const startDate = weekOf;
  const endDate = addDays(weekOf, 6);
  const wshStart = startDate.replace(/-/g, "");
  const wshEnd = endDate.replace(/-/g, "");

  const includeWsh = opts.includeWsh ?? true;
  const includeMacro = opts.includeMacro ?? true;
  const includeFinnhub = opts.includeFinnhub ?? true;
  const includeNasdaq = opts.includeNasdaq ?? true;
  const send = opts.onProgress ?? (() => {});
  const errors: string[] = [];
  const skipped: string[] = [];
  const removed: CalendarRowChange[] = [];
  let superseded: CalendarRowChange[] = [];
  let restored: CalendarRowChange[] = [];

  // Earnings rows on screen as the refresh starts, by source_key (the vendor
  // steps delete and re-mint rows, so ids do not survive the run). The
  // reconcile step below reports every row its pass hid; only the ones in
  // this set were visible to the desk beforehand. A hidden twin that is
  // re-minted and hidden again, or a duplicate that arrives and is hidden
  // inside this same run, was never on screen and is not named.
  const showingAtStart = new Set(
    (
      db
        .prepare(
          `SELECT source_key FROM calendar_events
            WHERE event_type = 'earnings' AND COALESCE(superseded, 0) = 0`,
        )
        .all() as { source_key: string }[]
    ).map((r) => r.source_key),
  );

  let wshEvents = 0;
  let wshNew = 0;
  let macroEvents = 0;
  let macroNew = 0;
  let finnhubEvents = 0;
  let finnhubNew = 0;
  let nasdaqEvents = 0;
  let nasdaqNew = 0;

  if (includeWsh) {
    const api = getIbApi();
    if (api) {
      send({ phase: "wsh_fetch", message: "Fetching company events from TWS..." });
      try {
        const wshJson = await fetchWshEvents({
          startDate: wshStart,
          endDate: wshEnd,
          fillPortfolio: true,
        });
        send({ phase: "wsh_parse", message: "Parsing WSH event data..." });
        const parsed = parseWshEvents(wshJson, weekOf, db);
        if (parsed.length > 0) {
          // WSH never deletes before upserting, but shares the one "new"
          // definition so the four counts can't drift apart.
          wshNew = writeAndCountNewKeys(db, parsed, () => {
            upsertCalendarEvents(db, parsed);
          });
        }
        wshEvents = parsed.length;
        send({
          phase: "wsh_done",
          message: `Found ${wshEvents} company event${wshEvents !== 1 ? "s" : ""}${wshNew < wshEvents ? ` (${wshNew} new)` : ""}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown WSH error";
        errors.push(`wsh: ${msg}`);
        if (msg.toLowerCase().includes("timeout")) {
          disconnectTws();
          send({
            phase: "wsh_error",
            message: "TWS connection appears dead — auto-disconnected. Reconnect via TWS panel to sync company events.",
          });
        } else {
          send({
            phase: "wsh_error",
            message: `WSH fetch failed: ${msg}. Continuing with macro events...`,
          });
        }
      }
    } else {
      skipped.push("Company events skipped — TWS not connected");
      send({
        phase: "wsh_skip",
        message:
          "TWS not connected — skipping company events. Connect TWS and re-sync to include earnings/analyst meetings.",
      });
    }
  }

  if (includeMacro) {
    send({ phase: "macro_fetch", message: "Researching macro events via Claude..." });
    try {
      const macroInputs = await fetchMacroEvents(startDate, endDate, weekOf);
      if (macroInputs.length > 0) {
        // Reschedule-orphan cleanup — un-enriched TRUE orphans only (rows this
        // fetch no longer lists). Re-listed rows are refreshed in place by the
        // upsert, which keeps their id and any stored consensus_estimate /
        // previous_value this fetch omits. Enriched rows are historical
        // records of releases that happened and are never deleted.
        macroNew = writeAndCountNewKeys(db, macroInputs, () => {
          removed.push(
            ...writeAndCollectRemoved(
              db,
              weekOf,
              "claude_macro",
              "no longer on the release schedule the source publishes",
              () => {
                deleteUnenrichedEventsForWeek(
                  db,
                  weekOf,
                  "claude_macro",
                  macroInputs.map((e) => e.source_key),
                );
                upsertCalendarEvents(db, macroInputs);
              },
            ),
          );
        });
      }
      macroEvents = macroInputs.length;
      send({
        phase: "macro_done",
        message: `Found ${macroEvents} macro event${macroEvents !== 1 ? "s" : ""}${macroNew < macroEvents ? ` (${macroNew} new)` : ""}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push(`macro: ${msg}`);
      // The FRED/Claude leg failed — but the FOMC and non-FRED dates are a
      // hardcoded table that needs neither (user ruling 2026-10-05: they are
      // synced for the full four-week horizon, not only when FRED answers).
      // Add-only: no orphan cleanup ran, so nothing is deleted here.
      const kept = writeHardcodedMacroFallback(db, startDate, endDate, weekOf);
      macroEvents = kept.written;
      macroNew = kept.fresh;
      send({
        phase: "macro_error",
        message:
          `Macro event fetch failed: ${msg}` +
          (kept.written > 0
            ? ` — kept ${kept.written} scheduled event${kept.written !== 1 ? "s" : ""} from the built-in FOMC/ISM/UMich/Conference Board calendar`
            : ""),
      });
    }
  }

  // Scan set = held stocks ∪ read-through reporters ∪ active watchlist ∪
  // held-option underlyings. Watchlist names get full earnings parity (user
  // decision, Wave 1); option-only names (e.g. a TER LEAP with no TER stock)
  // must see their print too. Deduped + uppercase to keep call counts tight.
  // Shared by the Finnhub scan AND the Nasdaq cross-check (Wave 1 item 3) —
  // the cross-check must validate dates for the exact universe Finnhub
  // scanned, or a watchlist-only/option-only name could get a Finnhub row
  // with no Nasdaq corroboration.
  const heldSymbols = getHeldStockSymbols(db);
  const reporterSymbols = getReadThroughReporterSymbols(db);
  const watchlistSymbols = getActiveWatchlistStockSymbols(db);
  const optionUnderlyings = getHeldOptionUnderlyingSymbols(db);
  const scanSymbols = Array.from(
    new Set(
      [...heldSymbols, ...reporterSymbols, ...watchlistSymbols, ...optionUnderlyings].map(
        (s) => s.toUpperCase(),
      ),
    ),
  ).sort();

  if (includeFinnhub) {
    if (process.env.FINNHUB_API_KEY) {
      const extras = scanSymbols.length - heldSymbols.length;
      const extrasSuffix =
        extras > 0 ? ` (+ ${extras} watchlist/reporter/underlying)` : "";
      send({
        phase: "finnhub_fetch",
        message: `Scanning ${scanSymbols.length} symbol${scanSymbols.length === 1 ? "" : "s"} via Finnhub${extrasSuffix}...`,
      });
      // Per-symbol calendar fetches that failed (429s, mostly) — swallowed
      // inside the fetcher so one bad symbol can't abort the sweep, reported
      // here so the run can't claim it scanned them.
      const finnhubFailures: FinnhubSymbolFailure[] = [];
      try {
        const finnhubInputs = await fetchFinnhubEarningsForSymbols(
          db,
          scanSymbols,
          startDate,
          endDate,
          weekOf,
          (done, total) => {
            // `done` counts ATTEMPTS; the desk needs SUCCESSFUL scans. The
            // fetcher reports a failure before ticking progress for that
            // symbol, so the subtraction is always in step.
            const partial = describeFinnhubFailures(finnhubFailures, total);
            send({
              phase: "finnhub_progress",
              message: `Finnhub ${done - finnhubFailures.length}/${total} scanned${partial ? partial.progressTail : ""}`,
            });
          },
          (failure) => {
            finnhubFailures.push(failure);
          },
        );
        if (finnhubInputs.length > 0) {
          // Same enrichment-preserving cleanup as the macro phase — an enriched
          // earnings row also anchors earnings_emails dedup rows (CASCADE).
          // A partial scan deletes rows for names it never asked about, so
          // the reason must not claim the vendor dropped the date.
          const finnhubReason =
            finnhubFailures.length > 0
              ? "Finnhub did not return this date on this refresh (some symbols were not scanned)"
              : "Finnhub did not return this date on this refresh";
          finnhubNew = writeAndCountNewKeys(db, finnhubInputs, () => {
            removed.push(
              ...writeAndCollectRemoved(db, weekOf, "finnhub", finnhubReason, () => {
                deleteUnenrichedEventsForWeek(db, weekOf, "finnhub");
                upsertCalendarEvents(db, finnhubInputs);
              }),
            );
          });
        }
        finnhubEvents = finnhubInputs.length;
        send({
          phase: "finnhub_done",
          message:
            `Found ${finnhubEvents} portfolio earning${finnhubEvents !== 1 ? "s" : ""}${finnhubNew < finnhubEvents ? ` (${finnhubNew} new)` : ""}` +
            (describeFinnhubFailures(finnhubFailures, scanSymbols.length)?.notScanned ?? ""),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        errors.push(`finnhub: ${msg}`);
        send({ phase: "finnhub_error", message: `Finnhub scan failed: ${msg}` });
      }
      // Outside the try: a partial scan is worth reporting even when the
      // upsert (or a later throw) took the phase down with it.
      const partialScan = describeFinnhubFailures(finnhubFailures, scanSymbols.length);
      if (partialScan) errors.push(partialScan.error);
    } else {
      skipped.push("Finnhub scan skipped — no API key configured");
      send({
        phase: "finnhub_skip",
        message: "FINNHUB_API_KEY not set — skipping portfolio earnings scan.",
      });
    }
  }

  // ── Nasdaq cross-check (date authority alongside Finnhub) ──────────
  // Same scanSymbols set as Finnhub (hoisted above). Window reaches back 7
  // days before the week so a name that already reported (a corrected past
  // date) can supersede a stale future Finnhub row. US-listed only — no
  // GFL→GFL.TO drift. Graceful-degrades (returns fewer rows) if the
  // unofficial endpoint is unavailable.
  if (includeNasdaq) {
    send({ phase: "nasdaq_fetch", message: "Cross-checking earnings dates via Nasdaq..." });
    try {
      const nasdaqStart = addDays(startDate, -7);
      const nasdaqInputs = await fetchNasdaqEarningsForSymbols(
        db,
        scanSymbols,
        nasdaqStart,
        endDate,
        weekOf,
      );
      if (nasdaqInputs.length > 0) {
        nasdaqNew = writeAndCountNewKeys(db, nasdaqInputs, () => {
          removed.push(
            ...writeAndCollectRemoved(
              db,
              weekOf,
              "nasdaq",
              "Nasdaq did not return this date on this refresh",
              () => {
                deleteUnenrichedEventsForWeek(db, weekOf, "nasdaq");
                upsertCalendarEvents(db, nasdaqInputs);
              },
            ),
          );
        });
      }
      nasdaqEvents = nasdaqInputs.length;
      send({
        phase: "nasdaq_done",
        message: `Nasdaq found ${nasdaqEvents} earning${nasdaqEvents !== 1 ? "s" : ""}${nasdaqNew < nasdaqEvents ? ` (${nasdaqNew} new)` : ""}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push(`nasdaq: ${msg}`);
      send({ phase: "nasdaq_error", message: `Nasdaq scan failed: ${msg}` });
    }
  }

  // ── Reconcile earnings dates (Finnhub × Nasdaq) ───────────────────
  // Resolve a canonical date + trust status per name; supersede the losers so
  // every reader shows exactly one row per reporting event. Pure DB work.
  try {
    const rec = reconcileEarningsDates(db, { today: todayET() });
    superseded = rec.superseded
      .filter((r) => showingAtStart.has(r.sourceKey))
      .map((r) => ({
        title: r.title,
        eventDate: r.eventDate,
        source: r.source,
        reason: r.reason,
      }));
    // No "showing at start" filter: a restored row was hidden by definition,
    // and hand-entered rows are never deleted and re-minted by a vendor step.
    restored = rec.restored.map((r) => ({
      title: r.title,
      eventDate: r.eventDate,
      source: r.source,
      reason: r.reason,
    }));
    send({
      phase: "reconcile_done",
      message: `Earnings dates reconciled: ${rec.confirmed} confirmed, ${rec.conflict} conflict, ${rec.single} single, ${rec.userConfirmed} you-confirmed`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    errors.push(`reconcile: ${msg}`);
  }

  const totalSaved = wshEvents + macroEvents + finnhubEvents + nasdaqEvents;
  const newEvents = wshNew + macroNew + finnhubNew + nasdaqNew;

  return {
    weekOf,
    startDate,
    endDate,
    wshEvents,
    wshNew,
    macroEvents,
    macroNew,
    finnhubEvents,
    finnhubNew,
    nasdaqEvents,
    nasdaqNew,
    totalSaved,
    newEvents,
    refreshedEvents: totalSaved - newEvents,
    errors,
    skipped,
    removed,
    superseded,
    restored,
  };
}
