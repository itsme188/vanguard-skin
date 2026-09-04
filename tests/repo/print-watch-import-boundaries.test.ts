/**
 * Repo guard: the print-watch client/server import boundary (R-D20, R-D22).
 *
 * (a) A `"use client"` component is compiled into the BROWSER bundle, so every
 *     module it imports is too. Most of `lib/print-watch` is server code —
 *     `callouts.ts` reads files (node:fs) and shells out to poppler through
 *     `./pdf` (node:child_process); `first-pass-prompt.ts` pulls node:crypto,
 *     the AI SDK, DB queries and the digest chain. Importing either from the
 *     panel did not fail a test, it failed `next build` outright ("the chunking
 *     context does not support external modules"). Only four modules in that
 *     directory are safe to cross the line — the two type modules, the pure
 *     reconciler, and the client-safe formatter — and each of those must itself
 *     stay free of server dependencies, or the boundary moves under us again.
 *
 * (b) Slice D never imports `lib/digest` (R-D22): the read's prompt composes
 *     its own intel view from the pure resolver plus the intel query, so the
 *     watcher does not drag the email/AI chain into memory at import time.
 *
 * Both halves are a source scan — import lines are unambiguous, so no parsing
 * is needed beyond a line regex.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const PRINT_WATCH_DIR = path.join(REPO, "lib", "print-watch");

/** The ONLY `lib/print-watch` modules a `"use client"` file may import. */
const CLIENT_SAFE = ["types", "first-pass-types", "reconcile", "first-pass-format"] as const;

/** What a client-safe module may never reach for. */
const SERVER_ONLY_PREFIXES = [
  "node:",
  "better-sqlite3",
  "@/lib/db",
  "@/lib/ai/",
  "@/lib/queries/",
  "@/lib/digest/",
  "@/lib/earnings/",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every `from "<spec>"` on an import/export-from line, with its line number. */
function importSpecs(source: string): Array<{ spec: string; line: number }> {
  const out: Array<{ spec: string; line: number }> = [];
  const lines = source.split("\n");
  lines.forEach((text, i) => {
    const m = text.match(/^\s*(?:import|export)\b[^"']*from\s*["']([^"']+)["']/) ?? text.match(/^\s*import\s*["']([^"']+)["']/);
    if (m) out.push({ spec: m[1], line: i + 1 });
  });
  return out;
}

function isUseClient(source: string): boolean {
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    return /^["']use client["']/.test(line);
  }
  return false;
}

const rel = (file: string) => path.relative(REPO, file);

describe("print-watch import boundaries", () => {
  it("a \"use client\" component imports only the client-safe print-watch modules", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(REPO, "app"))) {
      const source = fs.readFileSync(file, "utf8");
      if (!isUseClient(source)) continue;
      for (const { spec, line } of importSpecs(source)) {
        const m = spec.match(/^@\/lib\/print-watch\/(.+)$/);
        if (!m) continue;
        if (!CLIENT_SAFE.includes(m[1] as (typeof CLIENT_SAFE)[number])) {
          offenders.push(`${rel(file)}:${line} imports @/lib/print-watch/${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("each client-safe module is itself free of server dependencies", () => {
    const offenders: string[] = [];
    for (const mod of CLIENT_SAFE) {
      const file = path.join(PRINT_WATCH_DIR, `${mod}.ts`);
      const source = fs.readFileSync(file, "utf8");
      for (const { spec, line } of importSpecs(source)) {
        if (spec === "ai" || SERVER_ONLY_PREFIXES.some((p) => spec === p || spec.startsWith(p))) {
          offenders.push(`${rel(file)}:${line} imports ${spec}`);
          continue;
        }
        // A sibling outside the allowlist would drag the server stack in
        // transitively, which is exactly how the build broke.
        const sibling = spec.match(/^\.\/(.+)$/);
        if (sibling && !CLIENT_SAFE.includes(sibling[1] as (typeof CLIENT_SAFE)[number])) {
          offenders.push(`${rel(file)}:${line} imports sibling ./${sibling[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no lib/print-watch module imports @/lib/digest (R-D22)", () => {
    const offenders: string[] = [];
    for (const file of walk(PRINT_WATCH_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      for (const { spec, line } of importSpecs(source)) {
        if (spec.startsWith("@/lib/digest/") || spec === "@/lib/digest") {
          offenders.push(`${rel(file)}:${line} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
