import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Source pins for trial positions on the Gains at risk page. There is no DOM
// test harness; the browser pass proves the rendering, these pin the wiring a
// refactor could quietly undo. The import walk for these files lives in
// tests/dashboard/gains-at-risk-view-source.test.ts.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SECTION = "app/dashboard/components/gains-at-risk/GainsAtRiskSection.tsx";
const VIEW = "app/dashboard/components/gains-at-risk/GainsAtRiskView.tsx";
const CHART = "app/dashboard/components/gains-at-risk/GainsAtRiskChart.tsx";
const PROVIDER = "app/dashboard/components/gains-at-risk/TrialPositionsProvider.tsx";
const FORM = "app/dashboard/components/gains-at-risk/TrialPositionForm.tsx";
const LIST = "app/dashboard/components/gains-at-risk/TrialPositionList.tsx";
const HELPERS = "lib/analysis/gains-at-risk-trial-view.ts";

/** Source with // and /* *\/ comments removed (string contents kept as written). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** The string literals and JSX text of a file. */
function copyOf(src: string): string[] {
  const literals = [...src.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
  const jsxText = [...src.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
  return [...literals, ...jsxText];
}

describe("the provider keeps trial positions across a scope switch (R5)", () => {
  const section = read(SECTION);

  it("wraps the keyed view and is not keyed itself", () => {
    const open = anchorIndex(section, "<TrialPositionsProvider>");
    const view = anchorIndex(section, "<GainsAtRiskView", open);
    const close = anchorIndex(section, "</TrialPositionsProvider>", view);
    expect(section.slice(view, close)).toContain("key={scope}");
    // The provider's own opening tag carries no props at all, so no key.
    expect(section).not.toMatch(/<TrialPositionsProvider\s+[^>]/);
  });

  it("is a client component that stores nothing", () => {
    const src = read(PROVIDER);
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
    expect(code(src)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|apiFetch|fetch\(/);
    anchorIndex(src, "useReducer(trialListReducer");
  });
});

describe("the view sends and waits for the trial positions", () => {
  const src = read(VIEW);

  it("each request carries the trial positions as fixed, and the set it answers", () => {
    anchorIndex(src, "trialPositions: trialRequestPositions(trialNow.list)");
    anchorIndex(src, 'dispatch({ type: "start", seq, trialVersion: trialNow.version })');
    anchorIndex(src, 'dispatch({ type: "success", seq, data: r.data.data, trialVersion: trialNow.version })');
  });

  it("P7: it starts pending when it mounts with trial positions, and asks at once", () => {
    anchorIndex(src, "initialGainsRequestState(d, { hasTrials: trials.list.length > 0, trialVersion: trials.version })");
    const at = anchorIndex(src, "P7: mounted with trial positions");
    expect(src.slice(at, at + 250)).toContain("if (trialsRef.current.list.length > 0) void run(controlsRef.current);");
  });

  it("every trial add, edit or remove asks again", () => {
    const at = anchorIndex(src, "}, [trials.version]);");
    expect(src.slice(at - 250, at)).toContain("void run(controlsRef.current);");
  });

  it("the list's figures come only from an answer to the list as it stands", () => {
    anchorIndex(src, "const trialsCurrent = state.trialVersion === trials.version;");
    anchorIndex(src, 'const trialAnswer = mode === "fresh" ? (display.result.trial ?? null) : null;');
    const panel = anchorIndex(src, "<TrialPositionsPanel");
    expect(src.slice(panel, panel + 400)).toContain("trial={trialAnswer}");
    // A note points to the per-name table only when it is on screen.
    expect(src.slice(panel, panel + 400)).toContain("tableBelow={display.result.positions.length > 0 || (display.result.trial?.rows.length ?? 0) > 0}");
  });

  it("the moves table: as it is, with trial positions, the difference, and given back before and after", () => {
    for (const k of ["asIs", "withTrial", "difference", "givenBack"]) anchorIndex(src, `TRIAL_TABLE_LABELS.${k}`);
    anchorIndex(src, "trialTableRow(bookCase, trialSel, move)");
    anchorIndex(src, "<Money value={fig(tRow?.withTrial)} signed />");
    anchorIndex(src, "<Money value={fig(tRow?.difference)} signed />");
    anchorIndex(src, "noMoveCostSentence(trialSel)");
    anchorIndex(src, "<Money value={fig(noMoveCost.usd)} />");
  });

  it("the chart hides the line without the offsetting positions while trial positions exist, and says so", () => {
    const at = anchorIndex(src, "<GainsAtRiskChart");
    expect(src.slice(at, at + 300)).toContain("trial={trial ? trial.cases : null}");
    anchorIndex(src, "{trial ? TRIAL_CHART_NOTE : CHART_GAP_NOTE}");
    const chart = code(read(CHART));
    const trialLines = chart.slice(anchorIndex(chart, "function TrialLines("));
    expect(trialLines).toContain('dataKey="asIs"');
    expect(trialLines).toContain('dataKey="withTrial"');
    expect(trialLines).not.toContain('dataKey="without"');
    expect(trialLines).not.toContain('dataKey="measured"');
    expect(trialLines).not.toContain('dataKey="selloff"');
    // With none, the chart is step 1's: the trial branch is taken only when `trial` is set.
    anchorIndex(chart, "if (trial) {");
  });

  it("a scope with no positions but trial positions draws the comparison; with neither, step 1's empty box", () => {
    anchorIndex(src, "if (result.positions.length === 0 && !trial) {");
    anchorIndex(src, "{trial && emptyBook && <p className=\"text-xs text-ink-faint\">{TRIAL_EMPTY_BOOK_NOTE}</p>}");
  });

  it("the given-back cell: before, an arrow glyph, after; the crossing sentence knows the table's rows", () => {
    anchorIndex(src, "{TRIAL_GIVEN_BACK_ARROW}");
    anchorIndex(src, "crossingSentence(trialSel, driver, customExtra && custom !== null ? [...tableMoves, custom] : tableMoves)");
  });

  it("trial rows sit in the per-name table, marked trial, and say why when refused", () => {
    anchorIndex(src, "nameTableRows(result, trialLabels)");
    anchorIndex(src, "const key = nameRowKey(p);");
    anchorIndex(src, 'trialRefusalNote(p.trialRow, { tableBelow: "this-row" })');
    const chip = anchorIndex(src, "{p.trialId !== undefined && (");
    expect(src.slice(chip, chip + 160)).toContain("trial");
  });
});

describe("the form", () => {
  const src = read(FORM);
  const body = code(src);

  it("is a client component and reads every answer through the shared reader", () => {
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
    anchorIndex(src, "readMutationResult");
    anchorIndex(src, "networkFailureMessage(");
    expect(body).not.toMatch(/\bres\.ok\b/);
    expect(body).not.toMatch(/\bconfirm\(|\balert\(|\bprompt\(/);
  });

  it("disables Get quote when the broker is not connected, and says so", () => {
    anchorIndex(src, "const quoteBlocked = connected !== true ||");
    const btn = anchorIndex(src, "disabled={quoteBlocked}");
    expect(src.slice(btn, btn + 300)).toContain("getQuote()");
    anchorIndex(src, "{TRIAL_CONNECT_FOR_QUOTES}");
    anchorIndex(src, 'apiFetch("/api/tws/status")');
  });

  it("contracts and quantities are private number inputs; prices and strikes are plain", () => {
    const at = anchorIndex(src, "<PrivateNumberInput");
    expect(src.slice(at, at + 400)).toContain("value={draft.count}");
    expect((src.match(/<PrivateNumberInput/g) ?? []).length).toBe(1);
    const price = anchorIndex(src, 'id="trial-price"');
    expect(src.slice(price - 80, price)).toContain("<input");
  });

  it("P6: every request goes through the reducer and its reply is checked against the draft", () => {
    anchorIndex(src, "useReducer(trialFormReducer");
    anchorIndex(src, 'act({ type: "request", kind, id });');
    anchorIndex(src, "isCurrentTrialReply(stateRef.current, kind, id, sent.revision, sent.contractKey, sym)");
    anchorIndex(src, "act({ type: \"reply\", kind, id, revision: sent.revision, contractKey: sent.contractKey, symbol: sym, payload }");
    for (const kind of ['"lookup"', '"chain"', '"quote"', '"ensure"', '"entry"']) anchorIndex(src, `request(${kind}`);
    // Closing drops whatever is still on the way.
    const close = anchorIndex(src, "function close()");
    expect(src.slice(close, close + 120)).toContain('act({ type: "cancel" });');
  });

  it("P1: an edit tries a resize first, with no server call", () => {
    const at = anchorIndex(src, "const e = applyTrialEdit(editing, s.draft);");
    const entry = anchorIndex(src, 'request("entry"');
    expect(at).toBeLessThan(entry);
    expect(src.slice(at, at + 300)).toContain("onSave(e.next);");
  });

  it("P8: no daily prices and a connected broker: the bars are fetched before the entry; Add waits for the status", () => {
    const at = anchorIndex(src, "const step = barsStep(stateRef.current, sec, isConnected);");
    expect(at).toBeLessThan(anchorIndex(src, 'request("entry"'));
    expect(src.slice(at, at + 400)).toContain('if (step === "blocked") return;');
    expect(src.slice(at, at + 400)).toContain("ensureBars(sec.securityId)");
    // Add joins the lookup the blur started and waits for the broker status (never skips the fetch).
    anchorIndex(src, "await Promise.all([lookup(), connectedNow()])");
    anchorIndex(src, "if (lookupRef.current && lookupRef.current.symbol === sym) return lookupRef.current.promise;");
    anchorIndex(src, "const busy = addBlockedBy(state);");
  });

  it("after a failed fetch the owner chooses: try again, or add without daily prices", () => {
    const at = anchorIndex(src, "{barsBlocked ? (");
    const block = src.slice(at, at + 1400);
    expect(block).toContain('act({ type: "retry-bars" });');
    expect(block).toContain("Try the daily-price fetch again");
    expect(block).toContain('act({ type: "skip-bars" });');
    expect(block).toContain("Add without daily prices");
  });

  it("an unmount runs the cancel transition, so no reply adds a position after the form is gone", () => {
    const at = anchorIndex(src, "Unmounted (a scope switch, the panel closing)");
    const block = src.slice(at, at + 500);
    expect(block).toContain("return () => {");
    expect(block).toContain('stateRef.current = trialFormReducer(stateRef.current, { type: "cancel" });');
  });

  it("the lookup line and the chain fields come from the helpers; the strike note sits under the select", () => {
    anchorIndex(src, "lookupBarsLine(security, connected)");
    anchorIndex(src, "chainFieldState(draft, state.chain)");
    anchorIndex(src, "{TRIAL_STRIKES_NOTE}");
    // Never a select under the owner's cursor.
    anchorIndex(src, 'fields.strike.inChain && typing !== "strike"');
  });

  it("the multiplier note and the native selects from the chain", () => {
    anchorIndex(src, "{TRIAL_MULTIPLIER_NOTE}");
    anchorIndex(src, "/api/tws/option-chain?symbol=");
    expect((src.match(/<select/g) ?? []).length).toBe(2);
    expect(copyOf(body).join(" ")).not.toMatch(/[▾▼⌄]|chevron|caret/i);
  });
});

describe("the list", () => {
  const src = read(LIST);

  it("renders the not-stored note, and the zero-start note once there are trial positions", () => {
    anchorIndex(src, "{TRIAL_NOT_STORED_NOTE}");
    anchorIndex(src, "{trials.list.length > 0 && <p className=\"text-xs text-ink-faint\">{TRIAL_ZERO_START_NOTE}</p>}");
  });

  it("counts, costs and cash print through the privacy components", () => {
    anchorIndex(src, "<Count value={label.count} />");
    anchorIndex(src, "<QuantityUnit securityType=\"stock\" quantity={label.count} />");
    anchorIndex(src, "<Money value={cost.usd} />");
    anchorIndex(src, "<Pct value={share.percent} />");
    anchorIndex(src, "<PrivateText>{UNDER_TENTH_TEXT}</PrivateText>");
    anchorIndex(src, "<Money value={net.usd} />");
    anchorIndex(src, "<Count value={short.count} />");
    anchorIndex(src, "<Count value={s.shortBy} />");
  });

  it("every row note comes from the helpers; edit and remove are always visible buttons", () => {
    for (const h of [
      "trialPositionLabel(t)",
      "quoteLabel(t)",
      "underlyingPriceNote(t)",
      "staleCloseNote(t)",
      "trialCostLine(row)",
      "trialCostShareCell(row, yearGain)",
      "trialRefusalNote(row, { tableBelow })",
      "holdingsChangedNote(t, row)",
      "leavesShortNote(row)",
      "noLinkWarningNote(row, { tableBelow })",
      "shortByNameLines(trial)",
      "netCashLine(trial.netCashUsd)",
    ]) {
      anchorIndex(src, h);
    }
    expect(code(src)).not.toMatch(/group-hover|opacity-0/);
  });
});

describe("the words", () => {
  for (const file of [VIEW, CHART, PROVIDER, FORM, LIST, HELPERS]) {
    it(`${file}: never "hedge", and no plan wording`, () => {
      for (const t of copyOf(code(read(file)))) {
        expect(t).not.toMatch(/\bhedges?\b/i);
        expect(t).not.toMatch(/\bstep\s*\d|\b[RP]\d{1,2}\b/);
      }
    });
  }

  it("the headline label is unchanged", () => {
    expect(read("lib/analysis/gains-at-risk-view.ts")).toContain('export const YEAR_GAIN_LABEL = "Year\'s gain so far";');
  });
});
