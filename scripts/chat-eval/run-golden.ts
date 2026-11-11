/**
 * run-golden.ts: the chat golden evaluation and the prompt-cache proof.
 *
 * ON DEMAND ONLY. It spends real money through the running app's chat
 * route; it is never part of the test suite (only the pure scorer is, in
 * tests/scripts/chat-eval-scorer.test.ts).
 *
 * What it drives: a dev server started from this checkout against the eval
 * database (plan 2026-11-11, W3-4), over HTTP, exactly as the browser does.
 * So the system prompt, tool list, dispatcher, cache marks and model
 * resolution (`resolveFeatureModel("chat")`) are the app's own; this script
 * never names a model. Token usage comes from the route's `[chat-usage]`
 * server-log lines (--log), priced by the model id each line reports.
 *
 * Recipe (from the repo root; the demo DB, the eval DB, the server, then this):
 *   npm run seed:demo        (in a worktree where tsx is not on the npm script path:
 *                             npx tsx scripts/seed-demo.ts)
 *   npx tsx scripts/chat-eval/build-eval-db.ts --force
 *   # the server needs ANTHROPIC_API_KEY in its own environment
 *   DATABASE_PATH=$PWD/data/chat-eval/eval.db TWS_HOST=192.0.2.1 \
 *     APP_EXTRA_HOSTS=127.0.0.1:3095 APP_EXTRA_ORIGINS=http://127.0.0.1:3095 \
 *     npx next dev -H 127.0.0.1 -p 3095 > data/chat-eval/server.log 2>&1
 *   npx tsx scripts/chat-eval/run-golden.ts --db data/chat-eval/eval.db --dry-run [--mode cache-proof]
 *   npx tsx scripts/chat-eval/run-golden.ts --db data/chat-eval/eval.db --log data/chat-eval/server.log \
 *     --mode cache-proof --max-usd N
 *   npx tsx scripts/chat-eval/run-golden.ts --db data/chat-eval/eval.db --log data/chat-eval/server.log \
 *     --max-usd N [--only Q1,Q5] [--show-answers]
 *
 * The cap is HARD: a question runs only when the money spent so far plus
 * that question's worst case (its real input size, every step up to the
 * route's step cap at the dearer input rate, the route's maximum output per
 * step, a per-step tool-result allowance, one nested-AI reserve) fits under
 * --max-usd. A request whose streamed tool result is bigger than the
 * allowance is aborted; a step with no usage line books the worst case and
 * stops the run. Questions that do not fit are skipped and listed.
 *
 * Flags:
 *   --db <path>          required; refused when named vanguard.db or not built by build-eval-db.ts
 *   --log <path>         the dev server's log file (required unless --dry-run)
 *   --base-url <url>     default http://127.0.0.1:3095
 *   --mode golden|cache-proof   default golden
 *   --max-usd <n>        hard budget cap (alias --budget-usd; default 4, the plan's default)
 *   --tool-result-tokens <n>    per-step tool-result allowance in the worst case (default 8000)
 *   --only Q1,Q5         run a subset (golden mode)
 *   --page <path>        a /dashboard path sent as the page context (golden mode; default none)
 *   --out <path>         JSON result (default data/chat-eval/results-<timestamp>.json; must be git-ignored)
 *   --show-answers       print answer text (and keep it in the JSON); off by default
 *   --dry-run            build every request, print the plan and the estimate; no request is sent
 *   --timeout-ms <n>     per request (default 240000)
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { UIMessage } from "ai";
import { todayET } from "../../lib/calendar/date-utils";
import { setFeatureModelOverrideSource } from "../../lib/ai/override-source";
import { setModelCatalogSource } from "../../lib/ai/catalog-source";
import { getFeatureModelOverrides } from "../../lib/queries/ai-model-overrides";
import { getModelCatalog } from "../../lib/ai/model-catalog";
import { resolveFeatureModel } from "../../lib/ai/models";
import { createSession, revokeSessionsByLabel } from "../../lib/mutations/sessions";
import { type ChatScope } from "../../lib/types";
import { liveDbRefusal, readEvalMarker, resolvedDbPath, EVAL_FIXTURE_VERSION } from "./db-guard";
import { outputPathRefusal } from "./output-guard";
import { readManifest } from "./manifest";
import { deriveExpected, type ExpectedContext } from "./expected";
import { buildGolden, toolsReferenced, type GoldenQuestion } from "./golden";
import { scoreAnswer, serializeCheck, type ScoreResult } from "./scorer";
import {
  NESTED_AI_TOOLS,
  PRICE_SOURCE,
  ZERO_USAGE,
  addUsage,
  budgetAllows,
  costOf,
  priceFor,
  questionsThatFit,
  roughTokens,
  worstCaseInputTokens,
  worstCaseQuestionCost,
  type RequestLimits,
  type TokenUsage,
} from "./pricing";
import { MAX_CHAT_STEPS } from "../../lib/chat/history";
import { previewRequest } from "./request-preview";
import {
  fileLogDeps,
  sendChat,
  userMessage,
  waitForUsage,
  type ChatExchange,
  type ChatRequest,
  type Session,
  type TransportDeps,
} from "./transport";
import { cacheVerdicts, priceTurn, type CacheStepRow, type CacheVerdict, type PricedTurn } from "./accounting";

export const SESSION_LABEL = "chat-eval";
export const DEFAULT_MAX_USD = 4;

export interface EvalOptions {
  db: string;
  log?: string;
  baseUrl: string;
  mode: "golden" | "cache-proof";
  maxUsd: number;
  only?: string[];
  page?: string;
  out?: string;
  showAnswers: boolean;
  dryRun: boolean;
  timeoutMs: number;
  toolResultTokens: number;
}

type Print = (line: string) => void;

// ─── Args ────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): EvalOptions | { error: string } {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const db = get("--db");
  if (!db) return { error: "--db is required" };
  const mode = get("--mode") ?? "golden";
  if (mode !== "golden" && mode !== "cache-proof") return { error: `--mode must be golden or cache-proof, not ${mode}` };
  const maxRaw = get("--max-usd") ?? get("--budget-usd");
  const maxUsd = maxRaw === undefined ? DEFAULT_MAX_USD : Number(maxRaw);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) return { error: "--max-usd must be a positive number" };
  const timeoutMs = Number(get("--timeout-ms") ?? 240000);
  const toolResultTokens = Number(get("--tool-result-tokens") ?? DEFAULT_TOOL_RESULT_TOKENS);
  if (!Number.isFinite(toolResultTokens) || toolResultTokens < 0) return { error: "--tool-result-tokens must be a non-negative number" };
  const dryRun = argv.includes("--dry-run");
  const log = get("--log");
  if (!dryRun && !log) return { error: "--log <dev server log> is required unless --dry-run" };
  const page = get("--page");
  if (page !== undefined && !page.startsWith("/dashboard")) return { error: "--page must start with /dashboard" };
  return {
    db,
    log,
    baseUrl: get("--base-url") ?? "http://127.0.0.1:3095",
    toolResultTokens: toolResultTokens,
    mode,
    maxUsd,
    only: get("--only")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    page,
    out: get("--out"),
    showAnswers: argv.includes("--show-answers"),
    dryRun,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 240000,
  };
}

// ─── Setup ───────────────────────────────────────────────────────

export interface EvalSetup {
  dbPath: string;
  db: Database.Database;
  expected: ExpectedContext;
  /** What resolveFeatureModel("chat") gives for this database right now. */
  predictedModel: string;
}

export function setupEval(opts: EvalOptions, print: Print): EvalSetup | { error: string } {
  const refusal = liveDbRefusal(opts.db);
  if (refusal) return { error: refusal };
  const dbPath = resolvedDbPath(opts.db);
  print(`database: ${dbPath}`);
  if (!fs.existsSync(dbPath)) return { error: `no such file ${dbPath}; build it with scripts/chat-eval/build-eval-db.ts` };
  // Defensive: anything that resolves the app's default database in this
  // process sees the eval database, never the live one.
  process.env.DATABASE_PATH = dbPath;
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const marker = readEvalMarker(db);
  if (marker !== EVAL_FIXTURE_VERSION) {
    db.close();
    return { error: `refusing ${dbPath}: no eval marker (built by build-eval-db.ts version ${EVAL_FIXTURE_VERSION}); found ${marker ?? "none"}` };
  }
  const manifest = readManifest(db);
  if (!manifest) {
    db.close();
    return { error: `refusing ${dbPath}: the eval manifest is missing` };
  }
  // The same seams lib/db.ts wires for the app, pointed at the eval DB, so
  // the prediction resolves the way the server does.
  setFeatureModelOverrideSource(() => getFeatureModelOverrides(db));
  setModelCatalogSource(() => getModelCatalog(db));
  const predictedModel = resolveFeatureModel("chat").modelId;
  const today = todayET();
  if (manifest.builtFor !== today) {
    print(`warning: the fixture was built for ${manifest.builtFor}, today is ${today}; rebuild it so relative dates hold`);
  }
  return { dbPath, db, expected: deriveExpected(db, manifest, today), predictedModel };
}

function defaultOut(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("data", "chat-eval", `results-${stamp}.json`);
}

function mintSession(db: Database.Database): Session {
  revokeSessionsByLabel(db, SESSION_LABEL);
  const { rawToken, csrfToken } = createSession(db, { label: SESSION_LABEL }, Date.now());
  return { rawToken, csrfToken };
}

function conversationExists(db: Database.Database, id: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM chat_conversations WHERE id = ?").get(id));
}

const usd = (n: number) => `$${n.toFixed(4)}`;

// ─── The hard budget ─────────────────────────────────────────────

/**
 * The route's per-step output cap (`maxOutputTokens` in app/api/chat/route.ts,
 * an inline literal there; pinned to the route by a source test).
 */
export const ROUTE_MAX_OUTPUT_TOKENS = 16000;
/** Default tool-result allowance per step; a bigger streamed result aborts the request. */
export const DEFAULT_TOOL_RESULT_TOKENS = 8000;

export function requestLimits(toolResultTokens: number): RequestLimits {
  return { maxSteps: MAX_CHAT_STEPS, maxOutputTokensPerStep: ROUTE_MAX_OUTPUT_TOKENS, toolResultTokensPerStep: toolResultTokens };
}

/** The worst case of one request: its real input size (tools + system + messages) under the route's limits. */
export function requestWorstCase(
  setup: EvalSetup,
  scope: ChatScope,
  messages: readonly UIMessage[],
  pagePath: string | undefined,
  limits: RequestLimits,
): number {
  const price = priceFor(setup.predictedModel);
  if (!price) return Number.POSITIVE_INFINITY;
  const chars = previewRequest(setup.db, scope, setup.expected.today, pagePath).totalChars + JSON.stringify(messages).length;
  return worstCaseQuestionCost(worstCaseInputTokens(chars), limits, price);
}

interface AskResult {
  ex: ChatExchange;
  priced: PricedTurn;
  /** Why the whole run must stop after this request, or null. */
  stop: string | null;
}

/**
 * Send one request under the hard budget (the caller has already checked
 * spent + worstCase <= cap). While it streams, a tool result bigger than
 * the allowance, or a second nested-AI tool call, aborts it (the worst case
 * would no longer bound it). Afterwards every streamed step must have its
 * usage line; if not, the worst case is booked and the run stops.
 */
async function guardedAsk(
  opts: EvalOptions,
  setup: EvalSetup,
  deps: TransportDeps,
  req: Omit<ChatRequest, "baseUrl" | "timeoutMs" | "onChunk">,
  worstCase: number,
  limits: RequestLimits,
): Promise<AskResult> {
  let nestedCalls = 0;
  const onChunk = (chunk: Record<string, unknown>): string | null => {
    if (chunk.type === "tool-output-available") {
      const tokens = roughTokens(JSON.stringify(chunk.output ?? ""));
      if (tokens > limits.toolResultTokensPerStep) {
        return `a tool result of ~${tokens} tokens exceeds the ${limits.toolResultTokensPerStep}-token allowance the worst case assumes`;
      }
    }
    if (chunk.type === "tool-input-start" && typeof chunk.toolName === "string" && NESTED_AI_TOOLS.includes(chunk.toolName)) {
      nestedCalls++;
      if (nestedCalls > 1) return `a second nested-AI tool call (${chunk.toolName}); the worst case reserves one`;
    }
    return null;
  };
  const logStart = deps.logSize();
  const ex = await sendChat({ ...req, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, onChunk }, deps);
  let stop: string | null = ex.stoppedByRunner ? `request stopped: ${ex.stoppedByRunner}` : null;
  if (ex.status === 401 || ex.status === 403) {
    stop = `the app refused the minted session (HTTP ${ex.status}); is the dev server running with DATABASE_PATH=${setup.dbPath} and APP_EXTRA_HOSTS/APP_EXTRA_ORIGINS for this host and port?`;
  }
  if (ex.conversationId !== null && !conversationExists(setup.db, ex.conversationId)) {
    stop = `conversation ${ex.conversationId} is not in ${setup.dbPath}: the server is using another database`;
  }
  // A refused request (non-200) returned before the model was called: no usage line will come.
  const turns = ex.conversationId !== null && ex.status === 200 ? await waitForUsage(deps, logStart, ex.conversationId, 1) : [];
  const aborted = Boolean(ex.stoppedByRunner) || (ex.status === 200 && !ex.summary.done && ex.httpError !== null);
  const priced = priceTurn({
    turn: turns[turns.length - 1],
    toolCalls: ex.summary.toolCalls,
    httpStatus: ex.status,
    streamedSteps: ex.status === 200 ? ex.summary.finishSteps : null,
    aborted,
    worstCase,
    expectedModel: setup.predictedModel,
  });
  if (priced.unknownModel) stop = `the server used model ${priced.unknownModel}, which has no price in scripts/chat-eval/pricing.ts`;
  else if (priced.usageMissing) stop = stop ?? `usage not fully accounted (${priced.usageMissing})`;
  return { ex, priced, stop };
}

// ─── Golden mode ─────────────────────────────────────────────────

export interface QuestionRecord {
  id: string;
  scope: ChatScope;
  question: string;
  status: "scored" | "skipped-budget" | "aborted";
  score: ScoreResult | null;
  toolCalls: string[];
  steps: number | null;
  finishReason: string | null;
  usage: TokenUsage | null;
  perStep: { step: number; usage: TokenUsage }[];
  model: string | null;
  costUsd: number;
  reserveReason: string | null;
  /** The hard-cap worst case this question was checked with. */
  worstCaseUsd?: number;
  conversationId: number | null;
  elapsedMs: number | null;
  notes: string[];
  answer?: string;
  checks: Record<string, unknown>[];
}

export interface GoldenReport {
  mode: "golden";
  startedAt: string;
  database: string;
  baseUrl: string;
  predictedModel: string;
  priceSource: string;
  maxUsd: number;
  spentUsd: number;
  stoppedReason: string | null;
  unregisteredTools: string[];
  questions: QuestionRecord[];
}

export async function runGolden(
  opts: EvalOptions,
  setup: EvalSetup,
  deps: TransportDeps,
  print: Print,
): Promise<GoldenReport> {
  const all = buildGolden(setup.expected);
  const questions = opts.only ? all.filter((q) => opts.only!.includes(q.id)) : all;
  const unregistered = toolsReferenced(questions).filter((t) => !setup.expected.registeredTools.includes(t));
  const report: GoldenReport = {
    mode: "golden",
    startedAt: new Date().toISOString(),
    database: setup.dbPath,
    baseUrl: opts.baseUrl,
    predictedModel: setup.predictedModel,
    priceSource: PRICE_SOURCE,
    maxUsd: opts.maxUsd,
    spentUsd: 0,
    stoppedReason: null,
    unregisteredTools: unregistered,
    questions: [],
  };
  if (unregistered.length > 0) {
    print(`note: checks name tools the app does not register yet (they will fail): ${unregistered.join(", ")}`);
  }

  const session = mintSession(setup.db);
  const limits = requestLimits(opts.toolResultTokens);
  let stop: string | null = null;
  try {
    for (const q of questions) {
      const base: QuestionRecord = {
        id: q.id,
        scope: q.scope,
        question: q.question,
        status: "skipped-budget",
        score: null,
        toolCalls: [],
        steps: null,
        finishReason: null,
        usage: null,
        perStep: [],
        model: null,
        costUsd: 0,
        reserveReason: null,
        conversationId: null,
        elapsedMs: null,
        notes: q.notes,
        checks: q.checks.map(serializeCheck),
      };
      if (stop) {
        report.questions.push({ ...base, status: "aborted" });
        continue;
      }
      const messages = [userMessage(randomUUID(), q.question)];
      const worst = requestWorstCase(setup, q.scope, messages, opts.page, limits);
      const decision = budgetAllows(report.spentUsd, worst, opts.maxUsd);
      if (!decision.run) {
        // Hard cap: skip it and try the next (a smaller one may still fit).
        report.questions.push({ ...base, worstCaseUsd: worst, reserveReason: `skipped: ${decision.reason}` });
        continue;
      }
      const { ex, priced, stop: askStop } = await guardedAsk(
        opts,
        setup,
        deps,
        { session, chatId: randomUUID(), scope: q.scope, conversationId: null, messages, pagePath: opts.page },
        worst,
        limits,
      );
      if (askStop) stop = askStop;
      report.spentUsd += priced.costUsd;
      const errorText = ex.httpError ?? ex.summary.errorText ?? (ex.stoppedByRunner ? `stopped by the runner: ${ex.stoppedByRunner}` : null);

      const score = scoreAnswer(
        {
          text: ex.summary.text,
          toolCalls: ex.summary.toolCalls,
          finishReason: ex.summary.finishReason,
          error: errorText,
        },
        q.checks,
      );
      report.questions.push({
        ...base,
        status: "scored",
        score,
        toolCalls: ex.summary.toolCalls,
        steps: ex.summary.stepCount ?? (ex.summary.finishSteps || null),
        finishReason: ex.summary.finishReason,
        usage: priced.usage,
        perStep: priced.steps,
        model: priced.model,
        costUsd: priced.costUsd,
        reserveReason: priced.reserveReason,
        worstCaseUsd: worst,
        conversationId: ex.conversationId,
        elapsedMs: ex.elapsedMs,
        ...(opts.showAnswers ? { answer: ex.summary.text } : {}),
      });
      print(
        `${q.id} ${score.pass ? "PASS" : "FAIL"} ${score.passed}/${score.total}` +
          `${score.gate ? ` [${score.gate}]` : ""} steps=${ex.summary.stepCount ?? "?"} cost=${usd(priced.costUsd)} total=${usd(report.spentUsd)}`,
      );
      if (opts.showAnswers) print(`--- ${q.id} answer ---\n${ex.summary.text}\n---`);
    }
  } finally {
    revokeSessionsByLabel(setup.db, SESSION_LABEL);
  }
  report.stoppedReason = stop;
  return report;
}

export function printGoldenTable(report: GoldenReport, print: Print): void {
  print("");
  print("id   scope             result  checks  steps  finish      tools                                      noCache  cWrite   cRead    output   cost");
  for (const q of report.questions) {
    const u = q.usage;
    const result = q.status !== "scored" ? q.status : q.score?.pass ? "PASS" : "FAIL";
    print(
      [
        q.id.padEnd(4),
        q.scope.padEnd(17),
        result.padEnd(7),
        (q.score ? `${q.score.passed}/${q.score.total}` : "-").padEnd(7),
        String(q.steps ?? "-").padEnd(6),
        (q.finishReason ?? "-").padEnd(11),
        (q.toolCalls.join(",") || "-").slice(0, 42).padEnd(42),
        String(u?.noCache ?? "-").padStart(7),
        String(u?.cacheWrite ?? "-").padStart(8),
        String(u?.cacheRead ?? "-").padStart(8),
        String(u?.output ?? "-").padStart(8),
        usd(q.costUsd).padStart(9),
      ].join(" "),
    );
    if (q.score && !q.score.pass) {
      if (q.score.gate) print(`       gate: ${q.score.gate}`);
      for (const c of q.score.checks.filter((c) => !c.pass)) print(`       fail: ${c.label} (${c.detail})`);
    }
    if (q.reserveReason) print(`       cost note: ${q.reserveReason}`);
    for (const n of q.notes) print(`       note: ${n}`);
  }
  const scored = report.questions.filter((q) => q.status === "scored");
  const passed = scored.filter((q) => q.score?.pass).length;
  const total = scored.reduce((acc, q) => addUsage(acc, q.usage ?? ZERO_USAGE), ZERO_USAGE);
  print("");
  print(`passed ${passed}/${scored.length} scored (${report.questions.length} planned)`);
  print(`tokens: uncached input ${total.noCache}, cache write ${total.cacheWrite}, cache read ${total.cacheRead}, output ${total.output}`);
  print(`cost: ${usd(report.spentUsd)} of cap $${report.maxUsd.toFixed(2)}  (prices: ${report.priceSource})`);
  const skipped = report.questions.filter((q) => q.status !== "scored").map((q) => q.id);
  if (skipped.length > 0) print(`not run: ${skipped.join(", ")}`);
  if (report.stoppedReason) print(`stopped: ${report.stoppedReason}`);
}

// ─── Cache-proof mode ────────────────────────────────────────────


export interface CacheReport {
  mode: "cache-proof";
  startedAt: string;
  database: string;
  predictedModel: string;
  priceSource: string;
  maxUsd: number;
  spentUsd: number;
  prefixTokensEstimate: number;
  prefixTokensMeasured: number | null;
  turns: CacheStepRow[];
  verdicts: CacheVerdict[];
  stoppedReason: string | null;
}

const CACHE_SEQUENCE = [
  { label: "B1", conversation: "B", text: "Reply with one word: ready.", page: "first" },
  { label: "A1", conversation: "A", text: "What are my three largest holdings by market value? Use the holdings tool.", page: "first" },
  { label: "A2", conversation: "A", text: "Of those three, which has the largest unrealized gain? Answer in one sentence.", page: "first" },
  { label: "A3", conversation: "A", text: "Thanks. In one sentence: which account holds the most cash?", page: "second" },
] as const;

export async function runCacheProof(
  opts: EvalOptions,
  setup: EvalSetup,
  deps: TransportDeps,
  print: Print,
): Promise<CacheReport> {
  const scope: ChatScope = "all";
  const aapl = setup.db.prepare("SELECT id FROM securities WHERE symbol = 'AAPL'").get() as { id: number } | undefined;
  const pages = { first: aapl ? `/dashboard/security/${aapl.id}` : "/dashboard/today", second: "/dashboard/accounts" };
  const preview = previewRequest(setup.db, scope, setup.expected.today, pages.first);
  const report: CacheReport = {
    mode: "cache-proof",
    startedAt: new Date().toISOString(),
    database: setup.dbPath,
    predictedModel: setup.predictedModel,
    priceSource: PRICE_SOURCE,
    maxUsd: opts.maxUsd,
    spentUsd: 0,
    prefixTokensEstimate: preview.prefixTokensEstimate,
    prefixTokensMeasured: null,
    turns: [],
    verdicts: [],
    stoppedReason: null,
  };

  // B1 runs first so its step-1 read is the cross-conversation prefix
  // (warm from any earlier request in this scope) or, cold, it writes the
  // prefix that A1 then reads. Either way one of B1/A1 step 1 reads about P.
  const session = mintSession(setup.db);
  const conv: Record<string, { id: number | null; messages: UIMessage[]; chatId: string }> = {
    A: { id: null, messages: [], chatId: randomUUID() },
    B: { id: null, messages: [], chatId: randomUUID() },
  };
  const limits = requestLimits(opts.toolResultTokens);
  try {
    for (const turn of CACHE_SEQUENCE) {
      const c = conv[turn.conversation];
      const messages = [...c.messages, userMessage(randomUUID(), turn.text)];
      const worst = requestWorstCase(setup, scope, messages, pages[turn.page], limits);
      const decision = budgetAllows(report.spentUsd, worst, opts.maxUsd);
      if (!decision.run) {
        report.stoppedReason = `budget (hard cap): ${decision.reason}`;
        break;
      }
      const { ex, priced, stop } = await guardedAsk(
        opts,
        setup,
        deps,
        { session, chatId: c.chatId, scope, conversationId: c.id, messages, pagePath: pages[turn.page] },
        worst,
        limits,
      );
      report.spentUsd += priced.costUsd;
      report.turns.push({ label: turn.label, conversationId: ex.conversationId, page: pages[turn.page], steps: priced.steps, costUsd: priced.costUsd });
      for (const s of priced.steps) {
        print(
          `${turn.label} step ${s.step + 1}: uncached ${s.usage.noCache}, cache write ${s.usage.cacheWrite}, cache read ${s.usage.cacheRead}, output ${s.usage.output}`,
        );
      }
      const errorText = ex.httpError ?? ex.summary.errorText;
      if (stop) {
        report.stoppedReason = stop;
        break;
      }
      if (errorText) {
        report.stoppedReason = `${turn.label} failed: ${errorText}`;
        break;
      }
      c.id = ex.conversationId;
      c.messages = ex.assistantMessage ? [...messages, ex.assistantMessage] : messages;
    }
  } finally {
    revokeSessionsByLabel(setup.db, SESSION_LABEL);
  }

  // P, the cached prefix (tools + static block): the first-step cache read
  // of a NEW conversation. B1 and A1 are both new conversations in the same
  // scope; whichever ran warm read only the prefix (the volatile block has
  // no mark and each one's message tail is its own). If B1 ran cold it read
  // 0 and wrote the prefix, so A1 reads it; the smaller non-zero read is P.
  const firstReads = ["B1", "A1"]
    .map((l) => report.turns.find((t) => t.label === l)?.steps.find((s) => s.step === 0)?.usage.cacheRead ?? 0)
    .filter((r) => r > 0);
  report.prefixTokensMeasured = firstReads.length > 0 ? Math.min(...firstReads) : null;
  report.verdicts = cacheVerdicts(report.turns, report.prefixTokensMeasured);
  return report;
}

export function printCacheReport(report: CacheReport, print: Print): void {
  print("");
  print(`prefix estimate (tools + static block, chars/3): ${report.prefixTokensEstimate} tokens; measured P: ${report.prefixTokensMeasured ?? "none"}`);
  for (const v of report.verdicts) print(`verdict ${v.id.padEnd(3)} ${v.result.padEnd(9)} ${v.check}: ${v.detail}`);
  print(`cost: ${usd(report.spentUsd)} of cap $${report.maxUsd.toFixed(2)}  (prices: ${report.priceSource})`);
  if (report.stoppedReason) print(`stopped: ${report.stoppedReason}`);
}

// ─── Dry run ─────────────────────────────────────────────────────

export function dryRun(opts: EvalOptions, setup: EvalSetup, print: Print): void {
  const price = priceFor(setup.predictedModel);
  const limits = requestLimits(opts.toolResultTokens);
  print(`predicted chat model (resolveFeatureModel("chat") on this database): ${setup.predictedModel}`);
  print(`price source: ${PRICE_SOURCE}`);
  print(
    `hard-cap rule: spent + worst case <= $${opts.maxUsd.toFixed(2)}; worst case = ${limits.maxSteps} steps x (input at the dearer of ` +
      `uncached/cache-write, +${limits.maxOutputTokensPerStep} output and +${limits.toolResultTokensPerStep} tool-result tokens per earlier step) ` +
      `+ ${limits.maxOutputTokensPerStep} output per step + one nested-AI reserve`,
  );
  if (!price) print(`NOTE: no price for ${setup.predictedModel}; a live run will refuse to start`);
  if (opts.mode === "cache-proof") {
    const p = previewRequest(setup.db, "all", setup.expected.today);
    const worst = requestWorstCase(setup, "all", [userMessage("dry", "x")], undefined, limits);
    print(`cache-proof plan: B1 (fresh conversation), A1 tool question, A2 same page, A3 page changed; scope all`);
    print(`request size estimate: prefix ${p.prefixTokensEstimate} tokens (${p.toolCount} tools), volatile ${p.volatileTokensEstimate} tokens`);
    print(`worst case per request (first turn size): $${worst.toFixed(2)}; requests that fit under the cap: ${questionsThatFit([worst, worst, worst, worst], opts.maxUsd)} of 4 (later turns are larger)`);
    return;
  }
  const qs = buildGolden(setup.expected).filter((q) => !opts.only || opts.only.includes(q.id));
  const unregistered = toolsReferenced(qs).filter((t) => !setup.expected.registeredTools.includes(t));
  const sizes = new Map<ChatScope, ReturnType<typeof previewRequest>>();
  let typical = 0;
  const worsts: number[] = [];
  for (const q of qs) {
    if (!sizes.has(q.scope)) sizes.set(q.scope, previewRequest(setup.db, q.scope, setup.expected.today, opts.page));
    const s = sizes.get(q.scope)!;
    // A typical cold question: the whole prompt written once, 4 more steps reading it, 3k output.
    const tokens = s.prefixTokensEstimate + s.volatileTokensEstimate;
    const est = price ? costOf({ noCache: 2000, cacheWrite: tokens, cacheRead: tokens * 4, output: 3000 }, price) : 0;
    const worst = requestWorstCase(setup, q.scope, [userMessage("dry", q.question)], opts.page, limits);
    typical += est;
    worsts.push(worst);
    print(`${q.id} [${q.scope}] ${q.question}`);
    for (const c of q.checks) print(`     ${c.kind}: ${c.label}`);
    for (const n of q.notes) print(`     note: ${n}`);
    print(`     request: prefix ~${s.prefixTokensEstimate} + volatile ~${s.volatileTokensEstimate} tokens; typical $${est.toFixed(2)}; worst case $${worst.toFixed(2)}`);
  }
  if (unregistered.length > 0) print(`tools named in checks but not registered today: ${unregistered.join(", ")}`);
  const fit = questionsThatFit(worsts, opts.maxUsd);
  print(`${qs.length} questions; typical total $${typical.toFixed(2)}; worst-case total $${worsts.reduce((a, b) => a + b, 0).toFixed(2)}`);
  print(`under the hard cap of $${opts.maxUsd.toFixed(2)}, ${fit} of ${qs.length} questions fit in order if each spent its worst case; the rest would be skipped`);
}

// ─── Main ────────────────────────────────────────────────────────

export async function main(argv: string[], deps?: Partial<TransportDeps>, print: Print = (l) => console.log(l)): Promise<number> {
  const opts = parseArgs(argv);
  if ("error" in opts) {
    print(`run-golden: ${opts.error}`);
    return 2;
  }
  const setup = setupEval(opts, print);
  if ("error" in setup) {
    print(`run-golden: ${setup.error}`);
    return 2;
  }
  try {
    if (opts.dryRun) {
      dryRun(opts, setup, print);
      return 0;
    }
    if (!priceFor(setup.predictedModel)) {
      print(`run-golden: refusing to run: model ${setup.predictedModel} has no price in scripts/chat-eval/pricing.ts (add it with its source and date)`);
      return 2;
    }
    const out = opts.out ?? defaultOut();
    const outRefusal = outputPathRefusal(out);
    if (outRefusal) {
      print(`run-golden: ${outRefusal}`);
      return 2;
    }
    const full: TransportDeps = {
      fetch: deps?.fetch ?? fetch,
      sleep: deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      ...fileLogDeps(opts.log!),
      ...(deps?.readLogSince ? { readLogSince: deps.readLogSince } : {}),
      ...(deps?.logSize ? { logSize: deps.logSize } : {}),
    };
    print(`log: ${path.resolve(opts.log!)}   app: ${opts.baseUrl}   cap: $${opts.maxUsd.toFixed(2)}`);
    let ok = true;
    let json: unknown;
    if (opts.mode === "cache-proof") {
      const report = await runCacheProof(opts, setup, full, print);
      printCacheReport(report, print);
      ok = report.verdicts.every((v) => v.result !== "FAIL");
      json = report;
    } else {
      const report = await runGolden(opts, setup, full, print);
      printGoldenTable(report, print);
      ok = report.questions.every((q) => q.status === "scored" && q.score?.pass);
      json = report;
    }
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(json, null, 2));
    print(`results: ${path.resolve(out)}`);
    return ok ? 0 : 1;
  } finally {
    setup.db.close();
  }
}

if (process.argv[1] && /run-golden\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`run-golden: ${(err as Error)?.message ?? err}`);
      process.exit(2);
    },
  );
}

export type { GoldenQuestion };
