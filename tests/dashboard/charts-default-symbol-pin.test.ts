/**
 * Source-pin coverage for the charts-landing precedence ruling
 * (charts-landing--defaults-to-closed-foreign-symbol-with-no-bars-
 * regression-1 / ...-defaults-to-dead-402340-no-bars-regression-2). No
 * jsdom/RTL in this repo, so page.tsx (a server component) and the
 * mount-effect wiring in ChartsView.tsx (client localStorage behavior) are
 * pinned by reading the source text, per the no-DOM-test-harness
 * convention (app/dashboard/today/hub-live/expansion.ts's own test file
 * uses the same pattern for its untestable wiring).
 *
 * USER RULING (2026-09-11) — the precedence, in order:
 *
 *   1. last viewed (localStorage, restored client-side on mount)
 *   2. else the largest currently-held position (server-side)
 *   3. else alphabetical-first (server-side last resort)
 *
 * An explicit `?id=` outranks all three; it is not a default.
 *
 * The composite matters more than either half: rule 2 is the only one the
 * SERVER can render (localStorage is unreadable there), and rule 1 is the
 * only one that survives a mount. Pinning them separately is how the two
 * files' comments came to state the order backwards while the code did the
 * right thing.
 *
 * These assertions pin BEHAVIOR, not formatting: imports are checked by the
 * symbols they bring in, never by an exact multi-line import statement —
 * an over-pin like that fails on a prettier reflow that changes nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const pageSrc = () => readFileSync("app/dashboard/charts/page.tsx", "utf8");
const viewSrc = () =>
  readFileSync("app/dashboard/components/ChartsView.tsx", "utf8");
const lastSymbolSrc = () =>
  readFileSync("app/dashboard/charts/last-symbol.ts", "utf8");

/** True when `src` imports every one of `names` from `moduleSpecifier`. */
function importsFrom(src: string, moduleSpecifier: string, names: string[]): boolean {
  const escaped = moduleSpecifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // `[^{}]*` (not a lazy `[\s\S]*?`) so the match can only ever span ONE
  // import block — a lazy any-char capture happily swallows every earlier
  // import in the file on its way to the right module specifier.
  const stmt = src.match(
    new RegExp(`import\\s*\\{([^{}]*)\\}\\s*from\\s*["']${escaped}["']`),
  );
  if (!stmt) return false;
  const imported = stmt[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  return names.every((n) => imported.includes(n));
}

describe("charts landing — rule 2 (server): largest currently-held, not securities[0]", () => {
  it("imports the largest-held query from lib/queries/ohlcv", () => {
    expect(
      importsFrom(pageSrc(), "@/lib/queries/ohlcv", [
        "getChartableSecurities",
        "getDefaultChartSecurityId",
        "getLatestPrice",
      ]),
    ).toBe(true);
  });

  it("securities[0] only survives as the alphabetical LAST-RESORT fallback (rule 3), not the primary default", () => {
    const src = pageSrc();
    // The old primary default assigned straight to `defaultSecurity`; now
    // that name is reserved for the final (held-first, else-alphabetical)
    // choice, and the raw alphabetical pick lives under its own name.
    expect(src).toContain("const alphabeticalFallback =");
    expect(src).not.toMatch(/const defaultSecurity =\s*\n\s*securities\.find/);
    // The final default prefers the held id, falling back to the
    // alphabetical pick — never the reverse.
    expect(src).toMatch(
      /const defaultSecurity =\s*\n\s*\(defaultHeldId != null[\s\S]*?\?\?\s*alphabeticalFallback;/,
    );
  });

  it("threads whether the URL carried an explicit ?id= down to ChartsView", () => {
    const src = pageSrc();
    expect(src).toContain("const hasExplicitId = params.id !== undefined;");
    expect(src).toMatch(/<ChartsView[\s\S]*?hasExplicitId={hasExplicitId}/);
  });

  it("still keeps the explicit ?id= override behavior and force-dynamic", () => {
    const src = pageSrc();
    expect(src).toContain('export const dynamic = "force-dynamic";');
    expect(src).toContain(
      "selectedId && !isNaN(selectedId)\n      ? securities.find((s) => s.id === selectedId) ?? defaultSecurity\n      : defaultSecurity",
    );
  });
});

describe("charts landing — rule 1 (client): last viewed wins over the server's held-position default", () => {
  it("imports the last-symbol helpers", () => {
    expect(
      importsFrom(viewSrc(), "../charts/last-symbol", [
        "readLastChartSymbolId",
        "writeLastChartSymbolId",
      ]),
    ).toBe(true);
  });

  it("writes the last-viewed id from the existing select handler", () => {
    const src = viewSrc();
    const handleSelectBody = src.slice(
      src.indexOf("const handleSelect ="),
      src.indexOf("const handleSelect =") + 400,
    );
    expect(handleSelectBody).toContain("writeLastChartSymbolId(secId);");
  });

  it("reads the last-viewed id inside a useEffect, gated on no explicit ?id=, with an empty dep array (mount-only)", () => {
    const src = viewSrc();
    expect(importsFrom(src, "react", ["useEffect", "useState"])).toBe(true);
    const effectStart = src.indexOf("useEffect(() => {");
    expect(effectStart).toBeGreaterThan(-1);
    const effectBody = src.slice(effectStart, src.indexOf("}, []);", effectStart) + 10);
    expect(effectBody).toContain("if (hasExplicitId) return;");
    expect(effectBody).toContain("readLastChartSymbolId()");
    expect(effectBody).toContain("router.replace(`/dashboard/charts?id=${lastId}`");
    // Mount-only: the dependency array is empty, not `[hasExplicitId]` or similar.
    expect(src).toMatch(/}, \[\]\);/);
  });

  it("the restore is UNCONDITIONAL on a stored id — it overrides the server default rather than deferring to it", () => {
    const src = viewSrc();
    const effectStart = src.indexOf("useEffect(() => {");
    const effectBody = src.slice(effectStart, src.indexOf("}, []);", effectStart) + 10);
    // The ONLY early returns are: an explicit ?id=, no/identical stored id,
    // and a stored id that no longer resolves to a listed security. Nothing
    // consults whether the server picked a held position, which is what
    // makes last-viewed rule 1 rather than rule 2.
    expect(effectBody).toContain("if (lastId == null || lastId === selected?.id) return;");
    expect(effectBody).toContain("if (!sec) return;");
    expect(effectBody).not.toMatch(/defaultHeldId|initialSecurity\s*==?=?\s*null\s*\)\s*return/);
    expect(effectBody).toContain("setSelected(sec);");
  });

  it("never reads localStorage during render — the read only happens inside the useEffect body", () => {
    const src = viewSrc();
    const beforeEffect = src.slice(0, src.indexOf("useEffect(() => {"));
    expect(beforeEffect).not.toContain("readLastChartSymbolId(");
  });

  it("accepts hasExplicitId as a required prop", () => {
    const src = viewSrc();
    expect(src).toContain("hasExplicitId: boolean;");
  });
});

describe("charts landing — the ruled order is documented, in order, where the rule lives", () => {
  it("last-symbol.ts states last-viewed FIRST and largest-held SECOND", () => {
    const doc = lastSymbolSrc();
    const lastViewedIdx = doc.indexOf("1. the LAST VIEWED symbol");
    const heldIdx = doc.indexOf("2. else the largest currently-held position");
    const alphaIdx = doc.indexOf("3. else alphabetical-first");
    expect(lastViewedIdx).toBeGreaterThan(-1);
    expect(heldIdx).toBeGreaterThan(lastViewedIdx);
    expect(alphaIdx).toBeGreaterThan(heldIdx);
  });

  it("no file still claims the reversed order (largest-held as step 1, last-viewed as step 2)", () => {
    for (const src of [lastSymbolSrc(), pageSrc(), viewSrc()]) {
      expect(src).not.toMatch(/ruling step 2[\s\S]{0,80}last-viewed/i);
      expect(src).not.toMatch(/\(1\)\s*largest currently-held/i);
    }
  });

  it("records that the server-render-then-swap flash is a deliberate keep, with the reason", () => {
    const doc = lastSymbolSrc();
    expect(doc).toMatch(/flash/i);
    expect(doc).toMatch(/NOT cheap|not cheap/);
    expect(doc).toMatch(/cookie/i);
  });
});
