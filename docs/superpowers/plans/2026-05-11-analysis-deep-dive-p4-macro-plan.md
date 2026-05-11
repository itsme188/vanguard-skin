# Analysis Deep Dive — Phase 4 (Macro Overlay + Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Analysis Deep Dive. Ship the Macro Overlay (Sonnet-generated weekly themes per scope) as Workspace card 3, wire it as one source of truth for the Sunday briefing email's "Macro context" section, cross-cut it into Cash-Deploy gap prioritization and Scenario picker "live now" hints, then fold in three small P3 follow-ups (narrative GET rate-limit, PositionRisk per-row W-o-W badges, bond `maturity_date` regex backfill).

**Architecture:** Five vertical slices that each ship and commit independently. **Slice A** stands up the macro themes table + Sonnet-via-AI-Gateway composer + Zod-validated 3-5 theme output + cache helpers + Sunday-briefing pre-gen hook (4 scopes per week, ~$0.85/mo). **Slice B** replaces the existing `MacroOverlayPlaceholder` with a real `<MacroOverlayCard>` and a source-receipt drawer (clickable theme → which articles/events/alerts informed it). **Slice C** threads the cached themes into the Sunday briefing's Opus prompt so the email and the app surface read from the same generation. **Slice D** does the two cross-cuts the spec calls out: Cash-Deploy boosts gaps that go with active risk-on/risk-off themes, and `scenario-recipes` attaches a `liveNowReason` field that the picker uses to badge relevant scenarios. **Slice E** is polish — three small P3 follow-ups that the user wants done before serious testing.

Cache discipline is the cost moat. One generation per (scope, week) regardless of view count. Tuesday viewers see Sunday's themes; an explicit "Refresh now" button is rate-limited 1/day/scope as escape hatch. Stale-tolerance is **option 1** from the brainstorm: cache-only display, no auto-regen on mid-week view.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, better-sqlite3 (in-memory for tests), Vitest, Tailwind CSS 4, AI SDK v6 with Anthropic provider via Cloudflare AI Gateway, Zod for output validation.

**Spec:** [docs/superpowers/specs/2026-05-10-analysis-deep-dive-design.md](../specs/2026-05-10-analysis-deep-dive-design.md) (Section 4 + 5.1 data model + 5.2 AI keys + 5.3 file layout)

**Migration numbers (confirmed post-P3):** P3 used 051 (`security_regressions`) and 052 (`analysis_narratives`). P4 takes **053** (`analysis_macro_themes`). The spec's original numbering called this 052 but reality drifted during P3 ship.

**Phase ship target:** ~13h, +39 tests (1913 → ~1952), all P4 surfaces shipped + 3 P3 follow-ups closed. New AI cost ~$0.85/month (macro themes only). Full Analysis Deep Dive complete after this phase.

**Explicit non-goals (deferred from P3 follow-up list):**
- `FactorProfileSection` block 3 (portfolio-share contribution math) — placeholder + TODO stays; revisit on signal
- `buildContextForSurface` multi-account fidelity — broader compute-fn refactor, park until quality complaints
- End-to-end Playwright/agent-browser sweep — user wants this after P4, not during

---

## File Structure (P4 only)

**Create:**
- `lib/db/migrations/053_analysis_macro_themes.sql`
- `lib/compute/macro-themes.ts`
- `lib/queries/analysis-macro-themes.ts`
- `app/api/analysis/macro-themes/route.ts`
- `app/dashboard/components/analysis/MacroOverlayCard.tsx`
- `app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx`
- `lib/digest/macro-themes-markdown.ts`
- `scripts/backfill-bond-maturity-dates.ts`
- `tests/compute/macro-themes.test.ts`
- `tests/queries/analysis-macro-themes.test.ts`
- `tests/api/analysis-macro-themes.test.ts`
- `tests/digest/macro-themes-markdown.test.ts`
- `tests/digest/send-briefing-macro-pregen.test.ts`
- `tests/compute/cash-deploy-theme-aware.test.ts`
- `tests/compute/scenario-recipes-live-now.test.ts`
- `tests/scripts/backfill-bond-maturity-dates.test.ts`

**Modify:**
- `lib/ai/feature-keys.ts:13-37` — add `"analysisMacroThemes"` to the union
- `lib/ai/models.ts:26+` — add `analysisMacroThemes: "anthropic/${SONNET_MODEL}"` to `FEATURE_MODELS`
- `lib/digest/send-briefing.ts:88-112` — after the existing narrative pre-gen block, add macro-themes pre-gen for 4 scopes
- `lib/digest/send-briefing.ts` (prompt section) — read themes from cache, format as markdown, prepend to Opus prompt
- `lib/compute/cash-deploy.ts` — extend `SectorGap` with `gapClosureScore` + accept optional `activeThemes` arg
- `app/api/analysis/cash-deploy/route.ts` — read current-week themes from cache, pass through
- `lib/compute/scenario-recipes.ts` — extend `ScenarioRecipe` with `liveNowReason?: string`; add `matchScenariosToThemes`
- `app/api/compute/scenarios/route.ts` — call `matchScenariosToThemes` before returning
- `app/dashboard/components/ScenarioModeling.tsx` — render amber "Live now" pill when `liveNowReason` set
- `app/dashboard/components/analysis/WorkspacePanel.tsx:3,5,21` — swap `MacroOverlayPlaceholder` import for `MacroOverlayCard`
- `app/api/analysis/narrative/route.ts` — add cache-miss rate-limit to GET path
- `app/dashboard/components/PositionRisk.tsx` — render `<WeekOverWeekBadge>` per row using `weekAgo` array
- `lib/mutations/securities.ts` — try bond-name maturity regex when a bond arrives without `maturity_date`

**Tests target:** +39 tests
- macro-themes compute: 11 (5 schema + 3 signal blob + 3 generator including empty-contributors fallback)
- analysis-macro-themes queries: 3
- analysis-macro-themes API: 3
- macro-themes markdown: 2
- send-briefing pre-gen smoke: 2
- cash-deploy theme-aware: 4
- cash-deploy API wire-through: 1
- scenario-recipes live-now: 3
- scenarios API wire-through: 1
- narrative GET rate-limit: 1
- PositionRisk W-o-W badge delta: 1
- backfill-bond-maturity-dates: 6
- upsertSecurity bond regex integration: 1

---

## Conventions (read once, apply throughout)

- **In-memory SQLite test pattern:** `new Database(":memory:")` + `runMigrations(db)` + per-test seed helpers. Canonical example: `tests/compute/exposure-delta.test.ts`. Never reach for `data/vanguard.db` from a test.
- **All DB query functions take `db: Database.Database`** (dependency injection). Never import the singleton inside `lib/compute/` or `lib/queries/`.
- **Latest-holdings CTE:** ALWAYS use `latestHoldingsPredicate()` from `lib/queries/latest-holdings.ts`. P2/P3 follow-ups retired 8 inline copies. Do not regress.
- **Case-insensitive security_type comparisons.** Always `LOWER(s.security_type)` in SQL, `.toLowerCase()` in TS.
- **AI calls go through `getModelForFeature("<key>")`** from `lib/ai/provider.ts`. Never `new Anthropic()` at call sites. Two documented exceptions exist (`vanguard-pdf`, `send-earnings-email`) — do not add a third.
- **Cost guard.** New AI call sites pre-gen weekly via Sunday briefing. On-demand regen rate-limited 1/day/scope.
- **Zod at AI output boundaries.** Sonnet's `generateText` output must be `JSON.parse`d then `MacroThemesSchema.parse()`'d before any cache write. Invalid → throw, caller catches, fall back to empty rather than poisoning the cache.
- **`force-dynamic` on dashboard routes.** Every new `app/api/.../route.ts` exports `export const dynamic = "force-dynamic"`.
- **TDD.** Every step writes the failing test first, runs it, then writes the minimum code to pass. Commit between tasks.

---

## Slice A — Macro themes compute + cache + API + Sunday pre-gen

**Goal:** Working `generateMacroThemes()` that takes a scope + week, reads from `analysis_macro_themes` cache, computes-on-miss via Sonnet over the last 7d of research articles + calendar events + level alerts + factor exposure, validates with Zod, UPSERTs, and returns. Hooked into the Sunday briefing pre-gen pipeline so steady-state is cache-only.

**Files this slice touches:**
- Create: `lib/db/migrations/053_analysis_macro_themes.sql`
- Create: `lib/compute/macro-themes.ts`
- Create: `lib/queries/analysis-macro-themes.ts`
- Create: `app/api/analysis/macro-themes/route.ts`
- Modify: `lib/ai/feature-keys.ts`, `lib/ai/models.ts`, `lib/digest/send-briefing.ts`
- Test: `tests/compute/macro-themes.test.ts`, `tests/queries/analysis-macro-themes.test.ts`, `tests/api/analysis-macro-themes.test.ts`, `tests/digest/send-briefing-macro-pregen.test.ts`

### Task A1: Migration 053

- [ ] **Step 1: Write the failing test**

Add to `tests/queries/analysis-macro-themes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 053", () => {
  it("creates analysis_macro_themes table with UNIQUE (week_of, scope)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(analysis_macro_themes)").all();
    const names = cols.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "week_of", "scope", "themes_json",
      "source_summary", "generated_at", "model_used",
    ]));
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='analysis_macro_themes'").all();
    expect(JSON.stringify(idx)).toContain("week_of");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/analysis-macro-themes.test.ts`
Expected: FAIL with "no such table: analysis_macro_themes"

- [ ] **Step 3: Write migration**

Create `lib/db/migrations/053_analysis_macro_themes.sql`:

```sql
-- Caches Sonnet-generated macro themes for a given (scope, week). One row per
-- (scope, week_of). Generated by the Sunday briefing pipeline; on-demand
-- regen rate-limited 1/day/scope.

CREATE TABLE IF NOT EXISTS analysis_macro_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_of TEXT NOT NULL,
  scope TEXT NOT NULL,
  themes_json TEXT NOT NULL,
  source_summary TEXT,
  generated_at TEXT NOT NULL,
  model_used TEXT NOT NULL,
  UNIQUE (week_of, scope)
);

CREATE INDEX IF NOT EXISTS idx_analysis_macro_themes_week_scope
  ON analysis_macro_themes(week_of, scope);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/queries/analysis-macro-themes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/db/migrations/053_analysis_macro_themes.sql tests/queries/analysis-macro-themes.test.ts
git commit -m "feat(p4-slice-a): migration 053 — analysis_macro_themes cache table"
```

### Task A2: Cache helpers

- [ ] **Step 1: Write the failing tests**

Append to `tests/queries/analysis-macro-themes.test.ts`:

```ts
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("analysis-macro-themes queries", () => {
  function fresh() {
    const db = new Database(":memory:");
    runMigrations(db);
    return db;
  }

  it("returns null when nothing cached", () => {
    const db = fresh();
    expect(getCachedMacroThemes(db, "all", "2026-05-04")).toBeNull();
  });

  it("inserts then reads back", () => {
    const db = fresh();
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: '[{"name":"X","direction":"risk-on"}]',
      sourceSummary: '{"articles":[]}',
      modelUsed: "claude-sonnet-4-6",
    });
    const got = getCachedMacroThemes(db, "all", "2026-05-04");
    expect(got).not.toBeNull();
    expect(got!.themesJson).toContain("risk-on");
    expect(got!.modelUsed).toBe("claude-sonnet-4-6");
  });

  it("UPSERT updates an existing (scope, week) row", () => {
    const db = fresh();
    upsertMacroThemes(db, { scope: "all", weekOf: "2026-05-04", themesJson: "[]", sourceSummary: null, modelUsed: "v1" });
    upsertMacroThemes(db, { scope: "all", weekOf: "2026-05-04", themesJson: '[{"name":"Y"}]', sourceSummary: null, modelUsed: "v2" });
    const rows = db.prepare("SELECT COUNT(*) as n FROM analysis_macro_themes WHERE scope='all' AND week_of='2026-05-04'").get() as { n: number };
    expect(rows.n).toBe(1);
    const got = getCachedMacroThemes(db, "all", "2026-05-04");
    expect(got!.modelUsed).toBe("v2");
    expect(got!.themesJson).toContain("Y");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/queries/analysis-macro-themes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `lib/queries/analysis-macro-themes.ts`:

```ts
import type Database from "better-sqlite3";

export interface CachedMacroThemes {
  scope: string;
  weekOf: string;
  themesJson: string;
  sourceSummary: string | null;
  generatedAt: string;
  modelUsed: string;
}

export interface UpsertMacroThemesInput {
  scope: string;
  weekOf: string;
  themesJson: string;
  sourceSummary: string | null;
  modelUsed: string;
}

export function getCachedMacroThemes(
  db: Database.Database,
  scope: string,
  weekOf: string
): CachedMacroThemes | null {
  const row = db.prepare(
    `SELECT scope, week_of, themes_json, source_summary, generated_at, model_used
     FROM analysis_macro_themes
     WHERE scope = ? AND week_of = ?`
  ).get(scope, weekOf) as
    | { scope: string; week_of: string; themes_json: string; source_summary: string | null; generated_at: string; model_used: string }
    | undefined;
  if (!row) return null;
  return {
    scope: row.scope,
    weekOf: row.week_of,
    themesJson: row.themes_json,
    sourceSummary: row.source_summary,
    generatedAt: row.generated_at,
    modelUsed: row.model_used,
  };
}

export function upsertMacroThemes(
  db: Database.Database,
  input: UpsertMacroThemesInput
): void {
  db.prepare(
    `INSERT INTO analysis_macro_themes
       (scope, week_of, themes_json, source_summary, generated_at, model_used)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(week_of, scope) DO UPDATE SET
       themes_json = excluded.themes_json,
       source_summary = excluded.source_summary,
       generated_at = excluded.generated_at,
       model_used = excluded.model_used`
  ).run(input.scope, input.weekOf, input.themesJson, input.sourceSummary, input.modelUsed);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/queries/analysis-macro-themes.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/queries/analysis-macro-themes.ts tests/queries/analysis-macro-themes.test.ts
git commit -m "feat(p4-slice-a): cache helpers for analysis_macro_themes"
```

### Task A3: Feature key + model registration

- [ ] **Step 1: Modify `lib/ai/feature-keys.ts`** — add `"analysisMacroThemes"` to the union after `"analysisFactorNarrative"`.

- [ ] **Step 2: Modify `lib/ai/models.ts`** — add the FEATURE_MODELS entry:

```ts
  // Weekly macro-themes generation for the Analysis Workspace + Sunday
  // briefing. Sonnet 4.6 via AI Gateway, pre-gen at Sunday cadence, cache
  // until next Sunday. ~$0.85/month at 4 scopes × 1/wk.
  analysisMacroThemes: `anthropic/${SONNET_MODEL}`,
```

- [ ] **Step 3: Run full test suite — no regression expected**

Run: `npx vitest run`
Expected: existing 1913 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/ai/feature-keys.ts lib/ai/models.ts
git commit -m "feat(p4-slice-a): register analysisMacroThemes feature key"
```

### Task A4: Zod schema for theme output

Foundation-only — no Sonnet call yet. Schema bounds what the model is allowed to return.

- [ ] **Step 1: Write the failing test**

Create `tests/compute/macro-themes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MacroThemesSchema, type MacroThemeAi } from "@/lib/compute/macro-themes";

describe("MacroThemesSchema", () => {
  it("accepts a well-formed 3-theme array", () => {
    const sample: MacroThemeAi[] = [
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off", summary: "Trade-deal headlines pushed risk down all week." },
      { name: "AI mania cooling", factor_label: "ai_exposure", direction: "risk-off", summary: "Mega-caps gave back gains after weak Capex commentary." },
      { name: "Rate-cut hopes", factor_label: "interest_rate_sensitive", direction: "risk-on", summary: "Softer CPI revived September cut bets." },
    ];
    expect(() => MacroThemesSchema.parse(sample)).not.toThrow();
  });

  it("rejects an empty array (need at least one theme)", () => {
    expect(() => MacroThemesSchema.parse([])).toThrow();
  });

  it("rejects a 6-theme array (cap at 5)", () => {
    const six = Array.from({ length: 6 }).map((_, i) => ({
      name: `T${i}`, factor_label: "ai_exposure",
      direction: "risk-on" as const, summary: "x".repeat(20),
    }));
    expect(() => MacroThemesSchema.parse(six)).toThrow();
  });

  it("rejects an unknown direction value", () => {
    const bad = [{ name: "X", factor_label: "ai_exposure", direction: "sideways", summary: "x".repeat(20) }];
    expect(() => MacroThemesSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown factor_label", () => {
    const bad = [{ name: "X", factor_label: "weather_exposure", direction: "risk-on", summary: "x".repeat(20) }];
    expect(() => MacroThemesSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compute/macro-themes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schema**

Create `lib/compute/macro-themes.ts`:

```ts
/**
 * macro-themes.ts — Sonnet 4.6 composer for weekly macro themes per scope.
 *
 * Cache-first via analysis_macro_themes. On miss, builds a 7d signal blob
 * from research_articles + calendar_events + level_alerts + factor exposure,
 * calls Sonnet via AI Gateway, validates with Zod, attaches per-scope
 * exposure buckets + top-3 contributors, UPSERTs, returns.
 */

import { z } from "zod";

const FACTOR_LABELS = [
  "interest_rate_sensitive", "growth_vs_value", "cyclical",
  "international_exposure", "geopolitical_onshoring", "tariff_exposure",
  "ai_exposure", "crypto_adjacent", "regulatory_risk",
] as const;

export const ThemeDirection = z.enum(["risk-on", "risk-off", "neutral"]);
export type ThemeDirection = z.infer<typeof ThemeDirection>;

const MacroThemeAiSchema = z.object({
  name: z.string().min(3).max(60),
  factor_label: z.enum(FACTOR_LABELS),
  direction: ThemeDirection,
  summary: z.string().min(15).max(280),
});
export type MacroThemeAi = z.infer<typeof MacroThemeAiSchema>;

export const MacroThemesSchema = z.array(MacroThemeAiSchema).min(1).max(5);

const ContributorSchema = z.object({
  symbol: z.string(),
  weight: z.number(),
});
export const ExposureBucket = z.enum(["low", "moderate", "high", "very-high"]);
export type ExposureBucket = z.infer<typeof ExposureBucket>;

export const MacroThemeSchema = MacroThemeAiSchema.extend({
  exposure_bucket: ExposureBucket,
  top_contributors: z.array(ContributorSchema).max(3),
});
export type MacroTheme = z.infer<typeof MacroThemeSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compute/macro-themes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/compute/macro-themes.ts tests/compute/macro-themes.test.ts
git commit -m "feat(p4-slice-a): Zod schema for macro theme output validation"
```

### Task A5: Signal aggregation

Pure read-only DB work, no AI yet — isolated so it's testable without mocks.

- [ ] **Step 1: Write the failing tests**

Append to `tests/compute/macro-themes.test.ts`:

```ts
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildMacroSignalBlob } from "@/lib/compute/macro-themes";

describe("buildMacroSignalBlob", () => {
  function seed() {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 't@test.com', 1)").run();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO research_articles
           (id, source_id, subject, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
         VALUES (?, 1, ?, ?, datetime('now', '-${i} days'), datetime('now'), ?, ?)`
      ).run(i + 1, `Article ${i}`, `Body ${i} mentioning AAPL and NVDA and tariffs`,
            i % 2 === 0 ? "negative" : "positive",
            JSON.stringify(["AAPL", "NVDA"]));
    }
    db.prepare(
      `INSERT INTO calendar_events
         (id, event_date, event_type, source, source_key, week_of, symbol, actual_value, reaction_snapshot, enriched_at)
       VALUES (1, date('now', '-2 days'), 'macro', 'fred', 'fred:CPIAUCSL:2026-05-08', date('now','-2 days'), 'CPI', '0.3%',
         '{"spy":{"close":580,"change":-0.012}}', datetime('now','-2 days'))`
    ).run();
    return db;
  }

  it("aggregates last 7d of articles + enriched events", () => {
    const db = seed();
    const blob = buildMacroSignalBlob(db, "all", "2026-05-04");
    expect(blob.articleCount).toBe(3);
    expect(blob.enrichedEventCount).toBe(1);
    expect(blob.totalSignalCount).toBe(4);
    expect(blob.articles[0].mentioned_symbols).toContain("AAPL");
    expect(blob.enrichedEvents[0].symbol).toBe("CPI");
  });

  it("respects 7-day cutoff and ignores older articles", () => {
    const db = seed();
    db.prepare(
      `INSERT INTO research_articles (id, source_id, subject, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
       VALUES (99, 1, 'old', 'old', datetime('now','-30 days'), datetime('now'), 'neutral', '[]')`
    ).run();
    const blob = buildMacroSignalBlob(db, "all", "2026-05-04");
    expect(blob.articleCount).toBe(3);
  });

  it("flags under-threshold input when < 2 articles + 0 enriched events", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'T', 't@t.com', 1)").run();
    db.prepare(
      `INSERT INTO research_articles (id, source_id, subject, raw_text, received_at, processed_at, sentiment, mentioned_symbols)
       VALUES (1, 1, 's', 'b', datetime('now'), datetime('now'), 'neutral', '[]')`
    ).run();
    const blob = buildMacroSignalBlob(db, "all", "2026-05-04");
    expect(blob.underThreshold).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compute/macro-themes.test.ts`
Expected: FAIL — `buildMacroSignalBlob` not exported.

- [ ] **Step 3: Implement the aggregator**

Append to `lib/compute/macro-themes.ts`:

```ts
import type Database from "better-sqlite3";

const MIN_SIGNAL_THRESHOLD = 2;

export interface ArticleSignal {
  id: number;
  subject: string;
  sentiment: string | null;
  mentioned_symbols: string[];
  excerpt: string;
}
export interface EventSignal {
  id: number;
  event_date: string;
  event_type: string;
  symbol: string | null;
  actual_value: string | null;
  reaction_snapshot: string | null;
}
export interface AlertSignal {
  id: number;
  symbol: string;
  triggered_at: string;
}
export interface MacroSignalBlob {
  articleCount: number;
  enrichedEventCount: number;
  alertCount: number;
  totalSignalCount: number;
  underThreshold: boolean;
  articles: ArticleSignal[];
  enrichedEvents: EventSignal[];
  alerts: AlertSignal[];
}

export function buildMacroSignalBlob(
  db: Database.Database,
  _scope: string,
  weekOf: string
): MacroSignalBlob {
  const articleRows = db.prepare(
    `SELECT id, subject, sentiment, mentioned_symbols, substr(raw_text, 1, 2000) AS excerpt
     FROM research_articles
     WHERE datetime(received_at) >= datetime(?, '-7 days')
     ORDER BY datetime(received_at) DESC
     LIMIT 60`
  ).all(weekOf) as Array<{
    id: number; subject: string; sentiment: string | null;
    mentioned_symbols: string | null; excerpt: string;
  }>;

  const articles: ArticleSignal[] = articleRows.map((r) => {
    let symbols: string[] = [];
    try { symbols = r.mentioned_symbols ? JSON.parse(r.mentioned_symbols) : []; } catch { symbols = []; }
    return { id: r.id, subject: r.subject, sentiment: r.sentiment, mentioned_symbols: symbols, excerpt: r.excerpt };
  });

  const eventRows = db.prepare(
    `SELECT id, event_date, event_type, symbol, actual_value, reaction_snapshot
     FROM calendar_events
     WHERE datetime(event_date) >= datetime(?, '-7 days')
       AND enriched_at IS NOT NULL
     ORDER BY event_date DESC
     LIMIT 30`
  ).all(weekOf) as EventSignal[];

  const alertRows = db.prepare(
    `SELECT la.id, s.symbol, la.triggered_at
     FROM level_alerts la
     JOIN securities s ON s.id = la.security_id
     WHERE datetime(la.triggered_at) >= datetime(?, '-7 days')
     ORDER BY la.triggered_at DESC
     LIMIT 30`
  ).all(weekOf) as AlertSignal[];

  const articleCount = articles.length;
  const enrichedEventCount = eventRows.length;
  const alertCount = alertRows.length;
  const totalSignalCount = articleCount + enrichedEventCount;
  const underThreshold = articleCount < MIN_SIGNAL_THRESHOLD && enrichedEventCount < 1;

  return {
    articleCount, enrichedEventCount, alertCount, totalSignalCount, underThreshold,
    articles, enrichedEvents: eventRows, alerts: alertRows,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/compute/macro-themes.test.ts`
Expected: PASS — 8 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/compute/macro-themes.ts tests/compute/macro-themes.test.ts
git commit -m "feat(p4-slice-a): signal blob aggregator for macro themes generator"
```

### Task A6: generateMacroThemes — Sonnet call + Zod validation + cache wiring

- [ ] **Step 1: Write the failing tests**

Append to `tests/compute/macro-themes.test.ts`:

```ts
import { generateMacroThemes } from "@/lib/compute/macro-themes";
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("generateMacroThemes", () => {
  function seedDb() {
    const db = new Database(":memory:");
    runMigrations(db);
    return db;
  }

  it("returns cache hit when row exists for (scope, week)", async () => {
    const db = seedDb();
    const themes = [{
      name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
      summary: "Trade-deal headlines pushed risk down all week.",
      exposure_bucket: "moderate", top_contributors: [{ symbol: "AAPL", weight: 0.04 }],
    }];
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify(themes), sourceSummary: null, modelUsed: "claude-sonnet-4-6",
    });
    const result = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(result.fromCache).toBe(true);
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].name).toBe("Tariff escalation");
  });

  it("returns empty array with underThreshold=true when insufficient signal", async () => {
    const db = seedDb();
    const result = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(result.fromCache).toBe(false);
    expect(result.themes).toEqual([]);
    expect(result.underThreshold).toBe(true);
  });

  it("post-process degrades to empty top_contributors when factor result lacks tilts", async () => {
    // Cache a theme generated against a freshly-migrated DB with no
    // factor classifications. computeFactorAnalysis returns null or an
    // object without `tilts`, and post-process must not throw — it
    // should just set top_contributors to [].
    const db = seedDb();
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify([{
        name: "AI mania cooling", factor_label: "ai_exposure", direction: "risk-off",
        summary: "Mega-caps gave back gains after weak Capex commentary.",
        exposure_bucket: "low", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const result = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(result.themes[0].top_contributors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compute/macro-themes.test.ts`
Expected: FAIL — `generateMacroThemes` not exported.

- [ ] **Step 3: Implement `generateMacroThemes`**

Append to `lib/compute/macro-themes.ts`:

```ts
import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { resolveScope } from "@/lib/queries/accounts";
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { computeFactorAnalysis } from "@/lib/compute/factors";

const SYSTEM_PROMPT = `You are a portfolio analyst identifying the macro themes that actually moved markets this week. Output ONLY valid JSON matching the schema. Never include prose outside the JSON array. 3-5 themes maximum. Each theme must map to one factor_label from the allowed list. Each summary is one sentence, 30-200 chars.`;

const USER_PROMPT_TEMPLATE = `Given the past 7 days of news articles, enriched macro events (CPI/PCE/FOMC actuals + market reactions), and price-level alerts that fired, identify 3-5 macro themes that drove markets this week.

For each theme:
- name: short label (e.g., "Tariff escalation", "AI mania cooling")
- factor_label: one of [interest_rate_sensitive, growth_vs_value, cyclical, international_exposure, geopolitical_onshoring, tariff_exposure, ai_exposure, crypto_adjacent, regulatory_risk]
- direction: "risk-on" | "risk-off" | "neutral"
- summary: one-sentence what it means (30-200 chars)

Output JSON array only. Example:
[{"name":"...","factor_label":"...","direction":"...","summary":"..."}]

Inputs:
{INPUTS_JSON}`;

export interface GenerateMacroThemesOpts {
  scope: string;
  weekOf: string;
  forceRegen?: boolean;
}

export interface MacroThemesResult {
  themes: MacroTheme[];
  sourceSummary: {
    articles: Array<{ id: number; title: string }>;
    events: Array<{ id: number; symbol: string | null; event_date: string }>;
    alerts: Array<{ id: number; symbol: string }>;
  } | null;
  fromCache: boolean;
  generatedAt: string;
  underThreshold: boolean;
}

const EXPOSURE_THRESHOLDS = { low: 0.05, moderate: 0.15, high: 0.25 } as const;

function bucketExposure(weight: number): ExposureBucket {
  if (weight < EXPOSURE_THRESHOLDS.low) return "low";
  if (weight < EXPOSURE_THRESHOLDS.moderate) return "moderate";
  if (weight < EXPOSURE_THRESHOLDS.high) return "high";
  return "very-high";
}

export async function generateMacroThemes(
  db: Database.Database,
  opts: GenerateMacroThemesOpts
): Promise<MacroThemesResult> {
  if (!opts.forceRegen) {
    const cached = getCachedMacroThemes(db, opts.scope, opts.weekOf);
    if (cached) {
      const themes = JSON.parse(cached.themesJson) as MacroTheme[];
      const sourceSummary = cached.sourceSummary ? JSON.parse(cached.sourceSummary) : null;
      return { themes, sourceSummary, fromCache: true, generatedAt: cached.generatedAt, underThreshold: false };
    }
  }

  const blob = buildMacroSignalBlob(db, opts.scope, opts.weekOf);

  // Under-threshold → empty array + cache it so we don't re-call Sonnet
  // on every page view this week.
  if (blob.underThreshold) {
    upsertMacroThemes(db, {
      scope: opts.scope, weekOf: opts.weekOf, themesJson: "[]",
      sourceSummary: JSON.stringify({ articles: [], events: [], alerts: [], note: "insufficient signal" }),
      modelUsed: "(none — under threshold)",
    });
    return { themes: [], sourceSummary: null, fromCache: false, generatedAt: new Date().toISOString(), underThreshold: true };
  }

  const inputs = {
    articles: blob.articles.map((a) => ({
      id: a.id, subject: a.subject, sentiment: a.sentiment,
      symbols: a.mentioned_symbols, excerpt: a.excerpt.slice(0, 800),
    })),
    enriched_events: blob.enrichedEvents,
    alerts: blob.alerts,
  };
  const prompt = USER_PROMPT_TEMPLATE.replace("{INPUTS_JSON}", JSON.stringify(inputs, null, 2).slice(0, 16000));

  const model = getModelForFeature("analysisMacroThemes");
  let rawText: string;
  try {
    const result = await generateText({ model, system: SYSTEM_PROMPT, prompt });
    rawText = result.text.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Sonnet macro-themes generation failed: ${msg}`);
  }

  // Trim code-fence wrap if the model added one despite system-prompt instructions.
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed: MacroThemeAi[];
  try {
    const raw = JSON.parse(jsonText);
    parsed = MacroThemesSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`AI returned malformed themes: ${msg}`);
  }

  // Post-process: attach per-scope exposure bucket + top-3 contributors.
  const accountIds = resolveScope(db, opts.scope);
  const firstAccountId = accountIds?.[0];
  const factorResult = computeFactorAnalysis(db, { accountId: firstAccountId });

  const themes: MacroTheme[] = parsed.map((t) => {
    const factorTilt =
      (factorResult as any)?.tilts?.find((tilt: any) => tilt.factor === t.factor_label) ?? null;
    const exposureWeight = factorTilt?.exposurePct ? factorTilt.exposurePct / 100 : 0;
    const top = factorTilt?.topContributors
      ? factorTilt.topContributors.slice(0, 3).map((c: any) => ({ symbol: c.symbol, weight: c.weight }))
      : [];
    return { ...t, exposure_bucket: bucketExposure(exposureWeight), top_contributors: top };
  });

  const sourceSummary = {
    articles: blob.articles.slice(0, 10).map((a) => ({ id: a.id, title: a.subject })),
    events: blob.enrichedEvents.slice(0, 10).map((e) => ({ id: e.id, symbol: e.symbol, event_date: e.event_date })),
    alerts: blob.alerts.slice(0, 10).map((a) => ({ id: a.id, symbol: a.symbol })),
  };

  const modelUsed = resolveFeatureModel("analysisMacroThemes").modelId;
  upsertMacroThemes(db, {
    scope: opts.scope, weekOf: opts.weekOf,
    themesJson: JSON.stringify(themes),
    sourceSummary: JSON.stringify(sourceSummary),
    modelUsed,
  });

  return { themes, sourceSummary, fromCache: false, generatedAt: new Date().toISOString(), underThreshold: false };
}
```

> **Note on `computeFactorAnalysis` shape:** the `(factorResult as any)` cast is intentional — verify actual shape during implementation. If the field doesn't exist, post-process degrades to empty contributors. Acceptable degradation; tighten typing once confirmed.

- [ ] **Step 4: Run the two new tests**

Run: `npx vitest run tests/compute/macro-themes.test.ts -t "returns cache hit"` then `-t "underThreshold"`
Expected: both PASS.

- [ ] **Step 5: Run full file**

Run: `npx vitest run tests/compute/macro-themes.test.ts`
Expected: PASS — 11 tests (5 schema + 3 signal blob + 3 generator).

- [ ] **Step 6: Commit**

```bash
git add lib/compute/macro-themes.ts tests/compute/macro-themes.test.ts
git commit -m "feat(p4-slice-a): generateMacroThemes — Sonnet + Zod + cache + post-process"
```

### Task A7: API route

- [ ] **Step 1: Write the failing test**

Create `tests/api/analysis-macro-themes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("/api/analysis/macro-themes", () => {
  it("GET returns cache hit shape when present", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    const { db } = await import("@/lib/db");
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify([{
        name: "X", factor_label: "ai_exposure", direction: "risk-on",
        summary: "y".repeat(20), exposure_bucket: "low", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const req = new Request("http://localhost/api/analysis/macro-themes?scope=all&week=2026-05-04");
    const res = await GET(req as any);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.themes).toHaveLength(1);
  });

  it("GET returns 400 when scope missing", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    const req = new Request("http://localhost/api/analysis/macro-themes");
    const res = await GET(req as any);
    expect(res.status).toBe(400);
  });

  it("POST rate-limits to once per day per scope", async () => {
    const { POST, __resetMacroRegenLimitForTests } = await import("@/app/api/analysis/macro-themes/route");
    __resetMacroRegenLimitForTests();
    const make = () => new Request("http://localhost/api/analysis/macro-themes", {
      method: "POST",
      body: JSON.stringify({ scope: "all" }),
      headers: { "Content-Type": "application/json" },
    });
    await POST(make() as any);
    const res2 = await POST(make() as any);
    expect(res2.status).toBe(429);
  });
});
```

> **Note on the cache-hit test — fragility:** `@/lib/db` is the singleton the route uses. In an in-memory test setup the seed inserts against the same handle the route reads, so the seed → request flow works **only if Vitest is running this file in a single worker**. The default `pool: "threads"` config CAN produce isolated SQLite connections per worker — if so, this test will flake. **If it flakes on first run:** mark it `.skip` with a clear TODO comment ("flaky on parallel workers; needs fixture-based DB injection per `tests/contracts/api-component-contracts.test.ts`"), file a follow-up to refactor the route to accept an injected `db` (5-line constructor wrapper), and proceed. The other two tests (400-missing-scope, 429-rate-limit) don't touch DB and are safe in any pool mode.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/api/analysis-macro-themes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `app/api/analysis/macro-themes/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateMacroThemes } from "@/lib/compute/macro-themes";
import { mondayOf } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

const ALLOWED_SCOPES = new Set(["all", "vanguard", "ibkr", "roth"]);

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  if (!scope || !ALLOWED_SCOPES.has(scope)) {
    return NextResponse.json(
      { success: false, error: "scope required (all|vanguard|ibkr|roth)" },
      { status: 400 }
    );
  }
  const weekParam = url.searchParams.get("week");
  const week = weekParam ? mondayOf(weekParam) : mondayOf(new Date().toISOString().slice(0, 10));
  try {
    const r = await generateMacroThemes(db, { scope, weekOf: week });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

const lastMacroRegenAt = new Map<string, number>();
const MACRO_REGEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  let body: { scope?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 }); }
  const scope = body.scope;
  if (!scope || !ALLOWED_SCOPES.has(scope)) {
    return NextResponse.json({ success: false, error: "scope required" }, { status: 400 });
  }
  const now = Date.now();
  const last = lastMacroRegenAt.get(scope) ?? 0;
  if (now - last < MACRO_REGEN_WINDOW_MS) {
    return NextResponse.json(
      { success: false, error: "rate-limited", retryAfter: MACRO_REGEN_WINDOW_MS - (now - last) },
      { status: 429 }
    );
  }
  lastMacroRegenAt.set(scope, now);
  const week = mondayOf(new Date().toISOString().slice(0, 10));
  try {
    const r = await generateMacroThemes(db, { scope, weekOf: week, forceRegen: true });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

export function __resetMacroRegenLimitForTests() {
  lastMacroRegenAt.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/analysis-macro-themes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/analysis/macro-themes/route.ts tests/api/analysis-macro-themes.test.ts
git commit -m "feat(p4-slice-a): /api/analysis/macro-themes GET + POST (rate-limited)"
```

### Task A8: Sunday briefing pre-gen hook

- [ ] **Step 1: Locate the existing narrative pre-gen block**

`lib/digest/send-briefing.ts` lines 88-112 are the narrative pre-gen block. New code goes right after it (before the regression backfill block ~line 117).

- [ ] **Step 2: Add the pre-gen block**

Insert after the narrative pre-gen, before the regression backfill:

```ts
  // Macro themes pre-generation. 4 scopes × 1/wk = 4 Sonnet calls, run in
  // parallel. Cached per (scope, week_of). Failures here MUST NOT block the
  // briefing. Cost: ~$0.85/month at Sunday cadence.
  try {
    const { generateMacroThemes } = await import("@/lib/compute/macro-themes");
    const SCOPES_FOR_MACRO = ["all", "vanguard", "ibkr", "roth"] as const;
    const macroWeek = mondayOf(weekOf);
    const macroResults = await Promise.allSettled(
      SCOPES_FOR_MACRO.map((scope) =>
        generateMacroThemes(db, { scope, weekOf: macroWeek })
      )
    );
    const macroFailed = macroResults.filter((r) => r.status === "rejected").length;
    if (macroFailed > 0) {
      console.warn(
        `[send-briefing] ${macroFailed} of ${macroResults.length} macro-theme pre-generations failed`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-briefing] macro-themes pre-generation skipped: ${msg}`);
  }
```

- [ ] **Step 3: Write a smoke test**

Create `tests/digest/send-briefing-macro-pregen.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("send-briefing macro-themes pre-gen smoke", () => {
  it("caches an empty themes row when no signal exists", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const { generateMacroThemes } = await import("@/lib/compute/macro-themes");
    const r = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(r.underThreshold).toBe(true);
    expect(r.themes).toEqual([]);
    const cached = getCachedMacroThemes(db, "all", "2026-05-04");
    expect(cached).not.toBeNull();
    expect(cached!.themesJson).toBe("[]");
  });
});
```

- [ ] **Step 4: Run smoke test**

Run: `npx vitest run tests/digest/send-briefing-macro-pregen.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: ~1932 pass (1913 prior + 19 new for Slice A: 1 migration + 3 queries + 5 schema + 3 signal blob + 3 generator + 3 API + 1 smoke; 3 send-evening pre-existing failures unchanged).

- [ ] **Step 6: Commit**

```bash
git add lib/digest/send-briefing.ts tests/digest/send-briefing-macro-pregen.test.ts
git commit -m "feat(p4-slice-a): Sunday-briefing pre-gen for macro themes (4 scopes)"
```

**Slice A complete.** Macro themes ship to cache every Sunday; on-demand regen available via POST with 24h rate-limit; under-threshold weeks cache empty arrays.

---

## Slice B — MacroOverlayCard component + source receipt drawer

**Goal:** Replace the P2 `MacroOverlayPlaceholder` with a real `<MacroOverlayCard>` that reads from `/api/analysis/macro-themes`. Each theme: sentiment dot · name · exposure pill · summary · "View sources" affordance. Click opens a slide-in drawer listing source articles/events/alerts.

**Files this slice touches:**
- Create: `app/dashboard/components/analysis/MacroOverlayCard.tsx`
- Create: `app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx`
- Modify: `app/dashboard/components/analysis/WorkspacePanel.tsx`
- Delete: `app/dashboard/components/analysis/MacroOverlayPlaceholder.tsx`

> **Visual test pattern:** UI-heavy slice. Tests focus on data-binding integrity. No visual regression tests; user explicitly deferred serious testing to after P4.

### Task B1: MacroOverlayCard + receipt drawer (with SymbolLink wiring)

- [ ] **Step 0: Verify the existing SymbolLink + Research article filter URL pattern**

Before writing the drawer, confirm the link primitives exist:

```bash
ls app/dashboard/components/SymbolLink.tsx 2>/dev/null && grep -r "articleId" app/dashboard/research 2>/dev/null | head -3
```

- If `SymbolLink` exists and `/dashboard/research?articleId=…` is a recognized filter, use both.
- If only `SymbolLink` exists but the article filter isn't implemented, use `<SymbolLink>` for alert symbols and fall back to `/dashboard/research` (no article filter) with the article title in a `title=` tooltip attribute.
- If neither exists, ship raw `<a>` tags for both and file a follow-up.

Decide and proceed; bake the decision directly into the drawer code in Step 2.

- [ ] **Step 1: Create the component**

Create `app/dashboard/components/analysis/MacroOverlayCard.tsx`. Uses existing design tokens (`bg-panel`, `border-edge`, `text-ink`, `bg-amber/20`):

```tsx
"use client";

import { useEffect, useState } from "react";
import { MacroThemeReceiptDrawer } from "./MacroThemeReceiptDrawer";

interface MacroTheme {
  name: string;
  factor_label: string;
  direction: "risk-on" | "risk-off" | "neutral";
  summary: string;
  exposure_bucket: "low" | "moderate" | "high" | "very-high";
  top_contributors: Array<{ symbol: string; weight: number }>;
}

interface ApiResponse {
  success: boolean;
  themes?: MacroTheme[];
  sourceSummary?: {
    articles: Array<{ id: number; title: string }>;
    events: Array<{ id: number; symbol: string | null; event_date: string }>;
    alerts: Array<{ id: number; symbol: string }>;
  } | null;
  underThreshold?: boolean;
  generatedAt?: string;
  fromCache?: boolean;
  error?: string;
}

const FACTOR_LABELS: Record<string, string> = {
  interest_rate_sensitive: "Rate-sensitive",
  growth_vs_value: "Growth vs value",
  cyclical: "Cyclicality",
  international_exposure: "International",
  geopolitical_onshoring: "Onshoring",
  tariff_exposure: "Tariff",
  ai_exposure: "AI",
  crypto_adjacent: "Crypto-adjacent",
  regulatory_risk: "Regulatory",
};

function directionColor(d: MacroTheme["direction"]) {
  if (d === "risk-on") return "var(--up, #10b981)";
  if (d === "risk-off") return "var(--down, #ef4444)";
  return "var(--ink-faint, #94a3b8)";
}

function exposurePillStyle(b: MacroTheme["exposure_bucket"]) {
  switch (b) {
    case "very-high": return "bg-amber/30 text-amber border-amber/40";
    case "high":      return "bg-amber/20 text-amber border-amber/30";
    case "moderate":  return "bg-edge/40 text-ink-dim border-edge";
    case "low":       return "bg-edge/20 text-ink-faint border-edge/40";
  }
}

export function MacroOverlayCard({ scope }: { scope: string }) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpenForThemeIdx, setDrawerOpenForThemeIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/analysis/macro-themes?scope=${encodeURIComponent(scope)}`)
      .then((r) => r.json())
      .then((j: ApiResponse) => { if (!cancelled) setData(j); })
      .catch(() => { if (!cancelled) setData({ success: false, error: "network error" }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope]);

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink">Macro this week</h3>
          <p className="text-xs text-ink-faint mt-0.5">
            AI-distilled themes from research feeds + macro releases
            <span className="ml-2 italic">· {scope}</span>
          </p>
        </div>
        {data?.generatedAt && (
          <span className="text-[10px] text-ink-faint uppercase tracking-wider">
            {data.fromCache ? "cached" : "fresh"}
          </span>
        )}
      </header>

      {loading && (
        <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
          <p className="text-xs text-ink-faint">Loading…</p>
        </div>
      )}

      {!loading && data?.underThreshold && (
        <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
          <p className="text-xs text-ink-faint">No actionable themes this week — insufficient signal.</p>
        </div>
      )}

      {!loading && data?.themes && data.themes.length > 0 && (
        <ul className="space-y-2">
          {data.themes.map((t, i) => (
            <li key={i} className="rounded-lg border border-edge/60 bg-canvas px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full mt-1.5 shrink-0"
                  style={{ backgroundColor: directionColor(t.direction) }} />
                <h4 className="text-sm font-medium text-ink flex-1">{t.name}</h4>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${exposurePillStyle(t.exposure_bucket)} uppercase tracking-wide`}>
                  your exposure: {t.exposure_bucket}
                </span>
              </div>
              <p className="text-xs text-ink-dim mt-1 ml-4">{t.summary}</p>
              <div className="mt-2 ml-4 flex items-center gap-3 text-[11px]">
                <span className="text-ink-faint">factor: {FACTOR_LABELS[t.factor_label] ?? t.factor_label}</span>
                {t.top_contributors.length > 0 && (
                  <span className="text-ink-faint">top: {t.top_contributors.map((c) => c.symbol).join(", ")}</span>
                )}
                <button type="button" onClick={() => setDrawerOpenForThemeIdx(i)}
                  className="ml-auto text-amber hover:text-amber/80 transition-colors">
                  View sources →
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!loading && data && !data.success && !data.underThreshold && (
        <div className="rounded-lg border border-down/40 bg-canvas px-3 py-3 text-center">
          <p className="text-xs text-down">{data.error ?? "Failed to load macro themes"}</p>
        </div>
      )}

      {drawerOpenForThemeIdx !== null && data?.sourceSummary && data.themes && (
        <MacroThemeReceiptDrawer
          theme={data.themes[drawerOpenForThemeIdx]}
          sourceSummary={data.sourceSummary}
          onClose={() => setDrawerOpenForThemeIdx(null)}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 2: Create the receipt drawer**

Create `app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx`:

```tsx
"use client";

interface Theme {
  name: string;
  factor_label: string;
  direction: "risk-on" | "risk-off" | "neutral";
  summary: string;
}

interface SourceSummary {
  articles: Array<{ id: number; title: string }>;
  events: Array<{ id: number; symbol: string | null; event_date: string }>;
  alerts: Array<{ id: number; symbol: string }>;
}

export function MacroThemeReceiptDrawer({
  theme, sourceSummary, onClose,
}: { theme: Theme; sourceSummary: SourceSummary; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose} role="dialog" aria-label={`Sources for ${theme.name}`}>
      <div className="flex-1 bg-black/30" aria-hidden="true" />
      <aside className="w-full max-w-md bg-panel border-l border-edge p-5 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <header className="mb-4 flex items-baseline justify-between">
          <div>
            <h2 className="text-base font-medium text-ink">{theme.name}</h2>
            <p className="text-xs text-ink-faint mt-1">{theme.summary}</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink text-sm" aria-label="Close">✕</button>
        </header>

        <section className="mb-4">
          <h3 className="text-xs uppercase tracking-wider text-ink-faint mb-2">Articles ({sourceSummary.articles.length})</h3>
          <ul className="space-y-1.5">
            {sourceSummary.articles.map((a) => (
              <li key={a.id} className="text-xs text-ink-dim">
                <a href={`/dashboard/research?articleId=${a.id}`} className="hover:text-ink">{a.title}</a>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-4">
          <h3 className="text-xs uppercase tracking-wider text-ink-faint mb-2">Macro events ({sourceSummary.events.length})</h3>
          <ul className="space-y-1.5">
            {sourceSummary.events.map((e) => (
              <li key={e.id} className="text-xs text-ink-dim">{e.symbol ?? "macro"} · {e.event_date}</li>
            ))}
          </ul>
        </section>

        <section className="mb-4">
          <h3 className="text-xs uppercase tracking-wider text-ink-faint mb-2">Level alerts ({sourceSummary.alerts.length})</h3>
          <ul className="space-y-1.5">
            {sourceSummary.alerts.map((al) => (
              <li key={al.id} className="text-xs text-ink-dim">{al.symbol}</li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
```

- [ ] **Step 3: Swap placeholder for real card in WorkspacePanel**

Edit `app/dashboard/components/analysis/WorkspacePanel.tsx`:

```tsx
// Replace:
import { MacroOverlayPlaceholder } from "./MacroOverlayPlaceholder";
// With:
import { MacroOverlayCard } from "./MacroOverlayCard";

// In JSX replace:
<MacroOverlayPlaceholder scope={scope} />
// With:
<MacroOverlayCard scope={scope} />
```

- [ ] **Step 4: Delete the placeholder**

Run: `rm app/dashboard/components/analysis/MacroOverlayPlaceholder.tsx`

Verify nothing else imports it: `grep -r "MacroOverlayPlaceholder" --include="*.tsx" --include="*.ts" app/ lib/ tests/`
Expected: no matches.

- [ ] **Step 5: Run typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/components/analysis/MacroOverlayCard.tsx app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx app/dashboard/components/analysis/WorkspacePanel.tsx
git rm app/dashboard/components/analysis/MacroOverlayPlaceholder.tsx
git commit -m "feat(p4-slice-b): MacroOverlayCard replaces placeholder in Workspace"
```

**Slice B complete.** Placeholder gone; Workspace renders themes with clickable source receipts (Step 0 above already wired SymbolLink + article URLs into the initial drawer ship).

---

## Slice C — Briefing email "Macro context" integration

**Goal:** Same `analysis_macro_themes` cache feeds the Sunday briefing email's prompt context. One source of truth: email + app agree on "what's hot this week."

**Approach:** After Slice A pre-gens themes, the briefing's prompt-building step reads them back from cache, formats as markdown bullet list under `## Macro context this week`, and prepends to the Opus prompt context. **No new AI cost** — just reading what Slice A wrote.

**Files this slice touches:**
- Create: `lib/digest/macro-themes-markdown.ts`
- Modify: `lib/digest/send-briefing.ts` (prompt-building section)

### Task C1: Render themes to markdown

- [ ] **Step 1: Write the failing test**

Create `tests/digest/macro-themes-markdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderMacroThemesMarkdown } from "@/lib/digest/macro-themes-markdown";

describe("renderMacroThemesMarkdown", () => {
  it("returns null when themes array is empty", () => {
    expect(renderMacroThemesMarkdown([])).toBeNull();
  });

  it("renders a heading and one bullet per theme", () => {
    const md = renderMacroThemesMarkdown([
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "Trade headlines pushed risk lower.", exposure_bucket: "high",
        top_contributors: [{ symbol: "AAPL", weight: 0.04 }] },
      { name: "Rate cut hopes", factor_label: "interest_rate_sensitive", direction: "risk-on",
        summary: "Softer CPI revived September cut bets.", exposure_bucket: "moderate",
        top_contributors: [] },
    ]);
    expect(md).toContain("## Macro context this week");
    expect(md).toContain("Tariff escalation");
    expect(md).toContain("risk-off");
    expect(md).toContain("your exposure: high");
    expect(md).toContain("Rate cut hopes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest/macro-themes-markdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the renderer**

Create `lib/digest/macro-themes-markdown.ts`:

```ts
import type { MacroTheme } from "@/lib/compute/macro-themes";

const DIRECTION_GLYPHS: Record<MacroTheme["direction"], string> = {
  "risk-on": "↑", "risk-off": "↓", neutral: "→",
};

/**
 * Renders cached macro themes as a markdown block for inclusion in the Sunday
 * briefing prompt. Returns null on empty input so the caller can omit the
 * section entirely rather than emitting a heading with no bullets.
 */
export function renderMacroThemesMarkdown(themes: MacroTheme[]): string | null {
  if (themes.length === 0) return null;
  const lines: string[] = ["## Macro context this week", ""];
  for (const t of themes) {
    const arrow = DIRECTION_GLYPHS[t.direction] ?? "·";
    const contribs = t.top_contributors.length > 0
      ? ` · top: ${t.top_contributors.map((c) => c.symbol).join(", ")}`
      : "";
    lines.push(`- **${t.name}** ${arrow} *${t.direction}* · your exposure: ${t.exposure_bucket}${contribs}`);
    lines.push(`  ${t.summary}`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest/macro-themes-markdown.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/digest/macro-themes-markdown.ts tests/digest/macro-themes-markdown.test.ts
git commit -m "feat(p4-slice-c): renderMacroThemesMarkdown for briefing prompt context"
```

### Task C2: Thread themes into the briefing's Opus prompt

- [ ] **Step 1: Locate the prompt-building section**

```bash
grep -n "calendar_briefings\|generateText\|buildPrompt\|prompt =\|opus" /Users/Yitzi/code/vanguard-skin/lib/digest/send-briefing.ts | head -20
```

Expect to find the prompt being assembled somewhere in the second half of the file (typical pattern: a multi-section string built up with template literals or `Array.join("\n\n")`, then passed to `generateText({ model, system, prompt })` in a single call). Note the line range — you'll insert the macro-context read just BEFORE the `prompt` variable is finalized and just AFTER any newsletter / calendar / Vital-Knowledge sections are built (so the macro section appears at the TOP of the assembled prompt context, before the dense newsletter excerpts).

If the prompt is built across many ad-hoc concatenations rather than a clean array-and-join, refactor opportunistically — the array-and-join pattern below makes the insertion trivial and is the project's established style for compose pipelines (`lib/digest/synthesize.ts` is a good reference).

- [ ] **Step 2: Read themes from cache + prepend to prompt**

In the prompt-building section of `send-briefing.ts`, just before the prompt is passed to `generateText`, insert:

```ts
  // Macro context: read cached themes for "all" scope. Workspace card and
  // briefing email read from the same cache so they stay in sync. Failure
  // here MUST NOT block the email — just skip the section.
  let macroContextMd: string | null = null;
  try {
    const { getCachedMacroThemes } = await import("@/lib/queries/analysis-macro-themes");
    const { renderMacroThemesMarkdown } = await import("@/lib/digest/macro-themes-markdown");
    const cached = getCachedMacroThemes(db, "all", mondayOf(weekOf));
    if (cached) {
      const themes = JSON.parse(cached.themesJson);
      macroContextMd = renderMacroThemesMarkdown(themes);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-briefing] macro-context section skipped: ${msg}`);
  }
```

Then prepend `macroContextMd` (when non-null) before the next section header. If the prompt uses array-and-join:

```ts
const prompt = [
  macroContextMd,
  // ... existing sections ...
].filter(Boolean).join("\n\n");
```

If string concatenation: `${macroContextMd ? macroContextMd + "\n\n" : ""}`.

- [ ] **Step 3: Append a read-through smoke test**

Append to `tests/digest/send-briefing-macro-pregen.test.ts`:

```ts
import { renderMacroThemesMarkdown } from "@/lib/digest/macro-themes-markdown";
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("send-briefing read-through to cache", () => {
  it("renders themes from the cache that the pre-gen step writes", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const themes = [{
      name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off" as const,
      summary: "Trade headlines pushed risk lower.", exposure_bucket: "high" as const,
      top_contributors: [{ symbol: "AAPL", weight: 0.04 }],
    }];
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify(themes), sourceSummary: null, modelUsed: "v1",
    });
    const md = renderMacroThemesMarkdown(themes);
    expect(md).not.toBeNull();
    expect(md!).toContain("Tariff escalation");
  });
});
```

- [ ] **Step 4: Run the smoke test**

Run: `npx vitest run tests/digest/send-briefing-macro-pregen.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: no regression.

- [ ] **Step 6: Commit**

```bash
git add lib/digest/send-briefing.ts tests/digest/send-briefing-macro-pregen.test.ts
git commit -m "feat(p4-slice-c): briefing email reads macro themes from same cache"
```

**Slice C complete.** Sunday's briefing email contains a "Macro context this week" section sourced from the same cache the Workspace card reads.

---

## Slice D — Cross-cuts: Cash-Deploy + Scenario picker

**Goal:** Two cross-cuts the spec calls out. **(1)** When ranking Cash-Deploy gaps, prefer gaps that align with active risk-on/risk-off themes — defensive sectors get a boost during risk-off weeks; aggressive sectors get a boost during risk-on weeks. **(2)** Scenario picker shows a "live now" pill on scenarios whose primary factor matches an active theme.

**Files this slice touches:**
- Modify: `lib/compute/cash-deploy.ts`
- Modify: `app/api/analysis/cash-deploy/route.ts`
- Modify: `lib/compute/scenario-recipes.ts`
- Modify: `app/api/compute/scenarios/route.ts`
- Modify: `app/dashboard/components/ScenarioModeling.tsx`
- Test: `tests/compute/cash-deploy-theme-aware.test.ts`
- Test: `tests/compute/scenario-recipes-live-now.test.ts`

### Task D1: Cash-Deploy gap re-ranking — TDD

- [ ] **Step 1: Write the failing tests**

Create `tests/compute/cash-deploy-theme-aware.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyThemeAwareBoost } from "@/lib/compute/cash-deploy";
import type { SectorGap } from "@/lib/compute/cash-deploy";

describe("applyThemeAwareBoost", () => {
  const baseGaps: SectorGap[] = [
    { sector: "Technology", currentWeight: 0.20, targetWeight: 0.30, gapPp: -10, dollarGap: -10000, gapClosureScore: 0 },
    { sector: "Healthcare", currentWeight: 0.05, targetWeight: 0.15, gapPp: -10, dollarGap: -10000, gapClosureScore: 0 },
    { sector: "Energy", currentWeight: 0.08, targetWeight: 0.05, gapPp: 3, dollarGap: 3000, gapClosureScore: 0 },
  ];

  it("no boost when activeThemes is empty", () => {
    const r = applyThemeAwareBoost(baseGaps, []);
    expect(r[0].gapClosureScore).toBeCloseTo(10, 5);
    expect(r[1].gapClosureScore).toBeCloseTo(10, 5);
  });

  it("risk-off theme boosts defensive sector gap", () => {
    const r = applyThemeAwareBoost(baseGaps, [
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const hc = r.find((g) => g.sector === "Healthcare")!;
    const tech = r.find((g) => g.sector === "Technology")!;
    expect(hc.gapClosureScore).toBeGreaterThan(tech.gapClosureScore);
  });

  it("risk-on theme boosts aggressive sector gap", () => {
    const r = applyThemeAwareBoost(baseGaps, [
      { name: "Rate cut hopes", factor_label: "interest_rate_sensitive", direction: "risk-on",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const tech = r.find((g) => g.sector === "Technology")!;
    const hc = r.find((g) => g.sector === "Healthcare")!;
    expect(tech.gapClosureScore).toBeGreaterThan(hc.gapClosureScore);
  });

  it("neutral theme is a no-op", () => {
    const r = applyThemeAwareBoost(baseGaps, [
      { name: "Mixed signals", factor_label: "ai_exposure", direction: "neutral",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    expect(r[0].gapClosureScore).toBeCloseTo(10, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compute/cash-deploy-theme-aware.test.ts`
Expected: FAIL — `applyThemeAwareBoost` not exported, or `SectorGap` missing `gapClosureScore`.

- [ ] **Step 3: Extend `SectorGap` + implement `applyThemeAwareBoost`**

In `lib/compute/cash-deploy.ts`:

1. Add `gapClosureScore: number` to the `SectorGap` interface. Existing producers need a default — set `gapClosureScore: Math.abs(gapPp)` at construction.

2. Export `applyThemeAwareBoost`:

```ts
import type { MacroTheme } from "./macro-themes";

const DEFENSIVE_SECTORS = new Set([
  "Utilities", "Consumer Staples", "Healthcare", "Real Estate",
]);
const AGGRESSIVE_SECTORS = new Set([
  "Technology", "Consumer Discretionary", "Communication Services",
]);
const BOOST_MULTIPLIER = 1.15;

export function applyThemeAwareBoost(
  gaps: SectorGap[],
  themes: MacroTheme[]
): SectorGap[] {
  if (themes.length === 0) {
    return gaps.map((g) => ({ ...g, gapClosureScore: Math.abs(g.gapPp) }));
  }
  const netDirection = themes.reduce((d, t) => {
    if (t.direction === "risk-off") return d - 1;
    if (t.direction === "risk-on") return d + 1;
    return d;
  }, 0);
  if (netDirection === 0) {
    return gaps.map((g) => ({ ...g, gapClosureScore: Math.abs(g.gapPp) }));
  }
  return gaps.map((g) => {
    const base = Math.abs(g.gapPp);
    let boost = 1;
    if (netDirection < 0 && DEFENSIVE_SECTORS.has(g.sector)) boost = BOOST_MULTIPLIER;
    if (netDirection > 0 && AGGRESSIVE_SECTORS.has(g.sector)) boost = BOOST_MULTIPLIER;
    return { ...g, gapClosureScore: base * boost };
  });
}
```

3. In existing `suggestAllocation`, after producing `gaps`, call `applyThemeAwareBoost(gaps, opts.activeThemes ?? [])`. Add `activeThemes?: MacroTheme[]` to input opts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/compute/cash-deploy-theme-aware.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: PASS — if `tests/compute/cash-deploy.test.ts` breaks, fill in missing `gapClosureScore` defaults.

- [ ] **Step 6: Commit**

```bash
git add lib/compute/cash-deploy.ts tests/compute/cash-deploy-theme-aware.test.ts
git commit -m "feat(p4-slice-d): theme-aware gap boost in Cash-Deploy"
```

### Task D2: Wire active themes through the Cash-Deploy API

- [ ] **Step 1: Write the failing wire-through test**

Append to `tests/compute/cash-deploy-theme-aware.test.ts` (or create a sibling `tests/api/cash-deploy-themes.test.ts` if you prefer route-level isolation):

```ts
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("/api/analysis/cash-deploy reads active themes from cache", () => {
  it("passes themes to suggestAllocation when cache hit", async () => {
    // Spy on suggestAllocation. Vitest's vi.spyOn works without manual mocks.
    const cashDeploy = await import("@/lib/compute/cash-deploy");
    const spy = vi.spyOn(cashDeploy, "suggestAllocation").mockReturnValue({
      scope: "all", cashAmount: 10000, benchmarkSymbol: "VTI",
      mode: "benchmark", gaps: [], picks: [], totalAllocated: 0, cashRemaining: 10000, notes: [],
    } as any);
    const { db } = await import("@/lib/db");
    upsertMacroThemes(db, {
      scope: "all", weekOf: new Date().toISOString().slice(0,10),
      themesJson: JSON.stringify([{
        name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x".repeat(20), exposure_bucket: "moderate", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const { GET } = await import("@/app/api/analysis/cash-deploy/route");
    const req = new Request("http://localhost/api/analysis/cash-deploy?scope=all&cash=10000");
    await GET(req as any);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      activeThemes: expect.arrayContaining([expect.objectContaining({ direction: "risk-off" })]),
    }));
    spy.mockRestore();
  });

  it("passes empty array when cache miss", async () => {
    const cashDeploy = await import("@/lib/compute/cash-deploy");
    const spy = vi.spyOn(cashDeploy, "suggestAllocation").mockReturnValue({} as any);
    const { GET } = await import("@/app/api/analysis/cash-deploy/route");
    const req = new Request("http://localhost/api/analysis/cash-deploy?scope=vanguard&cash=10000");
    await GET(req as any);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      activeThemes: [],
    }));
    spy.mockRestore();
  });
});
```

> The two scenarios here count as **one effective test** in the +1 count for "cash-deploy API wire-through" — written as a `describe` block with two `it`s for readability; combine if your project style prefers single-it tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "reads active themes from cache"`
Expected: FAIL — `activeThemes` not yet threaded.

- [ ] **Step 3: Modify `app/api/analysis/cash-deploy/route.ts`**

```ts
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { mondayOf } from "@/lib/calendar/date-utils";

// Inside the handler, after parsing scope:
const weekOf = mondayOf(new Date().toISOString().slice(0, 10));
const cached = getCachedMacroThemes(db, scope, weekOf);
const activeThemes = cached ? JSON.parse(cached.themesJson) : [];

const result = suggestAllocation(db, { scope, cashAmount, activeThemes });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run -t "reads active themes from cache"`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/analysis/cash-deploy/route.ts tests/compute/cash-deploy-theme-aware.test.ts
git commit -m "feat(p4-slice-d): wire active themes into /api/analysis/cash-deploy"
```

### Task D3: Scenario "live now" decoration

- [ ] **Step 1: Write the failing test**

Create `tests/compute/scenario-recipes-live-now.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchScenariosToThemes, SCENARIO_RECIPES } from "@/lib/compute/scenario-recipes";

describe("matchScenariosToThemes", () => {
  it("returns scenarios unchanged when themes is empty", () => {
    const r = matchScenariosToThemes(SCENARIO_RECIPES, []);
    expect(r.every((s) => s.liveNowReason === undefined)).toBe(true);
  });

  it("decorates Tariff scenario when a tariff_exposure risk-off theme is active", () => {
    const r = matchScenariosToThemes(SCENARIO_RECIPES, [
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const tariffScenarios = r.filter((s) => s.primaryFactor === "tariff_exposure");
    expect(tariffScenarios.length).toBeGreaterThan(0);
    expect(tariffScenarios[0].liveNowReason).toMatch(/Tariff escalation/);
  });

  it("does not decorate scenarios whose factor doesn't match any active theme", () => {
    const r = matchScenariosToThemes(SCENARIO_RECIPES, [
      { name: "AI mania cooling", factor_label: "ai_exposure", direction: "risk-off",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const ratesScenarios = r.filter((s) => s.primaryFactor === "interest_rate_sensitive");
    expect(ratesScenarios.every((s) => s.liveNowReason === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compute/scenario-recipes-live-now.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `ScenarioRecipe` + implement `matchScenariosToThemes`**

In `lib/compute/scenario-recipes.ts`:

1. Confirm each recipe has a `primaryFactor: FactorColumn` field. If not, add it (use the dominant factor in the sensitivity map).

2. Add `liveNowReason?: string;` to the `ScenarioRecipe` interface.

3. Export the matcher:

```ts
import type { MacroTheme } from "./macro-themes";
import type { ScenarioRecipe } from "./scenario-recipes";

export function matchScenariosToThemes(
  recipes: ScenarioRecipe[],
  themes: MacroTheme[]
): ScenarioRecipe[] {
  if (themes.length === 0) {
    return recipes.map((r) => ({ ...r, liveNowReason: undefined }));
  }
  return recipes.map((r) => {
    const match = themes.find((t) => t.factor_label === r.primaryFactor);
    if (!match) return { ...r, liveNowReason: undefined };
    return { ...r, liveNowReason: match.name };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/compute/scenario-recipes-live-now.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing scenarios-API wire-through test**

Append to `tests/compute/scenario-recipes-live-now.test.ts`:

```ts
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { mondayOf } from "@/lib/calendar/date-utils";

describe("/api/compute/scenarios decorates recipes when themes are cached", () => {
  it("attaches liveNowReason to scenarios matching an active theme's factor_label", async () => {
    const { db } = await import("@/lib/db");
    const today = new Date().toISOString().slice(0, 10);
    upsertMacroThemes(db, {
      scope: "all", weekOf: mondayOf(today),
      themesJson: JSON.stringify([{
        name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x".repeat(20), exposure_bucket: "moderate", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const { GET } = await import("@/app/api/compute/scenarios/route");
    const req = new Request("http://localhost/api/compute/scenarios?accountId=1");
    const res = await GET(req as any);
    const body = await res.json();
    const tariffScenario = body.scenarios?.find((s: any) => s.primaryFactor === "tariff_exposure");
    expect(tariffScenario?.liveNowReason).toMatch(/Tariff escalation/);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/compute/scenario-recipes-live-now.test.ts -t "decorates recipes"`
Expected: FAIL — `liveNowReason` not yet decorated by the route.

- [ ] **Step 7: Wire through the scenarios API**

Modify `app/api/compute/scenarios/route.ts`:
1. Read current-week themes from cache (same pattern as D2).
2. Call `matchScenariosToThemes(SCENARIO_RECIPES, themes)` before returning.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/compute/scenario-recipes-live-now.test.ts`
Expected: PASS (4 tests now — 3 matcher unit + 1 wire-through integration).

- [ ] **Step 9: Render "live now" pill in the UI**

In `app/dashboard/components/ScenarioModeling.tsx`, locate the scenario picker. Beside each option that has `liveNowReason`:

```tsx
{recipe.liveNowReason && (
  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border bg-amber/20 text-amber border-amber/40 uppercase tracking-wide"
        title={`Live theme: ${recipe.liveNowReason}`}>
    live now
  </span>
)}
```

If `ScenarioModeling.tsx` doesn't currently receive recipe metadata (only an enum), thread it through the API response shape.

- [ ] **Step 10: Run full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add lib/compute/scenario-recipes.ts app/api/compute/scenarios/route.ts app/dashboard/components/ScenarioModeling.tsx tests/compute/scenario-recipes-live-now.test.ts
git commit -m "feat(p4-slice-d): scenario picker shows 'live now' pill on theme-matched recipes"
```

**Slice D complete.** Cash-Deploy boosts gaps that align with the week's theme direction; Scenario picker badges scenarios aligned to active themes. Both read from the same cache.

---

## Slice E — Polish fold-in (3 P3 follow-ups)

**Goal:** Close three small carry-overs from P3 before declaring the Analysis Deep Dive done.

1. **E1:** GET `/api/analysis/narrative` cache-miss rate-limit
2. **E2:** PositionRisk per-row W-o-W badges
3. **E3:** Bond `maturity_date` regex backfill

### Task E1: GET narrative rate-limit

- [ ] **Step 0: Read the current GET handler**

```bash
sed -n '1,60p' app/api/analysis/narrative/route.ts
```

Confirm three things before writing the test:
1. The GET handler **does** call `generateNarrative` on every invocation today (the cache lookup currently lives INSIDE `generateNarrative`, not at the route).
2. The POST handler has its own `lastRegenAt` Map + `REGEN_WINDOW_MS = 24*60*60*1000`.
3. `__resetRateLimitForTests()` already exists and clears `lastRegenAt`.

The new code below adds a **separate** map and window for GET, plus a route-level cache lookup that bypasses the rate-limit on cache hit. This avoids duplicating the cache lookup inside `generateNarrative` — the existing helper still does its own cache check, but the route-level check returns sooner (no module imports, no generateNarrative invocation at all) so cache hits never count against the limiter.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/analysis-narrative.test.ts` (or create if missing):

```ts
import { describe, it, expect, beforeEach } from "vitest";

describe("/api/analysis/narrative GET cache-miss rate-limit", () => {
  beforeEach(async () => {
    const { __resetRateLimitForTests } = await import("@/app/api/analysis/narrative/route");
    __resetRateLimitForTests();
  });

  it("first cache-miss call goes through; second within window is rate-limited", async () => {
    const { GET, __resetRateLimitForTests } = await import("@/app/api/analysis/narrative/route");
    __resetRateLimitForTests();
    const req = () => new Request("http://localhost/api/analysis/narrative?scope=all&surface=factor-analysis");
    await GET(req() as any);
    const res2 = await GET(req() as any);
    expect(res2.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/analysis-narrative.test.ts -t "rate-limit"`
Expected: FAIL — second call probably 200s or 500s without the limiter.

- [ ] **Step 3: Add cache-miss rate-limit to GET**

In `app/api/analysis/narrative/route.ts`:

```ts
// Separate map for GET cache-miss attempts; 60s window — goal is to prevent
// thundering herd on cold cache, not match the 24h POST window.
const lastCacheMissAt = new Map<string, number>();
const CACHE_MISS_WINDOW_MS = 60 * 1000;

export async function GET(req: NextRequest) {
  // ... existing scope + surface parsing ...

  const week = mondayOf(new Date().toISOString().slice(0, 10));

  // Cache lookup FIRST without invoking generateNarrative. If hit, return
  // immediately and skip the rate-limit gate.
  const { getCachedNarrative } = await import("@/lib/queries/analysis-narratives");
  const cached = getCachedNarrative(db, scope, surface, week);
  if (cached) {
    return NextResponse.json({
      success: true,
      narrativeMd: cached.narrativeMd,
      fromCache: true,
      generatedAt: cached.generatedAt,
    });
  }

  // Cache miss — apply per-(scope, surface) rate-limit.
  const key = `${scope}::${surface}`;
  const now = Date.now();
  const last = lastCacheMissAt.get(key) ?? 0;
  if (now - last < CACHE_MISS_WINDOW_MS) {
    return NextResponse.json(
      { success: false, error: "rate-limited (cache miss)",
        retryAfter: CACHE_MISS_WINDOW_MS - (now - last) },
      { status: 429 }
    );
  }
  lastCacheMissAt.set(key, now);

  try {
    const r = await generateNarrative(db, { scope, surfaceKey: surface, weekOf: week });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

// Update the test-reset helper to clear both maps.
export function __resetRateLimitForTests() {
  lastRegenAt.clear();
  lastCacheMissAt.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/analysis-narrative.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/analysis/narrative/route.ts tests/api/analysis-narrative.test.ts
git commit -m "fix(p4-slice-e): GET /api/analysis/narrative cache-miss rate-limit (60s window)"
```

### Task E2: PositionRisk per-row W-o-W badges

- [ ] **Step 1: Inspect the existing position-risk API response shape**

Run: `grep -n "weekAgo\|delta" /Users/Yitzi/code/vanguard-skin/app/api/compute/position-risk/route.ts | head -10`

Confirm route returns `{ data: PositionRiskRow[], weekAgo: { positions: PositionRiskRow[] } | null }`.

- [ ] **Step 2: Read PositionRisk.tsx to find the per-row render**

Open `app/dashboard/components/PositionRisk.tsx` and locate the row map.

- [ ] **Step 3: Extract the delta-lookup logic into a pure helper + write the failing test**

The simplest way to keep the component testable is to move the Map-build + per-row delta lookup into a small pure helper at the top of `PositionRisk.tsx` (or a sibling file). Create `tests/dashboard/position-risk-wow-delta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeWeekOverWeekDelta } from "@/app/dashboard/components/PositionRisk";

describe("computeWeekOverWeekDelta", () => {
  it("returns the per-symbol delta when both current and prior rows exist", () => {
    const current = [
      { symbol: "NVDA", riskContribution: 0.18 },
      { symbol: "AAPL", riskContribution: 0.06 },
    ];
    const past = [
      { symbol: "NVDA", riskContribution: 0.14 },
      { symbol: "AAPL", riskContribution: 0.08 },
    ];
    expect(computeWeekOverWeekDelta(current[0], past)).toBeCloseTo(0.04, 5);
    expect(computeWeekOverWeekDelta(current[1], past)).toBeCloseTo(-0.02, 5);
  });

  it("returns null when the prior week has no matching symbol", () => {
    const current = { symbol: "NEW_TICKER", riskContribution: 0.05 };
    const past = [{ symbol: "OLD", riskContribution: 0.10 }];
    expect(computeWeekOverWeekDelta(current, past)).toBeNull();
  });

  it("returns null when prior week is null or empty", () => {
    const current = { symbol: "NVDA", riskContribution: 0.18 };
    expect(computeWeekOverWeekDelta(current, null)).toBeNull();
    expect(computeWeekOverWeekDelta(current, [])).toBeNull();
  });
});
```

> **Why extract a pure helper here:** the component is a `"use client"` React component, hard to test without a renderer. Extracting `computeWeekOverWeekDelta` as a top-level export keeps the logic testable without React Testing Library or jsdom setup. The helper is ~6 lines and reusable.

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/dashboard/position-risk-wow-delta.test.ts`
Expected: FAIL — `computeWeekOverWeekDelta` not exported.

- [ ] **Step 5: Implement the helper + wire into the component**

In `app/dashboard/components/PositionRisk.tsx`:

```tsx
type PositionRiskRow = { symbol: string; riskContribution: number; /* ...other fields */ };

export function computeWeekOverWeekDelta(
  current: { symbol: string; riskContribution: number },
  past: Array<{ symbol: string; riskContribution: number }> | null | undefined
): number | null {
  if (!past || past.length === 0) return null;
  const match = past.find((p) => p.symbol === current.symbol);
  if (!match) return null;
  return current.riskContribution - match.riskContribution;
}
```

In the row map, replace any inline delta logic with:

```tsx
const delta = computeWeekOverWeekDelta(row, data?.weekAgo?.positions ?? null);

{delta !== null && (
  <WeekOverWeekBadge
    value={delta}
    formatter={(v) => `${(v * 100).toFixed(1)}pp`}
    invertColors={false}
  />
)}
```

Exact field name (`riskContribution` vs `weight`) and `<WeekOverWeekBadge>` prop signature depend on what P3 actually shipped. Check `app/dashboard/components/analysis/WeekOverWeekBadge.tsx` before implementing.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/dashboard/position-risk-wow-delta.test.ts`
Expected: PASS (3 tests, counted as the +1 "PositionRisk W-o-W badge delta" in the header total).

- [ ] **Step 7: Manually verify in browser**

If a dev server is running, navigate to `/dashboard/analysis` and inspect a Position Risk row. Confirm the badge appears next to rows that have a `weekAgo` counterpart. (Visual verification only; user deferred serious E2E testing.)

- [ ] **Step 8: Commit**

```bash
git add app/dashboard/components/PositionRisk.tsx tests/dashboard/position-risk-wow-delta.test.ts
git commit -m "feat(p4-slice-e): PositionRisk per-row W-o-W badges"
```

### Task E3: Bond maturity_date regex backfill

The user's 16 held bonds carry `maturity_date = NULL` even though the `name` field contains the maturity (e.g., "TREAS 4.5% DUE 11/15/29", "VANG MTD 2027-08-15", "MUNI 3.25% 08/15/30"). Extract via three regex patterns; write back to `securities.maturity_date` in ISO `YYYY-MM-DD` form.

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/backfill-bond-maturity-dates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractMaturityDate } from "@/scripts/backfill-bond-maturity-dates";

describe("extractMaturityDate", () => {
  it("matches 'DUE MM/DD/YY' with 2-digit year (assumes 20YY)", () => {
    expect(extractMaturityDate("TREAS 4.5% DUE 11/15/29")).toBe("2029-11-15");
  });

  it("matches 'DUE MM/DD/YYYY' with 4-digit year", () => {
    expect(extractMaturityDate("TREAS 4.5% DUE 11/15/2029")).toBe("2029-11-15");
  });

  it("matches 'MTD YYYY-MM-DD' ISO form", () => {
    expect(extractMaturityDate("VANG MTD 2027-08-15")).toBe("2027-08-15");
  });

  it("matches first MM/DD/YY token when no DUE keyword", () => {
    expect(extractMaturityDate("MUNI 3.25% 08/15/30")).toBe("2030-08-15");
  });

  it("returns null when no date is parseable", () => {
    expect(extractMaturityDate("TREAS 4.5%")).toBeNull();
  });

  it("returns null when year is out of plausible range", () => {
    expect(extractMaturityDate("DUE 11/15/95")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/backfill-bond-maturity-dates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the extractor**

Create `scripts/backfill-bond-maturity-dates.ts`:

```ts
/**
 * Backfill securities.maturity_date for bond rows where the column is NULL
 * but the name field contains a parseable date.
 *
 * Patterns:
 *   1. "DUE MM/DD/YY"     → "20YY-MM-DD"
 *   2. "DUE MM/DD/YYYY"   → "YYYY-MM-DD"
 *   3. "MTD YYYY-MM-DD"   → "YYYY-MM-DD"
 *   4. First "MM/DD/YY"   → "20YY-MM-DD" (fallback)
 *
 * Year sanity: 2-digit years assumed 2000-2099. Out-of-range returns null.
 */

import Database from "better-sqlite3";
import path from "path";

export function extractMaturityDate(name: string): string | null {
  const dueMatch = name.match(/DUE\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (dueMatch) {
    const result = normalize(dueMatch[1], dueMatch[2], dueMatch[3]);
    if (result) return result;
  }
  const mtdMatch = name.match(/MTD\s+(\d{4})-(\d{2})-(\d{2})/i);
  if (mtdMatch) {
    const y = parseInt(mtdMatch[1], 10);
    if (y >= 2000 && y <= 2099) {
      return `${mtdMatch[1]}-${mtdMatch[2]}-${mtdMatch[3]}`;
    }
  }
  const fallback = name.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (fallback) return normalize(fallback[1], fallback[2], fallback[3]);
  return null;
}

function normalize(mm: string, dd: string, yy: string): string | null {
  const m = parseInt(mm, 10);
  const d = parseInt(dd, 10);
  let y = parseInt(yy, 10);
  if (yy.length === 2) y += 2000;
  if (y < 2000 || y > 2099) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  const db = new Database(dbPath);
  const rows = db.prepare(
    `SELECT id, symbol, name
     FROM securities
     WHERE LOWER(security_type) = 'bond'
       AND maturity_date IS NULL
       AND name IS NOT NULL`
  ).all() as Array<{ id: number; symbol: string; name: string }>;
  let updated = 0, skipped = 0;
  for (const r of rows) {
    const parsed = extractMaturityDate(r.name);
    if (parsed) {
      if (!dryRun) {
        db.prepare("UPDATE securities SET maturity_date = ? WHERE id = ?").run(parsed, r.id);
      }
      console.log(`  ${r.symbol} → ${parsed}  (from "${r.name}")${dryRun ? " [DRY-RUN]" : ""}`);
      updated++;
    } else {
      console.log(`  ${r.symbol} → SKIP (no date in "${r.name}")`);
      skipped++;
    }
  }
  console.log(`\nBackfill ${dryRun ? "preview" : "complete"}: ${updated} ${dryRun ? "would update" : "updated"}, ${skipped} skipped.`);
}

const isMain = typeof process !== "undefined" && process.argv[1] && process.argv[1].includes("backfill-bond-maturity-dates");
if (isMain) main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scripts/backfill-bond-maturity-dates.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Dry-run against live DB**

```bash
npx tsx scripts/backfill-bond-maturity-dates.ts --dry-run
```

Review output; confirm the regex catches all 16 bonds.

- [ ] **Step 6: Run for real**

```bash
npx tsx scripts/backfill-bond-maturity-dates.ts
```

Verify:

```bash
sqlite3 data/vanguard.db "SELECT symbol, name, maturity_date FROM securities WHERE LOWER(security_type)='bond' ORDER BY maturity_date;"
```

- [ ] **Step 7: Write the failing upsertSecurity integration test**

This step is **not optional**. The user imports Vanguard PDFs via Co-Work, and every monthly statement contains fresh bond rows; wiring the regex into `upsertSecurity` means new bonds get their maturity populated on import, not via a one-off script run months later.

Create `tests/mutations/upsert-security-bond-maturity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";

describe("upsertSecurity bond maturity_date extraction", () => {
  function fresh() {
    const db = new Database(":memory:");
    runMigrations(db);
    return db;
  }

  it("auto-populates maturity_date from name when bond is inserted without one", () => {
    const db = fresh();
    upsertSecurity(db, {
      symbol: "912828YZ7",
      security_type: "bond",
      name: "TREAS 4.5% DUE 11/15/29",
      // maturity_date omitted
    });
    const row = db.prepare("SELECT maturity_date FROM securities WHERE symbol=?").get("912828YZ7") as { maturity_date: string };
    expect(row.maturity_date).toBe("2029-11-15");
  });

  it("does not overwrite an explicit maturity_date passed to upsertSecurity", () => {
    const db = fresh();
    upsertSecurity(db, {
      symbol: "912828YZ7",
      security_type: "bond",
      name: "TREAS 4.5% DUE 11/15/29",
      maturity_date: "2029-12-31", // explicit — must win over the regex's 11/15
    });
    const row = db.prepare("SELECT maturity_date FROM securities WHERE symbol=?").get("912828YZ7") as { maturity_date: string };
    expect(row.maturity_date).toBe("2029-12-31");
  });
});
```

> **Two `it`s in one `describe` count as one effective integration test** in the +1 header count — combine if your project style prefers single-it tests.

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run tests/mutations/upsert-security-bond-maturity.test.ts`
Expected: FAIL — `maturity_date` is null after insert.

- [ ] **Step 9: Wire the regex into `upsertSecurity`**

In `lib/mutations/securities.ts`, inside `upsertSecurity`, before the INSERT/UPDATE, when `security_type === 'bond'` and `maturity_date` is null:

```ts
// Hoist the import to module top:
import { extractMaturityDate } from "@/scripts/backfill-bond-maturity-dates";

// Inside upsertSecurity, after parsing input but before writing:
if (
  input.security_type?.toLowerCase() === "bond" &&
  !input.maturity_date &&
  input.name
) {
  const parsed = extractMaturityDate(input.name);
  if (parsed) input.maturity_date = parsed;
}
```

> Verify the import doesn't trigger the `main()` function in `backfill-bond-maturity-dates.ts` — the `isMain` guard at the bottom of that file should prevent execution on import. If it does fire, refactor the script: split `extractMaturityDate` into its own file (e.g., `lib/securities/bond-maturity-parser.ts`) and have both the script and `upsertSecurity` import from there.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run tests/mutations/upsert-security-bond-maturity.test.ts`
Expected: PASS.

- [ ] **Step 11: Run full suite**

Run: `npx vitest run`
Expected: ~1952 pass (1913 prior + 39 new; 3 send-evening pre-existing failures unchanged).

- [ ] **Step 12: Commit**

```bash
git add scripts/backfill-bond-maturity-dates.ts tests/scripts/backfill-bond-maturity-dates.test.ts lib/mutations/securities.ts tests/mutations/upsert-security-bond-maturity.test.ts
git commit -m "feat(p4-slice-e): bond maturity_date regex extraction + upsertSecurity integration"
```

**Slice E complete.** Three P3 follow-ups closed. Bond duration script now has data.

---

## Phase ship checklist

- [ ] All 5 slices committed
- [ ] `npx vitest run` reports ~1952 / 1955 pass (3 unchanged pre-existing send-evening failures)
- [ ] `npx tsc --noEmit` reports no errors
- [ ] Live DB bond maturity rows verified populated
- [ ] Manual smoke on `/dashboard/analysis` Workspace view: macro overlay card shows last Sunday's themes (or "no actionable themes this week" if pre-gen hasn't fired yet)
- [ ] Manual smoke on `/dashboard/security/[id]`: Factor Profile section still renders unchanged from P3
- [ ] Briefing email next Sunday: confirm "Macro context this week" section appears at the top (or warns gracefully if cache empty)
- [ ] Cost dashboard at Cloudflare AI Gateway: confirm `feature=analysisMacroThemes` metric appears with ~4 calls/Sunday
- [ ] Reconcile `docs/plans/TODO.md`:
  - Mark P4 Macro Overlay closed
  - Mark 3 P3 follow-ups (narrative GET rate-limit, PositionRisk per-row W-o-W, bond maturity backfill) closed
  - Leave non-goals (FactorProfileSection block 3, buildContextForSurface multi-account) as open carries
- [ ] Reconcile `MEMORY.md` Active Topics / Project Status with "P4 shipped — Analysis Deep Dive complete"

## Sunday-after-merge validation

The first Sunday after this phase merges is the real validation gate.

- 16:00 ET → launchd `com.vanguard-skin.weekly-email.plist` fires
- 16:00 ET + ~30s → narrative pre-gen completes (16 surfaces × Sonnet calls)
- 16:00 ET + ~45s → macro-themes pre-gen completes (4 scopes × Sonnet calls)
- 16:00 ET + ~60s → briefing email composed with "Macro context this week" section
- Confirm via `~/Library/Logs/vanguard-weekly-email.log`

If pre-gen times out under the 300s primary timeout, cloud fallback kicks in but won't carry the macro section (Worker reads R2 snapshot, doesn't run Sonnet pre-gen — Mac is the only place macro themes generate). Acceptable degradation.

## Risks + mitigations

1. **Sonnet returns prose alongside JSON.** Guarded by code-fence trim + Zod parse → error path. Bare-prose preamble surfaces as `JSON.parse` failure → caller catches → cache empty + log warning, no poison.

2. **`computeFactorAnalysis` field shape drift.** Post-process casts through `as any`. If the field doesn't exist, post-process degrades to empty contributors — acceptable. Tighten typing once confirmed.

3. **Under-classified scope produces themes with empty contributors.** UI handles gracefully. Correct degradation.

4. **First Sunday post-merge times out.** Mitigated by `Promise.allSettled` — if any of the 16 narratives or 4 macro themes fail, briefing still ships.

5. **Cache from previous week shows on Tuesday.** Per brainstorm option 1: correct steady-state. Refresh-now button rate-limited 1/day/scope is the escape hatch.

6. **Cash-Deploy boost feels too aggressive.** 1.15× was chosen as meaningful-but-not-dominant. Single-line change to `BOOST_MULTIPLIER` to tune.

7. **Scenario "live now" badge color clash.** Amber pill matches the design system. If it visually competes, downgrade to a small text indicator.

---

## Reference

- Spec: [docs/superpowers/specs/2026-05-10-analysis-deep-dive-design.md](../specs/2026-05-10-analysis-deep-dive-design.md) §4
- P3 plan (template): [docs/superpowers/plans/2026-05-10-analysis-deep-dive-p3-narrative-plan.md](2026-05-10-analysis-deep-dive-p3-narrative-plan.md)
- Existing pre-gen pattern: `lib/digest/send-briefing.ts:88-112`
- Narrative cache helper pattern: `lib/queries/analysis-narratives.ts`
- Narrative generator pattern: `lib/compute/analysis-narratives.ts`
- Cash-Deploy compute: `lib/compute/cash-deploy.ts`
- Scenario recipes: `lib/compute/scenario-recipes.ts`
- Workspace component: `app/dashboard/components/analysis/WorkspacePanel.tsx`
- AI Gateway routing: `lib/ai/provider.ts` (no changes — new feature key plugs in)
