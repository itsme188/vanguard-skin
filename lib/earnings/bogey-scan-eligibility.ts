import type Database from "better-sqlite3";

/**
 * Which newsletter articles may be bogey-scanned.
 *
 * Owner rulings:
 *   - 2026-11-02: "as a rule, let's only look for bogeys in TMT Breakout."
 *   - 2026-11-17: FundaAI's "Preview" posts are scanned too. Its other post
 *     types (Weekly, Deep, Research, Review, Column) are not.
 *   - 2026-11-18: the owner chooses per newsletter in Manage Sources (Off, All
 *     posts, Previews only). The two rulings above are the DEFAULTS, used until
 *     the first choice is saved.
 *
 * ONE gate for every path that reads an article for bogey figures: the global
 * scan (extract-newsletter-bogeys.ts), the per-event rescan prepare step and
 * the armed-event deep read. It decides WHICH ARTICLES are eligible; it never
 * changes how many events an eligible article is scanned against (one TMT
 * email often batches several companies' bogeys).
 *
 * Rules live in the `settings` row `bogey_scan_sources` as a JSON object keyed
 * by `research_sources.id`: `{ "<id>": "all" | "previews" }`; an absent id is
 * off. Keying by id means a renamed source keeps its rule and a new source
 * starts off. Before the first save (or when the row cannot be read) the rules
 * are derived from source NAMES: every TMT Breakout spelling ('TMT Breakouts',
 * migration 019; 'TMT Breakout', migration 024) is all posts, FundaAI is
 * previews only. The first save writes the whole resolved map, so from then on
 * the defaults are id-keyed too. A changed rule is prospective: the automatic
 * readers follow it on their next run. Enrichment/summarization is NOT gated.
 */
export type BogeyScanMode = "off" | "all" | "previews";

/** A source's rule when it is on. A source missing from the map is off. */
export type BogeyScanRule = Exclude<BogeyScanMode, "off">;

export type BogeyScanRules = Map<number, BogeyScanRule>;

export const BOGEY_SCAN_SETTINGS_KEY = "bogey_scan_sources";

export const BOGEY_SCAN_MODES: readonly BogeyScanMode[] = ["off", "all", "previews"];

/** Default (no saved rules): sources scanned for every post, by lower(trim(name)). */
export const DEFAULT_ALL_SOURCE_NAMES = ["tmt breakout", "tmt breakouts"] as const;

/**
 * Default (no saved rules): sources scanned only for a post whose subject
 * starts with "Preview" and a bar, the way FundaAI titles a pre-print note
 * ("Preview|ACME FY27Q3: ..."). Spaces are ignored and case does not matter,
 * so "Preview | X" passes too.
 */
export const DEFAULT_PREVIEW_SOURCE_NAMES = ["fundaai"] as const;

const PREVIEW_SUBJECT_PREFIX = "preview|";

/** Thrown by {@link setBogeyScanMode} for a source id with no row. */
export class UnknownBogeyScanSourceError extends Error {
  constructor(sourceId: number) {
    super(`No newsletter source has id ${sourceId}.`);
    this.name = "UnknownBogeyScanSourceError";
  }
}

export function isBogeyScanMode(value: unknown): value is BogeyScanMode {
  return typeof value === "string" && (BOGEY_SCAN_MODES as readonly string[]).includes(value);
}

function isRule(value: unknown): value is BogeyScanRule {
  return value === "all" || value === "previews";
}

/** A positive integer written plainly ("8", never "08", "8.0" or "-8"). */
const ID_KEY = /^[1-9][0-9]*$/;

/** The stored map, or null when the row is missing or not a valid rule map. */
function readStoredRules(db: Database.Database): BogeyScanRules | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(BOGEY_SCAN_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = undefined;
  }
  const rules: BogeyScanRules = new Map();
  let valid = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (valid) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key);
      if (!ID_KEY.test(key) || !Number.isSafeInteger(id) || !isRule(value)) {
        valid = false;
        break;
      }
      rules.set(id, value);
    }
  }
  if (!valid) {
    // Content-free: the key name only, never the stored value.
    console.warn(
      `[bogey-scan] settings "${BOGEY_SCAN_SETTINGS_KEY}" is not a valid rule map; using the default sources`,
    );
    return null;
  }
  return rules;
}

/**
 * The rules in force: the saved map limited to sources that still exist, or
 * the name defaults when nothing valid is saved. Never "scan everything".
 */
export function getBogeyScanRules(db: Database.Database): BogeyScanRules {
  const sources = db.prepare(`SELECT id, name FROM research_sources ORDER BY id`).all() as Array<{
    id: number;
    name: string | null;
  }>;
  const stored = readStoredRules(db);
  const rules: BogeyScanRules = new Map();
  if (stored) {
    for (const s of sources) {
      const rule = stored.get(s.id);
      if (rule) rules.set(s.id, rule);
    }
    return rules;
  }
  for (const s of sources) {
    const name = (s.name ?? "").trim().toLowerCase();
    if ((DEFAULT_ALL_SOURCE_NAMES as readonly string[]).includes(name)) rules.set(s.id, "all");
    else if ((DEFAULT_PREVIEW_SOURCE_NAMES as readonly string[]).includes(name)) rules.set(s.id, "previews");
  }
  return rules;
}

/**
 * Set one source's mode. Writes the WHOLE resolved map (so the name defaults
 * become id-keyed on the first save) and drops every "off" entry.
 */
export function setBogeyScanMode(db: Database.Database, sourceId: number, mode: BogeyScanMode): void {
  if (!isBogeyScanMode(mode)) throw new Error(`Unknown bogey scan mode: ${String(mode)}`);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) throw new UnknownBogeyScanSourceError(sourceId);
  const write = db.transaction(() => {
    const exists = db.prepare(`SELECT 1 FROM research_sources WHERE id = ?`).get(sourceId);
    if (!exists) throw new UnknownBogeyScanSourceError(sourceId);
    const rules = getBogeyScanRules(db);
    if (mode === "off") rules.delete(sourceId);
    else rules.set(sourceId, mode);
    const out: Record<string, BogeyScanRule> = {};
    for (const id of [...rules.keys()].sort((a, b) => a - b)) out[String(id)] = rules.get(id)!;
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(BOGEY_SCAN_SETTINGS_KEY, JSON.stringify(out));
  });
  write();
}

export interface BogeyScanSourceRow {
  id: number;
  name: string;
  is_active: number;
  mode: BogeyScanMode;
}

/** Every source with its mode, for the Manage Sources switch. */
export function listBogeyScanSources(db: Database.Database): BogeyScanSourceRow[] {
  const rules = getBogeyScanRules(db);
  const rows = db
    .prepare(`SELECT id, name, is_active FROM research_sources ORDER BY name COLLATE NOCASE, id`)
    .all() as Array<{ id: number; name: string; is_active: number }>;
  return rows.map((r) => ({ ...r, mode: rules.get(r.id) ?? "off" }));
}

function isPreviewSubject(subject: string | null | undefined): boolean {
  // Only U+0020 is removed, to match SQLite's replace(..., ' ', '') exactly.
  return (subject ?? "").toLowerCase().split(" ").join("").startsWith(PREVIEW_SUBJECT_PREFIX);
}

/** JS twin of {@link bogeyScanSourceSql} (parity-pinned in tests). */
export function isBogeyScanArticle(
  rules: BogeyScanRules,
  sourceId: number,
  subject: string | null | undefined,
): boolean {
  const rule = rules.get(sourceId);
  if (rule === "all") return true;
  if (rule === "previews") return isPreviewSubject(subject);
  return false;
}

/** `rs.id IN (...)`, or `0` for an empty list. Ids are checked integers. */
function idInSql(ids: number[]): string {
  const safe = ids.filter((id) => Number.isSafeInteger(id) && id > 0);
  return safe.length === 0 ? "0" : `rs.id IN (${safe.join(", ")})`;
}

/**
 * SQL predicate over a `research_sources` row aliased `rs` joined to its
 * `research_articles` row aliased `a`, for the given rules. AND it into any
 * query that selects articles for a bogey scan. `substr` (not LIKE) keeps the
 * prefix test exact: no wildcard characters, no case-folding setting.
 */
export function bogeyScanSourceSqlForRules(rules: BogeyScanRules): string {
  const all: number[] = [];
  const previews: number[] = [];
  for (const [id, rule] of rules) (rule === "all" ? all : previews).push(id);
  all.sort((a, b) => a - b);
  previews.sort((a, b) => a - b);
  return `(${idInSql(all)}
  OR (${idInSql(previews)}
      AND substr(replace(lower(COALESCE(a.subject, '')), ' ', ''), 1, ${PREVIEW_SUBJECT_PREFIX.length}) = '${PREVIEW_SUBJECT_PREFIX}'))`;
}

/** The gate predicate for the rules currently in force (reads settings). */
export function bogeyScanSourceSql(db: Database.Database): string {
  return bogeyScanSourceSqlForRules(getBogeyScanRules(db));
}
