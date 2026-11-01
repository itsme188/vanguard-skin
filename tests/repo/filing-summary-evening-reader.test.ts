/**
 * Static guards for the late periodic report (migration 100).
 *
 * 1. Every reader of `filing_summary_filings` under lib/filing-summary and
 *    app/ goes through the ONE evening helper (`eveningFilingSql`, which
 *    `listFilings` uses), so a late 10-Q / 10-K never enters the evening run,
 *    the evening view, the share page or the push. Checked per OCCURRENCE:
 *    the SQL string that names the table must also call `eveningFilingSql(`.
 *    Files that legitimately read both arrivals are allow-listed by path with
 *    their reason.
 * 2. No file under workers/, lib/digest/, lib/email or the push sender reads
 *    the `arrival` column, the late watch table or the late readers: the late
 *    report is in-app only (owner ruling 2026-10-29).
 *
 * Comments are skipped (lines starting with `//`, `*` or `/*`).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const ROOT = path.join(__dirname, "../..");
const TABLE = "filing_summary_filings";
const HELPER = "eveningFilingSql(";

/** Files that read both arrivals on purpose, with the reason. */
const ALLOWLIST: Record<string, string> = {
  "lib/filing-summary/store.ts":
    "owner of the helper: listFilings filters through it; listLateFilings, getFilingById and the insert serve the late path",
  "lib/filing-summary/late.ts": "the late watch itself: reads and stores late filings",
  "lib/filing-summary/merge.ts": "an event merge moves every filing of the event, both arrivals, unchanged",
  "lib/filing-summary/runner.ts":
    "runs evening and late sections alike: its one raw read is the by-id identity re-check at finalize; list reads go through listFilings / listLateFilings",
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join("/");

function isCommentLine(src: string, idx: number): boolean {
  const lineStart = src.lastIndexOf("\n", idx) + 1;
  const head = src.slice(lineStart, idx).trimStart();
  return head.startsWith("//") || head.startsWith("*") || head.startsWith("/*");
}

/** The SQL string around an occurrence: from the enclosing `prepare(` to the string's closing quote. */
function statementAround(src: string, idx: number): string {
  const start = Math.max(src.lastIndexOf("prepare(", idx), src.lastIndexOf("exec(", idx), 0);
  const ends = ["`", '"'].map((q) => src.indexOf(q, idx)).filter((i) => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : src.length;
  return src.slice(start, end);
}

describe("evening readers of filing_summary_filings use the one helper", () => {
  const files = [...walk(path.join(ROOT, "lib/filing-summary")), ...walk(path.join(ROOT, "app"))];

  it("the helper exists and listFilings uses it", () => {
    const store = fs.readFileSync(path.join(ROOT, "lib/filing-summary/store.ts"), "utf8");
    const fn = anchorIndex(store, "export function listFilings(");
    const body = store.slice(fn, anchorIndex(store, "\n}", fn));
    expect(body).toContain("eveningFilingSql()");
    expect(store.slice(anchorIndex(store, "export function eveningFilingSql("))).toContain("arrival = 'evening'");
  });

  it("every other occurrence names the helper in the same SQL string", () => {
    const bad: string[] = [];
    let scanned = 0;
    for (const f of files) {
      const r = rel(f);
      if (ALLOWLIST[r]) continue;
      const src = fs.readFileSync(f, "utf8");
      let idx = src.indexOf(TABLE);
      while (idx !== -1) {
        if (!isCommentLine(src, idx)) {
          scanned += 1;
          if (!statementAround(src, idx).includes(HELPER)) {
            const line = src.slice(0, idx).split("\n").length;
            bad.push(`${r}:${line}`);
          }
        }
        idx = src.indexOf(TABLE, idx + TABLE.length);
      }
    }
    // The scan saw the known evening readers (push, tick, poller), so it is not vacuous.
    expect(scanned).toBeGreaterThanOrEqual(5);
    expect(bad).toEqual([]);
  });

  it("the guard catches a planted raw read", () => {
    const planted = 'const x = db.prepare(`SELECT * FROM filing_summary_filings WHERE event_id = ?`).all(1);';
    expect(statementAround(planted, planted.indexOf(TABLE)).includes(HELPER)).toBe(false);
    const fixed = 'const x = db.prepare(`SELECT * FROM filing_summary_filings f WHERE ${eveningFilingSql("f")}`).all();';
    expect(statementAround(fixed, fixed.indexOf(TABLE)).includes(HELPER)).toBe(true);
  });

  it("every allow-listed file exists", () => {
    for (const p of Object.keys(ALLOWLIST)) expect(fs.existsSync(path.join(ROOT, p)), p).toBe(true);
  });
});

describe("outbound paths never read the late report", () => {
  const LATE_NAMES = [
    /\barrival\b/,
    /filing_summary_late_watch/,
    /\blistLateFilings\b/,
    /\blistLateRuns\b/,
    /\bgetLateWatch\b/,
    /from ["'][^"']*filing-summary\/late["']/,
  ];
  const files = [
    ...walk(path.join(ROOT, "workers")),
    ...walk(path.join(ROOT, "lib/digest")),
    ...walk(path.join(ROOT, "lib/email")),
    path.join(ROOT, "lib/email.ts"),
    path.join(ROOT, "lib/filing-summary/push.ts"),
  ].filter((f) => fs.existsSync(f));

  it("no code line under workers/, lib/digest/, lib/email or the push sender names them", () => {
    expect(files.length).toBeGreaterThan(20);
    const bad: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (LATE_NAMES.some((re) => re.test(line))) bad.push(`${rel(f)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("the push sender's query filters to evening filings", () => {
    const push = fs.readFileSync(path.join(ROOT, "lib/filing-summary/push.ts"), "utf8");
    const q = anchorIndex(push, "JOIN filing_summary_filings f");
    expect(push.slice(q, anchorIndex(push, "`", q))).toContain('eveningFilingSql("f")');
  });
});
