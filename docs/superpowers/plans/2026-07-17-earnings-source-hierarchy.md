# Earnings Source Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the earnings composer's hardcoded equal-weight `PREFERRED_SOURCE_IDS` with a user-editable ranked source hierarchy (DB-backed), rank-ordered article fill, per-source prompt guidance notes, and edition/cross-source dedup.

**Architecture:** Migration 068 adds `earnings_rank` + `earnings_note` to `research_sources` (seeded from the current constant, which is then deleted). `getNewsletterContext` in `lib/digest/send-earnings-email.ts` becomes a rank-ordered fill: one candidate query (all sources) → edition supersedence (`lib/digest/editions.ts`) → rank-then-recency sort → 6-slot fill under existing caps, with a 30-day backstop on zero 7-day hits. `renderNewslettersBlock` renders in that order with once-per-source notes + a dedup instruction. UI is a hierarchy editor in `ManageSourcesModal` via the extended `PATCH /api/research/sources`.

**Tech Stack:** Next.js 16 / React 19 / TypeScript 5, better-sqlite3, Vitest (in-memory DB + `runMigrations`).

**Spec:** `docs/superpowers/specs/2026-07-17-earnings-source-hierarchy-design.md` — read it before starting any task.

## Global Constraints

- All DB reads in `lib/queries/`, writes in `lib/mutations/`; every DB function takes `db: Database.Database` as first param.
- Timestamp comparisons wrap BOTH sides in SQLite `datetime()` (space vs 'T' separator mis-sorts raw strings).
- No Worker changes, no snapshot schema bump — the cloud earnings fallback deliberately has no newsletter context.
- Rank-ordered reads break ties by `id ASC` (server does not enforce rank uniqueness).
- Mutating UI buttons follow the honest-feedback convention: check `res.ok` AND `data.success !== false`, revert optimistic state on failure and say so (existing `mutationError` pattern in ManageSourcesModal).
- Run `npx vitest run` (full suite, ~3600 tests) before the final commit; do not commit failing tests.
- Commit messages end with the Co-Authored-By + Claude-Session trailer used by this session.

---

### Task 1: Migration 068 + hierarchy query

**Files:**
- Create: `lib/db/migrations/068_earnings_source_hierarchy.sql`
- Modify: `lib/queries/research.ts` (extend `ResearchSource` interface; add `getEarningsSourceHierarchy`)
- Test: `tests/queries/earnings-source-hierarchy.test.ts` (create)

**Interfaces:**
- Consumes: existing `runMigrations(db)` from `@/lib/db/migrate`.
- Produces: `getEarningsSourceHierarchy(db): EarningsHierarchySource[]` where `EarningsHierarchySource = { id: number; name: string; earnings_rank: number; earnings_note: string | null }` (exported interface). `ResearchSource` gains `earnings_rank: number | null; earnings_note: string | null` (flows through `getResearchSources`'s `SELECT s.*` automatically). Tasks 2–5 rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `tests/queries/earnings-source-hierarchy.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEarningsSourceHierarchy } from "@/lib/queries/research";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSource(name: string, rank: number | null, note: string | null = null): number {
  const res = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active, earnings_rank, earnings_note) VALUES (?, ?, 1, ?, ?)"
    )
    .run(name, `${name.toLowerCase().replace(/\s+/g, "")}@example.com`, rank, note);
  return res.lastInsertRowid as number;
}

describe("getEarningsSourceHierarchy", () => {
  it("returns only ranked sources, ordered by rank ascending", () => {
    seedSource("Unranked Letter", null);
    seedSource("Third", 3);
    seedSource("First", 1, "Bogies tables — quote exact numbers.");
    seedSource("Second", 2);

    const rows = getEarningsSourceHierarchy(db);
    expect(rows.map((r) => r.name)).toEqual(["First", "Second", "Third"]);
    expect(rows[0].earnings_note).toBe("Bogies tables — quote exact numbers.");
    expect(rows[1].earnings_note).toBeNull();
  });

  it("breaks duplicate ranks by id ascending", () => {
    const a = seedSource("Dup A", 2);
    const b = seedSource("Dup B", 2);
    const rows = getEarningsSourceHierarchy(db);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
  });

  it("returns empty array when nothing is ranked", () => {
    seedSource("Only Unranked", null);
    expect(getEarningsSourceHierarchy(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/earnings-source-hierarchy.test.ts`
Expected: FAIL — `getEarningsSourceHierarchy` is not exported (and/or the columns don't exist yet).

- [ ] **Step 3: Create the migration**

Create `lib/db/migrations/068_earnings_source_hierarchy.sql`:

```sql
-- Migration 068: earnings source hierarchy (spec 2026-07-17).
-- earnings_rank non-NULL = source is in the earnings composer's trust-ordered
-- hierarchy (1 = highest). NULL = general pool (still eligible to fill
-- remaining slots — see getNewsletterContext rank-ordered fill).
-- earnings_note = per-source "how to read this" guidance injected once per
-- source into the earnings preview/recap prompt.
--
-- The seed UPDATEs transfer ownership from the deleted PREFERRED_SOURCE_IDS
-- constant in lib/digest/send-earnings-email.ts to the DB. They are id-guarded
-- and no-op harmlessly on DBs without those rows (test DBs, fresh installs).

ALTER TABLE research_sources ADD COLUMN earnings_rank INTEGER;
ALTER TABLE research_sources ADD COLUMN earnings_note TEXT;

UPDATE research_sources SET earnings_rank = 1 WHERE id = 1;  -- Vital Knowledge
UPDATE research_sources SET earnings_rank = 2,
       earnings_note = 'Morning Wrap carries sell-side bogies tables — quote exact numbers.'
 WHERE id = 8;                                               -- TMT Breakout
UPDATE research_sources SET earnings_rank = 3 WHERE id = 18; -- Eliant Capital
UPDATE research_sources SET earnings_rank = 4 WHERE id = 19; -- Purple Drink's Market Musings
UPDATE research_sources SET earnings_rank = 5 WHERE id = 28; -- Helene Meisler
```

- [ ] **Step 4: Extend the query layer**

In `lib/queries/research.ts`, add to the `ResearchSource` interface (after `allow_off_topic`):

```ts
  /** Non-NULL = in the earnings composer's trust hierarchy, ascending (migration 068). */
  earnings_rank: number | null;
  /** Per-source "how to read this" prompt guidance for earnings emails. */
  earnings_note: string | null;
```

Add after `getResearchSources`:

```ts
export interface EarningsHierarchySource {
  id: number;
  name: string;
  earnings_rank: number;
  earnings_note: string | null;
}

/**
 * Trust-ordered earnings source hierarchy (migration 068). Only ranked
 * sources; duplicate ranks (possible after a mid-sequence PATCH failure)
 * break by id ASC so ordering stays deterministic.
 */
export function getEarningsSourceHierarchy(
  db: Database.Database
): EarningsHierarchySource[] {
  return db
    .prepare(
      `SELECT id, name, earnings_rank, earnings_note
         FROM research_sources
        WHERE earnings_rank IS NOT NULL
        ORDER BY earnings_rank ASC, id ASC`
    )
    .all() as EarningsHierarchySource[];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/queries/earnings-source-hierarchy.test.ts`
Expected: PASS (3 tests). Also run `npx vitest run tests/queries` to confirm no sibling regressions.

- [ ] **Step 6: Commit**

```bash
git add lib/db/migrations/068_earnings_source_hierarchy.sql lib/queries/research.ts tests/queries/earnings-source-hierarchy.test.ts
git commit -m "feat(earnings): migration 068 — earnings source hierarchy columns + query"
```

---

### Task 2: Mutation allowlist + PATCH validation

**Files:**
- Modify: `lib/mutations/research.ts` (allowlist + `updateSource` types)
- Modify: `app/api/research/sources/route.ts` (PATCH validation)
- Test: `tests/mutations/research-source-hierarchy.test.ts` (create)

**Interfaces:**
- Consumes: migration 068 columns from Task 1.
- Produces: `updateSource(db, id, updates)` accepts `earnings_rank?: number | null` and `earnings_note?: string | null`. `PATCH /api/research/sources` body may include those fields; invalid rank/note → HTTP 400 `{ error }`; a note that trims to empty is stored as NULL. Task 5's UI calls this exact contract.

- [ ] **Step 1: Write the failing test**

Create `tests/mutations/research-source-hierarchy.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { updateSource } from "@/lib/mutations/research";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSource(name: string): number {
  const res = db
    .prepare("INSERT INTO research_sources (name, is_active) VALUES (?, 1)")
    .run(name);
  return res.lastInsertRowid as number;
}

function readSource(id: number): { earnings_rank: number | null; earnings_note: string | null } {
  return db
    .prepare("SELECT earnings_rank, earnings_note FROM research_sources WHERE id = ?")
    .get(id) as { earnings_rank: number | null; earnings_note: string | null };
}

describe("updateSource — earnings hierarchy fields", () => {
  it("sets and clears earnings_rank", () => {
    const id = seedSource("VK");
    updateSource(db, id, { earnings_rank: 2 });
    expect(readSource(id).earnings_rank).toBe(2);
    updateSource(db, id, { earnings_rank: null });
    expect(readSource(id).earnings_rank).toBeNull();
  });

  it("sets and clears earnings_note", () => {
    const id = seedSource("TMT");
    updateSource(db, id, { earnings_note: "Bogies tables." });
    expect(readSource(id).earnings_note).toBe("Bogies tables.");
    updateSource(db, id, { earnings_note: null });
    expect(readSource(id).earnings_note).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mutations/research-source-hierarchy.test.ts`
Expected: FAIL — `earnings_rank` is not in `UPDATABLE_SOURCE_COLUMNS`, so the update silently no-ops and the read returns NULL where 2 is expected.

- [ ] **Step 3: Extend the mutation**

In `lib/mutations/research.ts`, add to `UPDATABLE_SOURCE_COLUMNS`:

```ts
  "earnings_rank",
  "earnings_note",
```

Add to `updateSource`'s `updates` type (after `allow_off_topic`):

```ts
    /** Trust-hierarchy position for earnings emails (migration 068); null removes from hierarchy. */
    earnings_rank?: number | null;
    /** Per-source prompt guidance for earnings emails; null clears. */
    earnings_note?: string | null;
```

- [ ] **Step 4: Add PATCH validation in the route**

In `app/api/research/sources/route.ts`, inside `PATCH` after `const { id, ...updates } = body;` and before `updateSource(...)`:

```ts
  if ("earnings_rank" in updates) {
    const r = updates.earnings_rank;
    if (r !== null && (!Number.isInteger(r) || r < 1)) {
      return Response.json(
        { error: "earnings_rank must be a positive integer or null" },
        { status: 400 }
      );
    }
  }
  if ("earnings_note" in updates) {
    const n = updates.earnings_note;
    if (n !== null && typeof n !== "string") {
      return Response.json(
        { error: "earnings_note must be a string or null" },
        { status: 400 }
      );
    }
    if (typeof n === "string") {
      const trimmed = n.trim();
      updates.earnings_note = trimmed === "" ? null : trimmed;
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mutations/research-source-hierarchy.test.ts`
Expected: PASS. Also `npx vitest run tests/mutations` for sibling regressions.

- [ ] **Step 6: Commit**

```bash
git add lib/mutations/research.ts app/api/research/sources/route.ts tests/mutations/research-source-hierarchy.test.ts
git commit -m "feat(earnings): PATCH /api/research/sources accepts earnings_rank + earnings_note"
```

---

### Task 3: Rank-ordered fill in getNewsletterContext

**Files:**
- Modify: `lib/digest/send-earnings-email.ts` (delete `PREFERRED_SOURCE_IDS`; rewrite `getNewsletterContext`; extend + export `NewsletterEntry`; export `getNewsletterContext`)
- Test: `tests/digest/earnings-newsletter-context.test.ts` (create)

**Interfaces:**
- Consumes: migration 068 columns (Task 1); `classifyEdition(sourceName, subject)` from `@/lib/digest/editions` (returns `{ edition, supersedes: EditionId[] }`).
- Produces: `export function getNewsletterContext(db: Database.Database, family: readonly string[]): NewsletterEntry[]`, and `export interface NewsletterEntry` gaining `earnings_rank: number | null; earnings_note: string | null` (Task 4's renderer reads both). Existing caller `buildContext` (line ~580) is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/digest/earnings-newsletter-context.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getNewsletterContext } from "@/lib/digest/send-earnings-email";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSource(name: string, rank: number | null, note: string | null = null): number {
  const res = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active, earnings_rank, earnings_note) VALUES (?, ?, 1, ?, ?)"
    )
    .run(name, `${name.toLowerCase().replace(/[^a-z]/g, "")}@example.com`, rank, note);
  return res.lastInsertRowid as number;
}

function seedSecurity(symbol: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

/** receivedAt: full ISO or SQLite 'YYYY-MM-DD HH:MM:SS' (UTC). */
function seedArticle(
  sourceId: number,
  securityId: number,
  subject: string,
  receivedAt: string,
  body = "Article body long enough to matter."
): number {
  const res = db
    .prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment, sentiment_score, processed_at)
       VALUES (?, ?, 'x@example.com', ?, ?, 'Summary', 'neutral', 0.1, datetime('now'))`
    )
    .run(sourceId, subject, receivedAt, body);
  const articleId = res.lastInsertRowid as number;
  db.prepare(
    "INSERT INTO research_article_securities (article_id, security_id) VALUES (?, ?)"
  ).run(articleId, securityId);
  return articleId;
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

describe("getNewsletterContext — rank-ordered fill", () => {
  it("admits fresh unranked articles alongside stale ranked ones (starvation fix)", () => {
    const sec = seedSecurity("AAPL");
    const ranked = seedSource("Ranked Letter", 1);
    const unranked = seedSource("Fresh Substack", null);
    seedArticle(ranked, sec, "Old preferred mention", daysAgo(6));
    seedArticle(unranked, sec, "Fresh detailed preview", hoursAgo(2));

    const result = getNewsletterContext(db, ["AAPL"]);
    const names = result.map((r) => r.source_name);
    expect(names).toContain("Ranked Letter");
    expect(names).toContain("Fresh Substack");
    // Ranked source comes first despite being older.
    expect(names[0]).toBe("Ranked Letter");
  });

  it("orders ranked sources by rank, then unranked, recency desc within", () => {
    const sec = seedSecurity("NVDA");
    const r2 = seedSource("Rank Two", 2);
    const r1 = seedSource("Rank One", 1);
    const un = seedSource("Pool Letter", null);
    seedArticle(un, sec, "Pool note", hoursAgo(1));
    seedArticle(r2, sec, "Second trust", hoursAgo(3));
    seedArticle(r1, sec, "Top trust older", hoursAgo(30));
    seedArticle(r1, sec, "Top trust newer", hoursAgo(4));

    const result = getNewsletterContext(db, ["NVDA"]);
    expect(result.map((r) => r.subject)).toEqual([
      "Top trust newer",
      "Top trust older",
      "Second trust",
      "Pool note",
    ]);
  });

  it("drops same-day superseded editions (VK Dawn dies to the Mid-Day Update)", () => {
    const sec = seedSecurity("MSFT");
    // classifyEdition keys on the exact source name "Vital Knowledge".
    const vk = seedSource("Vital Knowledge", 1);
    // Same ET day: use two timestamps a few hours apart mid-day UTC.
    const base = new Date();
    base.setUTCHours(12, 0, 0, 0); // 08:00 ET — same ET day for both
    const dawnAt = new Date(base.getTime() - 2 * 3600_000).toISOString();
    const middayAt = base.toISOString();
    seedArticle(vk, sec, "Vital Dawn — early look", dawnAt);
    seedArticle(vk, sec, "Mid-Day Market Update", middayAt);

    const result = getNewsletterContext(db, ["MSFT"]);
    const subjects = result.map((r) => r.subject);
    expect(subjects).toContain("Mid-Day Market Update");
    expect(subjects).not.toContain("Vital Dawn — early look");
  });

  it("falls back to 30 days only when the 7-day window is empty", () => {
    const sec = seedSecurity("TSM");
    const src = seedSource("Ranked Letter", 1);
    seedArticle(src, sec, "Two weeks old", daysAgo(14));
    const result = getNewsletterContext(db, ["TSM"]);
    expect(result.map((r) => r.subject)).toEqual(["Two weeks old"]);
  });

  it("caps at 6 articles, ranked sources winning the slots", () => {
    const sec = seedSecurity("AMD");
    const r1 = seedSource("Rank One", 1);
    const un = seedSource("Pool Letter", null);
    for (let i = 0; i < 5; i++) seedArticle(r1, sec, `Ranked ${i}`, hoursAgo(i + 1));
    for (let i = 0; i < 5; i++) seedArticle(un, sec, `Pool ${i}`, hoursAgo(i + 1));

    const result = getNewsletterContext(db, ["AMD"]);
    expect(result).toHaveLength(6);
    expect(result.filter((r) => r.source_name === "Rank One")).toHaveLength(5);
    expect(result.filter((r) => r.source_name === "Pool Letter")).toHaveLength(1);
  });

  it("carries earnings_note + earnings_rank onto entries", () => {
    const sec = seedSecurity("GOOG");
    const src = seedSource("TMT Breakout", 2, "Bogies tables — quote exact numbers.");
    seedArticle(src, sec, "Morning Wrap", hoursAgo(2));
    const [entry] = getNewsletterContext(db, ["GOOG"]);
    expect(entry.earnings_rank).toBe(2);
    expect(entry.earnings_note).toBe("Bogies tables — quote exact numbers.");
  });

  it("returns [] for an empty family", () => {
    expect(getNewsletterContext(db, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/digest/earnings-newsletter-context.test.ts`
Expected: FAIL — `getNewsletterContext` is not exported.

- [ ] **Step 3: Rewrite the selection**

In `lib/digest/send-earnings-email.ts`:

1. Delete the `PREFERRED_SOURCE_IDS` constant (lines ~40–50) and its explanatory comment.
2. Add `import { classifyEdition } from "@/lib/digest/editions";` to the imports.
3. Extend and export `NewsletterEntry` (currently module-private, line ~486):

```ts
export interface NewsletterEntry {
  source_name: string;
  subject: string;
  received_at: string;
  body: string;
  sentiment: string | null;
  sentiment_score: number | null;
  source_id: number;
  earnings_rank: number | null;
  earnings_note: string | null;
}
```

4. Replace the whole `getNewsletterContext` function (and its `NewsletterRow` helper interface) with:

```ts
interface CandidateRow {
  id: number;
  source_id: number;
  source_name: string;
  earnings_rank: number | null;
  earnings_note: string | null;
  subject: string;
  received_at: string;
  raw_text: string | null;
  summary: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
}

const MAX_NEWSLETTER_ARTICLES = 6;
const CANDIDATE_FETCH_LIMIT = 30;

/** ET calendar day of a received_at timestamp (ISO or SQLite space format, UTC). */
function receivedAtEtDay(receivedAt: string): string {
  const iso = receivedAt.includes("T")
    ? receivedAt
    : receivedAt.replace(" ", "T") + (receivedAt.endsWith("Z") ? "" : "Z");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return receivedAt.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(d);
}

/**
 * Same-source same-ET-day edition supersedence: a VK Dawn dies to the
 * Mid-Day Update (lib/digest/editions.ts). Runs BEFORE the fill loop so
 * no slot or cap budget is spent on an article we're about to discard.
 */
function dropSupersededEditions(rows: CandidateRow[]): CandidateRow[] {
  const groups = new Map<string, CandidateRow[]>();
  for (const r of rows) {
    const key = `${r.source_id}|${receivedAtEtDay(r.received_at)}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const dropped = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const infos = group.map((r) => ({
      r,
      info: classifyEdition(r.source_name, r.subject),
    }));
    for (const { r, info } of infos) {
      const superseded = infos.some(
        (other) =>
          other.r.id !== r.id && other.info.supersedes.includes(info.edition)
      );
      if (superseded) dropped.add(r.id);
    }
  }
  return rows.filter((r) => !dropped.has(r.id));
}

/**
 * Rank-ordered fill (spec 2026-07-17): one candidate query over ALL sources
 * carrying the source's hierarchy rank, edition supersedence, then ranked
 * sources first (rank asc, id asc on duplicate ranks) / unranked after,
 * recency desc within — unranked articles fill remaining slots instead of
 * requiring the ranked tier to be empty (the old starvation bug).
 * Exported for tests.
 */
export function getNewsletterContext(
  db: Database.Database,
  family: readonly string[],
): NewsletterEntry[] {
  if (family.length === 0) return [];
  const placeholders = family.map(() => "?").join(",");
  const upperFamily = family.map((s) => s.toUpperCase());

  const fetchWindow = (days: 7 | 30): CandidateRow[] =>
    db
      .prepare(
        `SELECT a.id, a.source_id, rs.name AS source_name,
                rs.earnings_rank, rs.earnings_note,
                a.subject, a.received_at, a.raw_text, a.summary,
                a.sentiment, a.sentiment_score
           FROM research_articles a
           JOIN research_article_securities ras ON ras.article_id = a.id
           JOIN securities s ON s.id = ras.security_id
           JOIN research_sources rs ON rs.id = a.source_id
          WHERE UPPER(s.symbol) IN (${placeholders})
            AND datetime(a.received_at) >= datetime('now', '-${days} days')
            AND a.processed_at IS NOT NULL
            AND COALESCE(a.is_relevant, 1) = 1
          GROUP BY a.id
          ORDER BY a.received_at DESC
          LIMIT ${CANDIDATE_FETCH_LIMIT}`,
      )
      .all(...upperFamily) as CandidateRow[];

  // 7-day window; zero candidates → 30-day backstop (old tier-2 semantics).
  let rows = fetchWindow(7);
  if (rows.length === 0) rows = fetchWindow(30);

  rows = dropSupersededEditions(rows);

  const UNRANKED = Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => {
    const ra = a.earnings_rank ?? UNRANKED;
    const rb = b.earnings_rank ?? UNRANKED;
    if (ra !== rb) return ra - rb;
    // Duplicate ranks across two sources: deterministic source id tie-break.
    if (ra !== UNRANKED && a.source_id !== b.source_id)
      return a.source_id - b.source_id;
    const ta = a.received_at;
    const tb = b.received_at;
    if (ta !== tb) return ta < tb ? 1 : -1; // recency desc
    return b.id - a.id;
  });

  let totalChars = 0;
  const result: NewsletterEntry[] = [];
  for (const r of rows) {
    if (result.length >= MAX_NEWSLETTER_ARTICLES) break;
    const fullText = r.raw_text || r.summary || "";
    const body =
      fullText.length > ARTICLE_BODY_CAP
        ? fullText.slice(0, ARTICLE_BODY_CAP) + "\n[...truncated...]"
        : fullText;
    if (totalChars + body.length > TOTAL_CONTEXT_CAP) break;
    totalChars += body.length;
    result.push({
      source_name: r.source_name,
      subject: r.subject,
      received_at: r.received_at,
      body,
      sentiment: r.sentiment,
      sentiment_score: r.sentiment_score,
      source_id: r.source_id,
      earnings_rank: r.earnings_rank,
      earnings_note: r.earnings_note,
    });
  }
  return result;
}
```

Note: the sort comparator compares `received_at` strings directly. Mixed `T`/space formats from different write paths sort inconsistently — normalize both sides via `receivedAtEtDay`-style replacement is NOT enough (loses time). Use this exact comparator instead if the direct compare proves flaky in tests: `Date.parse(ta.includes("T") ? ta : ta.replace(" ", "T") + "Z")`. Prefer the simple string compare first; all real rows in one DB come from the same writers and tests use ISO throughout.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/digest/earnings-newsletter-context.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the composer's sibling tests**

Run: `npx vitest run tests/digest`
Expected: PASS — the old two-tier behavior had no direct test pins; any failure here is a regression to investigate, not to paper over.

- [ ] **Step 6: Commit**

```bash
git add lib/digest/send-earnings-email.ts tests/digest/earnings-newsletter-context.test.ts
git commit -m "feat(earnings): rank-ordered newsletter fill replaces PREFERRED_SOURCE_IDS two-tier"
```

---

### Task 4: Prompt rendering — notes, trust-order framing, dedup instruction

**Files:**
- Modify: `lib/digest/send-earnings-email.ts` (`renderNewslettersBlock`, line ~1461; export it)
- Test: `tests/digest/earnings-newsletter-render.test.ts` (create)

**Interfaces:**
- Consumes: `NewsletterEntry` with `earnings_rank`/`earnings_note` (Task 3).
- Produces: `export function renderNewslettersBlock(ctx, phase)` — exported for tests only; `buildContext`/prompt assembly unchanged. The function still takes the full `PreviewContext`, but tests may pass a minimal object cast via `{ symbol, recentArticles } as Parameters<typeof renderNewslettersBlock>[0]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/digest/earnings-newsletter-render.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderNewslettersBlock } from "@/lib/digest/send-earnings-email";

type Ctx = Parameters<typeof renderNewslettersBlock>[0];

function mkEntry(over: Partial<Ctx["recentArticles"][number]> = {}) {
  return {
    source_name: "TMT Breakout",
    subject: "Morning Wrap",
    received_at: "2026-07-16T10:12:00.000Z",
    body: "Body text.",
    sentiment: "neutral" as string | null,
    sentiment_score: null as number | null,
    source_id: 8,
    earnings_rank: 2 as number | null,
    earnings_note: "Bogies tables — quote exact numbers." as string | null,
    ...over,
  };
}

function mkCtx(articles: ReturnType<typeof mkEntry>[]): Ctx {
  return { symbol: "AAPL", recentArticles: articles } as Ctx;
}

describe("renderNewslettersBlock — hierarchy rendering", () => {
  it("renders a source's note once, on its first article only", () => {
    const block = renderNewslettersBlock(
      mkCtx([
        mkEntry({ subject: "Morning Wrap" }),
        mkEntry({ subject: "EOD Wrap", received_at: "2026-07-16T21:00:00.000Z" }),
      ]),
      "preview"
    );
    const occurrences = block.split("How to read this source").length - 1;
    expect(occurrences).toBe(1);
    expect(block).toContain("Bogies tables — quote exact numbers.");
  });

  it("omits the note line for sources without one", () => {
    const block = renderNewslettersBlock(
      mkCtx([mkEntry({ earnings_note: null })]),
      "preview"
    );
    expect(block).not.toContain("How to read this source");
  });

  it("pins the trust-order framing and dedup instruction (preview)", () => {
    const block = renderNewslettersBlock(mkCtx([mkEntry()]), "preview");
    expect(block).toContain("trust order");
    expect(block).toContain("multi-source attribution");
  });

  it("pins the trust-order framing and dedup instruction (recap)", () => {
    const block = renderNewslettersBlock(mkCtx([mkEntry()]), "recap");
    expect(block).toContain("trust order");
    expect(block).toContain("multi-source attribution");
  });

  it("keeps the empty-state web_search fallback", () => {
    const block = renderNewslettersBlock(mkCtx([]), "preview");
    expect(block).toContain("No recent newsletter articles");
    expect(block).toContain("web_search");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/digest/earnings-newsletter-render.test.ts`
Expected: FAIL — `renderNewslettersBlock` is not exported.

- [ ] **Step 3: Rewrite the renderer**

Replace `renderNewslettersBlock` in `lib/digest/send-earnings-email.ts` with (add `export`):

```ts
export function renderNewslettersBlock(
  ctx: PreviewContext,
  phase: "preview" | "recap",
): string {
  if (ctx.recentArticles.length === 0) {
    return `\n## Newsletter coverage\nNo recent newsletter articles mention ${ctx.symbol}. Use web_search to gather sell-side / buy-side commentary instead.\n`;
  }
  const seenNoteSources = new Set<number>();
  const blocks = ctx.recentArticles.map((a) => {
    const sentSuffix = a.sentiment_score != null
      ? ` (sentiment score: ${a.sentiment_score.toFixed(2)})`
      : "";
    let noteLine = "";
    if (a.earnings_note && !seenNoteSources.has(a.source_id)) {
      seenNoteSources.add(a.source_id);
      noteLine = `\n> How to read this source: ${a.earnings_note}`;
    }
    return `### [${a.received_at.slice(0, 16).replace("T", " ")}] ${a.source_name} — ${a.subject}${sentSuffix}${noteLine}\n${a.body}`;
  });
  const phaseFraming = phase === "preview"
    ? `Treat these as **bogies + buy-side / sell-side commentary** — quote authors by name, surface where they disagree, and note any specific numbers (EPS, revenue, segment splits, price targets) they mention.`
    : `These frame how the position was being read *into* the print. Reference them only where they're directly relevant to interpreting the actual.`;
  const framing = `Sources below appear in the user's trust order — when sources conflict, weight the earlier-listed source's framing more heavily, but always surface the disagreement. ${phaseFraming} Where multiple sources make the same factual claim (a bogey, a price target, a sell-side note), collapse it into one statement with multi-source attribution ("VK and TMT Breakout both flag the same whisper") rather than repeating it per source.`;
  return `\n## Newsletter coverage (user's trust-ordered sources)\n${framing}\n\n${blocks.join("\n\n---\n\n")}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/digest/earnings-newsletter-render.test.ts`
Expected: PASS (5 tests). Then `npx vitest run tests/digest` for siblings (the no-dollar-leak prompt test in particular must stay green).

- [ ] **Step 5: Commit**

```bash
git add lib/digest/send-earnings-email.ts tests/digest/earnings-newsletter-render.test.ts
git commit -m "feat(earnings): trust-order newsletter rendering with per-source notes + dedup instruction"
```

---

### Task 5: Hierarchy editor in ManageSourcesModal

**Files:**
- Modify: `app/dashboard/components/ManageSourcesModal.tsx`

**Interfaces:**
- Consumes: `ResearchSource.earnings_rank`/`earnings_note` (Task 1), `PATCH /api/research/sources` contract (Task 2).
- Produces: UI only — no new exports. No unit tests (client component; covered by Task 6 E2E).

- [ ] **Step 1: Add hierarchy state + handlers**

In `ManageSourcesModal.tsx`, after the existing `handleToggleOffTopic` callback, add:

```ts
  // ── Earnings hierarchy (migration 068) ─────────────────────────────
  // Ranked ascending; duplicate ranks (mid-sequence PATCH failure) break
  // by id to match getEarningsSourceHierarchy's ORDER BY.
  const hierarchy = sources
    .filter((s) => s.earnings_rank != null)
    .sort((a, b) => (a.earnings_rank! - b.earnings_rank!) || (a.id - b.id));

  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});

  const patchSource = useCallback(
    async (id: number, fields: Record<string, unknown>): Promise<void> => {
      const res = await fetch("/api/research/sources", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...fields }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error ?? `server returned ${res.status}`);
      }
    },
    []
  );

  /** Write dense 1..N ranks for newOrder, PATCHing only changed rows. */
  const applyRanks = useCallback(
    async (newOrder: ResearchSource[]) => {
      setMutationError(null);
      const prevSources = sources;
      const rankById = new Map(newOrder.map((s, i) => [s.id, i + 1]));
      // Optimistic update
      setSources((prev) =>
        prev.map((s) =>
          rankById.has(s.id) ? { ...s, earnings_rank: rankById.get(s.id)! } : s
        )
      );
      try {
        for (const s of newOrder) {
          const newRank = rankById.get(s.id)!;
          if (s.earnings_rank !== newRank) {
            await patchSource(s.id, { earnings_rank: newRank });
          }
        }
        onSourcesChanged();
      } catch (err) {
        setSources(prevSources);
        setMutationError(
          `Couldn't reorder the earnings hierarchy: ${err instanceof Error ? err.message : "network error"}. The order was reverted — reopen the modal to see the server state.`
        );
      }
    },
    [sources, patchSource, onSourcesChanged]
  );

  const handleAddToHierarchy = useCallback(
    async (sourceId: number) => {
      setMutationError(null);
      const maxRank = hierarchy.reduce(
        (m, s) => Math.max(m, s.earnings_rank ?? 0),
        0
      );
      const newRank = maxRank + 1;
      setSources((prev) =>
        prev.map((s) => (s.id === sourceId ? { ...s, earnings_rank: newRank } : s))
      );
      try {
        await patchSource(sourceId, { earnings_rank: newRank });
        onSourcesChanged();
      } catch (err) {
        setSources((prev) =>
          prev.map((s) => (s.id === sourceId ? { ...s, earnings_rank: null } : s))
        );
        setMutationError(
          `Couldn't add the source to the earnings hierarchy: ${err instanceof Error ? err.message : "network error"}. The change was reverted.`
        );
      }
    },
    [hierarchy, patchSource, onSourcesChanged]
  );

  const handleRemoveFromHierarchy = useCallback(
    async (sourceId: number) => {
      setMutationError(null);
      const prevSources = sources;
      const remaining = hierarchy.filter((s) => s.id !== sourceId);
      setSources((prev) =>
        prev.map((s) => (s.id === sourceId ? { ...s, earnings_rank: null } : s))
      );
      try {
        await patchSource(sourceId, { earnings_rank: null });
        // Renumber survivors to dense 1..N (only changed rows PATCH).
        await applyRanks(remaining);
      } catch (err) {
        setSources(prevSources);
        setMutationError(
          `Couldn't remove the source from the earnings hierarchy: ${err instanceof Error ? err.message : "network error"}. The change was reverted.`
        );
      }
    },
    [sources, hierarchy, patchSource, applyRanks]
  );

  const handleMove = useCallback(
    (sourceId: number, dir: -1 | 1) => {
      const idx = hierarchy.findIndex((s) => s.id === sourceId);
      const swapWith = idx + dir;
      if (idx < 0 || swapWith < 0 || swapWith >= hierarchy.length) return;
      const newOrder = [...hierarchy];
      [newOrder[idx], newOrder[swapWith]] = [newOrder[swapWith], newOrder[idx]];
      void applyRanks(newOrder);
    },
    [hierarchy, applyRanks]
  );

  const handleNoteBlur = useCallback(
    async (sourceId: number) => {
      const draft = noteDrafts[sourceId];
      if (draft === undefined) return;
      const current =
        sources.find((s) => s.id === sourceId)?.earnings_note ?? "";
      const trimmed = draft.trim();
      if (trimmed === current) return;
      setMutationError(null);
      setSources((prev) =>
        prev.map((s) =>
          s.id === sourceId ? { ...s, earnings_note: trimmed || null } : s
        )
      );
      try {
        await patchSource(sourceId, { earnings_note: trimmed || null });
        onSourcesChanged();
      } catch (err) {
        setSources((prev) =>
          prev.map((s) =>
            s.id === sourceId ? { ...s, earnings_note: current || null } : s
          )
        );
        setMutationError(
          `Couldn't save the note: ${err instanceof Error ? err.message : "network error"}. The note was reverted.`
        );
      }
    },
    [noteDrafts, sources, patchSource, onSourcesChanged]
  );
```

- [ ] **Step 2: Render the hierarchy section**

Above the existing source list in the JSX (immediately before the sources `.map(...)` container), add a section styled with the modal's existing token classes (match surrounding markup — `text-ink`, `text-ink-dim`, `border-edge`, `bg-raised`; inspect neighbors and reuse):

```tsx
        {/* Earnings source hierarchy (migration 068) — trust order for the
            earnings preview/recap composer. */}
        <div className="mb-4 rounded border border-edge bg-raised p-3">
          <div className="mb-1 text-sm font-medium text-ink">
            Earnings source hierarchy
          </div>
          <p className="mb-2 text-xs text-ink-dim">
            Trust order for earnings emails — higher sources win prompt priority.
            The note tells the AI how to read each source.
          </p>
          {hierarchy.length === 0 ? (
            <p className="text-xs italic text-ink-faint">
              No ranked sources. Use “+ earnings” on a source below to add it.
            </p>
          ) : (
            <ul className="space-y-2">
              {hierarchy.map((s, i) => (
                <li key={s.id} className="flex items-start gap-2">
                  <span className="mt-1 w-5 shrink-0 text-right font-mono text-xs text-ink-faint">
                    {i + 1}.
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-ink">{s.name}</span>
                      <button
                        type="button"
                        onClick={() => handleMove(s.id, -1)}
                        disabled={i === 0}
                        aria-label={`Move ${s.name} up`}
                        className="relative rounded border border-edge px-1.5 py-0.5 text-xs text-ink-dim hover:text-ink disabled:opacity-30 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-['']"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(s.id, 1)}
                        disabled={i === hierarchy.length - 1}
                        aria-label={`Move ${s.name} down`}
                        className="relative rounded border border-edge px-1.5 py-0.5 text-xs text-ink-dim hover:text-ink disabled:opacity-30 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-['']"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveFromHierarchy(s.id)}
                        aria-label={`Remove ${s.name} from earnings hierarchy`}
                        className="relative rounded border border-edge px-1.5 py-0.5 text-xs text-ink-dim hover:text-down pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-['']"
                      >
                        remove
                      </button>
                    </div>
                    <input
                      type="text"
                      value={noteDrafts[s.id] ?? s.earnings_note ?? ""}
                      onChange={(e) =>
                        setNoteDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))
                      }
                      onBlur={() => void handleNoteBlur(s.id)}
                      placeholder="How to read this source (optional prompt note)"
                      className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
```

- [ ] **Step 3: Add the "+ earnings" chip to unranked source rows**

In the main source-row markup, next to the existing off-topic chip button (the `handleToggleOffTopic` button around line 292), add — visible only when the source is NOT ranked:

```tsx
                      {s.earnings_rank == null && (
                        <button
                          type="button"
                          onClick={() => void handleAddToHierarchy(s.id)}
                          aria-label={`Add ${s.name} to earnings hierarchy`}
                          className="relative rounded border border-edge px-1.5 py-0.5 text-[11px] font-medium text-ink-dim hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-['']"
                        >
                          + earnings
                        </button>
                      )}
```

Match the exact class idiom of the neighboring off-topic chip (read the surrounding code and mirror its classes; the snippet above is the fallback if the neighbor's idiom diverges). Keep the touch hit-extension (`pointer-coarse:after:…` narrow asymmetric form) because these buttons sit within ~12px of interactive neighbors.

- [ ] **Step 4: Verify compile + lint**

Run: `npx next build 2>&1 | tail -20` (or at minimum `npx tsc --noEmit` if a full build is too slow mid-task)
Expected: no type errors in `ManageSourcesModal.tsx`.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/components/ManageSourcesModal.tsx
git commit -m "feat(earnings): hierarchy editor in ManageSourcesModal — add/reorder/remove + prompt notes"
```

---

### Task 6: Full suite, E2E verification, docs

**Files:**
- Modify: `CLAUDE.md` (conventions bullet), `docs/plans/TODO.md` (check off the item)
- Scratch (not committed): a read-only inspection script in the session scratchpad

**Interfaces:**
- Consumes: everything above.
- Produces: verified feature + updated docs.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass (~3620+). Report the exact count. Do not proceed on failures.

- [ ] **Step 2: Real-DB selection sanity check (read-only)**

Write an inspection script to the session scratchpad (NOT the repo):

```ts
// <scratchpad>/inspect-hierarchy.ts — run FROM THE REPO ROOT:
//   npx tsx --tsconfig tsconfig.json <scratchpad>/inspect-hierarchy.ts
import Database from "better-sqlite3";
import { getEarningsSourceHierarchy } from "@/lib/queries/research";
import { getNewsletterContext } from "@/lib/digest/send-earnings-email";

const db = new Database("data/vanguard.db", { readonly: true });
console.log("Hierarchy:", getEarningsSourceHierarchy(db));
const entries = getNewsletterContext(db, ["AAPL"]);
console.log(
  entries.map((e) => ({
    src: e.source_name,
    rank: e.earnings_rank,
    subj: e.subject.slice(0, 60),
    at: e.received_at,
  }))
);
```

Run with `npx tsx` from the repo root (tsconfig paths resolve `@/`; if `npx tsx` can't resolve the alias, use relative imports `./lib/...` and place the script at repo root temporarily, deleting it after). Expected: hierarchy shows the 5 seeded sources rank 1–5 (verify migration ran against the real DB — the dev server or `npx tsx scripts/...` boot runs migrations; if the column is missing, run any script that opens the DB via `lib/db.ts` first); entries are rank-ordered. Pick a family symbol that actually has recent articles (query `research_article_securities` joined to a held symbol if AAPL is empty).

- [ ] **Step 3: Browser E2E of the hierarchy editor**

Ensure a dev server is running (check `lsof -nP -iTCP:3000 -sTCP:LISTEN` and `lsof -nP -iTCP:3099 -sTCP:LISTEN`; NEVER start a second `next dev` against the same directory — if :3099 (Electron) is live, use it; else start `npm run dev` in background). Dispatch an agent-browser agent to:

1. Open `http://localhost:<port>/dashboard/research?view=feeds`, open "Manage sources".
2. Verify the "Earnings source hierarchy" section lists 5 sources in order (VK, TMT Breakout, Eliant, Purple Drink, Meisler).
3. Move rank 2 up; verify it becomes rank 1 and persists after closing/reopening the modal.
4. Move it back down.
5. Type a note on a source, blur, reopen modal, verify persistence; then restore the prior note text (empty → cleared).
6. Click "+ earnings" on an unranked source; verify it appears at rank 6; then remove it and verify the section returns to 5 entries with dense ranks.
7. Screenshot the section.

Expected: all steps pass with no console errors. Any failure: stop and fix before docs.

- [ ] **Step 4: Docs updates**

In `CLAUDE.md`, add a bullet to the Conventions section (near the other earnings bullets):

```markdown
- **Earnings source hierarchy (migration 068)**: earnings preview/recap source priority lives in `research_sources.earnings_rank` (+ per-source `earnings_note` prompt guidance) — never a hardcoded constant (`PREFERRED_SOURCE_IDS` deleted 2026-07-17). `getNewsletterContext` (exported, `lib/digest/send-earnings-email.ts`) is a rank-ordered fill: one all-sources candidate query → same-source same-ET-day edition supersedence (`classifyEdition`) → ranked-first (rank asc, id tie-break) then unranked, recency desc within → 6-slot fill under the 8k/80k caps → 30-day backstop only on zero 7-day hits. Unranked sources FILL REMAINING SLOTS (never re-introduce the zero-hit tier gate — one stale preferred mention used to suppress fresh non-preferred previews). UI: hierarchy editor in `ManageSourcesModal` via `PATCH /api/research/sources` (`earnings_rank` positive-int-or-null, `earnings_note` trimmed empty→NULL; server does not enforce rank uniqueness — reads tie-break by id). Briefing deep-read list is deliberately separate. Spec: `docs/superpowers/specs/2026-07-17-earnings-source-hierarchy-design.md`.
```

In `docs/plans/TODO.md`, change the "Earnings preview — source hierarchy work" item from `- [ ]` to `- [x]` and append: `— shipped 2026-07-17 (migration 068 + rank-ordered fill + ManageSourcesModal editor; spec docs/superpowers/specs/2026-07-17-earnings-source-hierarchy-design.md)`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/plans/TODO.md
git commit -m "docs: earnings source hierarchy conventions + TODO close-out"
```

---

## Self-Review Notes

- Spec §1 → Tasks 1–2; §2 → Task 3; §3 → Task 4; §4 UI → Task 5; §4 testing/docs → per-task tests + Task 6. Out-of-scope items have no tasks (correct).
- Type names consistent: `EarningsHierarchySource`, `NewsletterEntry.earnings_rank/earnings_note`, `getNewsletterContext`, `renderNewslettersBlock` used identically across tasks.
- The old `NewsletterRow` interface is deleted in Task 3 with the function it served.
