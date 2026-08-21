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

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SEC_USER_AGENT = "PortfolioDesk contact@myportfoliodesk.com";

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
  const res = await fetchFn("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`EDGAR company_tickers.json HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, CompanyTickerEntry>;

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
  const res = await fetchFn(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`EDGAR submissions HTTP ${res.status}`);
  const json = (await res.json()) as { filings: { recent: Record<string, unknown[]> } };
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
  const res = await fetchFn(`${base}/${accession}-index-headers.html`, {
    headers: { "User-Agent": SEC_USER_AGENT },
  });
  if (!res.ok) throw new Error(`EDGAR index-headers HTTP ${res.status}`);
  const html = await res.text();

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
  const res = await fetchFn(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) throw new Error(`EDGAR exhibit HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Poll a CIK's submissions feed for new 8-K/6-K filings whose acceptance
 * timestamp falls in `[windowStartIso - 15min, windowEndIso]`, fetching
 * every EX-99.* exhibit for each qualifying filing.
 *
 * `seenAccessions` is mutated in place: every accession this call reports is
 * added before returning, so a repeat poll against identical underlying
 * data returns nothing new. It is meant to be owned by the caller (one Set
 * per watcher run) and re-used across polls of the same print.
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

    // A filing is only marked seen — and only added to the result — once its
    // exhibits are FULLY fetched. A transient failure on one filing's
    // exhibit walk must neither poison the other filings collected in this
    // same poll (we don't throw out of the loop) nor permanently drop the
    // failed filing (we don't mark it seen, so the next poll retries it).
    try {
      const exhibitList = await fetchExhibitList(cik, accession, fetchFn);
      const exhibits: Array<{ name: string; url: string; html: string }> = [];
      for (const ex of exhibitList) {
        const html = await fetchExhibitHtml(ex.url, fetchFn);
        exhibits.push({ name: ex.filename, url: ex.url, html });
      }
      seenAccessions.add(accession);
      out.push({ accession, form, acceptanceDateTime, exhibits });
    } catch {
      // Left un-seen on purpose — retried whole on the next poll.
      continue;
    }
  }

  return out;
}
