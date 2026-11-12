import type Database from "better-sqlite3";

/**
 * Income semantics, as SQL fragments: the ONE copy (plan 2026-11-11,
 * Contract J and ruling P13). Read by the chat income tool
 * (`getIncomeSummaryForChat`, lib/queries/chat-tools.ts) and the dashboard
 * income reader (`getIncomeSummary`, lib/queries/income.ts).
 *
 * - Legs are read by MEANING. A DIVIDEND is a payment (positive) or a
 *   charge / reversal (negative). A REINVESTMENT is a purchase or the
 *   reversal of one, read through its importer's sign convention
 *   (`reinvestmentIsPurchase`: the direct Vanguard PDF and export parsers
 *   store a purchase negative, every other row positive).
 * - Dividend income = signed DIVIDEND amounts (a reversal nets), plus the
 *   magnitude of a REINVESTMENT only when it is an UNPAIRED purchase.
 * - A REINVESTMENT is the purchase leg of a DIVIDEND, not a second payout.
 *   It pairs one-to-one with a DIVIDEND (payment with purchase, reversal
 *   with reversal) on the same account and security, dated up to 3 calendar days either side, for
 *   the same absolute amount to the cent, or for the dividend minus ONE
 *   withholding row dated on the dividend's or the reinvestment's day.
 *   Every row is used at most once; the pairing found has the most pairs,
 *   then the smallest total day gap (see `pairIncomeLegs`). A paired
 *   REINVESTMENT adds nothing, so a pair is counted once, on the
 *   DIVIDEND's date. A charge never hides a purchase: it reduces income.
 * - An unpaired REINVESTMENT reversal is not income; it is counted
 *   (`UNPAIRED_NEGATIVE_REINVESTMENT_SQL`) so the reader can say so.
 * - Interest earned = positive INTEREST amounts; interest paid = the
 *   magnitude of negative INTEREST amounts (margin interest is a cost).
 * - Fees keep their current rule (ruling P6): ABS of FEE and COMMISSION.
 * - Net income = dividends + interest earned - interest paid - fees.
 *
 * Usage: put `incomePairingCtes(db)` inside a WITH clause, select from
 * `transactions t` with `INCOME_PAIRED_JOIN`, filter rows with
 * `INCOME_TYPES_SQL`, and sum the per-row expressions below. The pairing
 * reads every row, whatever the outer date window. A pair that straddles
 * the window edge is counted in the period holding the dividend's date: a
 * window holding only the reinvestment shows nothing for it, one holding
 * only the dividend shows it whole, so adjacent windows never lose or
 * double it.
 */

/** One DIVIDEND, REINVESTMENT or TAX_WITHHELD row, as the pairing reads it. */
export interface IncomeLeg {
  id: number;
  type: "DIVIDEND" | "REINVESTMENT" | "TAX_WITHHELD";
  account_id: number;
  security_id: number | null;
  trade_date: string;
  amount: number;
  /** The importer's key; it says which sign convention a REINVESTMENT uses. */
  source_key?: string | null;
}

/**
 * Importers whose REINVESTMENT amount is the broker's signed cash effect (a
 * purchase is NEGATIVE): the direct Vanguard PDF and Vanguard export parsers
 * store the statement's figure as printed. Every other row follows the
 * documented ledger convention (docs/reference/conventions-detail.md; the
 * canonical CSV flips the statement's sign): a purchase is POSITIVE.
 */
export const CASH_EFFECT_REINVESTMENT_SOURCE_PREFIXES = ["vanguard-pdf:", "vanguard-export:"] as const;

/**
 * Whether a REINVESTMENT row is a purchase (true) or the reversal of one
 * (false), read through its importer's sign convention. Zero is neither and
 * reads false. The SQL twin is `REINVESTMENT_IS_PURCHASE_SQL`.
 */
export function reinvestmentIsPurchase(amount: number, sourceKey: string | null | undefined): boolean {
  if (!amount) return false;
  const cashEffect = CASH_EFFECT_REINVESTMENT_SOURCE_PREFIXES.some((p) => (sourceKey ?? "").startsWith(p));
  return cashEffect ? amount < 0 : amount > 0;
}

const CASH_EFFECT_SOURCE_SQL = `(${CASH_EFFECT_REINVESTMENT_SOURCE_PREFIXES.map(
  (p) => `substr(COALESCE(t.source_key, ''), 1, ${p.length}) = '${p}'`
).join(" OR ")})`;

/** SQL twin of `reinvestmentIsPurchase` for a REINVESTMENT row `t`. */
export const REINVESTMENT_IS_PURCHASE_SQL = `(CASE WHEN ${CASH_EFFECT_SOURCE_SQL} THEN t.amount < 0 ELSE t.amount > 0 END)`;

/** SQL: a REINVESTMENT row `t` that reverses a purchase (non-zero, not a purchase). */
const REINVESTMENT_IS_REVERSAL_SQL = `(CASE WHEN ${CASH_EFFECT_SOURCE_SQL} THEN t.amount > 0 ELSE t.amount < 0 END)`;

/** One reinvestment and the dividend it is the purchase leg of. */
export interface IncomePair {
  reinvestmentId: number;
  dividendId: number;
  /** The withholding row the net match used; null for a gross match. */
  withholdingId: number | null;
}

/** Every row the pairing reads (all dates: a pair may span up to 3 days). */
export function loadIncomeLegs(db: Database.Database): IncomeLeg[] {
  return db
    .prepare(
      `SELECT id, UPPER(type) AS type, account_id, security_id, trade_date, amount, source_key
       FROM transactions
       WHERE UPPER(type) IN ('DIVIDEND', 'REINVESTMENT', 'TAX_WITHHELD') AND amount IS NOT NULL`
    )
    .all() as IncomeLeg[];
}

/**
 * How far apart, in calendar days, a reinvestment and its dividend may be
 * dated (ruling 2026-11-12: brokers date some reinvestments a day or so
 * off their dividend, e.g. across a month end).
 */
export const INCOME_PAIR_MAX_GAP_DAYS = 3;

const cents = (amount: number) => Math.round(Math.abs(amount) * 100);
/** Calendar day number of a YYYY-MM-DD date (NaN for anything else). */
const dayNumber = (date: string) => Math.floor(Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`) / 86_400_000);

/**
 * Pair reinvestments with their dividends (review RF-6; date window and
 * maximum matching rulings 2026-11-12). Within one account and security a
 * REINVESTMENT may pair with a DIVIDEND dated up to INCOME_PAIR_MAX_GAP_DAYS
 * calendar days either side, a payment with a purchase or a reversal with a
 * reversal (legs read by meaning: see `reinvestmentIsPurchase`), when:
 *  1. gross: their absolute amounts are equal to the cent; or
 *  2. net: a payment and a purchase, and ONE TAX_WITHHELD row, dated on the
 *     DIVIDEND's day or on the REINVESTMENT's day, makes dividend -
 *     |withholding| = reinvestment to the cent (dividend 100, 15 withheld,
 *     85 reinvested). The withholding is read by magnitude: the ledger
 *     stores it with either sign.
 * A negative DIVIDEND (a reversal, or a dividend charged on a short) only
 * ever pairs with a reversed REINVESTMENT, so it can never hide a
 * purchase's income: it reduces income.
 *
 * Every row is used at most once, withholding rows included. Among all such
 * one-to-one pairings the one chosen has, in order:
 *  1. the MOST pairs;
 *  2. then the smallest total day gap (so same-day and nearest win whenever
 *     they cost no pair);
 *  3. then the fewest net (withholding) pairs, so a gross match wins;
 *  4. then the fewest withholdings taken from the reinvestment's day rather
 *     than the dividend's;
 *  5. then the earliest dividends (by date, amount, row id); rows that are
 *     interchangeable (same day, amount and direction) are taken by lowest id.
 *
 * Method: interchangeable rows are collapsed into classes; each connected
 * component is solved as a min-cost maximum flow with a lexicographic cost
 * (exact for 1 to 5 when no withholding row is contested). The flow does not
 * see the limit on how many pairs one day's withholding rows of one amount
 * can serve; when a solution over-uses one, a branch-and-bound on that edge
 * restores it, so the result is the true optimum. Proved against a
 * brute-force enumeration in tests/queries/income-pairing-maximum.test.ts.
 *
 * The counted amount of a pair is the DIVIDEND row (the paired
 * reinvestment adds nothing), so the pair's income falls in the period of
 * the dividend's date wherever the reinvestment is dated.
 */
export function pairIncomeLegs(
  legs: readonly IncomeLeg[],
  /** Tests only: "tuple" skips the one-integer cost encoding. */
  options: { costMode?: "auto" | "tuple" } = {},
): IncomePair[] {
  const costMode = options.costMode ?? "auto";
  const groups = new Map<string, DatedLeg[]>();
  const days = new Map<string, number>();
  for (const leg of legs) {
    let day = days.get(leg.trade_date);
    if (day === undefined) days.set(leg.trade_date, (day = dayNumber(leg.trade_date)));
    if (!Number.isFinite(day)) continue;
    const key = `${leg.account_id}|${leg.security_id ?? "null"}`;
    const list = groups.get(key);
    // Direction by meaning: a dividend is a payment (+1) or a charge (-1);
    // a reinvestment is a purchase (+1) or a reversal (-1), through its
    // importer's convention; a withholding is read by magnitude.
    const dir: 1 | -1 =
      leg.type === "REINVESTMENT"
        ? reinvestmentIsPurchase(leg.amount, leg.source_key) ? 1 : -1
        : leg.type === "DIVIDEND" && leg.amount < 0 ? -1 : 1;
    const dated: DatedLeg = { id: leg.id, type: leg.type, amount: leg.amount, day, dir };
    if (list) list.push(dated);
    else groups.set(key, [dated]);
  }
  const pairs: IncomePair[] = [];
  for (const group of groups.values()) pairs.push(...pairGroup(group, costMode));
  return pairs.sort((a, b) => a.reinvestmentId - b.reinvestmentId);
}

// ---------------------------------------------------------------------------
// Matching engine. A Cost is [total gap, net pairs, reinvestment-day
// withholdings, dividend rank], compared lexicographically.

type Cost = [number, number, number, number];
const ZERO: Cost = [0, 0, 0, 0];
const cAdd = (a: Cost, b: Cost): Cost => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const cSub = (a: Cost, b: Cost): Cost => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
const cScale = (a: Cost, k: number): Cost => [a[0] * k, a[1] * k, a[2] * k, a[3] * k];
const cCmp = (a: Cost, b: Cost) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

/** Interchangeable rows: same day, cents and direction; ids ascending. */
interface LegClass {
  day: number;
  cents: number;
  sign: 1 | -1;
  ids: number[];
}

/** One candidate pairing between a reinvestment class and a dividend class. */
interface ClassEdge {
  r: number;
  d: number;
  /** Withholding bucket index, or -1 for a gross match. */
  b: number;
  cap: number;
  cost: Cost;
}

/** A leg reduced to what the matching reads. */
interface DatedLeg {
  id: number;
  type: IncomeLeg["type"];
  amount: number;
  day: number;
  /** +1 payment / purchase, -1 charge / reversal (see pairIncomeLegs). */
  dir: 1 | -1;
}

function classify(rows: readonly DatedLeg[], withSign: boolean): LegClass[] {
  const map = new Map<string, LegClass>();
  for (const row of rows) {
    const day = row.day;
    const c = cents(row.amount);
    if (c === 0) continue;
    const sign: 1 | -1 = withSign ? row.dir : 1;
    const key = `${day}|${c}|${sign}`;
    const cls = map.get(key);
    if (cls) cls.ids.push(row.id);
    else map.set(key, { day, cents: c, sign, ids: [row.id] });
  }
  const out = [...map.values()];
  for (const cls of out) cls.ids.sort((a, b) => a - b);
  // Dividend rank order: date, amount, positive first, lowest id.
  return out.sort((a, b) => a.day - b.day || a.cents - b.cents || b.sign - a.sign || a.ids[0] - b.ids[0]);
}

function pairGroup(group: readonly DatedLeg[], costMode: "auto" | "tuple"): IncomePair[] {
  const byType: Record<IncomeLeg["type"], DatedLeg[]> = { REINVESTMENT: [], DIVIDEND: [], TAX_WITHHELD: [] };
  for (const leg of group) byType[leg.type]?.push(leg);
  const rc = classify(byType.REINVESTMENT, true);
  const dc = classify(byType.DIVIDEND, true);
  if (rc.length === 0 || dc.length === 0) return [];
  const bc = classify(byType.TAX_WITHHELD, false);

  const dByDay = new Map<number, number[]>();
  dc.forEach((d, i) => {
    const list = dByDay.get(d.day);
    if (list) list.push(i);
    else dByDay.set(d.day, [i]);
  });
  const bByKey = new Map<string, number>();
  bc.forEach((b, i) => bByKey.set(`${b.day}|${b.cents}`, i));

  const edges: ClassEdge[] = [];
  rc.forEach((r, ri) => {
    for (let day = r.day - INCOME_PAIR_MAX_GAP_DAYS; day <= r.day + INCOME_PAIR_MAX_GAP_DAYS; day++) {
      for (const di of dByDay.get(day) ?? []) {
        const d = dc[di];
        if (d.sign !== r.sign) continue;
        const gap = Math.abs(d.day - r.day);
        const pairCap = Math.min(r.ids.length, d.ids.length);
        if (d.cents === r.cents) {
          edges.push({ r: ri, d: di, b: -1, cap: pairCap, cost: [gap, 0, 0, di] });
          continue;
        }
        if (r.sign < 0 || d.cents <= r.cents) continue;
        const need = d.cents - r.cents;
        const onDividendDay = bByKey.get(`${d.day}|${need}`);
        if (onDividendDay !== undefined) {
          edges.push({ r: ri, d: di, b: onDividendDay, cap: Math.min(pairCap, bc[onDividendDay].ids.length), cost: [gap, 1, 0, di] });
        }
        const onReinvestmentDay = r.day !== d.day ? bByKey.get(`${r.day}|${need}`) : undefined;
        if (onReinvestmentDay !== undefined) {
          edges.push({ r: ri, d: di, b: onReinvestmentDay, cap: Math.min(pairCap, bc[onReinvestmentDay].ids.length), cost: [gap, 1, 1, di] });
        }
      }
    }
  });
  if (edges.length === 0) return [];

  // Connected components over reinvestment, dividend and bucket classes.
  const parent: number[] = [];
  const node = (kind: 0 | 1 | 2, i: number) => (kind === 0 ? i : kind === 1 ? rc.length + i : rc.length + dc.length + i);
  const find = (x: number): number => {
    while (parent[x] !== undefined && parent[x] !== x) x = parent[x];
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const e of edges) {
    union(node(0, e.r), node(1, e.d));
    if (e.b >= 0) union(node(0, e.r), node(2, e.b));
  }
  const components = new Map<number, number[]>();
  edges.forEach((e, i) => {
    const root = find(node(0, e.r));
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  });

  const flows = new Array<number>(edges.length).fill(0);
  for (const edgeIds of components.values()) {
    if (uncontested(edgeIds, edges, rc, dc, bc)) {
      // No row class can be asked for more than it holds: every candidate
      // edge pairs as many rows as it allows, the only maximum there is.
      for (const i of edgeIds) flows[i] = edges[i].cap;
      continue;
    }
    const solved = solveComponent(edgeIds.map((i) => edges[i]), rc, dc, bc, costMode);
    edgeIds.forEach((i, k) => (flows[i] = solved[k]));
  }

  // Classes to rows: each edge, in order, takes the lowest unused ids.
  const nextR = new Array<number>(rc.length).fill(0);
  const nextD = new Array<number>(dc.length).fill(0);
  const nextB = new Array<number>(bc.length).fill(0);
  const pairs: IncomePair[] = [];
  edges.forEach((e, i) => {
    for (let k = 0; k < flows[i]; k++) {
      pairs.push({
        reinvestmentId: rc[e.r].ids[nextR[e.r]++],
        dividendId: dc[e.d].ids[nextD[e.d]++],
        withholdingId: e.b >= 0 ? bc[e.b].ids[nextB[e.b]++] : null,
      });
    }
  });
  return pairs;
}

/** True when saturating every edge of the component respects every class. */
function uncontested(edgeIds: number[], edges: ClassEdge[], rc: LegClass[], dc: LegClass[], bc: LegClass[]): boolean {
  if (edgeIds.length === 1) return true;
  const load = new Map<string, number>();
  const over = (key: string, add: number, limit: number) => {
    const next = (load.get(key) ?? 0) + add;
    load.set(key, next);
    return next > limit;
  };
  for (const i of edgeIds) {
    const e = edges[i];
    if (over(`r${e.r}`, e.cap, rc[e.r].ids.length)) return false;
    if (over(`d${e.d}`, e.cap, dc[e.d].ids.length)) return false;
    if (e.b >= 0 && over(`b${e.b}`, e.cap, bc[e.b].ids.length)) return false;
  }
  return true;
}

/**
 * Exact optimum for one component: flows per edge (same order as `edges`).
 * The min-cost max-flow relaxation ignores bucket capacity; a solution that
 * over-uses a bucket is split on its first over-using edge e carrying f
 * units: either e carries at least f (fix f, keep the rest of e open) or at
 * most f - 1. Each branch is pruned unless its relaxation beats the best
 * feasible solution found, so the first optimum found is kept.
 *
 * Costs run as one exact integer when the component is small enough for the
 * encoding to keep the tuple order (nearly always); otherwise as tuples.
 */
function solveComponent(
  edges: ClassEdge[],
  rc: LegClass[],
  dc: LegClass[],
  bc: LegClass[],
  costMode: "auto" | "tuple",
): number[] {
  // Dense dividend rank inside the component (same order, smaller numbers).
  const ranks = [...new Set(edges.map((e) => e.cost[3]))].sort((a, b) => a - b);
  const rankOf = new Map(ranks.map((r, i) => [r, i]));
  const tuples = edges.map((e): Cost => [e.cost[0], e.cost[1], e.cost[2], rankOf.get(e.cost[3])!]);

  const rCap = new Map<number, number>();
  const dCap = new Map<number, number>();
  const bCap = new Map<number, number>();
  for (const e of edges) {
    rCap.set(e.r, rc[e.r].ids.length);
    dCap.set(e.d, dc[e.d].ids.length);
    if (e.b >= 0) bCap.set(e.b, bc[e.b].ids.length);
  }
  const units = Math.min([...rCap.values()].reduce((s, x) => s + x, 0), [...dCap.values()].reduce((s, x) => s + x, 0));
  const ops = costMode === "auto" ? scalarOps(rCap.size + dCap.size + 2, units, ranks.length) : null;
  return ops
    ? branchAndBound(edges, tuples.map(ops.from), ops, rCap, dCap, bCap)
    : branchAndBound(edges, tuples, TUPLE_OPS, rCap, dCap, bCap);
}

/** Arithmetic over a cost type that is ordered like the tuple. */
interface CostOps<C> {
  zero: C;
  add(a: C, b: C): C;
  sub(a: C, b: C): C;
  scale(a: C, k: number): C;
  cmp(a: C, b: C): number;
}

const TUPLE_OPS: CostOps<Cost> = { zero: ZERO, add: cAdd, sub: cSub, scale: cScale, cmp: cCmp };

/**
 * Mixed-radix encoding of the tuple as one integer, or null when it might
 * not stay exact. Every value the flow and the search handle (edge costs,
 * reduced costs, distances, potentials, flow totals) has components bounded
 * in magnitude by (nodes + units) times the largest per-edge component, a
 * few times over; each digit gets 8 times that, both signs, and the whole
 * must stay under 2^52.
 */
function scalarOps(nodes: number, units: number, rankCount: number): (CostOps<number> & { from(c: Cost): number }) | null {
  const span = 8 * (nodes + units);
  const radix = [2 * span * 3 + 1, 2 * span + 1, 2 * span + 1, 2 * span * Math.max(1, rankCount) + 1];
  const w3 = 1;
  const w2 = w3 * radix[3];
  const w1 = w2 * radix[2];
  const w0 = w1 * radix[1];
  if (w0 * radix[0] >= 2 ** 52) return null;
  return {
    zero: 0,
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    scale: (a, k) => a * k,
    cmp: (a, b) => a - b,
    from: (c) => c[0] * w0 + c[1] * w1 + c[2] * w2 + c[3] * w3,
  };
}

function branchAndBound<C>(
  edges: ClassEdge[],
  costs: C[],
  ops: CostOps<C>,
  rCap: Map<number, number>,
  dCap: Map<number, number>,
  bCap: Map<number, number>,
): number[] {
  type Best = { count: number; cost: C; flows: number[] };
  let best: Best | null = null;
  const beats = (count: number, cost: C, b: Best | null) =>
    !b || count > b.count || (count === b.count && ops.cmp(cost, b.cost) < 0);

  const search = (
    caps: number[],
    rLeft: Map<number, number>,
    dLeft: Map<number, number>,
    bLeft: Map<number, number>,
    fixed: number[],
    fixedCount: number,
    fixedCost: C,
  ) => {
    const live = edges.map((e, i) => (e.b >= 0 ? Math.min(caps[i], bLeft.get(e.b) ?? 0) : caps[i]));
    const relaxed = minCostMaxFlow(edges, costs, ops, live, rLeft, dLeft);
    const count = fixedCount + relaxed.count;
    const cost = ops.add(fixedCost, relaxed.cost);
    if (!beats(count, cost, best)) return;
    const used = new Map<number, number>();
    edges.forEach((e, i) => {
      if (e.b >= 0 && relaxed.flows[i] > 0) used.set(e.b, (used.get(e.b) ?? 0) + relaxed.flows[i]);
    });
    const over = [...used].find(([b, u]) => u > (bLeft.get(b) ?? 0));
    if (!over) {
      best = { count, cost, flows: fixed.map((f, i) => f + relaxed.flows[i]) };
      return;
    }
    const ei = edges.findIndex((e, i) => e.b === over[0] && relaxed.flows[i] > 0);
    const e = edges[ei];
    const f = relaxed.flows[ei];
    // Branch 1: e carries at least f units (f fits: live caps it by bucket).
    const caps1 = [...caps];
    caps1[ei] -= f;
    const fixed1 = [...fixed];
    fixed1[ei] += f;
    search(
      caps1,
      new Map(rLeft).set(e.r, (rLeft.get(e.r) ?? 0) - f),
      new Map(dLeft).set(e.d, (dLeft.get(e.d) ?? 0) - f),
      new Map(bLeft).set(e.b, (bLeft.get(e.b) ?? 0) - f),
      fixed1,
      fixedCount + f,
      ops.add(fixedCost, ops.scale(costs[ei], f)),
    );
    // Branch 2: e carries at most f - 1 units.
    const caps2 = [...caps];
    caps2[ei] = f - 1;
    search(caps2, rLeft, dLeft, bLeft, fixed, fixedCount, fixedCost);
  };

  search(
    edges.map((e) => e.cap),
    rCap,
    dCap,
    bCap,
    new Array<number>(edges.length).fill(0),
    0,
    ops.zero,
  );
  return (best as Best | null)?.flows ?? new Array<number>(edges.length).fill(0);
}

/**
 * Min-cost maximum flow on source -> reinvestment classes -> dividend
 * classes -> sink, by successive shortest paths (Dijkstra on reduced costs,
 * stopping at the sink). Costs form an ordered group, so the usual proof
 * holds: each augmentation pushes the bottleneck along a cheapest path, the
 * flow is cheapest for each value reached, and it stops only when no
 * augmenting path is left (maximum flow).
 */
function minCostMaxFlow<C>(
  edges: ClassEdge[],
  costs: C[],
  ops: CostOps<C>,
  caps: number[],
  rLeft: Map<number, number>,
  dLeft: Map<number, number>,
): { count: number; cost: C; flows: number[] } {
  const rNode = new Map<number, number>();
  const dNode = new Map<number, number>();
  let n = 2; // 0 source, 1 sink
  for (const e of edges) {
    if (!rNode.has(e.r)) rNode.set(e.r, n++);
    if (!dNode.has(e.d)) dNode.set(e.d, n++);
  }
  const to: number[] = [];
  const cap: number[] = [];
  const cost: C[] = [];
  const adj: number[][] = Array.from({ length: n }, () => []);
  const addArc = (u: number, v: number, c: number, w: C): number => {
    const id = to.length;
    to.push(v, u);
    cap.push(c, 0);
    cost.push(w, ops.sub(ops.zero, w));
    adj[u].push(id);
    adj[v].push(id + 1);
    return id;
  };
  for (const [r, v] of rNode) addArc(0, v, Math.max(0, rLeft.get(r) ?? 0), ops.zero);
  for (const [d, v] of dNode) addArc(v, 1, Math.max(0, dLeft.get(d) ?? 0), ops.zero);
  const arcOf = edges.map((e, i) => addArc(rNode.get(e.r)!, dNode.get(e.d)!, Math.max(0, caps[i]), costs[i]));

  const pot: C[] = new Array<C>(n).fill(ops.zero);
  let count = 0;
  let total = ops.zero;
  for (;;) {
    const dist: (C | null)[] = new Array<C | null>(n).fill(null);
    const via = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[0] = ops.zero;
    const heap = new CostHeap<C>(ops.cmp);
    heap.push(ops.zero, 0);
    while (heap.size > 0) {
      const [du, u] = heap.pop();
      if (done[u] || ops.cmp(du, dist[u]!) !== 0) continue;
      done[u] = true;
      if (u === 1) break;
      for (const a of adj[u]) {
        if (cap[a] <= 0) continue;
        const v = to[a];
        if (done[v]) continue;
        const nd = ops.add(du, ops.sub(ops.add(cost[a], pot[u]), pot[v]));
        if (dist[v] === null || ops.cmp(nd, dist[v]!) < 0) {
          dist[v] = nd;
          via[v] = a;
          heap.push(nd, v);
        }
      }
    }
    if (!done[1]) break;
    const dt = dist[1]!;
    for (let v = 0; v < n; v++) {
      const dv = dist[v];
      pot[v] = ops.add(pot[v], done[v] && dv !== null && ops.cmp(dv, dt) < 0 ? dv : dt);
    }
    let push = Infinity;
    for (let v = 1; v !== 0; v = to[via[v] ^ 1]) push = Math.min(push, cap[via[v]]);
    let pathCost = ops.zero;
    for (let v = 1; v !== 0; v = to[via[v] ^ 1]) {
      cap[via[v]] -= push;
      cap[via[v] ^ 1] += push;
      pathCost = ops.add(pathCost, cost[via[v]]);
    }
    count += push;
    total = ops.add(total, ops.scale(pathCost, push));
  }
  return { count, cost: total, flows: arcOf.map((a) => cap[a ^ 1]) };
}

/** Binary min-heap of (cost, node), ties by node for determinism. */
class CostHeap<C> {
  private items: [C, number][] = [];
  constructor(private readonly cmp: (a: C, b: C) => number) {}
  get size() {
    return this.items.length;
  }
  private less(i: number, j: number) {
    const a = this.items[i];
    const b = this.items[j];
    const c = this.cmp(a[0], b[0]);
    return c < 0 || (c === 0 && a[1] < b[1]);
  }
  push(c: C, v: number) {
    const items = this.items;
    items.push([c, v]);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }
  pop(): [C, number] {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(l, m)) m = l;
        if (r < items.length && this.less(r, m)) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The CTE that defines `paired_reinvestments(id)`, no leading WITH. The
 * pairing runs in `pairIncomeLegs` (one-to-one matching is not a SQL
 * join); the ids are integers read from this database, spliced as a JSON
 * array.
 */
export function incomePairingCtes(db: Database.Database): string {
  const ids = pairIncomeLegs(loadIncomeLegs(db)).map((p) => Math.trunc(p.reinvestmentId));
  return `paired_reinvestments AS MATERIALIZED (
    SELECT CAST(value AS INTEGER) AS id FROM json_each('${JSON.stringify(ids)}')
  )`;
}

/** Joins the pairing result onto `transactions t` as `pr`. */
export const INCOME_PAIRED_JOIN = "LEFT JOIN paired_reinvestments pr ON pr.id = t.id";

/** The rows any income figure reads. */
export const INCOME_TYPES_SQL =
  "UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST', 'FEE', 'COMMISSION')";

/** Per-row dividend income (sum it). Needs `t` and `pr`. */
export const DIVIDEND_INCOME_SQL = `(CASE
  WHEN UPPER(t.type) = 'DIVIDEND' THEN COALESCE(t.amount, 0)
  WHEN UPPER(t.type) = 'REINVESTMENT' AND pr.id IS NULL AND ${REINVESTMENT_IS_PURCHASE_SQL} THEN ABS(t.amount)
  ELSE 0 END)`;

/** Per-row interest earned (sum it). */
export const INTEREST_EARNED_SQL = `(CASE WHEN UPPER(t.type) = 'INTEREST' AND t.amount > 0 THEN t.amount ELSE 0 END)`;

/** Per-row interest paid, as a positive magnitude (sum it). */
export const INTEREST_PAID_SQL = `(CASE WHEN UPPER(t.type) = 'INTEREST' AND t.amount < 0 THEN -t.amount ELSE 0 END)`;

/** Per-row fees, as a positive magnitude (sum it). Unchanged rule (P6). */
export const FEES_SQL = `(CASE WHEN UPPER(t.type) IN ('FEE', 'COMMISSION') THEN ABS(COALESCE(t.amount, 0)) ELSE 0 END)`;

/** Per-row net income contribution (sum it). */
export const NET_INCOME_SQL = `(${DIVIDEND_INCOME_SQL} + ${INTEREST_EARNED_SQL} - ${INTEREST_PAID_SQL} - ${FEES_SQL})`;

/**
 * Per-row 1 for an unpaired REINVESTMENT that reverses a purchase, left out
 * of income (sum it). The name is historical: under the documented
 * convention a reversal is the negative row; a cash-effect importer's
 * reversal is positive.
 */
export const UNPAIRED_NEGATIVE_REINVESTMENT_SQL = `(CASE WHEN UPPER(t.type) = 'REINVESTMENT' AND pr.id IS NULL AND ${REINVESTMENT_IS_REVERSAL_SQL} THEN 1 ELSE 0 END)`;
