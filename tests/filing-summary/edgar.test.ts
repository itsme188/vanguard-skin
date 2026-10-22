// Strict EDGAR discovery for the armed-print filing summary (spec §4, R11).
// Every fixture here is SYNTHETIC: a made-up CIK, made-up accessions and file
// names, in the escaped `&lt;TYPE&gt;` shape EDGAR serves its
// `-index-headers.html`. A real header (gitignored) is replayed at the bottom
// when it is present on this machine.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyFiling,
  fetchFilingDocument,
  inferFilerKind,
  listDayFilings,
  parseFilingHeader,
  readDayFilings,
  shouldSkipDocument,
  FILING_DOCUMENT_MAX_BYTES,
} from "@/lib/filing-summary/edgar";
import type { FetchLike } from "@/lib/print-watch/hardened-fetch";

const CIK = "0000123456";
const CIK_NUM = "123456";

interface Route {
  status?: number;
  text?: string;
  json?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

function makeFetch(routes: Record<string, Route>): { fetchFn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unmocked fetch: ${url}`);
    const isJson = route.json !== undefined;
    const body = isJson ? JSON.stringify(route.json) : (route.text ?? "");
    return new Response(body, {
      status: route.status ?? 200,
      headers: {
        "content-type": route.contentType ?? (isJson ? "application/json" : "text/html"),
        ...(route.headers ?? {}),
      },
    });
  };
  return { fetchFn, calls };
}

function doc(type: string, seq: number, fileName: string, description: string | null): string {
  return [
    "&lt;DOCUMENT&gt;",
    `&lt;TYPE&gt;${type}`,
    `&lt;SEQUENCE&gt;${seq}`,
    `&lt;FILENAME&gt;${fileName}`,
    ...(description === null ? [] : [`&lt;DESCRIPTION&gt;${description}`]),
    "&lt;TEXT&gt;",
    `<a href="${fileName}">Document ${seq} - file: ${fileName}</a><br>`,
    "&lt;/DOCUMENT&gt;",
  ].join("\n");
}

/** The shape EDGAR serves: an HTML comment holding the raw SGML header (with
 *  `<ITEMS>` lines), then a <PRE> of the escaped header and document list. */
function headerHtml(opts: {
  accession: string;
  form: string;
  acceptance?: string | null;
  items?: string[];
  documents: string[];
}): string {
  const acceptance = opts.acceptance === undefined ? "20261021160500" : opts.acceptance;
  const raw = [
    `<SEC-HEADER>${opts.accession}.hdr.sgml : 20261021`,
    ...(acceptance ? [`<ACCEPTANCE-DATETIME>${acceptance}`] : []),
    `<ACCESSION-NUMBER>${opts.accession}`,
    `<TYPE>${opts.form}`,
    ...(opts.items ?? []).map((i) => `<ITEMS>${i}`),
    "</SEC-HEADER>",
  ].join("\n");
  const pre = [
    `&lt;SEC-DOCUMENT&gt;${opts.accession}-index.html : 20261021`,
    ...(acceptance ? [`&lt;ACCEPTANCE-DATETIME&gt;${acceptance}`] : []),
    `CONFORMED SUBMISSION TYPE:\t${opts.form}`,
    "&lt;/SEC-HEADER&gt;",
    ...opts.documents,
    "&lt;/SEC-DOCUMENT&gt;",
  ].join("\n");
  return `<HTML><HEAD><TITLE>SEC EDGAR Submission ${opts.accession}</TITLE>\n<!--\n${raw}\n-->\n</HEAD><BODY>\n<PRE>${pre}</PRE></BODY></HTML>`;
}

const EARNINGS_8K = headerHtml({
  accession: "0000999999-26-000101",
  form: "8-K",
  items: ["2.02", "9.01"],
  documents: [
    doc("8-K", 1, "acme-20261021.htm", "8-K"),
    doc("EX-99.1", 2, "acme-ex991.htm", "PRESS RELEASE"),
    doc("EX-10.1", 3, "acme-ex101.htm", "CREDIT AGREEMENT"),
    doc("GRAPHIC", 4, "acme-g1.jpg", null),
    doc("EX-101.SCH", 5, "acme-20261021.xsd", "XBRL TAXONOMY EXTENSION SCHEMA DOCUMENT"),
  ],
});

function headerUrl(accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${CIK_NUM}/${accession.replace(/-/g, "")}/${accession}-index-headers.html`;
}

const SUBMISSIONS_URL = `https://data.sec.gov/submissions/CIK${CIK}.json`;

describe("parseFilingHeader", () => {
  it("reads the Eastern acceptance time, every ITEMS line and every document group", () => {
    const h = parseFilingHeader(EARNINGS_8K);
    // 16:05:00 Eastern on 2026-10-21 (EDT) is 20:05:00 UTC.
    expect(h.acceptanceMs).toBe(Date.parse("2026-10-21T20:05:00Z"));
    expect(h.items).toEqual(["2.02", "9.01"]);
    expect(h.documents).toEqual([
      { type: "8-K", sequence: 1, fileName: "acme-20261021.htm", description: "8-K" },
      { type: "EX-99.1", sequence: 2, fileName: "acme-ex991.htm", description: "PRESS RELEASE" },
      { type: "EX-10.1", sequence: 3, fileName: "acme-ex101.htm", description: "CREDIT AGREEMENT" },
      { type: "GRAPHIC", sequence: 4, fileName: "acme-g1.jpg", description: null },
      {
        type: "EX-101.SCH",
        sequence: 5,
        fileName: "acme-20261021.xsd",
        description: "XBRL TAXONOMY EXTENSION SCHEMA DOCUMENT",
      },
    ]);
  });

  it("does not count the submission's own header <TYPE> as a document", () => {
    const h = parseFilingHeader(EARNINGS_8K);
    expect(h.documents.filter((d) => d.type === "8-K")).toHaveLength(1);
  });

  it("returns acceptanceMs null when the header carries no ACCEPTANCE-DATETIME", () => {
    const h = parseFilingHeader(
      headerHtml({
        accession: "0000999999-26-000102",
        form: "8-K",
        acceptance: null,
        items: ["2.02"],
        documents: [doc("8-K", 1, "a.htm", "8-K")],
      }),
    );
    expect(h.acceptanceMs).toBeNull();
    expect(h.items).toEqual(["2.02"]);
  });

  it("reads escaped ITEMS lines too and never lists an item twice", () => {
    const html = `${EARNINGS_8K}\n<PRE>&lt;ITEMS&gt;2.02\n&lt;ITEMS&gt;7.01</PRE>`;
    expect(parseFilingHeader(html).items).toEqual(["2.02", "9.01", "7.01"]);
  });

  it("decodes entities in a description", () => {
    const h = parseFilingHeader(
      headerHtml({
        accession: "0000999999-26-000103",
        form: "8-K",
        documents: [doc("EX-99.1", 1, "b.htm", "Q3 RESULTS &amp; OUTLOOK")],
      }),
    );
    expect(h.documents[0].description).toBe("Q3 RESULTS & OUTLOOK");
  });
});

describe("classifyFiling", () => {
  const docs = parseFilingHeader(EARNINGS_8K).documents;

  it("an 8-K with Item 2.02 is the domestic earnings filing", () => {
    expect(classifyFiling("8-K", ["2.02", "9.01"], docs, "domestic")).toBe("earnings");
  });

  it("an 8-K without Item 2.02 is a companion", () => {
    expect(classifyFiling("8-K", ["8.01", "9.01"], docs, "domestic")).toBe("companion");
    expect(classifyFiling("8-K/A", ["2.02"], docs, "domestic")).toBe("companion");
  });

  it("Form 4, 3, 5 and 144 are ignored, and so is anything off the allow list", () => {
    for (const form of ["4", "3", "5", "144", "SC 13G", "13F-HR", "4/A"]) {
      expect(classifyFiling(form, [], [], "domestic")).toBe("ignored");
      expect(classifyFiling(form, [], [], "foreign")).toBe("ignored");
    }
  });

  it("allow-listed forms are companions (PRE 14C, 10-Q, 424B*, SC TO-I …)", () => {
    for (const form of [
      "PRE 14C",
      "DEF 14C",
      "PRE 14A",
      "DEF 14A",
      "10-Q",
      "10-K",
      "S-3",
      "S-3ASR",
      "S-8",
      "424B2",
      "424B5",
      "SC TO-I",
    ]) {
      expect(classifyFiling(form, [], [], "domestic")).toBe("companion");
    }
  });

  it("a foreign filer's earnings filing is a 6-K with an EX-99 exhibit", () => {
    const exDocs = [
      { type: "6-K", sequence: 1, fileName: "f.htm", description: null },
      { type: "EX-99.1", sequence: 2, fileName: "f-ex991.htm", description: null },
    ];
    const plainDocs = [{ type: "6-K", sequence: 1, fileName: "f.htm", description: null }];
    expect(classifyFiling("6-K", [], exDocs, "foreign")).toBe("earnings");
    expect(classifyFiling("6-K", [], plainDocs, "foreign")).toBe("companion");
    expect(classifyFiling("F-3", [], [], "foreign")).toBe("companion");
  });

  it("6-K and F-3 are ignored for a domestic filer", () => {
    const exDocs = [{ type: "EX-99.1", sequence: 1, fileName: "x.htm", description: null }];
    expect(classifyFiling("6-K", [], exDocs, "domestic")).toBe("ignored");
    expect(classifyFiling("F-3", [], [], "domestic")).toBe("ignored");
  });
});

describe("shouldSkipDocument", () => {
  it("skips graphics, XBRL parts, zips and data files with a reason", () => {
    expect(shouldSkipDocument("GRAPHIC", "acme-g1.jpg")).toMatch(/GRAPHIC/);
    expect(shouldSkipDocument("EX-101.SCH", "acme-20261021.xsd")).toMatch(/EX-101/);
    expect(shouldSkipDocument("EX-101.INS", "acme.htm")).not.toBeNull();
    expect(shouldSkipDocument("ZIP", "a-xbrl.zip")).not.toBeNull();
    expect(shouldSkipDocument("XML", "R1.htm")).not.toBeNull();
    expect(shouldSkipDocument("JSON", "MetaLinks.json")).not.toBeNull();
  });

  it("skips by file extension whatever the type says", () => {
    for (const name of ["a.jpg", "a.JPEG", "a.png", "a.gif", "a.xsd", "a.xml", "a.json", "a.zip"]) {
      expect(shouldSkipDocument("EX-99.2", name)).not.toBeNull();
    }
  });

  it("keeps the main document and every text exhibit", () => {
    expect(shouldSkipDocument("8-K", "acme-20261021.htm")).toBeNull();
    expect(shouldSkipDocument("EX-99.1", "acme-ex991.htm")).toBeNull();
    expect(shouldSkipDocument("EX-10.1", "acme-ex101.htm")).toBeNull();
    expect(shouldSkipDocument("PRE 14C", "acme-pre14c.htm")).toBeNull();
    expect(shouldSkipDocument("EX-99.1", "acme-ex991.txt")).toBeNull();
  });
});

describe("inferFilerKind", () => {
  it("foreign when recent forms include 6-K or 20-F and no 10-Q", () => {
    expect(inferFilerKind(["6-K", "20-F"])).toBe("foreign");
    expect(inferFilerKind(["20-F", "4"])).toBe("foreign");
    expect(inferFilerKind(["6-K", "10-Q"])).toBe("domestic");
    expect(inferFilerKind(["8-K", "10-Q", "4"])).toBe("domestic");
    expect(inferFilerKind([])).toBe("domestic");
  });
});

describe("listDayFilings", () => {
  const A = "0000999999-26-000101"; // earnings 8-K, JSON in true UTC
  const B = "0000999999-26-000102"; // PRE 14C, JSON in true UTC after 20:00 UTC
  const C = "0000999999-26-000103"; // Form 4 the same day
  const D = "0000999999-26-000104"; // yesterday's 8-K — prefiltered out
  const E = "0000999999-26-000105"; // 10-Q whose header 500s
  const F = "0000999999-26-000106"; // fresh filing: Eastern wall-clock with a bogus Z

  function submissions() {
    return {
      filings: {
        recent: {
          accessionNumber: [F, E, C, B, A, D],
          form: ["8-K", "10-Q", "4", "PRE 14C", "8-K", "8-K"],
          acceptanceDateTime: [
            // literal UTC = 2026-10-20 22:00 ET; Eastern reading = 2026-10-21 02:00 ET
            "2026-10-21T02:00:00.000Z",
            "2026-10-21T21:00:00.000Z",
            "2026-10-21T22:07:36.000Z",
            // literal UTC = 2026-10-21 20:10 ET (the Eastern reading is the 22nd)
            "2026-10-22T00:10:30.000Z",
            "2026-10-21T20:05:00.000Z",
            "2026-10-20T20:05:00.000Z",
          ],
        },
      },
    };
  }

  function routes(): Record<string, Route> {
    return {
      [SUBMISSIONS_URL]: { json: submissions() },
      [headerUrl(A)]: { text: EARNINGS_8K },
      [headerUrl(B)]: {
        text: headerHtml({
          accession: B,
          form: "PRE 14C",
          acceptance: "20261021161030",
          documents: [doc("PRE 14C", 1, "acme-pre14c.htm", "PRE 14C")],
        }),
      },
      [headerUrl(C)]: {
        text: headerHtml({
          accession: C,
          form: "4",
          acceptance: "20261021180736",
          documents: [doc("4", 1, "ownership.xml", "FORM 4")],
        }),
      },
      [headerUrl(E)]: { status: 500, text: "oops" },
      [headerUrl(F)]: {
        text: headerHtml({
          accession: F,
          form: "8-K",
          acceptance: "20261021020000",
          items: ["5.02"],
          documents: [doc("8-K", 1, "f.htm", "8-K")],
        }),
      },
    };
  }

  it("keeps every filing either JSON reading puts on the event day and fetches each header", async () => {
    const { fetchFn, calls } = makeFetch(routes());
    const out = await listDayFilings(CIK, "2026-10-21", fetchFn);
    expect(out.map((f) => f.accession)).toEqual([F, E, C, B, A]);
    expect(calls).not.toContain(headerUrl(D));
    expect(calls[0]).toBe(SUBMISSIONS_URL);

    const a = out.find((f) => f.accession === A)!;
    expect(a.form).toBe("8-K");
    expect(a.headerError).toBeNull();
    expect(a.header?.items).toEqual(["2.02", "9.01"]);
    expect(a.header?.documents.map((d) => d.type)).toEqual([
      "8-K",
      "EX-99.1",
      "EX-10.1",
      "GRAPHIC",
      "EX-101.SCH",
    ]);
    const b = out.find((f) => f.accession === B)!;
    expect(b.header?.acceptanceMs).toBe(Date.parse("2026-10-21T20:10:30Z"));
  });

  it("reports one filing's header failure on that entry and still returns the others", async () => {
    const { fetchFn } = makeFetch(routes());
    const out = await listDayFilings(CIK, "2026-10-21", fetchFn);
    const e = out.find((f) => f.accession === E)!;
    expect(e.header).toBeNull();
    expect(e.headerError).toMatch(/HTTP 500/);
    expect(out.filter((f) => f.header !== null)).toHaveLength(4);
  });

  it("sends the SEC User-Agent on every request", async () => {
    const seen: Array<Record<string, string>> = [];
    const { fetchFn: inner } = makeFetch(routes());
    const fetchFn: FetchLike = (url, init) => {
      seen.push((init?.headers as Record<string, string>) ?? {});
      return inner(url, init);
    };
    await listDayFilings(CIK, "2026-10-21", fetchFn);
    expect(seen.length).toBeGreaterThan(1);
    for (const h of seen) expect(h["User-Agent"]).toBe("PortfolioDesk contact@myportfoliodesk.com");
  });

  it("throws when the submissions list itself cannot be fetched", async () => {
    const { fetchFn } = makeFetch({ [SUBMISSIONS_URL]: { status: 503, text: "busy" } });
    await expect(listDayFilings(CIK, "2026-10-21", fetchFn)).rejects.toThrow(/HTTP 503/);
  });

  it("rethrows an abort instead of booking it as a header failure", async () => {
    const r = routes();
    const { fetchFn: inner } = makeFetch(r);
    const fetchFn: FetchLike = async (url, init) => {
      if (url === headerUrl(A)) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return inner(url, init);
    };
    await expect(listDayFilings(CIK, "2026-10-21", fetchFn)).rejects.toThrow(/aborted/);
  });

  it("readDayFilings also reports the filer kind from the same submissions list", async () => {
    const { fetchFn } = makeFetch(routes());
    const day = await readDayFilings(CIK, "2026-10-21", fetchFn);
    expect(day.filerKind).toBe("domestic");
    expect(day.filings).toHaveLength(5);
  });
});

describe("fetchFilingDocument", () => {
  const ACC = "0000999999-26-000101";
  const base = `https://www.sec.gov/Archives/edgar/data/${CIK_NUM}/000099999926000101`;

  it("fetches a document's markup with its byte count", async () => {
    const { fetchFn } = makeFetch({ [`${base}/acme-ex991.htm`]: { text: "<p>Revenue rose</p>" } });
    const res = await fetchFilingDocument(CIK, ACC, "acme-ex991.htm", fetchFn);
    expect(res).toEqual({ ok: true, html: "<p>Revenue rose</p>", bytes: 19 });
  });

  it("skips a document over the 16 MB cap with that reason", async () => {
    expect(FILING_DOCUMENT_MAX_BYTES).toBe(16 * 1024 * 1024);
    const { fetchFn } = makeFetch({
      [`${base}/big-10q.htm`]: {
        text: "<p>x</p>",
        headers: { "content-length": String(17 * 1024 * 1024) },
      },
    });
    const res = await fetchFilingDocument(CIK, ACC, "big-10q.htm", fetchFn);
    expect(res).toEqual({ ok: false, reason: "over 16 MB" });
  });

  it("reports a failed fetch with a reason rather than throwing", async () => {
    const { fetchFn } = makeFetch({ [`${base}/gone.htm`]: { status: 404, text: "" } });
    const res = await fetchFilingDocument(CIK, ACC, "gone.htm", fetchFn);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/HTTP 404/);
  });

  it("refuses a non-markup content type", async () => {
    const { fetchFn } = makeFetch({
      [`${base}/a.pdf`]: { text: "%PDF", contentType: "application/pdf" },
    });
    const res = await fetchFilingDocument(CIK, ACC, "a.pdf", fetchFn);
    expect(res.ok).toBe(false);
  });

  it("refuses a file name that is not a plain name in the filing folder", async () => {
    const { fetchFn, calls } = makeFetch({});
    for (const name of ["../x.htm", "a/b.htm", "", "https://evil.example/x.htm"]) {
      const res = await fetchFilingDocument(CIK, ACC, name, fetchFn);
      expect(res.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});

const REAL_HEADER = path.join(
  process.cwd(),
  "tests/fixtures/real/filing-summary/meta-8k-2026-10-21-index-headers.html",
);

describe.skipIf(!existsSync(REAL_HEADER))("real EDGAR header replay (gitignored)", () => {
  it("parses a real 8-K header: Eastern time, items, every document", () => {
    const h = parseFilingHeader(readFileSync(REAL_HEADER, "utf8"));
    expect(h.acceptanceMs).toBe(Date.parse("2026-10-21T20:03:35Z"));
    expect(h.items).toEqual(["1.01", "2.02", "8.01", "9.01"]);
    expect(classifyFiling("8-K", h.items, h.documents, "domestic")).toBe("earnings");
    const kept = h.documents.filter((d) => shouldSkipDocument(d.type, d.fileName) === null);
    expect(kept.map((d) => d.type)).toEqual(["8-K", "EX-10.1", "EX-99.1"]);
    expect(h.documents.length).toBeGreaterThan(kept.length);
  });
});
