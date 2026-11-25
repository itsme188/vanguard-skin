import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Source pins for the single-name driver on the page (Gains at risk step 3,
// Task S5). No DOM harness: the pure rules are tested in
// tests/lib/gains-at-risk-view.test.ts and the browser pass proves the rendering.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SECTION = "app/dashboard/components/gains-at-risk/GainsAtRiskSection.tsx";
const VIEW = "app/dashboard/components/gains-at-risk/GainsAtRiskView.tsx";
const CHART = "app/dashboard/components/gains-at-risk/GainsAtRiskChart.tsx";
const DRIVER_CONTROL = "app/dashboard/components/gains-at-risk/DriverControl.tsx";

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

describe("the driver control", () => {
  const src = read(DRIVER_CONTROL);
  const body = code(src);

  it("is a client component", () => {
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("two kinds by radio, the three index pills as before, and a native select of the server list", () => {
    expect(body.match(/type="radio"/g)?.length).toBe(2);
    expect(body).toContain('name="gains-driver-kind"');
    anchorIndex(src, "GAINS_AT_RISK_DRIVERS.map(");
    const at = anchorIndex(src, "<select");
    const block = src.slice(at, anchorIndex(src, "</select>", at));
    expect(block).toContain("drivers.map(");
    expect(block).toContain("driverOptionValue(e)");
    expect(block).toContain("driverFromOptionValue(drivers, e.target.value)");
    // No free text: no text input for a symbol.
    expect(body).not.toMatch(/type="text"|<input[^>]*type="search"/);
  });

  it("no caret as a dropdown affordance", () => {
    for (const t of copyOf(body)) expect(t).not.toMatch(/[▾▼⌄▲]|chevron|caret/i);
  });

  it("an empty list says so and the single-name radio is disabled", () => {
    anchorIndex(src, "disabled={drivers.length === 0}");
    anchorIndex(src, "NO_SINGLE_NAME_TEXT");
  });

  it("imports no server code as a value (types only)", () => {
    expect(src).toMatch(/import type \{ SingleNameDriverEntry \} from "@\/lib\/compute\/gains-at-risk-drivers"/);
    expect(body).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/(compute|queries|db|tws)/m);
  });
});

describe("the server section hands the lists to the view", () => {
  const src = read(SECTION);

  it("builds the driver list with no trial positions and the candidate list from it", () => {
    anchorIndex(src, "listSingleNameDrivers(db, { trialUnderlyingIds: [], today })");
    anchorIndex(src, "listCandidateUnderlyings(db, { drivers, today })");
    anchorIndex(src, "initialDriverLists={driverLists}");
  });

  it("a failure to build them is the first paint's failure (inside the same try)", () => {
    const tryAt = anchorIndex(src, "try {");
    const listAt = anchorIndex(src, "listSingleNameDrivers(");
    const catchAt = anchorIndex(src, "} catch {");
    expect(tryAt).toBeLessThan(listAt);
    expect(listAt).toBeLessThan(catchAt);
  });
});

describe("single-name mode in the view", () => {
  const src = read(VIEW);
  const body = code(src);

  it("mounts the driver control in the controls", () => {
    anchorIndex(src, "<DriverControl");
    anchorIndex(src, "onPickSingleName={pickSingleName}");
    // The old index-only pill group is gone from the view (the control owns it).
    expect(body).not.toContain("If this index falls");
  });

  it("the request: index mode sends today's body; single-name sends the driver, its moves and the selected move", () => {
    const at = anchorIndex(src, "const body: GainsAtRiskBody = {");
    const block = src.slice(anchorIndex(src, "async function run("), anchorIndex(src, "apiFetch(", at));
    expect(block).toContain("requestMoves(sweepFor(kind), next.custom, tableMovesFor(kind))");
    expect(block).toContain("...driverRequestFields(next.driver)");
    expect(block).toContain("const selectedInMoves = moves.find((m) => sameMove(m, selected));");
    expect(block).toContain('kind === "single-name" && selectedInMoves !== undefined ? { selectedMove: selectedInMoves } : {}');
    // P2: the owner's figures are not sent in single-name mode.
    expect(block).toContain("betaOverridesToSend(kind, next.betaOverrides)");
    expect(block).not.toContain("betaOverrides: next.betaOverrides");
  });

  it("the stale-reply guard is kept for every request, the drivers list included", () => {
    anchorIndex(src, 'dispatch({ type: "success", seq, data: r.data.data, trialVersion: trialNow.version })');
    const at = anchorIndex(src, '"/api/compute/gains-at-risk/single-name-drivers"');
    const block = src.slice(at, at + 700);
    expect(block).toContain("if (seq !== driversSeqRef.current) return;");
    expect(block).toContain("readMutationResult");
  });

  it("switching the driver goes through the one pure rule", () => {
    const at = anchorIndex(src, "function pickDriver(");
    const block = src.slice(at, at + 700);
    expect(block).toContain("switchDriver(base, selectedMove, next)");
    expect(block).toContain("void run(switched.controls, switched.selectedMove)");
  });

  it("a name that drops off the list sends the page back to the index and says so", () => {
    const at = anchorIndex(src, "function applyDriverLists(");
    const block = src.slice(at, at + 900);
    expect(block).toContain("sameDriverIn(lists.drivers, cur.entry)");
    expect(block).toContain('{ kind: "index" }');
    expect(block).toContain("driverDroppedText(cur.entry.symbol)");
  });

  it("no case switch and the held-unchanged note in single-name mode; the down-only note only for the index", () => {
    const at = anchorIndex(src, 'aria-label="Case"');
    const guard = src.lastIndexOf("{singleNameSymbol === null && (", at);
    expect(guard).toBeGreaterThan(-1);
    expect(src.slice(guard, at)).not.toContain(")}"); // the guard is still open at the switch
    anchorIndex(src, "<p className=\"text-xs text-ink-dim\">{HELD_UNCHANGED_NOTE}</p>");
    anchorIndex(src, "singleNameVolNote(singleNameSymbol)");
    anchorIndex(src, "caseKey={screenCase}");
    anchorIndex(src, "const screenCase = caseOnScreen(kind, caseKey);");
  });

  it("the table: its own rows, each row's own split, the zero row's split blank, the custom bounds by kind", () => {
    anchorIndex(src, "const rowMoves = tableRowMoves(kind, custom);");
    anchorIndex(src, "singleNameRowCells(row)");
    anchorIndex(src, "cells && cells.loses === null ? null : <Money value={fig(row?.losersPnlUsd)} signed />");
    anchorIndex(src, "cells && cells.offsets === null ? null : <Money value={fig(row?.offsetsPnlUsd)} signed />");
    anchorIndex(src, "max={customBounds.max}");
    anchorIndex(src, "min={customBounds.min}");
    anchorIndex(src, "customMoveProblemFor(controls.driver.kind, move)");
  });

  it("the headline prints its figure through <Money> and its share through <Pct>", () => {
    const at = anchorIndex(src, "{headline && !failed && (");
    const block = src.slice(at, at + 500);
    expect(block).toContain("<Money value={fig(headline.usd)} signed />");
    expect(block).toContain("<Pct value={headline.share * 100} />");
  });

  it("the per-name table: no figure box, words that name the stock, the side of the selected move's direction", () => {
    anchorIndex(src, '{!singleName && <th className="font-normal py-1 pr-3 whitespace-nowrap">Your figure</th>}');
    anchorIndex(src, "{!singleName && (\n      <td");
    anchorIndex(src, "rowSideAt(pc, singleName ? \"single-name\" : \"index\", selectedMove)");
    anchorIndex(src, "singleNameMovesNote(driver)");
    // The evidence caption is about a regression the single-name ladder never runs.
    anchorIndex(src, "{!failed && !singleName && (");
  });

  it("the disclosures: no 'no measured link' line, and the not-linked leveraged funds with options on them", () => {
    anchorIndex(src, '.filter((d) => !(singleName && d.key === "noMeasuredLink"))');
    anchorIndex(src, "leveragedNotLinkedText(driver)");
    anchorIndex(src, "<Count value={fig(lnl.count)} />");
  });

  it("a direction change of the selected row asks again when trial positions are on (D5)", () => {
    const at = anchorIndex(src, "function selectMove(");
    const block = src.slice(at, at + 500);
    expect(block).toContain("moveDirection(m) !== moveDirection(before)");
    expect(block).toContain("void run(controlsRef.current, m)");
    anchorIndex(src, "onSelectMove={selectMove}");
  });

  it("the chart is told the mode", () => {
    const at = anchorIndex(src, "<GainsAtRiskChart");
    expect(src.slice(at, at + 300)).toContain("singleName={singleName}");
    anchorIndex(src, "SINGLE_NAME_CHART_NOTE");
  });
});

describe("single-name mode in the chart", () => {
  const src = read(CHART);

  it("draws the book (and the book with trial positions), never the line without the offsets", () => {
    const at = anchorIndex(src, "function SingleNameLines(");
    const fn = code(src.slice(at));
    expect(fn).toContain('dataKey="book"');
    expect(fn).toContain('dataKey="withTrial"');
    expect(fn).not.toContain('dataKey="without"');
    expect(fn).not.toContain('dataKey="selloff"');
    expect(fn).toContain("singleNameChartRows(book, trial)");
    expect(fn).toContain("gainKeptShare(p.book, yearGain)");
  });

  it("reads the measured case only (both keys hold the same figures, P20)", () => {
    const at = anchorIndex(src, "if (singleName) {");
    const block = src.slice(at, at + 300);
    expect(block).toContain("book={cases.measured}");
    expect(block).toContain("trial={trial ? trial.measured : null}");
  });
});
