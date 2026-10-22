/**
 * Arithmetic of the filing-summary checker: computed figures (R8) and
 * comparisons (R7), judged over the ROUNDING INTERVAL of every source operand
 * (fix-round ruling 4). A printed "7.25" is anything from 7.245 to 7.255, so:
 *
 * - Checked (matches) only when the relation or the stated computed value
 *   holds over the whole interval;
 * - Contradicted only when it fails over the whole interval;
 * - otherwise unconfirmed with `within_rounding`.
 *
 * Pure. Called by `evaluate.ts` with figures bound by `evaluate-figures.ts`.
 */
import { IN_LINE_BAND, checkRelation, computeOp, toUnits, type Operand, type RelationResult } from "./figures";
import { basisCompat, halfUnit, reason, statedNumber, emptyResolved, type ResolvedFigure } from "./evaluate-figures";
import { measureClasses } from "./evaluate-words";
import { isPriorPeriod, periodsMatch } from "./evaluate-periods";
import type { ComparisonCheck, ModelComparison, ModelFigure } from "./types";

/** Every combination of the low and high ends of the given intervals. */
function corners(ivs: Array<[number, number]>): number[][] {
  let out: number[][] = [[]];
  for (const [lo, hi] of ivs) {
    const next: number[][] = [];
    for (const c of out) {
      next.push([...c, lo]);
      if (hi !== lo) next.push([...c, hi]);
    }
    out = next;
  }
  return out;
}

const iv = (r: ResolvedFigure): [number, number] => [r.lo as number, r.hi as number];

// ---------------------------------------------------------------------------
// Computed figures (R8)
// ---------------------------------------------------------------------------

export function evalComputed(fig: ModelFigure, byId: Map<string, ResolvedFigure>, shownIds: Set<string>): ResolvedFigure {
  const out = emptyResolved(fig);
  out.basisConfirmed = true;
  const add = (code: string, detail: string) => out.reasons.push(reason(code, fig.id, detail));
  if (fig.inputs.length === 0) { add("no_inputs", "a computed figure with no inputs is not from the filing"); return out; }
  if (!fig.operation) { add("no_operation", "a computed figure must name its operation"); return out; }

  const inputs: ResolvedFigure[] = [];
  for (const id of fig.inputs) {
    const r = byId.get(id);
    if (!r) { add("dangling_input", `input ${id} is not a figure of this claim`); continue; }
    if (r.figure.sourceKind === "computed") { add("input_not_sourced", `input ${id} is itself computed`); continue; }
    if (!r.established) add("input_unconfirmed", `input ${id} is not established`);
    if (!shownIds.has(id)) add("inputs_not_shown", `input ${id} is not shown in the claim text`);
    inputs.push(r);
  }
  if (out.reasons.length > 0) return out;

  const op = fig.operation;
  const unit = inputs[0].unit;
  if (inputs.some((r) => r.unit !== unit)) { add("unit_mismatch", "the inputs are in different units"); return out; }
  const wantUnit = op === "growth" || op === "ratio" ? "percent" : unit;
  if (fig.unit !== wantUnit) { add("unit_mismatch", `${op} gives ${wantUnit}, the figure says ${fig.unit}`); return out; }

  if (op === "growth") {
    if (inputs.length !== 2) { add("compute_undefined", "growth takes exactly two inputs (new, old)"); return out; }
    const [nw, old] = inputs;
    // Growth of one thing: both inputs name the same measure (fix-round item 7).
    const mNew = measureClasses(nw.figure.metric);
    const mOld = measureClasses(old.figure.metric);
    if (![...mNew].some((x) => mOld.has(x))) add("metric_unconfirmed", `"${nw.figure.metric}" and "${old.figure.metric}" are not one measure`);
    const prior = nw.period && old.period ? isPriorPeriod(nw.period, old.period) : null;
    if (prior === false) add("periods_differ", "the old input does not end a year (or quarter) before the new one");
    if (prior === null) add("period_unconfirmed", "the inputs' periods cannot be placed a year apart");
  } else {
    for (const r of inputs.slice(1)) {
      const same = periodsMatch(inputs[0].period, r.period);
      if (same === false) add("periods_differ", `inputs ${inputs[0].figure.id} and ${r.figure.id} are for different periods`);
      if (same === null) add("period_unconfirmed", `inputs ${inputs[0].figure.id} and ${r.figure.id} cannot be matched by period`);
    }
  }
  const basis = basisCompat(inputs);
  if (basis === "differ") add("bases_differ", "the inputs are on different bases");
  if (basis === "unknown") add("basis_unconfirmed", "an input's basis is unknown or not shown by the source");

  // The result's period: the shared period, or the NEW input's for growth. The claim's own label must agree.
  out.period = inputs[0].period;
  out.table = inputs.find((r) => r.table)?.table ?? null;
  out.basis = inputs.find((r) => !r.basis.startsWith("guidance_"))?.basis ?? inputs[0].basis;
  const self = periodsMatch({ ...fig.period, anchor: null }, out.period);
  if (self === false) add("periods_differ", `the inputs are for another period than ${fig.period.label}`);
  if (self === null) add("period_unconfirmed", `${fig.period.label} cannot be matched to the inputs' period`);

  const point = computeOp(op, inputs.map((r) => r.units as number));
  if (point === null) { add("compute_undefined", `${op} is undefined for these inputs`); return out; }
  const stated = statedNumber(fig);
  if (!stated) { add("value_text_mismatch", `the shown text "${fig.valueText}" does not state the typed value`); return out; }

  // The result's interval from the inputs' intervals (every operation is monotone in each input where defined).
  const results = corners(inputs.map(iv)).map((c) => computeOp(op, c));
  const defined = results.every((x): x is number => x !== null);
  const rlo = defined ? Math.min(...results) : point;
  const rhi = defined ? Math.max(...results) : point;
  const sScale = op === "growth" || op === "ratio" ? "units" : stated.scale;
  const s = toUnits(stated.value, sScale);
  const h = halfUnit(stated.decimals, sScale);
  const slack = h * 1e-9 + 8 * Number.EPSILON * Math.max(Math.abs(s), Math.abs(rlo), Math.abs(rhi));
  const inside = defined && rlo >= s - h - slack && rhi <= s + h + slack;
  const disjoint = defined && (rhi < s - h - slack || rlo > s + h + slack);
  const blocking = out.reasons.length > 0;
  const shown = (x: number) => (wantUnit === "percent" ? `${x.toFixed(2)}%` : String(Math.round(x * 100) / 100));

  if (inside) {
    out.units = point;
    out.lo = rlo;
    out.hi = rhi;
    out.established = !blocking;
    if (!blocking) add("computed", `computed: ${op} of ${fig.inputs.join(", ")}`);
    return out;
  }
  if (blocking) return out;
  if (disjoint) {
    out.contradicted = true;
    add("computed_mismatch", `recomputed ${shown(point)} (${shown(rlo)} to ${shown(rhi)} allowing for the inputs' rounding); stated ${fig.valueText}`);
    return out;
  }
  add("within_rounding", `recomputed ${shown(point)}, and the inputs' rounding allows ${shown(rlo)} to ${shown(rhi)}; stated ${fig.valueText}`);
  return out;
}

// ---------------------------------------------------------------------------
// Comparisons (R7)
// ---------------------------------------------------------------------------

function operand(lo: number, hi: number | null, unit: Operand["unit"]): Operand {
  return hi === null ? { units: lo, unit } : { units: lo, unit, low: lo, high: hi };
}

/**
 * Judge the relation at the printed values, then at every corner of the
 * rounding intervals. "In line" and "unchanged" are not monotone, so a
 * failure at every corner is a contradiction only when no value inside the
 * intervals could satisfy them.
 */
function relationOverIntervals(
  relation: ModelComparison["relation"],
  L: ResolvedFigure, LH: ResolvedFigure | null, R: ResolvedFigure, RH: ResolvedFigure | null,
): RelationResult & { withinRounding: boolean } {
  const unit = L.unit;
  const point = checkRelation(relation, operand(L.units as number, LH ? (LH.units as number) : null, unit),
    operand(R.units as number, RH ? (RH.units as number) : null, unit));
  if (point.verdict === "unconfirmed") return { ...point, withinRounding: false };
  const ops = [L, LH, R, RH].filter((x): x is ResolvedFigure => x !== null);
  const verdicts = corners(ops.map(iv)).map((c) => {
    let i = 0;
    const l = c[i++];
    const lh = LH ? c[i++] : null;
    const r = c[i++];
    const rh = RH ? c[i++] : null;
    return checkRelation(relation, operand(l, lh, unit), operand(r, rh, unit)).verdict;
  });
  const overlap = (a: ResolvedFigure, b: ResolvedFigure) => (a.lo as number) <= (b.hi as number) && (b.lo as number) <= (a.hi as number);
  let canHold = false;
  if (relation === "unchanged") {
    if (point.verdict === "matches") return { ...point, withinRounding: false }; // the printed ends are equal
    canHold = overlap(L, R) && (!LH || !RH || overlap(LH, RH));
  } else if (relation === "in_line" && !RH) {
    const dmin = (L.lo as number) - (R.hi as number);
    const dmax = (L.hi as number) - (R.lo as number);
    const minAbsD = dmin <= 0 && dmax >= 0 ? 0 : Math.min(Math.abs(dmin), Math.abs(dmax));
    canHold = minAbsD <= IN_LINE_BAND * Math.max(Math.abs(R.lo as number), Math.abs(R.hi as number));
  } else if (relation === "in_line" && RH) {
    canHold = (L.hi as number) >= (R.lo as number) && (L.lo as number) <= (RH.hi as number);
  }
  const allHold = point.verdict === "matches" && verdicts.every((v) => v === "matches");
  const allFail = point.verdict === "contradicted" && verdicts.every((v) => v === "contradicted") && !canHold;
  if (allHold || allFail) return { ...point, withinRounding: false };
  return { ...point, verdict: "unconfirmed", withinRounding: true };
}

export function evalComparison(cmp: ModelComparison, byId: Map<string, ResolvedFigure>): ComparisonCheck {
  const check: ComparisonCheck = {
    relation: cmp.relation, verdict: "unconfirmed", difference: null, differencePct: null, shownText: null, reasons: [],
  };
  const add = (code: string, detail: string) => check.reasons.push(reason(code, null, detail));
  for (const id of [cmp.left, cmp.leftHigh, cmp.right, cmp.rightHigh]) {
    if (id !== null && !byId.has(id)) check.reasons.push(reason("dangling_operand", id, `comparison operand ${id} is not a figure of this claim`));
  }
  if (check.reasons.length > 0) return check;
  const get = (id: string | null) => (id === null ? null : (byId.get(id) as ResolvedFigure));
  const L = get(cmp.left) as ResolvedFigure;
  const R = get(cmp.right) as ResolvedFigure;
  const LH = get(cmp.leftHigh);
  const RH = get(cmp.rightHigh);
  const ops = [L, LH, R, RH].filter((x): x is ResolvedFigure => x !== null);
  const unsettled = ops.filter((r) => !r.established);
  if (unsettled.length > 0) {
    for (const r of unsettled) add("operand_unconfirmed", `operand ${r.figure.id} is not established`);
    return check;
  }

  let differ = false;
  let unsure = false;
  const pairs: Array<[ResolvedFigure, ResolvedFigure]> = [[L, R]];
  if (LH) pairs.push([L, LH]);
  if (RH) pairs.push([R, RH]);
  for (const [a, b] of pairs) {
    // A quarter's actual and that quarter's guidance are one period for a comparison (fix-round ruling 5).
    const same = periodsMatch(a.period, b.period, { ignoreRole: true });
    if (same === false) { differ = true; add("periods_differ", `${a.figure.id} and ${b.figure.id} are for different periods`); }
    if (same === null) { unsure = true; add("period_unconfirmed", `${a.figure.id} and ${b.figure.id} cannot be matched by period`); }
  }
  const basis = basisCompat(ops);
  if (basis === "differ") { differ = true; add("bases_differ", "the operands are on different bases"); }
  if (basis === "unknown") { unsure = true; add("basis_unconfirmed", "an operand's basis is unknown or not shown by the source"); }
  if ((LH && LH.unit !== L.unit) || (RH && RH.unit !== R.unit)) { unsure = true; add("unit_mismatch", "a range's ends are in different units"); }
  if (differ) { check.verdict = "periods_differ"; return check; }
  if (unsure) return check;

  const rel = relationOverIntervals(cmp.relation, L, LH, R, RH);
  check.verdict = rel.verdict;
  check.difference = rel.difference;
  check.differencePct = rel.differencePct;
  check.shownText = rel.shownText;
  check.reasons.push(...rel.reasons);
  if (rel.withinRounding) {
    add("within_rounding", `the printed figures' rounding leaves "${cmp.relation}" undecided${rel.shownText ? ` (${rel.shownText} at the printed values)` : ""}`);
  } else if (rel.verdict === "contradicted") {
    add("relation_contradicted", `the filing's figures do not support "${cmp.relation}"${rel.shownText ? ` (${rel.shownText})` : ""}`);
  }
  return check;
}
