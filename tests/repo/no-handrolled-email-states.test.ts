/**
 * Static regression guard for the `earnings_emails` state vocabulary
 * (live print v2, slice E — migration 092).
 *
 * `lib/earnings/email-states.ts` is the single source of truth for the five
 * values `earnings_emails.error` can hold. This test scans the SERVER-SIDE
 * readers for the four sentinel STRING LITERALS and fails on every occurrence
 * that is not (a) inside the vocabulary module itself, (b) inside a migration,
 * or (c) an explicitly justified allowlist entry.
 *
 * ── The MATCH UNIT (controller ruling, slice E) ─────────────────────────────
 * One of the four sentinels — `sending` — is also an ordinary English
 * participle, and this tree is full of prose containing it. A naive substring
 * scan would flag `"…before sending."` and `` `sending ${phase}` ``, which are
 * not states at all. So an occurrence is recorded only when a string/template
 * literal's content is one of these two shapes:
 *
 *   1. WHOLE-LITERAL — the literal's entire content is exactly a sentinel:
 *      `"in_progress"`, `'sent-by-cloud'`, a `reason?: "in_progress"` type
 *      literal, a `row.error === "sending"` comparison. This is the shape a
 *      hand-rolled JS-side predicate takes.
 *   2. SQL-LITERAL — the content contains the sentinel wrapped in SINGLE
 *      QUOTES (`'in_progress'`) somewhere inside a bigger string, which in
 *      this codebase means a SQL literal inside a query. This is the shape a
 *      hand-rolled SQL predicate takes.
 *
 * Prose is neither, and is silently (correctly) ignored. Comments are excluded
 * from the scan outright by the same lexer the latest-holdings guard uses —
 * this tree is full of comments explaining why a given site does NOT hand-roll
 * the predicate, and none of it needs an allowlist entry.
 *
 * ── SCOPE (R-E13 / contract §1) ─────────────────────────────────────────────
 * The guard covers the SERVER-SIDE readers of the column only: `lib/**` and
 * `app/api/**`. `app/dashboard/**` is exempt BY DESIGN — UI files carry these
 * words as TypeScript union members and display keys (EmailSendState,
 * PreviewStage, RecapStage), never as SQL, and slice F adds more of them in
 * new client files. Making the UI import a constant to satisfy a guard would
 * be the tail wagging the dog; F therefore needs no allowlist entry and no
 * client-safe import. The Worker keeps its own literal set behind the parity
 * test in tests/workers/fallback-earnings-live-claims.test.ts.
 *
 * Design copied from tests/repo/no-handrolled-latest-holdings.test.ts: no
 * fast-glob (undeclared dep), per-OCCURRENCE validation never whole-file (a
 * bad predicate added to an already-allowlisted file still fails), and a
 * per-occurrence anchor-substring allowlist with a justification field.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameLocal, "../..");

const SENTINELS = ["in_progress", "sending", "sent-by-cloud", "delivery_unknown"] as const;

const SCAN_ROOTS: Array<{ dir: string; extRe: RegExp }> = [
  { dir: "lib", extRe: /\.ts$/ },
  { dir: "app/api", extRe: /\.ts$/ },
];
const EXCLUDED_SEGMENTS = new Set([
  "tests",
  "node_modules",
  ".next",
  ".superpowers",
  "docs",
  ".git",
]);
const EXEMPT_FILES = new Set(["lib/earnings/email-states.ts"]);
const EXEMPT_PREFIXES = ["lib/db/migrations/"];

// ─── File collection ──────────────────────────────────────────────────────

function collectFiles(dir: string, extRe: RegExp, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, extRe, out);
    } else if (entry.isFile() && extRe.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectTargetFiles(): string[] {
  const out: string[] = [];
  for (const { dir, extRe } of SCAN_ROOTS) {
    collectFiles(path.join(REPO_ROOT, dir), extRe, out);
  }
  return out;
}

function isExempt(relFile: string): boolean {
  return EXEMPT_FILES.has(relFile) || EXEMPT_PREFIXES.some((p) => relFile.startsWith(p));
}

// ─── Tiny lexer: code / comment / string / template regions ───────────────
// Enough JS/TS tokenizing to find sentinel text ONLY inside real
// string/template content — never inside a // or /* */ comment — and to give
// each match a precisely-bounded enclosing literal as its validation context.
// `${...}` interpolation is tracked only for brace depth (this codebase's SQL
// template literals interpolate identifiers/calls, never nested strings).
// Verbatim in structure from tests/repo/no-handrolled-latest-holdings.test.ts.

interface Segment {
  type: "code" | "comment" | "string" | "template";
  start: number;
  end: number;
}

function tokenize(src: string): Segment[] {
  const segments: Segment[] = [];
  const n = src.length;
  let i = 0;
  let codeStart = 0;

  const flushCode = (end: number) => {
    if (end > codeStart) segments.push({ type: "code", start: codeStart, end });
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "/" && c2 === "/") {
      flushCode(i);
      const start = i;
      while (i < n && src[i] !== "\n") i++;
      segments.push({ type: "comment", start, end: i });
      codeStart = i;
      continue;
    }

    if (c === "/" && c2 === "*") {
      flushCode(i);
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      segments.push({ type: "comment", start, end: i });
      codeStart = i;
      continue;
    }

    if (c === '"' || c === "'") {
      flushCode(i);
      const quote = c;
      const start = i;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i = Math.min(n, i + 1);
      segments.push({ type: "string", start, end: i });
      codeStart = i;
      continue;
    }

    if (c === "`") {
      flushCode(i);
      const start = i;
      i++;
      let depth = 0; // ${ ... } nesting depth while inside interpolation
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (depth === 0 && src[i] === "`") {
          i++;
          break;
        }
        if (depth === 0 && src[i] === "$" && src[i + 1] === "{") {
          depth = 1;
          i += 2;
          continue;
        }
        if (depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
          continue;
        }
        i++;
      }
      segments.push({ type: "template", start, end: i });
      codeStart = i;
      continue;
    }

    i++;
  }
  flushCode(n);
  return segments;
}

// ─── The two flagged shapes ───────────────────────────────────────────────

type Shape = "whole-literal" | "sql-literal";

interface Occurrence {
  file: string; // repo-relative, forward-slash
  line: number;
  sentinel: string;
  shape: Shape;
  context: string; // the enclosing string/template literal text — allowlist match unit
}

/** Strip the enclosing quote/backtick characters from a lexed literal. */
function literalContent(segmentText: string): string {
  return segmentText.slice(1, segmentText.length - 1);
}

function shapeOf(content: string, sentinel: string): Shape | null {
  if (content.trim() === sentinel) return "whole-literal";
  if (content.includes(`'${sentinel}'`)) return "sql-literal";
  return null;
}

function findOccurrences(relFile: string, src: string): Occurrence[] {
  const segments = tokenize(src);
  const out: Occurrence[] = [];

  for (const seg of segments) {
    if (seg.type !== "string" && seg.type !== "template") continue;
    const text = src.slice(seg.start, seg.end);
    const content = literalContent(text);
    for (const sentinel of SENTINELS) {
      const shape = shapeOf(content, sentinel);
      if (!shape) continue;
      out.push({
        file: relFile,
        line: src.slice(0, seg.start).split("\n").length,
        sentinel,
        shape,
        context: text,
      });
    }
  }
  return out;
}

function scanRepo(files: string[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const abs of files) {
    const relFile = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
    if (isExempt(relFile)) continue;
    out.push(...findOccurrences(relFile, fs.readFileSync(abs, "utf8")));
  }
  return out;
}

function collectOccurrences(): Occurrence[] {
  return scanRepo(collectTargetFiles());
}

// ─── Allowlist ────────────────────────────────────────────────────────────

interface AllowlistEntry {
  file: string;
  anchor: string;
  justification: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const ALLOWLIST: AllowlistEntry[] = [
  // EMPTY, and meant to stay that way — that is the whole point of the guard.
  // The one temporary entry (lib/calendar/email-sweep.ts, whose blocked-recap
  // query spelled the live-claim exclusion by hand) went away in Task 5 when
  // that predicate became notLiveClaimSql("ep.error") and learned 'sending'
  // along with the rest of the send service. Any new entry needs a
  // per-occurrence anchor and a real justification, and the "no dead
  // exemptions" test below deletes it again the moment it stops matching.
];

function isAllowlisted(occ: Occurrence): boolean {
  const normContext = norm(occ.context);
  return ALLOWLIST.some(
    (entry) => entry.file === occ.file && normContext.includes(norm(entry.anchor)),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("earnings_emails state sentinels are single-sourced", () => {
  it("no lib/ or app/api/ file hand-rolls a sentinel outside the allowlist", () => {
    const files = collectTargetFiles();
    // Sanity: the walk is actually finding files (guards against a typo'd
    // root silently turning this test into a no-op).
    expect(files.length).toBeGreaterThan(100);

    const offenders = collectOccurrences().filter((o) => !isAllowlisted(o));
    expect(
      offenders.map((o) => `${o.file}:${o.line} [${o.shape}] ${o.context.slice(0, 120)}`),
      "use lib/earnings/email-states.ts (isLiveClaim / isDelivered / isDeliveredStrict / " +
        "notLiveClaimSql / deliveredSql / sendStateFor / sentByFor, or the IN_PROGRESS / " +
        "SENDING / SENT_BY_CLOUD / DELIVERY_UNKNOWN constants), or add a justified " +
        "per-occurrence entry to ALLOWLIST in this file",
    ).toEqual([]);
  });

  it("every allowlist entry still matches something (no dead exemptions)", () => {
    const all = collectOccurrences();
    for (const entry of ALLOWLIST) {
      expect(
        all.some((o) => o.file === entry.file && norm(o.context).includes(norm(entry.anchor))),
        `dead allowlist entry: ${entry.file} / ${entry.anchor}`,
      ).toBe(true);
    }
  });

  it("every allowlist entry carries a justification", () => {
    for (const entry of ALLOWLIST) expect(entry.justification.length).toBeGreaterThan(40);
  });

  it("the lexer is doing real work — prose mentions far outnumber flagged occurrences", () => {
    // Proves the match unit is not degenerate: the tree genuinely contains
    // many lines that MENTION a sentinel (comments explaining the five-value
    // convention, the word "sending" as an English participle), and almost
    // none of them are occurrences.
    const files = collectTargetFiles();
    let textualLines = 0;
    for (const abs of files) {
      for (const line of fs.readFileSync(abs, "utf8").split("\n")) {
        if (SENTINELS.some((s) => line.includes(s))) textualLines += 1;
      }
    }
    expect(textualLines).toBeGreaterThan(20);
    expect(collectOccurrences().length).toBeLessThan(textualLines);
  });

  // ─── Self-tests: the scanner's own behaviour, on planted source ─────────

  it("self-test: a hand-rolled SQL predicate is flagged", () => {
    const bad = `
      const rows = db.prepare(\`
        SELECT id FROM earnings_emails
         WHERE event_id = ? AND (error IS NULL OR error != 'in_progress')
      \`).all(eventId);
    `;
    const occs = findOccurrences("lib/queries/planted-bad.ts", bad);
    expect(occs).toHaveLength(1);
    expect(occs[0]).toMatchObject({ sentinel: "in_progress", shape: "sql-literal" });
    expect(isAllowlisted(occs[0])).toBe(false);
  });

  it("self-test: a hand-rolled JS comparison is flagged", () => {
    const bad = `export const isCloud = (e: string | null) => e === "sent-by-cloud";`;
    const occs = findOccurrences("lib/earnings/planted-bad.ts", bad);
    expect(occs).toHaveLength(1);
    expect(occs[0]).toMatchObject({ sentinel: "sent-by-cloud", shape: "whole-literal" });
  });

  it("self-test: prose containing the participle 'sending' is NOT flagged", () => {
    const fine = `
      const msg = "The accepted pair changed — promote it again before sending.";
      const label = \`sending \${phase} for \${symbol}\`;
      const other = "resending an ever-growing transcript";
    `;
    expect(findOccurrences("lib/earnings/planted-prose.ts", fine)).toEqual([]);
  });

  it("self-test: comments merely mentioning a sentinel are never scanned", () => {
    const commentOnly = `
      // 'in_progress' is a LIVE claim and every reader already excludes it;
      // 'sent-by-cloud' rows DO return, and 'delivery_unknown' rows carry prose.
      /**
       * A live 'sending' row means the provider call is on the wire.
       */
      export function fine() {
        return 1;
      }
    `;
    expect(findOccurrences("lib/anything.ts", commentOnly)).toEqual([]);
  });

  it("self-test: interpolating the constant is clean, hand-writing the literal is not", () => {
    const good = `
      const sql = \`CASE WHEN ee.error = '\${SENT_BY_CLOUD}' THEN 1 ELSE 0 END\`;
    `;
    expect(findOccurrences("lib/queries/planted-good.ts", good)).toEqual([]);

    const bad = `
      const sql = \`CASE WHEN ee.error = 'sent-by-cloud' THEN 1 ELSE 0 END\`;
    `;
    expect(findOccurrences("lib/queries/planted-bad2.ts", bad)).toHaveLength(1);
  });

  it("self-test: allowlisting is per-occurrence, never file-wide", () => {
    // A DIFFERENT hand-rolled predicate planted in the one allowlisted file
    // still fails: its enclosing literal does not contain the entry's anchor.
    const bad = `
      const rows = db.prepare(\`
        SELECT id FROM earnings_emails WHERE error = 'sending'
      \`).all();
    `;
    const occs = findOccurrences("lib/calendar/email-sweep.ts", bad);
    expect(occs).toHaveLength(1);
    expect(isAllowlisted(occs[0])).toBe(false);
  });

  it("self-test: the vocabulary module and the migrations are exempt", () => {
    expect(isExempt("lib/earnings/email-states.ts")).toBe(true);
    expect(isExempt("lib/db/migrations/092_earnings_email_delivery_states.sql")).toBe(true);
    expect(isExempt("lib/queries/earnings-emails.ts")).toBe(false);
  });

  it("self-test: app/dashboard is out of scope by design (R-E13)", () => {
    const roots = SCAN_ROOTS.map((r) => r.dir);
    expect(roots).toEqual(["lib", "app/api"]);
    expect(collectTargetFiles().some((f) => f.includes("/app/dashboard/"))).toBe(false);
  });
});
