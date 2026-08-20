/**
 * SPIKE for the print-watch design (2026-08-20).
 * Measurement/analysis tool, NOT product code. Throwaway quality is
 * acceptable — but it must work: this is Phase 4 of the extraction
 * bake-off, the statistical gate that decides whether GREEN cells are
 * trustworthy (§2 of
 * docs/superpowers/specs/2026-08-20-live-print-watch-design.md).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BUILDS
 * ---------------------------------------------------------------------------
 * Scores every parsed candidate (produced by scripts/spike-bakeoff-parse.ts,
 * built by another agent in parallel — this script only READS its output)
 * against the frozen gold answers for every bake-off event, classifies each
 * (event, representation, metric_id) line, and simulates the live
 * pipeline's GREEN (mechanical-agreement) promotion rule for two parser
 * pairs:
 *   AB — same-document: two representations of the SAME parse target
 *        (repA, repB — e.g. normalized-table vs rendered-page, §4.4)
 *   AC — cross-document: repA vs repC, when repC exists for the event
 *        (a different document/vendor — the decorrelation candidate)
 *
 * Reports, per representation and per pair:
 *   - accuracy + full error-class breakdown
 *   - GREEN coverage / precision / catastrophic count / abstain rate
 *   - the correlated-error rate Codex demanded (design §4.4, Codex 6):
 *     among lines where A is wrong, how often the partner is ALSO wrong
 *     with the SAME wrong value. This is the number that decides whether
 *     the "independent parses" claim holds, or whether a second vendor /
 *     third representation is needed before GREEN can go live.
 *
 * ---------------------------------------------------------------------------
 * CLASSIFICATION (per event, representation, metric_id)
 * ---------------------------------------------------------------------------
 *   correct      — not_disclosed flags agree AND value (+ value_high for
 *                  ranges) matches gold within 1e-6 RELATIVE tolerance.
 *   wrong_unit   — wrong, but matches gold × or ÷ one of
 *                  [1e3, 1e6, 1e9, 100] (scale/percent slip). For a range
 *                  line, the SAME factor must reconcile both value and
 *                  value_high — an inconsistent scale isn't a clean slip.
 *   cross_line   — wrong, but the candidate's value matches a DIFFERENT
 *                  metric_id's gold value in the same event (grabbed the
 *                  wrong row). The target metric_id is recorded.
 *   false_match  — gold says not_disclosed but the parser produced a
 *                  value. CATASTROPHIC (per §2, always — not just when
 *                  greened).
 *   missed       — gold has a value but the parser said not_disclosed.
 *                  Abstention-style miss, NOT catastrophic.
 *   absent       — the parser returned no candidate entry for the
 *                  metric_id at all (checked BEFORE looking at gold
 *                  disclosure — an absent line is a non-answer, not a
 *                  disclosure judgement).
 *   wrong_value  — wrong, none of the above patterns.
 *
 * NOTE on wrong-basis / wrong-period: contracts.json pins basis and
 * period per metric_id (one contract line = one specific basis/period
 * combination), so a parser that reads the right NUMBER off the wrong
 * basis/period row of the source document has no distinct class here —
 * it manifests as cross_line (if that row happens to BE another
 * contract's gold answer) or wrong_value (if not). This is a modeling
 * choice inherited from the contract shape, not an oversight.
 *
 * ---------------------------------------------------------------------------
 * GREEN SIMULATION (a pair, not a single representation)
 * ---------------------------------------------------------------------------
 * A pair GREENS a line when both candidates AGREE WITH EACH OTHER —
 * not_disclosed flags match, and (if disclosed) values match within
 * tolerance. Agreement is computed candidate-vs-candidate; correctness
 * against gold is a SEPARATE question, evaluated only for greened lines.
 *
 *   coverage              greenedValuedLines / goldValuedLines
 *                          (goldValuedLines = contract lines where gold
 *                          actually has a value, i.e. not gold-not-
 *                          disclosed — coverage measures how much of the
 *                          real data got filled in live, not credit for
 *                          agreeing that something is undisclosed)
 *   precision              greenedCorrect / greenedTotal
 *                          (greenedTotal counts EVERY greened line,
 *                          including greened not-disclosed agreement —
 *                          this is the number that stands in for the
 *                          ≥99%-precision-among-GREEN-cells SLO in §2)
 *   catastrophicCount       greened lines whose class is false_match,
 *                          cross_line, or wrong_unit — the severe,
 *                          plausible-looking wrong-answer classes. Per
 *                          the task spec this MUST be zero to pass.
 *                          Deliberately narrower than "any wrong greened
 *                          line": a plain wrong_value that both parsers
 *                          independently agree on is still wrong, and it
 *                          still drags precision down — but it is
 *                          reported through correlatedErrorRate below,
 *                          not lumped into "catastrophic". Treat
 *                          precision as the overall GREEN-cell honesty
 *                          number and catastrophicCount as the specific
 *                          severe subclasses the design calls out.
 *   abstainRate            1 - (greenedTotal / totalLines) — the
 *                          fraction of lines the pair declined to green
 *                          (disagreement, or either side absent).
 *   correlatedErrorRate    Restricted to lines where A itself is wrong
 *                          (class not in {correct, absent}): the
 *                          fraction where the partner is ALSO wrong AND
 *                          agrees with A's exact (wrong) answer. High
 *                          correlation here means the two representations
 *                          are not actually independent — they'd have
 *                          greened the SAME mistake.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA NOTE (resolved ambiguity)
 * ---------------------------------------------------------------------------
 * The task spec describes contracts.json as a bare array of contract
 * objects. The file actually produced for HD-2026-08-18 (present on disk
 * when this script was written) is instead an object —
 * {symbol, event_date, issuer, ..., contracts: [...]} — with the array
 * nested under a `contracts` key plus useful labeling metadata
 * (labeler_notes, docs_present, primary_doc). gold-frozen.json's shape
 * was not yet frozen/observed at all when this script was written (no
 * gold-*.json exists anywhere in the corpus yet — that's the
 * orchestrator's job, later). To avoid a schema fight blocking this
 * script, asArray() below accepts EITHER a bare array OR an object
 * carrying the array under a known key (tried in order, then falls back
 * to the first array-valued property found) for BOTH contracts.json and
 * gold-frozen.json. The classify/score logic itself is agnostic to which
 * shape wins — only asArray()'s preferredKeys lists would need
 * adjustment if a producer settles on a different key name.
 *
 * ---------------------------------------------------------------------------
 * INPUTS (per event dir under tests/fixtures/real/bakeoff/{SYMBOL}-{DATE}/)
 * ---------------------------------------------------------------------------
 *   contracts.json      — line contracts (metric_id, basis, period, kind, …)
 *   gold-frozen.json    — frozen adjudicated gold. This script NEVER reads
 *                         gold-claude.json / gold-codex.json (pre-
 *                         adjudication drafts) — only the frozen merge is
 *                         truth, and if it doesn't exist yet the event is
 *                         skipped (reported, not fatal).
 *   parse-repA.json / parse-repB.json / parse-repC.json (C optional) —
 *                         {representation, model_id, candidates:[…]}
 *
 * ---------------------------------------------------------------------------
 * OUTPUT (gitignored — tests/fixtures/real/ — verified via
 * `git check-ignore -v`, .gitignore line 49)
 * ---------------------------------------------------------------------------
 *   tests/fixtures/real/bakeoff/scores.json        full per-line detail
 *   tests/fixtures/real/bakeoff/bakeoff-report.md  headline + per-event +
 *                                                   worst-lines tables
 * Both paths are fixed under tests/fixtures/real/bakeoff/ — the report is
 * never written anywhere else.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/spike-bakeoff-score.ts [--events HD-2026-08-18,CRWD]
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/spike-bakeoff-score.ts --selftest
 *
 * Pure offline scoring over whatever's already on disk under
 * tests/fixtures/real/bakeoff/ — no TWS, no EDGAR, no network calls.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUT_ROOT = join(process.cwd(), "tests", "fixtures", "real", "bakeoff");
const SCORES_PATH = join(OUT_ROOT, "scores.json");
const REPORT_PATH = join(OUT_ROOT, "bakeoff-report.md");

const RELATIVE_TOLERANCE = 1e-6;
const SCALE_FACTORS = [1e3, 1e6, 1e9, 100];
const REP_KEYS = ["A", "B", "C"] as const;
type RepKey = (typeof REP_KEYS)[number];
const PAIR_KEYS = ["AB", "AC"] as const;
type PairKey = (typeof PAIR_KEYS)[number];

// ---------------------------------------------------------------------------
// Types (per the schemas in the task; see SCHEMA NOTE above for the
// contracts.json / gold-frozen.json wrapper-object accommodation)
// ---------------------------------------------------------------------------

type Kind = "point" | "range";

interface Contract {
  metric_id: string;
  label: string;
  definition: string;
  basis: string;
  period: string;
  currency: string;
  unit: string;
  kind: Kind;
  segment: string | null;
}

interface GoldLine {
  metric_id: string;
  value: number | null;
  value_high: number | null;
  raw_text: string | null;
  snippet: string | null;
  source_doc: string | null;
  not_disclosed: boolean;
  adjudication?: string;
}

interface Candidate {
  metric_id: string;
  value: number | null;
  value_high: number | null;
  raw_text: string | null;
  snippet: string | null;
  location_hint: string | null;
  not_disclosed: boolean;
}

interface ParseRep {
  representation: string;
  model_id: string;
  candidates: Candidate[];
}

type LineClass =
  | "correct"
  | "wrong_unit"
  | "cross_line"
  | "false_match"
  | "missed"
  | "absent"
  | "wrong_value";

const ALL_CLASSES: LineClass[] = [
  "correct",
  "wrong_unit",
  "cross_line",
  "false_match",
  "missed",
  "absent",
  "wrong_value",
];

function emptyClassCounts(): Record<LineClass, number> {
  return {
    correct: 0,
    wrong_unit: 0,
    cross_line: 0,
    false_match: 0,
    missed: 0,
    absent: 0,
    wrong_value: 0,
  };
}

/** Classes that are catastrophic-if-greened (see report preamble for why
 * plain wrong_value agreement is tracked separately via correlatedErrorRate
 * instead of folded in here). */
const GREEN_CATASTROPHIC_CLASSES: ReadonlySet<LineClass> = new Set([
  "false_match",
  "cross_line",
  "wrong_unit",
]);

// ---------------------------------------------------------------------------
// JSON loading helpers
// ---------------------------------------------------------------------------

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Accept either a bare array, or an object carrying the array under one of
 * `preferredKeys` (tried in order), or — last resort — the first
 * array-valued property found on the object. See SCHEMA NOTE above.
 */
function asArray(json: unknown, preferredKeys: string[], what: string): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const k of preferredKeys) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v;
    }
  }
  throw new Error(
    `${what}: expected an array, or an object containing one (tried keys: ${preferredKeys.join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// Numeric comparison
// ---------------------------------------------------------------------------

function relMatch(a: number | null, b: number | null, tol = RELATIVE_TOLERANCE): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a === b) return true;
  if (a === 0 || b === 0) return Math.abs(a - b) <= tol;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= tol;
}

interface ValuePair {
  value: number | null;
  value_high: number | null;
}

/** Do two (value, value_high) pairs match, respecting `kind`? For "range",
 * BOTH components must match; value_high is ignored for "point". */
function pairMatches(a: ValuePair, b: ValuePair, kind: Kind): boolean {
  if (!relMatch(a.value, b.value)) return false;
  if (kind === "range") return relMatch(a.value_high ?? null, b.value_high ?? null);
  return true;
}

function scaledPair(base: ValuePair, mult: number): ValuePair {
  return {
    value: base.value === null ? null : base.value * mult,
    value_high: base.value_high === null ? null : base.value_high * mult,
  };
}

/** Wrong, but reconciled by a single consistent ×/÷ scale factor applied to
 * BOTH components (a range line needs the same factor on value AND
 * value_high — an inconsistent scale isn't a clean unit slip). */
function isWrongUnit(candidate: ValuePair, gold: ValuePair, kind: Kind): boolean {
  if (gold.value === null || gold.value === 0) return false;
  for (const f of SCALE_FACTORS) {
    for (const mult of [f, 1 / f]) {
      if (pairMatches(candidate, scaledPair(gold, mult), kind)) return true;
    }
  }
  return false;
}

/** Does candidate.value match some OTHER metric_id's gold value in this
 * event? Returns the first matching metric_id, or null. Matches on the
 * primary `value` only (see class-doc comment above for rationale). */
function findCrossLineMatch(
  candidate: Candidate,
  ownMetricId: string,
  goldByMetric: Map<string, GoldLine>,
): string | null {
  if (candidate.value === null) return null;
  for (const [metricId, gold] of goldByMetric) {
    if (metricId === ownMetricId) continue;
    if (gold.not_disclosed || gold.value === null) continue;
    if (relMatch(candidate.value, gold.value)) return metricId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface ClassifyResult {
  cls: LineClass;
  crossLineTarget: string | null;
}

function classifyLine(
  contract: Contract,
  gold: GoldLine,
  candidate: Candidate | undefined,
  goldByMetric: Map<string, GoldLine>,
): ClassifyResult {
  if (!candidate) return { cls: "absent", crossLineTarget: null };

  const candND = Boolean(candidate.not_disclosed);
  const goldND = Boolean(gold.not_disclosed);

  if (goldND) {
    return candND
      ? { cls: "correct", crossLineTarget: null }
      : { cls: "false_match", crossLineTarget: null };
  }
  if (candND) return { cls: "missed", crossLineTarget: null };

  const goldPair: ValuePair = { value: gold.value, value_high: gold.value_high };
  const candPair: ValuePair = { value: candidate.value, value_high: candidate.value_high };

  if (pairMatches(candPair, goldPair, contract.kind)) return { cls: "correct", crossLineTarget: null };
  if (isWrongUnit(candPair, goldPair, contract.kind)) return { cls: "wrong_unit", crossLineTarget: null };
  const crossTarget = findCrossLineMatch(candidate, contract.metric_id, goldByMetric);
  if (crossTarget) return { cls: "cross_line", crossLineTarget: crossTarget };
  return { cls: "wrong_value", crossLineTarget: null };
}

/** Do two candidates (not vs gold — vs EACH OTHER) agree? Used both for the
 * GREEN simulation and, restricted to lines where one side is wrong, for
 * the correlated-error stat ("wrong with the SAME value"). */
function candidatesAgree(
  x: Candidate | undefined,
  y: Candidate | undefined,
  kind: Kind,
): boolean {
  if (!x || !y) return false;
  const xnd = Boolean(x.not_disclosed);
  const ynd = Boolean(y.not_disclosed);
  if (xnd !== ynd) return false;
  if (xnd) return true;
  return pairMatches(
    { value: x.value, value_high: x.value_high },
    { value: y.value, value_high: y.value_high },
    kind,
  );
}

// ---------------------------------------------------------------------------
// Per-event scoring
// ---------------------------------------------------------------------------

interface LineDetail {
  metric_id: string;
  contract: Pick<Contract, "label" | "basis" | "period" | "kind" | "unit" | "segment">;
  gold: GoldLine;
  class: LineClass;
  crossLineTarget: string | null;
  candidate: Candidate | null;
}

interface RepScore {
  representation: string;
  model_id: string;
  lines: LineDetail[];
  classCounts: Record<LineClass, number>;
  n: number;
  correctPct: number;
}

interface PairLine {
  metric_id: string;
  agree: boolean;
  classX: LineClass;
  classY: LineClass;
  greenCatastrophic: boolean;
  correlatedWrong: boolean;
}

interface PairScore {
  pair: PairKey;
  kind: "same-document" | "cross-document";
  repX: string;
  repY: string;
  goldValuedLines: number;
  greenedValuedLines: number;
  coverage: number;
  greenedTotal: number;
  greenedCorrect: number;
  precision: number;
  catastrophicCount: number;
  catastrophicLines: { metric_id: string; class: LineClass }[];
  abstainRate: number;
  totalLines: number;
  wrongXCount: number;
  correlatedWrongCount: number;
  correlatedErrorRate: number;
  lines: PairLine[];
}

interface EventResult {
  name: string;
  symbol: string;
  eventDate: string;
  skipped: boolean;
  skipReason: string | null;
  warnings: string[];
  contractCount: number;
  goldValuedCount: number;
  goldNotDisclosedCount: number;
  noGoldCount: number;
  representations: Partial<Record<RepKey, RepScore>>;
  pairs: Partial<Record<PairKey, PairScore>>;
}

/**
 * Core scorer — takes already-parsed inputs so it can be exercised
 * identically by the real (file-loading) path and --selftest.
 */
function scoreEventCore(
  name: string,
  contractsRaw: Contract[],
  goldRaw: GoldLine[],
  reps: Partial<Record<RepKey, ParseRep>>,
): EventResult {
  const [symbol, ...rest] = name.split("-");
  const eventDate = rest.join("-");
  const warnings: string[] = [];

  const goldByMetric = new Map<string, GoldLine>();
  for (const g of goldRaw) {
    if (goldByMetric.has(g.metric_id)) {
      warnings.push(`duplicate gold entry for ${g.metric_id} — keeping first`);
      continue;
    }
    goldByMetric.set(g.metric_id, g);
  }

  const scorable = contractsRaw.filter((c) => goldByMetric.has(c.metric_id));
  const noGold = contractsRaw.filter((c) => !goldByMetric.has(c.metric_id));
  if (noGold.length > 0) {
    warnings.push(
      `${noGold.length} contract line(s) with no gold entry, excluded: ${noGold.map((c) => c.metric_id).join(", ")}`,
    );
  }
  const contractIds = new Set(contractsRaw.map((c) => c.metric_id));
  const extraGold = [...goldByMetric.keys()].filter((id) => !contractIds.has(id));
  if (extraGold.length > 0) {
    warnings.push(`${extraGold.length} gold entry/entries with no matching contract, ignored: ${extraGold.join(", ")}`);
  }

  const goldValuedCount = scorable.filter((c) => !goldByMetric.get(c.metric_id)!.not_disclosed).length;
  const goldNotDisclosedCount = scorable.length - goldValuedCount;

  const repIndex: Partial<Record<RepKey, { parsed: ParseRep; index: Map<string, Candidate> }>> = {};
  for (const key of REP_KEYS) {
    const parsed = reps[key];
    if (!parsed) continue;
    const index = new Map<string, Candidate>();
    const dups: string[] = [];
    for (const c of parsed.candidates ?? []) {
      if (index.has(c.metric_id)) {
        dups.push(c.metric_id);
        continue;
      }
      index.set(c.metric_id, c);
    }
    if (dups.length > 0) warnings.push(`rep ${key}: duplicate candidate metric_id(s) ${dups.join(", ")} — kept first`);
    repIndex[key] = { parsed, index };
  }

  const representations: Partial<Record<RepKey, RepScore>> = {};
  const perRepClassify: Partial<Record<RepKey, Map<string, ClassifyResult>>> = {};

  for (const key of REP_KEYS) {
    const rd = repIndex[key];
    if (!rd) continue;
    const lines: LineDetail[] = [];
    const classCounts = emptyClassCounts();
    const classifyMap = new Map<string, ClassifyResult>();
    for (const c of scorable) {
      const gold = goldByMetric.get(c.metric_id)!;
      const candidate = rd.index.get(c.metric_id);
      const result = classifyLine(c, gold, candidate, goldByMetric);
      classCounts[result.cls] += 1;
      classifyMap.set(c.metric_id, result);
      lines.push({
        metric_id: c.metric_id,
        contract: { label: c.label, basis: c.basis, period: c.period, kind: c.kind, unit: c.unit, segment: c.segment },
        gold,
        class: result.cls,
        crossLineTarget: result.crossLineTarget,
        candidate: candidate ?? null,
      });
    }
    perRepClassify[key] = classifyMap;
    const n = scorable.length;
    representations[key] = {
      representation: rd.parsed.representation,
      model_id: rd.parsed.model_id,
      lines,
      classCounts,
      n,
      correctPct: n > 0 ? (classCounts.correct / n) * 100 : 0,
    };
  }

  const pairs: Partial<Record<PairKey, PairScore>> = {};
  const pairDefs: { pair: PairKey; x: RepKey; y: RepKey; kind: PairScore["kind"] }[] = [];
  if (repIndex.A && repIndex.B) pairDefs.push({ pair: "AB", x: "A", y: "B", kind: "same-document" });
  if (repIndex.A && repIndex.C) pairDefs.push({ pair: "AC", x: "A", y: "C", kind: "cross-document" });

  for (const { pair, x, y, kind } of pairDefs) {
    const rdx = repIndex[x]!;
    const rdy = repIndex[y]!;
    const classifyX = perRepClassify[x]!;
    const classifyY = perRepClassify[y]!;

    const lines: PairLine[] = [];
    let greenedValuedLines = 0;
    let greenedTotal = 0;
    let greenedCorrect = 0;
    let catastrophicCount = 0;
    const catastrophicLines: { metric_id: string; class: LineClass }[] = [];
    let wrongXCount = 0;
    let correlatedWrongCount = 0;

    for (const c of scorable) {
      const gold = goldByMetric.get(c.metric_id)!;
      const candX = rdx.index.get(c.metric_id);
      const candY = rdy.index.get(c.metric_id);
      const agree = candidatesAgree(candX, candY, c.kind);
      const classX = classifyX.get(c.metric_id)!.cls;
      const classY = classifyY.get(c.metric_id)!.cls;

      let greenCatastrophic = false;
      if (agree) {
        greenedTotal += 1;
        if (!gold.not_disclosed) greenedValuedLines += 1;
        if (classX === "correct") greenedCorrect += 1;
        if (GREEN_CATASTROPHIC_CLASSES.has(classX)) {
          greenCatastrophic = true;
          catastrophicCount += 1;
          catastrophicLines.push({ metric_id: c.metric_id, class: classX });
        }
      }

      const xIsWrong = classX !== "correct" && classX !== "absent";
      let correlatedWrong = false;
      if (xIsWrong) {
        wrongXCount += 1;
        const yIsWrong = classY !== "correct" && classY !== "absent";
        if (yIsWrong && agree) {
          correlatedWrong = true;
          correlatedWrongCount += 1;
        }
      }

      lines.push({ metric_id: c.metric_id, agree, classX, classY, greenCatastrophic, correlatedWrong });
    }

    pairs[pair] = {
      pair,
      kind,
      repX: rdx.parsed.representation,
      repY: rdy.parsed.representation,
      goldValuedLines: goldValuedCount,
      greenedValuedLines,
      coverage: goldValuedCount > 0 ? greenedValuedLines / goldValuedCount : 0,
      greenedTotal,
      greenedCorrect,
      precision: greenedTotal > 0 ? greenedCorrect / greenedTotal : 0,
      catastrophicCount,
      catastrophicLines,
      abstainRate: scorable.length > 0 ? 1 - greenedTotal / scorable.length : 0,
      totalLines: scorable.length,
      wrongXCount,
      correlatedWrongCount,
      correlatedErrorRate: wrongXCount > 0 ? correlatedWrongCount / wrongXCount : 0,
      lines,
    };
  }

  return {
    name,
    symbol,
    eventDate,
    skipped: false,
    skipReason: null,
    warnings,
    contractCount: contractsRaw.length,
    goldValuedCount,
    goldNotDisclosedCount,
    noGoldCount: noGold.length,
    representations,
    pairs,
  };
}

// ---------------------------------------------------------------------------
// File-backed event discovery + loading
// ---------------------------------------------------------------------------

interface EventPaths {
  name: string;
  dir: string;
  contractsPath: string;
  goldPath: string;
  repPaths: Partial<Record<RepKey, string>>;
}

function discoverEvents(root: string): EventPaths[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory())
    .sort();
  return entries.map((name) => {
    const dir = join(root, name);
    return {
      name,
      dir,
      contractsPath: join(dir, "contracts.json"),
      goldPath: join(dir, "gold-frozen.json"),
      repPaths: {
        A: join(dir, "parse-repA.json"),
        B: join(dir, "parse-repB.json"),
        C: join(dir, "parse-repC.json"),
      },
    };
  });
}

function matchesFilter(name: string, filter: string[] | null): boolean {
  if (!filter) return true;
  const symbol = name.split("-")[0]?.toUpperCase() ?? "";
  const upper = name.toUpperCase();
  return filter.some((f) => f === upper || f === symbol);
}

function scoreEventFromDisk(paths: EventPaths): EventResult {
  const missing: string[] = [];
  if (!existsSync(paths.contractsPath)) missing.push("contracts.json");
  if (!existsSync(paths.goldPath)) missing.push("gold-frozen.json");
  if (missing.length > 0) {
    const [symbol, ...rest] = paths.name.split("-");
    return {
      name: paths.name,
      symbol,
      eventDate: rest.join("-"),
      skipped: true,
      skipReason: `missing ${missing.join(", ")} — not yet gold-labeled`,
      warnings: [],
      contractCount: 0,
      goldValuedCount: 0,
      goldNotDisclosedCount: 0,
      noGoldCount: 0,
      representations: {},
      pairs: {},
    };
  }

  const contracts = asArray(
    loadJson(paths.contractsPath),
    ["contracts"],
    `${paths.name}/contracts.json`,
  ) as Contract[];
  const gold = asArray(
    loadJson(paths.goldPath),
    ["gold", "lines", "items"],
    `${paths.name}/gold-frozen.json`,
  ) as GoldLine[];

  const reps: Partial<Record<RepKey, ParseRep>> = {};
  for (const key of REP_KEYS) {
    const p = paths.repPaths[key];
    if (p && existsSync(p)) reps[key] = loadJson(p) as ParseRep;
  }

  const result = scoreEventCore(paths.name, contracts, gold, reps);
  if (!reps.A || !reps.B) {
    result.warnings.push(
      `only ${Object.keys(reps).join(",") || "none"} of A/B/C present — AB pair needs both A and B`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface RepSummary {
  representationLabel: string | null;
  modelId: string | null;
  n: number;
  classCounts: Record<LineClass, number>;
  correctPct: number;
}

interface PairSummary {
  goldValuedLines: number;
  greenedValuedLines: number;
  coverage: number;
  greenedTotal: number;
  greenedCorrect: number;
  precision: number;
  catastrophicCount: number;
  totalLines: number;
  abstainRate: number;
  wrongXCount: number;
  correlatedWrongCount: number;
  correlatedErrorRate: number;
}

function summarize(events: EventResult[]): {
  perRep: Partial<Record<RepKey, RepSummary>>;
  perPair: Partial<Record<PairKey, PairSummary>>;
} {
  const perRep: Partial<Record<RepKey, RepSummary>> = {};
  for (const key of REP_KEYS) {
    const agg: RepSummary = {
      representationLabel: null,
      modelId: null,
      n: 0,
      classCounts: emptyClassCounts(),
      correctPct: 0,
    };
    let any = false;
    for (const ev of events) {
      const rep = ev.representations[key];
      if (!rep) continue;
      any = true;
      if (agg.representationLabel === null) agg.representationLabel = rep.representation;
      if (agg.modelId === null) agg.modelId = rep.model_id;
      agg.n += rep.n;
      for (const cls of ALL_CLASSES) agg.classCounts[cls] += rep.classCounts[cls];
    }
    if (any) {
      agg.correctPct = agg.n > 0 ? (agg.classCounts.correct / agg.n) * 100 : 0;
      perRep[key] = agg;
    }
  }

  const perPair: Partial<Record<PairKey, PairSummary>> = {};
  for (const key of PAIR_KEYS) {
    const agg: PairSummary = {
      goldValuedLines: 0,
      greenedValuedLines: 0,
      coverage: 0,
      greenedTotal: 0,
      greenedCorrect: 0,
      precision: 0,
      catastrophicCount: 0,
      totalLines: 0,
      abstainRate: 0,
      wrongXCount: 0,
      correlatedWrongCount: 0,
      correlatedErrorRate: 0,
    };
    let any = false;
    for (const ev of events) {
      const p = ev.pairs[key];
      if (!p) continue;
      any = true;
      agg.goldValuedLines += p.goldValuedLines;
      agg.greenedValuedLines += p.greenedValuedLines;
      agg.greenedTotal += p.greenedTotal;
      agg.greenedCorrect += p.greenedCorrect;
      agg.catastrophicCount += p.catastrophicCount;
      agg.totalLines += p.totalLines;
      agg.wrongXCount += p.wrongXCount;
      agg.correlatedWrongCount += p.correlatedWrongCount;
    }
    if (any) {
      agg.coverage = agg.goldValuedLines > 0 ? agg.greenedValuedLines / agg.goldValuedLines : 0;
      agg.precision = agg.greenedTotal > 0 ? agg.greenedCorrect / agg.greenedTotal : 0;
      agg.abstainRate = agg.totalLines > 0 ? 1 - agg.greenedTotal / agg.totalLines : 0;
      agg.correlatedErrorRate = agg.wrongXCount > 0 ? agg.correlatedWrongCount / agg.wrongXCount : 0;
      perPair[key] = agg;
    }
  }

  return { perRep, perPair };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtVal(v: number | null): string {
  if (v === null) return "—";
  return Number.isInteger(v) ? String(v) : v.toString();
}

function candidateSummary(c: Candidate | null): string {
  if (!c) return "(absent)";
  if (c.not_disclosed) return "not_disclosed";
  const v = fmtVal(c.value);
  const vh = c.value_high !== null ? `..${fmtVal(c.value_high)}` : "";
  return `${v}${vh}`;
}

function goldSummary(g: GoldLine): string {
  if (g.not_disclosed) return "not_disclosed";
  const v = fmtVal(g.value);
  const vh = g.value_high !== null ? `..${fmtVal(g.value_high)}` : "";
  return `${v}${vh}`;
}

function renderReport(events: EventResult[], summary: ReturnType<typeof summarize>): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push("# Extraction Bake-off — Score Report");
  lines.push("");
  lines.push(`Generated ${now}`);
  lines.push("");
  lines.push(
    "Scores every parsed candidate against frozen gold per the statistical gate in " +
      "docs/superpowers/specs/2026-08-20-live-print-watch-design.md §2. Produced by " +
      "scripts/spike-bakeoff-score.ts.",
  );
  lines.push("");

  lines.push("## Interpretation notes");
  lines.push("");
  lines.push(`- Numeric tolerance: 1e-6 RELATIVE (symmetric, \`|a-b| / max(|a|,|b|)\`).`);
  lines.push(`- wrong_unit scale factors tested (both × and ÷): ${SCALE_FACTORS.join(", ")}.`);
  lines.push(
    "- Wrong-basis / wrong-period manifest as cross_line or wrong_value here, not a distinct class — " +
      "contracts.json pins basis and period per metric_id, so a parser reading the right number off the " +
      "wrong basis/period row either happens to match another contract's gold value (cross_line) or doesn't " +
      "(wrong_value).",
  );
  lines.push(
    "- `absent` is checked before gold disclosure state — a missing candidate is a non-answer, not a " +
      "disclosure judgement, even when gold itself says not_disclosed.",
  );
  lines.push(
    "- Green coverage denominator is gold-VALUED lines only (excludes gold-not_disclosed lines); the " +
      "numerator is greened lines that are also gold-valued. Green precision's denominator is ALL greened " +
      "lines (including greened not_disclosed-agreement).",
  );
  lines.push(
    "- Green catastrophicCount is deliberately narrower than \"any wrong greened line\": only " +
      "false_match / cross_line / wrong_unit count (the severe, plausible-looking classes the design calls " +
      "out — see §2's catastrophic-error definition). A plain wrong_value that both parsers happen to agree " +
      "on is still wrong and still drags precision down, but it's surfaced via correlatedErrorRate instead " +
      "of catastrophicCount.",
  );
  lines.push(
    "- correlatedErrorRate denominator is lines where the FIRST representation of the pair (A) is wrong " +
      "(class not in {correct, absent}); numerator is the subset where the partner is ALSO wrong and agrees " +
      "with A's exact (wrong) answer. Both pairs share the same A, so wrongXCount is identical across AB " +
      "and AC for a given event.",
  );
  lines.push(
    "- SCHEMA NOTE: contracts.json and gold-frozen.json are accepted as either a bare array or an object " +
      "with the array nested under a key (contracts.json observed on disk as the latter, wrapped under " +
      "`contracts`). See the script header for the exact fallback order.",
  );
  lines.push("");

  const scoredEvents = events.filter((e) => !e.skipped);
  const skippedEvents = events.filter((e) => e.skipped);

  lines.push("## Headline — per representation");
  lines.push("");
  if (Object.keys(summary.perRep).length === 0) {
    lines.push("_No representations scored yet (no event has both contracts.json and gold-frozen.json plus at least one parse-repX.json)._");
  } else {
    lines.push(
      "| rep | representation | model | n | correct% | " +
        ALL_CLASSES.filter((c) => c !== "correct").join(" | ") +
        " |",
    );
    lines.push("|---|---|---|---|---|" + ALL_CLASSES.filter((c) => c !== "correct").map(() => "---").join("|") + "|");
    for (const key of REP_KEYS) {
      const s = summary.perRep[key];
      if (!s) continue;
      const other = ALL_CLASSES.filter((c) => c !== "correct").map((c) => String(s.classCounts[c]));
      lines.push(
        `| ${key} | ${s.representationLabel ?? "—"} | ${s.modelId ?? "—"} | ${s.n} | ${s.correctPct.toFixed(1)}% | ${other.join(" | ")} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Headline — per pair");
  lines.push("");
  if (Object.keys(summary.perPair).length === 0) {
    lines.push("_No pairs scored yet (need at least repA + repB for one event)._");
  } else {
    lines.push("| pair | kind | coverage | precision | catastrophic | abstain rate | correlated-error rate | wrong-X n |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const key of PAIR_KEYS) {
      const s = summary.perPair[key];
      if (!s) continue;
      const kindLabel = key === "AB" ? "same-document" : "cross-document";
      lines.push(
        `| ${key} | ${kindLabel} | ${pct(s.coverage)} | ${pct(s.precision)} | ${s.catastrophicCount} | ${pct(s.abstainRate)} | ${pct(s.correlatedErrorRate)} | ${s.wrongXCount} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Per-event");
  lines.push("");
  lines.push("| event | status | contracts | gold-valued | rep A correct% | rep B correct% | rep C correct% | AB coverage | AB precision | AB catastrophic | AC coverage | AC precision | AC catastrophic |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const ev of events) {
    if (ev.skipped) {
      lines.push(`| ${ev.name} | skipped | — | — | — | — | — | — | — | — | — | — | — |`);
      continue;
    }
    const rA = ev.representations.A;
    const rB = ev.representations.B;
    const rC = ev.representations.C;
    const ab = ev.pairs.AB;
    const ac = ev.pairs.AC;
    lines.push(
      `| ${ev.name} | scored | ${ev.contractCount} | ${ev.goldValuedCount} | ` +
        `${rA ? rA.correctPct.toFixed(1) + "%" : "—"} | ${rB ? rB.correctPct.toFixed(1) + "%" : "—"} | ${rC ? rC.correctPct.toFixed(1) + "%" : "—"} | ` +
        `${ab ? pct(ab.coverage) : "—"} | ${ab ? pct(ab.precision) : "—"} | ${ab ? ab.catastrophicCount : "—"} | ` +
        `${ac ? pct(ac.coverage) : "—"} | ${ac ? pct(ac.precision) : "—"} | ${ac ? ac.catastrophicCount : "—"} |`,
    );
  }
  lines.push("");

  if (skippedEvents.length > 0) {
    lines.push("### Skipped events");
    lines.push("");
    for (const ev of skippedEvents) lines.push(`- **${ev.name}**: ${ev.skipReason}`);
    lines.push("");
  }

  const eventWarnings = scoredEvents.filter((e) => e.warnings.length > 0);
  if (eventWarnings.length > 0) {
    lines.push("### Warnings");
    lines.push("");
    for (const ev of eventWarnings) {
      for (const w of ev.warnings) lines.push(`- **${ev.name}**: ${w}`);
    }
    lines.push("");
  }

  lines.push("## Worst lines (catastrophic-class)");
  lines.push("");

  const falseMatchLines: { event: string; line: LineDetail }[] = [];
  for (const ev of scoredEvents) {
    for (const key of REP_KEYS) {
      const rep = ev.representations[key];
      if (!rep) continue;
      for (const line of rep.lines) {
        if (line.class === "false_match") falseMatchLines.push({ event: `${ev.name} (rep ${key})`, line });
      }
    }
  }

  lines.push("### false_match (parser produced a value gold says is not disclosed) — always catastrophic");
  lines.push("");
  if (falseMatchLines.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| event | metric | gold | candidate | candidate snippet |");
    lines.push("|---|---|---|---|---|");
    for (const { event, line } of falseMatchLines) {
      lines.push(
        `| ${event} | ${line.metric_id} | ${goldSummary(line.gold)} | ${candidateSummary(line.candidate)} | ${(line.candidate?.snippet ?? "").replace(/\|/g, "\\|").slice(0, 200)} |`,
      );
    }
  }
  lines.push("");

  const greenCatastrophicLines: { event: string; pair: PairKey; metric_id: string; class: LineClass }[] = [];
  for (const ev of scoredEvents) {
    for (const key of PAIR_KEYS) {
      const p = ev.pairs[key];
      if (!p) continue;
      for (const l of p.lines) {
        if (l.greenCatastrophic) greenCatastrophicLines.push({ event: ev.name, pair: key, metric_id: l.metric_id, class: l.classX });
      }
    }
  }

  lines.push("### Greened but catastrophic (false_match / cross_line / wrong_unit that a pair independently agreed on) — must be ZERO");
  lines.push("");
  if (greenCatastrophicLines.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| event | pair | metric | class | gold | rep A candidate | rep A snippet |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const g of greenCatastrophicLines) {
      const ev = scoredEvents.find((e) => e.name === g.event)!;
      const goldLine = ev.representations.A?.lines.find((l) => l.metric_id === g.metric_id);
      lines.push(
        `| ${g.event} | ${g.pair} | ${g.metric_id} | ${g.class} | ${goldLine ? goldSummary(goldLine.gold) : "—"} | ${goldLine ? candidateSummary(goldLine.candidate) : "—"} | ${(goldLine?.candidate?.snippet ?? "").replace(/\|/g, "\\|").slice(0, 200)} |`,
      );
    }
  }
  lines.push("");

  const crossLineLines: { event: string; rep: RepKey; line: LineDetail }[] = [];
  for (const ev of scoredEvents) {
    for (const key of REP_KEYS) {
      const rep = ev.representations[key];
      if (!rep) continue;
      for (const line of rep.lines) {
        if (line.class === "cross_line") crossLineLines.push({ event: ev.name, rep: key, line });
      }
    }
  }
  lines.push("### cross_line (grabbed a different metric's value) — full list");
  lines.push("");
  if (crossLineLines.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| event | rep | metric | took from | gold | candidate | snippet |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const { event, rep, line } of crossLineLines) {
      lines.push(
        `| ${event} | ${rep} | ${line.metric_id} | ${line.crossLineTarget ?? "—"} | ${goldSummary(line.gold)} | ${candidateSummary(line.candidate)} | ${(line.candidate?.snippet ?? "").replace(/\|/g, "\\|").slice(0, 200)} |`,
      );
    }
  }
  lines.push("");

  const wrongUnitLines: { event: string; rep: RepKey; line: LineDetail }[] = [];
  for (const ev of scoredEvents) {
    for (const key of REP_KEYS) {
      const rep = ev.representations[key];
      if (!rep) continue;
      for (const line of rep.lines) {
        if (line.class === "wrong_unit") wrongUnitLines.push({ event: ev.name, rep: key, line });
      }
    }
  }
  lines.push("### wrong_unit (scale/percent slip) — full list");
  lines.push("");
  if (wrongUnitLines.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| event | rep | metric | gold | candidate | snippet |");
    lines.push("|---|---|---|---|---|---|");
    for (const { event, rep, line } of wrongUnitLines) {
      lines.push(
        `| ${event} | ${rep} | ${line.metric_id} | ${goldSummary(line.gold)} | ${candidateSummary(line.candidate)} | ${(line.candidate?.snippet ?? "").replace(/\|/g, "\\|").slice(0, 200)} |`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Real-mode driver
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { events: string[] | null; selftest: boolean } {
  let events: string[] | null = null;
  let selftest = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--events") {
      events = (argv[++i] ?? "").split(",").filter(Boolean).map((s) => s.toUpperCase());
    } else if (argv[i] === "--selftest") {
      selftest = true;
    }
  }
  return { events, selftest };
}

function printSummaryTable(summary: ReturnType<typeof summarize>): void {
  console.log("\n=== Per representation ===");
  for (const key of REP_KEYS) {
    const s = summary.perRep[key];
    if (!s) continue;
    console.log(
      `  ${key} (${s.representationLabel}, ${s.modelId}): n=${s.n} correct=${s.correctPct.toFixed(1)}% ` +
        ALL_CLASSES.filter((c) => c !== "correct")
          .map((c) => `${c}=${s.classCounts[c]}`)
          .join(" "),
    );
  }
  console.log("\n=== Per pair ===");
  for (const key of PAIR_KEYS) {
    const s = summary.perPair[key];
    if (!s) continue;
    console.log(
      `  ${key}: coverage=${pct(s.coverage)} precision=${pct(s.precision)} catastrophic=${s.catastrophicCount} ` +
        `abstain=${pct(s.abstainRate)} correlatedError=${pct(s.correlatedErrorRate)} (n_wrong=${s.wrongXCount})`,
    );
  }
}

function runReal(eventFilter: string[] | null): void {
  const discovered = discoverEvents(OUT_ROOT).filter((e) => matchesFilter(e.name, eventFilter));
  if (discovered.length === 0) {
    console.error(`No event directories found under ${OUT_ROOT}` + (eventFilter ? ` matching --events ${eventFilter.join(",")}` : ""));
    process.exit(1);
  }

  const results = discovered.map(scoreEventFromDisk);
  const summary = summarize(results);

  const scoresOutput = {
    generatedAt: new Date().toISOString(),
    toleranceRelative: RELATIVE_TOLERANCE,
    scaleFactors: SCALE_FACTORS,
    greenCatastrophicClasses: [...GREEN_CATASTROPHIC_CLASSES],
    eventCount: results.length,
    scoredCount: results.filter((r) => !r.skipped).length,
    skippedCount: results.filter((r) => r.skipped).length,
    events: results,
    summary,
  };
  writeFileSync(SCORES_PATH, `${JSON.stringify(scoresOutput, null, 2)}\n`, "utf8");

  const report = renderReport(results, summary);
  writeFileSync(REPORT_PATH, report, "utf8");

  console.log(`Scored ${results.filter((r) => !r.skipped).length}/${results.length} event(s).`);
  const skipped = results.filter((r) => r.skipped);
  if (skipped.length > 0) {
    console.log(`Skipped (not yet gold-labeled): ${skipped.map((r) => r.name).join(", ")}`);
  }
  printSummaryTable(summary);
  console.log(`\nWrote ${SCORES_PATH}`);
  console.log(`Wrote ${REPORT_PATH}`);
}

// ---------------------------------------------------------------------------
// --selftest
// ---------------------------------------------------------------------------

interface Assertion {
  pass: boolean;
  label: string;
  detail?: string;
}

function buildSelftestFixture(): {
  contracts: Contract[];
  gold: GoldLine[];
  reps: Partial<Record<RepKey, ParseRep>>;
} {
  const kindPoint: Kind = "point";
  const kindRange: Kind = "range";

  const baseContract = (metric_id: string, kind: Kind = kindPoint): Contract => ({
    metric_id,
    label: metric_id,
    definition: `synthetic contract for ${metric_id}`,
    basis: "gaap",
    period: "Q",
    currency: "USD",
    unit: "usd",
    kind,
    segment: null,
  });

  const contracts: Contract[] = [
    baseContract("eps_gaap_q"),
    baseContract("revenue_q"),
    baseContract("gross_profit_q"),
    baseContract("guidance_note_fy"),
    baseContract("guidance_note2_fy"),
    baseContract("capex_fy"),
    baseContract("backlog_q"),
    baseContract("guidance_range_fy", kindRange),
    baseContract("correlated_wrong_fy"),
    baseContract("guidance_floor_fy", kindRange),
    baseContract("unlabeled_metric"), // no gold entry — exercises no-gold exclusion
  ];

  const g = (metric_id: string, value: number | null, value_high: number | null, not_disclosed = false): GoldLine => ({
    metric_id,
    value,
    value_high,
    raw_text: value === null ? null : String(value),
    snippet: `gold snippet for ${metric_id}`,
    source_doc: "synthetic",
    not_disclosed,
  });

  const gold: GoldLine[] = [
    g("eps_gaap_q", 1.85, null),
    g("revenue_q", 45_610_000_000, null),
    g("gross_profit_q", 15_000_000_000, null),
    g("guidance_note_fy", null, null, true),
    g("guidance_note2_fy", null, null, true),
    g("capex_fy", 500_000_000, null),
    g("backlog_q", 200_000_000, null),
    g("guidance_range_fy", 10_000_000_000, 12_000_000_000),
    g("correlated_wrong_fy", 7_000_000_000, null),
    g("guidance_floor_fy", 5_000_000_000, null),
    g("phantom_metric", 1, null), // no matching contract — exercises extra-gold warning
  ];

  const cand = (
    metric_id: string,
    value: number | null,
    value_high: number | null = null,
    not_disclosed = false,
  ): Candidate => ({
    metric_id,
    value,
    value_high,
    raw_text: value === null ? null : String(value),
    snippet: `candidate snippet for ${metric_id}`,
    location_hint: null,
    not_disclosed,
  });

  const repA: ParseRep = {
    representation: "normalized-table",
    model_id: "claude-selftest-A",
    candidates: [
      cand("eps_gaap_q", 1.85),
      cand("revenue_q", 45_610), // wrong_unit: gold / 1e6
      cand("gross_profit_q", 45_610_000_000), // cross_line: grabbed revenue_q's gold value
      cand("guidance_note_fy", null, null, true), // correct not_disclosed agreement
      cand("guidance_note2_fy", 42), // false_match
      cand("capex_fy", null, null, true), // missed
      // backlog_q: no candidate at all -> absent
      cand("guidance_range_fy", 10_000_000_000, 12_000_000_000), // correct range
      cand("correlated_wrong_fy", 6_500_000_000), // wrong_value
      cand("guidance_floor_fy", 5_000_000_000, null), // correct open-ended range
    ],
  };

  const repB: ParseRep = {
    representation: "rendered-pages",
    model_id: "claude-selftest-B",
    candidates: [
      cand("eps_gaap_q", 1.85),
      cand("revenue_q", 45_610_000_000), // correct
      cand("gross_profit_q", 45_610_000_000), // cross_line, SAME wrong value as A -> correlated
      cand("guidance_note_fy", 999), // false_match, disagrees with A (A said not_disclosed)
      cand("guidance_note2_fy", 42), // false_match, SAME value as A -> correlated
      cand("capex_fy", 500_000_000), // correct
      cand("backlog_q", 200_000_000), // correct
      cand("guidance_range_fy", 10_000_000_000, 11_000_000_000), // wrong_value (value_high off)
      cand("correlated_wrong_fy", 6_500_000_000), // wrong_value, SAME value as A -> correlated
      cand("guidance_floor_fy", 5_000_000_000, null), // correct
    ],
  };

  const repC: ParseRep = {
    representation: "second-vendor",
    model_id: "codex-selftest-C",
    candidates: [
      cand("eps_gaap_q", 1.85), // correct, agrees with A
      cand("guidance_range_fy", 10_000_000_000, 12_000_000_000), // correct, agrees with A
      cand("guidance_floor_fy", 5_000_000_000, null), // correct, agrees with A
      // everything else absent for C
    ],
  };

  return { contracts, gold, reps: { A: repA, B: repB, C: repC } };
}

function runSelftest(): void {
  const assertions: Assertion[] = [];
  const check = (pass: boolean, label: string, detail?: string) => assertions.push({ pass, label, detail });
  const eq = (actual: unknown, expected: unknown, label: string) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    check(pass, label, pass ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  const { contracts, gold, reps } = buildSelftestFixture();
  const result = scoreEventCore("SELFTEST-2026-01-01", contracts, gold, reps);

  // --- structural ---
  eq(result.skipped, false, "event is not skipped");
  eq(result.contractCount, 11, "contractCount includes the no-gold contract");
  eq(result.noGoldCount, 1, "one contract (unlabeled_metric) has no gold entry");
  eq(result.goldValuedCount, 8, "8 gold lines carry a value");
  eq(result.goldNotDisclosedCount, 2, "2 gold lines are not_disclosed");
  check(
    result.warnings.some((w) => w.includes("phantom_metric")),
    "extra-gold warning mentions phantom_metric",
    result.warnings.join(" | "),
  );
  check(
    result.warnings.some((w) => w.includes("unlabeled_metric")),
    "no-gold warning mentions unlabeled_metric",
    result.warnings.join(" | "),
  );

  // --- per-line classification, rep A ---
  const A = result.representations.A!;
  const clsA = new Map(A.lines.map((l) => [l.metric_id, l]));
  eq(clsA.get("eps_gaap_q")?.class, "correct", "A: eps_gaap_q correct");
  eq(clsA.get("revenue_q")?.class, "wrong_unit", "A: revenue_q wrong_unit (÷1e6)");
  eq(clsA.get("gross_profit_q")?.class, "cross_line", "A: gross_profit_q cross_line");
  eq(clsA.get("gross_profit_q")?.crossLineTarget, "revenue_q", "A: gross_profit_q took revenue_q's value");
  eq(clsA.get("guidance_note_fy")?.class, "correct", "A: guidance_note_fy correct not_disclosed agreement");
  eq(clsA.get("guidance_note2_fy")?.class, "false_match", "A: guidance_note2_fy false_match");
  eq(clsA.get("capex_fy")?.class, "missed", "A: capex_fy missed");
  eq(clsA.get("backlog_q")?.class, "absent", "A: backlog_q absent");
  eq(clsA.get("guidance_range_fy")?.class, "correct", "A: guidance_range_fy correct range");
  eq(clsA.get("correlated_wrong_fy")?.class, "wrong_value", "A: correlated_wrong_fy wrong_value");
  eq(clsA.get("guidance_floor_fy")?.class, "correct", "A: guidance_floor_fy correct open-ended range");
  eq(A.classCounts, { correct: 4, wrong_unit: 1, cross_line: 1, false_match: 1, missed: 1, absent: 1, wrong_value: 1 }, "A classCounts");
  eq(A.correctPct, 40, "A correctPct = 40%");

  // --- per-line classification, rep B ---
  const B = result.representations.B!;
  const clsB = new Map(B.lines.map((l) => [l.metric_id, l]));
  eq(clsB.get("revenue_q")?.class, "correct", "B: revenue_q correct");
  eq(clsB.get("gross_profit_q")?.class, "cross_line", "B: gross_profit_q cross_line (same mistake as A)");
  eq(clsB.get("guidance_note_fy")?.class, "false_match", "B: guidance_note_fy false_match");
  eq(clsB.get("guidance_note2_fy")?.class, "false_match", "B: guidance_note2_fy false_match");
  eq(clsB.get("guidance_range_fy")?.class, "wrong_value", "B: guidance_range_fy wrong_value (value_high off, no cross-line target)");
  eq(clsB.get("correlated_wrong_fy")?.class, "wrong_value", "B: correlated_wrong_fy wrong_value");
  eq(B.classCounts, { correct: 5, wrong_unit: 0, cross_line: 1, false_match: 2, missed: 0, absent: 0, wrong_value: 2 }, "B classCounts");
  eq(B.correctPct, 50, "B correctPct = 50%");

  // --- rep C (sparse) ---
  const C = result.representations.C!;
  eq(C.classCounts.correct, 3, "C: 3 correct");
  eq(C.classCounts.absent, 7, "C: 7 absent");

  // --- AB pair ---
  const AB = result.pairs.AB!;
  eq(AB.goldValuedLines, 8, "AB goldValuedLines = 8");
  eq(AB.greenedValuedLines, 4, "AB greenedValuedLines = 4 (eps, gross_profit, correlated_wrong, guidance_floor)");
  eq(AB.coverage, 0.5, "AB coverage = 4/8");
  eq(AB.greenedTotal, 5, "AB greenedTotal = 5");
  eq(AB.greenedCorrect, 2, "AB greenedCorrect = 2 (eps, guidance_floor)");
  eq(AB.precision, 0.4, "AB precision = 2/5");
  eq(AB.catastrophicCount, 2, "AB catastrophicCount = 2 (gross_profit cross_line, guidance_note2 false_match)");
  eq(
    new Set(AB.catastrophicLines.map((l) => l.metric_id)),
    new Set(["gross_profit_q", "guidance_note2_fy"]),
    "AB catastrophicLines metric_ids",
  );
  eq(AB.abstainRate, 0.5, "AB abstainRate = 1 - 5/10");
  eq(AB.wrongXCount, 5, "AB wrongXCount = 5");
  eq(AB.correlatedWrongCount, 3, "AB correlatedWrongCount = 3 (gross_profit, guidance_note2, correlated_wrong)");
  eq(AB.correlatedErrorRate, 0.6, "AB correlatedErrorRate = 3/5");

  const abLine = new Map(AB.lines.map((l) => [l.metric_id, l]));
  check(abLine.get("eps_gaap_q")!.agree === true, "AB pair-green agreement: eps_gaap_q greens");
  check(
    abLine.get("eps_gaap_q")!.greenCatastrophic === false && abLine.get("eps_gaap_q")!.correlatedWrong === false,
    "AB eps_gaap_q greened correctly, not flagged",
  );
  check(abLine.get("revenue_q")!.agree === false, "AB pair-green disagreement: revenue_q does not green (wrong_unit vs correct)");
  check(abLine.get("correlated_wrong_fy")!.agree === true, "AB correlated_wrong_fy GREENS (both parsers agree)");
  check(abLine.get("correlated_wrong_fy")!.correlatedWrong === true, "AB correlated_wrong_fy flagged as correlated error");
  check(
    abLine.get("correlated_wrong_fy")!.greenCatastrophic === false,
    "AB correlated_wrong_fy is NOT in the narrow catastrophic bucket (plain wrong_value, not unit/cross-line/false-match)",
  );
  check(abLine.get("guidance_note2_fy")!.greenCatastrophic === true, "AB guidance_note2_fy IS green-catastrophic (false_match, agreed)");

  // --- AC pair ---
  const AC = result.pairs.AC!;
  eq(AC.greenedTotal, 3, "AC greenedTotal = 3 (eps, guidance_range, guidance_floor)");
  eq(AC.greenedCorrect, 3, "AC greenedCorrect = 3 (all correct)");
  eq(AC.precision, 1, "AC precision = 1.0 (fully decorrelated pair, all greens correct)");
  eq(AC.catastrophicCount, 0, "AC catastrophicCount = 0");
  eq(AC.wrongXCount, 5, "AC wrongXCount = 5 (same A-side wrongness as AB)");
  eq(AC.correlatedWrongCount, 0, "AC correlatedWrongCount = 0 (C absent everywhere A is wrong)");
  eq(AC.correlatedErrorRate, 0, "AC correlatedErrorRate = 0 (decorrelated vs AB's 0.6)");

  // --- report renders without throwing, contains key sections ---
  const summary = summarize([result]);
  const report = renderReport([result], summary);
  check(report.includes("Worst lines"), "report includes Worst lines section");
  check(report.includes("guidance_note2_fy"), "report worst-lines mentions the greened false_match");
  check(report.includes("gross_profit_q"), "report worst-lines mentions the cross_line case");

  // --- report ---
  const passed = assertions.filter((a) => a.pass).length;
  const failed = assertions.filter((a) => !a.pass);
  console.log(`\n=== SELFTEST: ${passed}/${assertions.length} passed ===\n`);
  for (const a of assertions) {
    console.log(`  [${a.pass ? "PASS" : "FAIL"}] ${a.label}${a.detail ? ` — ${a.detail}` : ""}`);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} SELFTEST ASSERTION(S) FAILED`);
    process.exit(1);
  }
  console.log("\nAll selftest assertions passed.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const { events, selftest } = parseArgs(process.argv.slice(2));
  if (selftest) {
    runSelftest();
    return;
  }
  runReal(events);
}

main();
