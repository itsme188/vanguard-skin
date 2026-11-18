/**
 * Bogey intake Task F: what a read from a file or pasted text does to the edit
 * box. Pure helper, so no DOM harness is needed. ACME and invented figures only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  fillFormFromRead,
  describeReadFill,
  type ExtraRow,
  type FormState,
} from "@/app/dashboard/today/bogey-read-fill";
import { formatDeskFigure, readDeskFigure, type DeskFigureKind } from "@/lib/earnings/desk-figure";
import type { ReadBogeysResult } from "@/lib/earnings/read-bogeys-types";

const EMPTY_FORM: FormState = {
  source_label: "",
  eps_consensus: "",
  eps_whisper: "",
  revenue_consensus: "",
  revenue_whisper: "",
  expected_move: "",
  guidance_notes: "",
  notes: "",
};

const ARR_ID = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
const MARGIN_ID = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

function read(over: Partial<ReadBogeysResult> = {}, values: Partial<ReadBogeysResult["values"]> = {}): ReadBogeysResult {
  return {
    found: true,
    values: {
      eps_consensus: null,
      eps_whisper: null,
      revenue_consensus_usd: null,
      revenue_whisper_usd: null,
      expected_move_pct: null,
      guidance_notes: null,
      notes: null,
      ...values,
    },
    extraMetrics: [],
    suggestedLabel: "ACME preview 2026-11-16",
    modelId: "test-model",
    message: "Found figures for ACME in the pasted text. Check them, then Save.",
    ...over,
  };
}

const arrRow = (over: Partial<ExtraRow> = {}): ExtraRow => ({
  id: ARR_ID,
  label: "Net new ARR",
  definition: "",
  unit: "usd",
  kind: "point",
  period: "Q",
  basis: "na",
  consensus: "",
  whisper: "",
  ...over,
});

describe("format_round_trips", () => {
  const cases: Array<[number, DeskFigureKind]> = [
    [3.35e9, "usd"],
    [8.5e8, "usd"],
    [1.085e11, "usd"],
    [3.35e9 + 1234, "usd"],
    [1.07, "per_share"],
    [-0.12, "per_share"],
    [28, "pct"],
    [6.5, "pct"],
    [1200, "count"],
  ];
  it.each(cases)("%s (%s) reads back to itself", (value, kind) => {
    expect(readDeskFigure(formatDeskFigure(value, kind), kind).value).toBe(value);
  });
  it("writes the short desk form", () => {
    expect(formatDeskFigure(3.35e9, "usd")).toBe("3.35B");
    expect(formatDeskFigure(8.5e8, "usd")).toBe("850M");
  });
});

describe("fillFormFromRead", () => {
  it("fills_empty_fields_only, in desk text", () => {
    const r = fillFormFromRead(
      EMPTY_FORM,
      [],
      read({}, {
        eps_consensus: 1.07,
        eps_whisper: 1.12,
        revenue_consensus_usd: 3.35e9,
        revenue_whisper_usd: 8.5e8,
        expected_move_pct: 6,
        guidance_notes: "FY guide above the street",
        notes: "a note",
      }),
    );
    expect(r.form).toEqual({
      source_label: "ACME preview 2026-11-16",
      eps_consensus: "1.07",
      eps_whisper: "1.12",
      revenue_consensus: "3.35B",
      revenue_whisper: "850M",
      expected_move: "6",
      guidance_notes: "FY guide above the street",
      notes: "a note",
    });
    expect(r.filled).toEqual([
      "Source label",
      "EPS consensus",
      "EPS whisper",
      "Revenue consensus",
      "Revenue whisper",
      "Expected move",
      "Guidance bogeys",
      "Notes",
    ]);
    expect(r.keptYours).toEqual([]);
  });

  it("keeps_typed_values_and_reports_them", () => {
    const form = { ...EMPTY_FORM, eps_consensus: "0.99", revenue_consensus: "3.2B" };
    const r = fillFormFromRead(form, [], read({}, { eps_consensus: 1.07, revenue_consensus_usd: 3.35e9, eps_whisper: 1.1 }));
    expect(r.form.eps_consensus).toBe("0.99");
    expect(r.form.revenue_consensus).toBe("3.2B");
    expect(r.form.eps_whisper).toBe("1.1");
    expect(r.keptYours).toEqual(["EPS consensus", "Revenue consensus"]);
    expect(r.filled).toContain("EPS whisper");
    expect(r.filled).not.toContain("EPS consensus");
  });

  it("a typed value equal to the read one is neither filled nor reported as kept", () => {
    const form = { ...EMPTY_FORM, revenue_consensus: "$3,350M" };
    const r = fillFormFromRead(form, [], read({}, { revenue_consensus_usd: 3.35e9 }));
    expect(r.form.revenue_consensus).toBe("$3,350M");
    expect(r.keptYours).toEqual([]);
    expect(r.filled).not.toContain("Revenue consensus");
  });

  it("does not overwrite a typed label", () => {
    const r = fillFormFromRead({ ...EMPTY_FORM, source_label: "My sheet" }, [], read({}, { eps_consensus: 1 }));
    expect(r.form.source_label).toBe("My sheet");
    expect(r.filled).not.toContain("Source label");
    expect(r.keptYours).not.toContain("Source label");
  });

  it("sets_label_when_blank (whitespace counts as blank)", () => {
    const r = fillFormFromRead({ ...EMPTY_FORM, source_label: "  " }, [], read({}, { eps_consensus: 1 }));
    expect(r.form.source_label).toBe("ACME preview 2026-11-16");
  });

  it("reuses_existing_line_id_fills_blank_whisper and keeps the typed consensus", () => {
    const rows = [arrRow({ consensus: "300M" })];
    const r = fillFormFromRead(
      EMPTY_FORM,
      rows,
      read({
        extraMetrics: [
          { id: ARR_ID, label: "Net new ARR", definition: "d", unit: "usd", kind: "point", period: "Q", basis: "na", consensus: 3.2e8, whisper: 3.3e8 },
        ],
      }),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual(arrRow({ consensus: "300M", whisper: "330M" }));
    expect(r.filled).toContain("Net new ARR whisper");
    expect(r.keptYours).toContain("Net new ARR consensus");
  });

  it("appends_new_line by its own id, with figures in its unit's desk text", () => {
    const r = fillFormFromRead(
      EMPTY_FORM,
      [arrRow()],
      read({
        extraMetrics: [
          { id: MARGIN_ID, label: "Op margin", definition: "Non-GAAP operating margin", unit: "pct", kind: "point", period: "Q", basis: "non_gaap", consensus: 27.5, whisper: null },
        ],
      }),
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual(arrRow());
    expect(r.rows[1]).toEqual({
      id: MARGIN_ID,
      label: "Op margin",
      definition: "Non-GAAP operating margin",
      unit: "pct",
      kind: "point",
      period: "Q",
      basis: "non_gaap",
      consensus: "27.5",
      whisper: "",
    });
    expect(r.filled).toContain("Op margin");
  });

  it("does not mutate its inputs", () => {
    const form = { ...EMPTY_FORM };
    const rows = [arrRow()];
    fillFormFromRead(form, rows, read({ extraMetrics: [{ ...arrRow(), consensus: 1e8, whisper: 2e8 } as never] }, { eps_consensus: 1 }));
    expect(form).toEqual(EMPTY_FORM);
    expect(rows[0]).toEqual(arrRow());
  });

  it("a read that found nothing changes nothing", () => {
    const r = fillFormFromRead(EMPTY_FORM, [], read({ found: false, message: "No figures for ACME were found in the pasted text." }));
    expect(r.form).toEqual(EMPTY_FORM);
    expect(r.rows).toEqual([]);
    expect(r.filled).toEqual([]);
    expect(r.keptYours).toEqual([]);
  });
});

describe("describeReadFill", () => {
  it("names what was filled and what was kept", () => {
    expect(describeReadFill(["EPS consensus", "Revenue whisper"], ["Notes"])).toBe(
      "Filled: EPS consensus, Revenue whisper · Kept your: Notes — check and Save.",
    );
    expect(describeReadFill(["EPS consensus"], [])).toBe("Filled: EPS consensus — check and Save.");
  });
  it("says so when nothing new could be filled", () => {
    expect(describeReadFill([], ["EPS consensus"])).toBe(
      "Nothing filled · Kept your: EPS consensus — check and Save.",
    );
    expect(describeReadFill([], [])).toBe("Nothing new to fill: the boxes already hold these figures.");
  });
});

describe("the helper stays pure", () => {
  it("does not import the modal or React at runtime", () => {
    const src = readFileSync("app/dashboard/today/bogey-read-fill.ts", "utf8");
    expect(src).not.toMatch(/from "\.\/BogeysEditModal"/);
    expect(src).not.toMatch(/from "react"/);
    expect(src).toMatch(/import type \{ ReadBogeysResult \} from "@\/lib\/earnings\/read-bogeys-types"/);
  });
});
