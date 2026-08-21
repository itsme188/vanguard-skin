import { describe, it, expect } from "vitest";
import { resolveCik, pollEdgar, type EdgarFiling, type FetchLike } from "@/lib/print-watch/edgar-adapter";

const SEC_UA = "PortfolioDesk contact@myportfoliodesk.com";
const CIK = "0001045810";

interface Call {
  url: string;
  headers: Record<string, string>;
}

interface MockRoute {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Route table keyed by exact URL; each entry returns a canned response. */
function makeMockFetch(
  routes: Record<string, MockRoute>,
  calls: Call[] = [],
): { fetchFn: FetchLike; calls: Call[] } {
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    const route = routes[url];
    if (!route) throw new Error(`unmocked fetch: ${url}`);
    const status = route.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => route.json,
      text: async () => route.text ?? "",
    } as Response;
  };
  return { fetchFn, calls };
}

function companyTickersFixture() {
  return {
    "0": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
    "1": { cik_str: 1535527, ticker: "CRWD", title: "CrowdStrike Holdings, Inc." },
  };
}

/** SGML filing header, HTML-escaped as SEC serves it inside a <PRE> block. */
function indexHeadersFixture(exhibits: Array<{ type: string; filename: string }>): string {
  const blocks = exhibits
    .map(
      (e) =>
        `&lt;DOCUMENT&gt;\n&lt;TYPE&gt;${e.type}\n&lt;SEQUENCE&gt;2\n&lt;FILENAME&gt;${e.filename}\n&lt;DESCRIPTION&gt;Exhibit\n&lt;/DOCUMENT&gt;`,
    )
    .join("\n");
  return `&lt;SEC-DOCUMENT&gt;\n${blocks}\n&lt;/SEC-DOCUMENT&gt;`;
}

const WINDOW_START = "2026-08-26T20:20:00.000Z";
const WINDOW_END = "2026-08-26T21:00:00.000Z";

const OLD_8K_ACCESSION = "0001045810-26-000100";
const NEW_8K_ACCESSION = "0001045810-26-000123";
const NEW_6K_ACCESSION = "0001045810-26-000124";
const TENK_ACCESSION = "0001045810-26-000125";

function submissionsFixture() {
  return {
    filings: {
      recent: {
        form: ["8-K", "8-K", "6-K", "10-K"],
        // Effective window floor = WINDOW_START - 15min = 20:05:00Z.
        acceptanceDateTime: [
          "2026-08-26T19:00:00Z", // old 8-K, before the window floor
          "2026-08-26T20:22:00Z", // in-window 8-K
          "2026-08-26T20:25:00Z", // in-window 6-K
          "2026-08-26T20:30:00Z", // in-window but wrong form
        ],
        accessionNumber: [OLD_8K_ACCESSION, NEW_8K_ACCESSION, NEW_6K_ACCESSION, TENK_ACCESSION],
        primaryDocument: ["old8k.htm", "new8k.htm", "new6k.htm", "tenk.htm"],
      },
    },
  };
}

function baseUrl(accession: string): string {
  const accNoDash = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/1045810/${accNoDash}`;
}

function buildRoutes(): Record<string, MockRoute> {
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${CIK}.json`;
  const eightKBase = baseUrl(NEW_8K_ACCESSION);
  const sixKBase = baseUrl(NEW_6K_ACCESSION);

  return {
    [submissionsUrl]: { json: submissionsFixture() },
    [`${eightKBase}/${NEW_8K_ACCESSION}-index-headers.html`]: {
      text: indexHeadersFixture([
        { type: "EX-99.1", filename: "ex991.htm" },
        { type: "EX-99.2", filename: "ex992.htm" },
        { type: "EX-10.1", filename: "ex101.htm" }, // must NOT be picked up
      ]),
    },
    [`${eightKBase}/ex991.htm`]: { text: "<html>8-K press release body</html>" },
    [`${eightKBase}/ex992.htm`]: { text: "<html>8-K CFO commentary</html>" },
    [`${sixKBase}/${NEW_6K_ACCESSION}-index-headers.html`]: {
      text: indexHeadersFixture([{ type: "EX-99.1", filename: "ex991.htm" }]),
    },
    [`${sixKBase}/ex991.htm`]: { text: "<html>6-K press release body</html>" },
  };
}

describe("resolveCik", () => {
  it("resolves a known ticker to its 10-digit zero-padded CIK", async () => {
    const { fetchFn } = makeMockFetch({
      "https://www.sec.gov/files/company_tickers.json": { json: companyTickersFixture() },
    });
    await expect(resolveCik("NVDA", fetchFn)).resolves.toBe("0001045810");
  });

  it("matches case-insensitively", async () => {
    const { fetchFn } = makeMockFetch({
      "https://www.sec.gov/files/company_tickers.json": { json: companyTickersFixture() },
    });
    await expect(resolveCik("nvda", fetchFn)).resolves.toBe("0001045810");
  });

  it("returns null for an unknown ticker", async () => {
    const { fetchFn } = makeMockFetch({
      "https://www.sec.gov/files/company_tickers.json": { json: companyTickersFixture() },
    });
    await expect(resolveCik("ZZZZ", fetchFn)).resolves.toBeNull();
  });

  it("sends the declared SEC User-Agent", async () => {
    const { fetchFn, calls } = makeMockFetch({
      "https://www.sec.gov/files/company_tickers.json": { json: companyTickersFixture() },
    });
    await resolveCik("NVDA", fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["User-Agent"]).toBe(SEC_UA);
  });
});

describe("pollEdgar", () => {
  it("excludes a filing accepted before the window floor even with an empty seen set", async () => {
    const { fetchFn } = makeMockFetch(buildRoutes());
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);
    expect(filings.find((f) => f.accession === OLD_8K_ACCESSION)).toBeUndefined();
  });

  it("returns both the in-window 8-K and 6-K", async () => {
    const { fetchFn } = makeMockFetch(buildRoutes());
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);
    const accessions = filings.map((f) => f.accession).sort();
    expect(accessions).toEqual([NEW_6K_ACCESSION, NEW_8K_ACCESSION].sort());
    expect(filings.find((f) => f.accession === NEW_8K_ACCESSION)?.form).toBe("8-K");
    expect(filings.find((f) => f.accession === NEW_6K_ACCESSION)?.form).toBe("6-K");
  });

  it("ignores a 10-K even though it falls inside the window", async () => {
    const { fetchFn } = makeMockFetch(buildRoutes());
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);
    expect(filings.find((f) => f.accession === TENK_ACCESSION)).toBeUndefined();
  });

  it("fetches ALL EX-99.* exhibits for a qualifying filing, excluding non-EX-99 exhibits", async () => {
    const { fetchFn } = makeMockFetch(buildRoutes());
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);
    const eightK = filings.find((f) => f.accession === NEW_8K_ACCESSION) as EdgarFiling;
    expect(eightK.exhibits).toHaveLength(2);
    const names = eightK.exhibits.map((e) => e.name).sort();
    expect(names).toEqual(["ex991.htm", "ex992.htm"]);
    const ex1 = eightK.exhibits.find((e) => e.name === "ex991.htm");
    expect(ex1?.html).toBe("<html>8-K press release body</html>");
    const ex2 = eightK.exhibits.find((e) => e.name === "ex992.htm");
    expect(ex2?.html).toBe("<html>8-K CFO commentary</html>");
  });

  it("carries the SEC User-Agent on every captured request", async () => {
    const { fetchFn, calls } = makeMockFetch(buildRoutes());
    await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers["User-Agent"]).toBe(SEC_UA);
    }
  });

  it("dedupes against seenAccessions on a second poll of identical data", async () => {
    const { fetchFn, calls } = makeMockFetch(buildRoutes());
    const seen = new Set<string>();

    const first = await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);
    expect(first).toHaveLength(2);
    expect(seen.has(NEW_8K_ACCESSION)).toBe(true);
    expect(seen.has(NEW_6K_ACCESSION)).toBe(true);

    const callsAfterFirst = calls.length;
    const second = await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);
    expect(second).toEqual([]);
    // Only the submissions re-fetch should happen — no exhibit walk for
    // already-seen accessions.
    expect(calls.length).toBe(callsAfterFirst + 1);
  });

  it("never adds an excluded (wrong-form or out-of-window) accession to seenAccessions", async () => {
    const { fetchFn } = makeMockFetch(buildRoutes());
    const seen = new Set<string>();
    await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);
    expect(seen.has(OLD_8K_ACCESSION)).toBe(false);
    expect(seen.has(TENK_ACCESSION)).toBe(false);
  });

  it("does not lose the poll when one filing's exhibit fetch fails: the other filing still comes back, and the failed one is left unseen for retry", async () => {
    const routes = buildRoutes();
    const eightKBase = baseUrl(NEW_8K_ACCESSION);
    // Break the 8-K's exhibit fetch (404); the 6-K's route stays healthy.
    routes[`${eightKBase}/ex991.htm`] = { status: 404, text: "" };

    const { fetchFn } = makeMockFetch(routes);
    const seen = new Set<string>();
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);

    expect(filings.map((f) => f.accession)).toEqual([NEW_6K_ACCESSION]);
    expect(seen.has(NEW_6K_ACCESSION)).toBe(true);
    expect(seen.has(NEW_8K_ACCESSION)).toBe(false);
  });
});
