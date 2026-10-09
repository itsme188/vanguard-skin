/**
 * The read-only record an armed Hub row shows once its print is over (sprint 2
 * unit B2).
 *
 * No DOM harness exists in this repo, so the client is proven three ways: the
 * pure helpers that carry every decision, a `react-dom/server` render of the
 * presentational view, and source pins for the wiring. Every identifier and
 * figure below is synthetic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrintRecordView } from "@/app/dashboard/today/LivePrintRow";
import { fetchPrintRecord } from "@/app/dashboard/today/EarningsHubLive";
import {
  lineSourceLabel,
  recordHeaderText,
  recordLineStatus,
  recordLines,
  slotBodyKind,
} from "@/app/dashboard/today/live-print/helpers";
import type { PrintRecordWire } from "@/app/dashboard/today/hub-live/types";
import type { LineStateKind, PrintWatchLine } from "@/lib/print-watch/types";
import { anchorIndex } from "@/tests/helpers/source-anchor";

function line(
  metricId: string,
  state: LineStateKind,
  value: number | null,
  o: Partial<PrintWatchLine> = {},
): PrintWatchLine {
  const isRevenue = metricId === "revenue_q";
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: isRevenue ? "Revenue" : "EPS",
      definition: "d",
      basis: isRevenue ? "gaap" : "non_gaap",
      period: "Q",
      currency: "USD",
      unit: isRevenue ? "usd" : "per_share",
      kind: "point",
      segment: null,
    },
    expected: null,
    state,
    value,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
    ...o,
  };
}

const OUTPUTS: NonNullable<PrintRecordWire["outputs"]> = {
  printSheet: { enabled: true, reason: null },
  sendRecap: { enabled: true, reason: null, state: "unsent", providerMessageId: null },
};

function record(o: Partial<PrintRecordWire> = {}): PrintRecordWire {
  return {
    eventId: 10,
    print: { printId: 7, symbol: "ZZA", eventDate: "2026-01-06", state: "expired" },
    lines: [],
    documents: {},
    outputs: OUTPUTS,
    ...o,
  };
}

const render = (r: PrintRecordWire, dateLabel: string | null = "Tue, Jan 6") =>
  renderToStaticMarkup(
    createElement(PrintRecordView, { record: r, dateLabel, onChanged: async () => undefined }),
  );

describe("slotBodyKind: which body an expanded slot renders", () => {
  const TODAY = "2026-01-08";
  it("a live print always wins, whatever the date and whether or not the row is armed", () => {
    for (const armed of [true, false]) {
      for (const eventDate of ["2026-01-06", TODAY, "2026-01-09", null]) {
        expect(slotBodyKind({ armed, hasLivePrint: true, eventDate, todayEt: TODAY })).toBe("live");
      }
    }
  });
  it("an armed row with no live print and a past date shows the read-only record", () => {
    expect(
      slotBodyKind({ armed: true, hasLivePrint: false, eventDate: "2026-01-07", todayEt: TODAY }),
    ).toBe("record");
  });
  it("an armed row dated today or later is still waiting for its window", () => {
    for (const eventDate of [TODAY, "2026-01-09"]) {
      expect(slotBodyKind({ armed: true, hasLivePrint: false, eventDate, todayEt: TODAY })).toBe(
        "waiting",
      );
    }
  });
  it("an unknown date or an unstarted clock never claims the window has closed", () => {
    expect(
      slotBodyKind({ armed: true, hasLivePrint: false, eventDate: null, todayEt: TODAY }),
    ).toBe("waiting");
    expect(
      slotBodyKind({ armed: true, hasLivePrint: false, eventDate: "2026-01-06", todayEt: null }),
    ).toBe("waiting");
  });
  it("an unarmed row with no print renders nothing", () => {
    expect(
      slotBodyKind({ armed: false, hasLivePrint: false, eventDate: "2026-01-06", todayEt: TODAY }),
    ).toBe("none");
  });
});

describe("record helpers", () => {
  it("keeps accepted and agreed lines only, in sheet order", () => {
    const lines = [
      line("a", "pending", null),
      line("b", "accepted", 1),
      line("c", "conflict", null),
      line("d", "agreed", 2),
      line("e", "single_source", 3),
      line("f", "flash", 4),
      line("g", "retired", 5),
      line("h", "blank", null),
    ];
    expect(recordLines(lines).map((l) => l.metric_id)).toEqual(["b", "d"]);
  });
  it("says in words whether a figure was accepted or only machine-agreed", () => {
    expect(recordLineStatus(line("b", "accepted", 1))).toBe("accepted");
    expect(recordLineStatus(line("d", "agreed", 2))).toBe("agreed, not accepted");
  });
  it("names the document behind a figure, or says there is none", () => {
    expect(lineSourceLabel(line("b", "accepted", 1, { source_doc_id: 12 }), { 12: "edgar-ex99" })).toBe(
      "doc #12 (edgar-ex99)",
    );
    expect(lineSourceLabel(line("b", "accepted", 1, { source_doc_id: 12 }), {})).toBe("doc #12");
    expect(lineSourceLabel(line("b", "accepted", 1), { 12: "edgar-ex99" })).toBe(
      "no document of record",
    );
  });
  it("builds the header without repeating itself for an expired print", () => {
    expect(recordHeaderText("expired", "Tue, Jan 6")).toBe("Window closed · Tue, Jan 6");
    expect(recordHeaderText("parsed", "Tue, Jan 6")).toBe("Window closed · parsed · Tue, Jan 6");
    expect(recordHeaderText("disarmed", null)).toBe("Window closed · disarmed");
  });
});

describe("PrintRecordView", () => {
  it("shows the accepted figures with value, source and snippet, plus the output buttons", () => {
    const html = render(
      record({
        lines: [
          line("eps_adj_q", "agreed", 1.5, { snippet: "adjusted EPS of $1.50" }),
          line("revenue_q", "accepted", 2_000_000_000, {
            source_doc_id: 12,
            snippet: "Revenue $2.0 billion",
          }),
          line("gross_margin", "pending", null),
        ],
        documents: { 12: "edgar-ex99" },
      }),
    );
    expect(html).toContain("Window closed · Tue, Jan 6");
    expect(html).toContain("ZZA");
    expect(html).toContain("Revenue");
    expect(html).toContain("$2.00B");
    expect(html).toContain("doc #12 (edgar-ex99)");
    expect(html).toContain("Revenue $2.0 billion");
    expect(html).toContain("$1.50");
    expect(html).toContain("agreed, not accepted");
    expect(html).not.toContain("gross_margin");
    expect(html).toContain("Print sheet");
    expect(html).toContain("Send recap now");
  });

  it("offers no accept, go, drop or IR-page control", () => {
    const html = render(
      record({ lines: [line("revenue_q", "accepted", 2_000_000_000), line("eps_adj_q", "agreed", 1.5)] }),
    );
    expect(html).not.toMatch(/>\s*(accept|unaccept|accept this)\s*</);
    expect(html).not.toContain("Accept all agreed");
    expect(html).not.toContain("Drop release");
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("Print is live");
    expect(html).not.toContain("IR page");
    // The promote control is owned by the live sheet; here it can never fire.
    const promote = html.slice(anchorIndex(html, "Promote EPS+Rev") - 400, anchorIndex(html, "Promote EPS+Rev"));
    expect(promote.slice(promote.lastIndexOf("<button"))).toContain("disabled");
  });

  it("says so when no print was captured, and shows no table and no buttons", () => {
    const html = render(record({ print: null, outputs: null }));
    expect(html).toContain("No print was captured for this release");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Print sheet");
  });

  it("says so when the print holds no accepted figure, and keeps the output buttons", () => {
    const html = render(record({ lines: [line("revenue_q", "pending", null)] }));
    expect(html).toContain("No figures were accepted on this print");
    expect(html).not.toContain("<table");
    expect(html).toContain("Print sheet");
  });
});

describe("fetchPrintRecord", () => {
  const respond = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("reads the record for one event with a GET", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const result = await fetchPrintRecord(10, async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return respond(200, { success: true, data: record() })();
    });
    expect(calls).toEqual([{ url: "/api/print-watch/record?eventId=10", method: undefined }]);
    expect(result).toEqual({ ok: true, record: record() });
  });

  it("reports the server's own words on a refusal", async () => {
    const result = await fetchPrintRecord(10, respond(500, { success: false, error: "database is busy" }));
    expect(result).toEqual({ ok: false, error: "database is busy" });
  });

  it("reports the status when the body is not the envelope", async () => {
    const result = await fetchPrintRecord(10, async () => new Response("<html>", { status: 502 }));
    expect(result).toEqual({ ok: false, error: "Could not read this print's record (HTTP 502)." });
  });

  it("reports a network failure instead of throwing", async () => {
    const result = await fetchPrintRecord(10, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toEqual({ ok: false, error: "Could not reach the server for this print's record." });
  });
});

describe("source pins", () => {
  const row = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
  const hub = readFileSync("app/dashboard/today/EarningsHubLive.tsx", "utf8");

  it("the record view is built from read-only parts only", () => {
    const view = row.slice(anchorIndex(row, "export function PrintRecordView"));
    for (const banned of ["<GoControls", "<IrPageField", "<LineRow", "<FirstPassRead", "postAccept", "onDrop", "/api/print-watch/accept", "/api/print-watch/drop"]) {
      expect(view, banned).not.toContain(banned);
    }
    expect(view).toContain("<PrintOutputs");
    // Public press-release figures: plain formatting, never the privacy mask.
    expect(view).not.toContain("<Money");
    expect(view).toContain("formatContractRange(");
  });

  it("the slot picks its body through the pure helper and never widens the live feed", () => {
    const slot = hub.slice(anchorIndex(hub, "export function LivePrintSlot"));
    expect(slot).toContain("slotBodyKind(");
    expect(slot).toContain('body === "record"');
    expect(slot).toContain("<PrintRecordPanel");
    expect(hub).toContain("/api/print-watch/record?eventId=");
    // The body mounts only in the visible twin, so the read fires once per expand.
    const i = anchorIndex(slot, "<PrintRecordPanel");
    expect(slot.slice(i - 200, i)).toContain("open && isVisibleTwin");
  });

  it("the client never imports the server outputs module", () => {
    for (const src of [row, hub]) {
      expect(src).not.toMatch(/from "@\/lib\/earnings\/print-(outputs|record)"/);
    }
  });
});
