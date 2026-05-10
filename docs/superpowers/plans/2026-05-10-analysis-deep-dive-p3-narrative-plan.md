# Analysis Deep Dive — Phase 3 (Narrative) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Analysis page *read*, not just *show*. Add cached AI factor narratives to four diagnostic surfaces, build a per-security factor lens on Security Detail, ship a generic classification drill-down panel, and surface week-over-week deltas on every metric.

**Architecture:** Four vertical slices that each ship and commit independently. **Slice A** stands up the narrative caching layer + AI Gateway integration + 4 surface attachments. **Slice B** introduces a per-security regression compute + cache + new section on Security Detail. **Slice C** ships a generic `<DrillDownPanel>` and the holdings-in-bucket query that powers it from 4 trigger surfaces. **Slice D** threads optional `asOfDate` through 3 existing compute functions and adds a `<WeekOverWeekBadge>` to every diagnostic card. No new AI cost beyond ~$0.32/month.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, better-sqlite3 (in-memory for tests), Vitest, Tailwind CSS 4, AI SDK v6 with Anthropic provider via Cloudflare AI Gateway.

**Spec:** [docs/superpowers/specs/2026-05-10-analysis-deep-dive-design.md](../specs/2026-05-10-analysis-deep-dive-design.md) (Section 3 + 5.1 data model + 5.2 AI keys + 5.3 file layout)

**Migration numbers (confirmed post-P2):** P2 took 049 (`construction_caps`) and 050 (`benchmark_compositions`), so this phase uses **051** (`security_regressions`) and **052** (`analysis_narratives`). P4 will take **053** (`analysis_macro_themes`). The spec's original numbering predates the P2 swap.

**Phase ship target:** ~16h, +30 tests (1845 → 1875), all 4 narrative-layer dials shipped. New AI cost ~$0.32/month (factor narratives only — macro themes deferred to P4).

---

## File Structure (P3 only)

**Create:**
- `lib/db/migrations/051_security_regressions.sql` — per-(security, benchmark, day) cached betas
- `lib/db/migrations/052_analysis_narratives.sql` — per-(scope, surface, week) cached narrative
- `lib/compute/security-regression.ts` — `computeSecurityRegression(db, securityId, benchmarkSymbol, days?): SecurityRegression`
- `lib/compute/analysis-narratives.ts` — `generateNarrative(db, scope, surfaceKey, week): Promise<string>` + cache helpers
- `lib/queries/security-regressions.ts` — cache reads (`getCachedRegression`, `upsertRegression`)
- `lib/queries/analysis-narratives.ts` — cache reads (`getCachedNarrative`, `upsertNarrative`)
- `lib/queries/drill-down.ts` — `getHoldingsInBucket(db, scope, dimension, bucketLabel, accountIds?)`
- `lib/queries/weekly-snapshots.ts` — date helpers (`mondayOf(date)`, `weekAgo(date)`) + asOfDate plumbing helpers
- `app/api/analysis/narrative/route.ts` — `GET ?scope=&surface=&week=` (cache lookup) + `POST` (force regen, rate-limited 1/day/scope)
- `app/api/security/[id]/regression/route.ts` — `GET ?benchmark=SPY` (cache-then-compute fallback)
- `app/api/analysis/drill-down/route.ts` — `GET ?scope=&dimension=&bucket=`
- `app/dashboard/components/analysis/NarrativeBlock.tsx` — italic + gold-left-edge prose container
- `app/dashboard/components/analysis/DrillDownPanel.tsx` — slide-in panel (480px desktop, full-screen mobile)
- `app/dashboard/components/analysis/WeekOverWeekBadge.tsx` — tiny pill with arrow + signed magnitude
- `app/dashboard/security/[id]/FactorProfileSection.tsx` — qualitative + quantitative + portfolio-share contribution
- `scripts/backfill-security-regressions.ts` — one-time historical compute for ~60 securities × current set of benchmarks
- `tests/compute/security-regression.test.ts`
- `tests/compute/analysis-narratives.test.ts`
- `tests/queries/drill-down.test.ts`
- `tests/queries/weekly-snapshots.test.ts`
- `tests/api/analysis-narrative.test.ts` — rate-limit + cache-hit + 404 for unknown surface
- `tests/api/analysis-drill-down.test.ts`

**Modify:**
- `lib/ai/feature-keys.ts:13-36` — add `"analysisFactorNarrative"` to the union
- `lib/ai/models.ts:26+` — add `analysisFactorNarrative: "anthropic/${SONNET_MODEL}"` to `FEATURE_MODELS`
- `lib/digest/send-briefing.ts` — slot pre-generation hook **after** `syncCalendarForWeek` (line 77 area), before email composition: iterate `(scope × surface)` and call `generateNarrative` (fire-and-forget; failure should NOT block the briefing email)
- `lib/compute/factors.ts::computeFactorAnalysis` — add optional `asOfDate?: string` param threaded into the holdings CTE via `latestHoldingsPredicate({ asOfDate })` extension (Slice D)
- `lib/compute/risk.ts::computeRiskMetrics` — same param plumbing
- (factor tilts are inside the private `computeTilts` helper in `factors.ts:~152`, called only from `computeFactorAnalysis` — no separate modification needed)
- `lib/queries/latest-holdings.ts:36-65` — extend `LatestHoldingsOptions` with optional `asOfDate?: string`; when set, the inner subquery becomes `WHERE … AND h2.as_of_date <= ?` AND outer `WHERE … AND h.as_of_date <= ?` (caller binds the date twice — same pattern options-greeks already uses for cutoff)
- `app/dashboard/components/FactorAnalysis.tsx` — render `<NarrativeBlock surfaceKey="factor-analysis" />` above the chart; render `<WeekOverWeekBadge>` next to each headline metric
- `app/dashboard/components/RiskMetrics.tsx` — same: `<NarrativeBlock surfaceKey="risk-metrics" />` + per-metric badges
- `app/dashboard/components/PositionRisk.tsx` — same: `<NarrativeBlock surfaceKey="position-risk" />` + per-row badges
- `app/dashboard/components/FactorAnalysis.tsx` (heatmap section, around line where chips render) — add `onClick` to each cell that opens `<DrillDownPanel kind="factor" filter={{ factor, bucket }} />`
- `app/dashboard/components/ClassificationCard.tsx` (P2 file) — wire pie slice clicks to `<DrillDownPanel kind="classification" filter={{ dimension, bucket }} />`
- `app/dashboard/components/PositionRisk.tsx` — wire row click to `<DrillDownPanel kind="risk" filter={{ symbol }} />`
- `app/dashboard/components/AnalysisView.tsx` (sector tilt section) — wire bucket click to `<DrillDownPanel kind="sector" filter={{ sector }} />`
- `app/dashboard/security/[id]/page.tsx:203-205` — slot `<FactorProfileSection securityId={id} />` between the `<MarketDataPanel>` block and the `Notes & Theses` block (line 607)
- `lib/compute/daily-valuations.ts` (cron extension) — append a per-security regression backfill loop at the end so newly-imported securities get cached betas without needing the script

**Tests target:** +30 tests
- security-regression: 6 (basic regression math, R² edge cases, missing-bench-data fallback, cache hit, cache miss, scope filter)
- analysis-narratives: 5 (cache lookup hit, cache miss → generate, schema validation, rate-limit enforcement, model-failure fallback)
- drill-down: 6 (one per kind: classification / factor / sector / risk + scope filter + filter-chip predicate)
- weekly-snapshots: 4 (mondayOf edge cases incl. Sunday boundary, weekAgo, ISO date round-trip, leap-year)
- analysis-narrative API: 4 (cache hit JSON shape, force-regen rate-limit, unknown surface 404, scope param missing 400)
- analysis-drill-down API: 3 (basic shape, scope filter, empty bucket)
- WeekOverWeekBadge integration smoke: 2 (renders neutral + signed variants without console errors)

---

## Conventions (read once, apply throughout)

- **In-memory SQLite test pattern:** `new Database(":memory:")` + `runMigrations(db)` + per-test seed helpers. Canonical example: `tests/compute/exposure-delta.test.ts`.
- **All DB query functions take a `db: Database.Database` parameter** (dependency injection). Never import the `db` singleton inside `lib/compute/` or `lib/queries/`.
- **Latest-holdings CTE:** ALWAYS use `latestHoldingsPredicate()` from `lib/queries/latest-holdings.ts`. P2 follow-up retired 8 inline copies; do not regress.
- **Case-insensitive security_type comparisons.** Always `LOWER(s.security_type)` in SQL, `.toLowerCase()` in TS. PostToolUse hook in `.claude/settings.json` rejects new case-sensitive comparisons.
- **AI calls go through `getModelForFeature("<key>")`** from `lib/ai/provider.ts`. Never `new Anthropic()` at call sites. Two documented exceptions exist (`vanguard-pdf`, `send-earnings-email`) — do not add a third.
- **Scope resolution:** use `resolveScope(db, scope)` from `lib/queries/accounts.ts`. Returns `number[] | undefined` (undefined = all accounts).
- **Privacy-aware formatters:** dollar/percent/share user-facing values use `<Money>` / `<Pct>` / `<Shares>` from `@/lib/privacy/components`. Public market data (bench returns, prices) uses bare `formatUSD` / `formatPercent` from `lib/format.ts`. Narrative prose itself is treated as public — it never contains specific dollar amounts because the prompt forbids it.
- **Dashboard pages export `const dynamic = "force-dynamic"`** — applies to any new `app/dashboard/**/page.tsx`. Required so `next build` doesn't open `data/vanguard.db` during static collection.
- **Commit cadence:** one commit per slice (4 commits). Plus one final doc-reconciliation commit at end (TODO.md + MEMORY.md). Use `git commit -F /tmp/<msg-file>.txt` to avoid HEREDOC apostrophe pitfalls.

---

## Slice A — Factor narratives (~6h, +9 tests)

Spec §3.1. Adds Sonnet-generated 1-2-paragraph narratives to 4 diagnostic surfaces (Quant Factor Analysis · Risk Metrics · Position Risk · Factor Heatmap). Cached per `(scope, surface, week_of)` so cost is view-count-independent. Pre-generated in the Sunday briefing pipeline; on-demand fallback for first-visit-of-week.

### Task A1: Migration 052 — `analysis_narratives` table

**Files:**
- Create: `lib/db/migrations/052_analysis_narratives.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Caches Sonnet-generated narrative prose for diagnostic surfaces. One row
-- per (scope, surface_key, week_of). Generated by the Sunday briefing
-- pipeline; on-demand fallback for first visit in a new week.
--
-- surface_key examples:
--   'factor-analysis'   — Quant Factor Analysis card
--   'risk-metrics'      — Risk Metrics card
--   'position-risk'     — Position Risk card
--   'factor-heatmap'    — Factor Heatmap card
--
-- week_of is the Monday of the ISO week as YYYY-MM-DD.

CREATE TABLE IF NOT EXISTS analysis_narratives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  surface_key TEXT NOT NULL,
  week_of TEXT NOT NULL,
  narrative_md TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model_used TEXT NOT NULL,
  UNIQUE (scope, surface_key, week_of)
);

CREATE INDEX IF NOT EXISTS idx_analysis_narratives_scope_week
  ON analysis_narratives(scope, week_of);
```

- [ ] **Step 2: Apply via dev server boot OR explicit `runMigrations(db)` in tests**

The runner picks up new files automatically via `lib/db/migrate.ts` filename ordering. No registration needed.

- [ ] **Step 3: Commit**

```bash
git add lib/db/migrations/052_analysis_narratives.sql
git commit -F /tmp/p3-a1-msg.txt  # message: "feat(analysis-p3): add analysis_narratives cache table"
```

### Task A2: Date helpers + AI feature key

**Files:**
- Create: `lib/queries/weekly-snapshots.ts`
- Create: `tests/queries/weekly-snapshots.test.ts`
- Modify: `lib/ai/feature-keys.ts:13-36`
- Modify: `lib/ai/models.ts:26+`

- [ ] **Step 1: Write the failing date-helper tests**

```typescript
// tests/queries/weekly-snapshots.test.ts
import { describe, it, expect } from "vitest";
import { mondayOf, weekAgo } from "@/lib/queries/weekly-snapshots";

describe("mondayOf", () => {
  it("returns same date when input is already a Monday", () => {
    expect(mondayOf("2026-05-04")).toBe("2026-05-04"); // Mon
  });
  it("rolls forward from Sunday to next Monday's prior Monday", () => {
    expect(mondayOf("2026-05-10")).toBe("2026-05-04"); // Sun → prior Mon
  });
  it("rolls back from Wednesday to Monday", () => {
    expect(mondayOf("2026-05-06")).toBe("2026-05-04"); // Wed
  });
  it("handles year boundaries", () => {
    expect(mondayOf("2026-01-01")).toBe("2025-12-29"); // Thu → prior Mon in prev year
  });
});

describe("weekAgo", () => {
  it("subtracts exactly 7 days", () => {
    expect(weekAgo("2026-05-10")).toBe("2026-05-03");
  });
  it("crosses month boundary correctly", () => {
    expect(weekAgo("2026-05-03")).toBe("2026-04-26");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/weekly-snapshots.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the helpers**

```typescript
// lib/queries/weekly-snapshots.ts
/**
 * ISO-week Monday for a given YYYY-MM-DD date.
 * Returns YYYY-MM-DD. Sunday rolls back to the prior Monday.
 */
export function mondayOf(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00Z"); // noon UTC avoids DST edge cases
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offset = day === 0 ? -6 : 1 - day; // Sun → -6, Mon → 0, Tue → -1, ...
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the YYYY-MM-DD date exactly 7 days before the input.
 */
export function weekAgo(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/queries/weekly-snapshots.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the AI feature key**

In `lib/ai/feature-keys.ts:13-36`, append `"analysisFactorNarrative"` to the union.

In `lib/ai/models.ts`, find the `FEATURE_MODELS` const around line 26 and add (alphabetical order or logical grouping per existing convention):

```typescript
analysisFactorNarrative: `anthropic/${SONNET_MODEL}`,
```

- [ ] **Step 6: Verify type compilation**

Run: `npx tsc --noEmit lib/ai/models.ts lib/ai/feature-keys.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/queries/weekly-snapshots.ts tests/queries/weekly-snapshots.test.ts lib/ai/feature-keys.ts lib/ai/models.ts
git commit -F /tmp/p3-a2-msg.txt  # "feat(analysis-p3): weekly date helpers + analysisFactorNarrative model key"
```

### Task A3: Narrative cache reads + writes

**Files:**
- Create: `lib/queries/analysis-narratives.ts`

- [ ] **Step 1: Write the failing cache test**

```typescript
// tests/compute/analysis-narratives.test.ts (initial scaffold)
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCachedNarrative,
  upsertNarrative,
} from "@/lib/queries/analysis-narratives";

describe("analysis-narratives cache", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("returns null for cache miss", () => {
    expect(
      getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04")
    ).toBeNull();
  });

  it("upsert + read returns the same row", () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Tech tilt is doing the lifting…",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04");
    expect(r?.narrativeMd).toMatch(/Tech tilt/);
  });

  it("upsert is idempotent — second write replaces first", () => {
    upsertNarrative(db, { scope: "vanguard", surfaceKey: "factor-analysis", weekOf: "2026-05-04", narrativeMd: "v1", modelUsed: "anthropic/claude-sonnet-4-6" });
    upsertNarrative(db, { scope: "vanguard", surfaceKey: "factor-analysis", weekOf: "2026-05-04", narrativeMd: "v2", modelUsed: "anthropic/claude-sonnet-4-6" });
    const r = getCachedNarrative(db, "vanguard", "factor-analysis", "2026-05-04");
    expect(r?.narrativeMd).toBe("v2");
    const count = db.prepare("SELECT COUNT(*) AS n FROM analysis_narratives").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compute/analysis-narratives.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the cache module**

```typescript
// lib/queries/analysis-narratives.ts
import type Database from "better-sqlite3";

export interface NarrativeRecord {
  scope: string;
  surfaceKey: string;
  weekOf: string;
  narrativeMd: string;
  modelUsed: string;
  generatedAt?: string;
}

export interface NarrativeRow extends NarrativeRecord {
  id: number;
  generatedAt: string;
}

export function getCachedNarrative(
  db: Database.Database,
  scope: string,
  surfaceKey: string,
  weekOf: string
): NarrativeRow | null {
  const row = db
    .prepare(
      `SELECT id, scope, surface_key AS surfaceKey, week_of AS weekOf,
              narrative_md AS narrativeMd, generated_at AS generatedAt,
              model_used AS modelUsed
         FROM analysis_narratives
        WHERE scope = ? AND surface_key = ? AND week_of = ?`
    )
    .get(scope, surfaceKey, weekOf) as NarrativeRow | undefined;
  return row ?? null;
}

export function upsertNarrative(db: Database.Database, rec: NarrativeRecord): void {
  db.prepare(
    `INSERT INTO analysis_narratives (scope, surface_key, week_of, narrative_md, generated_at, model_used)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(scope, surface_key, week_of) DO UPDATE SET
       narrative_md = excluded.narrative_md,
       generated_at = excluded.generated_at,
       model_used = excluded.model_used`
  ).run(rec.scope, rec.surfaceKey, rec.weekOf, rec.narrativeMd, rec.modelUsed);
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit (defer to A4 — combine with the generate function)**

### Task A4: `generateNarrative` + AI call

**Files:**
- Create: `lib/compute/analysis-narratives.ts`

- [ ] **Step 1: Write the failing generate test (uses a stubbed AI client)**

```typescript
// tests/compute/analysis-narratives.test.ts (extend)
import { vi } from "vitest";
import { generateNarrative } from "@/lib/compute/analysis-narratives";

// vi.mock("@/lib/ai/provider", () => ({
//   getModelForFeature: vi.fn().mockReturnValue({
//     // Stub: returns a deterministic narrative regardless of prompt
//     generateText: vi.fn().mockResolvedValue({
//       text: "AI-generated narrative for testing.",
//     }),
//   }),
// }));

describe("generateNarrative", () => {
  it("returns the cached narrative when present (no AI call)", async () => {
    upsertNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
      narrativeMd: "Cached prose",
      modelUsed: "anthropic/claude-sonnet-4-6",
    });
    const r = await generateNarrative(db, {
      scope: "vanguard",
      surfaceKey: "factor-analysis",
      weekOf: "2026-05-04",
    });
    expect(r.narrativeMd).toBe("Cached prose");
    expect(r.fromCache).toBe(true);
  });

  it("rejects unknown surfaceKey at the boundary", async () => {
    await expect(
      generateNarrative(db, { scope: "vanguard", surfaceKey: "bogus", weekOf: "2026-05-04" })
    ).rejects.toThrow(/unknown surface/i);
  });

  // Force-regen / cache-miss test deferred — covered by API integration test in A6.
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL with module-not-found / unknown export.

- [ ] **Step 3: Implement `generateNarrative`**

```typescript
// lib/compute/analysis-narratives.ts
import type Database from "better-sqlite3";
import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
import {
  getCachedNarrative,
  upsertNarrative,
} from "@/lib/queries/analysis-narratives";
import { resolveFeatureModel } from "@/lib/ai/models";

export const NARRATIVE_SURFACES = [
  "factor-analysis",
  "risk-metrics",
  "position-risk",
  "factor-heatmap",
] as const;
export type NarrativeSurface = (typeof NARRATIVE_SURFACES)[number];

export interface GenerateOptions {
  scope: string;
  surfaceKey: string;
  weekOf: string; // YYYY-MM-DD Monday
  forceRegen?: boolean;
}

export interface NarrativeResult {
  narrativeMd: string;
  fromCache: boolean;
  generatedAt: string;
}

const SURFACE_PROMPTS: Record<NarrativeSurface, string> = {
  "factor-analysis":
    "Summarize the user's portfolio factor exposure in 2-3 sentences. Highlight the dominant tilts (Growth vs Value, AI exposure, Rate sensitivity, Cyclicality, etc) and what they imply about the user's effective bet on the market regime. Avoid specific dollar amounts. Use plain English, no jargon.",
  "risk-metrics":
    "Summarize the portfolio's risk metrics in 2-3 sentences: drawdown profile, volatility, Sharpe, Herfindahl concentration. Note whether risk is concentrated in a few names or diversified. Avoid specific dollar amounts.",
  "position-risk":
    "In 2-3 sentences, identify which positions are driving the portfolio's risk. Mention the top 2-3 risk contributors by name and what makes them risky (size, beta, factor exposure). Avoid specific dollar amounts.",
  "factor-heatmap":
    "Read the heatmap of factor exposures across positions. In 2-3 sentences, call out the most concentrated factor bucket and any surprising holes (e.g., zero crypto exposure, no defensive plays). Avoid specific dollar amounts.",
};

export async function generateNarrative(
  db: Database.Database,
  opts: GenerateOptions
): Promise<NarrativeResult> {
  const { scope, surfaceKey, weekOf, forceRegen = false } = opts;
  if (!NARRATIVE_SURFACES.includes(surfaceKey as NarrativeSurface)) {
    throw new Error(`unknown surface: ${surfaceKey}`);
  }

  if (!forceRegen) {
    const cached = getCachedNarrative(db, scope, surfaceKey, weekOf);
    if (cached) {
      return {
        narrativeMd: cached.narrativeMd,
        fromCache: true,
        generatedAt: cached.generatedAt,
      };
    }
  }

  // Build context from current scope-aware data. KEEP THIS NARROW — too much
  // context degrades narrative quality. The Sonnet system prompt anchors the
  // user-input format.
  const context = await buildContextForSurface(db, scope, surfaceKey as NarrativeSurface);
  const model = getModelForFeature("analysisFactorNarrative");
  const { text } = await generateText({
    model,
    system:
      "You are a portfolio analyst writing concise narrative prose. Output 2-3 sentences of plain English. Never include specific dollar amounts. Focus on what the data MEANS, not what it shows.",
    prompt: `${SURFACE_PROMPTS[surfaceKey as NarrativeSurface]}\n\n## Data\n${context}`,
  });

  // Note: ResolvedModel.modelId (NOT .id) — see lib/ai/models.ts:102-105.
  upsertNarrative(db, {
    scope,
    surfaceKey,
    weekOf,
    narrativeMd: text.trim(),
    modelUsed: resolveFeatureModel("analysisFactorNarrative").modelId,
  });

  return {
    narrativeMd: text.trim(),
    fromCache: false,
    generatedAt: new Date().toISOString(),
  };
}

// Small per-surface context builders. Each returns a JSON or markdown blob
// the model can read. KEEP CONCISE.
async function buildContextForSurface(
  db: Database.Database,
  scope: string,
  surface: NarrativeSurface
): Promise<string> {
  // Implementation per surface. Reuse existing compute functions:
  //   factor-analysis  → computeFactorAnalysis(db, accountIds)
  //   risk-metrics     → computeRiskMetrics(db, accountIds)
  //   position-risk    → computePositionRisk(db, accountIds, topN: 5)
  //   factor-heatmap   → getFactorHeatmap(db, accountIds)
  // Serialize the results into terse JSON. ~500-800 tokens of context max.
  // This function is the main extension point if narratives feel generic later.
  // ...
  return JSON.stringify({ /* surface-specific context */ });
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS — cache-hit + unknown-surface tests pass without invoking the AI client (mocked or real).

- [ ] **Step 5: Commit (combined A3 + A4)**

```bash
git add lib/queries/analysis-narratives.ts lib/compute/analysis-narratives.ts tests/compute/analysis-narratives.test.ts
git commit -F /tmp/p3-a3-msg.txt  # "feat(analysis-p3): narrative cache + generate via Sonnet 4.6"
```

### Task A5: `<NarrativeBlock>` component

**Files:**
- Create: `app/dashboard/components/analysis/NarrativeBlock.tsx`

- [ ] **Step 1: Implement the component**

```tsx
"use client";

import { useEffect, useState } from "react";

interface Props {
  scope: string;
  surfaceKey: "factor-analysis" | "risk-metrics" | "position-risk" | "factor-heatmap";
}

export function NarrativeBlock({ scope, surfaceKey }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/analysis/narrative?scope=${scope}&surface=${surfaceKey}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data.success) setText(data.narrativeMd);
        else setError(data.error ?? "Failed to load narrative");
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [scope, surfaceKey]);

  if (loading) return <div className="text-xs text-ink-faint italic mt-2">Loading narrative…</div>;
  if (error || !text) return null; // graceful no-render on error

  return (
    <div className="text-sm text-ink-dim italic border-l-2 border-gold/40 pl-3 my-3 leading-relaxed">
      {text}
    </div>
  );
}
```

- [ ] **Step 2: Skip tests for this thin client component** — it's a pure fetch + render. Coverage comes from the API test in A6.

### Task A6: API route `/api/analysis/narrative`

**Files:**
- Create: `app/api/analysis/narrative/route.ts`
- Create: `tests/api/analysis-narrative.test.ts`

- [ ] **Step 1: Write the failing API contract test**

```typescript
// tests/api/analysis-narrative.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "@/app/api/analysis/narrative/route";

// Mock the compute module so we don't actually hit the AI Gateway in tests.
vi.mock("@/lib/compute/analysis-narratives", () => ({
  generateNarrative: vi.fn().mockResolvedValue({
    narrativeMd: "Mocked narrative prose.",
    fromCache: false,
    generatedAt: "2026-05-10T22:00:00Z",
  }),
  NARRATIVE_SURFACES: ["factor-analysis", "risk-metrics", "position-risk", "factor-heatmap"],
}));

describe("GET /api/analysis/narrative", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with narrative shape on cache miss", async () => {
    const req = new Request("http://x/api/analysis/narrative?scope=vanguard&surface=factor-analysis");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.narrativeMd).toBe("Mocked narrative prose.");
  });

  it("returns 400 when scope is missing", async () => {
    const req = new Request("http://x/api/analysis/narrative?surface=factor-analysis");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when surface is unknown", async () => {
    const req = new Request("http://x/api/analysis/narrative?scope=vanguard&surface=bogus");
    const res = await GET(req);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/analysis/narrative (force regen)", () => {
  it("rate-limits to 1 regen per (scope, surface) per day", async () => {
    // First call OK, second call within 24h → 429.
    const req = () =>
      new Request("http://x/api/analysis/narrative", {
        method: "POST",
        body: JSON.stringify({ scope: "vanguard", surface: "factor-analysis" }),
        headers: { "Content-Type": "application/json" },
      });
    const r1 = await POST(req());
    expect(r1.status).toBe(200);
    const r2 = await POST(req());
    expect(r2.status).toBe(429);
  });
});
```

- [ ] **Step 2: Implement the route**

```typescript
// app/api/analysis/narrative/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateNarrative,
  NARRATIVE_SURFACES,
} from "@/lib/compute/analysis-narratives";
import { mondayOf } from "@/lib/queries/weekly-snapshots";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const surface = url.searchParams.get("surface");
  if (!scope) return NextResponse.json({ success: false, error: "scope required" }, { status: 400 });
  if (!surface || !NARRATIVE_SURFACES.includes(surface as never)) {
    return NextResponse.json({ success: false, error: "unknown surface" }, { status: 404 });
  }
  const week = mondayOf(new Date().toISOString().slice(0, 10));
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

// In-memory rate limit. Reset per server boot — fine for v1; promote to settings
// row if multi-instance becomes a concern.
const lastRegenAt = new Map<string, number>();
const REGEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { scope, surface } = body ?? {};
  if (!scope || !surface) return NextResponse.json({ success: false, error: "scope+surface required" }, { status: 400 });
  const key = `${scope}::${surface}`;
  const now = Date.now();
  const last = lastRegenAt.get(key) ?? 0;
  if (now - last < REGEN_WINDOW_MS) {
    return NextResponse.json(
      { success: false, error: "rate-limited", retryAfter: REGEN_WINDOW_MS - (now - last) },
      { status: 429 }
    );
  }
  lastRegenAt.set(key, now);
  const week = mondayOf(new Date().toISOString().slice(0, 10));
  const r = await generateNarrative(db, { scope, surfaceKey: surface, weekOf: week, forceRegen: true });
  return NextResponse.json({ success: true, ...r });
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `npx vitest run tests/api/analysis-narrative.test.ts`
Expected: PASS, 4 tests.

### Task A7: Wire Sunday briefing pre-generation hook

**Files:**
- Modify: `lib/digest/send-briefing.ts:77` (after `syncCalendarForWeek` call)

- [ ] **Step 1: Read the existing structure to confirm attachment point**

```bash
sed -n '70,90p' lib/digest/send-briefing.ts
```

- [ ] **Step 2: Add the pre-generation block**

```typescript
// After syncCalendarForWeek, before email composition. Generates narratives
// for all 4 surfaces × 4 scopes (= 16 calls) in parallel. Fire-and-forget —
// failures must NOT block the briefing. Cost ~$0.32/month at this cadence.
import { generateNarrative, NARRATIVE_SURFACES } from "@/lib/compute/analysis-narratives";
import { mondayOf } from "@/lib/queries/weekly-snapshots";

const SCOPES = ["all", "vanguard", "ibkr", "roth"] as const;
const week = mondayOf(new Date().toISOString().slice(0, 10));
await Promise.allSettled(
  SCOPES.flatMap((scope) =>
    NARRATIVE_SURFACES.map((surface) =>
      generateNarrative(db, { scope, surfaceKey: surface, weekOf: week })
        .catch((e) => console.error(`narrative gen failed for ${scope}/${surface}:`, e))
    )
  )
);
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit lib/digest/send-briefing.ts`
Expected: clean.

- [ ] **Step 4: Manual verification** — trigger briefing locally if user wants pre-merge confirmation:

```bash
curl -sS -X POST -H "X-Cron-Secret: $CRON_SHARED_SECRET" \
  http://localhost:3000/api/cron/briefing | jq
```

After it returns, query the cache:
```bash
sqlite3 data/vanguard.db "SELECT scope, surface_key, length(narrative_md) FROM analysis_narratives;"
```
Expected: 16 rows.

### Task A8: Attach `<NarrativeBlock>` to 4 surfaces

**Files:**
- Modify: `app/dashboard/components/FactorAnalysis.tsx` — add `<NarrativeBlock surfaceKey="factor-analysis" scope={scope ?? "all"} />` near the top of the card body, above the chart
- Modify: `app/dashboard/components/RiskMetrics.tsx` — same with `surfaceKey="risk-metrics"`
- Modify: `app/dashboard/components/PositionRisk.tsx` — same with `surfaceKey="position-risk"`
- Modify: `app/dashboard/components/FactorAnalysis.tsx` (or wherever `FactorHeatmap` renders) — `surfaceKey="factor-heatmap"`

- [ ] **Step 1: Find each card's top-of-body insertion point** and add the `<NarrativeBlock>` line.

- [ ] **Step 2: Manual visual smoke test** at `:3000/dashboard/analysis?mode=factors` and `?mode=classification`. Each surface should show a loading shimmer briefly, then narrative prose with a gold left border.

- [ ] **Step 3: Run full test suite, verify nothing broke**

Run: `npx vitest run`
Expected: 1854 / 1857 (was 1845 / 1848 + 9 new = 1854 / 1857). 3 unchanged pre-existing failures.

- [ ] **Step 4: Commit Slice A**

```bash
git add lib/digest/send-briefing.ts \
        app/dashboard/components/analysis/NarrativeBlock.tsx \
        app/api/analysis/narrative/route.ts \
        tests/api/analysis-narrative.test.ts \
        app/dashboard/components/FactorAnalysis.tsx \
        app/dashboard/components/RiskMetrics.tsx \
        app/dashboard/components/PositionRisk.tsx
git commit -F /tmp/p3-slice-a-msg.txt  # "feat(analysis-p3): factor narratives — Sonnet, 4 surfaces, Sunday-briefing pre-gen"
```

---

## Slice B — Per-security factor lens (~4h, +6 tests)

Spec §3.2. New section on Security Detail page that combines qualitative classification (existing `security_factors`) + per-security beta vs portfolio (new `computeSecurityRegression`) + portfolio-share contribution math.

### Task B1: Migration 051 — `security_regressions` cache table

**Files:**
- Create: `lib/db/migrations/051_security_regressions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Cached per-security regression coefficients vs a benchmark. Populated by
-- computeDailyValuations cron extension (~60 ops/day). Read by
-- FactorProfileSection on Security Detail.

CREATE TABLE IF NOT EXISTS security_regressions (
  security_id INTEGER NOT NULL,
  benchmark_symbol TEXT NOT NULL,
  computed_at_day TEXT NOT NULL,
  beta REAL,
  vol REAL,
  correlation REAL,
  r_squared REAL,
  data_points INTEGER,
  PRIMARY KEY (security_id, benchmark_symbol, computed_at_day),
  FOREIGN KEY (security_id) REFERENCES securities(id)
);

CREATE INDEX IF NOT EXISTS idx_security_regressions_lookup
  ON security_regressions(security_id, benchmark_symbol, computed_at_day DESC);
```

### Task B2: `computeSecurityRegression` engine

**Files:**
- Create: `lib/compute/security-regression.ts`
- Create: `tests/compute/security-regression.test.ts`

- [ ] **Step 1: Write the failing test** (use `lib/compute/risk.ts::computeMarketRegression` as the model — it already does the OLS math for the portfolio-level case)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeSecurityRegression } from "@/lib/compute/security-regression";

describe("computeSecurityRegression", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    // Seed: one security (id=1) with 30 days of prices, one benchmark with 30
    // days of prices that covary in a known way (e.g., security = 1.5x bench
    // returns). Beta should compute to ~1.5, R² high.
    // ...
  });

  it("computes beta close to known seeded ratio", () => {
    const r = computeSecurityRegression(db, 1, "SPY", 30);
    expect(r.beta).toBeCloseTo(1.5, 1);
    expect(r.dataPoints).toBeGreaterThanOrEqual(25);
  });

  it("returns null beta when fewer than 10 overlapping points", () => {
    // Seed only 5 days of overlap
    const r = computeSecurityRegression(db, 1, "SPY", 30);
    expect(r.beta).toBeNull();
  });

  // ...4 more cases: vol math, correlation, R², missing benchmark
});
```

- [ ] **Step 2: Implement** mirroring `lib/compute/risk.ts::computeMarketRegression` shape but for a single security against a benchmark price series. Pull benchmark from `benchmark_prices`, security from `prices`.

- [ ] **Step 3: Add cache reads**

```typescript
// lib/queries/security-regressions.ts
export function getCachedRegression(db, securityId, benchmark): SecurityRegression | null { ... }
export function upsertRegression(db, ...): void { ... }
```

- [ ] **Step 4: Run tests, verify pass.**

### Task B3: Backfill script + cron extension

**Files:**
- Create: `scripts/backfill-security-regressions.ts`
- Modify: `lib/compute/daily-valuations.ts` — append regression backfill loop

- [ ] **Step 1: Write a one-time backfill script** that iterates current set of held securities × benchmarks (default `["SPY", "QQQ", "VTI"]`) and writes to `security_regressions`.

- [ ] **Step 2: Wire the same logic into the daily-valuations cron** so newly-imported securities get cached without re-running the script.

- [ ] **Step 3: Run script against demo DB, confirm rows land**

```bash
npx tsx scripts/backfill-security-regressions.ts
sqlite3 data/vanguard.db "SELECT COUNT(*) FROM security_regressions;"
```

### Task B4: `<FactorProfileSection>` UI

**Files:**
- Create: `app/dashboard/security/[id]/FactorProfileSection.tsx`
- Modify: `app/dashboard/security/[id]/page.tsx:203-205` — slot the new section between MarketDataPanel and Notes

- [ ] **Step 1: Implement the section** using existing `<TerminalSection>` + `<TerminalTH>` / `<TerminalTD>` primitives. Three sub-blocks:
  1. Qualitative profile — read `security_factors` row, render 9 factor chips with `<TerminalTag>` color-coded by `LEVEL_COLORS`.
  2. Quantitative regression — fetch `/api/security/[id]/regression?benchmark=SPY` (cache-first), display β / vol / R² / corr.
  3. Portfolio share contribution — for each factor: `position_factor_value × position_value ÷ Σ scope factor exposure`. New compute helper or inline math.

- [ ] **Step 2: Slot into the page**

```tsx
// page.tsx around line 203
<MarketDataPanel ... />

<FactorProfileSection securityId={id} />

{/* existing Notes block at 607 */}
```

- [ ] **Step 3: Manual smoke test** at `/dashboard/security/<some-id>` — section renders between hero and Notes, no console errors.

- [ ] **Step 4: Run tests, commit Slice B**

```bash
git add lib/db/migrations/051_security_regressions.sql \
        lib/compute/security-regression.ts \
        lib/queries/security-regressions.ts \
        tests/compute/security-regression.test.ts \
        scripts/backfill-security-regressions.ts \
        lib/compute/daily-valuations.ts \
        app/dashboard/security/\[id\]/FactorProfileSection.tsx \
        app/dashboard/security/\[id\]/page.tsx \
        app/api/security/\[id\]/regression/route.ts
git commit -F /tmp/p3-slice-b-msg.txt
```

---

## Slice C — Classification drill-down (~3h, +9 tests)

Spec §3.3. Generic `<DrillDownPanel>` opens a slide-in panel listing every holding in a given bucket. Powered by one new query helper. Wired to 4 trigger surfaces.

### Task C1: `getHoldingsInBucket` query

**Files:**
- Create: `lib/queries/drill-down.ts`
- Create: `tests/queries/drill-down.test.ts`

- [ ] **Step 1: Write the failing tests — one per `kind`**

```typescript
describe("getHoldingsInBucket", () => {
  it("classification: filters by dimension+bucket", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "classification", dimension: "sector", bucket: "Technology" });
    expect(rows.every((r) => r.sector === "Technology")).toBe(true);
  });

  it("factor: filters by factor+bucket", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "factor", factor: "ai_exposure", bucket: "High" });
    expect(rows.every((r) => r.factors.ai_exposure === "High")).toBe(true);
  });

  it("sector: bare sector filter (alias for classification with dimension=sector)", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "sector", sector: "Healthcare" });
    expect(rows.every((r) => r.sector === "Healthcare")).toBe(true);
  });

  it("risk: top-N by risk contribution", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 5 });
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("respects scope", () => { /* filter to vanguard accounts only */ });
  it("returns empty array for unknown bucket", () => { /* no crash */ });
});
```

- [ ] **Step 2: Implement** using `latestHoldingsPredicate({ keyBy: "account_security", accountFilter })` + LEFT JOINs to `security_factors` + `security_regressions` for the cached betas.

- [ ] **Step 3: Run tests, verify pass.**

### Task C2: API route + `<DrillDownPanel>` component

**Files:**
- Create: `app/api/analysis/drill-down/route.ts`
- Create: `app/dashboard/components/analysis/DrillDownPanel.tsx`
- Create: `tests/api/analysis-drill-down.test.ts`

- [ ] **Step 1: Write API contract tests**, then implement.

- [ ] **Step 2: Implement the panel** — slide-in from right at desktop (480px), full-screen on mobile. Sortable table (use existing `<SortableHeader>` + `useSortParam`). Filter chips ("AI=High", "β>1") at the top.

```tsx
"use client";

import { useState, useEffect } from "react";

interface Filter {
  kind: "classification" | "factor" | "sector" | "risk";
  // discriminated by kind
}

interface Props {
  open: boolean;
  onClose: () => void;
  scope: string;
  filter: Filter;
}

export function DrillDownPanel({ open, onClose, scope, filter }: Props) {
  // ... fetch + render
}
```

### Task C3: Wire 4 trigger surfaces

**Files:**
- Modify: `app/dashboard/components/analysis/ClassificationCard.tsx` — pie slice click
- Modify: `app/dashboard/components/FactorAnalysis.tsx` — heatmap chip click
- Modify: `app/dashboard/components/AnalysisView.tsx` — sector tilt bucket click
- Modify: `app/dashboard/components/PositionRisk.tsx` — risk-row click

- [ ] **Step 1: Add `useState<Filter | null>` + `<DrillDownPanel>` mount** to each parent, wire onClick handlers.

- [ ] **Step 2: Manual smoke test** — click each trigger, panel slides in, holdings list renders, sortable, filter chips work.

- [ ] **Step 3: Commit Slice C**

```bash
git add lib/queries/drill-down.ts tests/queries/drill-down.test.ts \
        app/api/analysis/drill-down/route.ts tests/api/analysis-drill-down.test.ts \
        app/dashboard/components/analysis/DrillDownPanel.tsx \
        app/dashboard/components/analysis/ClassificationCard.tsx \
        app/dashboard/components/FactorAnalysis.tsx \
        app/dashboard/components/AnalysisView.tsx \
        app/dashboard/components/PositionRisk.tsx
git commit -F /tmp/p3-slice-c-msg.txt
```

---

## Slice D — Week-over-week deltas (~3h, +6 tests)

Spec §3.4. Compute-on-read v1 (no new snapshot table). Existing compute fns gain optional `asOfDate`; API routes call them twice (now + 7d ago); zip results into a `{ now, weekAgo, delta }` shape; `<WeekOverWeekBadge>` renders the delta.

### Task D1: Extend `latestHoldingsPredicate` with optional `asOfDate`

**Files:**
- Modify: `lib/queries/latest-holdings.ts:36-65`

- [ ] **Step 1: Collapse `cutoff` into `asOfDate`** — recommended approach per plan-review

`cutoff: true` already implies a bound date at position-1 of the outer query. Cleanest extension is to redefine the option as `asOfDate?: string`. When set, the helper emits `AND h2.as_of_date <= '<literal-date>'` in the subquery AND `AND h.as_of_date <= '<literal-date>'` in the outer predicate (literal substitution, NOT positional `?`). This eliminates the dual-param footgun (`cutoff: true` required the caller to bind ONE param; `asOfDate` would naively require TWO if both used `?`).

Migration plan for the existing `cutoff: true` caller (options-greeks.ts):
1. Add `asOfDate` option to `LatestHoldingsOptions`.
2. Update options-greeks.ts to pass `asOfDate` directly instead of binding a separate cutoff param.
3. Remove the `cutoff` option once options-greeks is migrated. Single-call-site rename — should land in same commit as the helper extension.

Date is literal-substituted (escaped to a SQL date string) — safe because the only callers pass `weekAgo(today)` or a known statement date, never user input.

- [ ] **Step 2: Add tests in `tests/queries/latest-holdings.test.ts`** — `asOfDate` produces both subquery and outer constraints.

### Task D2: Thread `asOfDate` through 3 compute fns

**Files:**
- Modify: `lib/compute/factors.ts::computeFactorAnalysis` — accept `asOfDate?: string`, plumb to `latestHoldingsPredicate({ asOfDate })`. The factor-tilts math is in a private `computeTilts` helper inside the same file (`factors.ts:~152`); just thread `asOfDate` through `computeFactorAnalysis` so the inner helper inherits it via the call chain. Don't export `computeTilts` for the param.
- Modify: `lib/compute/risk.ts::computeRiskMetrics` — same single-param add

- [ ] **Step 1: Add the param to each function signature** (default undefined = current behavior).

- [ ] **Step 2: Verify existing tests still pass** without changes (default behavior unchanged).

- [ ] **Step 3: Add 1 test per fn** that asserts results differ when called with different `asOfDate` values against a seeded multi-snapshot DB.

### Task D3: API route extension — return `{ now, weekAgo, delta }` shape

**Files:**
- Modify: `app/api/compute/factors/route.ts`
- Modify: `app/api/compute/risk/route.ts`
- Modify: `app/api/compute/position-risk/route.ts` (or whichever route hosts `computeFactorTilts`)

- [ ] **Step 1: Each route calls the underlying compute fn TWICE** — once with default, once with `asOfDate = weekAgo(today)`.

- [ ] **Step 2: Compute the delta** for every numeric metric. Wrap in:

```typescript
{
  success: true,
  data: { ...currentMetrics },
  weekAgo: { ...lastWeekMetrics } | null, // null if no holdings 7d ago (new portfolio)
  delta: { metric: "beta", value: 0.04 } // per-metric delta map
}
```

- [ ] **Step 3: Test with a multi-snapshot demo DB** that has holdings on both today and 7d ago.

### Task D4: `<WeekOverWeekBadge>` component + integrations

**Files:**
- Create: `app/dashboard/components/analysis/WeekOverWeekBadge.tsx`
- Modify: each diagnostic card to render the badge next to its metrics

- [ ] **Step 1: Implement the badge**

```tsx
interface Props {
  value: number | null;
  kind?: "neutral" | "signed"; // default neutral (gray); signed = green/red
  digits?: number;
}

export function WeekOverWeekBadge({ value, kind = "neutral", digits = 2 }: Props) {
  if (value === null || value === 0) return <span className="text-[9px] text-ink-faint">—</span>;
  const arrow = value > 0 ? "↑" : "↓";
  const color = kind === "signed"
    ? (value > 0 ? "text-up" : "text-down")
    : "text-ink-faint";
  return (
    <span className={`text-[10px] ${color} ml-1.5`} title="vs 7 days ago">
      {arrow} {Math.abs(value).toFixed(digits)} / 7d
    </span>
  );
}
```

- [ ] **Step 2: Slot into each metric** on FactorAnalysis, RiskMetrics, PositionRisk.

- [ ] **Step 3: Manual smoke test** — every metric on every diagnostic card has a tiny pill next to it. New portfolio (no 7d-ago data) shows `—` instead of crashing.

- [ ] **Step 4: Run full suite + commit Slice D**

```bash
git add lib/queries/latest-holdings.ts tests/queries/latest-holdings.test.ts \
        lib/compute/factors.ts lib/compute/risk.ts \
        app/api/compute/factors/route.ts app/api/compute/risk/route.ts \
        app/dashboard/components/analysis/WeekOverWeekBadge.tsx \
        app/dashboard/components/FactorAnalysis.tsx \
        app/dashboard/components/RiskMetrics.tsx \
        app/dashboard/components/PositionRisk.tsx
git commit -F /tmp/p3-slice-d-msg.txt
```

---

## Doc reconciliation (final commit)

**Files:**
- Modify: `docs/plans/TODO.md` — strike P3 entry, surface P3 follow-ups (e.g. "When narrative quality drifts, lengthen context blob in `buildContextForSurface`"), bump status line to 1875/1878
- Modify: `~/.claude/projects/-Users-Yitzi-code-vanguard-skin/memory/MEMORY.md` — same reconciliation

- [ ] **Commit doc updates**

```bash
git add docs/plans/TODO.md
git commit -F /tmp/p3-docs-msg.txt  # "chore(claude): reconcile TODO.md after P3 Narrative ship"
```

---

## Pre-merge gates

- [ ] **Slice ordering is mandatory.** Slices C and D both modify `FactorAnalysis.tsx` and `PositionRisk.tsx`. Land C (drill-down click handlers) BEFORE starting D (W-o-W badges) so the staged file changes don't tangle. If working in a worktree, this falls out naturally; if working on `main`, just respect the slice order in the plan.
- [ ] **All 4 slice commits + 1 doc commit pushed to `main`** (this phase merges via fast-forward following P1/P2 precedent)
- [ ] **Test count: 1872 / 1875** target (was 1842 / 1845 post-P2-helper-extract + 30 new = 1872 / 1875). 3 unchanged pre-existing send-evening failures. Run `npx vitest run --reporter=basic | tail -5` to verify the baseline before declaring the math wrong.
- [ ] **`npx tsc --noEmit` clean** for all touched files (1 pre-existing cron-evening.test.ts error unchanged)
- [ ] **Manual smoke at `/dashboard/analysis`** at each scope: narrative blocks render on FactorAnalysis + RiskMetrics + PositionRisk + FactorHeatmap; click any classification pie slice / heatmap chip → DrillDownPanel slides in; every metric has a `↑/↓ /7d` badge or `—`
- [ ] **Manual smoke at `/dashboard/security/<id>`**: FactorProfileSection renders between MarketDataPanel and Notes; β + R² + portfolio-share-contribution numbers populate (or graceful empty state if benchmark series missing)
- [ ] **Sunday briefing dry-run** populates 16 narrative cache rows: trigger `/api/cron/briefing` once, then `SELECT COUNT(*) FROM analysis_narratives WHERE week_of = mondayOf(today);` → 16

---

## Risks + mitigations

1. **Generic narrative output.** Sonnet may produce indistinguishable prose across surfaces if context is thin. Mitigation: `buildContextForSurface` is the explicit extension point — if quality drifts, beef up the per-surface context blob. Easy iteration without schema or API changes.
2. **Sunday briefing latency.** 16 narratives × ~2s each = ~32s if sequential. `Promise.allSettled` keeps it parallel; rate-limit at the AI Gateway side prevents flooding. Watch the briefing-pipeline timing the first Sunday after ship.
3. **`asOfDate` regressing existing reads.** Adding the optional param to 3 compute functions means every existing test must keep passing without changes. Default `undefined` = current behavior — verify by running full suite after just the param addition (D1+D2), before wiring the second compute call (D3).
4. **DrillDownPanel state collisions.** Multiple parents could mount their own panel. Decision: each parent owns its own `useState<Filter|null>`. URL params not used in v1 (per spec §6 open question). Revisit if shareable drill-down links become a request.
5. **Cache staleness across week boundaries.** A user who opens the page at 11:55pm Sunday might see stale prior-week narrative; refresh at 12:01am Monday won't have new cache yet. On-demand fallback (Task A4 — cache miss triggers generate) handles this correctly. Test it Sunday night before merge.

---

## Open questions (defer to implementation OR escalate)

- **Should narratives also surface in chat tool calls?** Could let the chat agent quote the cached narrative when the user asks "what's my AI exposure looking like?" Not a P3 blocker; revisit post-ship.
- **Per-security factor lens benchmarks.** Default SPY for v1; spec hints at user override. No UI in scope. Add a `<select>` to FactorProfileSection in P3 if cheap, otherwise defer.
- **Drill-down panel URL persistence.** Spec §6 open question — defer to v2.
- **Construction caps editor.** Spec §6 open question — still deferred (P4 polish, post-ship).
