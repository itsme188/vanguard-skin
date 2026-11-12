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
 *   # the server needs ANTHROPIC_API_KEY in its own environment, and must be
 *   # started with ANTHROPIC_BASE_URL UNSET: an agent shell exports it without
 *   # /v1, @ai-sdk/anthropic then posts to /messages and every call is a 404
 *   # (the runner stops on a provider 404 with this explanation)
 *   unset ANTHROPIC_BASE_URL
 *   DATABASE_PATH=$PWD/data/chat-eval/eval-v3.db TWS_HOST=192.0.2.1 \
 *     APP_EXTRA_HOSTS=127.0.0.1:3095 APP_EXTRA_ORIGINS=http://127.0.0.1:3095 \
 *     npx next dev -H 127.0.0.1 -p 3095 > data/chat-eval/server.log 2>&1
 *   npx tsx scripts/chat-eval/run-golden.ts --db data/chat-eval/eval-v3.db --dry-run [--mode cache-proof]
 *   npx tsx scripts/chat-eval/run-golden.ts --db data/chat-eval/eval-v3.db --log data/chat-eval/server.log \
 *     --mode cache-proof --max-usd N
 *   npx tsx scripts/chat-eval/run-golden.ts --db data/chat-eval/eval-v3.db --log data/chat-eval/server.log \
 *     --max-usd N [--only Q1,Q5] [--show-answers]
 *
 * Budget (orchestrator ruling): a question starts only if the money spent
 * so far plus the per-question ceiling fits under --max-usd (else it is
 * skipped and listed). While it runs, the runner tails the server's
 * per-step usage lines and aborts the HTTP request (which stops the route's
 * model call) as soon as the running cost plus the worst the step already
 * in flight can cost would pass the ceiling; the question is then reported
 * "aborted-cost-ceiling" and scored as failed. Guaranteed maximum spend =
 * run cap + one step in flight (its input at the cache-write rate plus the
 * route's maximum output), printed at the start; --hard-ceiling-usd refuses
 * to start above it. A tool result over the character bound aborts and stops
 * the run; a step with no usage line books one step worst case and stops it.
 *
 * Flags:
 *   --db <path>          required; refused when named vanguard.db or not built by build-eval-db.ts
 *   --log <path>         the dev server's log file (required unless --dry-run)
 *   --base-url <url>     default http://127.0.0.1:3095
 *   --mode golden|cache-proof   default golden
 *   --max-usd <n>        hard budget cap (alias --budget-usd; default 4, the plan's default)
 *   --max-usd-per-question <n>  ceiling enforced while a question runs (default 0.60)
 *   --hard-ceiling-usd <n>      refuse to start when cap + one step in flight exceeds it
 *   --tool-result-chars <n>     per-step tool-result bound the guarantee assumes (default 22000)
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
import { behaviourFlags, scoreAnswer, serializeCheck, type BehaviourFlags, type ScoreResult } from "./scorer";
import {
  NESTED_AI_TOOLS,
  PRICE_SOURCE,
  ZERO_USAGE,
  CHARS_PER_TOKEN,
  addUsage,
  QUESTION_RESERVE_USD,
  STEP_INPUT_MARGIN_TOKENS,
  budgetAllows,
  ceilingAllowsNextStep,
  costOf,
  inFlightStepWorstCase,
  priceFor,
  runGuarantee,
  stepWorstCase,
  worstCaseInputTokens,
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
import { parseUsageLines, splitTurns, type TurnUsage } from "./usage-lines";
import { localSnapshotCheck } from "./build-eval-db";
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
  /** Per-step bound on one tool result, in characters (a bigger one aborts the request). */
  toolResultChars: number;
  /** The per-question cost ceiling enforced while a question runs. */
  maxUsdPerQuestion: number;
  /** --max-usd-per-question was given (cache-proof derives its own default otherwise). */
  maxUsdPerQuestionExplicit: boolean;
  /** Appended to the cache-proof messages so each run's tail is new while the prefix is shared. */
  nonce: string;
  /** Refuse to start (or to start a request) when cap + one step in flight would exceed it. */
  hardCeilingUsd?: number;
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
  const toolResultChars = Number(get("--tool-result-chars") ?? DEFAULT_TOOL_RESULT_CHARS);
  if (!Number.isFinite(toolResultChars) || toolResultChars < 0) return { error: "--tool-result-chars must be a non-negative number" };
  const perQ = Number(get("--max-usd-per-question") ?? DEFAULT_MAX_USD_PER_QUESTION);
  if (!Number.isFinite(perQ) || perQ <= 0) return { error: "--max-usd-per-question must be a positive number" };
  const hardRaw = get("--hard-ceiling-usd");
  const hardCeilingUsd = hardRaw === undefined ? undefined : Number(hardRaw);
  if (hardCeilingUsd !== undefined && (!Number.isFinite(hardCeilingUsd) || hardCeilingUsd <= 0)) return { error: "--hard-ceiling-usd must be a positive number" };
  const dryRun = argv.includes("--dry-run");
  const log = get("--log");
  if (!dryRun && !log) return { error: "--log <dev server log> is required unless --dry-run" };
  const page = get("--page");
  if (page !== undefined && !page.startsWith("/dashboard")) return { error: "--page must start with /dashboard" };
  return {
    db,
    log,
    baseUrl: get("--base-url") ?? "http://127.0.0.1:3095",
    toolResultChars,
    maxUsdPerQuestion: perQ,
    maxUsdPerQuestionExplicit: get("--max-usd-per-question") !== undefined,
    nonce: get("--nonce") ?? randomUUID().slice(0, 8),
    ...(hardCeilingUsd !== undefined ? { hardCeilingUsd } : {}),
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

// ─── The budget: run cap, per-question ceiling, one step in flight ─────

/**
 * The route's per-step output cap (`maxOutputTokens` in app/api/chat/route.ts,
 * an inline literal there; pinned to the route by a source test).
 */
export const ROUTE_MAX_OUTPUT_TOKENS = 16000;
/**
 * The tools' owner bounds every tool's model-facing output under about
 * 22,000 characters (tests/chat/tools-output-size-guard.test.ts), the full
 * transcript excepted. A streamed tool result over this aborts the request.
 */
export const DEFAULT_TOOL_RESULT_CHARS = 22000;
/** Tokens per character assumed for a tool result in the worst case (conservative for JSON). */
export const TOOL_RESULT_TOKENS_PER_CHAR = 1 / 3;
export const DEFAULT_MAX_USD_PER_QUESTION = 0.6;
/** Pause after an aborted request so the route's last step lines are flushed. */
const ABORT_SETTLE_MS = 500;

export function requestLimits(toolResultChars: number): RequestLimits {
  return {
    maxSteps: MAX_CHAT_STEPS,
    maxOutputTokensPerStep: ROUTE_MAX_OUTPUT_TOKENS,
    toolResultTokensPerStep: Math.ceil(toolResultChars * TOOL_RESULT_TOKENS_PER_CHAR),
  };
}

export interface RequestBudget {
  /** The request's own input (tools + system + messages), rough tokens with a margin. */
  baseInputTokens: number;
  /** The first step's worst case (it starts before any check can run). */
  firstStepWorst: number;
  /** The largest step that can be in flight when the ceiling trips. */
  oneStepWorst: number;
}

/** The budget figures for one request, from its real size. */
export function requestBudget(
  setup: EvalSetup,
  scope: ChatScope,
  messages: readonly UIMessage[],
  pagePath: string | undefined,
  limits: RequestLimits,
  ceiling: number,
): RequestBudget {
  const price = priceFor(setup.predictedModel);
  const chars = previewRequest(setup.db, scope, setup.expected.today, pagePath).totalChars + JSON.stringify(messages).length;
  const baseInputTokens = worstCaseInputTokens(chars);
  if (!price) return { baseInputTokens, firstStepWorst: Number.POSITIVE_INFINITY, oneStepWorst: Number.POSITIVE_INFINITY };
  return {
    baseInputTokens,
    firstStepWorst: stepWorstCase(baseInputTokens + STEP_INPUT_MARGIN_TOKENS, limits.maxOutputTokensPerStep, price),
    oneStepWorst: inFlightStepWorstCase(baseInputTokens, limits, ceiling, price),
  };
}

/** Why a request may not start under the run rules, or null. Pure. */
export function startRefusal(
  spent: number,
  opts: Pick<EvalOptions, "maxUsd" | "maxUsdPerQuestion" | "hardCeilingUsd">,
  budget: Pick<RequestBudget, "oneStepWorst" | "firstStepWorst">,
): string | null {
  const start = budgetAllows(spent, opts.maxUsdPerQuestion, opts.maxUsd);
  if (!start.run) return `per-question ceiling does not fit: ${start.reason}`;
  if (opts.hardCeilingUsd !== undefined) {
    const g = runGuarantee(opts.maxUsd, opts.maxUsdPerQuestion, budget.oneStepWorst, budget.firstStepWorst);
    if (g.guaranteedMax > opts.hardCeilingUsd) {
      return `guaranteed maximum $${g.guaranteedMax.toFixed(2)} (cap + one step in flight) exceeds --hard-ceiling-usd $${opts.hardCeilingUsd.toFixed(2)}`;
    }
  }
  return null;
}

interface AskResult {
  ex: ChatExchange;
  priced: PricedTurn;
  /** The runner stopped this request at the per-question cost ceiling. */
  ceilingAborted: boolean;
  /** Why the whole run must stop after this request, or null. */
  stop: string | null;
}

export const COST_CEILING_REASON = "cost ceiling";

/**
 * Send one request under the per-question ceiling. While it streams, the
 * runner tails the server's per-step usage lines and keeps a running cost;
 * after each finished step it asks whether the running cost plus the worst
 * the NEXT step (already in flight: its input is the last step's input,
 * output and tool results) can cost still fits under the ceiling, and
 * aborts the request when it does not. Closing the connection aborts the
 * route's model call. A tool result over the character bound also aborts
 * (and stops the run: the bound the guarantee assumes no longer holds). A
 * step that streamed with no usage line books the one-step worst case and
 * stops the run.
 */
export async function guardedAsk(
  opts: EvalOptions,
  setup: EvalSetup,
  deps: TransportDeps,
  req: Omit<ChatRequest, "baseUrl" | "timeoutMs" | "onChunk">,
  budget: RequestBudget,
  limits: RequestLimits,
): Promise<AskResult> {
  const price = priceFor(setup.predictedModel);
  const ceiling = opts.maxUsdPerQuestion;
  const logStart = deps.logSize();
  let running = 0;
  let seenLines = 0;
  let finishSteps = 0;
  let nested = 0;
  const toolTokensByStep: number[] = [];
  let inFlightBooking: number | null = null;
  /** Usage lines seen when the ceiling tripped. */
  let linesAtTrip: number | null = null;
  let lagBreach: string | null = null;
  let lastPoll = 0;

  const follow = (conversationId: number | null): string | null => {
    if (conversationId === null || !price) return null;
    lastPoll = Date.now();
    const lines = splitTurns(parseUsageLines(deps.readLogSince(logStart)), conversationId).flatMap((t) => t.steps);
    for (let i = seenLines; i < lines.length; i++) {
      const l = lines[i];
      const p = priceFor(l.model);
      if (!p) return `the server used model ${l.model ?? "(none)"}, which has no price`;
      running += costOf(l.usage, p);
      seenLines = i + 1;
      const input = l.usage.noCache + l.usage.cacheRead + l.usage.cacheWrite;
      const next = stepWorstCase(
        input + l.usage.output + (toolTokensByStep[i] ?? 0) + STEP_INPUT_MARGIN_TOKENS,
        limits.maxOutputTokensPerStep,
        price,
      );
      if (!ceilingAllowsNextStep(running + nested * QUESTION_RESERVE_USD, next, ceiling)) {
        if (i < lines.length - 1) {
          lagBreach = `the log was read late: step ${i + 2} had already finished when step ${i + 1} tripped the ceiling`;
        }
        inFlightBooking = next;
        linesAtTrip = seenLines;
        return COST_CEILING_REASON;
      }
    }
    return null;
  };

  const onChunk = (chunk: Record<string, unknown>, conversationId: number | null): string | null => {
    if (chunk.type === "tool-output-available") {
      const chars = JSON.stringify(chunk.output ?? "").length;
      toolTokensByStep[finishSteps] = (toolTokensByStep[finishSteps] ?? 0) + Math.ceil(chars * TOOL_RESULT_TOKENS_PER_CHAR);
      if (chars > opts.toolResultChars) {
        return `a tool result of ${chars} characters exceeds the ${opts.toolResultChars}-character bound the guarantee assumes`;
      }
    }
    if (chunk.type === "tool-input-start" && typeof chunk.toolName === "string" && NESTED_AI_TOOLS.includes(chunk.toolName)) nested++;
    if (chunk.type === "finish-step") finishSteps++;
    const milestone = chunk.type === "finish-step" || chunk.type === "start-step" || chunk.type === "tool-input-start";
    if (milestone || Date.now() - lastPoll > 250) return follow(conversationId);
    return null;
  };

  const ex = await sendChat({ ...req, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, onChunk, onTick: follow }, deps);
  const ceilingAborted = ex.stoppedByRunner === COST_CEILING_REASON;
  let stop: string | null = ex.stoppedByRunner && !ceilingAborted ? `request stopped: ${ex.stoppedByRunner}` : null;
  if (ex.status === 401 || ex.status === 403) {
    stop = `the app refused the minted session (HTTP ${ex.status}); is the dev server running with DATABASE_PATH=${setup.dbPath} and APP_EXTRA_HOSTS/APP_EXTRA_ORIGINS for this host and port?`;
  }
  if (ex.conversationId !== null && !conversationExists(setup.db, ex.conversationId)) {
    stop = `conversation ${ex.conversationId} is not in ${setup.dbPath}: the server is using another database`;
  }
  const ended200 = ex.status === 200;
  // A provider error with no output at all: the call was refused (a 4xx is
  // not billed). Zero cost, and the run stops: nothing after it can work.
  const providerErrorBeforeOutput =
    ended200 && !ceilingAborted && ex.summary.errorText !== null && ex.summary.contentChunks === 0 && ex.summary.finishSteps === 0;
  if (providerErrorBeforeOutput) {
    stop = /not found|\b404\b/i.test(ex.summary.errorText ?? "")
      ? `the provider answered "${ex.summary.errorText}" before any output: the dev server is posting to a wrong URL. Start it with ANTHROPIC_BASE_URL unset (an agent shell exports it without /v1, so @ai-sdk/anthropic posts to /messages)`
      : `the provider refused the request before any output: ${ex.summary.errorText}`;
  }
  const abnormalEnd = ended200 && !ceilingAborted && !providerErrorBeforeOutput && (Boolean(ex.stoppedByRunner) || !ex.summary.done);
  let turns: TurnUsage[] = [];
  if (ex.conversationId !== null && ended200) {
    if (ceilingAborted || abnormalEnd) {
      // No turn line comes for an aborted request; the finished steps' lines are already written.
      await deps.sleep(ABORT_SETTLE_MS);
      turns = splitTurns(parseUsageLines(deps.readLogSince(logStart)), ex.conversationId);
    } else {
      turns = await waitForUsage(deps, logStart, ex.conversationId, 1);
    }
  }
  const priced = priceTurn({
    turn: turns[turns.length - 1],
    toolCalls: ex.summary.toolCalls,
    httpStatus: ex.status,
    streamedSteps: ended200 ? ex.summary.finishSteps : null,
    ceilingAbort: ceilingAborted,
    abnormalEnd,
    inFlightBooking,
    stepWorst: budget.oneStepWorst,
    expectedModel: setup.predictedModel,
    providerErrorBeforeOutput,
  });
  if (priced.unknownModel) stop = `the server used model ${priced.unknownModel}, which has no price in scripts/chat-eval/pricing.ts`;
  else if (priced.usageMissing) stop = stop ?? `usage not fully accounted (${priced.usageMissing})`;
  if (lagBreach) stop = stop ?? lagBreach;
  // The guarantee assumes the abort stops the route's model calls. If more
  // steps were logged after the trip than the one in flight, it did not:
  // every logged step is booked (above), and the run stops.
  const loggedAfterTrip = ceilingAborted && linesAtTrip !== null ? (turns[turns.length - 1]?.steps.length ?? 0) - linesAtTrip : 0;
  if (loggedAfterTrip > 1) {
    stop = stop ?? `the server ran ${loggedAfterTrip} step(s) after the abort (the stop did not reach the model call); every logged step is booked`;
  }
  return { ex, priced, ceilingAborted, stop };
}


// ─── Golden mode ─────────────────────────────────────────────────

export interface QuestionRecord {
  id: string;
  scope: ChatScope;
  question: string;
  /** scored; skipped-budget (did not fit); aborted-cost-ceiling (stopped mid-question, scored as failed); aborted (the run had stopped). */
  status: "scored" | "skipped-budget" | "aborted-cost-ceiling" | "aborted";
  score: ScoreResult | null;
  toolCalls: string[];
  steps: number | null;
  finishReason: string | null;
  usage: TokenUsage | null;
  perStep: { step: number; usage: TokenUsage }[];
  model: string | null;
  costUsd: number;
  reserveReason: string | null;
  /** The one-step worst case for this request (what a step in flight can cost). */
  oneStepWorstUsd?: number;
  /** What was booked for the step in flight when the request was stopped. */
  inFlightBookedUsd?: number | null;
  conversationId: number | null;
  elapsedMs: number | null;
  notes: string[];
  answer?: string;
  checks: Record<string, unknown>[];
  /** Characters of the answer text (kept even without --show-answers). */
  answerChars?: number;
  /** Behaviour flags of the answer (counted per run; never part of pass/fail). */
  behaviour?: BehaviourFlags;
}

export interface GoldenReport {
  mode: "golden";
  startedAt: string;
  database: string;
  baseUrl: string;
  predictedModel: string;
  priceSource: string;
  maxUsd: number;
  maxUsdPerQuestion: number;
  /** Run cap + the largest one-step worst case of any request that ran. */
  guaranteedMaxUsd: number;
  spentUsd: number;
  stoppedReason: string | null;
  unregisteredTools: string[];
  /** How many answered questions show each behaviour flag. */
  behaviourCounts?: { namesInternals: number; progressOpening: number; offerEnding: number; answered: number };
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
    maxUsdPerQuestion: opts.maxUsdPerQuestion,
    guaranteedMaxUsd: opts.maxUsd,
    spentUsd: 0,
    stoppedReason: null,
    unregisteredTools: unregistered,
    questions: [],
  };
  if (unregistered.length > 0) {
    print(`note: checks name tools the app does not register yet (they will fail): ${unregistered.join(", ")}`);
  }

  const session = mintSession(setup.db);
  const limits = requestLimits(opts.toolResultChars);
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
      const budget = requestBudget(setup, q.scope, messages, opts.page, limits, opts.maxUsdPerQuestion);
      const refusal = startRefusal(report.spentUsd, opts, budget);
      if (refusal) {
        report.questions.push({ ...base, oneStepWorstUsd: budget.oneStepWorst, reserveReason: `skipped: ${refusal}` });
        continue;
      }
      report.guaranteedMaxUsd = Math.max(
        report.guaranteedMaxUsd,
        runGuarantee(opts.maxUsd, opts.maxUsdPerQuestion, budget.oneStepWorst, budget.firstStepWorst).guaranteedMax,
      );
      const { ex, priced, ceilingAborted, stop: askStop } = await guardedAsk(
        opts,
        setup,
        deps,
        { session, chatId: randomUUID(), scope: q.scope, conversationId: null, messages, pagePath: opts.page },
        budget,
        limits,
      );
      if (askStop) stop = askStop;
      report.spentUsd += priced.costUsd;
      const errorText = ceilingAborted
        ? "aborted: cost ceiling"
        : ex.httpError ?? ex.summary.errorText ?? (ex.stoppedByRunner ? `stopped by the runner: ${ex.stoppedByRunner}` : null);

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
        status: ceilingAborted ? "aborted-cost-ceiling" : "scored",
        score,
        toolCalls: ex.summary.toolCalls,
        steps: ex.summary.stepCount ?? (ex.summary.finishSteps || null),
        finishReason: ex.summary.finishReason,
        usage: priced.usage,
        perStep: priced.steps,
        model: priced.model,
        costUsd: priced.costUsd,
        reserveReason: priced.reserveReason,
        oneStepWorstUsd: budget.oneStepWorst,
        inFlightBookedUsd: priced.inFlightBookedUsd,
        conversationId: ex.conversationId,
        elapsedMs: ex.elapsedMs,
        behaviour: behaviourFlags(ex.summary.text),
        answerChars: ex.summary.text.length,
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
  report.behaviourCounts = countBehaviour(report.questions);
  return report;
}

/** The three behaviour counts over the questions that got an answer. Pure. */
export function countBehaviour(questions: readonly Pick<QuestionRecord, "behaviour">[]): NonNullable<GoldenReport["behaviourCounts"]> {
  const answered = questions.filter((q) => q.behaviour);
  return {
    answered: answered.length,
    namesInternals: answered.filter((q) => q.behaviour!.namesInternals).length,
    progressOpening: answered.filter((q) => q.behaviour!.progressOpening).length,
    offerEnding: answered.filter((q) => q.behaviour!.offerEnding).length,
  };
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
  const b = report.behaviourCounts ?? countBehaviour(report.questions);
  const withAnswer = scored.filter((q) => q.answerChars !== undefined);
  const avgChars = withAnswer.length ? withAnswer.reduce((s, q) => s + (q.answerChars ?? 0), 0) / withAnswer.length : 0;
  const avgOutput = scored.length ? scored.reduce((s, q) => s + (q.usage?.output ?? 0), 0) / scored.length : 0;
  print(`length (the main cost lever): average answer ${Math.round(avgChars)} characters, average output ${Math.round(avgOutput)} tokens per question`);
  print(
    `behaviour (counted, not scored), of ${b.answered} answers: names a tool/field ${b.namesInternals}, ` +
      `announces work in progress ${b.progressOpening}, closes with an offer ${b.offerEnding}`,
  );
  print(`tokens: uncached input ${total.noCache}, cache write ${total.cacheWrite}, cache read ${total.cacheRead}, output ${total.output}`);
  print(
    `cost: ${usd(report.spentUsd)} of cap $${report.maxUsd.toFixed(2)} (per-question ceiling $${report.maxUsdPerQuestion.toFixed(2)}; ` +
      `guaranteed maximum $${report.guaranteedMaxUsd.toFixed(2)})  (prices: ${report.priceSource})`,
  );
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
  maxUsdPerQuestion: number;
  /** Run cap + the largest one-step worst case of any request that ran. */
  guaranteedMaxUsd: number;
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

/**
 * A run marker appended to every cache-proof message: re-running the
 * sequence within the five-minute cache life would otherwise read the WHOLE
 * earlier request back from the cache (same text), which looks like prefix
 * reuse and is not. The prefix (tools + static block) does not contain it.
 */
export function nonceText(text: string, nonce: string): string {
  return `${text} (run ${nonce})`;
}

/**
 * The cache-proof per-question ceiling when none is given: what one cold
 * first step typically costs (the request written to the cache, about 1,500
 * output tokens, the ratio measured live) plus the worst the step after it
 * can cost. It covers the one tool question (A1) in the sequence. Pure apart
 * from reading the request size.
 */
export function cacheProofCeiling(setup: EvalSetup, limits: RequestLimits, pagePath: string | undefined): number {
  const price = priceFor(setup.predictedModel);
  if (!price) return DEFAULT_MAX_USD_PER_QUESTION;
  const base = worstCaseInputTokens(previewRequest(setup.db, "all", setup.expected.today, pagePath).totalChars);
  const firstTypical = costOf({ noCache: 0, cacheWrite: base, cacheRead: 0, output: 1500 }, price);
  const next = stepWorstCase(base + 1500 + limits.toolResultTokensPerStep + STEP_INPUT_MARGIN_TOKENS, limits.maxOutputTokensPerStep, price);
  return Math.ceil((firstTypical + next) * 100) / 100;
}

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
    maxUsdPerQuestion: opts.maxUsdPerQuestion,
    guaranteedMaxUsd: opts.maxUsd,
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
  const limits = requestLimits(opts.toolResultChars);
  try {
    for (const turn of CACHE_SEQUENCE) {
      const c = conv[turn.conversation];
      const messages = [...c.messages, userMessage(randomUUID(), nonceText(turn.text, opts.nonce))];
      const budget = requestBudget(setup, scope, messages, pages[turn.page], limits, opts.maxUsdPerQuestion);
      const refusal = startRefusal(report.spentUsd, opts, budget);
      if (refusal) {
        report.stoppedReason = `${turn.label} not run: ${refusal}`;
        break;
      }
      report.guaranteedMaxUsd = Math.max(
        report.guaranteedMaxUsd,
        runGuarantee(opts.maxUsd, opts.maxUsdPerQuestion, budget.oneStepWorst, budget.firstStepWorst).guaranteedMax,
      );
      const { ex, priced, ceilingAborted, stop } = await guardedAsk(
        opts,
        setup,
        deps,
        { session, chatId: c.chatId, scope, conversationId: c.id, messages, pagePath: pages[turn.page] },
        budget,
        limits,
      );
      if (ceilingAborted && !stop) {
        report.spentUsd += priced.costUsd;
        report.turns.push({ label: turn.label, conversationId: ex.conversationId, page: pages[turn.page], steps: priced.steps, costUsd: priced.costUsd });
        report.stoppedReason = `${turn.label} aborted: cost ceiling (the conversation cannot continue)`;
        break;
      }
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
  print(`prefix estimate (tools + static block, chars/${CHARS_PER_TOKEN}): ${report.prefixTokensEstimate} tokens; measured P: ${report.prefixTokensMeasured ?? "none"}`);
  for (const v of report.verdicts) print(`verdict ${v.id.padEnd(3)} ${v.result.padEnd(9)} ${v.check}: ${v.detail}`);
  print(
    `cost: ${usd(report.spentUsd)} of cap $${report.maxUsd.toFixed(2)} (per-question ceiling $${report.maxUsdPerQuestion.toFixed(2)}; ` +
      `guaranteed maximum $${report.guaranteedMaxUsd.toFixed(2)})  (prices: ${report.priceSource})`,
  );
  if (report.stoppedReason) print(`stopped: ${report.stoppedReason}`);
}

// ─── Dry run ─────────────────────────────────────────────────────

/** Questions guaranteed to start if every question spent its whole ceiling. Pure. */
export function questionsGuaranteedToStart(count: number, cap: number, ceiling: number): number {
  let spent = 0;
  let n = 0;
  while (n < count && budgetAllows(spent, ceiling, cap).run) {
    spent += ceiling;
    n++;
  }
  return n;
}

export function dryRun(opts: EvalOptions, setup: EvalSetup, print: Print, summaryOnly = false): { guaranteedMax: number } {
  const price = priceFor(setup.predictedModel);
  const limits = requestLimits(opts.toolResultChars);
  print(`predicted chat model (resolveFeatureModel("chat") on this database): ${setup.predictedModel}`);
  print(`price source: ${PRICE_SOURCE}`);
  print(
    `rules: a request starts only if spent + per-question ceiling $${opts.maxUsdPerQuestion.toFixed(2)} <= run cap $${opts.maxUsd.toFixed(2)}; ` +
      `while it runs, it is aborted when its running cost + the worst the in-flight step can cost would pass the ceiling. ` +
      `One step in flight: input at the dearer of uncached/cache-write + ${limits.maxOutputTokensPerStep} output tokens; ` +
      `tool results bounded at ${opts.toolResultChars} characters (${limits.toolResultTokensPerStep} tokens) per step.`,
  );
  if (!price) print(`NOTE: no price for ${setup.predictedModel}; a live run will refuse to start`);
  type Planned = { label: string; scope: ChatScope; text: string; page?: string };
  let planned: Planned[];
  let typical = 0;
  if (opts.mode === "cache-proof") {
    const aapl = setup.db.prepare("SELECT id FROM securities WHERE symbol = 'AAPL'").get() as { id: number } | undefined;
    const first = aapl ? `/dashboard/security/${aapl.id}` : "/dashboard/today";
    planned = CACHE_SEQUENCE.map((t) => ({ label: t.label, scope: "all" as ChatScope, text: t.text, page: t.page === "first" ? first : "/dashboard/accounts" }));
    const p = previewRequest(setup.db, "all", setup.expected.today, first);
    print(`cache-proof plan: B1 (fresh conversation), A1 tool question, A2 same page, A3 page changed; scope all`);
    print(`request size estimate: prefix ${p.prefixTokensEstimate} tokens (${p.toolCount} tools), volatile ${p.volatileTokensEstimate} tokens`);
    print(`note: A2 and A3 carry the earlier turns, so their one-step worst case is re-computed from their real size before each starts`);
  } else {
    const qs = buildGolden(setup.expected).filter((q) => !opts.only || opts.only.includes(q.id));
    planned = qs.map((q) => ({ label: q.id, scope: q.scope, text: q.question, page: opts.page }));
    const unregistered = toolsReferenced(qs).filter((t) => !setup.expected.registeredTools.includes(t));
    for (const q of summaryOnly ? [] : qs) {
      print(`${q.id} [${q.scope}] ${q.question}`);
      for (const c of q.checks) print(`     ${c.kind}: ${c.label}`);
      for (const n of q.notes) print(`     note: ${n}`);
    }
    if (unregistered.length > 0) print(`tools named in checks but not registered today: ${unregistered.join(", ")}`);
  }
  let oneStepWorst = 0;
  let firstStepWorst = 0;
  for (const r of planned) {
    const b = requestBudget(setup, r.scope, [userMessage("dry", r.text)], r.page, limits, opts.maxUsdPerQuestion);
    oneStepWorst = Math.max(oneStepWorst, b.oneStepWorst);
    firstStepWorst = Math.max(firstStepWorst, b.firstStepWorst);
    if (price) {
      const s = previewRequest(setup.db, r.scope, setup.expected.today, r.page);
      const tokens = s.prefixTokensEstimate + s.volatileTokensEstimate;
      typical += costOf({ noCache: 2000, cacheWrite: tokens, cacheRead: tokens * 4, output: 3000 }, price);
    }
  }
  const g = runGuarantee(opts.maxUsd, opts.maxUsdPerQuestion, oneStepWorst, firstStepWorst);
  const fit = questionsGuaranteedToStart(planned.length, opts.maxUsd, opts.maxUsdPerQuestion);
  if (opts.mode === "cache-proof" && price) {
    // Typical spend per request: the first writes the whole request; the
    // rest read the cached prefix and write their own tail. Each request
    // must pass the start rule (spent + ceiling <= cap).
    const base = worstCaseInputTokens(previewRequest(setup.db, "all", setup.expected.today, planned[0]?.page).totalChars);
    let spent = 0;
    let allFit = true;
    let capNeeded = 0;
    planned.forEach((r, i) => {
      capNeeded = Math.max(capNeeded, spent + opts.maxUsdPerQuestion);
      const starts = budgetAllows(spent, opts.maxUsdPerQuestion, opts.maxUsd).run;
      if (!starts) allFit = false;
      const steps = r.label === "A1" ? 2 : 1;
      const one = i === 0
        ? costOf({ noCache: 0, cacheWrite: base, cacheRead: 0, output: 1500 }, price)
        : costOf({ noCache: 0, cacheWrite: 3000, cacheRead: base, output: 1500 }, price);
      const cost = one + (steps - 1) * costOf({ noCache: 0, cacheWrite: 3000, cacheRead: base, output: 1500 }, price);
      print(`  ${r.label}: typical $${cost.toFixed(3)}; starts: ${starts ? "yes" : "NO"} (spent $${spent.toFixed(3)} + ceiling $${opts.maxUsdPerQuestion.toFixed(2)} vs cap $${opts.maxUsd.toFixed(2)})`);
      spent += cost;
    });
    print(`  ALL ${planned.length} requests fit under the run cap: ${allFit ? "YES" : "NO"}; run cap needed for all to start: $${capNeeded.toFixed(2)}`);
  }
  print(`SUMMARY mode=${opts.mode} requests=${planned.length}`);
  print(`  per-question ceiling: $${opts.maxUsdPerQuestion.toFixed(2)}`);
  print(`  requests guaranteed to start (each spending its whole ceiling): ${fit} of ${planned.length}; typical total if none hits the ceiling: $${typical.toFixed(2)}`);
  print(`  one-step worst case (largest request, first-turn size): $${oneStepWorst.toFixed(2)}; first step: $${firstStepWorst.toFixed(2)}`);
  print(`  guaranteed maximum spend: $${g.guaranteedMax.toFixed(2)} (run cap $${opts.maxUsd.toFixed(2)} + one step in flight${g.guaranteedMax > opts.maxUsd + oneStepWorst + 1e-9 ? " + first-step excess" : ""})`);
  if (opts.hardCeilingUsd !== undefined) {
    print(`  --hard-ceiling-usd $${opts.hardCeilingUsd.toFixed(2)}: ${g.guaranteedMax <= opts.hardCeilingUsd ? "OK" : "WOULD REFUSE"}`);
  }
  return { guaranteedMax: g.guaranteedMax };
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
    if (opts.mode === "cache-proof" && !opts.maxUsdPerQuestionExplicit) {
      const aapl = setup.db.prepare("SELECT id FROM securities WHERE symbol = 'AAPL'").get() as { id: number } | undefined;
      opts.maxUsdPerQuestion = cacheProofCeiling(setup, requestLimits(opts.toolResultChars), aapl ? `/dashboard/security/${aapl.id}` : undefined);
      print(`cache-proof per-question ceiling (derived): $${opts.maxUsdPerQuestion.toFixed(2)}`);
    }
    // The app's market snapshot must read this database locally: a fallback
    // to the outside quote source sends the fixture's symbols out and makes
    // the "what moved today" question untestable.
    const snapshotProblem = await localSnapshotCheck(setup.db, setup.expected.today);
    if (opts.dryRun) {
      print(`market snapshot source check: ${snapshotProblem ?? "local (no outside quote request)"}`);
      dryRun(opts, setup, print);
      return 0;
    }
    if (snapshotProblem) {
      print(`run-golden: refusing to run: ${snapshotProblem}. Rebuild the fixture for today (build-eval-db.ts).`);
      return 2;
    }
    if (!priceFor(setup.predictedModel)) {
      print(`run-golden: refusing to run: model ${setup.predictedModel} has no price in scripts/chat-eval/pricing.ts (add it with its source and date)`);
      return 2;
    }
    const out = opts.out ?? defaultOut();
    const plan = dryRun(opts, setup, print, true);
    if (opts.hardCeilingUsd !== undefined && plan.guaranteedMax > opts.hardCeilingUsd) {
      print(`run-golden: refusing to start: guaranteed maximum $${plan.guaranteedMax.toFixed(2)} exceeds --hard-ceiling-usd $${opts.hardCeilingUsd.toFixed(2)}`);
      return 2;
    }
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
