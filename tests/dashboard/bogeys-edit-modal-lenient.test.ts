/**
 * Bogey intake Task F: the edit box reads figures the way people write them
 * (lib/earnings/desk-figure.ts), and offers a "Read from a file or pasted text"
 * panel that fills the boxes without saving. Behaviour is proved through the
 * pure module; the panel's wiring is pinned from source (no DOM harness here).
 * ACME and invented figures only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseManualBogeyForm,
  extraRowsToJson,
  type ExtraRow,
} from "@/app/dashboard/today/bogey-read-fill";
import { parseExtraMetrics } from "@/lib/print-watch/extra-metrics";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const EMPTY_FORM = {
  eps_consensus: "",
  eps_whisper: "",
  revenue_consensus: "",
  revenue_whisper: "",
  expected_move: "",
  guidance_notes: "",
  notes: "",
};

const row = (over: Partial<ExtraRow> = {}): ExtraRow => ({
  id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3",
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

describe("parseManualBogeyForm reads desk wording", () => {
  it("accepts “~$3.35B” and “c. 6%”", () => {
    const r = parseManualBogeyForm({ ...EMPTY_FORM, revenue_consensus: "~$3.35B", expected_move: "c. 6%" });
    expect(r.error).toBeNull();
    expect(r.values.revenue_consensus_usd).toBe(3.35e9);
    expect(r.values.expected_move_pct).toBe(6);
  });

  it("accepts “±6%”, “+/-6%” and “+6” for the expected move", () => {
    for (const raw of ["±6%", "+/-6%", "+6"]) {
      const r = parseManualBogeyForm({ ...EMPTY_FORM, expected_move: raw });
      expect(r.error, raw).toBeNull();
      expect(r.values.expected_move_pct, raw).toBe(6);
    }
  });

  it("stores the expected move as an absolute value and refuses zero", () => {
    expect(parseManualBogeyForm({ ...EMPTY_FORM, expected_move: "-6%" }).values.expected_move_pct).toBe(6);
    const zero = parseManualBogeyForm({ ...EMPTY_FORM, expected_move: "0" });
    expect(zero.values.expected_move_pct).toBeNull();
    expect(zero.error).toMatch(/^Expected move: .*above zero/);
  });

  it("reads EPS as a per-share figure and revenue with scale words", () => {
    const r = parseManualBogeyForm({
      ...EMPTY_FORM,
      eps_consensus: "$1.07",
      eps_whisper: "(0.12)",
      revenue_whisper: "3.9 billion",
    });
    expect(r.error).toBeNull();
    expect(r.values.eps_consensus).toBe(1.07);
    expect(r.values.eps_whisper).toBe(-0.12);
    expect(r.values.revenue_whisper_usd).toBe(3.9e9);
  });

  it("refuses “3.3-3.4B” with the range sentence, prefixed with the field name", () => {
    const r = parseManualBogeyForm({ ...EMPTY_FORM, revenue_consensus: "3.3-3.4B" });
    expect(r.error).toBe("Revenue consensus: That looks like a range (3.3B to 3.4B). Enter one number.");
    expect(r.values.revenue_consensus_usd).toBeNull();
  });

  it("refuses a scale word on EPS", () => {
    const r = parseManualBogeyForm({ ...EMPTY_FORM, eps_consensus: "1.07B" });
    expect(r.error).toMatch(/^EPS consensus: A scale word doesn't fit a per-share figure/);
  });

  it("says how an approximate figure was read", () => {
    const r = parseManualBogeyForm({ ...EMPTY_FORM, revenue_whisper: "108.5B+", expected_move: "~6%", eps_consensus: "1.07" });
    expect(r.error).toBeNull();
    expect(r.approximations).toEqual([
      "Revenue whisper: read “108.5B+” as 108.5B",
      "Expected move: read “~6%” as 6%",
    ]);
  });
});

describe("extraRowsToJson reads each row in its own unit and sends numbers", () => {
  it("“9.59bn” on a usd row serialises to the number", () => {
    const r = extraRowsToJson([row({ consensus: "9.59bn", whisper: "" })]);
    expect(r.errors).toEqual([]);
    const sent = JSON.parse(r.json!);
    expect(sent[0].consensus).toBe(9.59e9);
    expect(sent[0].whisper).toBeNull();
    // …and the shared parser the route runs accepts it unchanged.
    const parsed = parseExtraMetrics(r.json);
    expect(parsed.errors).toEqual([]);
    expect(parsed.specs[0].consensus).toBe(9.59e9);
  });

  it("“1.07B” on a per_share row is refused, naming the metric and the field", () => {
    const r = extraRowsToJson([row({ unit: "per_share", consensus: "1.07B" })]);
    expect(r.json).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Metric 1 consensus: A scale word doesn't fit a per-share figure/);
  });

  it("a pct row's “27.5%” is 27.5, never scaled", () => {
    const r = extraRowsToJson([row({ unit: "pct", consensus: "27.5%", whisper: "c. 28" })]);
    expect(r.errors).toEqual([]);
    const sent = JSON.parse(r.json!);
    expect(sent[0].consensus).toBe(27.5);
    expect(sent[0].whisper).toBe(28);
    expect(r.approximations).toEqual(["Metric 1 whisper: read “c. 28” as 28%"]);
  });

  it("names the second metric's whisper by its position", () => {
    const r = extraRowsToJson([row(), row({ id: "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", whisper: "3.3 to 3.4B" })]);
    expect(r.errors).toEqual(["Metric 2 whisper: That looks like a range (3.3B to 3.4B). Enter one number."]);
  });

  it("no rows is null, as before", () => {
    expect(extraRowsToJson([])).toEqual({ json: null, errors: [], approximations: [] });
  });

  it("keeps the label and definition trimmed, as before", () => {
    const sent = JSON.parse(extraRowsToJson([row({ label: "  Net new ARR ", definition: " d " })]).json!);
    expect(sent[0].label).toBe("Net new ARR");
    expect(sent[0].definition).toBe("d");
  });
});

describe("the edit box wiring (source pins)", () => {
  const src = readFileSync("app/dashboard/today/BogeysEditModal.tsx", "utf8");
  const manualForm = src.slice(anchorIndex(src, "{/* Manual entry form */}"));

  it("puts the read panel at the top of the manual form, above the source label", () => {
    const panel = anchorIndex(manualForm, "Read from a file or pasted text");
    expect(panel).toBeLessThan(anchorIndex(manualForm, 'label="Source label (optional)"'));
    expect(manualForm).toContain('placeholder="Paste the preview text here…"');
  });

  it("posts to the read route through apiFetch and reads the reply with the shared helper", () => {
    const fn = sliceBetween(src, "async function readIntoForm(", "async function save(");
    expect(fn).toContain('apiFetch("/api/earnings/bogeys/read"');
    expect(fn).toContain("readMutationResult<");
    expect(fn).toContain("networkFailureMessage(");
    expect(fn).toContain("fillFormFromRead(");
    // The read writes nothing: no save route, no refresh.
    expect(fn).not.toContain('"/api/earnings/bogeys"');
    expect(fn).not.toContain("router.refresh");
  });

  it("says Reading… while it runs and offers the same file types as the upload button", () => {
    expect(manualForm).toContain('"Reading…"');
    const upload = readFileSync("app/dashboard/today/BogeysUploadButton.tsx", "utf8");
    const accept = /accept="([^"]+)"/.exec(upload)![1];
    expect(src).toContain(accept);
  });

  it("accepts a dropped file", () => {
    expect(manualForm).toMatch(/onDrop=\{/);
    expect(manualForm).toMatch(/onDragOver=\{/);
  });

  it("the Read button never submits the form", () => {
    const at = anchorIndex(manualForm, "onClick={() => void readIntoForm()}");
    expect(manualForm.slice(Math.max(0, at - 200), at)).toContain('type="button"');
  });

  it("the save reads extra rows through the lenient serialiser before the shared parser", () => {
    const save = sliceBetween(src, "async function save(e: React.FormEvent) {", "async function submitActuals(");
    expect(anchorIndex(save, "extraRowsToJson(extraRows)")).toBeLessThan(anchorIndex(save, "parseExtraMetrics("));
    expect(anchorIndex(save, "parseExtraMetrics(")).toBeLessThan(anchorIndex(save, 'apiFetch("/api/earnings/bogeys"'));
  });

  it("shows how an approximate figure was read", () => {
    expect(src).toMatch(/approximations/);
  });
});
