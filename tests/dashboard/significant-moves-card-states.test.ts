// Significant Moves card: what it says when nothing is flagged, per coverage
// state, and how it dates a stale pair. Pure functions exported by the card;
// the db singleton is mocked out (no DOM harness in this repo).
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  quietState,
  scopeWording,
  coverageAccountsForFlags,
  latestCompletedSession,
  isOlderSession,
  type MovesCoverage,
} from "@/app/dashboard/components/SignificantMovesCard";

const PAIR = { prior: "2026-10-05", latest: "2026-10-06" };

function cov(over: Partial<MovesCoverage>): MovesCoverage {
  return { total: 0, evaluated: 0, missingBeta: 0, missingCloses: 0, ...over };
}

// The card follows the scope selector (owner ruling 2026-10-08): every string
// names the scope on screen. These cases use the Vanguard scope; the per-scope
// wording is pinned in the "scopeWording" block below.
const VANGUARD = scopeWording("Vanguard", false);

describe("quietState", () => {
  it("no holdings in scope: says so, never 'nothing moved'", () => {
    const q = quietState(cov({}), PAIR, false, VANGUARD);
    expect(q.reason).toBe("No Vanguard holdings are in scope for this card.");
    expect(q.reason).not.toContain("moved");
    expect(q.showCoverage).toBe(false);
  });

  it("a held name with no cached beta (evaluated 0 of 1): not evaluated, and why", () => {
    const q = quietState(cov({ total: 1, evaluated: 0, missingBeta: 1 }), PAIR, false, VANGUARD);
    expect(q.reason).toContain("No Vanguard holding could be evaluated");
    expect(q.reason).toContain("none of them has a beta on file");
    expect(q.reason).toContain("This is not a finding that nothing moved.");
    expect(q.reason).not.toContain("moved significantly");
  });

  it("nothing evaluated because closes are missing: names the two dates", () => {
    const q = quietState(cov({ total: 4, evaluated: 0, missingBeta: 1, missingCloses: 4 }), PAIR, false, VANGUARD);
    expect(q.reason).toContain("none of them has a close on both 2026-10-05 and 2026-10-06");
  });

  it("nothing evaluated for mixed reasons: says either input is missing", () => {
    const q = quietState(cov({ total: 4, evaluated: 0, missingBeta: 2, missingCloses: 2 }), PAIR, false, VANGUARD);
    expect(q.reason).toContain("each is missing a cached beta or a close");
  });

  it("partial coverage: the quiet-day sentence is limited to the evaluated holdings", () => {
    const q = quietState(cov({ total: 10, evaluated: 6, missingBeta: 4 }), PAIR, false, VANGUARD);
    expect(q.reason).toContain("Among the Vanguard holdings that could be evaluated");
    expect(q.reason).toContain("The rest were not checked.");
    expect(q.showCoverage).toBe(true);
  });

  it("full coverage: the plain quiet-day sentence, dated", () => {
    const q = quietState(cov({ total: 10, evaluated: 10 }), PAIR, false, VANGUARD);
    expect(q.reason).toBe(
      "No Vanguard holdings moved significantly more than their beta predicted on 2026-10-06.",
    );
    expect(q.showCoverage).toBe(true);
  });

  it("puts no holding count into the plain strings (counts render through <Count> only)", () => {
    for (const c of [
      cov({ total: 7, evaluated: 0, missingBeta: 7 }),
      cov({ total: 7, evaluated: 3, missingBeta: 4 }),
      cov({ total: 7, evaluated: 7 }),
    ]) {
      const q = quietState(c, { prior: "PRIOR", latest: "LATEST" }, false, VANGUARD);
      expect(`${q.reason} ${q.hint.replace(/3%|2 standard/g, "")}`).not.toMatch(/\d/);
    }
  });

  it("states the flag threshold in the visible hint whenever holdings exist", () => {
    const q = quietState(cov({ total: 10, evaluated: 10 }), PAIR, false, VANGUARD);
    expect(q.hint).toContain("at least 3%");
    expect(q.hint).toContain("2 standard deviations");
  });

  it("an older session is labelled next to its date", () => {
    const q = quietState(cov({ total: 10, evaluated: 10 }), PAIR, true, VANGUARD);
    expect(q.reason).toContain("2026-10-06 (older session — no newer close on file)");
  });
});

describe("scopeWording: the title and quiet text name the scope on screen", () => {
  const full = cov({ total: 10, evaluated: 10 });

  it("Vanguard", () => {
    const w = scopeWording("Vanguard", false);
    expect(w.title).toBe("Significant Moves in Vanguard Holdings");
    expect(quietState(full, PAIR, false, w).reason).toBe(
      "No Vanguard holdings moved significantly more than their beta predicted on 2026-10-06.",
    );
  });

  it("IBKR", () => {
    const w = scopeWording("IBKR", false);
    expect(w.title).toBe("Significant Moves in IBKR Holdings");
    expect(quietState(full, PAIR, false, w).reason).toBe(
      "No IBKR holdings moved significantly more than their beta predicted on 2026-10-06.",
    );
    expect(quietState(cov({}), PAIR, false, w).reason).toBe(
      "No IBKR holdings are in scope for this card.",
    );
    expect(quietState(cov({ total: 2, evaluated: 0, missingBeta: 2 }), PAIR, false, w).reason).toContain(
      "No IBKR holding could be evaluated",
    );
    expect(quietState(cov({ total: 4, evaluated: 2, missingBeta: 2 }), PAIR, false, w).reason).toContain(
      "Among the IBKR holdings that could be evaluated",
    );
  });

  it("Roth", () => {
    const w = scopeWording("Roth", false);
    expect(w.title).toBe("Significant Moves in Roth Holdings");
    expect(quietState(full, PAIR, false, w).reason).toContain("No Roth holdings moved significantly");
  });

  it("all accounts: reads as a sentence, and never says Vanguard", () => {
    const w = scopeWording("All accounts", true);
    expect(w.title).toBe("Significant Moves Across All Accounts");
    const states = [
      quietState(cov({}), PAIR, false, w),
      quietState(cov({ total: 2, evaluated: 0, missingBeta: 2 }), PAIR, false, w),
      quietState(cov({ total: 4, evaluated: 2, missingBeta: 2 }), PAIR, false, w),
      quietState(full, PAIR, false, w),
    ];
    expect(states[0].reason).toBe("No holdings across all accounts are in scope for this card.");
    expect(states[3].reason).toBe(
      "No holdings across all accounts moved significantly more than their beta predicted on 2026-10-06.",
    );
    for (const q of states) expect(`${q.reason} ${q.hint}`).not.toContain("Vanguard");
  });

  it("no scope's empty-scope hint claims the card is Vanguard-only", () => {
    for (const w of [scopeWording("IBKR", false), scopeWording("Vanguard", false)]) {
      expect(quietState(cov({}), PAIR, false, w).hint).toBe(
        "It covers long positions held in the accounts of the scope selected above.",
      );
    }
  });
});

describe("coverageAccountsForFlags", () => {
  it("refuses a coverage count smaller than the visible flags (0 of 0 above a flagged row)", () => {
    expect(coverageAccountsForFlags(cov({ total: 0, evaluated: 0 }), 1)).toBe(false);
    expect(coverageAccountsForFlags(cov({ total: 5, evaluated: 2 }), 3)).toBe(false);
  });
  it("accepts a coverage count that covers them", () => {
    expect(coverageAccountsForFlags(cov({ total: 5, evaluated: 3 }), 3)).toBe(true);
  });
});

describe("latestCompletedSession / isOlderSession (ET)", () => {
  // 2026-10-07 is a Wednesday; 2026-10-10/11 a weekend.
  it("before the 16:00 ET close, the latest completed session is the prior trading day", () => {
    expect(latestCompletedSession(new Date("2026-10-07T10:00:00-04:00"))).toBe("2026-10-06");
  });
  it("after the close, it is today", () => {
    expect(latestCompletedSession(new Date("2026-10-07T16:30:00-04:00"))).toBe("2026-10-07");
  });
  it("on a weekend it is Friday", () => {
    expect(latestCompletedSession(new Date("2026-10-11T12:00:00-04:00"))).toBe("2026-10-09");
  });
  it("on Monday morning it is still Friday", () => {
    expect(latestCompletedSession(new Date("2026-10-12T09:00:00-04:00"))).toBe("2026-10-09");
  });
  it("a pair ending at the latest completed session is current; an earlier one is older", () => {
    const wedMorning = new Date("2026-10-07T10:00:00-04:00");
    expect(isOlderSession("2026-10-06", wedMorning)).toBe(false);
    expect(isOlderSession("2026-10-05", wedMorning)).toBe(true);
    // An intraday close under today's date is newer than the last completed
    // session, never "older".
    expect(isOlderSession("2026-10-07", wedMorning)).toBe(false);
  });
});
