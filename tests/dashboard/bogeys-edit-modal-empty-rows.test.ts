/**
 * BogeysEditModal — empty rows, the manual form's validation, the actuals
 * form's own message slot, extra metrics on the card and the delete target
 * (qa: all-empty-newsletter-bogey-counts-as-coverage, empty-manual-bogey-
 * saved-flips-chip, unparseable-values-silently-dropped, actuals-validation-
 * message-detached, save-actuals-feedback-renders-far-from-button, saved-
 * extra-metric-never-shown, delete-links-16px).
 *
 * No DOM harness in this repo: behaviour is proved through the modal's pure
 * exports, wiring is pinned from source. Invented figures only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  bogeyCardHasContent,
  parseManualBogeyForm,
  formatExtraMetricLine,
  NOTHING_TO_SAVE,
} from "@/app/dashboard/today/BogeysEditModal";
import { bogeyHasContent, CONTENT_COLUMNS } from "@/lib/mutations/earnings-bogeys";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/today/BogeysEditModal.tsx", "utf8");

const sample: Record<(typeof CONTENT_COLUMNS)[number], unknown> = {
  eps_consensus: 1.5,
  eps_whisper: 1.6,
  revenue_consensus_usd: 2_000_000_000,
  revenue_whisper_usd: 2_100_000_000,
  expected_move_pct: 6,
  eps_consensus_vendor: 1.4,
  segment_breakdown_json: '{"Cloud":{"consensus":1000000000}}',
  guidance_notes: "guide above the street",
  notes: "a note",
  extra_metrics_json: '[{"id":"x"}]',
};

describe("bogeyCardHasContent — the client copy of the write path's rule", () => {
  it("an all-null row is empty", () => {
    const row = Object.fromEntries(CONTENT_COLUMNS.map((c) => [c, null]));
    expect(bogeyCardHasContent(row)).toBe(false);
    expect(bogeyHasContent(row)).toBe(false);
  });

  it.each(CONTENT_COLUMNS.map((c) => [c]))("agrees with bogeyHasContent when only %s is set", (col) => {
    const row = { [col]: sample[col] } as Parameters<typeof bogeyCardHasContent>[0];
    expect(bogeyCardHasContent(row)).toBe(true);
    expect(bogeyHasContent(row)).toBe(true);
  });

  it.each([{ notes: "  " }, { guidance_notes: "" }, { segment_breakdown_json: "{}" }, { extra_metrics_json: "[]" }, { eps_consensus: 0 }])(
    "agrees on the edge %j",
    (row) => {
      expect(bogeyCardHasContent(row)).toBe(bogeyHasContent(row));
    },
  );
});

describe("the existing-bogeys list neither lists nor counts an empty row", () => {
  it("counts and maps the filtered rows", () => {
    expect(src).toContain("const shown = existing.filter(bogeyCardHasContent);");
    expect(src).toContain("Existing bogeys ({shown.length})");
    expect(src).toContain("{shown.map((b) => (");
    expect(src).not.toContain("Existing bogeys ({existing.length})");
    expect(src).not.toContain("{existing.map((b) => (");
  });
  it("the empty state follows the filtered list, so a lone empty row reads as none", () => {
    expect(src).toContain("{shown.length === 0 ? (");
  });
});

const EMPTY_FORM = {
  eps_consensus: "",
  eps_whisper: "",
  revenue_consensus: "",
  revenue_whisper: "",
  expected_move: "",
  guidance_notes: "",
  notes: "",
};

describe("parseManualBogeyForm", () => {
  it("an untouched form is empty, with no error", () => {
    const r = parseManualBogeyForm(EMPTY_FORM);
    expect(r.empty).toBe(true);
    expect(r.error).toBeNull();
  });

  it("whitespace-only prose is still empty", () => {
    expect(parseManualBogeyForm({ ...EMPTY_FORM, notes: "  ", guidance_notes: " " }).empty).toBe(true);
  });

  it("reads the placeholder shapes", () => {
    const r = parseManualBogeyForm({
      ...EMPTY_FORM,
      eps_consensus: "0.46",
      eps_whisper: "$0.50",
      revenue_consensus: "$3.85B",
      revenue_whisper: "3900M",
      expected_move: "±6%",
      notes: " a note ",
    });
    expect(r.error).toBeNull();
    expect(r.empty).toBe(false);
    expect(r.values).toEqual({
      eps_consensus: 0.46,
      eps_whisper: 0.5,
      revenue_consensus_usd: 3_850_000_000,
      revenue_whisper_usd: 3_900_000_000,
      expected_move_pct: 6,
      guidance_notes: null,
      notes: "a note",
    });
  });

  it.each([
    ["eps_consensus", "abc", /^EPS consensus must be a number/],
    ["eps_whisper", "n/a", /^EPS whisper must be a number/],
    ["revenue_consensus", "lots", /^Revenue consensus must be a number/],
    ["revenue_whisper", "3.9 billion", /^Revenue whisper must be a number/],
    ["expected_move", "big", /^Expected move must be a percent above zero/],
    ["expected_move", "0", /^Expected move must be a percent above zero/],
  ])("a typed %s of %j is an error naming the field, never a silent blank", (field, value, message) => {
    const r = parseManualBogeyForm({ ...EMPTY_FORM, notes: "a real note", [field]: value });
    expect(r.error).toMatch(message);
  });

  it("names the FIRST unreadable field", () => {
    const r = parseManualBogeyForm({ ...EMPTY_FORM, eps_consensus: "abc", revenue_consensus: "lots" });
    expect(r.error).toMatch(/^EPS consensus/);
  });
});

describe("the manual save refuses before it posts", () => {
  const save = sliceBetween(src, "async function save(e: React.FormEvent) {", "async function submitActuals(");
  it("stops on a parse error and on an empty form, both ahead of the POST", () => {
    const post = anchorIndex(save, 'apiFetch("/api/earnings/bogeys"');
    const parseStop = anchorIndex(save, "setError(parsed.error);");
    const emptyStop = anchorIndex(save, "if (parsed.empty && extra_metrics_json === null) {");
    expect(parseStop).toBeLessThan(post);
    expect(emptyStop).toBeLessThan(post);
    expect(save.slice(emptyStop, post)).toContain("NOTHING_TO_SAVE");
    expect(save.slice(emptyStop, post)).toContain("return;");
  });
  it("uses the server's own wording", () => {
    const route = readFileSync("app/api/earnings/bogeys/route.ts", "utf8");
    expect(route).toContain(JSON.stringify(NOTHING_TO_SAVE));
  });
  it("sends the parsed values, not a second hand-rolled parse", () => {
    expect(save).toContain("...parsed.values,");
    expect(save).not.toMatch(/parseLargeUSD\(form\./);
  });
});

describe("the actuals form reports beside its own button", () => {
  const actualsFns = sliceBetween(src, "async function submitActuals(", "async function remove(");
  const actualsForm = sliceBetween(src, "<form onSubmit={saveActuals}", "{/* Manual entry form */}");

  it("every actuals outcome goes to the actuals slot, none to the shared footer slot", () => {
    expect(actualsFns).toContain("setActualsError(validationError);");
    expect(actualsFns).not.toMatch(/[^s]setError\(/);
    expect(actualsFns).not.toMatch(/^\s*setError\(/m);
  });

  it("the slot renders inside the actuals form, above its buttons, as an alert", () => {
    const slot = anchorIndex(actualsForm, "{actualsError && (");
    const button = anchorIndex(actualsForm, '"Save actuals"');
    expect(slot).toBeLessThan(button);
    expect(actualsForm.slice(slot, slot + 120)).toContain('role="alert"');
  });

  it("the manual form does not render the actuals message", () => {
    const manualForm = src.slice(anchorIndex(src, "{/* Manual entry form */}"));
    expect(manualForm).not.toContain("actualsError");
  });
});

describe("formatExtraMetricLine", () => {
  const base = { id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Net new ARR", definition: "d", kind: "point", period: "Q", basis: "na" } as const;
  it("formats usd figures the way the live sheet does", () => {
    expect(formatExtraMetricLine({ ...base, unit: "usd", consensus: 300_000_000, whisper: 310_000_000 })).toBe(
      "Net new ARR $300.0M · whisper $310.0M",
    );
  });
  it("formats a percent metric as a percent", () => {
    expect(formatExtraMetricLine({ ...base, unit: "pct", consensus: 27.5, whisper: null })).toBe("Net new ARR 27.5%");
  });
  it("a whisper alone is labelled", () => {
    expect(formatExtraMetricLine({ ...base, unit: "per_share", whisper: 0.5 })).toBe("Net new ARR whisper $0.50");
  });
  it("a metric with no figure says so rather than showing a bare label", () => {
    expect(formatExtraMetricLine({ ...base, unit: "count", consensus: null, whisper: null })).toBe(
      "Net new ARR — no bogey yet",
    );
  });
  it("the card renders each stored metric through it", () => {
    const card = sliceBetween(src, "{shown.map((b) => (", "{/* Actuals — manual override");
    expect(card).toContain("(b.extraMetrics ?? []).map((sp) => (");
    expect(card).toContain("{formatExtraMetricLine(sp)}");
  });
});

describe("the bogey delete link has a touch extension", () => {
  it("carries the same pointer-coarse inset the modal's other small controls do", () => {
    const at = anchorIndex(src, "onClick={() => remove(b.id)}");
    const cls = src.slice(at, at + 320);
    expect(cls).toContain("relative ");
    expect(cls).toContain("pointer-coarse:after:absolute");
    expect(cls).toContain("pointer-coarse:after:-inset-y-2");
  });
});
