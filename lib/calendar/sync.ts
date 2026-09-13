import type Database from "better-sqlite3";
import { fetchWshEvents } from "@/lib/tws/wsh";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";
import { fetchFinnhubEarningsForSymbols, type FinnhubSymbolFailure } from "@/lib/calendar/finnhub";
import { fetchNasdaqEarningsForSymbols } from "@/lib/calendar/nasdaq";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { getHeldStockSymbols, getHeldOptionUnderlyingSymbols } from "@/lib/queries/briefing-symbols";
import { getReadThroughReporterSymbols } from "@/lib/queries/read-through-pairs";
import { getActiveWatchlistStockSymbols } from "@/lib/queries/watchlist";
import { upsertCalendarEvents, deleteUnenrichedEventsForWeek } from "@/lib/mutations/calendar";
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
 * A 429 storm used to be completely invisible: 17 of 77 calendar fetches
 * failed, the loop kept ticking progress, and the run reported
 * "Finnhub 77/77 scanned" → "Refreshed — 5 new". A fifth of the universe was
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
          const result = upsertCalendarEvents(db, parsed);
          wshNew = result.inserted;
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
        // Reschedule-orphan cleanup — un-enriched rows only. Enriched rows are
        // historical records of releases that happened; the upsert below
        // refreshes their sync-owned metadata without touching enrichment.
        deleteUnenrichedEventsForWeek(db, weekOf, "claude_macro");
        const result = upsertCalendarEvents(db, macroInputs);
        macroNew = result.inserted;
      }
      macroEvents = macroInputs.length;
      send({
        phase: "macro_done",
        message: `Found ${macroEvents} macro event${macroEvents !== 1 ? "s" : ""}${macroNew < macroEvents ? ` (${macroNew} new)` : ""}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push(`macro: ${msg}`);
      send({ phase: "macro_error", message: `Macro event fetch failed: ${msg}` });
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
          deleteUnenrichedEventsForWeek(db, weekOf, "finnhub");
          const result = upsertCalendarEvents(db, finnhubInputs);
          finnhubNew = result.inserted;
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
        deleteUnenrichedEventsForWeek(db, weekOf, "nasdaq");
        const result = upsertCalendarEvents(db, nasdaqInputs);
        nasdaqNew = result.inserted;
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
  };
}
