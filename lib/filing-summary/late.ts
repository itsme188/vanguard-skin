/**
 * The late periodic report (spec docs/superpowers/specs/2026-10-29-late-periodic-report-design.md,
 * migration 100): the 10-Q / 10-K an issuer files AFTER the print night.
 *
 * The evening poll (`poller.ts`) stops at 21:00 Eastern on the event date and
 * sets `past_cutoff`. From then on a narrow second watch looks for the
 * quarterly or annual report:
 *
 *  - WINDOW (owner ruling 2026-10-29): until 16:00 Eastern on the next
 *    trading day after the event date (`nextTradingDay`, the NYSE calendar in
 *    `lib/calendar/market-holidays.ts`). Polled every 10 minutes on the event
 *    evening after 21:00 and on that trading day from 06:00; never on the
 *    days between (a Friday print waits for Monday). A "Look again" click
 *    (`lookAgainLate`) runs one poll at any time after `past_cutoff`, the
 *    window's end included, with no upper bound on the acceptance time.
 *  - WHAT COUNTS: a `10-Q` or `10-K` (exact form: an amended 10-Q/A or 10-K/A
 *    is ignored) from the earnings filing's CIK, whose header
 *    `<ACCEPTANCE-DATETIME>` (Eastern, never the submissions JSON alone) is
 *    after the earnings filing's, and whose header period of report is a
 *    period end before the print and within `PERIOD_MAX_AGE_DAYS` of it (the
 *    print's quarter or fiscal year), and whose accession the event does not
 *    already hold as a non-rejected evening filing. There is NO "after 21:00"
 *    rule: SEC's submissions list can lag the acceptance time, so a 10-Q
 *    accepted before 21:00 may be missing from the list at the evening
 *    catch-up and appear only later (Alphabet, 2026-10-28: accepted 20:29,
 *    not listed at the 21:00 catch-up). The submissions JSON is only the
 *    cheap prefilter (both readings, as the poller does). A 10-Q the evening
 *    summary already holds as an accepted companion is never stored twice;
 *    one the evening poll stored as rejected (e.g. "accepted after 9 pm") is
 *    moved to `late` in place instead.
 *  - FOREIGN FILERS: a 6-K carrying the interim report cannot be told
 *    reliably from any other 6-K from the header alone (no item codes, free
 *    exhibit descriptions), so 6-K filers are left out of the late watch.
 *  - STORED as role `companion`, arrival `late`, verdict `accepted`; then
 *    `onLateFilingAccepted` starts the one follow-up run (runner.ts
 *    `startLateRun`). The evening summary is never re-run or edited.
 *
 * In-app only: no email, no push, no Worker, no snapshot field.
 */
import type Database from "better-sqlite3";
import { addDays, calendarDaysBetween } from "@/lib/calendar/date-utils";
import { nextTradingDay } from "@/lib/calendar/market-holidays";
import {
  fetchSubmissionsRecent,
  parseEdgarAcceptanceDateTime,
} from "@/lib/print-watch/edgar-adapter";
import { inferFilerKind } from "./edgar";
import {
  CUTOFF_ET,
  easternClock,
  fetchDocuments,
  headerFor,
  POLL_START_ET,
  type PollSeams,
} from "./poller";
import {
  getEventState,
  getLateWatch,
  insertFiling,
  listFilings,
  listLateFilings,
  listLateWatches,
  markLateWatchPolled,
  openLateWatch,
  setLateWatchState,
  upsertDocument,
  type FilingRow,
  type LateWatchRow,
} from "./store";

/** Minutes between automatic late polls. */
export const LATE_POLL_EVERY_MS = 10 * 60_000;
/** The late window closes at this Eastern wall time on the next trading day. */
export const LATE_WINDOW_END_ET = "16:00:00";
/**
 * A report's period end must be before the print and at most this many days
 * earlier: the print's own quarter (or fiscal year for a 10-K), never an
 * older report. Quarters are ~91 days apart, so a prior quarter's report
 * cannot pass.
 */
export const PERIOD_MAX_AGE_DAYS = 80;
/** Days back the tick looks for a `past_cutoff` print with no watch (lazy backfill). */
const BACKFILL_DAYS = 7;
/** The forms that count. Exact match after normalising: amendments are ignored. */
const LATE_FORMS: ReadonlySet<string> = new Set(["10-Q", "10-K"]);

export interface LatePollSeams extends Pick<PollSeams, "fetchFn" | "now" | "storageRoot"> {
  /** A late filing was stored as accepted: start its follow-up run. */
  onLateFilingAccepted(db: Database.Database, eventId: number, filingId: number): void;
}

export type LatePollResult =
  | { status: "found"; filingId: number; form: string; alreadyFound: boolean }
  | { status: "none" }
  | { status: "sec_unreachable" }
  | { status: "not_eligible"; reason: "no_watch_basis" | "foreign_filer" };

// ---------------------------------------------------------------- the window

/** `YYYY-MM-DDTHH:MM:SS` Eastern wall time → ISO instant. */
function easternInstantIso(date: string, time: string): string {
  return new Date(parseEdgarAcceptanceDateTime(`${date}T${time}`)).toISOString();
}

/** 16:00 Eastern on the next trading day after the event date, as an ISO instant. */
export function lateWindowEndsAt(eventDate: string): string {
  return easternInstantIso(nextTradingDay(eventDate), LATE_WINDOW_END_ET);
}

/**
 * Whether an automatic poll may run now: before the window's end, and either
 * on the event date at or after 21:00 or on the next trading day at or after
 * 06:00. The days between (a weekend, a holiday) are skipped.
 */
export function inLatePollHours(eventDate: string, nowMs: number): boolean {
  if (nowMs >= Date.parse(lateWindowEndsAt(eventDate))) return false;
  const { date, time } = easternClock(nowMs);
  if (date === eventDate) return time >= CUTOFF_ET;
  if (date === nextTradingDay(eventDate)) return time >= POLL_START_ET;
  return false;
}

// ---------------------------------------------------------------- basis

interface WatchBasis {
  eventDate: string;
  cik: string;
  earnings: FilingRow;
  earningsMs: number;
}

function eventDateOf(db: Database.Database, eventId: number): string | null {
  const r = db.prepare("SELECT event_date FROM calendar_events WHERE id = ?").get(eventId) as
    | { event_date: string }
    | undefined;
  return r?.event_date ?? null;
}

/**
 * What a late watch needs: the event past its evening cutoff, its accepted
 * evening earnings filing with a header time, and that filing's CIK. Null
 * otherwise (no basis: nothing to compare a late filing against).
 */
function watchBasis(db: Database.Database, eventId: number): WatchBasis | null {
  const state = getEventState(db, eventId);
  if (!state || state.pollState !== "past_cutoff") return null;
  const eventDate = eventDateOf(db, eventId);
  if (!eventDate) return null;
  const earnings = listFilings(db, eventId).find((f) => f.role === "earnings" && f.identityVerdict === "accepted");
  if (!earnings || !earnings.acceptedAt) return null;
  const earningsMs = Date.parse(earnings.acceptedAt);
  if (Number.isNaN(earningsMs)) return null;
  if (state.cik && state.cik !== earnings.cik) return null;
  return { eventDate, cik: earnings.cik, earnings, earningsMs };
}

/**
 * Opens the watch for a `past_cutoff` print whose window has not ended (a
 * print already past its window gets no row: only Look again reaches it).
 * True when a row was created.
 */
export function ensureLateWatch(db: Database.Database, eventId: number, nowMs: number): boolean {
  if (getLateWatch(db, eventId)) return false;
  const basis = watchBasis(db, eventId);
  if (!basis) return false;
  const ends = lateWindowEndsAt(basis.eventDate);
  if (nowMs >= Date.parse(ends)) return false;
  return openLateWatch(db, eventId, ends);
}

// ---------------------------------------------------------------- the poll

function normalizeForm(form: string): string {
  return form.trim().toUpperCase().replace(/\s+/g, " ");
}

/** The period end matches the print: before the event date and at most `PERIOD_MAX_AGE_DAYS` earlier. */
export function periodMatchesPrint(periodOfReport: string | null | undefined, eventDate: string): boolean {
  if (!periodOfReport || !(periodOfReport < eventDate)) return false;
  const days = calendarDaysBetween(periodOfReport, eventDate); // absolute
  return Number.isFinite(days) && days <= PERIOD_MAX_AGE_DAYS;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * One look at EDGAR for the event's late periodic report. `manual` (Look
 * again) drops the window's upper bound. Stores at most one filing, the
 * earliest accepted that counts, and calls `onLateFilingAccepted` for it.
 * Never throws for an SEC failure; rethrows an abort.
 */
export async function pollLateFiling(
  db: Database.Database,
  eventId: number,
  nowMs: number,
  seams: LatePollSeams,
  opts: { manual?: boolean } = {},
): Promise<LatePollResult> {
  const already = listLateFilings(db, eventId).find((f) => f.identityVerdict === "accepted");
  if (already) return { status: "found", filingId: already.id, form: already.form, alreadyFound: true };
  const basis = watchBasis(db, eventId);
  if (!basis) return { status: "not_eligible", reason: "no_watch_basis" };
  const upperMs = opts.manual ? Infinity : Date.parse(lateWindowEndsAt(basis.eventDate));

  let recent;
  try {
    recent = await fetchSubmissionsRecent(basis.cik, seams.fetchFn);
  } catch (err) {
    if (isAbort(err)) throw err;
    if (getLateWatch(db, eventId)) markLateWatchPolled(db, eventId, nowMs);
    return { status: "sec_unreachable" };
  }
  if (getLateWatch(db, eventId)) markLateWatchPolled(db, eventId, nowMs);
  if (inferFilerKind(recent.form) === "foreign") return { status: "not_eligible", reason: "foreign_filer" };

  // Prefilter on the JSON (either reading after the earnings filing, minus a
  // day of slack); the header decides.
  const floorMs = basis.earningsMs - 24 * 3_600_000;
  const evening = new Map(listFilings(db, eventId).map((f) => [f.accession, f]));
  const candidates: Array<{ accession: string; form: string; acceptanceMs: number }> = [];
  let headerFailures = 0;
  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const form = normalizeForm(recent.form[i] ?? "");
    if (!LATE_FORMS.has(form)) continue;
    const raw = recent.acceptanceDateTime[i] ?? "";
    const a = Date.parse(raw);
    const b = parseEdgarAcceptanceDateTime(raw);
    const near = (ms: number) => Number.isFinite(ms) && ms >= floorMs && ms <= upperMs + 24 * 3_600_000;
    if (!near(a) && !near(b)) continue;
    const accession = recent.accessionNumber[i];
    const prior = evening.get(accession);
    // A filing the evening summary holds (not rejected) is already read there:
    // never stored twice. A rejected evening row (e.g. "accepted after 9 pm")
    // moves to late in place below.
    if (prior && prior.identityVerdict !== "rejected") continue;
    const header = await headerFor(basis.cik, accession, seams.fetchFn);
    if (!header) {
      headerFailures += 1;
      continue;
    }
    if (header.acceptanceMs === null) continue;
    const ms = header.acceptanceMs;
    if (ms <= basis.earningsMs || ms > upperMs) continue;
    if (!periodMatchesPrint(header.periodOfReport, basis.eventDate)) continue;
    candidates.push({ accession, form, acceptanceMs: ms });
  }
  // A header that would not load could be the report: never say "none" on a partial look.
  if (candidates.length === 0) return headerFailures > 0 ? { status: "sec_unreachable" } : { status: "none" };
  candidates.sort((x, y) => x.acceptanceMs - y.acceptanceMs);
  const c = candidates[0];

  let filingId: number;
  const prior = evening.get(c.accession);
  if (prior) {
    // The evening poll stored it rejected (never run): it becomes the late
    // filing, documents and all. No evening section reads it.
    db.prepare(
      `UPDATE filing_summary_filings
          SET arrival = 'late', role = 'companion', identity_verdict = 'accepted', identity_reason = NULL
        WHERE id = ? AND arrival = 'evening' AND identity_verdict = 'rejected'`,
    ).run(prior.id);
    filingId = prior.id;
  } else {
    const header = await headerFor(basis.cik, c.accession, seams.fetchFn);
    if (!header) return { status: "sec_unreachable" };
    const fetched = await fetchDocuments(basis.cik, c.accession, c.form, header, seams.fetchFn, seams.storageRoot?.());
    const res = db.transaction(() => {
      const r = insertFiling(db, {
        eventId,
        accession: c.accession,
        cik: basis.cik,
        form: c.form,
        role: "companion",
        items: header.items.length > 0 ? header.items.join(",") : null,
        acceptedAt: iso(c.acceptanceMs),
        discoveredAt: iso(seams.now()),
        identityVerdict: "accepted",
        identityReason: null,
        fetchState: fetched.fetchState,
        arrival: "late",
      });
      if (r.inserted) for (const d of fetched.documents) upsertDocument(db, { filingId: r.id, ...d });
      return r;
    })();
    filingId = res.id;
  }
  if (getLateWatch(db, eventId)) setLateWatchState(db, eventId, "found");
  try {
    seams.onLateFilingAccepted(db, eventId, filingId);
  } catch {
    // Ids only: a runner error can quote filing text. The tick retries the start.
    console.warn(`[filing-summary] late run start failed for event ${eventId}`);
  }
  return { status: "found", filingId, form: c.form, alreadyFound: false };
}

// ---------------------------------------------------------------- the tick's part

export interface LateTickOutcome {
  opened: number[];
  polled: number[];
  ended: number[];
}

/**
 * The late watch's share of the 60-second tick: open watches for recent
 * `past_cutoff` prints (lazy backfill), cancel a disarmed print's watch, end a
 * watch past its window, and poll each due watch (every 10 minutes inside
 * `inLatePollHours`). `ensureLateRun` retries a follow-up start that found no
 * model.
 */
export async function runLateTick(
  db: Database.Database,
  nowMs: number,
  seams: LatePollSeams & { ensureLateRun?(db: Database.Database, eventId: number): void },
  today: string,
): Promise<LateTickOutcome> {
  const out: LateTickOutcome = { opened: [], polled: [], ended: [] };
  const recent = (
    db
      .prepare(
        `SELECT e.event_id FROM filing_summary_events e
           JOIN calendar_events ce ON ce.id = e.event_id
          WHERE e.poll_state = 'past_cutoff'
            AND ce.event_date >= ?
            AND NOT EXISTS (SELECT 1 FROM filing_summary_late_watch w WHERE w.event_id = e.event_id)
          ORDER BY e.event_id`,
      )
      .all(addDays(today, -BACKFILL_DAYS)) as Array<{ event_id: number }>
  ).map((r) => r.event_id);
  for (const eventId of recent) {
    if (ensureLateWatch(db, eventId, nowMs)) out.opened.push(eventId);
  }

  // Only watches with work: still watching, or found with no follow-up run yet
  // (a found / ended / cancelled watch with nothing owed is never revisited).
  const owed = new Set(
    (
      db
        .prepare(
          `SELECT w.event_id FROM filing_summary_late_watch w
            WHERE w.state = 'found'
              AND NOT EXISTS (SELECT 1 FROM filing_summary_runs r
                                JOIN filing_summary_sections s ON s.run_id = r.id
                                JOIN filing_summary_filings f ON f.id = s.filing_id
                               WHERE r.event_id = w.event_id AND f.arrival = 'late')`,
        )
        .all() as Array<{ event_id: number }>
    ).map((r) => r.event_id),
  );
  for (const w of [...listLateWatches(db, "watching"), ...listLateWatches(db, "found").filter((x) => owed.has(x.eventId))]) {
    await lateWatchStep(db, w, nowMs, seams, out);
  }
  return out;
}

async function lateWatchStep(
  db: Database.Database,
  w: LateWatchRow,
  nowMs: number,
  seams: LatePollSeams & { ensureLateRun?(db: Database.Database, eventId: number): void },
  out: LateTickOutcome,
): Promise<void> {
  const eventId = w.eventId;
  if (w.state === "cancelled") return;
  if (getEventState(db, eventId)?.pollState === "cancelled") {
    setLateWatchState(db, eventId, "cancelled");
    return;
  }
  if (w.state === "found") {
    if (seams.ensureLateRun) {
      try {
        seams.ensureLateRun(db, eventId);
      } catch {
        console.warn(`[filing-summary] late run retry for event ${eventId} failed`);
      }
    }
    return;
  }
  if (w.state !== "watching") return;
  if (nowMs >= Date.parse(w.windowEndsAt)) {
    setLateWatchState(db, eventId, "ended");
    out.ended.push(eventId);
    return;
  }
  const eventDate = eventDateOf(db, eventId);
  if (!eventDate || !inLatePollHours(eventDate, nowMs)) return;
  if (w.lastPolledAt) {
    const last = Date.parse(w.lastPolledAt);
    if (!Number.isNaN(last) && nowMs - last < LATE_POLL_EVERY_MS) return;
  }
  try {
    const res = await pollLateFiling(db, eventId, nowMs, seams);
    out.polled.push(eventId);
    if (res.status === "not_eligible") {
      // A foreign filer, or the basis is gone (the earnings filing was
      // rejected): nothing will ever count, so the watch ends now.
      setLateWatchState(db, eventId, "ended");
      out.ended.push(eventId);
    }
  } catch (err) {
    console.warn(`[filing-summary] late poll for event ${eventId} ${isAbort(err) ? "was aborted" : "failed"}`);
  }
}

// ---------------------------------------------------------------- Look again

export type LookAgainResult =
  | { ok: true; data: { eventId: number; found: boolean; form: string | null; filingId: number | null } }
  | { ok: false; reason: "disarmed" | "not_past_cutoff" | "no_basis" | "foreign_filer" | "sec_unreachable" };

/**
 * One on-demand poll for the late report ("Look again"), at any time after
 * `past_cutoff`, the automatic window's end included (no upper bound on the
 * acceptance time). A watch row is opened if the print has none (state
 * `ended` once its window is over, so the tick does not resume polling).
 */
export async function lookAgainLate(
  db: Database.Database,
  eventId: number,
  nowMs: number,
  seams: LatePollSeams,
): Promise<LookAgainResult> {
  const state = getEventState(db, eventId);
  if (state?.pollState === "cancelled") return { ok: false, reason: "disarmed" };
  if (state?.pollState !== "past_cutoff") return { ok: false, reason: "not_past_cutoff" };
  const basis = watchBasis(db, eventId);
  if (!basis) return { ok: false, reason: "no_basis" };
  if (!getLateWatch(db, eventId)) {
    const ends = lateWindowEndsAt(basis.eventDate);
    openLateWatch(db, eventId, ends, nowMs >= Date.parse(ends) ? "ended" : "watching");
  }
  const res = await pollLateFiling(db, eventId, nowMs, seams, { manual: true });
  if (res.status === "found") {
    return { ok: true, data: { eventId, found: true, form: res.form, filingId: res.filingId } };
  }
  if (res.status === "none") return { ok: true, data: { eventId, found: false, form: null, filingId: null } };
  if (res.status === "sec_unreachable") return { ok: false, reason: "sec_unreachable" };
  return { ok: false, reason: res.reason === "foreign_filer" ? "foreign_filer" : "no_basis" };
}
