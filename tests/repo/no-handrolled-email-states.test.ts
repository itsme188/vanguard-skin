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
 *
 * ── ONE DELIBERATE DIVERGENCE FROM THAT ANCESTOR (R-E-C7) ──────────────────
 * The inherited lexer has no REGEX-LITERAL state, which makes it unsound in
 * the false-negative direction: an unpaired quote inside a regex (`/don't/`,
 * and this tree really contains several) opens a phantom string that swallows
 * every following predicate to the next matching quote. The Task 2 review
 * demonstrated it — two planted bad predicates hidden, guard reported PASSED.
 * `tokenize` below therefore lexes regex literals too. The latest-holdings
 * guard still carries the hole; closing it there belongs to that slice's
 * owner and is filed in docs/plans/TODO.md, NOT fixed here.
 *
 * KNOWN RESIDUAL of that divergence (review Minor, recorded not chased): the
 * regex-vs-division heuristic decides on the previous significant token and
 * `)` CAN end an expression, so a regex written directly after one — as in
 * `if (c) /don't/.test(s)` — is still read as division and its body lexed as
 * code, re-opening exactly the phantom-string blindness above; no token
 * lookback can fix it (only a parser knows whether that `)` closed an `if`
 * head or a call), and it stays acceptable only because a scan of `lib/**` and
 * `app/api/**` finds ZERO regex literals in that position carrying an unpaired
 * quote — so this is a known hole with no instances, not a missed one.
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
// Structure follows tests/repo/no-handrolled-latest-holdings.test.ts, plus the
// regex-literal state that guard lacks (R-E-C7 — see the header).

interface Segment {
  type: "code" | "comment" | "string" | "template" | "regex";
  start: number;
  end: number;
}

// ─── Regex literal vs division (R-E-C7) ───────────────────────────────────
// A `/` in code position is EITHER a division operator OR the opening of a
// regex literal, and the character alone does not decide it — the previous
// significant token does. Guessing wrong is unsound in BOTH directions, and
// both failure modes end in the same place: a MISSED hand-rolled predicate.
//
//   * regex mistaken for division — the regex BODY is scanned as code, so an
//     apostrophe inside it opens a phantom string that swallows everything up
//     to the next quote. Not hypothetical: lib/apis/analyst-estimates.ts
//     carries /\b403\b|don'?t have access/i and lib/transcripts/same-day.ts
//     carries /i(?:'|’)ll produce the/im. The Task 2 review planted
//     `const apos = /don't/;` above two genuinely bad predicates and this
//     guard reported 12/12 PASSED.
//   * division mistaken for a regex — the "regex" swallows code to the next `/`.
//
// The heuristic is the standard one: `/` opens a regex only when the previous
// significant token CANNOT end an expression. An identifier, a number, a
// string/template/regex literal, `)` and `]` all CAN end one, so a `/` after
// them is division; the punctuation in PRE_REGEX_PUNCT and the keywords in
// PRE_REGEX_KEYWORDS cannot. Two safety valves keep a misjudgement cheap:
//
//   1. a `/` that is the first significant character on its line opens a
//      regex. Verified empirically at authoring time: `^\s*/[^/*]` over the
//      589 scanned files matches 89 lines and every one is a regex literal —
//      this tree never breaks a division across a line (Prettier keeps binary
//      operators at the END of the line).
//   2. a regex scan that reaches a newline before closing is ABANDONED and the
//      `/` is re-read as ordinary code, so a false regex can never swallow
//      more than the remainder of its own line.
//
// `>` earns its place in PRE_REGEX_PUNCT on its own: without it the very
// common `(l) => /^…$/.test(l)` reads the arrow's `>` as an expression end and
// lexes the whole regex as code.

const PRE_REGEX_PUNCT = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "^", "~", "<", ">",
]);

const PRE_REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "new", "delete", "void",
  "instanceof", "do", "else", "yield", "await", "throw",
]);

const WORD_CHAR = /[A-Za-z0-9_$]/;

/** Does a `/` at `slash` open a regex literal, given the index of the last
 *  significant (non-whitespace, non-comment) character before it? */
function regexCanStartAt(src: string, lastSig: number, slash: number): boolean {
  if (lastSig < 0) return true; // first token in the file
  if (src.slice(lastSig + 1, slash).includes("\n")) return true; // valve 1
  const ch = src[lastSig];
  if (PRE_REGEX_PUNCT.has(ch)) return true;
  if (WORD_CHAR.test(ch)) {
    let s = lastSig;
    while (s >= 0 && WORD_CHAR.test(src[s])) s--;
    return PRE_REGEX_KEYWORDS.has(src.slice(s + 1, lastSig + 1));
  }
  return false; // `)`, `]`, a quote, a regex's own closing `/` or its flags
}

/** Scan a regex literal starting at `start` (which must be a `/`). Returns the
 *  index just past the closing `/` and its flags, or -1 when this is not a
 *  well-formed single-line regex literal (valve 2). Handles `\/` escapes and
 *  `[/]` character classes, inside which `/` does NOT close the literal. */
function scanRegexLiteral(src: string, start: number): number {
  const n = src.length;
  let i = start + 1;
  let inClass = false;
  while (i < n) {
    const ch = src[i];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      i++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (ch === "/") {
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++; // flags
      return i;
    }
    i++;
  }
  return -1;
}

function tokenize(src: string): Segment[] {
  const segments: Segment[] = [];
  const n = src.length;
  let i = 0;
  let codeStart = 0;
  // Index of the last significant character seen in CODE position. Comments
  // never update it; a closed string/template/regex sets it to its own final
  // character, all of which correctly read as "an expression just ended".
  let lastSig = -1;

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

    // A `/` that is not a comment opener is either a regex literal or a
    // division operator. `scanRegexLiteral` returning -1 is the second safety
    // valve: an unterminated "regex" is re-read as ordinary code below.
    if (c === "/" && regexCanStartAt(src, lastSig, i)) {
      const end = scanRegexLiteral(src, i);
      if (end !== -1) {
        flushCode(i);
        segments.push({ type: "regex", start: i, end });
        i = end;
        codeStart = i;
        lastSig = i - 1;
        continue;
      }
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
      lastSig = i - 1;
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
      lastSig = i - 1;
      continue;
    }

    if (!/\s/.test(c)) lastSig = i;
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

  // ─── R-E-C7: the lexer's regex-literal state, in BOTH directions ───────

  it("self-test: an apostrophe inside a regex literal does not blind the guard", () => {
    // THE HOLE. Without a regex-literal state the `'` in /don't/ opens a
    // phantom string that runs to the next `'` — which is the one opening
    // 'in_progress' — so both planted predicates below went unseen and the
    // guard reported PASSED. This tree really does carry such regexes
    // (lib/apis/analyst-estimates.ts, lib/transcripts/same-day.ts).
    // REVERT THE REGEX STATE IN `tokenize` AND THIS TEST MUST FAIL.
    const bad = `
      const apos = /don't/;
      export const bad1 = db.prepare(\`SELECT 1 WHERE error != 'in_progress'\`);
      const dq = /say"hi/;
      export const bad2 = db.prepare(\`SELECT 1 WHERE error != 'sending'\`);
    `;
    const occs = findOccurrences("lib/queries/planted-regex-apostrophe.ts", bad);
    expect(occs.map((o) => o.sentinel)).toEqual(["in_progress", "sending"]);
    expect(occs.every((o) => o.shape === "sql-literal")).toBe(true);
  });

  it("self-test: division is NOT read as a regex — no phantom skip, no crash", () => {
    // The other direction. Two `/` operators whose operands are ordinary
    // identifiers: if either were lexed as a regex opener, the "literal" would
    // swallow forward to the next `/` and the sentinel after it would vanish.
    const src = `
      const r = a / b;
      const s = c / d;
      export const bad = db.prepare(\`SELECT 1 WHERE error = 'delivery_unknown'\`);
      const t = (x + y) / 2 / 3;
      export const alsoBad = (e: string | null) => e === "sent-by-cloud";
    `;
    const occs = findOccurrences("lib/queries/planted-division.ts", src);
    expect(occs.map((o) => o.sentinel)).toEqual(["delivery_unknown", "sent-by-cloud"]);
  });

  it("self-test: a legitimate regex whose PATTERN contains a sentinel is not flagged", () => {
    // A regex is code, not a string literal, and prose inside one is prose.
    const fine = `
      const isSending = /sending/.test(state);
      const anyLive = /^(in_progress|sending)$/;
      const cloud = str.replace(/sent-by-cloud/g, "");
      const quoted = /error = 'delivery_unknown'/;
    `;
    expect(findOccurrences("lib/earnings/planted-regex-prose.ts", fine)).toEqual([]);
  });

  it("self-test: regex escapes, character classes and arrow-returned regexes lex correctly", () => {
    // `\\/` and `[/]` both contain a `/` that must NOT close the literal, and
    // `=> /…/` is the shape that forces `>` into PRE_REGEX_PUNCT. If any of
    // these mis-lexes, the trailing predicate is swallowed and goes unseen.
    const src = `
      const path = /a\\/b/;
      const cls = /[/'"]+/g;
      const arrow = (l: string) => /^\\d+$/.test(l);
      const flags = /x/gimsuy;
      export const bad = db.prepare(\`SELECT 1 WHERE error != 'in_progress'\`);
    `;
    const occs = findOccurrences("lib/queries/planted-regex-shapes.ts", src);
    expect(occs).toHaveLength(1);
    expect(occs[0]).toMatchObject({ sentinel: "in_progress", shape: "sql-literal" });
  });

  it("self-test: an unterminated regex-looking slash never swallows past its line", () => {
    // Safety valve 2. `a = / b` has no closing `/` on its line, so the scan is
    // abandoned and the `/` is re-read as ordinary code rather than eating the
    // rest of the file.
    const src = `
      const weird = fn(/ , x);
      export const bad = db.prepare(\`SELECT 1 WHERE error = 'sending'\`);
    `;
    const occs = findOccurrences("lib/queries/planted-unterminated.ts", src);
    expect(occs.map((o) => o.sentinel)).toEqual(["sending"]);
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
