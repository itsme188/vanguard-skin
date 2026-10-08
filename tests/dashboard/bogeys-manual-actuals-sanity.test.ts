/**
 * Unit C34 — a hand-typed actual that looks wrong is questioned, never
 * changed or dropped (qa: dashboard-today-earningshub-bogeyseditmodal-
 * reported-actuals-hub-act-eps-cell-manual-actual-eps-has-no-sanity-), plus
 * the "regenerate" touch target on the first-pass read (qa:
 * mobile-liveprintrow--regenerate-66x17-ai-spend-no-touch-extension-no-confirm).
 *
 * No DOM harness in this repo: the rule is proved through the modal's pure
 * exports and the wiring is pinned from source. Invented figures only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  consensusForActualsCheck,
  manualActualsSanityWarnings,
  plausibleEarningsClientCopy,
} from "@/app/dashboard/today/BogeysEditModal";
import { isPlausibleEarnings } from "@/lib/earnings/plausibility";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const none = { epsActual: null, revenueActualUsd: null, epsConsensus: null, revenueConsensusUsd: null };

describe("manualActualsSanityWarnings", () => {
  it("questions revenue typed into the EPS box", () => {
    const w = manualActualsSanityWarnings({ ...none, epsActual: 600_000_000, epsConsensus: 1.5 });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("$600,000,000.00");
    expect(w[0]).toContain("$1.50");
    expect(w[0]).toContain("revenue typed into the EPS box");
  });

  it("with no consensus on file, questions an EPS above $1,000 a share and nothing below", () => {
    expect(manualActualsSanityWarnings({ ...none, epsActual: 600_000_000 })).toHaveLength(1);
    expect(manualActualsSanityWarnings({ ...none, epsActual: -5_000 })).toHaveLength(1);
    expect(manualActualsSanityWarnings({ ...none, epsActual: 1_000 })).toEqual([]);
    expect(manualActualsSanityWarnings({ ...none, epsActual: 12.4 })).toEqual([]);
  });

  it("agrees with isPlausibleEarnings when there is a consensus", () => {
    for (const [cons, act] of [
      [1.5, 1.6],
      [1.5, 1.9],
      [1.5, 2.6],
      [1.5, 0.7],
      [1.5, -0.2],
      [-0.4, 0.1],
      [1.5, 0],
    ] as const) {
      const asked = manualActualsSanityWarnings({ ...none, epsActual: act, epsConsensus: cons }).length > 0;
      expect(asked, `${cons} vs ${act}`).toBe(!isPlausibleEarnings(cons, act, null, null));
    }
  });

  it("questions an EPS 100x a negative consensus, which the plausibility guard does not ratio-check", () => {
    expect(isPlausibleEarnings(-0.4, -50, null, null)).toBe(true);
    expect(manualActualsSanityWarnings({ ...none, epsActual: -50, epsConsensus: -0.4 })).toHaveLength(1);
    expect(manualActualsSanityWarnings({ ...none, epsActual: -0.6, epsConsensus: -0.4 })).toEqual([]);
  });

  it("questions a revenue far from its consensus, and stays quiet with none on file", () => {
    const w = manualActualsSanityWarnings({
      ...none,
      revenueActualUsd: 0.91,
      revenueConsensusUsd: 2_000_000_000,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("$2.00B");
    expect(manualActualsSanityWarnings({ ...none, revenueActualUsd: 0.91 })).toEqual([]);
    expect(
      manualActualsSanityWarnings({ ...none, revenueActualUsd: 2_100_000_000, revenueConsensusUsd: 2_000_000_000 }),
    ).toEqual([]);
  });

  it("an ordinary print raises nothing", () => {
    expect(
      manualActualsSanityWarnings({
        epsActual: 1.62,
        revenueActualUsd: 2_050_000_000,
        epsConsensus: 1.5,
        revenueConsensusUsd: 2_000_000_000,
      }),
    ).toEqual([]);
    expect(manualActualsSanityWarnings(none)).toEqual([]);
  });
});

describe("plausibleEarningsClientCopy", () => {
  it("answers exactly as isPlausibleEarnings over a grid of figures", () => {
    const eps = [null, -50, -1.5, -0.4, 0, 0.4, 0.75, 0.76, 1, 1.5, 2.54, 2.55, 2.6, 150, 600_000_000];
    const rev = [null, 0, 0.91, 1_400_000_000, 1_410_000_000, 2_000_000_000, 2_790_000_000, 2_800_000_000];
    let compared = 0;
    for (const ce of eps) for (const ae of eps) for (const cr of rev) for (const ar of rev) {
      expect(plausibleEarningsClientCopy(ce, ae, cr, ar), `${ce} ${ae} ${cr} ${ar}`).toBe(
        isPlausibleEarnings(ce, ae, cr, ar),
      );
      compared += 1;
    }
    expect(compared).toBe(eps.length ** 2 * rev.length ** 2);
  });
});

describe("consensusForActualsCheck", () => {
  it("takes the newest row that states each figure; the desk EPS wins over the vendor's on a row", () => {
    expect(
      consensusForActualsCheck([
        { eps_consensus: null, eps_consensus_vendor: null, revenue_consensus_usd: null },
        { eps_consensus: 1.5, eps_consensus_vendor: 1.4, revenue_consensus_usd: null },
        { eps_consensus: 9, eps_consensus_vendor: null, revenue_consensus_usd: 2_000_000_000 },
      ]),
    ).toEqual({ eps: 1.5, revenueUsd: 2_000_000_000 });
    expect(consensusForActualsCheck([{ eps_consensus_vendor: 1.4 }])).toEqual({ eps: 1.4, revenueUsd: null });
    expect(consensusForActualsCheck([])).toEqual({ eps: null, revenueUsd: null });
  });
});

describe("source pins", () => {
  const modal = readFileSync("app/dashboard/today/BogeysEditModal.tsx", "utf8");

  it("Save actuals asks before it saves, and a declined ask sends nothing", () => {
    const handler = sliceBetween(modal, "async function saveActuals(", "async function clearActuals(");
    const ask = anchorIndex(handler, "manualActualsSanityWarnings(");
    const confirm = anchorIndex(handler, "window.confirm(");
    const declined = anchorIndex(handler, "Not saved");
    const submit = anchorIndex(handler, "await submitActuals(false)");
    expect(ask).toBeLessThan(confirm);
    expect(confirm).toBeLessThan(declined);
    expect(declined).toBeLessThan(submit);
    // The declined branch returns before the save.
    expect(handler.slice(declined, submit)).toContain("return;");
  });

  it("the check never rewrites what was typed", () => {
    const handler = sliceBetween(modal, "async function saveActuals(", "async function clearActuals(");
    expect(handler).not.toContain("setActuals(");
    const fn = sliceBetween(modal, "export function manualActualsSanityWarnings(", "export const NOTHING_TO_SAVE");
    expect(fn).not.toContain("setActuals");
  });

  it("the first-pass 'regenerate' button carries the touch-only hit extension", () => {
    const src = readFileSync("app/dashboard/today/FirstPassRead.tsx", "utf8");
    const i = anchorIndex(src, "onClick={regenerate}");
    const tag = src.slice(src.lastIndexOf("<button", i), i);
    for (const cls of [
      "relative",
      "pointer-coarse:after:absolute",
      "pointer-coarse:after:content-['']",
      "pointer-coarse:after:-inset-y-3.5",
      "pointer-coarse:after:-inset-x-2",
    ]) {
      expect(tag).toContain(cls);
    }
    // Scope: the extension only — no confirm dialog was added.
    expect(sliceBetween(src, "async function regenerate()", "async function setAccept(")).not.toContain(
      "window.confirm",
    );
  });
});
