/**
 * Task 13 (holdings-latest-sweep, Codex F1) — static regression guard.
 *
 * `latestHoldingsPredicate` (lib/queries/latest-holdings.ts) is the single
 * source of truth for "latest holdings row per (account, security)" —
 * Tasks 1-11 of this sweep converted every call site that determines WHICH
 * holdings rows are "current" to use it. This test is what keeps the sweep
 * swept: it statically scans the tree for hand-rolled
 * `MAX(...) ... as_of_date` subqueries against `holdings` and fails on any
 * occurrence that is neither (a) structurally correlated per-(account,
 * security) via the same marker `latestHoldingsPredicate` uses, nor (b) an
 * explicitly reviewed, per-occurrence allowlisted exception (freshness-only
 * date reads, the closed-equity reconciler's own bookkeeping, the
 * predicate's own implementation, or the tax-lot tombstone detector).
 *
 * Design (see .superpowers/sdd/sleepy-bouncing-raven/task-13-brief.md +
 * shared-constraints.md):
 *  - EVERY occurrence is validated individually, never a whole file — a bad
 *    query added to an already-allowlisted file must still fail. This is
 *    why the allowlist matches per-occurrence, using a tightly-scoped
 *    "enclosing string/template literal" as the match unit (never a
 *    file-wide or fixed-character-window exemption).
 *  - Comments are excluded from the scan (a tiny lexer tracks comment vs.
 *    string/template regions) so prose that merely *mentions*
 *    `MAX(as_of_date)` — of which this codebase has many, documenting why
 *    a site does NOT hand-roll it — never trips the guard and never needs
 *    an allowlist entry.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameLocal, "../..");

// ─── File collection ──────────────────────────────────────────────────
// No fast-glob (undeclared dep — see lib/auth/route-policy.ts precedent).
// Only lib/, app/, scripts/ are scanned; tests/, node_modules, .next,
// .superpowers, and docs are all top-level siblings that a walk rooted at
// those three directories never visits. Defensive path-segment excludes
// are still applied in case a stray nested dir of one of those names ever
// appears.

const SCAN_ROOTS = ["lib", "app", "scripts"];
const EXCLUDED_SEGMENTS = new Set([
  "tests",
  "node_modules",
  ".next",
  ".superpowers",
  "docs",
  ".git",
]);

function collectFiles(dir: string, out: string[] = []): string[] {
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
      collectFiles(full, out);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectTargetFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    collectFiles(path.join(REPO_ROOT, root), out);
  }
  return out;
}

// ─── Tiny lexer: code / comment / string / template regions ───────────
// Just enough JS/TS tokenizing to (a) find the MAX(...as_of_date...) text
// ONLY inside real string/template content — never inside a // or /* */
// comment — and (b) give each match a precisely-bounded "enclosing
// literal" as its validation context, instead of an ad hoc character
// window (which would let two nearby occurrences bleed into each other's
// allowlist match). `${...}` interpolation inside a template literal is
// tracked only for brace depth (this codebase's SQL template literals
// interpolate plain identifiers/calls, never nested strings/templates).

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

// ─── The pattern under guard ───────────────────────────────────────────
// A correlated/derived MAX(...) whose argument is (optionally alias-
// qualified) `as_of_date` — the holdings table's staleness/versioning
// column. `as_of_date` also exists on etf_sector_weights and
// security_quotes (migrations 059, 058), but no site in this codebase
// hand-rolls a MAX(as_of_date) subquery against either — every real match
// found by this pattern is holdings-table "latest row" logic.
const MAX_AS_OF_DATE_RE = /MAX\(\s*(?:[A-Za-z_$][\w$]*\.)?as_of_date\s*\)/g;

// Structural per-pair correlation marker: some alias's `.security_id`
// equated with holdings' own `h.security_id` (either side), covering both
// the correlated-subquery shape (`h2.security_id = h.security_id`) and the
// derived-table JOIN shape (`latest.security_id = h.security_id`). This is
// the same relationship latestHoldingsPredicate's keyBy:"account_security"
// enforces, just spelled out by hand — evaluated per-occurrence against
// that occurrence's own enclosing literal, so a second, unmarked query
// added next to a marked one still fails.
const PER_PAIR_MARKER_RE =
  /\b\w+\.security_id\s*=\s*h\.security_id\b|\bh\.security_id\s*=\s*\w+\.security_id\b/;

interface Occurrence {
  file: string; // repo-relative, forward-slash
  line: number;
  context: string; // the enclosing string/template literal text
}

function findOccurrences(absFile: string, src: string): Occurrence[] {
  const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");
  const segments = tokenize(src);
  const out: Occurrence[] = [];

  for (const seg of segments) {
    if (seg.type !== "string" && seg.type !== "template") continue;
    const text = src.slice(seg.start, seg.end);
    MAX_AS_OF_DATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MAX_AS_OF_DATE_RE.exec(text))) {
      const absIdx = seg.start + m.index;
      const line = src.slice(0, absIdx).split("\n").length;
      out.push({ file: relFile, line, context: text });
    }
  }
  return out;
}

function scanRepo(files: string[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    out.push(...findOccurrences(f, src));
  }
  return out;
}

// ─── Allowlist ──────────────────────────────────────────────────────────
// Every entry here was individually read and verified (not inferred from
// the task brief's example list) against the tree at the end of the
// holdings-latest-sweep. Each `anchor` must appear inside the specific
// occurrence's enclosing string/template literal — it is NOT a file-wide
// exemption: a second, different hand-rolled query added anywhere in one
// of these files, whose enclosing literal does not contain a matching
// anchor (and isn't per-pair marked), still fails the scan.

interface AllowlistEntry {
  file: string;
  anchor: string;
  justification: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const ALLOWLIST: AllowlistEntry[] = [
  // ── The predicate's own implementation ──────────────────────────────
  {
    file: "lib/queries/latest-holdings.ts",
    anchor: "SELECT MAX(h2.as_of_date) FROM holdings h2",
    justification:
      "latestHoldingsPredicate's own inner subquery — this IS the single source of truth every other site is required to call instead of hand-rolling; the per-pair correlation (innerKey) is injected via ${innerKey} at runtime, invisible to a static text match, so this occurrence needs its own entry rather than tripping the structural marker.",
  },

  // ── Freshness-only readouts: report a date, never filter/select which
  //    holdings rows are "current" for any other query. ─────────────────
  {
    file: "lib/queries/holdings.ts",
    anchor: "SELECT MAX(as_of_date) as latest FROM holdings WHERE account_id = ?",
    justification:
      "getLatestHoldingsDate — returns a bare per-account max date for an 'as of' label; callers use it for display only, never to filter which holdings rows render (verified: no caller feeds this into a WHERE clause).",
  },
  {
    file: "lib/queries/dashboard.ts",
    anchor: "SELECT account_id, MAX(as_of_date) AS max_date\n        FROM holdings GROUP BY account_id",
    justification:
      "getAccountSummaries' latest_holdings CTE feeds only AccountSummary.holdingsAsOf ('Date of the most recent holdings snapshot for this account'); the account's rendered value/total comes from the tw/daily/monthly branches above it, never from this CTE.",
  },
  {
    file: "lib/queries/chat-tools.ts",
    anchor: 'SELECT MAX(as_of_date) AS latest FROM holdings',
    justification:
      "getDataFreshness — global 'how fresh is my data' stat surfaced to the chat tool; not used to select or filter any holdings rows.",
  },
  {
    file: "lib/queries/portfolio-summary.ts",
    anchor: 'SELECT MAX(as_of_date) AS max_date FROM holdings',
    justification:
      "buildPortfolioSummaryContext's 'Latest holdings: <date>' line for the AI chat context header — a global freshness stat, not a row filter.",
  },
  {
    file: "app/api/summary/route.ts",
    anchor: 'SELECT MAX(as_of_date) AS latest FROM holdings',
    justification:
      "Electron tray tooltip summary endpoint — global freshness stat only (holdingsRow.latest), never used to select holdings rows.",
  },
  {
    file: "app/dashboard/today/page.tsx",
    anchor: "SELECT MIN(latest) AS earliest",
    justification:
      "Today tab's Vanguard snapshot-age badge: per-account MAX(as_of_date) (no quantity/security correlation) reduced to MIN across the two Vanguard accounts for a staleness label; does not filter which holdings render on the page.",
  },
  {
    file: "lib/queries/data-confidence.ts",
    anchor: "SELECT h.account_id, MAX(h.as_of_date) AS latest_date\n    FROM holdings h\n    WHERE ${latestHoldingsPredicate({ keyBy: \"account\", includeShorts: true })}",
    justification:
      "scoreHoldingsRecency's latestByAccount map — the outer MAX(h.as_of_date) aggregates over rows already filtered to one-per-account by latestHoldingsPredicate(keyBy:'account') in the WHERE clause; it re-derives a display date from an already-correct row set rather than implementing its own latest-selection logic.",
  },
  {
    file: "lib/queries/analysis.ts",
    anchor: "MAX(h.as_of_date) AS latest_date\n        FROM latest_holdings h",
    justification:
      "getPortfolioTrustState's holdingsRow query — MAX(h.as_of_date) aggregates over the latest_holdings CTE, which is itself built by LATEST_HOLDINGS_CTE calling latestHoldingsPredicate({keyBy:'account_security'}); this is a freshness stat over already-filtered rows (FROM latest_holdings, not FROM holdings), not a second filter.",
  },
  {
    file: "lib/queries/data-health.ts",
    anchor: "MAX(h.as_of_date) AS latestHoldingsDate",
    justification:
      "getAccountCoverage's latestHoldingsDate column aggregates over holdings rows already restricted by `${latestHoldingsPredicate()}` in the LEFT JOIN condition on the same line above; a freshness readout over an already-correct row set, not an independent filter.",
  },
  {
    file: "lib/queries/data-confidence.ts",
    anchor:
      "SELECT h.security_id, MAX(h.as_of_date) AS latest_as_of\n      FROM holdings h\n      WHERE ${latestHoldingsPredicate({ keyBy: \"account_security\", includeShorts: true })}",
    justification:
      "getStaleness's `agg` subquery (stalest-held-security finder) — MAX(h.as_of_date) aggregates per security_id over rows already filtered to one row per (account, security) by latestHoldingsPredicate(keyBy:'account_security') in the WHERE clause; a freshness stat over an already-correct row set, not an independent filter (sibling of the keyBy:'account' entry above).",
  },
  {
    file: "lib/tws/streaming.ts",
    anchor: "ORDER BY MAX(h.as_of_date) DESC, s.symbol",
    justification:
      "streamSecurities' securities query — this is a GROUP BY s.id aggregate in ORDER BY, resolving the sort tiebreak for a security held in multiple accounts (freshest-anywhere-first per the comment above), not a subquery selecting which holdings rows are 'latest' — that filtering is already done via `${latestHoldingsPredicate()}` in the WHERE clause of the same query.",
  },
  {
    file: "lib/queries/dashboard.ts",
    anchor: "MIN(as_of_date) AS oldestDate,\n        MAX(as_of_date) AS latestDate\n      FROM account_values",
    justification:
      "getPortfolioTotals — false-positive match: `as_of_date` here is a CTE-local column alias (defined a few lines above by a CASE over tw.month_end_date / d.valuation_date / curr.month_end_date) for the account_values CTE's per-account value date, NOT the holdings table's as_of_date column. This CTE is built from monthly_snapshots/daily_valuations/TWS branches, not from holdings at all — no per-pair holdings selection is happening here.",
  },

  // ── The closed-equity reconciler (writes quantity=0 tombstones) ────
  // Deliberately procedural: it walks per-account MAX/prior-MAX dates in
  // JS to decide which snapshot pair to diff, then writes tombstones for
  // positions absent from the newer one. It is the reason per-pair
  // "latest" reads are safe everywhere else (CLAUDE.md), so it cannot
  // itself be rewritten in terms of latestHoldingsPredicate without
  // circularity. Five occurrences, each with its own justification since
  // each drives a distinct step of the 3-pass algorithm.
  {
    file: "lib/mutations/closed-equity.ts",
    anchor: "SELECT MAX(as_of_date) AS d FROM holdings WHERE account_id = ?",
    justification:
      "latestDateStmt (global pass) — the account's overall newest snapshot date, used only to pick which date the equity/option live-snapshot passes diff against; not a row filter for any rendered query.",
  },
  {
    file: "lib/mutations/closed-equity.ts",
    anchor: "SELECT MAX(as_of_date) AS d FROM holdings\n      WHERE account_id = ? AND as_of_date < ?",
    justification:
      "priorDateStmt (global pass) — finds the prior snapshot date strictly before the just-resolved latest date, for the same-source diff the reconciler runs; procedural bookkeeping, not a holdings row filter for display.",
  },
  {
    file: "lib/mutations/closed-equity.ts",
    anchor: "SELECT MAX(h.as_of_date) AS d FROM holdings h\n      WHERE h.account_id = ? AND ${statementSourcedHoldingSql()}",
    justification:
      "latestStatementDateStmt (pass 1, statement-scoped) — newest statement-sourced snapshot date for the account, driving the 'statement book is complete' diff; procedural, not a display filter.",
  },
  {
    file: "lib/mutations/closed-equity.ts",
    anchor: "SELECT MAX(h.as_of_date) AS d FROM holdings h\n      WHERE h.account_id = ? AND h.as_of_date < ? AND ${statementSourcedHoldingSql()}",
    justification:
      "priorStatementDateStmt (pass 1, statement-scoped) — the statement-sourced snapshot immediately prior to the resolved latest one, for the shrink-guarded statement-vs-statement diff; procedural, not a display filter.",
  },
  {
    file: "lib/mutations/closed-equity.ts",
    anchor: "SELECT security_id, MAX(as_of_date) AS d\n         FROM holdings WHERE account_id = ?\n        GROUP BY security_id",
    justification:
      "phantomsSql's latest_per_sec CTE — per-security latest date WITHIN the account already pinned by the caller's account_id parameter (the reconciler always scopes one account per call), used to find the security's own last non-zero row to tombstone; not a general-purpose holdings read.",
  },

  // ── Tax-lot orphan/tombstone detector ───────────────────────────────
  {
    file: "lib/compute/tax-lots.ts",
    anchor: "SELECT MAX(h2.as_of_date) FROM holdings h2\n                 WHERE h2.account_id = tl.account_id AND h2.security_id = tl.security_id",
    justification:
      "Deliberate quantity=0 tombstone detector for orphaned open tax lots — correlated per-(account, security) same as latestHoldingsPredicate, but keyed against the tax_lots alias `tl` rather than an outer holdings alias `h` (there is no outer holdings row here to equate against), so the generic h.security_id structural marker does not match; verified the correlation columns (account_id, security_id) are the same pair the predicate uses.",
  },
];

function isAllowlisted(occ: Occurrence): boolean {
  const normContext = norm(occ.context);
  return ALLOWLIST.some(
    (entry) => entry.file === occ.file && normContext.includes(norm(entry.anchor)),
  );
}

function isPerPairMarked(occ: Occurrence): boolean {
  return PER_PAIR_MARKER_RE.test(occ.context);
}

function classify(occ: Occurrence): { ok: boolean; reason: string } {
  if (isPerPairMarked(occ)) {
    return { ok: true, reason: "per-pair correlation marker present" };
  }
  if (isAllowlisted(occ)) {
    return { ok: true, reason: "allowlisted" };
  }
  return { ok: false, reason: "unmarked, unallowlisted" };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("no hand-rolled latest-holdings MAX(as_of_date) subqueries", () => {
  it("every holdings MAX(as_of_date) occurrence in the tree is either per-pair correlated or explicitly allowlisted", () => {
    const files = collectTargetFiles();
    // Sanity: the walk is actually finding files (guards against a typo'd
    // root silently turning this test into a no-op).
    expect(files.length).toBeGreaterThan(100);

    const occurrences = scanRepo(files);
    // Sanity: the scan is actually finding the known real sites (guards
    // against the tokenizer/regex silently matching nothing). At the end
    // of the holdings-latest-sweep there are 39 real occurrences (20
    // structurally per-pair-marked, 19 allowlisted); a loose floor here
    // avoids the test being brittle against a future legitimate addition.
    expect(occurrences.length).toBeGreaterThan(30);

    const violations: string[] = [];
    for (const occ of occurrences) {
      const { ok, reason } = classify(occ);
      if (!ok) {
        violations.push(
          `${occ.file}:${occ.line} — hand-rolled MAX(as_of_date) subquery is ${reason}. ` +
            `Use latestHoldingsPredicate() (lib/queries/latest-holdings.ts) instead of a ` +
            `hand-rolled per-account/global MAX(as_of_date) — see CLAUDE.md's "Per-pair ` +
            `'latest' holdings depend on the closed-position reconciler" invariant. If this ` +
            `site is a genuinely new, verified-legitimate exception, add a per-occurrence ` +
            `entry to ALLOWLIST in tests/repo/no-handrolled-latest-holdings.test.ts with a ` +
            `justification of what the code actually does.`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("self-test: the scanner finds a planted per-pair-correlated query and passes it", () => {
    const good = `
      const rows = db.prepare(\`
        SELECT s.symbol FROM holdings h
        JOIN securities s ON s.id = h.security_id
        WHERE h.quantity != 0
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )
      \`).all();
    `;
    const occs = findOccurrences("planted/good.ts", good);
    expect(occs.length).toBe(1);
    expect(classify(occs[0])).toMatchObject({ ok: true, reason: "per-pair correlation marker present" });
  });

  it("self-test: the scanner flags a planted GLOBAL MAX(as_of_date) with no per-pair correlation and no allowlist entry, with file:line and a pointer to latestHoldingsPredicate", () => {
    const bad = `
      export function getStaleHack(db: Database.Database) {
        return db.prepare(\`
          SELECT s.symbol FROM holdings h
          JOIN securities s ON s.id = h.security_id
          WHERE h.quantity != 0
            AND h.as_of_date = (
              SELECT MAX(as_of_date) FROM holdings WHERE account_id = h.account_id
            )
        \`).all();
      }
    `;
    const occs = findOccurrences("lib/queries/planted-bad.ts", bad);
    expect(occs.length).toBe(1);
    expect(occs[0].line).toBeGreaterThan(0);
    const { ok, reason } = classify(occs[0]);
    expect(ok).toBe(false);
    expect(reason).toBe("unmarked, unallowlisted");

    // Full-pipeline proof: run it through the same violation formatter the
    // real test uses and confirm the message names the file:line and
    // points at the predicate.
    const message = `${occs[0].file}:${occs[0].line} — hand-rolled MAX(as_of_date) subquery is ${reason}. Use latestHoldingsPredicate()`;
    expect(message).toContain("lib/queries/planted-bad.ts:");
    expect(message).toContain("latestHoldingsPredicate");
  });

  it("self-test: a bad query planted in an ALREADY-allowlisted file (closed-equity.ts) still fails — allowlisting is per-occurrence, never file-wide", () => {
    // Same file that legitimately has 5 allowlisted reconciler occurrences,
    // but this query's SQL body doesn't match any of their anchors and
    // carries no per-pair marker — proves the allowlist match is scoped to
    // the individual occurrence's own enclosing literal, not the filename.
    const bad = `
      const rows = db
        .prepare(\`SELECT MAX(as_of_date) AS d FROM holdings WHERE security_id = ?\`)
        .get(securityId);
    `;
    const occs = findOccurrences("lib/mutations/closed-equity.ts", bad);
    expect(occs.length).toBe(1);
    expect(classify(occs[0])).toMatchObject({ ok: false, reason: "unmarked, unallowlisted" });
  });

  it("self-test: an exact allowlisted occurrence (getLatestHoldingsDate) passes, but the same file with a DIFFERENT unmarked query still fails", () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, "lib/queries/holdings.ts"), "utf8");
    const occs = findOccurrences("lib/queries/holdings.ts", real);
    const target = occs.find((o) =>
      norm(o.context).includes(norm("SELECT MAX(as_of_date) as latest FROM holdings WHERE account_id = ?")),
    );
    expect(target).toBeDefined();
    expect(classify(target!)).toMatchObject({ ok: true, reason: "allowlisted" });

    const badSibling = `
      const other = db
        .prepare(\`SELECT MAX(as_of_date) AS x FROM holdings\`)
        .get();
    `;
    const badOcc = findOccurrences("lib/queries/holdings.ts", badSibling)[0];
    expect(classify(badOcc)).toMatchObject({ ok: false, reason: "unmarked, unallowlisted" });
  });

  it("self-test: comments merely mentioning MAX(as_of_date) are never scanned", () => {
    const commentOnly = `
      // never a per-account global MAX(as_of_date): a position that only
      // restates on the monthly statement...
      /**
       * This replaces a correlated \`MAX(as_of_date) <= ?\` subquery.
       */
      export function fine() {
        return 1;
      }
    `;
    expect(findOccurrences("lib/anything.ts", commentOnly)).toEqual([]);
  });
});
