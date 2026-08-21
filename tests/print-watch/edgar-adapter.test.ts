import { describe, it, expect } from "vitest";
import { resolveCik, pollEdgar, type EdgarFiling, type FetchLike } from "@/lib/print-watch/edgar-adapter";

const SEC_UA = "PortfolioDesk contact@myportfoliodesk.com";
const CIK = "0001045810";

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect;
}

interface MockRoute {
  status?: number;
  json?: unknown;
  text?: string;
  /** Overrides the content-type the route would otherwise infer. */
  contentType?: string;
  /** Raw body + headers, for the hardening tests (redirects, size caps). */
  body?: BodyInit | null;
  headers?: Record<string, string>;
}

/**
 * Route table keyed by exact URL; each entry returns a canned response.
 *
 * These are REAL `Response` objects (fix wave, finding E): every SEC fetch now
 * goes through the shared hardened fetch, which reads `res.headers` and streams
 * `res.body` — a hand-rolled `{ok, status, json, text}` stub cannot exercise
 * the redirect, content-type or byte-cap rules it exists to enforce.
 */
function makeMockFetch(
  routes: Record<string, MockRoute>,
  calls: Call[] = [],
): { fetchFn: FetchLike; calls: Call[] } {
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      redirect: init?.redirect,
    });
    const route = routes[url];
    if (!route) throw new Error(`unmocked fetch: ${url}`);
    const status = route.status ?? 200;

    if (route.body !== undefined || route.headers) {
      return new Response(route.body ?? null, { status, headers: route.headers });
    }

    const isJson = route.json !== undefined;
    const body = isJson ? JSON.stringify(route.json) : (route.text ?? "");
    return new Response(status === 204 ? null : body, {
      status,
      headers: {
        "content-type": route.contentType ?? (isJson ? "application/json" : "text/html"),
      },
    });
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

  it("never marks an accession seen itself — that is the caller's job once it has ingested (finding F)", async () => {
    const { fetchFn } = makeMockFetch(buildRoutes());
    const seen = new Set<string>();
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);

    expect(filings).toHaveLength(2);
    // A poll the watcher abandons on its source timeout used to keep running
    // and mutate this set behind its back, retiring a filing that never
    // reached the pipeline.
    expect(seen.size).toBe(0);
  });

  it("dedupes against seenAccessions on a second poll of identical data", async () => {
    const { fetchFn, calls } = makeMockFetch(buildRoutes());
    const seen = new Set<string>();

    const first = await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);
    expect(first).toHaveLength(2);
    // The CALLER marks, once it has consumed each filing.
    for (const filing of first) seen.add(filing.accession);

    const callsAfterFirst = calls.length;
    const second = await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);
    expect(second).toEqual([]);
    // Only the submissions re-fetch should happen — no exhibit walk for
    // already-seen accessions.
    expect(calls.length).toBe(callsAfterFirst + 1);
  });

  it("does not lose the poll when one filing's exhibit fetch fails: the other filing still comes back, and the failed one is left unseen for retry", async () => {
    const routes = buildRoutes();
    const eightKBase = baseUrl(NEW_8K_ACCESSION);
    // Break the 8-K's exhibit fetch (404); the 6-K's route stays healthy.
    routes[`${eightKBase}/ex991.htm`] = { status: 404, text: "" };

    const { fetchFn } = makeMockFetch(routes);
    const seen = new Set<string>();
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, fetchFn);

    // The healthy filing is reported (and the caller will mark it); the broken
    // one is simply not reported, so the next poll retries it whole.
    expect(filings.map((f) => f.accession)).toEqual([NEW_6K_ACCESSION]);
    expect(seen.has(NEW_8K_ACCESSION)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// outbound hardening (fix wave, finding E — shared hardened-fetch)
// ---------------------------------------------------------------------------

/** A ReadableStream that emits `totalBytes` without ever setting content-length. */
function bigStream(totalBytes: number): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97));
      sent += size;
    },
  });
}

describe("EDGAR outbound hardening", () => {
  it("rejects an oversized exhibit body streamed with no content-length", async () => {
    const routes = buildRoutes();
    routes[`${baseUrl(NEW_8K_ACCESSION)}/ex991.htm`] = {
      body: bigStream(3 * 1024 * 1024),
      headers: { "content-type": "text/html" },
    };

    const { fetchFn } = makeMockFetch(routes);
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);

    // The oversized filing is dropped whole; the healthy one still lands.
    expect(filings.map((f) => f.accession)).toEqual([NEW_6K_ACCESSION]);
  });

  it("rejects an oversized body caught by the content-length precheck", async () => {
    const routes = buildRoutes();
    routes[`${baseUrl(NEW_8K_ACCESSION)}/ex991.htm`] = {
      body: "<html>tiny body, big header lie</html>",
      headers: { "content-type": "text/html", "content-length": String(3 * 1024 * 1024) },
    };

    const { fetchFn } = makeMockFetch(routes);
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);
    expect(filings.map((f) => f.accession)).toEqual([NEW_6K_ACCESSION]);
  });

  it("refuses a cross-host redirect on the submissions feed", async () => {
    const routes = buildRoutes();
    routes[`https://data.sec.gov/submissions/CIK${CIK}.json`] = {
      status: 302,
      body: null,
      headers: { location: "https://evil.example.com/submissions.json" },
    };

    const { fetchFn } = makeMockFetch(routes);
    await expect(pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn)).rejects.toThrow(
      /cross-host/i,
    );
  });

  it("sends redirect: 'manual' and follows a same-host hop", async () => {
    const routes = buildRoutes();
    const ex991 = `${baseUrl(NEW_8K_ACCESSION)}/ex991.htm`;
    routes[ex991] = {
      status: 301,
      body: null,
      headers: { location: `${baseUrl(NEW_8K_ACCESSION)}/ex991-final.htm` },
    };
    routes[`${baseUrl(NEW_8K_ACCESSION)}/ex991-final.htm`] = {
      text: "<html>redirected exhibit body</html>",
    };

    const { fetchFn, calls } = makeMockFetch(routes);
    const filings = await pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn);

    const eightK = filings.find((f) => f.accession === NEW_8K_ACCESSION) as EdgarFiling;
    expect(eightK.exhibits.find((e) => e.name === "ex991.htm")?.html).toBe(
      "<html>redirected exhibit body</html>",
    );
    // Every SEC request is made with manual redirect handling — a browser-
    // followed 3xx would never be revalidated against the host.
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("rejects a response whose content-type is not what the call site expects", async () => {
    const routes = buildRoutes();
    routes["https://www.sec.gov/files/company_tickers.json"] = {
      text: "<html>an error page, not the ticker map</html>",
      contentType: "text/html",
    };
    const { fetchFn } = makeMockFetch(routes);
    await expect(resolveCik("NVDA", fetchFn)).rejects.toThrow(/content-type/i);
  });
});
