import { describe, it, expect } from "vitest";
import {
  resolveCik,
  pollEdgar,
  parseEdgarAcceptanceDateTime,
  type EdgarFiling,
  type FetchLike,
} from "@/lib/print-watch/edgar-adapter";

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

/**
 * SGML filing header, HTML-escaped as SEC serves it inside a <PRE> block.
 * `options.acceptanceDateTime`, when given, emits the header's own
 * `<ACCEPTANCE-DATETIME>YYYYMMDDHHMMSS` field (always Eastern wall-clock per
 * EDGAR's SGML header convention) — the authoritative value `pollEdgar` now
 * checks ahead of the submissions JSON.
 */
function indexHeadersFixture(
  exhibits: Array<{ type: string; filename: string }>,
  options: { acceptanceDateTime?: string } = {},
): string {
  const blocks = exhibits
    .map(
      (e) =>
        `&lt;DOCUMENT&gt;\n&lt;TYPE&gt;${e.type}\n&lt;SEQUENCE&gt;2\n&lt;FILENAME&gt;${e.filename}\n&lt;DESCRIPTION&gt;Exhibit\n&lt;/DOCUMENT&gt;`,
    )
    .join("\n");
  const header = options.acceptanceDateTime
    ? `&lt;ACCEPTANCE-DATETIME&gt;${options.acceptanceDateTime}\n`
    : "";
  return `&lt;SEC-DOCUMENT&gt;\n&lt;SEC-HEADER&gt;\n${header}&lt;/SEC-HEADER&gt;\n${blocks}\n&lt;/SEC-DOCUMENT&gt;`;
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
        // Effective window floor (true UTC) = WINDOW_START - 15min = 20:05:00Z.
        // The submissions JSON is DELIBERATELY MIXED here, matching the two
        // shapes SEC actually serves (see the "ACCEPTANCE-TIME QUIRK" note in
        // edgar-adapter.ts): OLD_8K/NEW_8K are EASTERN WALL-CLOCK mislabeled
        // with a "Z" (a fresh filing's shape); NEW_6K is already TRUE UTC (an
        // older/normalized filing's shape, Dell-style). Both shapes must
        // survive the dual-reading prefilter and are then confirmed by each
        // filing's own index-headers `<ACCEPTANCE-DATETIME>` (see buildRoutes).
        acceptanceDateTime: [
          "2026-08-26T15:00:00Z", // ET wall-clock; true UTC 19:00:00Z — old 8-K, before the window floor either way
          "2026-08-26T16:22:00Z", // ET wall-clock; true UTC 20:22:00Z — in-window 8-K (Eastern-as-Z shape)
          "2026-08-26T20:25:00Z", // already true UTC — in-window 6-K (normalized shape)
          "2026-08-26T16:30:00Z", // ET wall-clock; true UTC 20:30:00Z — in-window but wrong form
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
    // Header ACCEPTANCE-DATETIME below is the Eastern wall-clock equivalent
    // of each filing's intended true-UTC instant (20:22:00Z and 20:25:00Z
    // respectively, both EDT/UTC-4 on this August date) — it CONFIRMS the
    // JSON's window placement regardless of which JSON shape carried it.
    [`${eightKBase}/${NEW_8K_ACCESSION}-index-headers.html`]: {
      text: indexHeadersFixture(
        [
          { type: "EX-99.1", filename: "ex991.htm" },
          { type: "EX-99.2", filename: "ex992.htm" },
          { type: "EX-10.1", filename: "ex101.htm" }, // must NOT be picked up
        ],
        { acceptanceDateTime: "20260826162200" },
      ),
    },
    [`${eightKBase}/ex991.htm`]: { text: "<html>8-K press release body</html>" },
    [`${eightKBase}/ex992.htm`]: { text: "<html>8-K CFO commentary</html>" },
    [`${sixKBase}/${NEW_6K_ACCESSION}-index-headers.html`]: {
      text: indexHeadersFixture([{ type: "EX-99.1", filename: "ex991.htm" }], {
        acceptanceDateTime: "20260826162500",
      }),
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

describe("parseEdgarAcceptanceDateTime", () => {
  it("interprets an EDT-season timestamp as Eastern wall-clock, not literal UTC (today's Snowflake miss)", () => {
    // SEC submissions JSON reported "2026-09-02T16:08:29.000Z" for a filing
    // whose own -index-headers.html said <ACCEPTANCE-DATETIME>20260902160829
    // — EDGAR headers are Eastern by definition. 16:08:29 ET on 2026-09-02
    // (EDT, UTC-4) is 20:08:29 true UTC.
    expect(parseEdgarAcceptanceDateTime("2026-09-02T16:08:29.000Z")).toBe(
      Date.parse("2026-09-02T20:08:29.000Z"),
    );
  });

  it("interprets an EST-season timestamp with the winter offset (UTC-5)", () => {
    expect(parseEdgarAcceptanceDateTime("2026-01-15T16:08:00.000Z")).toBe(
      Date.parse("2026-01-15T21:08:00.000Z"),
    );
  });

  it("treats a raw value without a trailing Z the same way — the Z was never trustworthy anyway", () => {
    expect(parseEdgarAcceptanceDateTime("2026-09-02T16:08:29.000")).toBe(
      parseEdgarAcceptanceDateTime("2026-09-02T16:08:29.000Z"),
    );
  });

  it("returns NaN for unparseable input", () => {
    expect(Number.isNaN(parseEdgarAcceptanceDateTime("not-a-timestamp"))).toBe(true);
    expect(Number.isNaN(parseEdgarAcceptanceDateTime(""))).toBe(true);
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

  // Regression for the 2026-09-02 live miss: the submissions JSON's
  // acceptanceDateTime is Eastern wall-clock mislabeled UTC (see the
  // top-of-file comment and parseEdgarAcceptanceDateTime above). The armed
  // window here mirrors a real watcher window: 15:45-17:00 ET expressed as
  // true UTC ("2026-09-02T19:45:00Z".."2026-09-02T21:00:00Z").
  describe("acceptanceDateTime Eastern-wall-clock quirk (2026-09-02 live miss)", () => {
    const MISS_ACCESSION = "0001045810-26-000200";
    const WINDOW_START_TODAY = "2026-09-02T19:45:00Z";
    const WINDOW_END_TODAY = "2026-09-02T21:00:00Z";

    function buildMissRoutes(acceptanceDateTime: string): Record<string, MockRoute> {
      const submissionsUrl = `https://data.sec.gov/submissions/CIK${CIK}.json`;
      const base = baseUrl(MISS_ACCESSION);
      return {
        [submissionsUrl]: {
          json: {
            filings: {
              recent: {
                form: ["8-K"],
                acceptanceDateTime: [acceptanceDateTime],
                accessionNumber: [MISS_ACCESSION],
                primaryDocument: ["8k.htm"],
              },
            },
          },
        },
        [`${base}/${MISS_ACCESSION}-index-headers.html`]: {
          text: indexHeadersFixture([{ type: "EX-99.1", filename: "ex991.htm" }]),
        },
        [`${base}/ex991.htm`]: { text: "<html>Snowflake press release body</html>" },
      };
    }

    it("returns the filing: JSON says acceptanceDateTime 16:08:29 'Z', which is really 16:08:29 ET = 20:08:29 UTC, inside the 19:45-21:00Z window", async () => {
      const { fetchFn } = makeMockFetch(buildMissRoutes("2026-09-02T16:08:29.000Z"));
      const filings = await pollEdgar(CIK, WINDOW_START_TODAY, WINDOW_END_TODAY, new Set(), fetchFn);

      expect(filings).toHaveLength(1);
      expect(filings[0].accession).toBe(MISS_ACCESSION);
      expect(filings[0].exhibits).toHaveLength(1);
      expect(filings[0].exhibits[0].html).toBe("<html>Snowflake press release body</html>");
    });

    it("still excludes a filing genuinely accepted before the window (11:00 ET wall-clock = 15:00 true UTC, well before the 19:30Z floor)", async () => {
      const { fetchFn } = makeMockFetch(buildMissRoutes("2026-09-02T11:00:00.000Z"));
      const filings = await pollEdgar(CIK, WINDOW_START_TODAY, WINDOW_END_TODAY, new Set(), fetchFn);

      expect(filings).toHaveLength(0);
    });
  });

  // The JSON alone is never trusted (see the corrected "ACCEPTANCE-TIME
  // QUIRK" note in edgar-adapter.ts, 2026-09-02 evening): the submissions
  // feed serves EITHER shape (fresh filing = Eastern-as-Z; older/normalized
  // filing = true UTC), so pollEdgar prefilters on BOTH readings and then
  // settles the decision from the filing's own index-headers
  // <ACCEPTANCE-DATETIME>, which is always Eastern.
  describe("authoritative acceptance check via the filing's own index-headers", () => {
    const HDR_ACCESSION = "0001045810-26-000300";
    const HDR_WINDOW_START = "2026-09-02T19:45:00Z";
    const HDR_WINDOW_END = "2026-09-02T21:00:00Z";

    function buildHeaderCheckRoutes(
      jsonAcceptance: string,
      headerAcceptance?: string,
    ): Record<string, MockRoute> {
      const submissionsUrl = `https://data.sec.gov/submissions/CIK${CIK}.json`;
      const base = baseUrl(HDR_ACCESSION);
      return {
        [submissionsUrl]: {
          json: {
            filings: {
              recent: {
                form: ["8-K"],
                acceptanceDateTime: [jsonAcceptance],
                accessionNumber: [HDR_ACCESSION],
                primaryDocument: ["8k.htm"],
              },
            },
          },
        },
        [`${base}/${HDR_ACCESSION}-index-headers.html`]: {
          text: indexHeadersFixture(
            [{ type: "EX-99.1", filename: "ex991.htm" }],
            headerAcceptance !== undefined ? { acceptanceDateTime: headerAcceptance } : {},
          ),
        },
        [`${base}/ex991.htm`]: { text: "<html>press release body</html>" },
      };
    }

    it("(a) fresh filing: JSON is Eastern-as-Z, header confirms — returned with a true-UTC acceptanceDateTime", async () => {
      const routes = buildHeaderCheckRoutes("2026-09-02T16:08:29.000Z", "20260902160829");
      const { fetchFn } = makeMockFetch(routes);
      const filings = await pollEdgar(CIK, HDR_WINDOW_START, HDR_WINDOW_END, new Set(), fetchFn);

      expect(filings).toHaveLength(1);
      expect(filings[0].accession).toBe(HDR_ACCESSION);
      expect(filings[0].exhibits).toHaveLength(1);
      expect(filings[0].acceptanceDateTime).toBe("2026-09-02T20:08:29.000Z");
    });

    it("(b) normalized filing (Dell-style): JSON is already true UTC, header confirms the Eastern equivalent — returned with a true-UTC acceptanceDateTime", async () => {
      const routes = buildHeaderCheckRoutes("2026-09-01T20:10:14.000Z", "20260901161014");
      const { fetchFn } = makeMockFetch(routes);
      const filings = await pollEdgar(
        CIK,
        "2026-09-01T19:45:00Z",
        "2026-09-01T21:00:00Z",
        new Set(),
        fetchFn,
      );

      expect(filings).toHaveLength(1);
      expect(filings[0].accession).toBe(HDR_ACCESSION);
      expect(filings[0].acceptanceDateTime).toBe("2026-09-01T20:10:14.000Z");
    });

    it("(c) header overrules a lucky JSON reading: the JSON's Eastern reading looks in-window, but the header's true acceptance is not — never returned, exhibit never fetched", async () => {
      const routes = buildHeaderCheckRoutes("2026-09-02T16:08:29.000Z", "20260902120829");
      const { fetchFn, calls } = makeMockFetch(routes);
      const filings = await pollEdgar(CIK, HDR_WINDOW_START, HDR_WINDOW_END, new Set(), fetchFn);

      expect(filings).toHaveLength(0);
      const base = baseUrl(HDR_ACCESSION);
      expect(calls.some((c) => c.url === `${base}/ex991.htm`)).toBe(false);
      // The header itself WAS fetched (the prefilter passed on the JSON's
      // Eastern reading) — only the exhibit walk was skipped.
      expect(calls.some((c) => c.url === `${base}/${HDR_ACCESSION}-index-headers.html`)).toBe(true);
    });

    it("(d) neither JSON reading lands in-window: skipped before any header fetch", async () => {
      const routes = buildHeaderCheckRoutes("2026-09-02T11:00:00.000Z", "20260902110000");
      const { fetchFn, calls } = makeMockFetch(routes);
      const filings = await pollEdgar(CIK, HDR_WINDOW_START, HDR_WINDOW_END, new Set(), fetchFn);

      expect(filings).toHaveLength(0);
      const base = baseUrl(HDR_ACCESSION);
      expect(calls.some((c) => c.url === `${base}/${HDR_ACCESSION}-index-headers.html`)).toBe(false);
    });

    it("(e) header missing/unparseable: falls back to whichever JSON reading was in-window, still returns the filing", async () => {
      const routes = buildHeaderCheckRoutes("2026-09-02T16:08:29.000Z"); // no header acceptance field
      const { fetchFn } = makeMockFetch(routes);
      const filings = await pollEdgar(CIK, HDR_WINDOW_START, HDR_WINDOW_END, new Set(), fetchFn);

      expect(filings).toHaveLength(1);
      expect(filings[0].accession).toBe(HDR_ACCESSION);
      expect(filings[0].acceptanceDateTime).toBe("2026-09-02T20:08:29.000Z");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 4 (slice C): pollEdgar rides the caller's throttled fetch for
// cancellation — NO signature change. `resolveCik`/`pollEdgar` already take
// `fetchFn`; Task 6 passes a fetch that carries an AbortSignal into every
// request. The only thing THIS module owns is its per-filing try/catch: an
// AbortError must reject the whole poll, never get counted as an ordinary
// filing failure that yields a partial "ok" result (Codex round 1, #10).
// ---------------------------------------------------------------------------
describe("pollEdgar — cancellation via the caller's fetch", () => {
  it("rejects when the fetch it was handed throws AbortError, and never gets past the first request", async () => {
    const seen = new Set<string>();
    let calls = 0;
    const abortingFetch: FetchLike = async () => {
      calls += 1;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    await expect(
      pollEdgar("0000000001", "2026-09-03T19:55:00.000Z", "2026-09-03T20:40:00.000Z", seen, abortingFetch),
    ).rejects.toMatchObject({ name: "AbortError" });
    // Load-bearing (fix round 1, review finding M2): `pollEdgar` never writes
    // `seenAccessions` on ANY path (see the module-header note), so asserting
    // `seen.size === 0` here would be a tautology that can never fail. What
    // actually proves the abort short-circuited the walk is that it happened
    // on the very first request (the submissions fetch itself) — nothing
    // downstream (a filing header, an exhibit) was ever attempted.
    expect(calls).toBe(1);
  });

  it("rejects with AbortError when the SECOND filing's fetch aborts mid-walk, and never fetches that filing's exhibit (the per-filing catch must rethrow, not swallow)", async () => {
    const { fetchFn: baseFetch, calls } = makeMockFetch(buildRoutes());
    const sixKBase = baseUrl(NEW_6K_ACCESSION);
    const abortingFetch: FetchLike = async (url, init) => {
      // The 8-K (first qualifying filing) is left to complete normally; the
      // 6-K (second) aborts on its own header fetch, mid-walk.
      if (url === `${sixKBase}/${NEW_6K_ACCESSION}-index-headers.html`) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return baseFetch(url, init);
    };

    const seen = new Set<string>();
    await expect(pollEdgar(CIK, WINDOW_START, WINDOW_END, seen, abortingFetch)).rejects.toMatchObject({
      name: "AbortError",
    });
    // Load-bearing (fix round 1, review finding M2): `pollEdgar` never writes
    // `seenAccessions` on any path, so `seen.size === 0` would be a tautology.
    // What actually proves the rethrow (rather than a swallow-and-continue)
    // is that the 6-K's exhibit was NEVER fetched — the per-filing catch threw
    // before the walk ever got that far.
    expect(calls.some((c) => c.url === `${sixKBase}/ex991.htm`)).toBe(false);
    // pollEdgar rejected rather than returning a value — the caller never got
    // a result to mark ANY accession seen from, including the 8-K that had
    // already completed internally (dropped the `seen.size === 0` tautology
    // per M2: `pollEdgar` never writes that set on any path, so it could
    // never have failed regardless of this fix).
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

  it("never echoes a secret-bearing query parameter in a hardened-fetch error", async () => {
    // The cross-host redirect refusal (above) is the concrete hardened-fetch
    // error path an attacker-controlled Location header can reach: a redirect
    // to an off-host URL carrying ?token=SECRET-VALUE must never surface that
    // token in the rejection message.
    const routes = buildRoutes();
    routes[`https://data.sec.gov/submissions/CIK${CIK}.json`] = {
      status: 302,
      body: null,
      headers: { location: "https://evil.example.com/submissions.json?token=SECRET-VALUE" },
    };

    const { fetchFn } = makeMockFetch(routes);
    await expect(
      pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), fetchFn),
    ).rejects.not.toThrow(/SECRET-VALUE/);
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
