/**
 * Chat evaluation scorer: a pure function from (answer, checks) to a verdict.
 *
 * Unit-tested in tests/scripts/chat-eval-scorer.test.ts. No database, no
 * network, no clock. The only import is the turn-outcome sentences, a
 * client-safe module with no imports of its own, so the "cut-off" wording is
 * single-sourced with the route that writes it.
 *
 * Rules:
 * - An answer with an error, an empty text, a cut-off finish (`tool-calls`,
 *   `length`, `content-filter`, `error`) or text that is one of the route's
 *   empty-turn sentences ALWAYS fails, whatever its checks say.
 * - `contains` / `notContains`: a string is a case-insensitive substring; a
 *   RegExp is matched case-insensitively (the `i` flag is added).
 * - `number` / `notNumber`: every number in the prose is parsed (thousands
 *   separators, `$` and other currency signs, `%`, K/M/B suffixes, a leading
 *   minus or a Unicode minus, parentheses for a negative) and compared with
 *   the expected value within a tolerance. ISO dates and clock times are
 *   removed first so their digits never count as figures. By default the
 *   comparison is on absolute values, because prose writes "a loss of $500"
 *   as often as "-$500"; `signed: true` compares signs too.
 * - `calledTool` / `notCalledTool`: the tool names recorded from the stream.
 *   `calledTool` with a list passes when any one of them was called.
 * - `minLength`: the trimmed text has at least that many characters.
 */

import { CUT_OFF_SENTENCE, OUTPUT_LIMIT_SENTENCE, CONTENT_FILTER_SENTENCE } from "../../lib/chat/turn-outcome";

export type TextPattern = string | RegExp;

export interface NumberTolerance {
  /** Absolute tolerance in the value's own unit. */
  absTol?: number;
  /** Relative tolerance as a fraction of |value| (0.01 = 1%). */
  relTol?: number;
  /** Compare signs too (default false: absolute values). */
  signed?: boolean;
  /** Only count numbers written with a percent sign. */
  percentOnly?: boolean;
}

export type Check =
  | { kind: "contains"; label: string; pattern: TextPattern }
  | { kind: "notContains"; label: string; pattern: TextPattern }
  | ({ kind: "number"; label: string; value: number } & NumberTolerance)
  | ({ kind: "notNumber"; label: string; value: number } & NumberTolerance)
  | { kind: "calledTool"; label: string; tool: string | readonly string[] }
  | { kind: "notCalledTool"; label: string; tool: string }
  | { kind: "minLength"; label: string; chars: number };

export interface EvalAnswer {
  /** The streamed answer text, every step's text joined. */
  text: string;
  /** Tool names called during the turn, in call order (repeats kept). */
  toolCalls: readonly string[];
  /** The stream's finish reason, or null when none arrived. */
  finishReason: string | null;
  /** A transport, HTTP or stream error, or null. */
  error?: string | null;
}

export interface CheckResult {
  label: string;
  kind: Check["kind"];
  pass: boolean;
  detail: string;
}

export interface ScoreResult {
  pass: boolean;
  /** Why the answer failed before any check ran, or null. */
  gate: string | null;
  checks: CheckResult[];
  passed: number;
  total: number;
}

/** Finish reasons that mean the answer was cut off or never finished. */
export const CUT_OFF_FINISH_REASONS: readonly string[] = ["tool-calls", "length", "content-filter", "error"];

export const EMPTY_TURN_SENTENCES: readonly string[] = [CUT_OFF_SENTENCE, OUTPUT_LIMIT_SENTENCE, CONTENT_FILTER_SENTENCE];

// ─── Numbers ─────────────────────────────────────────────────────

export interface ParsedNumber {
  value: number;
  percent: boolean;
  raw: string;
}

const MINUS_CHARS = new Set(["-", "−"]);
const SUFFIX: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, bn: 1e9 };

/**
 * Every number written in `text`. Dates (`2026-03-27`, `03/27/2026`) and
 * clock times (`16:00`) are blanked first. A `-` directly after a letter or
 * digit is a hyphen, not a sign (`S&P-500`, `10-K`).
 */
export function parseNumbers(text: string): ParsedNumber[] {
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => " ".repeat(m.length))
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, (m) => " ".repeat(m.length))
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (m) => " ".repeat(m.length));

  const re =
    /(\()?([-+−])?\s?(?:[$€£¥]|[A-Z]{3}\s)?\s?([-+−])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:\s?(%)|(bn|[kKMB])(?![A-Za-z]))?(\))?/g;
  const out: ParsedNumber[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const [whole, open, sign1, sign2, digits, pct, suffix, close] = m;
    const start = m.index + (open ? 1 : 0);
    const prev = start > 0 ? cleaned[start - 1] : "";
    let sign = sign1 ?? sign2 ?? "";
    // A minus glued to a word or a number on its left is a hyphen.
    if (sign1 && MINUS_CHARS.has(sign1) && /[A-Za-z0-9]/.test(prev)) sign = "";
    // A digit glued to a letter on its left is part of a token (Q1, 10-K, ZZZZ1).
    const digitsStart = m.index + whole.indexOf(digits);
    const beforeDigits = digitsStart > 0 ? cleaned[digitsStart - 1] : "";
    if (!sign1 && !sign2 && /[A-Za-z]/.test(beforeDigits)) continue;
    let value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (suffix) value *= SUFFIX[suffix] ?? 1;
    const negative = MINUS_CHARS.has(sign) || (open === "(" && close === ")");
    if (negative) value = -value;
    out.push({ value, percent: pct === "%", raw: whole.trim() });
  }
  return out;
}

function tolerance(value: number, t: NumberTolerance): number {
  const abs = t.absTol ?? 0;
  const rel = t.relTol ?? (t.absTol === undefined ? 0.01 : 0);
  return Math.max(abs, rel * Math.abs(value), 1e-9);
}

/** The first parsed number that matches `value` within tolerance, or null. */
export function findNumber(text: string, value: number, t: NumberTolerance = {}): ParsedNumber | null {
  const tol = tolerance(value, t);
  for (const n of parseNumbers(text)) {
    if (t.percentOnly && !n.percent) continue;
    const a = t.signed ? n.value : Math.abs(n.value);
    const b = t.signed ? value : Math.abs(value);
    if (Math.abs(a - b) <= tol) return n;
  }
  return null;
}

// ─── Text ────────────────────────────────────────────────────────

function toRegExp(pattern: TextPattern): RegExp {
  if (typeof pattern === "string") {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const flags = pattern.flags.includes("i") ? pattern.flags : pattern.flags + "i";
  return new RegExp(pattern.source, flags.replace("g", ""));
}

export function patternText(pattern: TextPattern): string {
  return typeof pattern === "string" ? JSON.stringify(pattern) : pattern.toString();
}

export function matchesPattern(text: string, pattern: TextPattern): string | null {
  const m = toRegExp(pattern).exec(text);
  return m ? m[0] : null;
}

// ─── Gate and checks ─────────────────────────────────────────────

/** Why an answer fails before its checks, or null when it may be scored. */
export function answerGate(answer: EvalAnswer): string | null {
  if (answer.error) return `error: ${answer.error.slice(0, 160)}`;
  const text = (answer.text ?? "").trim();
  if (text.length === 0) return "empty answer";
  if (answer.finishReason && CUT_OFF_FINISH_REASONS.includes(answer.finishReason)) {
    return `cut off (finish reason ${answer.finishReason})`;
  }
  if (EMPTY_TURN_SENTENCES.some((s) => text === s.trim())) return "answer is the empty-turn sentence";
  if (text.includes(CUT_OFF_SENTENCE)) return "answer carries the cut-off sentence";
  return null;
}

function toolList(tool: string | readonly string[]): readonly string[] {
  return typeof tool === "string" ? [tool] : tool;
}

export function runCheck(answer: EvalAnswer, check: Check): CheckResult {
  const text = answer.text ?? "";
  const base = { label: check.label, kind: check.kind };
  switch (check.kind) {
    case "contains": {
      const hit = matchesPattern(text, check.pattern);
      return { ...base, pass: hit !== null, detail: hit !== null ? `found ${JSON.stringify(hit)}` : `missing ${patternText(check.pattern)}` };
    }
    case "notContains": {
      const hit = matchesPattern(text, check.pattern);
      return { ...base, pass: hit === null, detail: hit === null ? "absent" : `found forbidden ${JSON.stringify(hit)}` };
    }
    case "number": {
      const hit = findNumber(text, check.value, check);
      return {
        ...base,
        pass: hit !== null,
        detail: hit ? `found ${hit.raw}` : `no figure within ±${tolerance(check.value, check).toPrecision(3)} of the expected value`,
      };
    }
    case "notNumber": {
      const hit = findNumber(text, check.value, check);
      return { ...base, pass: hit === null, detail: hit ? `found forbidden figure ${hit.raw}` : "absent" };
    }
    case "calledTool": {
      const wanted = toolList(check.tool);
      const hit = wanted.find((t) => answer.toolCalls.includes(t));
      return { ...base, pass: hit !== undefined, detail: hit ? `called ${hit}` : `none of ${wanted.join(", ")} called` };
    }
    case "notCalledTool": {
      const called = answer.toolCalls.includes(check.tool);
      return { ...base, pass: !called, detail: called ? `called ${check.tool}` : "not called" };
    }
    case "minLength": {
      const n = text.trim().length;
      return { ...base, pass: n >= check.chars, detail: `${n} characters (need ${check.chars})` };
    }
  }
}

/** Score one answer. Pure. */
export function scoreAnswer(answer: EvalAnswer, checks: readonly Check[]): ScoreResult {
  const gate = answerGate(answer);
  const results = checks.map((c) => runCheck(answer, c));
  const passed = results.filter((r) => r.pass).length;
  return {
    pass: gate === null && passed === results.length,
    gate,
    checks: results,
    passed: gate === null ? passed : 0,
    total: results.length,
  };
}

/** A check in JSON-safe form (a RegExp becomes its source text). */
export function serializeCheck(check: Check): Record<string, unknown> {
  const out: Record<string, unknown> = { ...check };
  if ("pattern" in check) out.pattern = patternText(check.pattern);
  return out;
}
