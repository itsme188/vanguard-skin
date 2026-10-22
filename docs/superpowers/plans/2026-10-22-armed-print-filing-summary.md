# Armed-Print Filing Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every armed earnings print, find the company's earnings 8-K (or 6-K) and that evening's companion filings, have the per-print chosen model family summarise them as typed, cited claims, and show each claim with app-located footnotes (document, page, paragraph, sec.gov link) and an app-computed figure-check status.

**Architecture:** A new Mac-only subsystem `lib/filing-summary/` with its own tables (migration 099), its own SEC discovery (stricter than print-watch's, sharing print-watch's host throttle), a 60-second durable tick (poll + run), a pure text extractor / quote locator / figure checker, and one new AI seam that calls an explicit model id at an explicit effort. Display is a panel in the live print row, a full in-app page, and an on-demand standalone HTML download.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, better-sqlite3, AI SDK v6 (`ai` 6.0.138, `@ai-sdk/anthropic` 3.0.64 — supports `providerOptions.anthropic.effort` and `thinking: {type:"adaptive"}`), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-armed-print-filing-summary-design.md` (read §How it works, §Hardening requirements, §Figure checking and §Codex round 2 R1–R18 before any task; rule numbers below refer to it).

## Global Constraints

- Never inline a model id. Ids come from the live catalog via the new family resolver; tests use ids built from catalog fixtures.
- No new npm dependency. HTML is read with the existing tokenizer in `lib/print-watch/representations.ts` (export it; do not change its behaviour).
- Every `generateObject*` call passes explicit `maxOutputTokens` (32000 here). Schemas describe shape only; counts (Top 3, 12 bullets max) are enforced in code. Every schema object node has `additionalProperties: false`; every property is listed in `required` (use `nullable` instead of optional).
- Choice storage is `{family, effort}`; families `sonnet | opus | fable`; efforts `medium | high`; the five picker choices exactly: Sonnet·medium, Opus·medium, Opus·high (default), Fable·medium, Fable·high. Labels use a middle dot: `Opus · high`.
- Companion cutoff: 20:00 America/New_York on the event date, decided on the filing header's `<ACCEPTANCE-DATETIME>` only (R11). Poll window 06:00–20:00 ET on the event date (R12).
- Companion allow list: `PRE 14A, DEF 14A, PRE 14C, DEF 14C, 8-K, 8-K/A, 10-Q, 10-K, S-3, S-3ASR, S-8, 424B*, SC TO-I`; for 6-K filers also `6-K, F-3`. Always ignored: `3, 4, 5, 144` and anything not on the list.
- Skipped document kinds: `GRAPHIC`, `ZIP`, `EX-101.*`, `XML`, `JSON`, and file names ending `.jpg .jpeg .png .gif .xsd .xml .json .zip`. Per-document cap 16 MB (skip with reason). Per-call input cap 1,600,000 characters of extracted text (≈400k tokens); documents beyond it are skipped with reason "over the input cap".
- "In line" band: |difference| ≤ 0.5% of |comparator|, inclusive (R7). Rounding: match when |source − stated| ≤ half a unit in the stated figure's last digit (R4).
- Attempts: at most 2 per section; refusal and output truncation are never retried; SDK retries off (`maxRetries: 0`) so they count inside the budget.
- Dates/times: Eastern via `todayET()` and the EDGAR Eastern parser; never a UTC day slice; SQL timestamp comparisons use `datetime()` on both sides.
- Privacy (R15): prompts, the shareable page, pushes and logs carry only filing text, bogey figures, public-safe provenance labels and dates. No portfolio fields, no bogey `notes` / `guidance_notes` / free-text definitions. Filing and bogey content renders plain (market data, not portfolio data); it is still escaped everywhere.
- UI rules: no caret dropdown affordance (native `<select>`), questions through `useConfirmPrompt`, mutations read through `readMutationResult` / `networkFailureMessage`, chip colours from `CHIP_TONE_CLASSES` / `Chip`, phone width with no sideways scroll, `<dialog>` `m-auto`, small text ≥ 4.5:1 contrast in both themes.
- New routes are human routes by default (`lib/auth/route-policy.ts` default) — confirm no allowlist entry is needed; mutating routes go through the existing CSRF check (the `apiFetch` client already sends it).
- Migration 099 is additive; it is SHOWN to the owner (paste in the task report) and rehearsed on a VACUUM copy of the live DB before deploy (Task 15).
- Test command prefix: `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH`. Tests use `:memory:` SQLite with the migrated schema. Real filings used for replay live in gitignored `tests/fixtures/real/filing-summary/`; committed fixtures are synthetic (no 7+ digit real-looking portfolio numbers; public company figures in synthetic shapes are fine).
- Commits: message in a temp file, `git commit -F`; pathspec commits only (parallel workers share the worktree; never `git stash`, never `git add -A`).

## Review Focus

1. **A filing whose header lacks `<ACCEPTANCE-DATETIME>`** — expected: listed as "time unconfirmed", never run automatically, never shown as "no filing". Test in Task 6.
2. **The app asleep across 20:00** (laptop lid shut 15:50–21:30) — expected: the first tick after wake does one catch-up poll and still reads a filing accepted at 16:05; one accepted at 20:01 is ignored. Test in Task 9.
3. **Two quotes that both match** (the same sentence in the press release and the 8-K cover) — expected: footnote "ambiguous quote", never a silently chosen location. Test in Task 4.
4. **Re-run clicked twice quickly / request retried by the browser** — expected: one paid run (request key). Test in Task 12.
5. **An event date correction while a section is running** — expected: the claim is cleared, the section is retaken under the target event, no duplicate run numbers. Test in Task 9.

---

## Shared types (written by Task 1, read by everyone)

`lib/filing-summary/types.ts` — exact content decisions (implementer adds doc comments):

```ts
export type SummaryFamily = "sonnet" | "opus" | "fable";
export type SummaryEffort = "medium" | "high";
export interface SummaryChoice { family: SummaryFamily; effort: SummaryEffort }

// ---- extracted document text (Task 3) ----
export interface TextBlock { index: number; page: number; para: number; text: string; tableId: number | null; rowIndex: number | null }
export interface TableGrid {
  id: number; page: number;
  rows: string[][];            // body rows, colspan spread across covered columns (R3)
  columnHeaders: string[];     // per column: all header-row texts above it joined with " / "
  rowLabels: string[];         // first non-empty cell per body row
  scaleNote: string | null;    // nearest "in millions…" statement in/just above the table
}
export interface DocText {
  extractorVersion: number; pageCount: number; pageBreaksReliable: boolean;
  blocks: TextBlock[]; tables: TableGrid[]; documentScaleNote: string | null;
}

// ---- model output (Task 7 schema) ----
export type FigureUnit = "usd" | "usd_per_share" | "percent" | "shares" | "count" | "people" | "other";
export type FigureScale = "units" | "thousands" | "millions" | "billions";
export type PeriodKind = "quarter" | "year_to_date" | "fiscal_year" | "instant";
export type PeriodAnchor = "reported_quarter" | "next_quarter" | "fiscal_year" | null;
export interface PeriodSpec {
  kind: PeriodKind; role: "actual" | "outlook";
  endDate: string | null; fiscalYear: number | null; fiscalQuarter: number | null;
  anchor: PeriodAnchor;        // set only on bogey figures (R6)
  label: string;
}
export type Basis = "reported" | "non_gaap" | "constant_currency" | "excluding_item"
  | "guidance_low" | "guidance_high" | "guidance_mid" | "unknown";
export type FigureSourceKind = "quote" | "bogey" | "computed";
export type ComputeOp = "difference" | "sum" | "ratio" | "growth";
export interface ModelFigure {
  id: string; valueText: string; value: number; unit: FigureUnit; scale: FigureScale;
  metric: string; period: PeriodSpec; basis: Basis; basisNote: string | null;
  sourceKind: FigureSourceKind;
  citationId: string | null; label: string | null;        // quote
  bogeyKey: string | null;                                  // bogey
  operation: ComputeOp | null; inputs: string[];           // computed (ordered)
}
export interface ModelCitation { id: string; document: string; quote: string; isTableRow: boolean }
export type Relation = "above" | "below" | "in_line" | "raised" | "lowered" | "narrowed" | "unchanged";
export interface ModelComparison { left: string; leftHigh: string | null; right: string; rightHigh: string | null; relation: Relation }
export interface ModelClaim {
  id: string; text: string;               // template with {f1}… placeholders (R1)
  citations: ModelCitation[]; figures: ModelFigure[]; comparisons: ModelComparison[];
  corrects: { claimId: string; citationId: string } | null;   // 8-K/A only (R17)
}
export interface ModelBullet { top: boolean; routine: boolean; claims: ModelClaim[] }
export interface ModelSectionOutput { headline: string; bullets: ModelBullet[] }

// ---- bogey snapshot (Task 7) ----
export interface BogeySnapshotFigure {
  key: string;                 // `b<rowId>.<field>` or `b<rowId>.x.<extraId>`
  label: string; value: number; unit: FigureUnit; scale: "units";
  period: PeriodSpec; basis: Basis;
  provenance: string;          // public-safe (R15)
  asOf: string;                // YYYY-MM-DD Eastern
  rowKind: "manual" | "upload" | "deep_read" | "newsletter" | "vendor";
}

// ---- checks (Tasks 4, 5, 8) ----
export type ClaimStatus = "contradicted" | "figure_not_bound" | "periods_differ" | "not_in_filing"
  | "quote_not_found" | "ambiguous_quote" | "unconfirmed" | "checked" | "qualitative";
export interface CheckReason { code: string; figureId: string | null; detail: string }
export interface Footnote {
  citationId: string; document: string; status: "found" | "not_found" | "ambiguous";
  page: number | null; para: number | null; sentence: string | null; url: string | null;
}
export interface FigureCheck { figureId: string; established: boolean; foundValue: number | null; reasons: CheckReason[] }
export interface ComparisonCheck {
  relation: Relation; verdict: "matches" | "contradicted" | "periods_differ" | "unconfirmed";
  difference: number | null; differencePct: number | null; shownText: string | null; reasons: CheckReason[];
}
export interface CheckedClaim {
  claimId: string; renderedText: string; status: ClaimStatus; top: boolean; routine: boolean;
  footnotes: Footnote[]; figureChecks: FigureCheck[]; comparisonChecks: ComparisonCheck[];
  reasons: CheckReason[]; correction: { claimId: string; resolved: boolean; footnote: Footnote | null } | null;
}
export interface StatusCounts { claims: number; checked: number; contradicted: number; warning: number; unconfirmed: number; qualitative: number }
export interface CheckedSection { headline: string; claims: CheckedClaim[]; counts: StatusCounts }
export interface CoverageEntry { fileName: string; docType: string; status: "read" | "skipped" | "failed"; reason: string | null }

export const STATUS_SEVERITY: Record<ClaimStatus, "danger" | "warning" | "muted" | "ok"> = {
  contradicted: "danger", figure_not_bound: "warning", periods_differ: "warning", not_in_filing: "warning",
  quote_not_found: "warning", ambiguous_quote: "warning", unconfirmed: "muted", checked: "ok", qualitative: "ok",
};
```

## Waves (for parallel SDD)

- **Wave 1 (parallel):** Task 1 (migration+store), Task 2 (AI seam), Task 3 (text extractor), Task 4 (quote locator) — Task 4 consumes Task 3's `DocText` type only (from `types.ts`, which Task 1 writes first; the controller writes `types.ts` before dispatching Wave 1).
- **Wave 2 (parallel):** Task 5 (number/period/relation rules), Task 6 (EDGAR discovery), Task 7 (schema, prompt, bogey snapshot).
- **Wave 3:** Task 8 (claim evaluation) → Task 9 (poller, lifecycle, merge) ∥ Task 10 (runner) → Task 11 (push).
- **Wave 4 (parallel):** Task 12 (routes + share page), then Task 13 (panel + arm choice) ∥ Task 14 (full page).
- **Wave 5:** Task 15 (replay, docs, migration rehearsal, browser pass).

---

### Task 1: Types, migration 099, store

**Files:**
- Create: `lib/filing-summary/types.ts` (content above), `lib/db/migrations/099_filing_summary.sql`, `lib/filing-summary/store.ts`
- Test: `tests/filing-summary/store.test.ts`

**Interfaces — Produces** (`store.ts`, all take `db` first, all synchronous):
- `getEventState(db, eventId): EventStateRow | null`; `upsertEventState(db, eventId, patch: Partial<EventStateRow>): void`
- `getChoice(db, eventId): { choice: SummaryChoice; isDefault: boolean; locked: boolean }` (default from `DEFAULT_SUMMARY_CHOICE` in `lib/filing-summary/choice.ts`, Task 2)
- `setChoice(db, eventId, choice): { ok: true } | { ok: false; reason: "locked" }`
- `insertFiling(db, f: NewFiling): { id: number; inserted: boolean }` (INSERT OR IGNORE on `(event_id, accession)`; `discovery_seq` = max+1 per event)
- `listFilings(db, eventId): FilingRow[]` ordered by `discovery_seq`
- `upsertDocument(db, d: NewDocument): number`; `listDocuments(db, filingId): DocumentRow[]` ordered by `sequence`
- `createRun(db, r: { eventId; trigger; choice; modelId; fallbackNote; requestKey: string | null; bogeySnapshotJson; filingIds: number[] }): { runId: number; created: boolean }` — in one transaction: `run_no` = max+1 per event, one pending section per filing id in the given order (`seq` 1..n), sets `locked_at` on the event row; an existing `request_key` returns that run with `created: false`.
- `appendSection(db, runId, filingId): number | null` (null when the run already has that filing)
- `claimNextSection(db, eventId, token, nowMs, staleMs = 5*60_000): SectionRow | null` — CAS: the lowest `(run_id, seq)` section of the event with status `pending`, or `running` with `heartbeat_at` older than `staleMs` (takeover increments nothing; it records `error_class='takeover'` only if it then fails); refuses when another section of the same event is `running` and fresh; increments `attempts`.
- `heartbeatSection(db, sectionId, token, nowMs): boolean`
- `finalizeSection(db, sectionId, token, result: SectionResult): boolean` — `UPDATE … WHERE id=? AND claim_token=?`; false = lost the claim, write nothing. Recomputes the run status in the same transaction: all sections done → run `done`; any section failed and none pending/running → run `failed`.
- `requeueSection(db, sectionId, token, errorClass, errorText): boolean` (back to `pending`)
- `listRuns(db, eventId): RunRow[]`, `listSections(db, runId): SectionRow[]`, `listEventsWithPendingSections(db): number[]`
- Push rows: `beginPush(db, key, eventId, title, message): boolean` (INSERT, false if exists), `markPush(db, key, state)`, `markSendingAsUnknown(db): number` (startup sweep, R16).

Migration 099 (exact columns; implementer adds the header comment block in the style of 091):

```sql
CREATE TABLE filing_summary_events (
  event_id INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  family TEXT CHECK (family IS NULL OR family IN ('sonnet','opus','fable')),
  effort TEXT CHECK (effort IS NULL OR effort IN ('medium','high')),
  poll_state TEXT NOT NULL DEFAULT 'waiting' CHECK (poll_state IN
    ('waiting','found','past_cutoff','sec_unreachable','cancelled','no_cik','manual_only','ambiguous')),
  poll_detail TEXT,
  cik TEXT,
  last_polled_at TEXT,
  catchup_done INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE filing_summary_filings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  accession TEXT NOT NULL,
  cik TEXT NOT NULL,
  form TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('earnings','companion')),
  items TEXT,
  accepted_at TEXT,
  discovered_at TEXT NOT NULL,
  discovery_seq INTEGER NOT NULL,
  identity_verdict TEXT NOT NULL CHECK (identity_verdict IN ('accepted','ambiguous','rejected','time_unconfirmed')),
  identity_reason TEXT,
  fetch_state TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_state IN ('pending','fetched','failed')),
  UNIQUE (event_id, accession)
);
CREATE TABLE filing_summary_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filing_id INTEGER NOT NULL REFERENCES filing_summary_filings(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetched','skipped','failed')),
  skip_reason TEXT,
  sha256 TEXT, byte_len INTEGER, stored_path TEXT,
  UNIQUE (filing_id, file_name)
);
CREATE TABLE filing_summary_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  run_no INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','rerun','manual_run')),
  family TEXT NOT NULL CHECK (family IN ('sonnet','opus','fable')),
  effort TEXT NOT NULL CHECK (effort IN ('medium','high')),
  model_id TEXT,
  fallback_note TEXT,
  request_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  bogey_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE (event_id, run_no)
);
CREATE TABLE filing_summary_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES filing_summary_runs(id) ON DELETE CASCADE,
  filing_id INTEGER NOT NULL REFERENCES filing_summary_filings(id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT, claimed_at TEXT, heartbeat_at TEXT,
  model_id TEXT, effort TEXT,
  input_fingerprint TEXT,
  output_json TEXT, checked_json TEXT, coverage_json TEXT,
  incomplete INTEGER NOT NULL DEFAULT 0,
  counts_json TEXT, usage_json TEXT, versions_json TEXT,
  error_class TEXT CHECK (error_class IS NULL OR error_class IN
    ('model_error','timeout','refusal','truncated','invalid_output','model_unavailable','input_too_large','attempt_cap','takeover','cancelled')),
  error_text TEXT,
  finished_at TEXT,
  UNIQUE (run_id, filing_id),
  UNIQUE (run_id, seq)
);
CREATE INDEX idx_fs_sections_status ON filing_summary_sections(status, run_id, seq);
CREATE INDEX idx_fs_runs_event ON filing_summary_runs(event_id, run_no);
CREATE TABLE filing_summary_pushes (
  push_key TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','delivery_unknown','failed')),
  title TEXT NOT NULL, message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 1: Write failing tests** in `tests/filing-summary/store.test.ts` against the migrated in-memory schema (seed one `calendar_events` earnings row):
  - `createRun` twice with the same `requestKey` → second returns `{created:false}` and the same `runId`; `run_no` is 1 then 2 for distinct keys; sections get `seq` 1..n in the given filing order; `getChoice(...).locked === true` afterwards and `setChoice` returns `{ok:false, reason:"locked"}`.
  - `claimNextSection` with a fresh running section on the same event returns null; with `heartbeat_at` 6 minutes old it returns that section (takeover) and `attempts` becomes 2.
  - `finalizeSection` with a stale token returns false and leaves `checked_json` NULL.
  - Run status: two sections, one done one failed → run `failed`; both done → `done`.
  - `insertFiling` same accession twice → `inserted:false`; `discovery_seq` increments per event.
  - `beginPush` same key twice → second false; `markSendingAsUnknown` turns `sending` into `delivery_unknown`.
- [ ] **Step 2:** Run `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx vitest run tests/filing-summary/store.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Write `types.ts`, the migration, and `store.ts`.
- [ ] **Step 4:** Rerun — PASS. Also run `npx vitest run tests/db` — PASS (migration runner tests see 099).
- [ ] **Step 5:** Commit `feat(filing-summary): tables, store and shared types`. Paste the migration SQL into the task report (owner sees it before it is applied).

### Task 2: Model families and the explicit-model AI seam

**Files:**
- Create: `lib/ai/model-families.ts`, `lib/filing-summary/choice.ts`
- Modify: `lib/ai/feature-keys.ts` (add `"printFilingSummary"`), `lib/ai/models.ts` (`printFilingSummary: "anthropic/$frontier"`, comment: the per-print choice resolves the model; this entry is only the Settings fallback), `lib/ai/provider.ts` (add `getModelForId`), `lib/ai/generate.ts` (add `generateObjectWithModel`), `lib/ai/model-tiers.ts` (export `compareVersions`), plus any `Record<FeatureKey, …>` the type-check flags (e.g. a Settings label map)
- Test: `tests/ai/model-families.test.ts`, `tests/ai/generate-with-model.test.ts`

**Interfaces — Produces:**
- `lib/filing-summary/choice.ts`: `DEFAULT_SUMMARY_CHOICE: SummaryChoice = {family:"opus", effort:"high"}`; `SUMMARY_CHOICES: SummaryChoice[]` (the five, in picker order); `isSummaryChoice(x: unknown): x is SummaryChoice` (must be one of the five); `choiceLabel(c): string` → `"Opus · high"`.
- `lib/ai/model-families.ts`: `SUMMARY_FAMILY_LADDER = ["fable","opus","sonnet"] as const`; `resolveFamilyModel(family: SummaryFamily, catalogIds: string[], excluded?: Set<string>): { modelId: string; family: SummaryFamily; fellBackFrom: SummaryFamily | null } | null` — newest id of the chosen family; else walk DOWN the ladder from it (never up); null when nothing callable. `familyNowLabel(family, catalogIds): string` → `"Fable · now 5.1"` (or `"Fable · not available"`). `modelLabel(modelId): string` → `"Opus 5.5"`.
- `lib/ai/provider.ts`: `getModelForId(feature: FeatureKey, modelId: string): LanguageModel` — Anthropic only (throws for a non-`claude-` id), same gateway/headers as `getModelForFeature`.
- `lib/ai/generate.ts`: `generateObjectWithModel(feature: FeatureKey, target: { modelId: string; effort: SummaryEffort; family: SummaryFamily }, opts: GenObjOpts & { maxOutputTokens: number }): Promise<{ object: unknown; usage: unknown; finishReason: string }>`. Sends `providerOptions.anthropic = { structuredOutputMode: "outputFormat", effort, ...(family === "fable" ? {} : { thinking: { type: "adaptive" } }) }`, `maxRetries: 0`. No failover: a model-unavailable error throws `AIModelUnavailableError(feature, modelId)`; finish reason `content-filter` throws the existing `AIRefusalError`; finish reason `length` throws new `AITruncatedError(feature, modelId)`. Export both new error classes.

- [ ] **Step 1: Failing tests.** `model-families.test.ts`: catalog `["claude-opus-5-5","claude-opus-5","claude-sonnet-5-5","claude-fable-5-1","claude-haiku-4-5-20251001"]` → fable→`claude-fable-5-1`, `fellBackFrom:null`; add `"claude-fable-5-5"` → fable→`claude-fable-5-5` (auto-follows); without any fable id → fable resolves to `claude-opus-5-5` with `fellBackFrom:"fable"`; sonnet with no sonnet id → null (never up to opus); `familyNowLabel("fable", cat)` = `"Fable · now 5.1"`; `isSummaryChoice({family:"sonnet",effort:"high"})` false. `generate-with-model.test.ts`: mock `ai`'s `generateObject` (vi.mock) and assert the call carries the exact model from `getModelForId`, `maxRetries: 0`, `providerOptions.anthropic.effort === "high"`, `thinking` present for opus and absent for fable; finishReason `"length"` → rejects `AITruncatedError`; a 404 `APICallError` → rejects `AIModelUnavailableError` and `generateObject` was called once.
- [ ] **Step 2:** Run both test files — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both + `npx vitest run tests/ai` + `npx tsc --noEmit -p .` — PASS.
- [ ] **Step 5:** Commit `feat(ai): family resolver and explicit-model, explicit-effort structured call`.

### Task 3: Document text extractor (pages, paragraphs, table grids)

**Files:**
- Create: `lib/filing-summary/doc-text.ts`
- Modify: `lib/print-watch/representations.ts` (export `tokenize` and its `Token` type; no behaviour change)
- Test: `tests/filing-summary/doc-text.test.ts`, synthetic fixture `tests/fixtures/filing-summary/synthetic-8k.htm`

**Interfaces — Produces:** `EXTRACTOR_VERSION = 1`; `extractDocText(html: string): DocText`; `blockText(doc: DocText): string` (the text sent to the model: blocks joined by `\n`, table rows as ` | `-joined cells prefixed `[table N row R]`).

Rules: a page break is an element whose style contains `page-break-before:always` / `break-before:page` (break before it) or `page-break-after:always` / `break-after:page` (break after it), or an `<hr>` whose next text-bearing block starts a new page; `pageBreaksReliable` = at least one break found; with none, everything is page 1. A block is a text-bearing `p | div | li | h1-6 | tr` with no block descendant carrying text (innermost wins). `para` counts text-bearing blocks from 1 within each page; a table row is one block. Tables: header rows = leading rows with no numeric cell; colspan text spread to every covered column (R3 — differs from repA's first-column-only, on purpose); `columnHeaders[c]` = the non-empty header texts in column c joined top-down with `" / "`; `scaleNote` = the first match of `/\b(in|amounts in)\s+(thousands|millions|billions)\b[^)\n]*/i` inside the table's header rows or in the two text blocks immediately above; `documentScaleNote` = first such match anywhere in the document. Strip `<ix:header>` blocks (inline XBRL) before tokenising.

- [ ] **Step 1: Failing tests** on the synthetic fixture (write it: a cover page, a page break, a paragraph, a results table with header rows "Three Months Ended September 30," / "2026 | 2025" and "Nine Months Ended …", an "(In millions, except per share amounts)" line above it, a colspan header, and a second page break): pageCount 3; the paragraph after the first break is `page:2, para:1`; the table's `columnHeaders` for the 2026 quarter column equals `"Three Months Ended September 30, / 2026"`; `scaleNote` matches `in millions, except per share amounts`; a document with no breaks has `pageBreaksReliable:false` and all `page:1`; inline-XBRL hidden header text does not appear in any block.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run + `npx vitest run tests/print-watch/representations.test.ts` — PASS (golden test unchanged). **Step 5:** Commit `feat(filing-summary): page/paragraph/table text extractor`.

### Task 4: Quote locator and sec.gov links

**Files:** Create `lib/filing-summary/locate.ts`; Test `tests/filing-summary/locate.test.ts`

**Interfaces — Consumes:** `DocText` (types.ts). **Produces:**
- `normalizeForMatch(s: string): string` — NFKC, curly quotes → straight, en/em dash and minus → `-`, all whitespace runs → one space, lowercase, trim.
- `locateQuote(docs: Array<{ fileName: string; text: DocText }>, citation: ModelCitation): { status: "found" | "not_found" | "ambiguous"; fileName: string | null; block: TextBlock | null; sentence: string | null }` — search the cited document first; exactly one block containing the normalised quote → found; more than one match (within the cited document, or zero there and several across other documents) → ambiguous; a quote spanning two adjacent blocks counts as a match on the first. A table-row quote matches a row when every ` | `-separated part of the quote appears in that row's cells in order.
- `secArchiveUrl(cik: string, accession: string, fileName: string): string` — validates `cik` `/^\d{1,10}$/`, accession `/^\d{10}-\d{2}-\d{6}$/`, file name `/^[A-Za-z0-9._-]+$/`; throws on anything else (R15).
- `textFragmentUrl(baseUrl: string, sentence: string): string` — `#:~:text=` with the first ≤ 8 words and last ≤ 4 words as `start,end` when the sentence is longer than 12 words, each part `encodeURIComponent`-encoded with `-` and `,` also percent-encoded.
- `toFootnote(cik, accession, citation, located): Footnote` — page omitted (`null`) when the document's `pageBreaksReliable` is false.

- [ ] **Step 1: Failing tests:** curly-quote and em-dash variants find the block; whitespace differences find it; a sentence present in two blocks → `ambiguous`; absent → `not_found`; table-row quote `"Revenue | 64,601 | 51,242"` locates the row; `secArchiveUrl` rejects `../x` and an accession without dashes; `textFragmentUrl` output contains `%2C` for a comma in the sentence.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit `feat(filing-summary): quote locator and sec.gov footnote links`.

### Task 5: Numbers, periods and relations (pure rules)

**Files:** Create `lib/filing-summary/figures.ts`; Test `tests/filing-summary/figures.test.ts`

**Interfaces — Produces:**
- `parseNumberToken(raw: string): { value: number; decimals: number } | null` — commas, `$`, `%`, parentheses → negative, a leading `−`/`-` → negative; `—`, `–`, `-` alone, `n/a`, `nm`, empty → null (R4).
- `toUnits(value: number, scale: FigureScale): number`.
- `scaleFromNote(note: string | null, unit: FigureUnit): FigureScale | null` — "in millions, except per share" gives `millions` for usd/shares/count and `units` for `usd_per_share` and `percent`; no note → null.
- `matchesWithRounding(stated: { value: number; decimals: number; scale: FigureScale }, sourceUnits: number): boolean` — half-unit rule in the stated scale (R4).
- `parsePeriodHeader(text: string): Omit<PeriodSpec, "anchor" | "label"> | null` — "Three Months Ended September 30, 2026" → `{kind:"quarter", role:"actual", endDate:"2026-09-30", fiscalYear:null, fiscalQuarter:null}`; "Nine Months Ended" → `year_to_date`; "Year Ended" / "Twelve Months Ended" → `fiscal_year`; "As of" / "At" a date → `instant`; a bare year column under a duration header is combined by the caller (Task 8) by passing the joined header string.
- `parsePeriodPhrase(sentence: string, eventDate: string): Omit<PeriodSpec,"anchor"|"label"> | null` — "third quarter 2026", "Q3 2026", "nine months ended…", "full year 2026" / "fiscal 2026"; a quarter word without a year → null (R5).
- `samePeriod(a, b): boolean | null` — R5 equality; null = cannot tell.
- `checkRelation(relation: Relation, left: Operand, right: Operand): { verdict: "matches"|"contradicted"|"unconfirmed"; difference: number|null; differencePct: number|null; shownText: string|null; reasons: CheckReason[] }` where `Operand = { units: number; unit: FigureUnit; low?: number; high?: number }`. R7 exactly: above `> 0`, below `< 0`, in_line `|d| ≤ 0.005·|c|` inclusive; zero comparator → in_line `unconfirmed`, direction still decided; percent operands report the difference in percentage points (`shownText` "+0.3 pp"); range comparator rules; raised/lowered on midpoints, narrowed on widths, unchanged = equal low and high.
- `computeOp(op: ComputeOp, inputs: number[]): number | null` — growth with `old ≤ 0` → null; ratio returns a percentage (×100).
- `IN_LINE_BAND = 0.005`.

- [ ] **Step 1: Failing tests** (each assertion uses the spec's numbers): `matchesWithRounding({value:12.99,decimals:2,scale:"billions"}, 12_988e6)` true and `({12.99}, 12_984e6)` false (12.984 is outside ±0.005); `checkRelation("below", 64.601e9, 64.57e9)` → `contradicted`, `differencePct` ≈ +0.048; `checkRelation("above", …)` same operands → matches; `in_line` at exactly 0.5% → matches, at 0.51% → contradicted; zero comparator `in_line` → unconfirmed; negative comparator −7.3e9 vs −7.0e9 `above` → matches (difference +0.3e9); `computeOp("growth",[181712,141073])` ≈ 0.2881 and with old −5 → null; `scaleFromNote("in millions, except per share amounts","usd_per_share")` → `units`; `parseNumberToken("(5,313)")` → −5313, `parseNumberToken("—")` → null; `parsePeriodHeader("Nine Months Ended September 30, / 2026")` → `year_to_date`, endDate `2026-09-30`; `parsePeriodPhrase("in the third quarter", "2026-10-21")` → null.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(filing-summary): number, period and relation rules`.

### Task 6: EDGAR discovery for the filing summary

**Files:**
- Create: `lib/filing-summary/edgar.ts`
- Modify: `lib/print-watch/edgar-adapter.ts` (export `SEC_USER_AGENT`, `fetchSubmissions` as `fetchSubmissionsRecent`, `EDGAR_HEADER_ACCEPTANCE_RE`; no behaviour change), `lib/print-watch/scheduler.ts` (low-priority throttle, below)
- Test: `tests/filing-summary/edgar.test.ts`, `tests/print-watch/scheduler-priority.test.ts`

**Interfaces — Produces:**
- `AcquisitionScheduler.throttle(hostname, signal?, opts?: { priority?: "normal" | "low" })` and `fetchFor(signal, fetchImpl?, opts?)` — a low waiter is granted only when no normal waiter is queued for that host family (print-watch release acquisition first, spec hardening 11). Existing calls unchanged.
- `parseFilingHeader(html: string): { acceptanceMs: number | null; items: string[]; documents: Array<{ type: string; sequence: number; fileName: string; description: string | null }> }` — every `<TYPE>`/`<SEQUENCE>`/`<FILENAME>` group (not only EX-99); `<ITEMS>` lines (e.g. `2.02`, `9.01`).
- `classifyFiling(form: string, items: string[], documents, filerKind: "domestic" | "foreign"): "earnings" | "companion" | "ignored"` — domestic earnings = `8-K` with item `2.02`; foreign earnings = `6-K` with an `EX-99*` document; companions per the Global Constraints list; `8-K` without 2.02 after the earnings filing is a companion.
- `shouldSkipDocument(type: string, fileName: string): string | null` (reason or null).
- `listDayFilings(cik: string, eventDate: string, fetchFn: FetchLike): Promise<Array<{ accession: string; form: string; header: ReturnType<typeof parseFilingHeader> | null; headerError: string | null }>>` — submissions prefilter keeps a filing when either JSON reading falls on `eventDate` Eastern (same two readings as `pollEdgar`); every survivor's header is fetched; a header fetch failure is reported per filing (never dropped). Throws only when the submissions fetch itself fails (caller maps that to `sec_unreachable`).
- `fetchFilingDocument(cik, accession, fileName, fetchFn): Promise<{ ok: true; html: string; bytes: number } | { ok: false; reason: string }>` — 16 MB cap (`maxBytes`), markup content type; over the cap → `{ok:false, reason:"over 16 MB"}`.
- `filerKindFromSubmissions` is not needed: a filer is `foreign` when its recent forms include `6-K` or `20-F` and no `10-Q` — implement as `inferFilerKind(forms: string[]): "domestic" | "foreign"`.

- [ ] **Step 1: Failing tests** with a fake `fetchFn` serving synthetic submissions JSON and index-headers HTML (escaped `&lt;TYPE&gt;` form as EDGAR serves it): an 8-K header with `<ITEMS>2.02` and documents `8-K, EX-99.1, EX-10.1, GRAPHIC, EX-101.SCH` → classify `earnings`, skip reasons for GRAPHIC and EX-101.SCH; a header without ACCEPTANCE-DATETIME → `acceptanceMs:null` (caller marks time unconfirmed); one filing's header fetch 500s → that entry has `headerError` and the other filing still returns; Form 4 → `ignored`; `PRE 14C` after the earnings 8-K → `companion`; `inferFilerKind(["6-K","20-F"])` → foreign. Scheduler test: with concurrency 1, a low waiter queued before a normal waiter is granted after it.
- [ ] **Step 2–4.** Also run `npx vitest run tests/print-watch` — PASS. **Step 5:** Commit `feat(filing-summary): strict EDGAR discovery and a low-priority SEC lane`.

### Task 7: Output schema, prompt and bogey snapshot

**Files:** Create `lib/filing-summary/schema.ts`, `lib/filing-summary/prompt.ts`, `lib/filing-summary/bogey-snapshot.ts`; Test `tests/filing-summary/schema.test.ts`, `tests/filing-summary/prompt.test.ts`, `tests/filing-summary/bogey-snapshot.test.ts`

**Interfaces — Produces:**
- `SECTION_JSON_SCHEMA` (shape of `ModelSectionOutput`, flat nullable fields, no count keywords) and `SCHEMA_VERSION = 1`; `parseSectionOutput(raw: unknown): { ok: true; value: ModelSectionOutput } | { ok: false; error: string }` — runtime validation of every field and enum; then code-enforced caps: at most 12 bullets (extra dropped, noted), at most 3 `top` (later ones demoted). Ids unique within the section (duplicates → invalid).
- `PROMPT_VERSION = 1`; `buildSectionPrompt(input: { symbol: string; companyName: string | null; eventDate: string; filing: { form: string; acceptedAtEt: string; role: "earnings" | "companion" }; documents: Array<{ fileName: string; docType: string; text: string }>; bogeys: BogeySnapshotFigure[]; priorSections: Array<{ form: string; headline: string; claimTexts: string[] }> }): { system: string; user: string; fingerprint: string }` — rules from spec §5 plus R1 (placeholders, no other digits except years / Item / exhibit numbers / class letters), typed figures for every number, cite exact short quotes with the document file name, table rows as `cell | cell | cell`, comparisons name their operands by figure id, `corrects` only for an 8-K/A. `fingerprint` = sha256 of the exact system+user text.
- `buildBogeySnapshot(db, eventId): BogeySnapshotFigure[]` — reads `getBogeysWithContentForEvent`, keeps only rows whose linked article `received_at` (or `uploaded_at` for rows with no article) is before the pre-release slot floor used by the deep read (`AMC_FLOOR_ET` / `BMO_FLOOR_ET` composed on the event date); vendor rows always kept. Fields → figures: `eps_consensus`, `eps_whisper` (usd_per_share, basis `unknown` unless the row's metadata says otherwise — it does not today), `revenue_consensus_usd`, `revenue_whisper_usd` (usd, basis `reported`), `eps_consensus_vendor` (basis `unknown`); each with `period = {kind:"quarter", role:"actual", anchor:"reported_quarter", endDate:null, fiscalYear:null, fiscalQuarter:null, label:"this print's quarter"}`. Extra metric lines via `parseExtraMetrics`: kind `Q` → reported_quarter actual, `NQ_guide` → next_quarter outlook, `FY_guide` → fiscal_year outlook; basis `gaap`→`reported`, `non_gaap`→`non_gaap`, `na`→`unknown`; label = the line's label only (never its definition). Row kind from the same rule as `BOGEY_SOURCE_RANK_SQL` (`lib/print-watch/contracts.ts`). Provenance (R15): newsletter / deep read → the stored `source_label`; manual → `"your manual entry"`; upload → `"uploaded PDF"`; vendor → `"Finnhub consensus"`. `asOf` = Eastern date of the article / upload.

- [ ] **Step 1: Failing tests:** schema test — `parseSectionOutput` rejects a bad enum, accepts a valid fixture, demotes a 4th `top`, truncates 13 bullets to 12; a recursive JSON-schema walk asserts every object node has `additionalProperties:false`, every property in `required`, and no `minItems>1` / `maxItems`. Prompt test — fingerprint stable for identical input and different when a bogey value changes; the user text contains no `notes` text from a seeded bogey whose notes are `"CANARY-NOTES-7731"` and no account name `"CANARY-ACCOUNT"` seeded in `accounts`. Bogey snapshot test — a newsletter row whose article arrived 16:30 ET on an AMC print day is excluded, one from 09:00 kept; manual row provenance is `"your manual entry"` even when `source_label` is `"CANARY-LABEL"`; vendor EPS basis `unknown`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(filing-summary): output schema, prompt builder and pre-print bogey snapshot`.

### Task 8: Claim evaluation (bind figures to evidence, derive status)

**Files:** Create `lib/filing-summary/evaluate.ts`; Test `tests/filing-summary/evaluate.test.ts` (plus synthetic fixtures under `tests/fixtures/filing-summary/`)

**Interfaces — Consumes:** Tasks 3, 4, 5, 7. **Produces:** `CHECKER_VERSION = 1`; `evaluateSection(input: { output: ModelSectionOutput; docs: Array<{ fileName: string; text: DocText }>; cik: string; accession: string; eventDate: string; bogeys: BogeySnapshotFigure[]; priorClaims: CheckedClaim[] }): CheckedSection`; `countStatuses(claims: CheckedClaim[]): StatusCounts`; `renderClaimText(claim: ModelClaim): { text: string; unbound: boolean }`.

Algorithm (decisions the implementer cannot make alone):
1. `renderClaimText`: replace `{fN}` with that figure's `valueText`; an unknown placeholder or a digit outside placeholders that is not `\b(19|20)\d\d\b`, `Item \d+(\.\d+)?`, `EX-\d+(\.\d+)*` → `unbound: true` (R1).
2. Footnotes: `locateQuote` per citation → `toFootnote`.
3. Quote figures: the citation must be found (else `quote_not_found` / `ambiguous_quote`); the figure's `label` must appear in the located block (normalised) else reason `label_not_in_quote`. Table row: scale from the table's `scaleNote` else `documentScaleNote` via `scaleFromNote`; candidate cells = numeric cells in that row whose value matches (`matchesWithRounding`) at that scale; each candidate's period = `parsePeriodHeader(columnHeaders[col])`; keep candidates whose period `samePeriod` with the figure's period is true; exactly one → established; zero with any value match → `periods_differ` reason if a header parsed to a different period, else `period_unconfirmed`; more than one → `column_ambiguous` (unconfirmed). Metric: the figure's `metric` and the row label share a content word (lower-case, words ≥ 3 letters, stop-words removed) else `metric_unconfirmed` (R2). Prose: number tokens in the sentence (handle "billion"/"million" words as scale) must match; period from `parsePeriodPhrase(sentence)` else from the block's paragraph else `period_unconfirmed`.
4. Bogey figures: found in the snapshot by `bogeyKey` with the same value (rounding rule) else `not_in_filing`. Anchored periods resolve against the other operand's table: `reported_quarter` = the quarter-kind column with the latest `endDate` in that table; equality then by end date.
5. Computed figures: all inputs established; operation-specific compatibility (R8); `computeOp` result matches the stated value under the rounding rule → established + reason `computed` (shown label); else `contradicted` only if inputs are established; no inputs and no source → `not_in_filing`.
6. Comparisons: both operands established (and basis known when either operand's basis is `unknown` and the other is not `reported`… simply: if either basis is `unknown` → `basis_unconfirmed`); periods equal by `samePeriod` → `checkRelation`; `samePeriod === false` → `periods_differ`; null → unconfirmed.
7. Status per claim (R9): no figures and no comparisons → `qualitative`; `unbound` → at least `figure_not_bound`; contradicted only from a contradicted comparison/computed figure with all operands established; then warning statuses (`periods_differ`, `not_in_filing`, `quote_not_found`, `ambiguous_quote`, `figure_not_bound`), then `unconfirmed`, else `checked`. Store every reason.
8. `corrects` (R17): resolved only when the claim's correcting citation is found and `priorClaims` has `claimId`.

- [ ] **Step 1: Failing tests** — one per acceptance case and per R18 case, each a small synthetic table/sentence fixture:
  - revenue "below the {f2} consensus" with filing 64,601 (millions, Three Months Ended Sept 30 2026) vs vendor-free revenue bogey 64.57e9 → `contradicted`, shown difference `+0.05%`.
  - nine-month FCF 11,049 vs a full-year (`FY_guide`) bogey −7.3e9 → `periods_differ`.
  - "29%" growth with no inputs → `not_in_filing`; with inputs 181,712 and 141,073 cited from Nine Months columns 2026/2025 and stated `29%` → `checked` (computed).
  - "$12.99B" operating income against "12,988" (in millions) → `checked`.
  - wrong metric right number (net income number labelled operating income, row label "Net income") → `unconfirmed` (metric_unconfirmed).
  - swapped columns (claims the 2025 column value as Q3 2026) → `periods_differ`.
  - claim text "revenue fell 10%" with no placeholder → `figure_not_bound`.
  - EPS 7.25 under an "in millions, except per share" table → scale units → `checked`.
  - vendor EPS (basis unknown) `above` → not checked: `unconfirmed` with `basis_unconfirmed`.
  - zero comparator `in_line` → `unconfirmed`; negative comparator `above` → `checked`.
  - rounding boundary: stated 12.99B vs 12,995 million (exactly half a unit) → `checked`; vs 12,996 million → `unconfirmed` with reason `value_not_in_quote` (a sourced figure that does not match is never `contradicted`; only comparisons and computed figures can be).
  - a quote found twice → `ambiguous_quote`.
  - `countStatuses` on a mixed list gives the exact counts.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(filing-summary): app-side claim evaluation and status`.

### Task 9: Poller, lifecycle tick, merge handler, registration

**Files:** Create `lib/filing-summary/poller.ts`, `lib/filing-summary/tick.ts`, `lib/filing-summary/merge.ts`, `lib/filing-summary/register.ts`, `lib/filing-summary/files.ts`; Modify `lib/print-watch/register.ts` (call `registerFilingSummary(db)` after the first-pass registration); Test `tests/filing-summary/poller.test.ts`, `tests/filing-summary/merge.test.ts`

**Interfaces — Produces:**
- `files.ts`: `filingStoragePath(cik, accession, fileName): string` → `<resolveDbDir()>/filing-summary/<cik>/<accession>/<fileName>` (validated like `secArchiveUrl`); `writeFilingDocument(...)`, `readFilingDocument(path): string | null`.
- `poller.ts`: `pollEvent(db, eventId, nowMs, seams: PollSeams): Promise<PollOutcome>`; `PollSeams = { fetchFn: FetchLike; resolveCik(symbol, fetchFn): Promise<string|null>; now(): number; issuerName(db, symbol): string | null; onEarningsAccepted(db, eventId): void; onCompanionAccepted(db, eventId, filingId): void }`.
  Lifecycle (R12, late-arm ruling): row created on first sight of an armed event; created when `now ≥ cutoff` or `event_date < todayET` → `manual_only` (nothing polled automatically, detail "armed after 8 pm — Run summary to spend"); before 06:00 ET → no work; between 06:00 and cutoff → poll (submissions fetch failure → `sec_unreachable`, retried next tick, never "no filing"); first tick at/after cutoff with `catchup_done = 0` → one more poll, then `past_cutoff` (detail "no earnings 8-K filed by 8 pm" / "6-K" by filer kind when none found), `catchup_done = 1`. Filings: header acceptance required (else `time_unconfirmed`, not run); acceptance must be on the event date and ≤ cutoff (Eastern); earnings filing must pass `validateDocForEvent` on its EX-99 text (or main document when no EX-99) with the issuer name → `accepted`, else `ambiguous` with the gate's reason (event `poll_state = 'ambiguous'`, nothing run). Every document is fetched with `{priority:"low"}`, stored with sha256, and recorded `fetched / skipped / failed`; the filing is `fetched` when every non-skipped document is fetched, else `failed` (still summarised; coverage marks it incomplete). On a newly accepted earnings filing call `onEarningsAccepted`; on a newly accepted companion (acceptance after the earnings filing's) call `onCompanionAccepted`.
- `tick.ts`: `startFilingSummaryTick(db)` (idempotent, 60 s, unref'd, inert under VITEST unless `enableFilingSummaryTick()`); `runTick(db, nowMs, seams)`: `markSendingAsUnknown` once per process; for every armed earnings event dated today or yesterday (ET) → `pollEvent`; armed flag gone → `poll_state='cancelled'` and pending sections `failed` with `error_class='cancelled'`; armed again on the event date before the cutoff with `poll_state='cancelled'` → `waiting`; then `listEventsWithPendingSections` → `runNextSection` (Task 10) one per event, sequential. A tick never overlaps itself (in-process latch); paid work is guarded by section claims.
- `merge.ts`: `FILING_SUMMARY_MERGE_HANDLER_NAME = "filing-summary"`; `mergeFilingSummaryState(ctx: EventMergeContext): EventMergeTableResult[]` (R14): event row — keep the target's if present (choice and lock from whichever is locked; target wins on tie), else move donor's; filings — donor accession already on target → re-point donor sections to the target filing id, delete donor filing (its documents cascade; files are accession-keyed on disk so nothing is lost); else move; runs — move with `run_no` renumbered after the target's max in donor order; sections with a live claim → `claim_token=NULL, status='pending'`; pushes → move (skip on key collision).
- `register.ts`: `registerFilingSummary(db?)` registers the merge handler and, with a db, starts the tick; latched like `registerFirstPass`, with `__resetFilingSummaryRegisterForTests`.

- [ ] **Step 1: Failing tests** (fake clock, fake fetch, in-memory DB): armed AMC event, tick at 15:00 ET with no filing → `waiting`; filing accepted 16:05 appears → one filing `earnings/accepted`, `onEarningsAccepted` called once, a second tick does not call it again; PRE 14C accepted 16:12 → companion, `onCompanionAccepted` once; a companion accepted 20:01 → not inserted; **Review Focus 2**: no tick between 15:50 and 21:30, then one tick at 21:30 → catch-up finds the 16:05 8-K (inserted, accepted) and ignores the 20:01 one, then `past_cutoff`; submissions fetch throws → `sec_unreachable` (not past_cutoff, not "no filing"); **Review Focus 1**: header without acceptance → `time_unconfirmed`, `onEarningsAccepted` not called; arming at 20:30 → `manual_only`, no fetch made; disarm → `cancelled` and pending sections `failed/cancelled`; re-arm the same day before 20:00 → back to `waiting` and an existing run is kept, no new run (late-arm ruling); gate failure (issuer not named) → `ambiguous`. Merge test (**Review Focus 5**): donor and target both have accession X and a running donor section → after merge one filing row, donor section re-pointed and `pending` with no claim, run numbers 1..n unique on the target.
- [ ] **Step 2–4.** Also `npx vitest run tests/print-watch tests/earnings` — PASS. **Step 5:** Commit `feat(filing-summary): evening poll, durable tick and event-merge handler`.

### Task 10: Runner (runs, sections, attempts, companions)

**Files:** Create `lib/filing-summary/runner.ts`; Test `tests/filing-summary/runner.test.ts`

**Interfaces — Produces:**
- `startRun(db, eventId, trigger: "auto" | "rerun" | "manual_run", opts: { choice?: SummaryChoice; requestKey?: string | null; catalogIds?: string[] }): { ok: true; runId: number; created: boolean } | { ok: false; reason: "no_filings" | "no_model" | "not_found" }` — choice from `getChoice` unless given; `resolveFamilyModel` once (R12/R17), fallback recorded as `fallback_note` ("Fable unavailable — Opus 5.5 ran instead"); `buildBogeySnapshot` frozen into the run; filing list = accepted earnings filing then accepted companions in `discovery_seq` order, frozen.
- `appendCompanion(db, eventId, filingId): number | null` — R13 destination: newest run that is `running` or `done`; if the newest is `failed`, the newest `done`; with none done, the newest failed run (section waits for Retry). Returns the section id. (When appended to a `done` run, the run goes back to `running`.)
- `onEarningsAccepted(db, eventId)` → `startRun(db, eventId, "auto")` unless the event is `manual_only` or `cancelled` or already has a run; `onCompanionAccepted` → `appendCompanion`.
- `retryRun(db, runId, requestKey): boolean` — failed sections (not refusal/truncated? — those too, on an explicit click) back to `pending` with `attempts = 0`.
- `runNextSection(db, eventId, seams: RunnerSeams): Promise<"ran" | "idle" | "lost_claim">`; `RunnerSeams = { generate: typeof generateObjectWithModel; readDocument(path): string | null; now(): number; token(): string; onSectionDone(db, sectionId): Promise<void> }`.
  Steps: claim → load the filing's fetched documents, `extractDocText` each, build coverage (skipped/failed docs, cap overflow at 1.6M chars in sequence order → "over the input cap"), `incomplete` when any entry is not `read` → prior sections of the same run (done, lower seq) as `priorSections` and their checked claims as `priorClaims` → `buildSectionPrompt` → heartbeat → `generate(…, {modelId: run.model_id, effort: run.effort, family: run.family}, {schema: jsonSchema(SECTION_JSON_SCHEMA), system, prompt, maxOutputTokens: 32000, abortSignal: AbortSignal.timeout(300_000)})` → `parseSectionOutput` → `evaluateSection` → `finalizeSection` with `versions_json = {schema, prompt, extractor, checker}`, `usage_json` (input, output, reasoning tokens as reported), `counts_json`. Failures: `AIRefusalError` → failed `refusal`; `AITruncatedError` → failed `truncated`; `AIModelUnavailableError` → failed `model_unavailable` ("model no longer available — re-run"); invalid output, timeout, other API error → `requeueSection` while `attempts < 2`, else failed (`attempt_cap`, with the last class in `error_text`). Never log document text or error bodies — ids and classes only.

- [ ] **Step 1: Failing tests** with a fake `generate`: happy path writes `checked_json`, run `done`, `onSectionDone` once; refusal → failed, no second call; truncation → failed `truncated`; first call throws a timeout, second succeeds → done with `attempts=2`; two failures → `attempt_cap`; `startRun` with the same `requestKey` twice → one run (**Review Focus 4**); companion appended while a rerun is `running` lands on the rerun and runs after its earnings section, reading it as `priorSections`; companion arriving when newest run failed lands on the newest done run; a stale worker whose claim was taken over cannot finalize (returns `lost_claim`, no write); the prompt passed to `generate` contains none of the CANARY strings from Task 7's seed.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(filing-summary): section runner with bounded attempts and companion ordering`.

### Task 11: Pushes

**Files:** Create `lib/filing-summary/push.ts`; Modify `lib/filing-summary/runner.ts` default `onSectionDone`; Test `tests/filing-summary/push.test.ts`

**Interfaces — Produces:** `composeSummaryPush(input: { symbol: string; form: string; role: "earnings" | "companion"; counts: StatusCounts; incomplete: boolean; acceptedAtEt: string }): { title: string; message: string }` — earnings: title `"META filing summary"`, message `"12 claims · 9 checked · 1 contradicted · 2 unconfirmed"` (zero parts omitted; `"· incomplete"` appended when incomplete); companion: title `"META · PRE 14C · 4:12 pm"`, message `"adds 3 claims · …"`. `sendSummaryPushIfDue(db, sectionId, send = sendPushover): Promise<void>` — only for runs with `trigger = 'auto'`; key `fs:<eventId>:<accession>` (one push per filing per event, ever — a re-run or a later run never re-pushes, R15/R16); `beginPush` → `markPush('sending')` → send → `sent` / `failed`; url `${PUSHOVER_LINK_BASE}/dashboard/print/<eventId>/filings`.

- [ ] **Step 1: Failing tests:** composed strings exactly as above for a fixture; second call for the same section sends nothing; a `rerun` section sends nothing; a crash simulated between `sending` and `sent` then `markSendingAsUnknown` → `delivery_unknown` and no resend on the next call.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(filing-summary): at-most-once pushes`.

### Task 12: Routes, view model and shareable page

**Files:** Create `lib/filing-summary/view.ts`, `lib/filing-summary/share-page.ts`, `app/api/filing-summary/route.ts`, `app/api/filing-summary/[eventId]/route.ts`, `app/api/filing-summary/[eventId]/share/route.ts`; Test `tests/filing-summary/view.test.ts`, `tests/filing-summary/share-page.test.ts`, `tests/api/filing-summary-routes.test.ts`

**Interfaces — Produces:**
- `view.ts`: `getPanelViews(db, eventIds: number[], catalogIds: string[]): Record<number, PanelView>`; `PanelView = { eventId; choice: SummaryChoice; choiceLabel: string; isDefault: boolean; locked: boolean; nowLabel: string; pollState; pollDetail: string | null; shown: RunSummary | null; inProgress: RunSummary | null; runSummaryAvailable: boolean }`; `RunSummary = { runId; runNo; status; trigger; modelLabel: string; effort; fallbackNote: string | null; counts: StatusCounts; incomplete: boolean; top: CheckedClaim[]; sectionStates: Array<{ form: string; acceptedAtEt: string | null; status; errorClass: string | null }>; excludesAfterEt: string | null }`. `shown` = newest `done` run (falls back to newest run when none done); `inProgress` = a newer `running` run. `getFullView(db, eventId, catalogIds): FullView` with every run, its sections (headline, checked claims, coverage, filing form / time / accession links), filings list with identity verdicts, and the bogey snapshot's public fields.
- `share-page.ts`: `renderSharePage(view: FullView, runId: number): string` — one self-contained HTML document, inline `<style>` (light and dark via `prefers-color-scheme`), no scripts, every text through one `escapeHtml`, only `https://www.sec.gov/Archives/…` links built by `secArchiveUrl`/`textFragmentUrl`; header line "META · Q3 filing summary · Opus 5.5 high · 12 claims · …"; incomplete banner; statuses with their reasons; footnotes; bogey provenance + date; filing times. No app links.
- `GET /api/filing-summary?eventIds=1,2` → `{success:true, data: Record<id, PanelView>}` (read-only).
- `POST /api/filing-summary` body `{eventId, action: "set_choice" | "run" | "rerun" | "retry", family?, effort?, runId?, requestKey}`: `set_choice` → 409 `{error:"locked"}` after lock; `run` (manual_only / past_cutoff with filings and no run) → `startRun(…,"manual_run")`; `rerun` with a choice → `startRun(…,"rerun")`; `retry` → `retryRun`; every paid action requires a `requestKey` string (400 otherwise) and is idempotent on it; non-earnings or unknown event → 404/400 in the worksheet route's style; after a paid action, kick `runTick` without awaiting.
- `GET /api/filing-summary/[eventId]` → `{success:true, data: FullView}`.
- `GET /api/filing-summary/[eventId]/share?runId=N` → `text/html; charset=utf-8`, `Content-Disposition: attachment; filename="<SYMBOL>-<date>-filing-summary-run<N>.html"`, `Cache-Control: no-store`.

- [ ] **Step 1: Failing tests:** view — `shown` stays the done run while a rerun is `running`; `excludesAfterEt` set on an older run when a newer run has more filings. Share page — a claim text containing `<script>alert(1)</script>` is escaped; the HTML contains no `<script`; it contains no CANARY strings from seeded portfolio tables; status counts in the header equal `countStatuses`. Routes (call the handlers directly with `Request` objects and a seeded DB through the project's route-test pattern): `set_choice` after lock → 409; `rerun` twice with the same `requestKey` → one run; missing `requestKey` → 400; GET share returns `attachment` disposition. Route policy — `classifyRoute("POST","/api/filing-summary")` is `"human"`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(filing-summary): routes, view model and shareable page`.

### Task 13: Panel in the print row and the choice at arming

**Files:** Create `app/dashboard/today/FilingSummaryPanel.tsx`, `app/dashboard/today/FilingSummaryChoice.tsx`, `app/dashboard/today/filing-summary-text.ts` (pure copy helpers); Modify `app/dashboard/today/LivePrintRow.tsx` (render the panel after `FirstPassRead`, and inside `PrintRecordView` above its table when an event id is known), `app/dashboard/today/EarningsRowChips.tsx` (render `FilingSummaryChoice` beside the armed worksheet chip when armed); Test `tests/dashboard/filing-summary-text.test.ts`, `tests/dashboard/filing-summary-panel-source.test.ts`

**Interfaces — Consumes:** Task 12 routes and `PanelView`. **Produces:** `pollStateText(view: PanelView): string` — exact copy: waiting `"Waiting for the earnings 8-K · Opus · high"`; found+running `"Reading 8-K + 3 exhibits · Opus 5.5 high"`; `sec_unreachable` `"SEC not reachable — still trying"`; `past_cutoff` with no filing `"No earnings 8-K filed by 8 pm"` (6-K wording for foreign filers); `manual_only` `"Armed after 8 pm — nothing runs on its own"`; `ambiguous` `"Filing found but it does not name this quarter: <reason>"`; `cancelled` `"Disarmed — summary stopped"`. `countsText(counts): string` → `"12 claims · 9 checked · 1 contradicted · 2 unconfirmed"`.

UI decisions: the choice control is a native `<select>` with the five `choiceLabel`s, the selected option text suffixed by the family's now-label in the options ("Fable · high — now 5.1"); disabled with a "locked — re-run to change" note when locked. The panel polls `GET /api/filing-summary?eventIds=<id>` every 30 s while any run is running or the poll state is `waiting`/`found`/`sec_unreachable`, otherwise once. It shows the status line, the model line (with fallback note in warning tone), the counts line, a contradicted-in-Top-3 call-out at the top in danger tone, the Top 3 claims each with a status `<Chip>` (tone from `STATUS_SEVERITY`: danger/warning/muted/ok) and footnote markers `[1]` linking to the sec.gov fragment URL (`target="_blank" rel="noreferrer"`), "Open full summary" link to `/dashboard/print/<eventId>/filings`, a **Run summary** button for `runSummaryAvailable`, and **Retry** on a failed run — both through `useConfirmPrompt` stating the model and the rough cost from `ROUGH_COST_BY_CHOICE` in `filing-summary-text.ts` (Meta test figures 2026-10-21: measured: Sonnet·medium ≈ $0.11, Opus·high ≈ $0.32, Fable·high ≈ $0.68 per 8-K; not measured: Opus·medium and Fable·medium, shown as "less than Opus · high" / "less than Fable · high" until Task 15's replay measures them; copy says "about" and "per filing"), POSTing with a fresh `crypto.randomUUID()` request key held in a ref for the click.

- [ ] **Step 1: Failing tests:** `filing-summary-text.test.ts` asserts every `pollStateText` string above and `countsText` omits zero parts. Source-pin test (repo style, `anchorIndex`): `LivePrintRow.tsx` renders `<FilingSummaryPanel` after `<FirstPassRead`; `FilingSummaryPanel.tsx` uses `readMutationResult`, `useConfirmPrompt`, and no `confirm(`; `FilingSummaryChoice.tsx` uses a `<select` and no caret glyph (`▾`, `▼`, `⌄`).
- [ ] **Step 2–4.** Plus `npx tsc --noEmit -p .` and `npx next build` in the worktree (seat a migrated `data/vanguard.db` copy first, CLAUDE.md gotcha) — PASS. **Step 5:** Commit `feat(filing-summary): print-row panel and per-print model choice`.

### Task 14: Full summary page

**Files:** Create `app/dashboard/print/[eventId]/filings/page.tsx` (server, `export const dynamic = "force-dynamic"`, loads `getFullView` directly), `app/dashboard/print/[eventId]/filings/FilingSummaryView.tsx` (client); Test `tests/dashboard/filing-summary-page-source.test.ts`

Decisions: run switcher as a pill row (`Run 2 · Fable 5.1 high · 7:41 pm` …), newest done selected; "Re-run with…" = native select of the five choices + a button through `useConfirmPrompt` (copy names model and rough cost) with a request key; sections in order, each headed `"8-K · 4:05 pm"` / `"PRE 14C · 4:12 pm"` with its coverage list (read / skipped with reason / failed) and an **incomplete** banner when any; each claim shows the rendered text, status chip, every reason in plain words (`reasonText(code)` in `filing-summary-text.ts` — one sentence per code, e.g. `metric_unconfirmed` → "The number is in the cited line, but the line's label does not name this metric."), the comparison's shown difference, and numbered footnotes (document, "page 3, paragraph 4" or "paragraph 4", the sentence, "open on sec.gov"); corrected claims show "corrected by 8-K/A, 5:40 pm" only when resolved; a **Make shareable page** link (`<a href=".../share?runId=N" download>`). Phone width: footnotes stack under the claim; no horizontal scroll (`[overflow-wrap:anywhere]` on sentences and file names).

- [ ] **Step 1: Failing tests:** `reasonText` has a sentence for every reason code `evaluate.ts` can emit (import the code list exported from `evaluate.ts` as `REASON_CODES`); page source-pin: `force-dynamic` exported, the download anchor has `download`, no `dangerouslySetInnerHTML`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(filing-summary): full summary page with runs, footnotes and coverage`.

### Task 15: Replay, docs, migration rehearsal, browser pass

**Files:** Create `scripts/filing-summary-replay.ts`; Modify `docs/reference/earnings-pipeline.md` (new §Filing summary), `CLAUDE.md` (one Conventions bullet: where it lives, the R1/R9 rules, Mac-only, choice beats Settings override), `docs/plans/TODO.md`, `docs/DECISIONS.md` (2026-10-22 entry: owner rulings + Codex R1–R18 as my calls)

- [ ] **Step 1: Replay script** — `npx tsx scripts/filing-summary-replay.ts --dir tests/fixtures/real/filing-summary/meta-2026-10-21 --family opus --effort high [--db <copy>]`: reads saved documents (copy the three Meta files from the session scratchpad `meta8k/` and fetch the PRE 14C once into that gitignored dir), runs the real prompt → model → evaluate pipeline on an in-memory DB with a synthetic event and the pre-print bogey file, prints counts, every claim's status and reasons, usage (input / output / reasoning tokens) and cost at the published prices, and writes the share page to the scratchpad. Spend: one Opus·high run on the 8-K and one on the 14C (~$1 total).
- [ ] **Step 2:** Check by eye at least five footnotes' page and paragraph against sec.gov; record results and the measured token cost in the task report.
- [ ] **Step 3: Migration rehearsal** — VACUUM copy of the live DB, run the migrator on it, `PRAGMA foreign_key_check` empty, `integrity_check` ok, the five tables present, no other table changed (schema diff).
- [ ] **Step 4: Browser pass** via `npm run sandbox` + agent-browser on the sandbox port (Safari-equivalent WebKit if available, else Chromium) with a seeded armed event and the replayed run copied into the sandbox DB: arm and change the choice; the panel's every state (seed rows for waiting, sec_unreachable, past_cutoff, manual_only + Run summary, failed + Retry); the full page; re-run confirm dialog (cancel — no spend); a real download of the share page and its contents; 390 px width with no sideways scroll; light and dark themes. Every status chip appears and the counts agree across panel, full page, share page and the composed push text.
- [ ] **Step 5:** `bash scripts/verify.sh full --base main` — PASS; commit docs `docs(filing-summary): pipeline reference, conventions, decisions`.
