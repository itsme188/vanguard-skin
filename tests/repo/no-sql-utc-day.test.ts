/**
 * The SQL side of the UTC sweep, static guard.
 *
 * SQLite's clock is UTC. `date('now')` is the UTC calendar day, which is
 * already tomorrow between 20:00 and midnight Eastern. Compared with a
 * date-only column (`maturity_date`, `expiration_date`, `event_date`,
 * `as_of_date`, `expires_at`) it moved "today" four to five hours early every
 * evening. The rule (CLAUDE.md, "Dates & time"): a calendar-day comparison
 * binds the Eastern day from JavaScript (`todayET()`, or the validated
 * literal `easternDaySql()` / `unmaturedSecuritySql()` in
 * lib/db/eastern-day-sql.ts).
 *
 * The clock is still CORRECT in three shapes, which cannot be told apart from
 * the wrong one by pattern alone, so the guard works per occurrence:
 *
 *  1. DAY forms: `date('now'…)`, `julianday('now'…)`, `strftime(…'now'…)`,
 *     `CURRENT_DATE`. Every occurrence must be listed in ALLOWED. After the
 *     sweep only two remain, both column defaults inside migrations.
 *  2. INSTANT windows: `datetime('now', <offset>)`, or `datetime('now')` on
 *     either side of an inequality. Correct when BOTH sides are instants (a
 *     lease, a cooldown, a "received in the last N hours" window). Every
 *     occurrence must be listed with what the column holds.
 *  3. DAY CUTS of a stored instant: `date(<something>_at)` or
 *     `substr(<something>_at, 1, 10)` in SQL. That is the UTC day of the
 *     instant. Every occurrence must be listed.
 *
 * A bare `datetime('now')` with no offset and no inequality is a written
 * stamp or a column default (`SET updated_at = datetime('now')`, `VALUES (…,
 * datetime('now'))`): an instant, correct in UTC, and not listed one by one.
 *
 * An entry names the file, a substring of the line (`anchor`), its class, a
 * reason and how many lines it covers. A new occurrence in a listed file does
 * not match and fails. A stale entry (the code moved or was fixed) fails too.
 *
 * Scope: app/, lib/ (migrations included) and scripts/. Comment lines are not
 * scanned. tests/ and workers/ are out of scope (the Worker runs on D1-free
 * JavaScript and has its own Eastern helpers in workers/cron/src/dst.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|sql|sh|py)$/;

type Kind = "day" | "instant-window" | "day-cut";

type AllowClass =
  /** Two instants compared: a lease, cooldown, stale-claim or "last N hours/days" window. */
  | "elapsed-time"
  /** A column DEFAULT inside a migration (protected area); the writers bind the Eastern day. */
  | "migration-default"
  /** A ruled invariant or a send/claim path the sweep was told not to move. */
  | "ruled-left"
  /** An operator-run script whose window is given by hand in UTC days. */
  | "operator-script";

interface Allowed {
  file: string;
  /** Substring of the line that holds the expression. */
  anchor: string;
  kind: Kind;
  cls: AllowClass;
  why: string;
  /** Exact number of lines this entry covers (default 1). */
  count?: number;
}

const ALLOWED: Allowed[] = [
  // ── 1. day forms ──────────────────────────────────────────────────────
  {
    file: "lib/db/migrations/015_watchlist.sql",
    anchor: "added_date TEXT NOT NULL DEFAULT (date('now'))",
    kind: "day",
    cls: "migration-default",
    why: "UTC-day default, never relied on: addToWatchlist binds todayET() on insert.",
  },
  {
    file: "lib/db/migrations/029_security_levels.sql",
    anchor: "set_date TEXT NOT NULL DEFAULT (date('now'))",
    kind: "day",
    cls: "migration-default",
    why: "UTC-day default, never relied on: upsertLevel binds todayET() on insert.",
  },

  // ── 2. instant windows ────────────────────────────────────────────────
  {
    file: "lib/calendar/verify-earnings-dates.ts",
    anchor: "datetime(ce.date_verified_at) <= datetime('now', '-2 days')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Re-verify cooldown: date_verified_at is a datetime('now') stamp; 48 elapsed hours.",
  },
  {
    file: "lib/digest/overnight.ts",
    anchor: "datetime(a.received_at) >= datetime('now', '-2 days')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Articles received in the last 48 hours; received_at is an instant, both sides through datetime().",
  },
  {
    file: "lib/mutations/research-documents.ts",
    anchor: "datetime(updated_at) > datetime('now', ?) AS fresh",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Upload-claim lease in minutes against a datetime('now') stamp.",
  },
  {
    file: "lib/digest/send-earnings-email.ts",
    anchor: "datetime(sent_at) <= datetime('now', '-${CLAIM_STALE_MINUTES} minutes')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Stale-claim takeover window on the send path: sent_at is the claim instant.",
  },
  {
    file: "lib/digest/send-earnings-email.ts",
    anchor: "datetime(a.received_at) >= datetime('now', '-${days} days')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Newsletter context received in the last N x 24 hours; an instant window, both sides through datetime().",
  },
  {
    file: "lib/queries/briefing-levels.ts",
    anchor: "WHERE a.triggered_at >= datetime('now', ?)",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Alerts fired in the last N x 24 hours; triggered_at is the fire instant.",
  },
  {
    file: "lib/queries/research.ts",
    anchor: "AND a.received_at >= datetime('now', '-' || ? || ' hours')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Digest source window in hours against the received instant.",
    count: 2,
  },
  {
    file: "lib/queries/press-releases.ts",
    anchor: "published_at >= datetime('now', ?)",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Releases published in the last N x 24 hours; published_at is an instant.",
  },
  {
    file: "lib/alerts/extract-newsletter-levels.ts",
    anchor: "AND a.received_at >= datetime('now', '-${sinceDays} days')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Extraction scan window over the received instant; rows are stamped once scanned.",
  },
  {
    file: "lib/earnings/extract-newsletter-bogeys.ts",
    anchor: "AND a.received_at >= datetime('now', '-${sinceDays} days')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Bogey scan window over the received instant; rows are stamped once scanned.",
  },
  {
    file: "lib/earnings/prepare-steps/newsletter-rescan.ts",
    anchor: "WHERE a.received_at >= datetime('now', ?) AND a.raw_text IS NOT NULL",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Rescan lookback over the received instant.",
  },
  {
    file: "lib/earnings/prepare-steps/newsletter-rescan.ts",
    anchor: "datetime(earnings_bogey_scans.updated_at) < datetime('now', ?)))",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Stale scan-claim takeover against a datetime('now') stamp.",
  },
  {
    file: "lib/earnings/prepare-steps/newsletter-rescan.ts",
    anchor: "CASE WHEN datetime(updated_at) < datetime('now', ?) THEN 1 ELSE 0 END AS stale",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Same stale-claim test, read back for the report.",
  },
  {
    file: "scripts/snapshot-state-to-r2.ts",
    anchor: "WHERE datetime(sent_at) >= datetime('now', '-3 days')",
    kind: "instant-window",
    cls: "elapsed-time",
    why: "Send audit rows of the last 72 hours for the Worker snapshot; sent_at is an instant.",
  },

  // ── 3. day cuts of a stored instant ───────────────────────────────────
  {
    file: "lib/calendar/reconcile-earnings-dates.ts",
    anchor: "phase = 'preview' AND date(sent_at) >= date(?, '-1 day')",
    kind: "day-cut",
    cls: "ruled-left",
    why: "Preview-repoint rule (CLAUDE.md invariant): a preview only follows an event its send date could cover. Ruled; not moved.",
  },
  {
    file: "lib/calendar/reconcile-earnings-dates.ts",
    anchor: "phase = 'preview' AND date(skipped_at) >= date(?, '-1 day')",
    kind: "day-cut",
    cls: "ruled-left",
    why: "Twin of the preview-repoint rule for skip rows. Ruled; not moved.",
  },
  {
    file: "lib/calendar/reconcile-earnings-dates.ts",
    anchor: "AND date(pe_ee.sent_at) >= date(calendar_events.event_date))",
    kind: "day-cut",
    cls: "ruled-left",
    why: "Print-evidence rule, recap leg (reconciler): the UTC day of a send is never before its Eastern day, so the floor cannot miss a real recap. Not moved.",
  },
  {
    file: "lib/calendar/reconcile-earnings-dates.ts",
    anchor: "AND date(pe_ee.sent_at) BETWEEN date(calendar_events.event_date, '-1 day')",
    kind: "day-cut",
    cls: "ruled-left",
    why: "Print-evidence rule, preview leg (reconciler): the one-day band either side was sized for UTC sent_at against an Eastern event_date. Not moved.",
  },
  {
    file: "lib/calendar/reconcile-earnings-dates.ts",
    anchor: "AND date(pe_pl.updated_at) >= date(calendar_events.event_date, '-1 day'))",
    kind: "day-cut",
    cls: "ruled-left",
    why: "Print-evidence rule, accepted sheet line (reconciler): the minus-one-day floor covers the UTC/Eastern offset. Not moved.",
  },
  {
    file: "lib/calendar/reconcile-earnings-dates.ts",
    anchor: "AND date(COALESCE(pe_pc.accepted_at, pe_pc.updated_at)) >= date(calendar_events.event_date, '-1 day'))",
    kind: "day-cut",
    cls: "ruled-left",
    why: "Print-evidence rule, accepted callout (reconciler): same minus-one-day floor. Not moved.",
  },
  {
    file: "scripts/repair-requeue-failed-enrichment.ts",
    anchor: 'conditions.push("substr(received_at, 1, 10) >= ?");',
    kind: "day-cut",
    cls: "operator-script",
    why: "Dry-run-first repair script: the operator passes --since as a day and reviews the listed rows.",
  },
  {
    file: "scripts/repair-requeue-failed-enrichment.ts",
    anchor: 'conditions.push("substr(received_at, 1, 10) <= ?");',
    kind: "day-cut",
    cls: "operator-script",
    why: "Same script, --until bound.",
  },
];

interface Hit {
  file: string;
  line: number;
  text: string;
  kind: Kind;
}

const DAY_FORM = /\b(?:date|julianday)\(\s*'now'|\bstrftime\([^)]*'now'|\bCURRENT_DATE\b/i;
const INSTANT_WINDOW =
  /\bdatetime\(\s*'now'\s*,|(?:[<>]=?|\bBETWEEN\b[^\n]*)\s*datetime\(\s*'now'\s*\)|\bdatetime\(\s*'now'\s*\)\s*(?:[<>]|(?:NOT\s+)?BETWEEN\b)/i;
// Case-sensitive on purpose: SQL `date(` / `DATE(`, never JavaScript `new Date(`.
const DAY_CUT =
  /(?<![\w.])(?:date|DATE)\(\s*(?:COALESCE\(\s*)?(?:[a-z_][a-z0-9_]*\.)?[a-z0-9_]*_at\b|(?<![\w.])(?:substr|SUBSTR)\(\s*(?:[a-z_][a-z0-9_]*\.)?[a-z0-9_]*_at\s*,\s*1\s*,\s*10\s*\)/;

/** A line that is only a comment (JS line/block comment, SQL `--`, shell `#`). */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("--") ||
    t.startsWith("#")
  );
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (SCAN_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS) {
    for (const full of listFiles(path.join(REPO_ROOT, dir))) {
      const file = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      const lines = fs.readFileSync(full, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (isCommentLine(text)) return;
        // A trailing JS comment may quote the forbidden form while explaining it.
        const code = text.replace(/\s\/\/\s.*$/, "");
        const kinds: Kind[] = [];
        if (DAY_FORM.test(code)) kinds.push("day");
        if (INSTANT_WINDOW.test(code)) kinds.push("instant-window");
        if (DAY_CUT.test(code)) kinds.push("day-cut");
        for (const kind of kinds) hits.push({ file, line: i + 1, text: code.trim(), kind });
      });
    }
  }
  return hits;
}

const HITS = scan();

function matches(hit: Hit, entry: Allowed): boolean {
  return hit.file === entry.file && hit.kind === entry.kind && hit.text.includes(entry.anchor);
}

describe("SQL never reads the UTC clock as a calendar day", () => {
  it("the scanner sees the forms it is meant to see", () => {
    expect(DAY_FORM.test("AND s.maturity_date >= date('now')")).toBe(true);
    expect(DAY_FORM.test("AND x < date('now', '-1 day')")).toBe(true);
    expect(DAY_FORM.test("julianday('now') - julianday(d) > ?")).toBe(true);
    expect(DAY_FORM.test("strftime('%Y-%m-%d', 'now')")).toBe(true);
    expect(DAY_FORM.test("WHERE d = CURRENT_DATE")).toBe(true);
    expect(DAY_FORM.test("AND x < date(?, '-1 day')")).toBe(false);
    expect(DAY_FORM.test("SET updated_at = datetime('now')")).toBe(false);

    expect(INSTANT_WINDOW.test("datetime(a) >= datetime('now', '-2 days')")).toBe(true);
    expect(INSTANT_WINDOW.test("WHERE a.t >= datetime('now', ?)")).toBe(true);
    expect(INSTANT_WINDOW.test("WHERE a.t < datetime('now')")).toBe(true);
    expect(INSTANT_WINDOW.test("WHERE datetime('now') > a.t")).toBe(true);
    expect(INSTANT_WINDOW.test("WHERE datetime('now') BETWEEN a.starts_at AND a.ends_at")).toBe(true);
    expect(INSTANT_WINDOW.test("WHERE datetime('now') NOT BETWEEN a.t AND b.t")).toBe(true);
    expect(INSTANT_WINDOW.test("AND datetime( 'now' )  not between ? AND ?")).toBe(true);
    expect(INSTANT_WINDOW.test("WHERE a.t BETWEEN ? AND datetime('now')")).toBe(true);
    expect(INSTANT_WINDOW.test("SET updated_at = datetime('now')")).toBe(false);
    expect(INSTANT_WINDOW.test("VALUES (?, ?, datetime('now'))")).toBe(false);
    expect(INSTANT_WINDOW.test("applied_at TEXT DEFAULT (datetime('now'))")).toBe(false);

    expect(DAY_CUT.test("AND date(sent_at) >= date(?, '-1 day')")).toBe(true);
    expect(DAY_CUT.test("GROUP BY date(e.created_at)")).toBe(true);
    expect(DAY_CUT.test("substr(received_at, 1, 10) >= ?")).toBe(true);
    expect(DAY_CUT.test("AND date(maturity_date) < date(?, ?)")).toBe(false);
    expect(DAY_CUT.test("AND date(COALESCE(c.accepted_at, c.updated_at)) >= date(d)")).toBe(true);
    expect(DAY_CUT.test("new Date(row.sent_at)")).toBe(false);
    expect(DAY_CUT.test("const d = new Date(a.triggered_at).toLocaleString()")).toBe(false);
  });

  it("finds the reviewed sites at all (the scan is not silently empty)", () => {
    expect(HITS.length).toBeGreaterThanOrEqual(ALLOWED.length);
  });

  it("every UTC-clock day form, instant window and day cut is a reviewed, listed site", () => {
    const unlisted = HITS.filter((h) => !ALLOWED.some((a) => matches(h, a)));
    const report = unlisted.map((h) => `${h.file}:${h.line} [${h.kind}] ${h.text}`);
    expect(
      report,
      "A SQL fragment reads SQLite's UTC clock as a calendar day, or compares it in a way " +
        "nobody has reviewed. For a calendar-day comparison bind todayET() or use " +
        "easternDaySql() / unmaturedSecuritySql() from lib/db/eastern-day-sql.ts. Add an " +
        "entry to ALLOWED only for a comparison between two instants.",
    ).toEqual([]);
  });

  it("no listed entry is stale, and each covers exactly the lines it says", () => {
    const problems: string[] = [];
    for (const entry of ALLOWED) {
      const n = HITS.filter((h) => matches(h, entry)).length;
      const want = entry.count ?? 1;
      if (n !== want) {
        problems.push(`${entry.file} [${entry.kind}] "${entry.anchor}": listed ${want}, found ${n}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("no line is excused by two entries, and every entry says why", () => {
    const double = HITS.filter((h) => ALLOWED.filter((a) => matches(h, a)).length > 1).map(
      (h) => `${h.file}:${h.line}`,
    );
    expect(double).toEqual([]);
    for (const entry of ALLOWED) {
      expect(entry.why.length, `${entry.file}: ${entry.anchor}`).toBeGreaterThan(20);
    }
  });

  it("an instant window never compares the clock with a known date-only column", () => {
    // A date-only column read as an instant is midnight UTC: the comparison
    // is a calendar-day rule in disguise and belongs on the Eastern day.
    const DATE_ONLY =
      /\b(?:as_of_date|event_date|maturity_date|expiration_date|expires_at|month_end_date|valuation_date|publication_date|set_date|added_date)\b/;
    const disguised = HITS.filter((h) => h.kind === "instant-window" && DATE_ONLY.test(h.text)).map(
      (h) => `${h.file}:${h.line} ${h.text}`,
    );
    expect(disguised).toEqual([]);
  });
});
