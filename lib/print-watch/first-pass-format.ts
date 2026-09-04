// Client-safe formatting + sanitisation for the first-pass read (R-D20).
//
// The panel is a `"use client"` component, so anything it imports is compiled
// into the browser bundle. `callouts.ts` (node:fs, ./pdf → node:child_process)
// and `first-pass-prompt.ts` (node:crypto, the AI SDK, queries, the digest
// chain) are server modules; importing either from the panel broke
// `next build` outright ("the chunking context does not support external
// modules"). The two functions the panel actually needs are pure string/number
// work, so they live here instead, in a module with NO imports at all beyond a
// type.
//
// This module must stay dependency-free: `tests/repo/print-watch-import-boundaries.test.ts`
// pins the rule (it is one of the four `lib/print-watch` modules a client
// component may import, and none of the four may reach for node built-ins, the
// database, the AI SDK, queries, the digest chain or a heavier sibling).
//
// `callouts.ts` and `first-pass-prompt.ts` re-export these names, so every
// existing server caller and test import keeps working unchanged.
import type { CalloutUnit } from "./first-pass-types";

export function formatValue(value: number, unit: CalloutUnit): string {
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "per_share") return `$${value.toFixed(2)}`;
  if (unit === "count") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

// Control characters are stripped with a class built from char codes: never
// type a backslash-u escape into this file (see memory "Unicode-escape write hazard").
const CONTROL_CLASS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");
export const INSTRUCTION_LIKE: RegExp[] = [
  /^\s*(system|assistant|user)\s*:/i,
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier)\b.{0,30}\b(instruction|prompt|rule)/i,
  /\byou are (now|an? )\b/i,
  /^\s*(#{1,6}\s|<\||\[INST\])/,
  /\bas an ai\b/i,
];
const LINE_MAX = 600;
export function sanitizeProseLines(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = []; const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.replace(CONTROL_CLASS, "").replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
    if (!s || seen.has(s) || INSTRUCTION_LIKE.some((re) => re.test(s))) continue;
    seen.add(s); out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
