/**
 * Static guard: a calendar event's ACTUALS are read by id through the healed
 * reader, `getEventById` (lib/queries/calendar.ts).
 *
 * Why. A manual-actuals acceptance stamp (`manual_actuals_at`) belongs to the
 * PRINT, and can sit on a superseded twin row of that print
 * (lib/queries/manual-actuals-cluster.ts). A reader that fetches one row by
 * id and looks only at that row's own stamp puts an accepted figure back
 * behind the scrape-plausibility guard. The fetch-then-heal block used to be
 * copy-pasted across five files, and that duplication is exactly how the
 * actuals-editor surface was missed (PR #59 review, 2026-08-31).
 *
 * What is flagged. Inside `lib/**` and `app/**`, any SQL of the shape
 *
 *     SELECT <list> FROM calendar_events WHERE id = ?
 *
 * whose select list can carry the actuals: `*`, `actual_value` or
 * `manual_actuals_at`. A by-id read of other columns (symbol, dates, source)
 * is not an actuals read and is ignored.
 *
 * Validation is per OCCURRENCE, never per file: each allowlist entry names a
 * file, an anchor substring of the matched SQL, the exact number of
 * occurrences it covers, and a justification. A new hand-rolled read in an
 * already-allowlisted file still fails, and an entry whose read was removed
 * fails as stale. Pattern precedent: tests/repo/no-handrolled-latest-holdings.test.ts.
 *
 * Known limit (recorded, not chased): a by-id read spelled another way
 * (`WHERE id = @id`, `WHERE id IN (…)`, a query builder) is not matched. No
 * such actuals read exists in the tree today.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SCAN_ROOTS = ["lib", "app"];
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".next", "migrations"]);

/** The healed reader itself. */
const EXEMPT_FILES = new Set(["lib/queries/calendar.ts"]);

interface AllowEntry {
  file: string;
  /** Substring of the matched SQL (whitespace-collapsed). */
  anchor: string;
  /** Exact number of occurrences in `file` this entry covers. */
  count: number;
  why: string;
}

const ALLOWLIST: AllowEntry[] = [
  {
    file: "lib/calendar/email-sweep.ts",
    anchor: "SELECT actual_value, event_date FROM calendar_events",
    count: 1,
    why: "Presence check only (has this print already reported?) before a preview send. No plausibility decision and the stamp is never read.",
  },
  {
    file: "lib/earnings/actuals.ts",
    anchor: "SELECT id, event_date, release_time, event_time, raw_json, actual_value FROM calendar_events",
    count: 1,
    why: "WRITE path (saveManualActuals): reads the stored figure to merge a manual override into it. It is about to set the stamp, not gate on it.",
  },
  {
    file: "lib/earnings/actuals.ts",
    anchor: "SELECT id, symbol, event_date, event_type, actual_value, manual_actuals_at FROM calendar_events",
    count: 1,
    why: "clearManualActuals needs the row's OWN stamp and the cluster's, separately; it heals through clusterManualActualsAt on the next statement.",
  },
  {
    file: "app/api/earnings/actuals/route.ts",
    anchor: "SELECT id, actual_value, consensus_value, enriched_at, manual_actuals_at, symbol, event_date, event_type FROM calendar_events",
    count: 1,
    why: "Actuals-editor GET: returns the raw stored figure for editing and heals the stamp through clusterManualActualsAt in the response.",
  },
  {
    file: "lib/calendar/cloud-reconcile.ts",
    anchor: "SELECT id, reaction_snapshot, consensus_value, consensus_estimate, enriched_at, actual_value, event_type, symbol FROM calendar_events",
    count: 1,
    why: "WRITE path (Worker → Mac reconcile): reads the stored row to decide whether a cloud payload may fill an EMPTY actual. Never reads the acceptance stamp.",
  },
  {
    file: "lib/calendar/enrichment-runner.ts",
    anchor: "actual_value, reaction_snapshot, enrichment_attempted_at",
    count: 2,
    why: "WRITE path (post-release enrichment): candidate loaders that check whether an actual is still missing before fetching one. Never read the acceptance stamp or render a figure.",
  },
  {
    file: "lib/earnings/worksheet.ts",
    anchor: "SELECT * FROM calendar_events",
    count: 3,
    why: "Pre-print worksheet loaders (consensus, bogeys, intel). The module reads neither actual_value nor manual_actuals_at — a source pin below fails if it starts to.",
  },
];

function collect(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (EXCLUDED_SEGMENTS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Drop block comments and whole-line `//` comments (prose about the pattern). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

const BY_ID_SELECT_RE =
  /\bSELECT\b((?:(?!\bSELECT\b)[\s\S])*?)\bFROM\s+calendar_events(?:\s+(?:AS\s+)?(?!WHERE\b)\w+)?\s+WHERE\s+(?:\w+\.)?id\s*=\s*\?/gi;
const ACTUALS_IN_LIST_RE = /\*|\bactual_value\b|\bmanual_actuals_at\b/i;

/** Every by-id actuals read in `src`, as whitespace-collapsed SQL. */
function findActualsReadsById(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(BY_ID_SELECT_RE)) {
    if (ACTUALS_IN_LIST_RE.test(m[1])) out.push(m[0].replace(/\s+/g, " ").trim());
  }
  return out;
}

describe("detector self-test", () => {
  it("flags SELECT * and explicit actuals columns read by id", () => {
    expect(findActualsReadsById("db.prepare(`SELECT * FROM calendar_events WHERE id = ?`)")).toHaveLength(1);
    expect(
      findActualsReadsById("db.prepare(`SELECT symbol,\n  actual_value\n  FROM calendar_events\n WHERE id = ?`)"),
    ).toHaveLength(1);
    expect(
      findActualsReadsById('db.prepare("SELECT e.manual_actuals_at FROM calendar_events e WHERE e.id = ?")'),
    ).toHaveLength(1);
  });

  it("ignores by-id reads of other columns, non-id reads, and comments", () => {
    expect(findActualsReadsById("db.prepare(`SELECT symbol, event_date FROM calendar_events WHERE id = ?`)")).toEqual([]);
    expect(findActualsReadsById("db.prepare(`SELECT * FROM calendar_events WHERE week_of = ?`)")).toEqual([]);
    expect(findActualsReadsById("// SELECT * FROM calendar_events WHERE id = ?\n")).toEqual([]);
    expect(findActualsReadsById("/** `SELECT * FROM calendar_events WHERE id = ?` */")).toEqual([]);
  });

  it("does not let an earlier unrelated SELECT lend its column list", () => {
    const src =
      "a(`SELECT actual_value FROM other WHERE x = ?`); b(`SELECT symbol FROM calendar_events WHERE id = ?`)";
    expect(findActualsReadsById(src)).toEqual([]);
  });
});

describe("calendar-event actuals are read by id through getEventById", () => {
  const found = new Map<string, string[]>();
  for (const root of SCAN_ROOTS) {
    for (const full of collect(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      if (EXEMPT_FILES.has(rel)) continue;
      const hits = findActualsReadsById(fs.readFileSync(full, "utf8"));
      if (hits.length > 0) found.set(rel, hits);
    }
  }

  it("the healed reader exists and heals", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "lib/queries/calendar.ts"), "utf8");
    const start = anchorIndex(src, "export function getEventById(");
    if (start === -1) throw new Error("getEventById is missing from lib/queries/calendar.ts");
    const body = src.slice(start, anchorIndex(src, "\n}\n", start));
    expect(body).toContain("withClusterManualActuals(");
    expect(findActualsReadsById(src)).toHaveLength(1);
  });

  it("every by-id actuals read outside the healed reader is allowlisted with a justification", () => {
    const problems: string[] = [];
    for (const [file, hits] of found) {
      const entries = ALLOWLIST.filter((e) => e.file === file);
      for (const hit of hits) {
        if (!entries.some((e) => hit.includes(e.anchor))) {
          problems.push(
            `${file}: hand-rolled by-id actuals read — use getEventById(db, id) from @/lib/queries/calendar ` +
              `(it heals manual_actuals_at across the print's twin cluster), or allowlist it with a justification.\n    ${hit}`,
          );
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("no allowlist entry is stale or covers more reads than it declares", () => {
    const problems: string[] = [];
    for (const e of ALLOWLIST) {
      expect(e.why.length, `${e.file}: justification required`).toBeGreaterThan(20);
      const n = (found.get(e.file) ?? []).filter((h) => h.includes(e.anchor)).length;
      if (n !== e.count) {
        problems.push(`${e.file}: "${e.anchor}" expected ${e.count} occurrence(s), found ${n}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("the worksheet loaders, allowlisted as not reading actuals, still do not", () => {
    const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, "lib/earnings/worksheet.ts"), "utf8"));
    expect(src).not.toMatch(/\bactual_value\b|\bmanual_actuals_at\b/);
  });
});
