/**
 * The one copy of the filing summary's owner-facing words (lib/filing-summary/labels.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { REASON_CODES } from "@/lib/filing-summary/evaluate";
import { SUMMARY_CHOICES, choiceLabel } from "@/lib/filing-summary/choice";
import { STATUS_SEVERITY, type ClaimStatus, type StatusCounts } from "@/lib/filing-summary/types";
import type { OperandDescriptor, ViewComparisonCheck } from "@/lib/filing-summary/view";
import {
  ROUGH_COST_BY_CHOICE,
  bogeyValueText,
  choiceValue,
  comparisonLine,
  countsText,
  errorWords,
  hasReasonText,
  modelQuoteLine,
  newRequestKey,
  optionText,
  reasonText,
  roughCostText,
  sectionErrorSentence,
  statusLabel,
  statusTone,
} from "@/lib/filing-summary/labels";

const ZERO: StatusCounts = { claims: 0, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0 };

describe("reasonText", () => {
  it("has its own sentence for every code evaluate.ts can emit", () => {
    expect(REASON_CODES.length).toBeGreaterThan(10);
    for (const code of REASON_CODES) {
      expect(hasReasonText(code), code).toBe(true);
      expect(reasonText(code).endsWith("."), code).toBe(true);
    }
    expect(reasonText("no_such_code")).toBe("This could not be confirmed against the filing.");
    expect(reasonText("metric_unconfirmed")).toBe(
      "The number is in the cited line, but the line's label does not name this metric.",
    );
  });
});

describe("statuses and counts", () => {
  it("tone follows STATUS_SEVERITY: danger, warning, neutral, up", () => {
    const want = { danger: "down", warning: "warn", muted: "neutral", ok: "up" } as const;
    for (const s of Object.keys(STATUS_SEVERITY) as ClaimStatus[]) {
      expect(statusTone(s), s).toBe(want[STATUS_SEVERITY[s]]);
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
    expect(statusLabel("figure_not_bound")).toBe("Figure not tied to the filing");
  });

  it("counts leave zero parts out", () => {
    expect(countsText({ ...ZERO, claims: 12, checked: 9, contradicted: 1, unconfirmed: 2 })).toBe(
      "12 claims · 9 checked · 1 contradicted · 2 unconfirmed",
    );
    expect(countsText({ ...ZERO, claims: 1, checked: 1 })).toBe("1 claim · 1 checked");
  });
});

describe("choices and cost", () => {
  it("five choices, each with its rough cost", () => {
    const expected: Record<string, string> = {
      "Sonnet · medium": "Sonnet costs half as much per token as Opus",
      "Opus · medium": "less than Opus · high",
      "Opus · high": "about $0.80 per 8-K (measured); long filings cost more",
      "Fable · medium": "Fable costs 2.5 times as much per token as Opus",
      "Fable · high": "Fable costs 2.5 times as much per token as Opus",
    };
    for (const c of SUMMARY_CHOICES) expect(roughCostText(c), choiceLabel(c)).toBe(expected[choiceLabel(c)]);
    expect(Object.keys(ROUGH_COST_BY_CHOICE).sort()).toEqual(SUMMARY_CHOICES.map(choiceValue).sort());
    // The pre-typed-figures estimates are gone everywhere (browser pass ruling).
    for (const text of Object.values(ROUGH_COST_BY_CHOICE)) expect(text).not.toMatch(/\$0\.(11|32|68)\b/);
  });

  it("option text carries the now-label", () => {
    expect(optionText({ label: "Fable · high", nowLabel: "Fable · now 5.1" })).toBe("Fable · high — now 5.1");
    expect(optionText({ label: "Sonnet · medium", nowLabel: "Sonnet · not available" })).toBe("Sonnet · medium — not available");
  });
});

describe("section failures", () => {
  it("sentences keep the shareable page's words; clauses for the panel", () => {
    expect(sectionErrorSentence("timeout")).toBe("Not summarised: the model call timed out.");
    expect(sectionErrorSentence("truncated")).toBe("Not summarised: the answer was cut off at the length limit.");
    expect(sectionErrorSentence("awaiting_retry")).toBe("Waiting for Retry: this filing arrived after the run failed.");
    expect(sectionErrorSentence(null)).toBe("Not summarised.");
    expect(sectionErrorSentence("odd")).toBe("Not summarised.");
    expect(errorWords("timeout")).toBe("the model call timed out");
    expect(errorWords(null)).toBe("no reason recorded");
  });
});

describe("comparison line (ruling A)", () => {
  const filing = (id: string, text: string): OperandDescriptor => ({ figureId: id, displayText: text, source: "filing" });
  const bogey: OperandDescriptor = {
    figureId: "f2", displayText: "$64.57B", source: "bogey",
    bogey: { label: "Revenue consensus", value: 64.57e9, unit: "usd", provenance: "Finnhub consensus", asOf: "2026-10-20" },
  };
  const cc = (p: Partial<ViewComparisonCheck>): ViewComparisonCheck => ({
    relation: "below", verdict: "contradicted", difference: 0.031, differencePct: 0.05, shownText: "+0.05%", reasons: [],
    left: filing("f1", "$64.601B"), right: bogey, ...p,
  });

  it("a contradicted comparison states what the arithmetic shows, with the bogey's source and date", () => {
    expect(comparisonLine(cc({}))).toBe("filing: $64.601B is above $64.57B (Finnhub consensus, 2026-10-20), +0.05%");
  });

  it("a matching comparison repeats the stated relation", () => {
    expect(comparisonLine(cc({ verdict: "matches", relation: "in_line", shownText: "+0.05%" }))).toBe(
      "filing: $64.601B is in line with $64.57B (Finnhub consensus, 2026-10-20), +0.05%",
    );
  });

  it("an undecided comparison only compares; ranges and missing operands read plainly", () => {
    expect(
      comparisonLine(cc({
        verdict: "periods_differ", relation: "raised", shownText: null,
        left: filing("f3", "$1.10"), leftHigh: filing("f4", "$1.20"), right: null,
      })),
    ).toBe("filing: $1.10–$1.20 compared with a figure that was not supplied");
    expect(comparisonLine(cc({ relation: "raised", difference: -0.1, right: filing("f5", "$1.25") }))).toBe(
      "filing: $64.601B is lowered from $1.25, +0.05%",
    );
  });

  it("narrowed reads the change in range width: wider, same width, narrower", () => {
    const base = { relation: "narrowed" as const, left: filing("a", "$1.00"), leftHigh: filing("b", "$1.30"), right: filing("c", "$1.10"), rightHigh: filing("d", "$1.30") };
    expect(comparisonLine(cc({ ...base, verdict: "contradicted", difference: 0.1, shownText: "+50.00% in width" }))).toBe(
      "filing: $1.00–$1.30 is wider than $1.10–$1.30, +50.00% in width",
    );
    expect(comparisonLine(cc({ ...base, verdict: "contradicted", difference: 0, shownText: "0.00% in width" }))).toBe(
      "filing: $1.00–$1.30 is the same width as $1.10–$1.30, 0.00% in width",
    );
    expect(comparisonLine(cc({ ...base, verdict: "matches", difference: -0.1, shownText: "-33.33% in width" }))).toBe(
      "filing: $1.00–$1.30 is narrower than $1.10–$1.30, -33.33% in width",
    );
    // Never a raised/lowered word for a width change.
    expect(comparisonLine(cc({ ...base, verdict: "contradicted", difference: 0.1 }))).not.toMatch(/raised|lowered/);
  });

  it("unchanged: matches reads unchanged, contradicted reads differs from", () => {
    const base = { relation: "unchanged" as const, left: filing("a", "$1.00"), leftHigh: filing("b", "$1.30"), right: filing("c", "$1.10"), rightHigh: filing("d", "$1.30") };
    expect(comparisonLine(cc({ ...base, verdict: "matches", difference: 0, shownText: "0.00% at midpoint" }))).toBe(
      "filing: $1.00–$1.30 is unchanged from $1.10–$1.30, 0.00% at midpoint",
    );
    expect(comparisonLine(cc({ ...base, verdict: "contradicted", difference: -0.05, shownText: "-4.17% at midpoint" }))).toBe(
      "filing: $1.00–$1.30 differs from $1.10–$1.30, -4.17% at midpoint",
    );
    expect(comparisonLine(cc({ ...base, verdict: "contradicted", difference: 0, shownText: "0.00% at midpoint" }))).not.toMatch(/unchanged/);
  });

  it("a contradicted raised whose arithmetic says lowered reads lowered (midpoint sign)", () => {
    expect(
      comparisonLine(cc({
        relation: "raised", verdict: "contradicted", difference: -0.05, shownText: "-4.17% at midpoint",
        left: filing("a", "$1.10"), leftHigh: filing("b", "$1.20"), right: filing("c", "$1.15"), rightHigh: filing("d", "$1.25"),
      })),
    ).toBe("filing: $1.10–$1.20 is lowered from $1.15–$1.25, -4.17% at midpoint");
    expect(
      comparisonLine(cc({ relation: "raised", verdict: "matches", difference: 0.05, shownText: "+4.17% at midpoint",
        left: filing("a", "$1.20"), right: filing("c", "$1.15") })),
    ).toBe("filing: $1.20 is raised from $1.15, +4.17% at midpoint");
  });

  it("points: a contradicted in-line reads the sign; a matching one keeps its words", () => {
    expect(comparisonLine(cc({ relation: "in_line", verdict: "contradicted", difference: -2, shownText: "-3.10%", right: filing("r", "$64.57B") }))).toBe(
      "filing: $64.601B is below $64.57B, -3.10%",
    );
    expect(comparisonLine(cc({ relation: "above", verdict: "contradicted", difference: 0, shownText: "0.00%", right: filing("r", "$64.601B") }))).toBe(
      "filing: $64.601B is in line with $64.601B, 0.00%",
    );
  });

  it("model quote line", () => {
    expect(modelQuoteLine("a quote")).toBe("Quote as the model gave it: “a quote”");
  });

  it("bogey value text", () => {
    expect(bogeyValueText({ value: 64.57e9, unit: "usd" })).toBe("$64.57B");
    expect(bogeyValueText({ value: 1.85, unit: "usd_per_share" })).toBe("$1.85");
    expect(bogeyValueText({ value: 26, unit: "percent" })).toBe("26.0%");
  });
});

describe("newRequestKey (5)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses randomUUID when present", () => {
    const a = newRequestKey();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newRequestKey()).not.toBe(a);
  });

  it("falls back to 16 random bytes as hex where randomUUID is missing (plain http)", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (b: Uint8Array) => real.getRandomValues(b) });
    const a = newRequestKey();
    const b = newRequestKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("labels.ts stays a plain module", () => {
  it("no client directive and value imports only from types.ts", () => {
    const src = readFileSync("lib/filing-summary/labels.ts", "utf8");
    expect(src).not.toMatch(/^"use client"/);
    const valueImports = [...src.matchAll(/^import (?!type )[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(valueImports).toEqual(["./types"]);
  });
});
