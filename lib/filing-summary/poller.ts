/**
 * The armed-print filing poll (spec §4, R11, R12, "Late arms", Hardening 1
 * and 10). One call = one look at EDGAR for one armed earnings event.
 *
 * LIFECYCLE (all on the Eastern clock, per event):
 *  - The state row is created on first sight. A print ARMED at or after 20:00
 *    on its date, or armed on a later day, becomes `manual_only`: nothing is
 *    polled or run on its own (late-arm ruling). The arm time is the worksheet
 *    flag's `created_at`, so a print armed at 15:00 whose first tick only came
 *    at 21:30 (app asleep) still gets its catch-up pass (Hardening 10).
 *  - Before 06:00 on the event date: no work.
 *  - 06:00 to 20:00: poll. A submissions (or CIK) fetch failure is
 *    `sec_unreachable`, retried next tick, never "no filing".
 *  - First tick at or after 20:00 with `catchup_done = 0`: one more poll, then
 *    `past_cutoff` and `catchup_done = 1`. A catch-up that could not finish
 *    (SEC down, a header that would not load) leaves `catchup_done = 0` and is
 *    retried on the next tick.
 *
 * WHAT COUNTS (R11, controller rulings 1-3): a filing counts only on its
 * header's `<ACCEPTANCE-DATETIME>` (Eastern). A header day other than the
 * event date is ignored entirely. On the event date, after 20:00:00, the
 * filing is still inserted so the panel can list it, as `rejected` /
 * "accepted after 8 pm", and is never run. A header without the field is
 * inserted as `time_unconfirmed` and never run automatically.
 *
 * The earnings filing (the first 8-K with Item 2.02, or a foreign filer's
 * first 6-K with an EX-99) must pass print-watch's document gate on its EX-99
 * text (the main document when there is no EX-99) with the issuer name;
 * otherwise it is `ambiguous` with the gate's reason and nothing runs. A
 * companion is an allow-listed filing accepted after the earnings filing; a
 * foreign filer's 6-K/A counts as one (ruling 3).
 *
 * Every document of an inserted filing is fetched on the scheduler's
 * low-priority SEC lane (the caller's `fetchFn`), written to disk with its
 * SHA-256 and recorded `fetched` / `skipped` / `failed`. The filing is
 * `fetched` when every non-skipped document was, else `failed` (it is still
 * summarised; coverage marks it incomplete).
 *
 * WHY NOT `readDayFilings`: it re-fetches every day filing's header on every
 * call. At one poll a minute that is one SEC request per filing per minute,
 * Form 4s included. This module reads the submissions list itself (one
 * request), drops forms that can never matter BEFORE any header fetch, and
 * keeps parsed headers per accession in process memory (ruling 4). A failed
 * header fetch is never cached. The prefilter is the same two-reading rule.
 */
import type Database from "better-sqlite3";
import { parseDbTimestamp, todayET } from "@/lib/calendar/date-utils";
import {
  fetchSubmissionsRecent,
  parseEdgarAcceptanceDateTime,
  SEC_USER_AGENT,
} from "@/lib/print-watch/edgar-adapter";
import { validateDocForEvent } from "@/lib/print-watch/gate";
import {
  CONTENT_TYPE_MARKUP,
  hardenedFetchText,
  type FetchLike,
} from "@/lib/print-watch/hardened-fetch";
import { htmlToRawText } from "@/lib/print-watch/representations";
import {
  classifyFiling,
  fetchFilingDocument,
  inferFilerKind,
  OVER_DOCUMENT_CAP_REASON,
  parseFilingHeader,
  shouldSkipDocument,
  type FilerKind,
  type FilingClass,
  type FilingHeader,
} from "./edgar";
import { writeFilingDocument } from "./files";
import { secArchiveUrl } from "./locate";
import {
  getEventState,
  insertFiling,
  listFilings,
  upsertDocument,
  upsertEventState,
  type DocumentStatus,
  type EventStateRow,
  type FetchState,
  type FilingRole,
  type FilingRow,
  type IdentityVerdict,
  type PollState,
} from "./store";

export type { FetchLike };

// ---------------------------------------------------------------- constants

/** Poll window on the event date, Eastern wall clock (R12). */
export const POLL_START_ET = "06:00:00";
/** The companion cutoff (R11), inclusive: a filing at 20:00:00 counts. */
export const CUTOFF_ET = "20:00:00";

export const MANUAL_ONLY_DETAIL = "armed after 8 pm — Run summary to spend";
export const AFTER_CUTOFF_REASON = "accepted after 8 pm";
export const NO_ACCEPTANCE_REASON = "header has no acceptance time";
export const SEC_UNREACHABLE_DETAIL = "SEC unreachable — retrying every minute";
/** How long a "no CIK" answer is trusted before the ticker list is asked again. */
export const NO_CIK_RETRY_MS = 60 * 60_000;
/** Upper bound on cached headers (oldest dropped first). */
const HEADER_CACHE_MAX = 2_000;

// ---------------------------------------------------------------- seams

export interface PollSeams {
  /** The scheduler's low-priority SEC fetch (production) or a fake (tests). */
  fetchFn: FetchLike;
  resolveCik(symbol: string, fetchFn: FetchLike): Promise<string | null>;
  now(): number;
  issuerName(db: Database.Database, symbol: string): string | null;
  /** A newly inserted earnings filing passed the identity gate. */
  onEarningsAccepted(db: Database.Database, eventId: number): void;
  /** A newly inserted companion, accepted after an accepted earnings filing. */
  onCompanionAccepted(db: Database.Database, eventId: number, filingId: number): void;
  /** Storage root for documents; defaults to `resolveDbDir()`. */
  storageRoot?: () => string;
}

export type PollAction =
  /** Nothing to do this tick (before 06:00, terminal state, unknown event…). */
  | "skipped"
  /** Late arm: the row was set to `manual_only`. */
  | "manual_only"
  /** SEC was asked and the result recorded. */
  | "polled"
  /** CIK or submissions fetch failed: `sec_unreachable` (or state kept). */
  | "sec_unreachable"
  /** The ticker has no SEC filer. */
  | "no_cik";

export interface PollOutcome {
  action: PollAction;
  pollState: PollState | null;
  /** Filing rows this call inserted, in insertion order. */
  insertedFilingIds: number[];
}

// ---------------------------------------------------------------- Eastern clock

const ET_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The instant's Eastern date (`YYYY-MM-DD`) and wall time (`HH:MM:SS`). */
export function easternClock(ms: number): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of ET_CLOCK.formatToParts(new Date(ms))) p[part.type] = part.value;
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}:${p.second}` };
}

export type PollPhase = "before_window" | "in_window" | "after_cutoff";

/** Where an instant falls relative to the event date's 06:00-20:00 window. */
export function pollPhase(eventDate: string, ms: number): PollPhase {
  const { date, time } = easternClock(ms);
  if (date < eventDate) return "before_window";
  if (date > eventDate) return "after_cutoff";
  if (time < POLL_START_ET) return "before_window";
  if (time >= CUTOFF_ET) return "after_cutoff";
  return "in_window";
}

// ---------------------------------------------------------------- header cache

const headerCache = new Map<string, FilingHeader>();

export function __resetPollerCacheForTests(): void {
  headerCache.clear();
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** The parsed header, from memory or EDGAR; null when the fetch failed (not cached). */
async function headerFor(
  cik: string,
  accession: string,
  fetchFn: FetchLike,
): Promise<FilingHeader | null> {
  const key = `${cik}:${accession}`;
  const hit = headerCache.get(key);
  if (hit) return hit;
  let url: string;
  try {
    url = secArchiveUrl(cik, accession, `${accession}-index-headers.html`);
  } catch {
    return null;
  }
  try {
    const html = await hardenedFetchText(url, fetchFn, {
      host: "www.sec.gov",
      label: "EDGAR index-headers",
      contentType: CONTENT_TYPE_MARKUP,
      headers: { "User-Agent": SEC_USER_AGENT },
    });
    const header = parseFilingHeader(html);
    if (headerCache.size >= HEADER_CACHE_MAX) {
      const oldest = headerCache.keys().next().value;
      if (oldest !== undefined) headerCache.delete(oldest);
    }
    headerCache.set(key, header);
    return header;
  } catch (err) {
    if (isAbort(err)) throw err;
    return null;
  }
}

// ---------------------------------------------------------------- classification

function normalizeForm(form: string): string {
  return form.trim().toUpperCase().replace(/\s+/g, " ");
}

/** `classifyFiling`, plus ruling 3: a foreign filer's 6-K/A is a companion. */
function classOf(form: string, header: FilingHeader | null, filerKind: FilerKind): FilingClass {
  if (filerKind === "foreign" && normalizeForm(form) === "6-K/A") return "companion";
  return classifyFiling(form, header?.items ?? [], header?.documents ?? [], filerKind);
}

function onEasternDay(ms: number, eventDate: string): boolean {
  return Number.isFinite(ms) && todayET(new Date(ms)) === eventDate;
}

// ---------------------------------------------------------------- documents

/** Short, content-free reasons (ruling 5): never the raw error text. */
function documentFailureReason(reason: string): string {
  if (/unexpected content-type/i.test(reason)) return "not a text document";
  const http = /HTTP (\d{3})/.exec(reason);
  if (http) return `HTTP ${http[1]}`;
  if (/not a plain file name/i.test(reason)) return "not a plain file name";
  if (/redirect/i.test(reason)) return "redirect refused";
  if (/timed? ?out|timeout/i.test(reason)) return "timed out";
  return "fetch failed";
}

interface PreparedDocument {
  fileName: string;
  docType: string;
  sequence: number;
  status: DocumentStatus;
  skipReason: string | null;
  sha256: string | null;
  byteLen: number | null;
  storedPath: string | null;
}

interface FetchedFiling {
  documents: PreparedDocument[];
  fetchState: FetchState;
  /** Text the identity gate reads: every EX-99*, else the main document. */
  gateText: string | null;
}

async function fetchDocuments(
  cik: string,
  accession: string,
  form: string,
  header: FilingHeader,
  fetchFn: FetchLike,
  storageRoot: string | undefined,
): Promise<FetchedFiling> {
  const documents: PreparedDocument[] = [];
  const exhibitTexts: string[] = [];
  const mainForm = normalizeForm(form);
  let mainText: { seq: number; isForm: boolean; text: string } | null = null;
  let toFetch = 0;
  let fetched = 0;

  for (const d of header.documents) {
    const base = { fileName: d.fileName, docType: d.type, sequence: d.sequence };
    const skip = shouldSkipDocument(d.type, d.fileName);
    if (skip) {
      documents.push({ ...base, status: "skipped", skipReason: skip, sha256: null, byteLen: null, storedPath: null });
      continue;
    }
    toFetch += 1;
    const res = await fetchFilingDocument(cik, accession, d.fileName, fetchFn);
    if (!res.ok) {
      if (res.reason === OVER_DOCUMENT_CAP_REASON) {
        toFetch -= 1;
        documents.push({ ...base, status: "skipped", skipReason: OVER_DOCUMENT_CAP_REASON, sha256: null, byteLen: null, storedPath: null });
      } else {
        documents.push({ ...base, status: "failed", skipReason: documentFailureReason(res.reason), sha256: null, byteLen: null, storedPath: null });
      }
      continue;
    }
    let written;
    try {
      written = writeFilingDocument(cik, accession, d.fileName, res.html, storageRoot);
    } catch {
      documents.push({ ...base, status: "failed", skipReason: "could not be stored", sha256: null, byteLen: null, storedPath: null });
      continue;
    }
    fetched += 1;
    documents.push({
      ...base,
      status: "fetched",
      skipReason: null,
      sha256: written.sha256,
      byteLen: written.bytes,
      storedPath: written.path,
    });
    const type = d.type.trim().toUpperCase();
    if (/^EX-99/.test(type)) {
      exhibitTexts.push(htmlToRawText(res.html));
    } else {
      const isForm = type === mainForm;
      if (!mainText || (isForm && !mainText.isForm) || (isForm === mainText.isForm && d.sequence < mainText.seq)) {
        mainText = { seq: d.sequence, isForm, text: htmlToRawText(res.html) };
      }
    }
  }

  const gateText = exhibitTexts.length > 0 ? exhibitTexts.join("\n") : (mainText?.text ?? null);
  const fetchState: FetchState = fetched === toFetch ? "fetched" : "failed";
  return { documents, fetchState, gateText };
}

// ---------------------------------------------------------------- the poll

interface EventRow {
  symbol: string | null;
  event_date: string;
  armed_at: string | null;
}

interface Candidate {
  accession: string;
  form: string;
  header: FilingHeader;
  cls: Exclude<FilingClass, "ignored">;
  /** Null = the header had no acceptance time. */
  acceptanceMs: number | null;
  afterCutoff: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function result(action: PollAction, state: PollState | null, ids: number[] = []): PollOutcome {
  return { action, pollState: state, insertedFilingIds: ids };
}

function acceptedMs(f: FilingRow): number | null {
  if (!f.acceptedAt) return null;
  const ms = Date.parse(f.acceptedAt);
  return Number.isNaN(ms) ? null : ms;
}

/** The event's earnings filing: the earnings-role row that passed or failed the
 *  identity gate (an after-8-pm or time-unconfirmed row is not it). */
function earningsReference(filings: FilingRow[]): FilingRow | null {
  return (
    filings.find(
      (f) => f.role === "earnings" && (f.identityVerdict === "accepted" || f.identityVerdict === "ambiguous"),
    ) ?? null
  );
}

function callSafely(label: string, eventId: number, fn: () => void): void {
  try {
    fn();
  } catch {
    // Ids only: an error from the runner can quote filing text.
    console.warn(`[filing-summary] ${label} failed for event ${eventId}`);
  }
}

/**
 * One poll of one armed earnings event. Never throws for an SEC failure (that
 * is recorded as `sec_unreachable`); rethrows an abort.
 */
export async function pollEvent(
  db: Database.Database,
  eventId: number,
  nowMs: number,
  seams: PollSeams,
): Promise<PollOutcome> {
  const ev = db
    .prepare(
      `SELECT ce.symbol, ce.event_date, f.created_at AS armed_at
         FROM calendar_events ce
         LEFT JOIN earnings_worksheet_flags f ON f.event_id = ce.id
        WHERE ce.id = ?`,
    )
    .get(eventId) as EventRow | undefined;
  if (!ev || !ev.symbol) return result("skipped", null);
  const symbol = ev.symbol;
  const eventDate = ev.event_date;

  // ---- first sight / late arm
  let state: EventStateRow | null = getEventState(db, eventId);
  const neverPolled =
    !state || (state.lastPolledAt === null && state.pollState === "waiting" && !state.catchupDone);
  if (neverPolled) {
    const armedAtMs = ev.armed_at ? (parseDbTimestamp(ev.armed_at)?.getTime() ?? nowMs) : nowMs;
    if (pollPhase(eventDate, armedAtMs) === "after_cutoff") {
      upsertEventState(db, eventId, {
        pollState: "manual_only",
        pollDetail: MANUAL_ONLY_DETAIL,
        catchupDone: true,
      });
      return result("manual_only", "manual_only");
    }
    if (!state) {
      upsertEventState(db, eventId, {});
      state = getEventState(db, eventId);
    }
  }
  if (!state) return result("skipped", null);
  const current: EventStateRow = state;
  if (state.pollState === "manual_only" || state.pollState === "cancelled" || state.catchupDone) {
    return result("skipped", state.pollState);
  }

  const phase = pollPhase(eventDate, nowMs);
  if (phase === "before_window") return result("skipped", state.pollState);
  const catchup = phase === "after_cutoff";

  if (state.pollState === "no_cik" && !catchup && state.lastPolledAt) {
    const last = Date.parse(state.lastPolledAt);
    if (!Number.isNaN(last) && nowMs - last < NO_CIK_RETRY_MS) return result("skipped", "no_cik");
  }

  // State to fall back on when SEC cannot be reached: an earnings filing
  // already found keeps its state; otherwise the panel says SEC unreachable.
  const unreachable = (): PollOutcome => {
    const ref = earningsReference(listFilings(db, eventId));
    if (ref) return result("sec_unreachable", current.pollState);
    upsertEventState(db, eventId, {
      pollState: "sec_unreachable",
      pollDetail: SEC_UNREACHABLE_DETAIL,
      lastPolledAt: iso(nowMs),
    });
    return result("sec_unreachable", "sec_unreachable");
  };

  // ---- CIK
  let cik = state.cik;
  if (!cik) {
    try {
      cik = await seams.resolveCik(symbol, seams.fetchFn);
    } catch (err) {
      if (isAbort(err)) throw err;
      return unreachable();
    }
    if (!cik) {
      upsertEventState(db, eventId, {
        pollState: "no_cik",
        pollDetail: `no SEC filer found for ${symbol}`,
        lastPolledAt: iso(nowMs),
        catchupDone: catchup,
      });
      return result("no_cik", "no_cik");
    }
    upsertEventState(db, eventId, { cik });
  }
  const filerCik: string = cik;

  // ---- submissions list (one request)
  let recent;
  try {
    recent = await fetchSubmissionsRecent(filerCik, seams.fetchFn);
  } catch (err) {
    if (isAbort(err)) throw err;
    return unreachable();
  }
  const filerKind = inferFilerKind(recent.form);
  const formName = filerKind === "foreign" ? "6-K" : "8-K";

  // ---- candidates: prefilter, form filter, header (cached), header day
  const existing = new Map(listFilings(db, eventId).map((f) => [f.accession, f]));
  const candidates: Candidate[] = [];
  let headerFailures = 0;
  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const raw = recent.acceptanceDateTime[i];
    if (!onEasternDay(Date.parse(raw), eventDate) && !onEasternDay(parseEdgarAcceptanceDateTime(raw), eventDate)) {
      continue;
    }
    const accession = recent.accessionNumber[i];
    const form = recent.form[i];
    if (existing.has(accession)) continue;
    // Forms that can never be earnings or a companion need no header.
    if (classOf(form, null, filerKind) === "ignored") continue;
    const header = await headerFor(filerCik, accession, seams.fetchFn);
    if (!header) {
      headerFailures += 1;
      continue;
    }
    const cls = classOf(form, header, filerKind);
    if (cls === "ignored") continue;
    if (header.acceptanceMs === null) {
      candidates.push({ accession, form, header, cls, acceptanceMs: null, afterCutoff: false });
      continue;
    }
    const clock = easternClock(header.acceptanceMs);
    if (clock.date !== eventDate) continue; // ruling 1: the header's day decides
    candidates.push({
      accession,
      form,
      header,
      cls,
      acceptanceMs: header.acceptanceMs,
      afterCutoff: clock.time > CUTOFF_ET,
    });
  }

  // Acceptance order; unconfirmed times last (discovery order is the run order).
  candidates.sort((a, b) => (a.acceptanceMs ?? Infinity) - (b.acceptanceMs ?? Infinity));

  const inserted: number[] = [];
  let deferred = false;
  let reference = earningsReference([...existing.values()]);

  const insert = async (
    c: Candidate,
    role: FilingRole,
    verdict: IdentityVerdict | "gate",
    reason: string | null,
  ): Promise<FilingRow | null> => {
    const fetched = await fetchDocuments(filerCik, c.accession, c.form, c.header, seams.fetchFn, seams.storageRoot?.());
    let identityVerdict: IdentityVerdict;
    let identityReason = reason;
    if (verdict === "gate") {
      if (fetched.gateText === null) {
        // Nothing readable to check the issuer and quarter against: a
        // transient fetch failure, retried next tick rather than guessed.
        deferred = true;
        return null;
      }
      const v = validateDocForEvent(fetched.gateText, {
        symbol,
        issuerName: seams.issuerName(db, symbol),
        eventDate,
      });
      identityVerdict = v.ok ? "accepted" : "ambiguous";
      identityReason = v.ok ? null : v.reason;
    } else {
      identityVerdict = verdict;
    }
    const res = db.transaction(() => {
      const r = insertFiling(db, {
        eventId,
        accession: c.accession,
        cik: filerCik,
        form: c.form,
        role,
        items: c.header.items.length > 0 ? c.header.items.join(",") : null,
        acceptedAt: c.acceptanceMs === null ? null : iso(c.acceptanceMs),
        discoveredAt: iso(seams.now()),
        identityVerdict,
        identityReason,
        fetchState: fetched.fetchState,
      });
      if (r.inserted) {
        for (const d of fetched.documents) upsertDocument(db, { filingId: r.id, ...d });
      }
      return r;
    })();
    if (!res.inserted) return null;
    inserted.push(res.id);
    return listFilings(db, eventId).find((f) => f.id === res.id) ?? null;
  };

  for (const c of candidates) {
    if (deferred) break;
    const isEarningsClass = c.cls === "earnings";
    const role: FilingRole = isEarningsClass && !reference ? "earnings" : "companion";

    if (c.acceptanceMs === null) {
      await insert(c, role, "time_unconfirmed", NO_ACCEPTANCE_REASON);
      continue;
    }
    if (c.afterCutoff) {
      await insert(c, role, "rejected", AFTER_CUTOFF_REASON);
      continue;
    }
    if (role === "earnings") {
      const row = await insert(c, "earnings", "gate", null);
      if (!row) continue;
      reference = row;
      if (row.identityVerdict === "accepted") {
        callSafely("onEarningsAccepted", eventId, () => seams.onEarningsAccepted(db, eventId));
      }
      continue;
    }
    // Companion: only after the earnings filing (strictly later acceptance).
    const refMs = reference ? acceptedMs(reference) : null;
    if (reference === null || refMs === null || c.acceptanceMs <= refMs) continue;
    const row = await insert(c, "companion", "accepted", null);
    if (row && reference.identityVerdict === "accepted") {
      callSafely("onCompanionAccepted", eventId, () => seams.onCompanionAccepted(db, eventId, row.id));
    }
  }

  // ---- event state from the stored filings
  const all = listFilings(db, eventId);
  const ref = earningsReference(all);
  const unconfirmed = all.find((f) => f.role === "earnings" && f.identityVerdict === "time_unconfirmed");
  let pollState: PollState;
  let pollDetail: string | null;
  if (ref?.identityVerdict === "accepted") {
    pollState = "found";
    pollDetail = null;
  } else if (ref) {
    pollState = "ambiguous";
    pollDetail = ref.identityReason;
  } else {
    pollState = "waiting";
    pollDetail = unconfirmed ? `earnings ${formName} time unconfirmed` : null;
  }

  const complete = headerFailures === 0 && !deferred;
  let catchupDone = false;
  if (catchup) {
    if (complete) {
      catchupDone = true;
      if (pollState !== "ambiguous") {
        pollDetail =
          pollState === "found"
            ? "polling ended at 8 pm"
            : unconfirmed
              ? `earnings ${formName} time unconfirmed — Run summary to spend`
              : `no earnings ${formName} filed by 8 pm`;
        pollState = "past_cutoff";
      }
    } else if (pollState === "waiting") {
      // The catch-up could not finish: never say "no filing" on a partial look.
      pollState = "sec_unreachable";
      pollDetail = SEC_UNREACHABLE_DETAIL;
    }
  }

  upsertEventState(db, eventId, {
    pollState,
    pollDetail,
    lastPolledAt: iso(nowMs),
    catchupDone,
  });
  return result("polled", pollState, inserted);
}
