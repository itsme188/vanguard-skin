/**
 * Slice F, Task 4 — the bogeys modal's "Extra metrics" editor.
 *
 * The modal portals into `document.body`, and React Testing Library / jsdom are
 * NOT dependencies of this project (and none may be added), so the wiring is
 * pinned by reading the source and the numeric behaviour is proved through the
 * SAME pure parser the modal and the route both call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseExtraMetrics } from "@/lib/print-watch/extra-metrics";

const src = readFileSync("app/dashboard/today/BogeysEditModal.tsx", "utf8");

describe("BogeysEditModal — extra metrics editor", () => {
  it("mints the id client-side with crypto.randomUUID and never lets the user edit it", () => {
    expect(src).toMatch(/crypto\.randomUUID\(\)/);
    expect(src).toMatch(/readOnly/);
  });
  it("validates with the SAME parser the route validates with, before POSTing", () => {
    expect(src).toMatch(/from "@\/lib\/print-watch\/extra-metrics"/);
    expect(src).toMatch(/parseExtraMetrics\(/);
  });
  it("sends extra_metrics_json in the save body", () => {
    expect(src).toMatch(/extra_metrics_json/);
  });
  it("renders a conflict banner from the GET response rather than inventing one", () => {
    expect(src).toMatch(/extraMetricConflicts/);
    expect(src).toMatch(/disagree on/);
  });
  it("checks res.ok AND the error field and never swallows a failure", () => {
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
  it("offers no caret affordance for the add/remove controls (project UI rule)", () => {
    expect(src).not.toMatch(/▾|▼/);
  });
});

describe("BogeysEditModal — id identity and the shared parser (Codex round 1)", () => {
  it("hydrates stored specs instead of re-minting their ids", () => {
    expect(src).toMatch(/extraMetrics/);
    expect(src).toMatch(/hydratedLabelRef/);
  });
  it("offers copy-id and accepts a pasted id at ADD time only (the id input stays readOnly)", () => {
    expect(src).toMatch(/copy id/);
    expect(src).toMatch(/isUuidV4\(/);
    expect(src).toMatch(/readOnly/);
  });
  it("ships raw strings and lets the shared parser read them against the unit", () => {
    expect(src).not.toMatch(/parseLargeUSD\(r\./);
    expect(src).toMatch(/consensus: r\.consensus\.trim\(\) === "" \? null : r\.consensus\.trim\(\)/);
  });
  it("checks the envelope's success flag, not just res.ok", () => {
    expect(src).toMatch(/data\??\.success/);
  });
  it("says something honest when the clipboard is refused", () => {
    expect(src).toMatch(/copy it by hand/);
  });
});

describe("the editor's rows round-trip through the shared parser", () => {
  it("an editor row with empty numbers parses to nulls, not NaN", () => {
    const json = JSON.stringify([{
      id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Net new ARR", definition: "",
      unit: "usd", kind: "point", period: "Q", basis: "na", consensus: "", whisper: "",
    }]);
    expect(parseExtraMetrics(json)).toEqual({
      specs: [{
        id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Net new ARR", definition: "",
        unit: "usd", kind: "point", period: "Q", basis: "na", consensus: null, whisper: null,
      }],
      errors: [],
    });
  });

  it("a pct row's typed '27.5%' survives the editor unparsed and reads as 27.5", () => {
    // The defect the amendment fixed: the modal used to run parseLargeUSD over
    // EVERY unit, so a percent row was stored as "no bogey" instead of 27.5.
    const json = JSON.stringify([{
      id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Op margin", definition: "",
      unit: "pct", kind: "point", period: "Q", basis: "non_gaap", consensus: "27.5%", whisper: "",
    }]);
    const { specs, errors } = parseExtraMetrics(json);
    expect(errors).toEqual([]);
    expect(specs[0].consensus).toBe(27.5);
  });
});
