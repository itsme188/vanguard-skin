import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Source pins for the Gains at risk view (Task 6). There is no DOM test
// harness here; the browser pass proves the rendering, these pin the wiring a
// refactor could quietly undo.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PAGE = "app/dashboard/analysis/page.tsx";
const ROUTE = "app/api/compute/gains-at-risk/route.ts";
const SECTION = "app/dashboard/components/gains-at-risk/GainsAtRiskSection.tsx";
const VIEW = "app/dashboard/components/gains-at-risk/GainsAtRiskView.tsx";
const CHART = "app/dashboard/components/gains-at-risk/GainsAtRiskChart.tsx";
const HELPERS = "lib/analysis/gains-at-risk-view.ts";
const INPUT = "lib/analysis/gains-at-risk-input.ts";
const CONSTANTS = "lib/analysis/gains-at-risk-constants.ts";
const SCOPE = "lib/analysis/gains-at-risk-scope.ts";
// Step 2: trial positions.
const TRIAL_HELPERS = "lib/analysis/gains-at-risk-trial-view.ts";
const PROVIDER = "app/dashboard/components/gains-at-risk/TrialPositionsProvider.tsx";
const FORM = "app/dashboard/components/gains-at-risk/TrialPositionForm.tsx";
const LIST = "app/dashboard/components/gains-at-risk/TrialPositionList.tsx";
// Step 3 (Task S5): the driver control.
const DRIVER_CONTROL = "app/dashboard/components/gains-at-risk/DriverControl.tsx";
const DRIVER_PROVIDER = "app/dashboard/components/gains-at-risk/DriverChoiceProvider.tsx";
// Step 3 (Task S4): the plain route-body module and the money module the page will read.
const CANDIDATES_INPUT = "lib/analysis/gains-at-risk-candidates-input.ts";
const CANDIDATE_MONEY = "lib/analysis/gains-at-risk-candidate-money.ts";
// Step 3 (Task S6): the candidate section.
const CANDIDATES_PROVIDER = "app/dashboard/components/gains-at-risk/CandidatesProvider.tsx";
const CANDIDATE_SECTION = "app/dashboard/components/gains-at-risk/CandidateSection.tsx";
const CANDIDATE_PICKER = "app/dashboard/components/gains-at-risk/CandidatePicker.tsx";
const CANDIDATE_TABLE = "app/dashboard/components/gains-at-risk/CandidateTable.tsx";
const CANDIDATES_VIEW = "lib/analysis/gains-at-risk-candidates-view.ts";
const CANDIDATE_FILES = [CANDIDATES_PROVIDER, CANDIDATE_SECTION, CANDIDATE_PICKER, CANDIDATE_TABLE, CANDIDATES_VIEW];
/** Server only (F4, plan OPEN 1): never reached from a client file. */
const CANDIDATE_CHECK = "lib/compute/gains-at-risk-candidate-check.ts";

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

describe("Analysis page: the gains branch", () => {
  const src = read(PAGE);
  const start = anchorIndex(src, 'resolved.view === "gains"');
  const end = src.indexOf("resolved.view ===", start + 1);
  const branch = src.slice(start, end === -1 ? undefined : end);

  it("resolves its own scope and renders the section", () => {
    expect(branch).toContain("resolveGainsAtRiskScope(params.scope)");
    expect(branch).toContain("<GainsAtRiskSection");
    expect(branch).toContain('<AnalysisViewToggle currentView="gains"');
  });

  it("comes before the giving branch", () => {
    expect(start).toBeLessThan(anchorIndex(src, 'resolved.view === "giving"'));
  });
});

describe("GainsAtRiskSection is a server component", () => {
  const src = read(SECTION);

  it("has no client directive", () => {
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });

  it("imports only the component name from the client file", () => {
    const imports = [...src.matchAll(/import\s+([^;]+?)\s+from\s+["']\.\/GainsAtRiskView["']/g)].map((m) => m[1].trim());
    expect(imports).toEqual(["{ GainsAtRiskView }"]);
  });

  it("asks the year's gain for every account, whatever the stress scope", () => {
    anchorIndex(src, "computeYearGain(db, {");
    expect(src).not.toMatch(/computeYearGain\(db,\s*\{[^}]*accountIds/);
  });

  it("a first-paint failure writes one content-free log line", () => {
    const at = anchorIndex(src, "} catch {");
    const tail = src.slice(at, anchorIndex(src, "<EmptySection", at));
    expect(tail).toContain('console.error("[gains-at-risk] first paint failed");');
    expect(tail).not.toMatch(/console\.error\([^)]*,/); // no second argument: no message, no figure
  });
});

describe("the stress-scope rule has one copy", () => {
  // "all" is every account; any other token reads only the accounts it
  // names; a token that names no account reads nothing ([]), never every
  // account. The behaviour is tested in tests/lib/gains-at-risk-view.test.ts.
  it("the server-only module holds the rule", () => {
    const src = read(SCOPE);
    const at = anchorIndex(src, "export function gainsAtRiskAccountIds(db: Database.Database, scope: AnalysisScope): number[] | undefined");
    const open = anchorIndex(src, "{", at + 20);
    const body = src.slice(open + 1, anchorIndex(src, "\n}", open)).replace(/\s+/g, " ").trim();
    expect(body).toBe('if (scope === "all") return undefined; return resolveScope(db, scope) ?? [];');
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });

  for (const file of [ROUTE, SECTION]) {
    it(`${file}: uses the shared rule and keeps no copy of its own`, () => {
      const src = read(file);
      expect(src).toMatch(/import\s*\{\s*gainsAtRiskAccountIds\s*\}\s*from\s*"@\/lib\/analysis\/gains-at-risk-scope"/);
      expect(src).not.toMatch(/function\s+(gainsAtRiskAccountIds|stressAccountIds)\b/);
      expect(src).not.toMatch(/resolveScope\(/);
      anchorIndex(src, "gainsAtRiskAccountIds(db, ");
    });
  }
});

describe("GainsAtRiskView wiring", () => {
  const src = read(VIEW);

  it("is a client component", () => {
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("runs requests through the sequence-number reducer", () => {
    expect(src).toMatch(/useReducer\(\s*gainsRequestReducer/);
  });

  it("renders figures through the privacy components", () => {
    for (const needle of ["<Money", "<Pct", "<Count", "<PrivateNumberInput"]) anchorIndex(src, needle);
  });

  it("clears the result before it posts, and reads the answer through the shared reader", () => {
    const startAt = anchorIndex(src, 'dispatch({ type: "start"');
    const fetchAt = anchorIndex(src, "apiFetch(");
    expect(startAt).toBeLessThan(fetchAt);
    anchorIndex(src, "readMutationResult");
    anchorIndex(src, "networkFailureMessage(");
    anchorIndex(src, "requestFailureText(r.status, r.message)");
  });

  it("drops a response for an older request", () => {
    anchorIndex(src, 'dispatch({ type: "success", seq');
    anchorIndex(src, 'dispatch({ type: "failure", seq');
  });

  it("a refresh keeps the controls: fresh props are taken only when they answer them and no trial position exists, else it asks again", () => {
    const at = anchorIndex(src, "serverPropsAction(controlsRef.current, initialInputs, hasTrials)");
    const block = src.slice(at, at + 300);
    expect(block).toContain('dispatch({ type: "reset", data: initial, hasTrials })');
    expect(block).toContain("void run(controlsRef.current)");
  });

  it("a running or failed request keeps the layout and its input boxes mounted", () => {
    anchorIndex(src, "const display = state.result ?? state.previous ?? initial;");
    const at = anchorIndex(src, "<ResultSections");
    // Rendered unconditionally: not behind `result &&` or a loading check.
    expect(src.slice(at - 40, at)).not.toMatch(/&&\s*\(?\s*$/);
    anchorIndex(src, "STALE_TEXT");
    // Blank after a failure, and never a negative zero (moneyCell).
    anchorIndex(src, "moneyCell(v, failed)");
  });

  it("an option held in two accounts gets one price box", () => {
    anchorIndex(src, "priceBoxOwners(positions)");
    anchorIndex(src, "SAME_PRICE_TEXT");
  });

  it("an unpriced option with no volatility is editable, with its sentence", () => {
    anchorIndex(src, "const editable = isPriceEditable(p);");
    anchorIndex(src, "NO_VOLATILITY_PRICE_TEXT");
  });

  it("inputs in a table name themselves with aria-label, never an sr-only label", () => {
    // An sr-only label is absolutely positioned; its containing block is the
    // ScrollFade wrapper, not the inner scroller, so a label deep in a wide
    // table pushed the whole page sideways at phone width.
    expect(code(src)).not.toContain("sr-only");
    const beta = src.slice(anchorIndex(src, "id={`gains-beta-${"), anchorIndex(src, "/>", anchorIndex(src, "id={`gains-beta-${")));
    expect(beta).toContain("aria-label={`Your figure for ${p.symbol}");
    const price = src.slice(anchorIndex(src, "id={`gains-price-${"), anchorIndex(src, "/>", anchorIndex(src, "id={`gains-price-${")));
    expect(price).toContain("aria-label={`Your price per share for ${p.symbol}");
  });
});

describe("the two cases and the owner's figure", () => {
  const src = read(VIEW);
  const body = code(src);

  it("the case switch opens on Measured and is page state only", () => {
    anchorIndex(src, "useState<GainsAtRiskCaseKey>(DEFAULT_CASE)");
    const at = anchorIndex(src, 'aria-label="Case"');
    const block = src.slice(at, at + 900);
    expect(block).toContain("CASE_KEYS.map(");
    expect(block).toContain("CASE_LABELS[k]");
    expect(block).toContain("aria-pressed={caseKey === k}");
    // No caret on the pill pair.
    expect(block).not.toMatch(/[▾▼⌄]|chevron|caret/i);
  });

  it("the selected case's sentence sits under the switch", () => {
    const at = anchorIndex(src, 'aria-label="Case"');
    expect(src.slice(at, at + 1200)).toContain("CASE_NOTES[caseKey]");
  });

  it("the table, the per-name table and the disclosures read the selected case", () => {
    anchorIndex(src, "result.cases[caseKey]");
    anchorIndex(src, "p.cases[caseKey]");
    // Only the chart reads both cases, through the helper.
    expect(body).not.toMatch(/\.cases\.(measured|selloff)\b/);
    expect(body).not.toMatch(/cases\[["'](measured|selloff)["']\]/);
  });

  it("the chart gets both cases and the selected one, with the gap sentence under it", () => {
    const at = anchorIndex(src, "<GainsAtRiskChart");
    const block = src.slice(at, at + 200);
    expect(block).toContain("cases={result.cases}");
    expect(block).toContain("selectedCase={caseKey}");
    anchorIndex(src, "CHART_GAP_NOTE");
  });

  it("the figure box is a plain number input, bounded, keyed by the name's identity", () => {
    const at = anchorIndex(src, "id={`gains-beta-${");
    const open = src.lastIndexOf("<input", at);
    const close = src.indexOf("/>", at);
    expect(open).toBeGreaterThan(-1);
    const tag = src.slice(open, close);
    expect(tag).toContain('type="number"');
    expect(tag).toContain("min={BETA_OVERRIDE_BOUNDS.min}");
    expect(tag).toContain("max={BETA_OVERRIDE_BOUNDS.max}");
    expect(tag).toContain("onBlur=");
    expect(tag).toContain("onKeyDown={onEnterBlur}");
    expect(src.slice(open - 400, close)).not.toContain("PrivateNumberInput");
    anchorIndex(src, "nameTableEditorOwnership(positions)");
    anchorIndex(src, "sameFigureTextAt(");
    anchorIndex(src, "onBetaCommit(p.identitySecurityId)");
    anchorIndex(src, "onBetaClear(p.identitySecurityId)");
  });

  it("the figures are sent keyed by identity, and left out when there are none", () => {
    // Step 3 (P2): none are sent in single-name mode; they stay in page state.
    anchorIndex(src, "const figures = betaOverridesToSend(kind, next.betaOverrides);");
    anchorIndex(src, "Object.keys(figures).length > 0 ? { betaOverrides: figures } : {}");
    anchorIndex(src, "betaOverrideProblem(");
    anchorIndex(src, "BETA_OVERRIDE_REFUSAL_LABELS[");
    anchorIndex(src, "overridesIgnoredLine(result.betaOverridesIgnored)");
    anchorIndex(src, "<Count value={ignored.count} />");
    anchorIndex(src, "betaEditorNote(p)");
    anchorIndex(src, "LEVERAGED_FIGURE_HINT");
  });

  it("the evidence caption and the no-measured-link line", () => {
    anchorIndex(src, "betaEvidenceCaption(result.betaEvidence, driver)");
    anchorIndex(src, "<Count value={caption.waiting.count} />");
    anchorIndex(src, "<Count value={caption.notCaptured.count} />");
    anchorIndex(src, "noMeasuredLinkSentence(");
    anchorIndex(src, "betaSourceLine(p, caseKey, singleName ? driver : undefined)");
  });
});

describe("the per-name table sorts", () => {
  const src = read(VIEW);
  const body = code(src);

  it("sort state lives in the URL under its own key, through the house hook", () => {
    anchorIndex(src, "useSortParam<GainsSortKey>(GAINS_SORT_SCOPE, DEFAULT_POSITION_SORT.field, DEFAULT_POSITION_SORT.dir)");
    anchorIndex(src, 'from "@/lib/hooks/useSortParam"');
    anchorIndex(src, 'from "../SortableHeader"');
  });

  it("five sortable columns, each a SortableHeader", () => {
    for (const field of ["account", "symbol", "beta", "value", "loss"]) {
      expect(src).toMatch(new RegExp(`<SortableHeader\\s+field="${field}"`));
    }
    // No hand-drawn arrow: SortableHeader draws its own.
    expect(copyOf(body).join(" ")).not.toMatch(/[▲▼▾↑↓]/);
  });

  it("sorted by the selected case and move, through the pure helper; the boxes follow that order", () => {
    const at = anchorIndex(
      src,
      "const positions = sortPositions(nameTableRows(result, trialLabels), sortKey, sort.dir, caseKey, selectedIdx);",
    );
    expect(anchorIndex(src, "priceBoxOwners(positions)")).toBeGreaterThan(at);
    expect(anchorIndex(src, "nameTableEditorOwnership(positions)")).toBeGreaterThan(at);
    anchorIndex(src, "sameFigureTextAt(");
    anchorIndex(src, "positionSortNote(sortKey, sort.dir)");
    expect(body).not.toMatch(/\.sort\(\(a, b\)/);
  });

  it("the result and the value print through <Money>", () => {
    anchorIndex(src, "Result at {formatDriverMove(");
    anchorIndex(src, "<Money value={fig(p.valueUsd)} />");
    anchorIndex(src, "<Money value={pnl} signed />");
  });
});

describe("no portfolio number is printed outside the privacy components", () => {
  const MONEY_FIELDS = [
    "bookPnlUsd",
    "losersPnlUsd",
    "offsetsPnlUsd",
    "pnlByMove",
    "gainUsd",
    "differenceUsd",
    "modelPricePerShare",
    "valueUsd",
    "exposureUsd",
    "grossBookUsd",
    "shareOfBook",
    "unknownValueCount",
    "percent",
  ];
  const fieldRe = new RegExp(`\\b(${MONEY_FIELDS.join("|")})\\b`);

  for (const file of [VIEW, CHART, LIST, FORM, DRIVER_CONTROL]) {
    const src = code(read(file));

    it(`${file}: no money field inside a template string`, () => {
      for (const m of src.matchAll(/`[^`]*`/g)) expect(m[0]).not.toMatch(fieldRe);
    });

    it(`${file}: no money field as a bare JSX child`, () => {
      // A child expression opens a line or follows a tag's ">" (not an arrow's "=>").
      const children = [...src.matchAll(/(?:^|[^=]>)[ \t]*\{([^{}]*)\}/gm)].map((m) => m[1]);
      // The scan must see the view's children (it would pass vacuously on a broken regex).
      if (file === VIEW) expect(children.length).toBeGreaterThan(5);
      for (const c of children) expect(c).not.toMatch(fieldRe);
    });

    it(`${file}: no hand formatting of a figure`, () => {
      expect(src).not.toMatch(/toLocaleString\(|Intl\.NumberFormat/);
      if (file !== CHART) {
        expect(src).not.toMatch(/\bformat(USD|CompactUSD|LargeUSD|Percent)\(/);
        // A beta prints through formatBeta in the helper module; the view formats nothing itself.
        expect(src).not.toMatch(/\.toFixed\(/);
      }
    });
  }
});

describe("GainsAtRiskChart", () => {
  const src = read(CHART);

  it("is a client component", () => {
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("each formatter is a usePrivateFormatter result, or the driver's own move label", () => {
    const used = [...src.matchAll(/\b(?:tickFormatter|formatter|labelFormatter)=\{([^}]*)\}/g)].map((m) => m[1].trim());
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(name).toMatch(/^[A-Za-z_$][\w$]*$/);
      // formatDriverMove labels the index's own move: market data.
      if (name === "formatDriverMove" || name === "formatDriverMoveLabel") continue;
      expect(src).toMatch(new RegExp(`const\\s+${name}\\s*=\\s*usePrivateFormatter\\(`));
    }
  });

  it("plots only the sweep, on a numeric move axis", () => {
    anchorIndex(src, "chartRows(cases, selectedCase)");
    expect(src).toMatch(/dataKey="move"\s+type="number"/);
    expect(src).not.toContain('type="category"');
  });

  it("both book lines, and the selected case's positions that lose (executable code, not a comment)", () => {
    const helpers = code(read(HELPERS));
    expect(helpers).toContain("measured: m.bookPnlUsd, selloff: s.bookPnlUsd, without: sel.losersPnlUsd");
    expect(helpers).toContain('const sel = selected === "measured" ? m : s;');
    for (const key of ["measured", "selloff", "without"]) expect(code(src)).toContain(`dataKey="${key}"`);
    // The invisible gain-kept series rides on the selected case's book line.
    anchorIndex(src, "gainKeptShare(p[selectedCase], yearGain)");
  });
});

describe("the browser bundle reaches no database or engine code through these files", () => {
  // Walk VALUE imports (an `import type`, or an import whose every name is a
  // type, is erased at build) from the client files and the plain modules
  // they share, following @/ and relative paths.
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else return null;
    for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const p = base + ext;
      if (existsSync(p) && !p.endsWith("/") && /\.(ts|tsx)$/.test(p)) return p;
    }
    return null;
  };

  const valueImports = (src: string): string[] => {
    // A dynamic import or a require would escape the walk: refuse them outright.
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    const out: string[] = [];
    for (const m of src.matchAll(/^(?:import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
      const clause = m[1].trim();
      if (/^type\b/.test(clause)) continue;
      const braces = /\{([^}]*)\}/.exec(clause);
      const hasDefault = !clause.startsWith("{") && !clause.startsWith("*");
      if (braces && !hasDefault) {
        const names = braces[1].split(",").map((n) => n.trim()).filter(Boolean);
        if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
      }
      out.push(m[2]);
    }
    for (const m of src.matchAll(/^import\s+["']([^"']+)["']/gm)) out.push(m[1]);
    return out;
  };

  it("no lib/db, lib/queries, lib/compute, lib/tws, better-sqlite3 or the broker SDK as a value", () => {
    const seen = new Set<string>();
    const reached: string[] = [];
    const packages = new Set<string>();
    const stack = [VIEW, CHART, HELPERS, INPUT, TRIAL_HELPERS, PROVIDER, FORM, LIST, DRIVER_CONTROL, DRIVER_PROVIDER, CANDIDATES_INPUT, CANDIDATE_MONEY, ...CANDIDATE_FILES].map((p) =>
      join(ROOT, p),
    );
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      reached.push(file.slice(ROOT.length + 1));
      for (const spec of valueImports(readFileSync(file, "utf8"))) {
        const next = resolveSpec(file, spec);
        if (next) stack.push(next);
        else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.add(spec);
      }
    }
    expect(reached.filter((p) => /^lib\/(db|queries|compute|tws)(\/|\.ts)/.test(p) || p === "lib/db.ts")).toEqual([]);
    // The scope rule value-imports lib/queries: server-only, never reached from here.
    expect(reached).not.toContain(SCOPE);
    expect([...packages].filter((p) => p === "better-sqlite3" || p.startsWith("@stoqey/"))).toEqual([]);
    for (const f of [VIEW, CHART, HELPERS, INPUT, CONSTANTS, TRIAL_HELPERS, PROVIDER, FORM, LIST, DRIVER_CONTROL, DRIVER_PROVIDER, CANDIDATES_INPUT, CANDIDATE_MONEY, ...CANDIDATE_FILES]) {
      expect(reached).toContain(f);
    }
    // T22: the call-2 validator is server code; its types reach the page by type-only import.
    expect(reached).not.toContain(CANDIDATE_CHECK);
  });
});

describe("the page's words", () => {
  for (const file of [SECTION, VIEW, CHART, HELPERS, INPUT, TRIAL_HELPERS, PROVIDER, FORM, LIST, DRIVER_CONTROL, DRIVER_PROVIDER]) {
    it(`${file}: never calls the offsetting positions by the other name`, () => {
      for (const t of copyOf(read(file))) expect(t).not.toMatch(/\bhedges?\b/i);
    });
  }
  for (const file of [SECTION, VIEW, CHART, HELPERS, TRIAL_HELPERS, PROVIDER, FORM, LIST, DRIVER_CONTROL, DRIVER_PROVIDER]) {
    it(`${file}: no beta is called estimated any more`, () => {
      for (const t of copyOf(code(read(file)))) expect(t).not.toMatch(/estimat/i);
    });
    it(`${file}: no plan-step wording on screen`, () => {
      for (const t of copyOf(code(read(file)))) expect(t).not.toMatch(/\bstep\s*\d/i);
    });
  }
});
