// SEC EDGAR adapter for the live print-watch subsystem (spec 2026-08-20
// §4.2, §9.1). No db access in this module.
//
// Acceptance-window selection (Codex #17 — no baseline lifecycle): a filing
// qualifies purely by its `acceptanceDateTime` falling inside the armed
// window. There is no "first snapshot establishes a baseline, then diff"
// step (unlike the throwaway scripts/spike-print-timestamp-harness.ts this
// module descends from) — that makes the adapter restart-safe: after a
// process restart `seenAccessions` is empty, but the time filter alone
// re-derives the same in-window set, so nothing is missed and nothing is
// double-reported beyond what a fresh seen-set naturally re-walks.
//
// Every SEC request carries the declared User-Agent (SEC fair-access
// policy). Request spacing/pacing across polls is the caller's job (Task 9's
// per-host spacer) — this module never sleeps.
//
// OUTBOUND HARDENING (fix wave, finding E): every one of the four call sites
// below goes through the shared `hardened-fetch.ts` — manual same-host
// redirects (max 2), a content-length precheck plus a streamed 2MB cap, and a
// content-type check. `res.json()` is never used: an unbounded parse of a
// remote body is exactly what the cap exists to prevent, so JSON is read
// through the capped reader and parsed here.
//
// SEEN-MARKING ORDER (fix wave, finding F): this module never adds to
// `seenAccessions`. It reads the set for dedupe and returns what it found; the
// WATCHER marks an accession seen once it has actually ingested the filing's
// exhibits. Marking here meant a poll the watcher had abandoned on its source
// timeout could still mutate the set from under it and retire a filing that
// was never ingested.
//
// ACCEPTANCE-TIME QUIRK — the submissions JSON's `acceptanceDateTime` is
// UNRELIABLE and must never decide the window alone (root-caused 2026-09-02;
// corrected the same evening after spot-checking several filers live). It is
// NOT one consistent quirk: a FRESH same-day filing carries its
// America/New_York WALL-CLOCK value with a trailing `Z` that lies about the
// zone — today's Snowflake 8-K gave JSON `acceptanceDateTime:
// "2026-09-02T16:08:29.000Z"` against that SAME filing's own
// `-index-headers.html`, `<ACCEPTANCE-DATETIME>20260902160829` (EDGAR SGML
// headers are Eastern by definition — identical digits prove the JSON's `Z`
// is bogus). But an OLDER filing gets normalized by SEC to genuine UTC by the
// time it's polled: Dell's 2026-09-01 8-K read JSON
// `"2026-09-01T20:10:14.000Z"` against the SAME header
// `<ACCEPTANCE-DATETIME>20260901161014` (16:10:14 ET, matching the index
// page's own "Accepted" stamp) — four hours apart from a literal reading.
// Zscaler's recurring 8-Ks show the same drift across seasons (`20:08Z` in
// summer vs `21:07Z` in winter for the same ~16:05 ET print). Parsing the
// JSON as Eastern-only misses every already-normalized filing; parsing it as
// literal UTC reproduces the original Snowflake miss.
//
// The only source that is ALWAYS Eastern wall-clock, unconditionally, is the
// filing's own `-index-headers.html` `<ACCEPTANCE-DATETIME>YYYYMMDDHHMMSS`
// (EDGAR SGML header convention) — `pollEdgar` already fetches that page for
// every candidate to get its EX-99 exhibit list. So the JSON is used ONLY as
// a cheap, no-fetch PREFILTER (a filing survives if EITHER the literal-UTC
// reading via `Date.parse` OR the Eastern-wall-clock reading via
// `parseEdgarAcceptanceDateTime` lands in the armed window); the header's
// `<ACCEPTANCE-DATETIME>` — always parsed as Eastern via
// `parseEdgarAcceptanceDateTime` — is the value that actually decides
// inclusion and becomes the reported `acceptanceDateTime`. NEVER trust the
// JSON reading alone for the window decision, and NEVER let `pollEdgar`
// admit a filing without checking the header (falling back to the JSON only
// when the header field itself is missing or unparseable).

import {
  hardenedFetchJson,
  hardenedFetchText,
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_MARKUP,
  type FetchLike,
} from "./hardened-fetch";

export type { FetchLike };

const SEC_USER_AGENT = "PortfolioDesk contact@myportfoliodesk.com";
const SEC_WWW_HOST = "www.sec.gov";
const SEC_DATA_HOST = "data.sec.gov";

/**
 * The two SEC machine directories (`company_tickers.json`, a filer's
 * `submissions/CIK…json`) are legitimately far larger than a press release —
 * the ticker map alone is over a megabyte and grows with every new listing.
 * They get their own ceiling so the shared 2MB document cap (right for an
 * article page or an EX-99 exhibit) can never silently take EDGAR coverage
 * offline the night it is needed. Still bounded, still streamed.
 */
const SEC_DIRECTORY_MAX_BYTES = 16 * 1024 * 1024;

/** How far before `windowStartIso` a filing may still qualify. Companies do
 *  print early (project wire-time notes record XMTR hitting ~07:05 against
 *  an 08:00 expectation), and the SEC's own acceptance timestamp can lag the
 *  wire by minutes — a hard cutoff at the arm instant would miss those. */
const WINDOW_LOOKBACK_MS = 15 * 60 * 1000;

const QUALIFYING_FORMS = new Set(["8-K", "6-K"]);

const EDGAR_TIME_ZONE = "America/New_York";

/** Formats a UTC instant's wall-clock reading in America/New_York, reused by
 *  `parseEdgarAcceptanceDateTime` to resolve the correct EDT/EST offset for a
 *  given calendar date without a timezone dependency. */
const EDGAR_TZ_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EDGAR_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * For a UTC instant, returns how far ahead of UTC the America/New_York wall
 * clock reads at that instant, in ms (negative: -4h during EDT, -5h during
 * EST). Used to convert a wall-clock reading back to a true UTC instant.
 */
function newYorkOffsetMsAt(utcMs: number): number {
  const parts = EDGAR_TZ_FORMATTER.formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return localAsUtcMs - utcMs;
}

const EDGAR_ACCEPTANCE_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z?$/;

/**
 * Parses an EDGAR `acceptanceDateTime` value as an America/New_York
 * wall-clock timestamp (see the "ACCEPTANCE-TIME QUIRK" note at the top of
 * this file — the field's trailing `Z` does not mean UTC) and returns the
 * true UTC instant in ms since epoch. Accepts `YYYY-MM-DDTHH:MM:SS`,
 * optionally with `.sss` and/or a trailing `Z` (ignored either way). Returns
 * `NaN` for unparseable input.
 *
 * Method: read the wall-clock fields literally into a UTC-ms number (treating
 * them as if they were already UTC — a placeholder, not the answer), then use
 * that placeholder to look up what America/New_York's offset from UTC is on
 * that calendar date (DST makes this -4h in summer, -5h in winter) and
 * subtract it to land on the real UTC instant. A second lookup at the
 * corrected instant re-derives the offset and re-applies it, so a wall-clock
 * reading that falls right at a DST transition boundary still resolves using
 * the offset that actually applies to it rather than the placeholder's.
 */
export function parseEdgarAcceptanceDateTime(raw: string): number {
  const m = EDGAR_ACCEPTANCE_RE.exec(raw);
  if (!m) return NaN;
  const [, year, month, day, hour, minute, second, frac] = m;
  const ms = frac ? Math.round(Number(frac) * 1000) : 0;

  const wallAsUtcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    ms,
  );

  const offset1 = newYorkOffsetMsAt(wallAsUtcMs);
  const instant1 = wallAsUtcMs - offset1;

  // Iterate once more: the offset that applies AT the resolved instant can
  // differ from the offset guessed from the placeholder when the wall-clock
  // reading sits near a DST transition.
  const offset2 = newYorkOffsetMsAt(instant1);
  return offset2 === offset1 ? instant1 : wallAsUtcMs - offset2;
}

export interface EdgarFiling {
  accession: string;
  form: string;
  /** True-UTC ISO instant (`new Date(ms).toISOString()`), resolved from the
   *  filing's authoritative `-index-headers.html` acceptance time — see the
   *  "ACCEPTANCE-TIME QUIRK" note above. Never the raw submissions-JSON
   *  value, which cannot be trusted alone. */
  acceptanceDateTime: string;
  exhibits: Array<{ name: string; url: string; html: string }>;
}

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/**
 * Resolve a ticker symbol to its SEC CIK, zero-padded to 10 digits, via
 * `company_tickers.json`. Returns null when the symbol isn't found — never
 * guesses.
 */
export async function resolveCik(symbol: string, fetchFn: FetchLike = fetch): Promise<string | null> {
  const json = await hardenedFetchJson<Record<string, CompanyTickerEntry>>(
    "https://www.sec.gov/files/company_tickers.json",
    fetchFn,
    {
      host: SEC_WWW_HOST,
      label: "EDGAR company_tickers.json",
      contentType: CONTENT_TYPE_JSON,
      headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
      maxBytes: SEC_DIRECTORY_MAX_BYTES,
    },
  );

  const target = symbol.toUpperCase();
  for (const entry of Object.values(json)) {
    if (entry.ticker.toUpperCase() === target) {
      return String(entry.cik_str).padStart(10, "0");
    }
  }
  return null;
}

interface SubmissionsRecent {
  form: string[];
  acceptanceDateTime: string[];
  accessionNumber: string[];
}

async function fetchSubmissions(cik: string, fetchFn: FetchLike): Promise<SubmissionsRecent> {
  const json = await hardenedFetchJson<{ filings: { recent: Record<string, unknown[]> } }>(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
    fetchFn,
    {
      host: SEC_DATA_HOST,
      label: "EDGAR submissions",
      contentType: CONTENT_TYPE_JSON,
      headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
      maxBytes: SEC_DIRECTORY_MAX_BYTES,
    },
  );
  const r = json.filings.recent;
  return {
    form: r.form as string[],
    acceptanceDateTime: r.acceptanceDateTime as string[],
    accessionNumber: r.accessionNumber as string[],
  };
}

const EDGAR_HEADER_ACCEPTANCE_RE = /&lt;ACCEPTANCE-DATETIME&gt;\s*(\d{14})/;

interface FilingHeader {
  exhibits: Array<{ filename: string; url: string }>;
  /** True-UTC ms resolved from the header's Eastern `<ACCEPTANCE-DATETIME>`,
   *  or null when the field is missing or unparseable. */
  acceptanceMs: number | null;
}

/**
 * Fetch a filing's SGML header (`{accession}-index-headers.html`) ONCE and
 * pull both pieces of information it carries: the EX-99.* exhibit list (the
 * header has HTML-escaped `<TYPE>`/`<FILENAME>` pairs; the plain
 * `index.json` for a filing does NOT expose exhibit types, so it can't be
 * used for this selection) and the header's own
 * `<ACCEPTANCE-DATETIME>YYYYMMDDHHMMSS` field, which — unlike the submissions
 * JSON — is ALWAYS Eastern wall-clock (see the "ACCEPTANCE-TIME QUIRK" note
 * at the top of this file). That field is the authoritative answer to
 * "is this filing actually in the armed window".
 */
async function fetchFilingHeader(
  cik: string,
  accession: string,
  fetchFn: FetchLike,
): Promise<FilingHeader> {
  const cikNum = String(Number(cik));
  const accNoDash = accession.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}`;
  const html = await hardenedFetchText(`${base}/${accession}-index-headers.html`, fetchFn, {
    host: SEC_WWW_HOST,
    label: "EDGAR index-headers",
    contentType: CONTENT_TYPE_MARKUP,
    headers: { "User-Agent": SEC_USER_AGENT },
  });

  const exhibits: Array<{ filename: string; url: string }> = [];
  const exhibitRe = /&lt;TYPE&gt;([^\s<]+)[\s\S]*?&lt;FILENAME&gt;([^\s<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = exhibitRe.exec(html)) !== null) {
    const [, type, filename] = m;
    if (/^EX-99/i.test(type)) exhibits.push({ filename, url: `${base}/${filename}` });
  }

  const acceptMatch = EDGAR_HEADER_ACCEPTANCE_RE.exec(html);
  let acceptanceMs: number | null = null;
  if (acceptMatch) {
    const d = acceptMatch[1];
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
    const ms = parseEdgarAcceptanceDateTime(iso);
    acceptanceMs = Number.isNaN(ms) ? null : ms;
  }

  return { exhibits, acceptanceMs };
}

async function fetchExhibitHtml(url: string, fetchFn: FetchLike): Promise<string> {
  return hardenedFetchText(url, fetchFn, {
    host: SEC_WWW_HOST,
    label: "EDGAR exhibit",
    contentType: CONTENT_TYPE_MARKUP,
    headers: { "User-Agent": SEC_USER_AGENT },
  });
}

/**
 * Poll a CIK's submissions feed for new 8-K/6-K filings.
 *
 * The window decision is TWO-STAGE (see the "ACCEPTANCE-TIME QUIRK" note
 * above):
 *   1. Cheap prefilter, no fetch — a filing survives only if EITHER reading
 *      of the submissions JSON's `acceptanceDateTime` (literal UTC via
 *      `Date.parse`, or Eastern wall-clock via `parseEdgarAcceptanceDateTime`)
 *      lands in `[windowStartIso - 15min, windowEndIso]`.
 *   2. Authoritative check — for survivors, fetch the filing's own
 *      `-index-headers.html` ONCE (it also yields the EX-99 exhibit list) and
 *      trust its `<ACCEPTANCE-DATETIME>` (always Eastern) over the JSON.
 *      Outside the window there → skip without ever fetching an exhibit.
 *      Missing/unparseable header → fall back to whichever JSON reading
 *      passed stage 1.
 *
 * `seenAccessions` is READ ONLY here (finding F): an accession already in the
 * set is skipped, but nothing is ever added. The caller — which owns the set,
 * one per watcher run — marks an accession seen once it has consumed the
 * filing, so a poll abandoned mid-flight (the watcher's source timeout) cannot
 * retire a filing that never reached the pipeline.
 *
 * NO signature change for cancellation (Task 4 of live-print v2 slice C): the
 * caller passes an already signal-carrying `fetchFn` (its throttled fetch),
 * so every request this module makes is abortable through that. The one
 * thing this module still owns is the per-filing `try/catch` — its rethrow
 * of an `AbortError` (rather than swallowing it into `continue`, as an
 * ordinary filing failure) is what makes an abort reject the WHOLE poll
 * instead of quietly returning a partial "ok" result.
 */
export async function pollEdgar(
  cik: string,
  windowStartIso: string,
  windowEndIso: string,
  seenAccessions: Set<string>,
  fetchFn: FetchLike = fetch,
): Promise<EdgarFiling[]> {
  const windowStartMs = Date.parse(windowStartIso) - WINDOW_LOOKBACK_MS;
  const windowEndMs = Date.parse(windowEndIso);
  const inWindow = (ms: number) => !Number.isNaN(ms) && ms >= windowStartMs && ms <= windowEndMs;

  const recent = await fetchSubmissions(cik, fetchFn);
  const n = recent.accessionNumber.length;
  const out: EdgarFiling[] = [];

  for (let i = 0; i < n; i += 1) {
    const form = recent.form[i];
    if (!QUALIFYING_FORMS.has(form)) continue;

    const accession = recent.accessionNumber[i];
    if (seenAccessions.has(accession)) continue;

    const rawAcceptance = recent.acceptanceDateTime[i];
    const asUtcMs = Date.parse(rawAcceptance);
    const asEtMs = parseEdgarAcceptanceDateTime(rawAcceptance);
    const utcInWindow = inWindow(asUtcMs);
    const etInWindow = inWindow(asEtMs);
    if (!utcInWindow && !etInWindow) continue;

    // A filing is only added to the result once its exhibits are FULLY
    // fetched. A transient failure on one filing's walk must neither poison
    // the other filings collected in this same poll (we don't throw out of
    // the loop) nor permanently drop the failed filing (it is never
    // reported, so the next poll retries it whole).
    try {
      const header = await fetchFilingHeader(cik, accession, fetchFn);

      let acceptedMs: number;
      if (header.acceptanceMs !== null) {
        // Authoritative: the header settles it, even if that contradicts a
        // JSON reading that happened to land in-window.
        if (!inWindow(header.acceptanceMs)) continue;
        acceptedMs = header.acceptanceMs;
      } else {
        // Header field missing/unparseable: fall back to whichever JSON
        // reading passed the prefilter. Prefer the Eastern reading when both
        // somehow passed — the JSON's real failure mode is being mislabeled
        // Eastern, not literal UTC.
        acceptedMs = etInWindow ? asEtMs : asUtcMs;
      }

      const exhibits: Array<{ name: string; url: string; html: string }> = [];
      for (const ex of header.exhibits) {
        const html = await fetchExhibitHtml(ex.url, fetchFn);
        exhibits.push({ name: ex.filename, url: ex.url, html });
      }
      out.push({
        accession,
        form,
        acceptanceDateTime: new Date(acceptedMs).toISOString(),
        exhibits,
      });
    } catch (err) {
      // A cancellation must never be counted as an ordinary filing failure —
      // that would let the poll settle "ok — N filing(s)" while silently
      // dropping whatever was in flight when the caller gave up. Rethrow so
      // the whole poll rejects instead (Task 4 amendment, Codex #10).
      if (err instanceof Error && err.name === "AbortError") throw err;
      // Left unreported on purpose — retried whole on the next poll.
      continue;
    }
  }

  return out;
}
