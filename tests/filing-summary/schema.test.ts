/**
 * Filing summary output schema (Task 7): the JSON schema the model is asked to
 * fill, and the runtime validator that reads its answer. Synthetic data only.
 */
import { describe, it, expect } from "vitest";
import {
  SECTION_JSON_SCHEMA,
  SCHEMA_VERSION,
  parseSectionOutput,
} from "@/lib/filing-summary/schema";

type Json = Record<string, unknown>;

function figure(id: string, over: Json = {}): Json {
  return {
    id,
    valueText: "$12.99 billion",
    value: 12.99,
    unit: "usd",
    scale: "billions",
    metric: "operating income",
    period: {
      kind: "quarter",
      role: "actual",
      endDate: "2026-09-30",
      fiscalYear: 2026,
      fiscalQuarter: 3,
      anchor: null,
      label: "Q3 2026",
    },
    basis: "reported",
    basisNote: null,
    sourceKind: "quote",
    citationId: "q1",
    label: "Income from operations",
    bogeyKey: null,
    operation: null,
    inputs: [],
    ...over,
  };
}

function claim(id: string, n: number): Json {
  return {
    id,
    text: `Operating income was {f${n}}.`,
    citations: [{ id: `q${n}`, document: "ex99-1.htm", quote: "Income from operations | 12,988", isTableRow: true }],
    figures: [figure(`f${n}`, { citationId: `q${n}` })],
    comparisons: [],
    corrects: null,
  };
}

function bullet(n: number, top = false): Json {
  return { top, routine: false, claims: [claim(`c${n}`, n)] };
}

function output(bullets: Json[]): Json {
  return { headline: "Revenue beat; capex guide raised", bullets };
}

describe("SCHEMA_VERSION", () => {
  it("is 2 (claim and figure caps added to the reader)", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe("SECTION_JSON_SCHEMA", () => {
  /** Every node of the schema tree with its path. */
  function walk(node: unknown, path: string, visit: (n: Json, p: string) => void): void {
    if (Array.isArray(node)) {
      node.forEach((c, i) => walk(c, `${path}[${i}]`, visit));
      return;
    }
    if (node === null || typeof node !== "object") return;
    visit(node as Json, path);
    for (const [k, v] of Object.entries(node as Json)) walk(v, `${path}.${k}`, visit);
  }

  function isObjectNode(n: Json): boolean {
    return n.type === "object" || (Array.isArray(n.type) && (n.type as unknown[]).includes("object"));
  }

  it("closes every object node and requires every property", () => {
    const problems: string[] = [];
    let objects = 0;
    walk(SECTION_JSON_SCHEMA, "$", (n, p) => {
      if (!isObjectNode(n)) return;
      objects += 1;
      if (n.additionalProperties !== false) problems.push(`${p}: additionalProperties`);
      const props = Object.keys((n.properties as Json | undefined) ?? {});
      const required = (n.required as string[] | undefined) ?? [];
      for (const k of props) if (!required.includes(k)) problems.push(`${p}: ${k} not required`);
      for (const k of required) if (!props.includes(k)) problems.push(`${p}: required ${k} has no property`);
    });
    expect(objects).toBeGreaterThanOrEqual(8);
    expect(problems).toEqual([]);
  });

  it("carries no count or numeric/string constraint keywords", () => {
    const banned = ["maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format"];
    const problems: string[] = [];
    walk(SECTION_JSON_SCHEMA, "$", (n, p) => {
      for (const k of banned) if (k in n && typeof n[k] !== "object") problems.push(`${p}.${k}`);
      if (typeof n.minItems === "number" && n.minItems > 1) problems.push(`${p}.minItems`);
    });
    expect(problems).toEqual([]);
  });
});

describe("parseSectionOutput", () => {
  it("accepts a valid fixture and returns it unchanged", () => {
    const raw = output([bullet(1, true), bullet(2)]);
    const res = parseSectionOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual(raw);
    expect(res.notes).toEqual([]);
  });

  it("accepts a bogey figure, a computed figure, a comparison and a correction", () => {
    const c = claim("c1", 1);
    c.figures = [
      figure("f1"),
      figure("f2", { sourceKind: "bogey", citationId: null, label: null, bogeyKey: "b3.revenue_consensus_usd" }),
      figure("f3", { sourceKind: "computed", citationId: null, label: null, operation: "difference", inputs: ["f1", "f2"] }),
    ];
    c.comparisons = [{ left: "f1", leftHigh: null, right: "f2", rightHigh: null, relation: "above" }];
    c.corrects = { claimId: "c9", citationId: "q1" };
    const res = parseSectionOutput(output([{ top: true, routine: false, claims: [c] }]));
    expect(res.ok).toBe(true);
  });

  it("rejects a bad enum", () => {
    const b = bullet(1);
    ((b.claims as Json[])[0].figures as Json[])[0].unit = "euros";
    const res = parseSectionOutput(output([b]));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/unit/);
  });

  it("rejects a bad relation, basis, period kind and anchor", () => {
    for (const mutate of [
      (c: Json) => { c.comparisons = [{ left: "f1", leftHigh: null, right: "f1", rightHigh: null, relation: "beat" }]; },
      (c: Json) => { (c.figures as Json[])[0].basis = "adjusted"; },
      (c: Json) => { ((c.figures as Json[])[0].period as Json).kind = "half"; },
      (c: Json) => { ((c.figures as Json[])[0].period as Json).anchor = "last_quarter"; },
      (c: Json) => { (c.figures as Json[])[0].operation = "average"; },
    ]) {
      const b = bullet(1);
      mutate((b.claims as Json[])[0]);
      expect(parseSectionOutput(output([b])).ok).toBe(false);
    }
  });

  it("rejects a non-finite or non-numeric value and an empty valueText", () => {
    for (const over of [{ value: Number.NaN }, { value: Number.POSITIVE_INFINITY }, { value: "12.99" }, { valueText: "" }, { valueText: "  " }]) {
      const b = bullet(1);
      (b.claims as Json[])[0].figures = [figure("f1", over)];
      expect(parseSectionOutput(output([b])).ok).toBe(false);
    }
  });

  it("rejects a missing field and a wrong type", () => {
    const missing = bullet(1);
    delete ((missing.claims as Json[])[0] as Json).corrects;
    expect(parseSectionOutput(output([missing])).ok).toBe(false);
    const wrong = bullet(1);
    wrong.top = "yes";
    expect(parseSectionOutput(output([wrong])).ok).toBe(false);
    expect(parseSectionOutput(null).ok).toBe(false);
    expect(parseSectionOutput({ headline: "", bullets: [] }).ok).toBe(false);
  });

  it("rejects duplicate claim, citation or figure ids within the section", () => {
    expect(parseSectionOutput(output([bullet(1), bullet(1)])).ok).toBe(false);
    const dupFigure = bullet(1);
    const c = (dupFigure.claims as Json[])[0];
    c.figures = [figure("f1"), figure("f1")];
    expect(parseSectionOutput(output([dupFigure])).ok).toBe(false);
    const dupCite = bullet(1);
    const c2 = (dupCite.claims as Json[])[0];
    c2.citations = [...(c2.citations as Json[]), ...(c2.citations as Json[])];
    expect(parseSectionOutput(output([dupCite])).ok).toBe(false);
  });

  it("demotes a 4th top bullet and notes it", () => {
    const res = parseSectionOutput(output([bullet(1, true), bullet(2, true), bullet(3, true), bullet(4, true), bullet(5)]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bullets.map((b) => b.top)).toEqual([true, true, true, false, false]);
    expect(res.notes.join(" ")).toMatch(/top/i);
  });

  it("truncates 13 bullets to 12 and notes it", () => {
    const res = parseSectionOutput(output(Array.from({ length: 13 }, (_, i) => bullet(i + 1))));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bullets).toHaveLength(12);
    expect(res.value.bullets[11].claims[0].id).toBe("c12");
    expect(res.notes.join(" ")).toMatch(/12/);
  });

  it("keeps the first 2 claims of a bullet, drops the rest and notes it", () => {
    const b = { top: false, routine: false, claims: [claim("c1", 1), claim("c2", 2), claim("c3", 3)] };
    const res = parseSectionOutput(output([b, bullet(4)]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bullets[0].claims.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(res.value.bullets[1].claims.map((c) => c.id)).toEqual(["c4"]);
    expect(res.notes.join(" ")).toMatch(/Dropped 1 claim\(s\) beyond the first 2/);
  });

  it("keeps the first 4 figures of a claim, drops the rest and names them in notes", () => {
    const b = bullet(1);
    const c = (b.claims as Json[])[0];
    c.figures = ["f1", "f2", "f3", "f4", "f5", "f6"].map((id) => figure(id, { citationId: "q1" }));
    const res = parseSectionOutput(output([b]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bullets[0].claims[0].figures.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(res.notes.join(" ")).toMatch(/Claim c1: kept the first 4 of 6 figures; dropped f5, f6/);
  });

  it("leaves a claim with exactly 2 claims and 4 figures untouched, with no notes", () => {
    const b = bullet(1);
    const c = (b.claims as Json[])[0];
    c.figures = ["f1", "f2", "f3", "f4"].map((id) => figure(id, { citationId: "q1" }));
    b.claims = [c, claim("c2", 9)];
    const res = parseSectionOutput(output([b]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bullets[0].claims).toHaveLength(2);
    expect(res.value.bullets[0].claims[0].figures).toHaveLength(4);
    expect(res.notes).toEqual([]);
  });

  it("caps claims before the duplicate-id check, so a duplicate only in a dropped claim does not fail", () => {
    const b = { top: false, routine: false, claims: [claim("c1", 1), claim("c2", 2), claim("c1", 1)] };
    const res = parseSectionOutput(output([b]));
    expect(res.ok).toBe(true);
  });

  it("drops a bullet with no claims and notes it", () => {
    const res = parseSectionOutput(output([bullet(1), { top: false, routine: true, claims: [] }]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bullets).toHaveLength(1);
    expect(res.notes).toHaveLength(1);
  });

  it("strips keys the schema does not name", () => {
    const raw = output([bullet(1)]);
    (raw as Json).extra = "x";
    const res = parseSectionOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect("extra" in res.value).toBe(false);
  });
});
