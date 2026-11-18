/**
 * The bogey-scan gate reads its rules from the `settings` row
 * `bogey_scan_sources` (owner ruling 2026-11-18), keyed by source id. With no
 * readable row, the defaults are the earlier owner rulings by name:
 * 2026-11-02 (TMT Breakout, every post) and 2026-11-17 (FundaAI, "Preview"
 * posts only). Synthetic source names besides those two.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  BOGEY_SCAN_SETTINGS_KEY,
  DEFAULT_ALL_SOURCE_NAMES,
  DEFAULT_PREVIEW_SOURCE_NAMES,
  bogeyScanSourceSql,
  getBogeyScanRules,
  isBogeyScanArticle,
  listBogeyScanSources,
  setBogeyScanMode,
  UnknownBogeyScanSourceError,
} from "@/lib/earnings/bogey-scan-eligibility";

let db: Database.Database;

function addSource(id: number, name: string): number {
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (?, ?)`).run(id, name);
  return id;
}

function storeRaw(value: string): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(BOGEY_SCAN_SETTINGS_KEY, value);
}

function storedJson(): Record<string, string> | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(BOGEY_SCAN_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Record<string, string>) : null;
}

function addArticle(sourceId: number, subject: string): void {
  db.prepare(
    `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text)
     VALUES (?, '2026-11-01 12:00:00', ?, 'letters@example.com', 'body')`,
  ).run(sourceId, subject);
}

const TMT = 11;
const TMT_PLURAL = 12;
const TMT_SPACED = 13;
const FUNDA = 14;
const OTHER = 15;
const OTHER_TWO = 16;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.prepare(`DELETE FROM research_sources`).run();
  addSource(TMT, "TMT Breakout");
  addSource(TMT_PLURAL, "TMT BREAKOUTS");
  addSource(TMT_SPACED, "  tmt breakout ");
  addSource(FUNDA, " FundaAI ");
  addSource(OTHER, "Tape Letter");
  addSource(OTHER_TWO, "FundaAI Weekly");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DEFAULTS = new Map<number, "all" | "previews">([
  [TMT, "all"],
  [TMT_PLURAL, "all"],
  [TMT_SPACED, "all"],
  [FUNDA, "previews"],
]);

describe("getBogeyScanRules", () => {
  it("defaults_when_unset: TMT spellings all posts, FundaAI previews, everything else off", () => {
    expect(getBogeyScanRules(db)).toEqual(DEFAULTS);
  });

  it("defaults_when_json_unreadable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storeRaw("{oops");
    expect(getBogeyScanRules(db)).toEqual(DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("wrong_shape_falls_back (array, bad mode, non-integer key) with one warning each", () => {
    const shapes = [`["x"]`, `{"8":"sometimes"}`, `{"abc":"all"}`, `null`, `"all"`, `{"0":"all"}`, `{"1.5":"all"}`, `{"-3":"all"}`, `{"14":"off"}`, `{"014":"all"}`];
    for (const raw of shapes) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      storeRaw(raw);
      expect(getBogeyScanRules(db), raw).toEqual(DEFAULTS);
      expect(warn, raw).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  });

  it("an empty stored map is a real choice: nothing is scanned", () => {
    storeRaw("{}");
    expect(getBogeyScanRules(db).size).toBe(0);
  });

  it("first_save_materialises_defaults: the whole resolved map is written id-keyed", () => {
    expect(storedJson()).toBeNull();
    setBogeyScanMode(db, OTHER, "previews");
    expect(storedJson()).toEqual({
      [String(TMT)]: "all",
      [String(TMT_PLURAL)]: "all",
      [String(TMT_SPACED)]: "all",
      [String(FUNDA)]: "previews",
      [String(OTHER)]: "previews",
    });
  });

  it("setting a source off drops its entry", () => {
    setBogeyScanMode(db, TMT_PLURAL, "off");
    expect(storedJson()).not.toHaveProperty(String(TMT_PLURAL));
    expect(getBogeyScanRules(db).has(TMT_PLURAL)).toBe(false);
    expect(getBogeyScanRules(db).get(TMT)).toBe("all");
  });

  it("rename_keeps_rule: once saved, a rule follows the source id, not its name", () => {
    setBogeyScanMode(db, FUNDA, "all");
    db.prepare(`UPDATE research_sources SET name = 'Renamed Letter' WHERE id = ?`).run(FUNDA);
    expect(getBogeyScanRules(db).get(FUNDA)).toBe("all");
  });

  it("deleted_id_ignored: a stored rule for a source that no longer exists is dropped", () => {
    setBogeyScanMode(db, OTHER, "all");
    db.prepare(`DELETE FROM research_sources WHERE id = ?`).run(OTHER);
    const rules = getBogeyScanRules(db);
    expect(rules.has(OTHER)).toBe(false);
    expect(rules.get(TMT)).toBe("all");
    // A later save does not carry the deleted id forward either.
    setBogeyScanMode(db, OTHER_TWO, "all");
    expect(storedJson()).not.toHaveProperty(String(OTHER));
  });

  it("a new source defaults to off once rules are saved, whatever its name", () => {
    setBogeyScanMode(db, OTHER, "all");
    addSource(40, "TMT Breakout");
    expect(getBogeyScanRules(db).has(40)).toBe(false);
  });
});

describe("setBogeyScanMode", () => {
  it("throws UnknownBogeyScanSourceError on an unknown id and writes nothing", () => {
    expect(() => setBogeyScanMode(db, 999, "all")).toThrow(UnknownBogeyScanSourceError);
    expect(storedJson()).toBeNull();
  });

  it("refuses a mode outside the three and writes nothing", () => {
    expect(() => setBogeyScanMode(db, TMT, "sometimes" as never)).toThrow();
    expect(storedJson()).toBeNull();
  });
});

describe("listBogeyScanSources", () => {
  it("lists every source with its mode", () => {
    const list = listBogeyScanSources(db);
    expect(list).toHaveLength(6);
    const modeOf = new Map(list.map((s) => [s.id, s.mode]));
    expect(modeOf.get(TMT)).toBe("all");
    expect(modeOf.get(TMT_PLURAL)).toBe("all");
    expect(modeOf.get(FUNDA)).toBe("previews");
    expect(modeOf.get(OTHER)).toBe("off");
    expect(modeOf.get(OTHER_TWO)).toBe("off");
    for (const s of list) expect(typeof s.is_active).toBe("number");
  });
});

describe("isBogeyScanArticle and the SQL twin", () => {
  const previewSubjects = [
    "Preview|ACME FY27Q3: Demand Remains Solid",
    "Preview | ACME 3Q26: Data Drama",
    "PREVIEW|ACME",
    "preview |ACME & BETA 3Q26",
  ];
  const nonPreviewSubjects = [
    "Weekly|Thoughts on Short/Mid/Long Terms",
    "Deep|ACME: The Supply Chain",
    "Review|ACME 3Q26: A Clean Quarter",
    "Previewing next week|ACME",
    "Re: Preview|ACME FY27Q3",
    "ACME Preview|notes",
    "Preview",
    "Preview: ACME FY27Q3",
    "",
  ];

  it("an all-posts source passes any subject; a previews source only Preview-bar subjects; off fails", () => {
    const rules = getBogeyScanRules(db);
    for (const s of [...previewSubjects, ...nonPreviewSubjects, null, undefined]) {
      expect(isBogeyScanArticle(rules, TMT, s), `${s}`).toBe(true);
      expect(isBogeyScanArticle(rules, OTHER, s), `${s}`).toBe(false);
    }
    for (const s of previewSubjects) expect(isBogeyScanArticle(rules, FUNDA, s), s).toBe(true);
    for (const s of [...nonPreviewSubjects, null, undefined]) {
      expect(isBogeyScanArticle(rules, FUNDA, s), `${s}`).toBe(false);
    }
  });

  it("sql_and_js_agree over every source and subject, with an exact passing count", () => {
    setBogeyScanMode(db, OTHER_TWO, "previews");
    // research_articles.subject is NOT NULL in the migrated schema; the null
    // subject is checked on the JS side only (SQL COALESCEs it to '').
    const subjects = ["Preview|ACME 3Q", "Preview | ACME", "Weekly|x", "Re: Preview|ACME"];
    const ids = [TMT, TMT_PLURAL, TMT_SPACED, FUNDA, OTHER, OTHER_TWO];
    for (const id of ids) for (const s of subjects) addArticle(id, s);
    const rules = getBogeyScanRules(db);
    const rows = db
      .prepare(
        `SELECT rs.id AS id, a.subject AS subject, (${bogeyScanSourceSql(db)}) AS ok
           FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id`,
      )
      .all() as { id: number; subject: string; ok: number }[];
    expect(rows).toHaveLength(ids.length * subjects.length);
    for (const r of rows) {
      expect(r.ok === 1, `${r.id} / ${r.subject}`).toBe(isBogeyScanArticle(rules, r.id, r.subject));
    }
    // 3 all-posts sources x 4 subjects + 2 previews sources x 2 Preview subjects.
    expect(rows.filter((r) => r.ok === 1)).toHaveLength(3 * 4 + 2 * 2);
    for (const id of ids) {
      expect(isBogeyScanArticle(rules, id, null)).toBe(rules.get(id) === "all");
    }
  });

  it("empty_rules_pass_nothing (SQL and JS)", () => {
    storeRaw("{}");
    addArticle(TMT, "Preview|ACME");
    addArticle(FUNDA, "Preview|ACME");
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id
          WHERE ${bogeyScanSourceSql(db)}`,
      )
      .get() as { n: number };
    expect(n.n).toBe(0);
    expect(isBogeyScanArticle(getBogeyScanRules(db), TMT, "Preview|ACME")).toBe(false);
  });

  it("names every default publication lowercase (compared with lower(trim(name)))", () => {
    for (const n of [...DEFAULT_ALL_SOURCE_NAMES, ...DEFAULT_PREVIEW_SOURCE_NAMES]) {
      expect(n).toBe(n.trim().toLowerCase());
    }
  });
});
