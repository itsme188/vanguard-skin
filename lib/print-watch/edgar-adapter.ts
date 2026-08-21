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

export interface EdgarFiling {
  accession: string;
  form: string;
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

/**
 * Walk a filing's SGML header for its EX-99.* exhibits. The header
 * (`{accession}-index-headers.html`) carries HTML-escaped `<TYPE>`/
 * `<FILENAME>` pairs; the plain `index.json` for a filing does NOT expose
 * exhibit types, so it can't be used for this selection.
 */
async function fetchExhibitList(
  cik: string,
  accession: string,
  fetchFn: FetchLike,
): Promise<Array<{ filename: string; url: string }>> {
  const cikNum = String(Number(cik));
  const accNoDash = accession.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}`;
  const html = await hardenedFetchText(`${base}/${accession}-index-headers.html`, fetchFn, {
    host: SEC_WWW_HOST,
    label: "EDGAR index-headers",
    contentType: CONTENT_TYPE_MARKUP,
    headers: { "User-Agent": SEC_USER_AGENT },
  });

  const out: Array<{ filename: string; url: string }> = [];
  const re = /&lt;TYPE&gt;([^\s<]+)[\s\S]*?&lt;FILENAME&gt;([^\s<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, type, filename] = m;
    if (/^EX-99/i.test(type)) out.push({ filename, url: `${base}/${filename}` });
  }
  return out;
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
 * Poll a CIK's submissions feed for new 8-K/6-K filings whose acceptance
 * timestamp falls in `[windowStartIso - 15min, windowEndIso]`, fetching
 * every EX-99.* exhibit for each qualifying filing.
 *
 * `seenAccessions` is READ ONLY here (finding F): an accession already in the
 * set is skipped, but nothing is ever added. The caller — which owns the set,
 * one per watcher run — marks an accession seen once it has consumed the
 * filing, so a poll abandoned mid-flight (the watcher's source timeout) cannot
 * retire a filing that never reached the pipeline.
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

  const recent = await fetchSubmissions(cik, fetchFn);
  const n = recent.accessionNumber.length;
  const out: EdgarFiling[] = [];

  for (let i = 0; i < n; i += 1) {
    const form = recent.form[i];
    if (!QUALIFYING_FORMS.has(form)) continue;

    const accession = recent.accessionNumber[i];
    if (seenAccessions.has(accession)) continue;

    const acceptanceDateTime = recent.acceptanceDateTime[i];
    const acceptedMs = Date.parse(acceptanceDateTime);
    if (Number.isNaN(acceptedMs) || acceptedMs < windowStartMs || acceptedMs > windowEndMs) continue;

    // A filing is only added to the result once its exhibits are FULLY
    // fetched. A transient failure on one filing's exhibit walk must neither
    // poison the other filings collected in this same poll (we don't throw out
    // of the loop) nor permanently drop the failed filing (it is never
    // reported, so the next poll retries it whole).
    try {
      const exhibitList = await fetchExhibitList(cik, accession, fetchFn);
      const exhibits: Array<{ name: string; url: string; html: string }> = [];
      for (const ex of exhibitList) {
        const html = await fetchExhibitHtml(ex.url, fetchFn);
        exhibits.push({ name: ex.filename, url: ex.url, html });
      }
      out.push({ accession, form, acceptanceDateTime, exhibits });
    } catch {
      // Left unreported on purpose — retried whole on the next poll.
      continue;
    }
  }

  return out;
}
