/**
 * The 18 golden questions (plan 2026-11-11, Task 9 table), as data.
 *
 * Each question is a function of the expected context (expected.ts), so
 * figures and symbols come from the eval database at run time, never from a
 * constant here. A check whose figure could not be derived is left out and
 * the question records why in `notes` (it is reported, not silently passed).
 *
 * Tool names that are not registered today (the wave-2 composite tools
 * before Task 8 lands) still appear in checks: the runner lists them as
 * "not registered" up front, and such a check fails, which is the honest
 * result for an app that cannot call the tool.
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

const ADVICE_DEFLECTION = /consult (a|your) (tax|financial) (professional|advis[eo]r)/;

const pct = (n: number) => Math.round(n * 100) / 100;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const GOLDEN: readonly Builder[] = [
  () => ({
    id: "Q1",
    scope: "all",
    question: "How's my portfolio doing this year?",
    checks: [
      { kind: "calledTool", label: "uses the TWR tool", tool: "query_twr" },
      { kind: "contains", label: "time-weighted return named", pattern: /time[- ]weighted|\bTWR\b/ },
      { kind: "contains", label: "money-weighted (XIRR) labelled", pattern: /money[- ]weighted|\bXIRR\b|\bIRR\b/ },
      { kind: "contains", label: "window dates given", pattern: /\b(19|20)\d{2}-\d{2}-\d{2}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/ },
      { kind: "notContains", label: "no sum of monthly changes", pattern: /sum of (the )?monthly/ },
    ],
    notes: [],
  }),
  (x) => ({
    id: "Q2",
    scope: "all",
    question: "What moved today, in dollars?",
    checks: [
      { kind: "calledTool", label: "uses the market snapshot", tool: "query_market_snapshot" },
      { kind: "contains", label: "the short is named", pattern: x.manifest.short },
      { kind: "contains", label: "an as-of date or day is given", pattern: /\bas of\b|\b(19|20)\d{2}-\d{2}-\d{2}\b|\btoday\b/ },
    ],
    notes: ["day_effect figures are checked by the tool call, not re-derived here"],
  }),
  () => ({
    id: "Q3",
    scope: "all",
    question: "Am I beating the S&P this year?",
    checks: [
      { kind: "calledTool", label: "uses the benchmark tool", tool: "query_performance_vs_benchmark" },
      { kind: "contains", label: "SPY or the S&P named", pattern: /\bSPY\b|S&P/ },
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
    ],
    notes: [],
  }),
  (x) => ({
    id: "Q5",
    scope: "all",
    question: "Tax-loss harvesting candidates?",
    checks: [
      { kind: "calledTool", label: "reads tax lots", tool: "query_tax_lots" },
      { kind: "contains", label: "the taxable loser is listed", pattern: x.manifest.harvestCandidate },
      { kind: "contains", label: "wash-sale caveat", pattern: /wash[- ]sale/ },
      { kind: "notContains", label: "the Roth lot is not offered", pattern: new RegExp(`\\b${x.manifest.rothLoser}\\b`) },
      { kind: "notContains", label: "the pending lot is not offered", pattern: new RegExp(`\\b${x.manifest.pendingLot}\\b`) },
    ],
    notes: [],
  }),
  (x) => {
    const checks: Check[] = [
      { kind: "calledTool", label: "uses the realized-gains tool", tool: "query_realized_gains" },
      { kind: "contains", label: "short-term named", pattern: /short[- ]term/ },
      { kind: "contains", label: "long-term named", pattern: /long[- ]term/ },
      { kind: "contains", label: "not-for-filing caveat", pattern: /not (for|to be used for) filing|not a filing|1099|not tax advice|estimate/ },
    ];
    const notes: string[] = [];
    if (x.realized) {
      checks.push({ kind: "number", label: `short-term total for ${x.realized.year}`, value: x.realized.shortTerm, absTol: 1, relTol: 0.01 });
      if (x.realized.longTerm !== 0) {
        checks.push({ kind: "number", label: `long-term total for ${x.realized.year}`, value: x.realized.longTerm, absTol: 1, relTol: 0.01 });
      }
      const yearTotal = x.realized.shortTerm + x.realized.longTerm;
      if (Math.abs(x.realized.lifetimeAllAccounts - yearTotal) > 5) {
        checks.push({ kind: "notNumber", label: "not the lifetime total", value: x.realized.lifetimeAllAccounts, absTol: 1, relTol: 0.005 });
      }
    } else notes.push("realized figures could not be derived");
    return { id: "Q6", scope: "all", question: "Realized gains this year, short vs long?", checks, notes };
  },
  (x) => ({
    id: "Q7",
    scope: "all",
    question: "What options expire in the next 30 days?",
    checks: [
      { kind: "calledTool", label: "uses the options book", tool: "query_options_book" },
      { kind: "contains", label: "the live contract's underlying", pattern: new RegExp(`\\b${x.manifest.liveOption.underlying}\\b`) },
      { kind: "notContains", label: "not the expired contract's expiry", pattern: x.manifest.expiredOption.expiry },
    ],
    notes: [],
  }),
  () => ({
    id: "Q8",
    scope: "all",
    question: "How exposed am I to a 20% market drop?",
    checks: [
      { kind: "calledTool", label: "uses the scenario tool", tool: "query_scenarios" },
      { kind: "contains", label: "unmodelled positions mentioned", pattern: /not modell?ed|unmodell?ed|excluded|could not be modell?ed|left out/ },
      { kind: "notContains", label: "no hand-made beta x value", pattern: /beta\s*[x×*]\s*(the\s*)?(market )?value/ },
    ],
    notes: [],
  }),
  (x) => {
    const checks: Check[] = [{ kind: "calledTool", label: "reads holdings", tool: "query_holdings" }];
    const notes: string[] = [];
    const w = x.ibkrTopWeight;
    if (w) {
      // The symbol, or the name's leading words before any figure (a model
      // writes "US Treasury Note", not "US Treasury Note 2.875% 2032").
      const shortName = w.name ? w.name.split(/\s+/).filter((_, i, ws) => !ws.slice(0, i + 1).some((t) => /\d/.test(t))).join(" ") : "";
      const names = [w.symbol.trim(), ...(shortName ? [shortName] : [])].map(escapeRegExp);
      checks.push({ kind: "contains", label: "the largest position named", pattern: new RegExp(names.join("|")) });
      checks.push({ kind: "number", label: "weight on the account base", value: pct(w.accountWeightPct), absTol: 0.6, percentOnly: true });
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
      { kind: "contains", label: "the bill's maturity date", pattern: new RegExp(`${x.manifest.bill.maturity}|${x.manifest.bill.symbol}|Treasury Bill`) },
      { kind: "notContains", label: "no invented duration", pattern: /duration (of|is) (about |roughly |approximately )?\d/ },
    ],
    notes: [],
  }),
  (x) => {
    const checks: Check[] = [{ kind: "calledTool", label: "uses the income tool", tool: "query_income_summary" }];
    const notes: string[] = [];
    const d = x.dividends12m;
    if (d) {
      checks.push({ kind: "number", label: "the single-count dividend figure", value: d.single, absTol: 1, relTol: 0.005 });
      if (d.reinvestedPaired > 0) {
        checks.push({ kind: "notNumber", label: "not the double count", value: d.single + d.reinvestedPaired, absTol: 0.5 });
      }
      if (d.marginInterestPaid > 0) {
        checks.push({ kind: "notNumber", label: "margin interest not added as income", value: d.single + d.marginInterestPaid, absTol: 0.5 });
      }
    } else notes.push("dividend figures could not be derived");
    return { id: "Q11", scope: "all", question: "Dividend income last 12 months?", checks, notes };
  },
  () => ({
    id: "Q12",
    scope: "all",
    question: "Can I trust today's numbers?",
    checks: [
      { kind: "calledTool", label: "uses the data-confidence tool", tool: "query_data_confidence" },
      { kind: "contains", label: "a stale date or staleness is named", pattern: /stale|out of date|as of|\b(19|20)\d{2}-\d{2}-\d{2}\b/ },
      { kind: "notContains", label: "not 'everything is fresh'", pattern: /everything (is|looks) (fresh|current|up to date)|all (data|figures|numbers) (are|is) (fresh|current|up to date)/ },
    ],
    notes: [],
  }),
  (x) => {
    const w = x.longTermWait;
    const checks: Check[] = [
      { kind: "contains", label: "a view labelled as a view", pattern: /\bmy (read|view|take)\b|\bI('d| would)\b|\bin my view\b/ },
      { kind: "contains", label: "an assumed rate gap labelled as such", pattern: /assum/ },
      { kind: "notContains", label: "no advice deflection", pattern: ADVICE_DEFLECTION },
    ];
    const notes: string[] = [];
    if (w) {
      checks.push({ kind: "number", label: "days remaining to long-term", value: w.daysToLongTerm, absTol: 2 });
      if (w.unrealizedGain !== null) checks.push({ kind: "number", label: "the lot's gain", value: w.unrealizedGain, absTol: 1, relTol: 0.01 });
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
      { kind: "contains", label: "times in Eastern", pattern: /\bET\b|Eastern|\bEST\b|\bEDT\b|nothing (on|scheduled)|no (events|earnings)/ },
    ],
    notes: ["report_state is checked by review of the answer, not by pattern"],
  }),
  (x) => {
    const checks: Check[] = [
      { kind: "contains", label: "the currency code", pattern: new RegExp(`\\b${x.manifest.foreign.currency}\\b|¥`) },
    ];
    const notes: string[] = [];
    const f = x.foreign;
    if (f) {
      checks.push({ kind: "number", label: "the native price", value: f.nativePrice, absTol: 0.5, relTol: 0.002 });
      checks.push({ kind: "number", label: "the USD value", value: f.usdValue, absTol: 1, relTol: 0.01 });
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
      { kind: "contains", label: "delta-adjusted", pattern: /delta/ },
      { kind: "contains", label: "broken out by account", pattern: /IBKR/ },
      { kind: "notContains", label: "no premium sum as exposure", pattern: /premium[^.]{0,40}(exposure|total exposure)/ },
    ],
    notes: [],
  }),
  (x) => ({
    id: "Q17",
    scope: "all",
    question: `What do my notes say about ${x.manifest.unknownTicker}?`,
    checks: [
      {
        kind: "contains",
        label: "says the ticker is not on file",
        pattern: new RegExp(
          `(no|not|n't|nothing)[^.]{0,80}\\b${x.manifest.unknownTicker}\\b|\\b${x.manifest.unknownTicker}\\b[^.]{0,80}(not|no |isn't|n't)`,
        ),
      },
      { kind: "notCalledTool", label: "no note is drafted", tool: "create_note" },
    ],
    notes: [],
  }),
  () => ({
    id: "Q18",
    scope: "all",
    question: "Full review: performance, risk, tax, upcoming events.",
    checks: [
      { kind: "minLength", label: "a complete written answer", chars: 600 },
      { kind: "contains", label: "covers performance", pattern: /perform|return/ },
      { kind: "contains", label: "covers risk", pattern: /risk|volatil|drawdown/ },
      { kind: "contains", label: "covers tax", pattern: /tax/ },
      { kind: "contains", label: "covers upcoming events", pattern: /upcoming|earnings|calendar|this week|next week/ },
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
