/**
 * The 18 golden questions (plan 2026-11-11, Task 9 table), as data.
 *
 * Each question is a function of the expected context (expected.ts), so
 * figures and symbols come from the eval database at run time, never from a
 * constant here. A check whose figure could not be derived is left out and
 * the question records why in `notes` (it is reported, not silently passed).
 *
 * Every figure check is bound to its context (a unit right after it, or a
 * label on the same line) and, where the question exists to catch one, the
 * plausible WRONG figure is a `notNumber` check (the double-counted income,
 * the whole-book weight, the lifetime gain). Gains, losses and day effects
 * are `signed`. tests/scripts/chat-eval-scorer.test.ts pins one plausible
 * wrong answer per question (it must fail) and one right answer (it must
 * pass).
 *
 * Tool names that are not registered (yet) still appear in checks: the
 * runner lists them as "not registered" up front, and such a check fails.
 */

import type { ChatScope } from "../../lib/types";
import type { Check } from "./scorer";
import type { ExpectedContext } from "./expected";

export interface GoldenQuestion {
  id: string;
  scope: ChatScope;
  question: string;
  checks: Check[];
  /** Why a planned check is missing, or other caveats for the reader. */
  notes: string[];
}

type Builder = (x: ExpectedContext) => GoldenQuestion;

const ADVICE_DEFLECTION = /consult (a|your) (tax|financial) (professional|advis[eo]r)|speak (to|with) (a|your) (tax|financial)/;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pct = (n: number) => Math.round(n * 100) / 100;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A date written as ISO, "Mar 27", "March 27" or "27 March". */
export function datePattern(iso: string): string {
  const m = Number(iso.slice(5, 7)) - 1;
  const d = Number(iso.slice(8, 10));
  const names = `(?:${MONTH_FULL[m]}|${MONTH_ABBR[m]}\\.?)`;
  return `${iso}|\\b${names}\\s+${d}(?:st|nd|rd|th)?\\b|\\b${d}(?:st|nd|rd|th)?\\s+${names}\\b|\\b${m + 1}/${d}\\b`;
}

/** Tighten the not-for-filing caveat (the bare word "estimate" does not count). */
export const NOT_FOR_FILING = /not (for|to be used for|suitable for|meant for) (tax )?filing|not filing[- ]ready|before (you )?fil(e|ing)|check (it )?against (your|the) 1099|not tax advice/;

/** Staleness named in words (a date alone is not enough). */
export const STALE_WORDS = /\bstale\b|out of date|outdated|not (been )?(updated|refreshed)|older than|\blag(s|ging)?\b|behind\b|last (updated|priced|refreshed)/;

/** A weight stated as a share of long market value (or invested positions). */
export const LONG_MV_BASE =
  /long (market )?value|long MV|long book|invested (positions|book|capital)|of (the )?(positions|holdings|invested)|holdings value|market value of (the )?(positions|holdings)|deployed|gross long/;

/** A weight stated as a share of account value including cash. */
export const ACCOUNT_VALUE_BASE = /account (value|total)|total (account )?value|including cash|incl\.? cash|net liquidation|of (the )?account\b(?! long)/;

/** Rates labelled as assumed, illustrative or bracket-dependent. */
export const ASSUMED_RATES =
  /assum(e|ed|es|ing|ption)|illustrat|hypothetical|for example|e\.g\.|depends on (your|the) (rate|bracket|marginal|tax)|if (your|you are in|you're in) (the )?\d+%|at (a|your) \d+% (rate|bracket)|bracket[^.\n]{0,30}(table|scenario)/;

/** Eastern times, or an explicit empty calendar in any wording. */
export const EMPTY_OR_EASTERN =
  /\bET\b|Eastern|\bEST\b|\bEDT\b|nothing (on|scheduled|loaded|on file|returned|coming)|returned nothing|\bzero (events|results|items)\b|no (events|earnings|releases|scheduled)|calendar is empty|(is|was) empty/;

/** The harvest figure bound to the engine, and the plausible wrong hand sums. */
function harvestFigureChecks(x: ExpectedContext): Check[] {
  const out: Check[] = [];
  if (x.harvestLoss === null) return out;
  out.push({
    kind: "number",
    label: "the candidate's loss, as the engine states it",
    value: x.harvestLoss,
    absTol: 1,
    signed: true,
    near: new RegExp(`\\b${escapeRegExp(x.manifest.harvestCandidate)}\\b`),
    window: 120,
  });
  if (x.excludedLosses.roth !== null) {
    out.push({ kind: "notNumber", label: "not summed with the Roth loss", value: Math.abs(x.harvestLoss) + Math.abs(x.excludedLosses.roth), absTol: 1 });
  }
  if (x.excludedLosses.pending !== null) {
    out.push({ kind: "notNumber", label: "not summed with the pending loss", value: Math.abs(x.harvestLoss) + Math.abs(x.excludedLosses.pending), absTol: 1 });
  }
  return out;
}

/** The instruments that really closed this year must be named; one sold only in another year must not. */
function closedSourceChecks(x: ExpectedContext, mode: "all" | "any"): Check[] {
  const r = x.realized;
  if (!r || r.closedThisYear.length === 0) return [];
  const word = (s: string) => new RegExp(`\\b${escapeRegExp(s)}\\b`);
  const out: Check[] =
    mode === "all"
      ? r.closedThisYear.map((s) => ({ kind: "contains" as const, label: `names ${s}, which closed this year`, pattern: word(s) }))
      : [{ kind: "contains", label: "names an instrument that closed this year", pattern: new RegExp(r.closedThisYear.map((s) => `\\b${escapeRegExp(s)}\\b`).join("|")) }];
  for (const s of r.closedOtherYearsOnly) {
    out.push({
      kind: "notContains",
      label: `does not credit ${s}, sold only in another year`,
      pattern: new RegExp(`\\b${escapeRegExp(s)}\\b[^.\\n]{0,60}(sale|sold|closed|realiz|gain|loss)|(sale|sold|closed)[^.\\n]{0,30}\\b${escapeRegExp(s)}\\b`),
    });
  }
  return out;
}

export const GOLDEN: readonly Builder[] = [
  () => ({
    id: "Q1",
    scope: "all",
    question: "How's my portfolio doing this year?",
    checks: [
      { kind: "calledTool", label: "uses the TWR tool", tool: "query_twr" },
      { kind: "contains", label: "time-weighted return named", pattern: /time[- ]weighted|\bTWR\b/ },
      { kind: "contains", label: "money-weighted (XIRR) labelled", pattern: /money[- ]weighted|\bXIRR\b/ },
      { kind: "contains", label: "window dates given", pattern: /\b(19|20)\d{2}-\d{2}-\d{2}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b/ },
      { kind: "notContains", label: "no sum of monthly changes", pattern: /sum(ming)? (of )?(the )?monthly|added up (the )?month/ },
    ],
    notes: [],
  }),
  (x) => {
    const checks: Check[] = [
      { kind: "calledTool", label: "uses the market snapshot", tool: "query_market_snapshot" },
      {
        kind: "contains",
        label: "the short that rose is shown as a loss",
        pattern: new RegExp(`\\b${escapeRegExp(x.manifest.short)}\\b[^\\n]{0,100}(loss|lost|cost you|hurt|against you|-\\$|−\\$|\\(\\$)`),
      },
      { kind: "notContains", label: "no percent x value arithmetic", pattern: /%\s*[x×*]\s*(the\s*)?(market\s*)?value|percent times/ },
    ];
    const notes: string[] = [];
    if (x.shortDayEffect !== null && x.shortDayEffect !== 0) {
      checks.push({
        kind: "number",
        label: "the short's dollar day effect, signed",
        value: x.shortDayEffect,
        absTol: 0.5,
        signed: true,
        near: new RegExp(`\\b${escapeRegExp(x.manifest.short)}\\b`),
        window: 120,
      });
    } else notes.push("the short's day effect could not be derived");
    return { id: "Q2", scope: "all", question: "What moved today, in dollars?", checks, notes };
  },
  () => ({
    id: "Q3",
    scope: "all",
    question: "Am I beating the S&P this year?",
    checks: [
      { kind: "calledTool", label: "uses the benchmark tool", tool: "query_performance_vs_benchmark" },
      { kind: "contains", label: "SPY or the S&P named", pattern: /\bSPY\b|S&P/ },
      { kind: "notContains", label: "no benchmark figure from memory", pattern: /\b(roughly|about|around) \d+(\.\d+)?% (for|on) (the )?(S&P|SPY)|as far as I know|from memory/ },
    ],
    notes: [],
  }),
  (x) => ({
    id: "Q4",
    scope: "ibkr",
    question: "What drove last month?",
    checks: [
      { kind: "calledTool", label: "uses the attribution tool", tool: "query_performance_vs_benchmark" },
      { kind: "contains", label: "the month is named", pattern: new RegExp(`\\b${x.previousMonthName}\\b`) },
      {
        kind: "contains",
        label: "contributors named, or an explicit no-data answer for that month",
        pattern: new RegExp(
          `contribut|drove|driver|detract|\\bno ${x.previousMonthName}\\b[^.\\n]{0,40}(statement|data)|\\b${x.previousMonthName}\\b[^.\\n]{0,60}(not|n't) (been )?(imported|available|on file)|no data for ${x.previousMonthName}`,
        ),
      },
    ],
    notes: [],
  }),
  (x) => ({
    id: "Q5",
    scope: "all",
    question: "Tax-loss harvesting candidates?",
    checks: [
      { kind: "calledTool", label: "reads tax lots", tool: "query_tax_lots" },
      { kind: "contains", label: "the taxable loser is listed", pattern: new RegExp(`\\b${escapeRegExp(x.manifest.harvestCandidate)}\\b`) },
      { kind: "contains", label: "wash-sale caveat (any wording)", pattern: /\bwash/ },
      { kind: "notContains", label: "the Roth lot is not offered", pattern: new RegExp(`\\b${escapeRegExp(x.manifest.rothLoser)}\\b(?![^\\n.]{0,60}(not eligible|tax-advantaged|Roth|excluded|not a candidate))`) },
      { kind: "notContains", label: "the pending lot is not offered", pattern: new RegExp(`\\b${escapeRegExp(x.manifest.pendingLot)}\\b(?![^\\n.]{0,60}(pending|awaiting|excluded|not a candidate))`) },
      ...harvestFigureChecks(x),
    ],
    notes: [],
  }),
  (x) => {
    const checks: Check[] = [
      { kind: "calledTool", label: "uses the realized-gains tool", tool: "query_realized_gains" },
      { kind: "contains", label: "not-for-filing caveat", pattern: NOT_FOR_FILING },
      ...closedSourceChecks(x, "all"),
    ];
    const notes: string[] = [];
    if (x.realized) {
      checks.push({
        kind: "number",
        label: `short-term total for ${x.realized.year}, signed`,
        value: x.realized.shortTerm,
        absTol: 1,
        signed: true,
        near: /short[- ]term|\bST\b/,
      });
      if (Math.abs(x.realized.longTerm) >= 1) {
        checks.push({
          kind: "number",
          label: `long-term total for ${x.realized.year}, signed`,
          value: x.realized.longTerm,
          absTol: 1,
          signed: true,
          near: /long[- ]term|\bLT\b/,
        });
      } else {
        checks.push({
          kind: "contains",
          label: "no long-term gains said as such",
          pattern: /long[- ]term[^.\n]{0,40}(\$\s?0(\.00)?\b|\bnone\b|\bnil\b|\bzero\b|\bno\b)|\bno long[- ]term\b/,
        });
      }
      const yearTotal = x.realized.shortTerm + x.realized.longTerm;
      if (Math.abs(x.realized.lifetimeAllAccounts - yearTotal) > 5) {
        checks.push({ kind: "notNumber", label: "not the lifetime total", value: x.realized.lifetimeAllAccounts, absTol: 1 });
      } else notes.push("lifetime total equals this year's in the fixture; no lifetime trap");
    } else notes.push("realized figures could not be derived");
    return { id: "Q6", scope: "all", question: "Realized gains this year, short vs long?", checks, notes };
  },
  (x) => ({
    id: "Q7",
    scope: "all",
    question: "What options expire in the next 30 days?",
    checks: [
      { kind: "calledTool", label: "uses the options book", tool: "query_options_book" },
      { kind: "contains", label: "the live contract's expiry", pattern: new RegExp(datePattern(x.manifest.liveOption.expiry)) },
      { kind: "contains", label: "the live contract's underlying", pattern: new RegExp(`\\b${x.manifest.liveOption.underlying}\\b`) },
      { kind: "notContains", label: "not the expired contract's expiry", pattern: new RegExp(datePattern(x.manifest.expiredOption.expiry)) },
    ],
    notes: [],
  }),
  () => ({
    id: "Q8",
    scope: "all",
    question: "How exposed am I to a 20% market drop?",
    checks: [
      { kind: "calledTool", label: "uses the scenario tool", tool: "query_scenarios" },
      { kind: "contains", label: "unmodelled positions mentioned", pattern: /not modell?ed|unmodell?ed|could not be modell?ed|left out of the (scenario|model)|excluded from the (scenario|model)/ },
      { kind: "notContains", label: "no hand-made beta x value", pattern: /beta\s*(of\s*[\d.]+\s*)?[x×*]\s*(the\s*|your\s*)?(market\s*|portfolio\s*)?value|multiply(ing)? (the |your )?(value|portfolio) by (the |its )?beta/ },
    ],
    notes: [],
  }),
  (x) => {
    // No tool requirement: the IBKR dashboard in the system prompt labels the
    // account weights, and a figure correctly taken from it is a right answer.
    const checks: Check[] = [];
    const notes: string[] = [];
    const w = x.ibkrTopWeight;
    if (w) {
      // The symbol, or the name's leading words before any figure (a model
      // writes "US Treasury Note", not "US Treasury Note 2.875% 2032").
      const shortName = w.name ? w.name.split(/\s+/).filter((_, i, ws) => !ws.slice(0, i + 1).some((t) => /\d/.test(t))).join(" ") : "";
      const names = new RegExp([w.symbol.trim(), ...(shortName ? [shortName] : [])].map(escapeRegExp).join("|"));
      checks.push({ kind: "contains", label: "the largest position named", pattern: names });
      // Orchestrator ruling: "share of the account" is ambiguous, so either
      // base is right PROVIDED the answer states it in words; a bare
      // percentage with no base fails.
      const either: Check[] = [
        { kind: "number", label: "share of long market value, base stated", value: pct(w.accountWeightPct), absTol: 0.6, percentOnly: true, near: LONG_MV_BASE, window: 80 },
      ];
      if (w.accountValueWeightPct !== null) {
        either.push({ kind: "number", label: "share of account value, base stated", value: pct(w.accountValueWeightPct), absTol: 0.6, percentOnly: true, near: ACCOUNT_VALUE_BASE, window: 80 });
      }
      checks.push({ kind: "anyOf", label: "the weight with its base stated (long market value or account value)", checks: either });
      if (w.wholeBookWeightPct !== null && Math.abs(w.wholeBookWeightPct - w.accountWeightPct) > 1.5) {
        checks.push({ kind: "notNumber", label: "not the whole-book weight", value: pct(w.wholeBookWeightPct), absTol: 0.3, percentOnly: true });
      }
    } else notes.push("no IBKR holdings to derive a weight from");
    return { id: "Q9", scope: "ibkr", question: "Biggest position as a share of the account?", checks, notes };
  },
  (x) => ({
    id: "Q10",
    scope: "all",
    question: "What matures soon in my bond book?",
    checks: [
      { kind: "contains", label: "the bill and its maturity date", pattern: new RegExp(datePattern(x.manifest.bill.maturity)) },
      { kind: "notContains", label: "no invented duration", pattern: /duration (of|is|around|about) (about |roughly |approximately |around )?\d/ },
    ],
    notes: [],
  }),
  (x) => {
    const checks: Check[] = [{ kind: "calledTool", label: "uses the income tool", tool: "query_income_summary" }];
    const notes: string[] = [];
    const d = x.dividends12m;
    if (d) {
      checks.push({ kind: "number", label: "the single-count dividend figure", value: d.single, absTol: 1, near: /dividend/, window: 80 });
      if (Math.abs(d.naiveDoubleCount - d.single) > 1) {
        checks.push({ kind: "notNumber", label: "not the naive double count", value: d.naiveDoubleCount, absTol: 0.5 });
      } else notes.push("the fixture's naive sum equals the single count; no double-count trap");
      if (d.marginInterestPaid > 0) {
        checks.push({ kind: "notNumber", label: "margin interest not added as income", value: d.single + d.marginInterestPaid, absTol: 0.5 });
        checks.push({ kind: "notContains", label: "margin interest not called income", pattern: /margin interest (as|is|counted as) (income|earned)|interest (income|earned)[^.\n]{0,40}margin/ });
      }
    } else notes.push("dividend figures could not be derived");
    return { id: "Q11", scope: "all", question: "Dividend income last 12 months?", checks, notes };
  },
  (x) => {
    const checks: Check[] = [
      { kind: "calledTool", label: "uses the data-confidence tool", tool: "query_data_confidence" },
      { kind: "contains", label: "staleness named in words", pattern: STALE_WORDS },
      { kind: "notContains", label: "not 'everything is fresh'", pattern: /everything (is|looks|checks out)|all (data|figures|numbers|prices) (are|is|look) (fresh|current|up to date|good)|nothing (is )?stale/ },
    ];
    const notes: string[] = [];
    if (x.stalePriceDate) {
      checks.push({
        kind: "contains",
        label: `the stale name or its price date (${x.manifest.staleName}, ${x.stalePriceDate})`,
        pattern: new RegExp(`${datePattern(x.stalePriceDate)}|\\b${escapeRegExp(x.manifest.staleName)}\\b`),
      });
    }
    else notes.push("no stale price date in the fixture");
    return { id: "Q12", scope: "all", question: "Can I trust today's numbers?", checks, notes };
  },
  (x) => {
    const w = x.longTermWait;
    const checks: Check[] = [
      { kind: "contains", label: "a view labelled as a view", pattern: /\bmy (read|view|take)\b|\bin my view\b|\bI('d| would) (wait|sell|hold)\b/ },
      { kind: "contains", label: "rates labelled as assumed or illustrative", pattern: ASSUMED_RATES },
      { kind: "notContains", label: "no advice deflection", pattern: ADVICE_DEFLECTION },
    ];
    const notes: string[] = [];
    if (w) {
      checks.push({ kind: "number", label: "days remaining to long-term", value: w.daysToLongTerm, absTol: 1, unitAfter: /(more |calendar )?days?\b/ });
      if (w.unrealizedGain !== null) {
        checks.push({ kind: "number", label: "the lot's gain, signed", value: w.unrealizedGain, absTol: 1, signed: true, near: /gain|loss|up|down/ });
      }
    }
    return {
      id: "Q13",
      scope: "vanguard-taxable",
      question: `Should I wait for long-term on my ${x.manifest.longTermWait.symbol} lot?`,
      checks,
      notes,
    };
  },
  () => ({
    id: "Q14",
    scope: "all",
    question: "What's on deck this week for names I hold?",
    checks: [
      { kind: "calledTool", label: "reads the calendar", tool: "query_calendar_events" },
      { kind: "contains", label: "times in Eastern, or an explicit empty answer", pattern: EMPTY_OR_EASTERN },
      { kind: "notContains", label: "no 'already reported' for a print still ahead", pattern: /already reported[^.\n]{0,40}(tomorrow|later this week|before the open)/ },
    ],
    notes: ["report_state is otherwise checked by review of the answer"],
  }),
  (x) => {
    const checks: Check[] = [];
    const notes: string[] = [];
    const f = x.foreign;
    if (f) {
      const cur = new RegExp(`\\b${escapeRegExp(f.currency)}\\b|¥`);
      checks.push({ kind: "contains", label: "the currency code", pattern: cur });
      // Decision (2026-11-11, run 2): the question asks how much is OWNED, so
      // the native price is not required; the quantity and the USD value are.
      // If a native price is quoted, it must not carry a dollar sign (below).
      checks.push({ kind: "number", label: "the quantity held", value: f.quantity, absTol: 0.001, near: /shares?|units?/, window: 20 });
      checks.push({ kind: "number", label: "the USD value", value: f.usdValue, absTol: 1, relTol: 0.01, near: /\$|USD|dollars/, window: 12 });
      checks.push({
        kind: "notContains",
        label: "no dollar sign on the native price",
        pattern: new RegExp(`\\$\\s?${f.nativePrice.toLocaleString("en-US").replace(/,/g, ",?").replace(/\./g, "\\.")}(?![\\d,])`),
      });
    } else notes.push("the foreign holding could not be read");
    return { id: "Q15", scope: "all", question: "How much of the foreign stock do I own?", checks, notes };
  },
  (x) => ({
    id: "Q16",
    scope: "all",
    question: `Total exposure to ${x.manifest.multiAccountName} across accounts, including options?`,
    checks: [
      { kind: "calledTool", label: "reads holdings or Greeks", tool: ["query_holdings", "query_options_greeks", "query_options_book"] },
      { kind: "contains", label: "delta-adjusted", pattern: /delta[- ]adjusted|\bdelta\b/ },
      { kind: "contains", label: "broken out by account", pattern: /IBKR[^\n]{0,200}(Taxable|Vanguard)|(Taxable|Vanguard)[^\n]{0,200}IBKR|\n[^\n]*IBKR[\s\S]*\n[^\n]*(Taxable|Vanguard)|\n[^\n]*(Taxable|Vanguard)[\s\S]*\n[^\n]*IBKR/ },
      { kind: "notContains", label: "no premium sum as exposure", pattern: /premium[^.\n]{0,40}(exposure|total)|(exposure|total)[^.\n]{0,40}premium/ },
    ],
    notes: [],
  }),
  (x) => {
    const t = escapeRegExp(x.manifest.unknownTicker);
    return {
      id: "Q17",
      scope: "all",
      question: `What do my notes say about ${x.manifest.unknownTicker}?`,
      checks: [
        {
          kind: "contains",
          label: "says the ticker is not on file",
          pattern: new RegExp(
            `(\\b(no|not|nothing|none|cannot|can't|couldn't|don't|doesn't)\\b)[^.\\n]{0,80}\\b${t}\\b|\\b${t}\\b[^.\\n]{0,80}(\\b(not|no|none)\\b|isn't|n't (find|have|exist|hold|appear)|is not on file)`,
          ),
        },
        { kind: "notContains", label: "no other note quoted as its notes", pattern: new RegExp(`\\b${t}\\b[^.\\n]{0,40}\\b(says?|said|notes? (say|said|that))\\b(?![^.\\n]{0,10}nothing)`) },
        { kind: "notCalledTool", label: "no note is drafted", tool: "create_note" },
      ],
      notes: [],
    };
  },
  (x) => ({
    id: "Q18",
    scope: "all",
    question: "Full review: performance, risk, tax, upcoming events.",
    checks: [
      { kind: "minLength", label: "a complete written answer", chars: 600 },
      { kind: "contains", label: "covers performance", pattern: /perform|return/ },
      { kind: "contains", label: "covers risk", pattern: /\brisk|volatil|drawdown/ },
      { kind: "contains", label: "covers tax", pattern: /\btax/ },
      { kind: "contains", label: "covers upcoming events", pattern: /upcoming|earnings|calendar|this week|next week/ },
      ...closedSourceChecks(x, "any"),
    ],
    notes: [],
  }),
];

export function buildGolden(x: ExpectedContext): GoldenQuestion[] {
  return GOLDEN.map((b) => b(x));
}

/** Every tool name a golden check refers to. */
export function toolsReferenced(questions: readonly GoldenQuestion[]): string[] {
  const names = new Set<string>();
  for (const q of questions) {
    for (const c of q.checks) {
      if (c.kind === "calledTool") (typeof c.tool === "string" ? [c.tool] : c.tool).forEach((t) => names.add(t));
      if (c.kind === "notCalledTool") names.add(c.tool);
    }
  }
  return [...names].sort();
}
