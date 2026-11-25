import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { CANDIDATE_SORT_OPTIONS, initialCandidatesState } from "@/lib/analysis/gains-at-risk-candidates-view";

// Source pins for the candidate section (step 3, Task S6). There is no DOM
// harness; the browser pass proves the rendering, these pin the wiring.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const DIR = "app/dashboard/components/gains-at-risk";
const SECTION = `${DIR}/GainsAtRiskSection.tsx`;
const VIEW = `${DIR}/GainsAtRiskView.tsx`;
const PROVIDER = `${DIR}/CandidatesProvider.tsx`;
const CANDIDATE_SECTION = `${DIR}/CandidateSection.tsx`;
const PICKER = `${DIR}/CandidatePicker.tsx`;
const TABLE = `${DIR}/CandidateTable.tsx`;
const HELPERS = "lib/analysis/gains-at-risk-candidates-view.ts";
const NEW_FILES = [PROVIDER, CANDIDATE_SECTION, PICKER, TABLE, HELPERS];

/** Source with // and /* *\/ comments removed. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** The string literals and JSX text of a file. */
function copyOf(src: string): string[] {
  const literals = [...src.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
  const jsxText = [...src.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
  return [...literals, ...jsxText];
}

describe("F1: the provider sits beside the trial provider, around the keyed view", () => {
  const src = code(read(SECTION));
  it("renders CandidatesProvider inside TrialPositionsProvider and around GainsAtRiskView", () => {
    const trial = anchorIndex(src, "<TrialPositionsProvider>");
    const open = anchorIndex(src, "<CandidatesProvider>");
    const view = anchorIndex(src, "<GainsAtRiskView");
    const close = anchorIndex(src, "</CandidatesProvider>");
    const trialClose = anchorIndex(src, "</TrialPositionsProvider>");
    expect(trial).toBeLessThan(open);
    expect(open).toBeLessThan(view);
    expect(view).toBeLessThan(close);
    expect(close).toBeLessThan(trialClose);
  });
  it("the provider carries no key; the view keeps key={scope}", () => {
    expect(src).not.toMatch(/<CandidatesProvider[^>]*\bkey=/);
    expect(src.slice(anchorIndex(src, "<GainsAtRiskView"))).toMatch(/key=\{scope\}/);
  });
  it("the provider holds the reducer and stores nothing", () => {
    const p = code(read(PROVIDER));
    expect(p).toContain("useReducer(candidatesReducer");
    expect(p).not.toMatch(/localStorage|sessionStorage|indexedDB|apiFetch/);
  });
});

describe("the view mounts the section below the trial list", () => {
  const src = code(read(VIEW));
  it("after TrialPositionsPanel, with the server's candidate underlyings", () => {
    const panel = anchorIndex(src, "<TrialPositionsPanel");
    const section = anchorIndex(src, "<CandidateSection");
    expect(panel).toBeLessThan(section);
    expect(src.slice(section, src.indexOf("/>", section))).toContain("underlyings={driverLists.candidateUnderlyings}");
  });
  it("collapsed by default", () => {
    expect(initialCandidatesState().open).toBe(false);
  });
});

describe("T23 privacy", () => {
  const table = code(read(TABLE));
  it("the budget through <PrivateNumberInput>", () => {
    const at = anchorIndex(table, "<PrivateNumberInput");
    expect(table.slice(at, table.indexOf("/>", at))).toContain("value={budgetDraft}");
    expect(table).not.toMatch(/<input[^>]*budget/i);
  });
  it("contracts through <Count>; cost and figures through <Money>; the share through <Pct>", () => {
    expect(table).toContain("<Count value={cells.contracts} />");
    expect(table).toContain("<Money value={cells.costUsd} />");
    expect(table).toContain("<Money value={cells.atSelectedUsd} signed />");
    expect(table).toContain("<Money value={cells.atZeroUsd} signed />");
    expect(table).toContain("<Pct value={share.percent} />");
  });
  it("bid, ask, mid and strikes plain", () => {
    expect(table).toContain("formatMarketPrice(q.bid)");
    expect(table).toContain("formatMarketPrice(q.ask)");
    expect(table).toContain("formatMarketPrice(q.mid)");
    expect(table).not.toMatch(/<Money value=\{q\./);
    expect(code(read(PICKER))).toContain("formatStrike(c.strike)");
  });
});

describe("the picker, the sort and Add", () => {
  it("the underlying is a native select of the server's list; no list is built on the page", () => {
    const picker = code(read(PICKER));
    expect(picker).toContain("underlyings.map(");
    expect(picker).toMatch(/<select[\s\S]*?underlyingSecurityId/);
    for (const f of [PICKER, CANDIDATE_SECTION, HELPERS]) {
      for (const t of copyOf(code(read(f)))) expect(t).not.toMatch(/^(SPY|QQQ|VTI)$/);
    }
  });
  it("the sort is a native select with none first", () => {
    expect(CANDIDATE_SORT_OPTIONS[0].key).toBe("none");
    const table = code(read(TABLE));
    expect(table).toContain('useState<CandidateSortKey>("none")');
    expect(table).toMatch(/<select[\s\S]*?CANDIDATE_SORT_OPTIONS\.map/);
  });
  it("Add's disabled state reads candidateAddBlocked, and the handler checks it again", () => {
    const table = code(read(TABLE));
    expect(table).toContain("candidateAddBlocked(r, state, state.figuresSeq, trialCount, inTrials)");
    expect(table).toContain("disabled={addBlockedText !== null}");
    const section = code(read(CANDIDATE_SECTION));
    expect(section).toMatch(/function addRow[\s\S]*?candidateAddBlocked\(/);
    expect(section).toContain("candidateToTrial(");
  });
  it("every reply is read through readMutationResult; no bare res.ok gate", () => {
    const section = code(read(CANDIDATE_SECTION));
    expect((section.match(/readMutationResult</g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(section).toContain("networkFailureMessage(");
    expect(section).not.toMatch(/\bres\.ok\b/);
  });
  it("Get quotes and Refresh quotes are off while the broker is disconnected (P16)", () => {
    const section = code(read(CANDIDATE_SECTION));
    expect(section).toContain("const canAskBroker = connected === true && !busy;");
    expect(section).toMatch(/disabled=\{!canAskBroker[^}]*\}[\s\S]{0,80}refreshQuotes/);
    expect(code(read(PICKER))).toMatch(/disabled=\{!canAskBroker[^}]*\}[\s\S]{0,60}onGetQuotes/);
  });
  it("a refresh is one call per underlying, one after another", () => {
    const section = code(read(CANDIDATE_SECTION));
    const body = section.slice(anchorIndex(section, "async function refreshQuotes"));
    expect(body).toMatch(/for \(const b of batches\)[\s\S]*?await runPull\("refresh"/);
  });
  it("the footer renders", () => {
    expect(code(read(CANDIDATE_SECTION))).toContain("{CANDIDATES_NOT_STORED_NOTE}");
  });
});

describe("the words", () => {
  for (const file of NEW_FILES) {
    it(`${file}: no other name for the offsetting positions, no ranking words`, () => {
      for (const t of copyOf(code(read(file)))) {
        expect(t).not.toMatch(/\bhedges?\b/i);
        expect(t).not.toMatch(/\b(best|worst|recommended|top pick)\b/i);
      }
    });
  }
  it("no caret glyphs", () => {
    for (const file of NEW_FILES) for (const t of copyOf(code(read(file)))) expect(t).not.toMatch(/[▾▼▸⌄⌃]/);
  });
});

describe("S6 fix round 1 wiring", () => {
  const section = code(read(CANDIDATE_SECTION));
  it("item 4: the section builds its body with the page's one builder; no copy of the rules", () => {
    expect(section).toContain("gainsAtRiskRequestBody({");
    expect(section).toContain("candidatesComputeBody(built.body, selectedMove, budget.usd, candidates)");
    const helpers = code(read(HELPERS));
    expect(helpers).not.toMatch(/requestMoves\(|betaOverridesToSend\(|driverRequestFields\(/);
    expect(code(read(VIEW)).slice(anchorIndex(code(read(VIEW)), "async function run("))).toContain("gainsAtRiskRequestBody({");
  });
  it("item 1: the book revision is in the inputs key and comes from the view", () => {
    expect(section).toContain("candidatesInputsKey(built, selectedMove, bookRevision)");
    const view = code(read(VIEW));
    expect(view).toContain("bookRevision={bookRevision}");
    const effect = view.slice(anchorIndex(view, "seenPropsRef.current = initial;"));
    expect(effect.slice(0, 120)).toContain("setBookRevision((n) => n + 1)");
  });
  it("item 2: the connection is checked on mount when open, after a chain 503, and on Check again; never on a timer", () => {
    expect(section).toMatch(/if \(current\(\)\.open\) void connectAndFetch/);
    const chain = section.slice(anchorIndex(section, "async function fetchChain"));
    expect(chain.slice(0, 900)).toContain("if (r.status === 503) setConnected(false);");
    expect(section).toContain("Check again");
    expect(section).not.toMatch(/setInterval\([^)]*checkConnected|setInterval\([^)]*connectAndFetch/);
  });
  it("item 7: every broker request goes out only after the reducer accepted its request action", () => {
    expect(section).toContain('if (!act({ type: "chain-request"');
    expect(section).toContain('if (!act({ type: "quotes-request"');
    expect(code(read(PROVIDER))).toContain("return after !== before;");
  });
  it("items 3, 8, 9: the in-trials mark and note, Try again, the pending budget line", () => {
    const table = code(read(TABLE));
    expect(table).toContain("{IN_TRIALS_MARK}");
    expect(table).toContain("{IN_TRIALS_NOTE}");
    expect(table).toContain("Try again");
    expect(table).toContain("{BUDGET_PENDING_TEXT}");
  });
});
