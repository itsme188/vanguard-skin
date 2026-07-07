import { describe, it, expect } from "vitest";
import { parseSnapshotRow, SNAPSHOT_FIELD_CODES } from "@/lib/ibkr/market-data";

describe("parseSnapshotRow (verified IBKR field-code map, 2026-06-08)", () => {
  it("maps the verified codes for a full stock row", () => {
    // Real AAPL row shape from the live probe (conid 265598).
    const row = {
      conid: 265598,
      "31": "302.94",
      "7283": "24.279%", // implied vol %
      "7284": "23.216%", // historic vol %
      "7293": "316.94", // 52wk high
      "7294": "194.47", // 52wk low
      "7282": "45.0M", // avg vol — must NOT be parsed as a number we keep
    };
    const q = parseSnapshotRow(row);
    expect(q.conid).toBe(265598);
    expect(q.last).toBeCloseTo(302.94, 2);
    expect(q.ivUnderlying).toBeCloseTo(0.24279, 5);
    expect(q.hv30d).toBeCloseTo(0.23216, 5);
    expect(q.week52High).toBe(316.94);
    expect(q.week52Low).toBe(194.47);
  });

  it("returns nulls for absent fields (ETF with no listed-option IV)", () => {
    const row = {
      conid: 96090060,
      "31": "98.50",
      "7284": "11.2%",
      "7293": "105.00",
      "7294": "82.30",
      // no 7283 → IV null
    };
    const q = parseSnapshotRow(row);
    expect(q.last).toBeCloseTo(98.5, 2);
    expect(q.ivUnderlying).toBeNull();
    expect(q.hv30d).toBeCloseTo(0.112, 4);
    expect(q.week52High).toBe(105.0);
  });

  it("yields all-null metrics for an empty/warm-up row but keeps the conid", () => {
    const q = parseSnapshotRow({ conid: 265598 });
    expect(q.conid).toBe(265598);
    expect(q.last).toBeNull();
    expect(q.ivUnderlying).toBeNull();
    expect(q.week52High).toBeNull();
  });

  it("exposes the field codes we request (verified set, no dividend yield)", () => {
    expect(SNAPSHOT_FIELD_CODES).toEqual(["31", "7283", "7284", "7293", "7294"]);
  });

  it("parses C-prefixed (prior close) and H-prefixed (halted) last prices — live probe 2026-07-07", () => {
    // Real rows from the OPT/BOND probe: instruments that haven't traded today
    // return field 31 as "C<prior close>" (e.g. AFRM option "C8.01"). A naive
    // numeric parse dropped these — which also silently skipped equities
    // quoted from prior close.
    expect(parseSnapshotRow({ conid: 760270996, "31": "C8.01" }).last).toBeCloseTo(8.01, 2);
    expect(parseSnapshotRow({ conid: 1, "31": "H12.5" }).last).toBeCloseTo(12.5, 2);
    // Plain numeric still works; magnitude suffixes still rejected.
    expect(parseSnapshotRow({ conid: 1, "31": "46.02" }).last).toBeCloseTo(46.02, 2);
    expect(parseSnapshotRow({ conid: 1, "31": "45.0M" }).last).toBeNull();
    expect(parseSnapshotRow({ conid: 1, "31": "C45.0M" }).last).toBeNull();
    // The prefix allowance is ONLY for field 31 — 52wk fields never carry it.
    expect(parseSnapshotRow({ conid: 1, "7293": "C316.94" }).week52High).toBeNull();
  });
});
