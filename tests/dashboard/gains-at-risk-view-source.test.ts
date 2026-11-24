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

describe("the stress-scope rule is the route's rule", () => {
  // The route's helper is private (a route file exports only handlers), so
  // both copies are pinned by source anchor to the same body: "all" is every
  // account, any other token reads only the accounts it names, a token that
  // names no account reads nothing ([]), never every account.
  const body = (src: string, signature: string) => {
    const start = anchorIndex(src, signature);
    const open = anchorIndex(src, "{", start + signature.length);
    const close = anchorIndex(src, "\n}", open);
    return src.slice(open + 1, close).replace(/\s+/g, " ").trim();
  };

  it("same body in the route and the section", () => {
    const route = body(read(ROUTE), "function gainsAtRiskAccountIds(scope: AnalysisScope): number[] | undefined");
    const section = body(read(SECTION), "function stressAccountIds(scope: AnalysisScope): number[] | undefined");
    expect(route).toBe('if (scope === "all") return undefined; return resolveScope(db, scope) ?? [];');
    expect(section).toBe(route);
  });
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

  it("a refresh keeps the controls: fresh props are taken only when they answer them, else it asks again", () => {
    const at = anchorIndex(src, "serverPropsAnswerControls(controlsRef.current, initialInputs)");
    const block = src.slice(at, at + 300);
    expect(block).toContain('dispatch({ type: "reset", data: initial })');
    expect(block).toContain("void run(controlsRef.current)");
  });

  it("a running or failed request keeps the layout and its input boxes mounted", () => {
    anchorIndex(src, "const display = state.result ?? state.previous ?? initial;");
    const at = anchorIndex(src, "<ResultSections");
    // Rendered unconditionally: not behind `result &&` or a loading check.
    expect(src.slice(at - 40, at)).not.toMatch(/&&\s*\(?\s*$/);
    anchorIndex(src, "STALE_TEXT");
    expect(code(src)).toMatch(/failed \|\| v === undefined \? null : v/);
  });

  it("an option held in two accounts gets one price box", () => {
    anchorIndex(src, "priceBoxOwners(positions)");
    anchorIndex(src, "SAME_PRICE_TEXT");
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

  for (const file of [VIEW, CHART]) {
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
      if (file === VIEW) {
        expect(src).not.toMatch(/\bformat(USD|CompactUSD|LargeUSD|Percent)\(/);
        // The one toFixed prints a beta, a model input, not a portfolio figure.
        const fixed = [...src.matchAll(/([\w.?]+)\.toFixed\(/g)].map((m) => m[1]);
        expect(fixed).toEqual(["p.assumedMovePerUnitDriver"]);
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
    anchorIndex(src, "chartRows(rows)");
    expect(src).toMatch(/dataKey="move"\s+type="number"/);
    expect(src).not.toContain('type="category"');
  });

  it("the second line is the positions that lose (executable code, not a comment)", () => {
    expect(code(read(HELPERS))).toContain("without: r.losersPnlUsd");
    expect(code(src)).toContain('dataKey="without"');
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

  it("no lib/db, lib/queries, lib/compute or better-sqlite3 as a value", () => {
    const seen = new Set<string>();
    const reached: string[] = [];
    const packages = new Set<string>();
    const stack = [VIEW, CHART, HELPERS, INPUT].map((p) => join(ROOT, p));
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
    expect(reached.filter((p) => /^lib\/(db|queries|compute)(\/|\.ts)/.test(p) || p === "lib/db.ts")).toEqual([]);
    expect([...packages].filter((p) => p === "better-sqlite3")).toEqual([]);
    expect(reached).toContain("lib/analysis/gains-at-risk-input.ts");
  });
});

describe("the page's words", () => {
  for (const file of [SECTION, VIEW, CHART, HELPERS, INPUT]) {
    it(`${file}: never calls the offsetting positions by the other name`, () => {
      for (const t of copyOf(read(file))) expect(t).not.toMatch(/\bhedges?\b/i);
    });
  }
  for (const file of [SECTION, VIEW, CHART, HELPERS]) {
    it(`${file}: no plan-step wording on screen`, () => {
      for (const t of copyOf(code(read(file)))) expect(t).not.toMatch(/\bstep\s*\d/i);
    });
  }
});
