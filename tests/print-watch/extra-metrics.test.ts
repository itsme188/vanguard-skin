import { describe, it, expect } from "vitest";
import {
  parseExtraMetrics,
  detectExtraMetricConflicts,
  mergeExtraMetrics,
  extraMetricId,
  extraMetricUnitToContractUnit,
  isUuidV4,
  type ExtraMetricSpec,
} from "@/lib/print-watch/extra-metrics";

const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
const B = "0c9e2d71-4a5b-4c6d-9e8f-1a2b3c4d5e6f";

const spec = (o: Partial<ExtraMetricSpec> = {}): ExtraMetricSpec => ({
  id: A, label: "Net new ARR", definition: "Sequential change in annual recurring revenue.",
  unit: "usd", kind: "point", period: "Q", basis: "na", consensus: null, whisper: null, ...o,
});

describe("isUuidV4", () => {
  it("accepts a full v4 uuid and rejects short, wrong-version and garbage ids", () => {
    expect(isUuidV4(A)).toBe(true);
    expect(isUuidV4("5b7a1f42")).toBe(false);
    expect(isUuidV4("5b7a1f42-9c3e-1d18-8f6a-2e0b91c7d4a3")).toBe(false); // version 1
    expect(isUuidV4("")).toBe(false);
  });
});

describe("parseExtraMetrics", () => {
  it("returns nothing and no error for null or an empty string (the common case)", () => {
    expect(parseExtraMetrics(null)).toEqual({ specs: [], errors: [] });
    expect(parseExtraMetrics("   ")).toEqual({ specs: [], errors: [] });
  });
  it("parses a well-formed array and defaults the two optional numbers to null", () => {
    const { specs, errors } = parseExtraMetrics(
      JSON.stringify([{ id: A, label: "Net new ARR", definition: "d", unit: "usd", kind: "point", period: "Q", basis: "na" }]),
    );
    expect(errors).toEqual([]);
    expect(specs).toEqual([spec({ definition: "d" })]);
  });
  it("rejects unknown keys by name rather than silently dropping them", () => {
    const { specs, errors } = parseExtraMetrics(
      JSON.stringify([{ ...spec(), colour: "red" }]),
    );
    expect(specs).toEqual([]);
    expect(errors).toEqual(['Metric 1: unknown field "colour".']);
  });
  it("rejects a bad uuid, an over-long label, an over-long definition and a bad enum", () => {
    const bad = JSON.stringify([
      { ...spec(), id: "nope" },
      { ...spec({ id: B }), label: "x".repeat(61) },
      { ...spec({ id: B }), definition: "y".repeat(301) },
      { ...spec({ id: B }), unit: "eur" },
    ]);
    const { specs, errors } = parseExtraMetrics(bad);
    expect(specs).toEqual([]);
    expect(errors).toEqual([
      "Metric 1: id must be a full uuid (v4).",
      "Metric 2: label must be 1 to 60 characters.",
      "Metric 3: definition must be 300 characters or fewer.",
      "Metric 4: unit must be one of usd, per_share, pct, count.",
    ]);
  });
  it("rejects a duplicate id inside ONE bogey row", () => {
    const { specs, errors } = parseExtraMetrics(JSON.stringify([spec(), spec({ label: "Twin" })]));
    expect(specs).toEqual([]);
    expect(errors).toEqual([`Metric 2: id ${A} appears twice on this sheet.`]);
  });
  it("rejects non-JSON and a non-array top level without throwing", () => {
    expect(parseExtraMetrics("{not json").errors).toEqual(["Extra metrics must be valid JSON."]);
    expect(parseExtraMetrics('{"id":"x"}').errors).toEqual(["Extra metrics must be a JSON array."]);
  });

  // --- unit-aware strict parsing (Codex round 1, finding 3) -----------------
  const one = (over: Record<string, unknown>) => parseExtraMetrics(JSON.stringify([{ ...spec(), ...over }]));

  it("reads the usd grammar — and ONLY the usd grammar — for a usd row", () => {
    expect(one({ consensus: "3.85B" }).specs[0].consensus).toBe(3_850_000_000);
    expect(one({ consensus: "850M" }).specs[0].consensus).toBe(850_000_000);
    expect(one({ consensus: "$3,850,000,000" }).specs[0].consensus).toBe(3_850_000_000);
    expect(one({ consensus: "-2.5k" }).specs[0].consensus).toBe(-2_500);
    expect(one({ consensus: 3_850_000_000 }).specs[0].consensus).toBe(3_850_000_000);
  });
  it("NEVER coerces: true, a bad unit spelling and scientific notation are errors, not numbers", () => {
    expect(one({ consensus: true }).errors).toEqual([
      "Metric 1: consensus must be a dollar figure like 3.85B, 850M or $3,850,000,000, or empty.",
    ]);
    expect(one({ consensus: "6%" }).errors).toEqual([
      "Metric 1: consensus must be a dollar figure like 3.85B, 850M or $3,850,000,000, or empty.",
    ]);
    expect(one({ unit: "count", consensus: "1e3" }).errors).toEqual([
      "Metric 1: consensus must be a plain whole or decimal number, or empty.",
    ]);
    expect(one({ consensus: "1e400" }).errors).toEqual([
      "Metric 1: consensus must be a dollar figure like 3.85B, 850M or $3,850,000,000, or empty.",
    ]);
    expect(one({ consensus: Number.POSITIVE_INFINITY }).errors).toEqual([]);   // JSON cannot carry Infinity
  });
  it("treats a whitespace-only string as NO bogey — null, never Number('  ') === 0", () => {
    const { specs, errors } = one({ consensus: "  ", whisper: "" });
    expect(errors).toEqual([]);
    expect(specs[0].consensus).toBeNull();
    expect(specs[0].consensus).not.toBe(0);
    expect(specs[0].whisper).toBeNull();
  });
  it("strips ONE trailing % on a pct row and never scales it", () => {
    expect(one({ unit: "pct", consensus: "27.5%" }).specs[0].consensus).toBe(27.5);
    expect(one({ unit: "pct", consensus: "27.5" }).specs[0].consensus).toBe(27.5);
    expect(one({ unit: "pct", consensus: "27.5%%" }).errors).toHaveLength(1);
  });
  it("takes a plain decimal for per_share and count, and refuses a dollar sign there", () => {
    expect(one({ unit: "per_share", consensus: "0.46" }).specs[0].consensus).toBe(0.46);
    expect(one({ unit: "count", consensus: "12000" }).specs[0].consensus).toBe(12_000);
    expect(one({ unit: "per_share", consensus: "$0.46" }).errors).toHaveLength(1);
  });
  it("does not second-guess the numbers when the unit itself is unreadable", () => {
    const { errors } = one({ unit: "eur", consensus: "nonsense" });
    expect(errors).toEqual(["Metric 1: unit must be one of usd, per_share, pct, count."]);
  });
});

describe("detectExtraMetricConflicts", () => {
  it("is empty when one id appears once, or twice in full agreement", () => {
    expect(detectExtraMetricConflicts([{ id: 1, specs: [spec()] }])).toEqual([]);
    expect(detectExtraMetricConflicts([
      { id: 1, specs: [spec({ consensus: 5 })] },
      { id: 2, specs: [spec({ consensus: 7, label: "different label is fine" })] },
    ])).toEqual([]);
  });
  it("names the id and every disagreeing semantic field, sorted", () => {
    expect(detectExtraMetricConflicts([
      { id: 1, specs: [spec()] },
      { id: 2, specs: [spec({ unit: "pct", basis: "gaap" })] },
    ])).toEqual([{ id: A, fields: ["basis", "unit"] }]);
  });
});

describe("mergeExtraMetrics", () => {
  it("keeps the first row's semantics, fills numbers first-non-null, and names the consensus row", () => {
    const merged = mergeExtraMetrics([
      { id: 1, sourceLabel: "Sheet A", specs: [spec({ consensus: null, whisper: 3 })] },
      { id: 2, sourceLabel: "Sheet B", specs: [spec({ consensus: 11, whisper: 9 })] },
    ]);
    expect(merged.conflicts).toEqual([]);
    expect(merged.specs).toEqual([spec({ consensus: 11, whisper: 3 })]);
    expect(merged.sourceLabelById).toEqual({ [A]: "Sheet B" });
  });
  it("omits a conflicting id entirely and reports it", () => {
    const merged = mergeExtraMetrics([
      { id: 1, sourceLabel: "A", specs: [spec()] },
      { id: 2, sourceLabel: "B", specs: [spec({ kind: "range" }), spec({ id: B, label: "Backlog" })] },
    ]);
    expect(merged.specs.map((s) => s.id)).toEqual([B]);
    expect(merged.conflicts).toEqual([{ id: A, fields: ["kind"] }]);
  });
});

describe("id and unit mapping", () => {
  it("builds x_<uuid>_<period> and maps pct to percent", () => {
    expect(extraMetricId(spec({ period: "FY_guide" }))).toBe(`x_${A}_FY_guide`);
    expect(extraMetricUnitToContractUnit("pct")).toBe("percent");
    expect(["usd", "per_share", "count"].map(extraMetricUnitToContractUnit)).toEqual(["usd", "per_share", "count"]);
  });
});
