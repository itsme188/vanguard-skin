# Live Print-Watch v1 Implementation Plan (v2 — post-Codex-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an armed earnings event prints, Portfolio Desk fills the bogey sheet on a live Today panel within seconds-to-minutes (DJ wire / EDGAR / NVDA RSS / drag-drop), dual-parsed and mechanically reconciled with bogeys displayed beside actuals, with one-click verified promotion of the complete headline pair — in production before the 2026-08-26 NVDA/CRWD prints.

**Architecture:** An in-process watcher (Next server inside Electron, DB-leased so only one process owns it) opens per-armed-event windows and runs source adapters on serialized non-overlapping loops; acquired documents pass a document-to-event validation gate, are hashed/stored under the app-data dir, parsed (per-representation), and reconciled ACROSS the print's whole document set into per-line states; the Today panel polls a read-only status route every 2s and shows actual-vs-bogey per line. Accepting promotes the complete headline pair through `saveManualActuals`. Additive only; the existing enrichment pipeline is untouched.

**Tech Stack:** TypeScript / Next.js App Router (thin routes over `lib/`), better-sqlite3 (DI `db` param), @stoqey/ib raw `IBApi` via the `lib/tws/wsh.ts` extraction precedent, @anthropic-ai/sdk via the repo model registry, Vitest (in-memory SQLite).

**Spec:** `docs/superpowers/specs/2026-08-20-live-print-watch-design.md` (v1.1 + §9). V1 scope cut user-approved 2026-08-20. **Codex plan review 2026-08-20: 26 findings; 22 adopted below; 4 accepted deviations** (recorded at the end of this header): (a) basis/period/unit stay contract-pinned rather than per-candidate re-declared — the bake-off pilot validated exactly this shape at zero catastrophic errors and the human verify backstops it; (b) a calendar-event rekey during a live watch window is an accepted rarity (correction refuses once actuals exist; the sweep re-arm recreates the print for the new event id; the orphaned print row is kept as evidence); (c) a minimal per-host request spacer replaces a full global governor (≤3 simultaneous prints in v1); (d) migration tests are fresh-db-only (the migration is CREATE-only — no populated-data rewrite risk).

## Global Constraints

- Never hardcode a model id — resolve via the repo registry exactly as `scripts/spike-bakeoff-parse.ts` does (`resolveTier("workhorse", …)` → falls back to `SONNET_MODEL`).
- Every DB function takes `db: Database.Database` first (DI for tests). Route envelope `{success:true,…}`/`{success:false,error}`; routes thin; unlisted routes default to "human" in `lib/auth/route-policy.ts` — add NO service entries; UI mutations via `apiFetch` (CSRF). **GET routes must be read-only** — `tests/api/no-state-changing-get.test.ts` statically scans for `ensure*()`-style calls in GET handlers and will fail the suite otherwise.
- Runtime file storage anchors at `resolveDbDir()` (`lib/db/db-path.ts` — the packaged app's cwd is a read-only signed bundle; sidecars resolve beside the database): `<resolveDbDir()>/print-watch/<printId>/<sha256>.<ext>`, written via temp-file + atomic rename.
- Timestamps compare with `datetime()` on BOTH sides; user-facing dates ET-anchored (`todayET()`).
- Anthropic tool schemas: `additionalProperties:false` on EVERY object node. Extraction prompts NEVER contain expected/bogey values or disclosure expectations — expected values travel in a parallel structure that never reaches a prompt.
- Press-release figures on the panel are public market data → plain formatting; the BOGEY column derives from the user's curated bogeys → wrap in `<PrivateText>`/`<Money>`-family privacy components.
- No new npm dependencies. Node via `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Outbound fetch hardening everywhere: SEC User-Agent `PortfolioDesk contact@myportfoliodesk.com`; per-host minimum spacing (SEC 300ms, others 200ms) via the shared spacer (Task 9); `redirect:"manual"` with same-host revalidation; `content-length` precheck + streamed 2MB cap; NVDA RSS cache-bust `?zz=<random>`.
- Snippets/model prose render only through React text nodes (never `dangerouslySetInnerHTML`); error strings surfaced to the UI are message-only (no URLs with tokens, no document bytes).
- Tests: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <paths>`. Commits via `git commit -F <tempfile>`.

## File Structure

```
lib/db/migrations/085_print_watch.sql        # 3 tables (Task 1)
lib/print-watch/types.ts                     # shared types (Task 1)
lib/print-watch/store.ts                     # all DB reads/writes (Task 1)
lib/print-watch/contracts.ts                 # contracts + PARALLEL expected values (Task 2)
lib/print-watch/representations.ts           # ported extractors (Task 3)
lib/print-watch/extract.ts                   # model call → tagged candidates (Task 4)
lib/print-watch/reconcile.ts                 # cross-document monotonic reconciler (Task 5)
lib/print-watch/dj-adapter.ts                # DJ poll + quiescent stitch + flashes (Task 6)
lib/print-watch/edgar-adapter.ts             # acceptance-window 8-K/6-K + all EX-99.* (Task 7)
lib/print-watch/ir-rss-adapter.ts            # hardened RSS adapter, NVDA config (Task 8)
lib/print-watch/watcher.ts                   # leased singleton, serialized loops, gate, queue (Task 9)
app/api/print-watch/status/route.ts          # GET read-only sheet payload (Task 10)
app/api/print-watch/ensure/route.ts          # POST ensure/reconcile watcher (Task 10)
app/api/print-watch/drop/route.ts            # POST document upload (Task 10)
app/api/print-watch/accept/route.ts          # POST accept/unaccept + pair promotion (Task 11)
app/dashboard/today/PrintWatchPanel.tsx      # live sheet UI w/ bogey column (Task 12)
app/dashboard/today/page.tsx                 # mount (Task 12)
lib/calendar/email-sweep.ts                  # ensurePrintWatch nudge (Task 9)
tests/print-watch/*.test.ts                  # per-task
tests/fixtures/print-watch/synthetic-release.html  # COMMITTED synthetic fixture (Task 13)
tests/print-watch/replay.test.ts             # synthetic (always) + CRWD corpus (guarded) replays (Task 13)
```

---

### Task 1: Schema, types, and store

**Files:**
- Create: `lib/db/migrations/085_print_watch.sql`
- Create: `lib/print-watch/types.ts`
- Create: `lib/print-watch/store.ts`
- Test: `tests/print-watch/store.test.ts`

**Interfaces:**
- Consumes: migration conventions (see `084_manual_actuals_at.sql`), migrate test pattern (`tests/db/migration-084-manual-actuals.test.ts`), `resolveDbDir` from `lib/db/db-path.ts`.
- Produces (later tasks depend on these EXACT names):

```ts
// types.ts
export type PrintWatchState = "scheduled" | "window_open" | "acquired" | "parsed" | "expired" | "disarmed";
export type LineStateKind = "pending" | "flash" | "single_source" | "agreed" | "conflict" | "blank" | "accepted";
export interface LineContract {
  metric_id: string; label: string; definition: string;
  basis: "gaap" | "non_gaap" | "na"; period: "Q" | "NQ_guide" | "FY_guide";
  currency: string; unit: "per_share" | "usd" | "percent" | "count";
  kind: "point" | "range"; segment: string | null;
}
export interface ExpectedValue { value: number | null; value_high: number | null; whisper: number | null; source_label: string | null; }
export interface ParseCandidate {
  metric_id: string; value: number | null; value_high: number | null;
  raw_text: string | null; snippet: string | null; location_hint: string | null;
  not_disclosed: boolean;
}
/** A candidate tagged with where it came from — reconciliation identity. */
export interface TaggedCandidate extends ParseCandidate {
  doc_id: number; representation: "repA" | "repB" | "flash";
  /** True when this doc was plain text parsed twice by the same prompt —
   *  such pairs are NOT independent and can never green alone (Codex #3). */
  weak_pair: boolean;
}
export interface PrintWatchLine {
  metric_id: string; contract: LineContract; expected: ExpectedValue | null;
  state: LineStateKind; value: number | null; value_high: number | null;
  snippet: string | null; source_doc_id: number | null;
  candidates_json: string; // JSON TaggedCandidate[]
}
export type PrintWatchDocKind = "dj-release" | "edgar-ex99" | "ir-page" | "user-drop";
```

```ts
// store.ts — every fn takes db first
export function upsertPrint(db, eventId: number, symbol: string, eventDate: string, releaseTimeEt: string | null): number; // UNIQUE(event_id)
export function setPrintState(db, printId: number, state: PrintWatchState): void;
export function getPrintByEventId(db, eventId: number): PrintRow | null;
export function listActivePrints(db): PrintRow[]; // state IN (scheduled, window_open, acquired, parsed)
export function insertDocument(db, printId: number, kind: PrintWatchDocKind, source: string, url: string | null, sha256: string, bytesPath: string): { id: number; isNew: boolean };
export function markDocumentParsed(db, docId: number): void;           // parsed_at = datetime('now')
export function listUnparsedDocuments(db, printId: number): DocumentRow[]; // parsed_at IS NULL (Codex #6: crash recovery re-parses these)
export function listDocuments(db, printId: number): DocumentRow[];
export function upsertLines(db, printId: number, lines: PrintWatchLine[]): void; // NEVER downgrades 'accepted': accepted rows refresh candidates_json only
export function getSheet(db, printId: number): PrintWatchLine[];
export function markLineAccepted(db, printId: number, metricId: string): void;
export function clearLineAccepted(db, printId: number, metricId: string): void;  // unaccept → state recomputed by next reconcile (Codex #15)
export function acquireWatcherLease(db, holder: string, nowMs: number, ttlMs: number): boolean; // settings-table row 'print_watch_lease' = JSON {holder, expiresAt}; true when acquired/renewed; stale (expired) leases are taken over (Codex #7)
```

**Migration SQL (write exactly):**

```sql
-- 085: live print-watch v1 (spec 2026-08-20 §5, v1 subset + Codex plan-review fixes).
-- Prints key to calendar_events.id (UNIQUE) with NO cascade: evidence must
-- survive event correction. ACCEPTED LIMITATION (plan header, deviation b):
-- a date-correction that deletes/re-homes the event mid-window orphans this
-- print (kept as evidence) and the sweep re-arm creates a fresh print for
-- the successor event.
CREATE TABLE print_watch_prints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  event_date TEXT NOT NULL,
  release_time_et TEXT,
  state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled','window_open','acquired','parsed','expired','disarmed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE print_watch_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  kind TEXT NOT NULL CHECK (kind IN ('dj-release','edgar-ex99','ir-page','user-drop')),
  source TEXT NOT NULL,
  url TEXT,
  sha256 TEXT NOT NULL,
  bytes_path TEXT NOT NULL,
  parsed_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(print_id, kind, sha256)
);
CREATE TABLE print_watch_lines (
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  metric_id TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  expected_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','flash','single_source','agreed','conflict','blank','accepted')),
  value REAL, value_high REAL, snippet TEXT,
  source_doc_id INTEGER REFERENCES print_watch_documents(id),
  candidates_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (print_id, metric_id)
);
CREATE INDEX idx_pw_documents_print ON print_watch_documents(print_id);
```

- [ ] **Step 1: Failing tests** — migration applies fresh; upsertPrint idempotent by eventId; insertDocument dedupe (`isNew:false`, no dup row); listUnparsedDocuments returns only `parsed_at IS NULL` and markDocumentParsed removes from it; upsertLines/getSheet round-trip incl. `expected_json`; accepted row survives upsertLines with only candidates_json refreshed; clearLineAccepted resets state; deleting the calendar_events row does NOT delete the print; acquireWatcherLease: fresh acquire true, second holder false while live, true after expiry, same holder renews.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): schema, types, store, watcher lease (migration 085)`.

### Task 2: Contract compiler + expected values

**Files:**
- Create: `lib/print-watch/contracts.ts`
- Test: `tests/print-watch/contracts.test.ts`

**Interfaces:**
- Consumes: `earnings_bogeys` schema (`lib/db/migrations/043_earnings_bogeys.sql`: per-source rows, `eps_consensus`, `eps_whisper`, `revenue_consensus_usd`, `revenue_whisper_usd`, `segment_breakdown_json` `{"Name":{"consensus":N,"whisper":M}}`, `guidance_notes`, `source_label`), Task 1 types.
- Produces: `export function compileContracts(db, eventId: number, symbol: string): { contracts: LineContract[]; expected: Record<string, ExpectedValue> }` — `expected` is the PARALLEL structure (Codex #22): bogey consensus/whisper per metric_id, for the panel's bogey column ONLY; it must never be passed to extraction.

Rules: always emit `eps_gaap_q` (gaap), `eps_adj_q` (non_gaap), `revenue_q`; `expected` maps `eps_adj_q` ← `eps_consensus`/`eps_whisper` (the user's bogeys are adjusted-basis by convention), `revenue_q` ← `revenue_consensus_usd`/whisper; per segment key: `seg_<slug>_revenue_q` with expected from the segment's consensus/whisper; when any row has guidance_notes: `revenue_guide_next` + `eps_adj_guide_next` (range, NQ_guide, definitions state "the UPDATED range if prior and updated appear side by side" — spec §9.5). Definitions NEVER contain values/disclosure hints; multiple bogey rows for one metric: first non-null by rowid wins, `source_label` carried into ExpectedValue.

- [ ] **Step 1: Failing tests** — seeded db: standard 3 + segment + guidance contracts present; `expected["revenue_q"].value` equals the seeded consensus and `expected` keys never appear serialized inside any contract definition (leak guard: no digit-run >4 in definitions); dedupe across rows.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): contracts + parallel expected values from bogeys`.

### Task 3: Representations (port)

**Files:**
- Create: `lib/print-watch/representations.ts`
- Modify: `scripts/spike-bakeoff-parse.ts` (import from the new module; delete local copies)
- Test: `tests/print-watch/representations.test.ts`

**Interfaces:**
- Consumes: `buildRepA` (HTML→normalized tables: colspan positional expansion, rowspan label repetition, indent from padding-left, 3-preceding-lines caption attach, empty row/col pruning) and the repB tag-strip (entities decoded, `<pre>` verbatim) inside `scripts/spike-bakeoff-parse.ts`.
- Produces: `export function htmlToTablesRepresentation(html: string): string`; `export function htmlToRawText(html: string): string` (pure).

- [ ] **Step 1: Failing tests** — inline HTML fixture (3×3 table w/ colspan header, split-cell `(7,604` `)` negative, preceding "(In thousands…)" paragraph): caption attached, colspan text in first spanned column, `<pre>` preserved in rawtext. Golden test vs `tests/fixtures/real/bakeoff/XMTR-2026-08-04/parse-input-repA.txt`/`repB.txt` (`existsSync`-guarded skip): byte-identical to the validated pilot outputs.
- [ ] **Step 2: Run** → FAIL. **Step 3: Port + rewire spike imports.** **Step 4: Run + `npx tsc --noEmit` clean for both files.**
- [ ] **Step 5: Commit** — `feat(print-watch): port validated representations from the bake-off spike`.

### Task 4: Extraction (port)

**Files:**
- Create: `lib/print-watch/extract.ts`
- Test: `tests/print-watch/extract.test.ts`

**Interfaces:**
- Consumes: Task 1 types; the spike's model call in `scripts/spike-bakeoff-parse.ts` (forced tool call, `additionalProperties:false`, no temperature, C0 retry, `resolveTier("workhorse", …)`); AI mocking pattern (`tests/securities/verify-sector-tags.test.ts`).
- Produces: `export async function extractCandidates(contracts: LineContract[], representationText: string, opts: { model?: string; anthropic?: AnthropicLike }): Promise<ParseCandidate[]>` (no db anywhere in this module).

Prompt rules carried from the spike + additions: normalize to contract units (thousands→dollars); parentheses negative; never guess/derive/compute; `not_disclosed` when absent; snippet verbatim ≤200 chars; **guidance lines take the UPDATED range when prior+updated coexist (spec §9.5 — new line, not in the spike prompt)**.

- [ ] **Step 1: Failing tests** — mocked client: candidates parse; malformed-then-valid retry; schema walk asserts `additionalProperties:false` everywhere; prompt contains the UPDATED-range rule; prompt contains NO expected values when called with contracts whose parallel expected exists (call signature makes this impossible — the test pins that `extractCandidates` has no expected param).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): extraction call ported from bake-off parser`.

### Task 5: Cross-document reconciler

**Files:**
- Create: `lib/print-watch/reconcile.ts`
- Test: `tests/print-watch/reconcile.test.ts`

**Interfaces:**
- Consumes: Task 1 types (`TaggedCandidate` with `doc_id`/`representation`/`weak_pair`).
- Produces: `export function reconcile(contracts: LineContract[], expected: Record<string, ExpectedValue>, all: TaggedCandidate[], acceptedLines: PrintWatchLine[]): PrintWatchLine[]` — takes EVERY candidate ever produced for the print (all documents, all representations — the caller passes the accumulated set) and computes the whole sheet in one pass (Codex #4: no per-document overwrites).

Rules (deterministic, tested branch-by-branch):
1. Per metric: collect value-candidates (not_disclosed=false) and ND-candidates.
2. **Agreement** = two candidates from INDEPENDENT sources (different `doc_id`, OR same doc different representation with `weak_pair=false`) matching on value (1e-6 relative), value_high, and table-provenance compatibility (both `location_hint`s naming `/table\s*(\d+)/i` must match numbers — only comparable within the same doc_id; cross-doc hints are always compatible) → `agreed`, value set, `source_doc_id` = the lowest doc_id among agreeing candidates, snippet from that candidate.
3. Value candidates exist but no independent agreement: exactly one value candidate (or only weak_pair-correlated duplicates agreeing) → `single_source` (renders "single source — verify", never green; Codex #3); two+ disagreeing → `conflict` (all candidates shown).
4. **Monotonic ND rule** (Codex #4): ND-candidates NEVER override value-candidates from another document — a doc that simply doesn't carry the line contributes nothing against a doc that does. All docs ND + ≥2 independent docs → `blank`; all ND but only one doc so far → `pending` (more sources may still land).
5. Flash candidates only → `flash`.
6. `acceptedLines` pass through untouched except candidates_json refresh (the store enforces too).
- Sign guard: a candidate whose value sign contradicts its own raw_text parenthesization is dropped as malformed (belt-and-braces).

- [ ] **Step 1: Failing tests** — every branch: cross-doc agreement (dj-release + edgar) → agreed; same-doc A/B agreement → agreed; weak_pair duplicates alone → single_source; the AMZN FCF 0.05% gap → conflict; table-hint mismatch same doc → conflict, cross-doc hints ignored; ND-from-supplement + value-from-release → the value survives (state per its own agreement level); all-ND two docs → blank, one doc → pending; flash-only → flash; accepted passthrough; sign-guard drop.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): cross-document monotonic reconciler`.

### Task 6: DJ adapter (port + quiescent stitch)

**Files:**
- Create: `lib/print-watch/dj-adapter.ts`
- Test: `tests/print-watch/dj-adapter.test.ts`

**Interfaces:**
- Consumes: raw-IBApi extraction precedent `lib/tws/wsh.ts` (shared app connection — NO second client id); `scripts/spike-print-tws-news.ts` for prefix strip / backward-walk windowing (first datetime = RECENT boundary; filter client-side) / part grouping by prefix containment / body fetch / flash detection. ReqId range 41000–41999 (verify no collision: `grep -rn "reqId" lib/tws/`).
- Produces:

```ts
export interface DjPollState { seenArticleIds: Set<string>; partGroups: Map<string, { headlines: string[]; articleIds: string[]; lastGrewAtMs: number }>; }
export interface DjPollOutput {
  completedReleases: Array<{ headline: string; stitchedText: string; partCount: number }>;
  flashes: Array<{ time: string; headline: string }>;
}
export async function pollDjNews(ib: IBApiLike, conId: number, windowStartUtc: string, nowUtc: string, state: DjPollState, nowMs: number): Promise<DjPollOutput>;
```

**Quiescence rule (Codex #5):** a part group is completed ONLY when its part set has not grown for ≥20,000ms (`nowMs - lastGrewAtMs`) — a 7-part release seen mid-burst waits for the next poll rather than stitching a fragment. Earnings-release filter: base headline must match `/results|quarter|fiscal|earnings/i` (HD "Express Delivery" distractor). Completed groups are removed from state (emit once).

- [ ] **Step 1: Failing tests** — fake IBApiLike replaying CRWD part headlines (from `dj-parts.json`, guarded, inline fallback): first poll sees 4 of 7 parts → nothing completed; second poll (+10s) adds 3 → still not quiescent; third poll (+20s, no growth) → one completed 7-part stitch in order; distractor excluded; flashes extracted; seen-dedupe.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): DJ adapter with quiescent multi-part stitch`.

### Task 7: EDGAR adapter (acceptance-window, 8-K + 6-K, all EX-99.*)

**Files:**
- Create: `lib/print-watch/edgar-adapter.ts`
- Test: `tests/print-watch/edgar-adapter.test.ts`

**Interfaces:**
- Produces:

```ts
export async function resolveCik(symbol: string, fetchFn?: FetchLike): Promise<string | null>; // via company_tickers.json, 10-digit padded
export interface EdgarFiling { accession: string; form: string; acceptanceDateTime: string; exhibits: Array<{ name: string; url: string; html: string }>; }
export async function pollEdgar(cik: string, windowStartIso: string, windowEndIso: string, seenAccessions: Set<string>, fetchFn?: FetchLike): Promise<EdgarFiling[]>;
```

**Selection (Codex #17 — no baseline lifecycle):** filings qualify by `form IN ('8-K','6-K')` (Codex #18) AND `acceptanceDateTime` within `[windowStartIso − 15min, windowEndIso]` AND not in `seenAccessions` (in-memory per watcher run; restart-safe because the time filter re-derives). Fetch ALL `EX-99.*` exhibits (spec §9.1). Every request: SEC User-Agent; caller provides spacing (Task 9's spacer).

- [ ] **Step 1: Failing tests** — mocked fetchFn: old 8-K (before window) excluded even with empty seen set; in-window 8-K AND 6-K both returned; both EX-99.1 + EX-99.2 fetched; UA header on every captured request; seen-dedupe on second poll; 10-K in window ignored.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): EDGAR acceptance-window adapter (8-K/6-K, all EX-99)`.

### Task 8: IR RSS adapter (NVDA, hardened)

**Files:**
- Create: `lib/print-watch/ir-rss-adapter.ts`
- Test: `tests/print-watch/ir-rss-adapter.test.ts`

**Interfaces:**
- Consumes: harness findings in `scripts/spike-print-timestamp-harness.ts`: `https://nvidianews.nvidia.com/cats/press_release.xml`, mandatory `?zz=<random>` cache-bust, `<modDate>` ordering, title regex `/NVIDIA Announces Financial Results for (First|Second|Third|Fourth) Quarter( and)? Fiscal 20\d\d/`.
- Produces: `export const IR_RSS_CONFIGS: IrRssConfig[]` (NVDA only); `export async function pollIrRss(cfg: IrRssConfig, seenLinks: Set<string>, fetchFn?: FetchLike): Promise<Array<{ title: string; link: string; html: string }>>`.

Hardening (Codex #24): `redirect:"manual"` — a 3xx is followed only after same-host revalidation of the Location (max 2 hops); `content-length` precheck AND streamed 2MB cap; content-type must be XML/HTML; item links only on the config host. RSS items via regex string extraction (no deps).

- [ ] **Step 1: Failing tests** — results item matched, "Sets Conference Call" distractor not; fresh `zz=` per request; cross-host redirect refused; same-host redirect followed once; 3MB stream truncated→rejected; seenLinks dedupe.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): hardened cache-busted IR RSS adapter (NVDA)`.

### Task 9: Watcher (leased, serialized, gated) + sweep nudge

**Files:**
- Create: `lib/print-watch/watcher.ts`
- Modify: `lib/calendar/email-sweep.ts` (add `ensurePrintWatch(db)` at the end of the sweep beside `alertBlockedRecaps` — read the file first)
- Test: `tests/print-watch/watcher.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8; armed flags via `lib/queries/earnings-worksheet-flags.ts` — **add a new query** `getArmedWorksheetEvents(db, dates: string[])` returning armed events REGARDLESS of `printed_at` (Codex #10: printed_at records physical printing, not disarming; the existing armed-unprinted query is the wrong filter), joined to calendar_events (id, symbol, event_date, event_time, raw_json fields `resolveEarningsReleaseTime` needs — read `lib/earnings/wire-times.ts:~330` for its exact input shape) and securities (`ib_con_id`); `resolveDbDir()`.
- Produces:

```ts
export interface ArmedEventDto { eventId: number; symbol: string; eventDate: string; conId: number | null; cik: string | null; releaseTimeEt: string; } // releaseTimeEt: resolveEarningsReleaseTime(...) ?? slot default (AMC→"16:15", BMO→"08:00" via the event's slot; deriveKnownSlot precedent) — never null past this DTO (Codex #19)
export function ensurePrintWatch(db: Database.Database): void; // idempotent reconciler, see behavior
export function getWatchStatus(db): Array<{ printId: number; symbol: string; state: PrintWatchState; sources: Record<string, string>; coverage: string[] }>; // coverage = static notes (Codex #23): "DJ: no conId — wire off" / "EDGAR: CIK unresolved" / "RSS: NVDA only" / "TWS offline" / "drop: HTML/text"
export async function ingestDocument(db, printId: number, kind: PrintWatchDocKind, source: string, url: string | null, buf: Buffer): Promise<{ docId: number; isNew: boolean }>;
export function _setTestSeams(seams: {...}): void; // adapters + extractCandidates + timers injection for tests
```

Behavior (each rule tested):
- **Lease (Codex #7):** `ensurePrintWatch` first calls `acquireWatcherLease(db, holder, now, 60_000)` (holder = `${process.pid}@${port}`); without the lease it returns without starting loops (status note "watcher owned by <holder>"). The running loop renews every 20s; renewal failure stops all loops.
- **Reconcile (Codex #11):** each `ensurePrintWatch` run diffs armed events vs prints: new armed → upsertPrint + compile (`upsertLines` pending + expected_json); no-longer-armed → `disarmed` + loops cancelled; past window-end → `expired` (a `parsed` print keeps state but loops stop).
- **Loops (Codex #8):** per print ONE serialized async loop (`while (live) { pollOnce(); await sleep(cadence) }`) — never setInterval; inside `pollOnce`, sources run sequentially (DJ→EDGAR→RSS) through the **per-host spacer** (module-level `lastRequestAt` map; SEC 300ms, others 200ms — Codex #21 minimal governor). DJ only when the app's TWS connection reports up (read how `lib/tws/client.ts` exposes state) else source note "tws offline". Cadence 10s in-window.
- **Burst:** a hit sets a flag that makes the loop immediately run one extra pollOnce.
- **Ingest queue (Codex #8):** documents queue per print; ONE pipeline runs at a time per print, in doc-id order.
- **Document-to-event gate (Codex #1):** before parsing, a document must pass `validateDocForEvent(text, dto)`: contains the symbol OR the issuer name (from securities.name, case-insensitive) AND a fiscal-period token derived from event_date quarter (accept both calendar "Q2 2026"/"second quarter" and the fiscal-label variants — the CRWD "Q1 FY2027" lesson: ALSO accept any "fiscal 20\d\d" + quarter-word combination when the symbol matches). EDGAR docs additionally already passed the acceptance-window filter. Failing docs are stored with source `"rejected:<reason>"` and never parsed (visible in status).
- **Pipeline:** representations (HTML → repA+repB; plain text → ONE extraction call tagged `weak_pair:false`, `representation:"repB"` — cross-document agreement is its only green path, per reconcile rule 3) → `extractCandidates` per representation → tag (`doc_id`, representation, weak_pair) → accumulate ALL candidates for the print (from candidates_json + new) → `reconcile` → `upsertLines` → `markDocumentParsed` → state `parsed`.
- **Crash recovery (Codex #6):** every loop tick also drains `listUnparsedDocuments`.
- **Flash lane:** DJ flashes accumulate; one `extractCandidates` over the joined flash text per new batch, tagged `representation:"flash"`; reconcile handles placement.
- Every loop body try/caught into per-source status strings.

- [ ] **Step 1: Failing tests** (fake timers + `_setTestSeams`) — lease excludes a second ensure (different holder) and its loops; arming creates print+lines+expected; disarm cancels; window open/expire transitions; serialized pollOnce (a slow fake adapter never overlaps itself); burst runs an extra poll; ingest queue order; gate rejects a wrong-symbol doc and stores the rejection; plain-text doc yields single_source (never agreed) until an EDGAR doc agrees cross-doc; unparsed-doc drained after simulated crash (insert without parse, then tick); DJ skipped with "tws offline" note when connection seam reports down.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement + sweep nudge (one line).** **Step 4: Run + `npx vitest run tests/calendar/` stays green.**
- [ ] **Step 5: Commit** — `feat(print-watch): leased serialized watcher with doc-event gate`.

### Task 10: Status (read-only GET) + ensure + drop routes

**Files:**
- Create: `app/api/print-watch/status/route.ts`, `app/api/print-watch/ensure/route.ts`, `app/api/print-watch/drop/route.ts`
- Test: `tests/api/print-watch-routes.test.ts`

**Interfaces:**
- Consumes: Task 9 + store; route test pattern `tests/api/notes-route.test.ts`.
- Produces: `GET /status` → `{success:true, data:{prints:[{printId, symbol, state, sources, coverage, lines}]}}` — **pure read** (getWatchStatus + getSheet only; NO ensure call — Codex #9, the repo's no-state-changing-GET scan). `POST /ensure` (empty body) → runs `ensurePrintWatch` → `{success:true, data:{prints: <count>}}`. `POST /drop` `{eventId, filename, contentBase64}` → precheck: base64 length ≤ 14MB BEFORE decode (≈10MB binary — Codex #24), magic-byte sniff (HTML/`<`, plain text, PDF rejected in v1 with the domain-language error naming ⌘S-the-IR-page), → `ingestDocument(kind:"user-drop")`.
- Verify `grep print-watch lib/auth/route-policy.ts` → empty (all default human).

- [ ] **Step 1: Failing tests** — status returns seeded sheet and calls NO watcher mutator (spy asserts); status route source scanned for `ensure` token absence (mirror the repo's static-scan style); ensure POST triggers the (mocked) watcher; drop: valid HTML ingests; oversized base64 400s BEFORE decode (spy on decode); PDF magic bytes → the ⌘S message; envelope shapes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run + `npx vitest run tests/api/no-state-changing-get.test.ts`** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): read-only status + ensure + hardened drop routes`.

### Task 11: Accept / unaccept + atomic pair promotion

**Files:**
- Create: `app/api/print-watch/accept/route.ts`
- Test: `tests/api/print-watch-accept.test.ts`

**Interfaces:**
- Consumes: store (`markLineAccepted`, `clearLineAccepted`, `getSheet`); `saveManualActuals(db, {eventId, epsActual, revenueActualUsd, force})` (`lib/earnings/actuals.ts` — stamps `manual_actuals_at`; 409 `pre_print` behind the floor).
- Produces: `POST /api/print-watch/accept` body `{eventId, accept?: string[], unaccept?: string[], promoteHeadline?: boolean, force?: boolean}`.

Rules: **validate the ENTIRE request first, then apply in one better-sqlite3 transaction** (Codex #14) — any invalid metric (state `conflict`/`pending`/unknown for accept) → 400 naming it, nothing written. Unaccept clears accepted state (Codex #15 — the re-verify path; the panel's "superseded — re-verify" flow is unaccept → fresh reconcile → re-accept). `promoteHeadline` requires a COMPLETE pair — an accepted EPS (adj preferred, else gaap; response + UI name the basis) AND an accepted `revenue_q` — else 400 explaining that a partial promote would merge with possibly-stale existing values (Codex #13: `mergeFinnhubActual` keeps existing fields). Promotion calls `saveManualActuals` with both values; `pre_print` 409 passes through with its code for the confirm-retry.

- [ ] **Step 1: Failing tests** — atomicity (one bad metric → zero rows changed, spy on saveManualActuals never called); unaccept round-trip; pair rule (EPS-only accepted + promoteHeadline → 400 with the stale-merge explanation); adj-over-gaap preference and basis named in response; pre_print passthrough; envelope shapes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print-watch): transactional accept/unaccept + complete-pair promotion`.

### Task 12: PrintWatchPanel UI

**Files:**
- Create: `app/dashboard/today/PrintWatchPanel.tsx`
- Modify: `app/dashboard/today/page.tsx` (mount near EarningsHub — read for the slot)
- Test: `tests/dashboard/print-watch-panel.test.ts`

**Interfaces:**
- Consumes: `GET /api/print-watch/status` poll (2s while any print is in `window_open`/`acquired`, 30s otherwise, stop when none active today); `POST /ensure` on mount + every 60s (this is what keeps the watcher alive while the user watches — CSRF via `apiFetch`); `POST /drop`; `POST /accept`. UI kit: `<Chip>`, tokens, EarningsHub visual precedent; `<PrivateText>` for bogey-column values (portfolio-derived), plain `formatLargeUSD`/`toFixed` for press-release actuals (public).
- Produces: per print: header (symbol, state, coverage notes line, per-source ladder), sheet table: **metric | bogey (expected.value + whisper, PrivateText-wrapped, "—" when null) | actual | Δ vs bogey (plain sign+percent when both sides exist) | state chip (TEXT labels: "agreed — verify" / "single source — verify" / "conflict" / "wire flash" / "not disclosed" / "accepted" / "superseded — re-verify") | snippet expander**. Conflict rows list all candidates with their source doc kind. Flash rows dashed-border. Drop target (file input + onDrop → base64 → drop route). Actions: "Accept all agreed" then "Promote EPS+Rev (adj $X.XX · $N)" confirm (disabled without the complete pair, title explains); per-line unaccept on accepted rows; every action honest-button compliant.
- Export pure helpers: `ladderText(sources)`, `promoteSummary(lines)` (null unless complete pair; carries basisLabel), `needsReverify(line)` (accepted value vs freshest independent agreement in candidates_json), `deltaPct(expected, actual)`.

- [ ] **Step 1: Failing tests** — `promoteSummary` complete-pair rule + adj preference + basisLabel; `needsReverify` true only on divergence; `deltaPct` sign/null handling; `ladderText` formatting.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement + mount.** **Step 4: Run + `npm run verify:smoke`.**
- [ ] **Step 5: Commit** — `feat(print-watch): live sheet panel with bogey comparison`.

### Task 13: Replay tests (synthetic committed + real-corpus guarded)

**Files:**
- Create: `tests/fixtures/print-watch/synthetic-release.html` (COMMITTED — a fictional company "Synthex Corp" quarterly release: an EPS/revenue table in thousands, one segment table, a guidance range, a deliberately absent metric; NO real company data)
- Test: `tests/print-watch/replay.test.ts`

Two suites (Codex #26): (1) ALWAYS-RUN synthetic: seed event+bogeys → compile → ingest synthetic HTML via `ingestDocument` with mocked `extractCandidates` returning hand-written candidates for repA/repB → lines reach agreed/blank correctly → accept + promote writes `calendar_events.actual_value` "EPS X.XX · Rev N" → then a MODIFIED synthetic doc (one changed value) ingests → accepted line flags `needsReverify` data → unaccept → re-accept new value. Also: restart-after-insert (insert doc, skip pipeline, drain via watcher tick). (2) GUARDED real-corpus: CRWD documents + recorded `parse-repA/B.json` candidates (skip when the gitignored corpus is absent) — asserts the pilot's agreed metrics green through the production path.

- [ ] **Step 1: Write both.** **Step 2: Run** → PASS against Tasks 1–11. **Step 3: Commit** — `test(print-watch): synthetic + real-corpus replays through the production pipeline`.

### Task 14: Rehearsal + deploy gate (orchestrator-run, not a subagent)

- [ ] Full suite green + `npx next build` green.
- [ ] Live rehearsal (dev :3000, TWS up): arm TWO worksheets (concurrency), ensure via panel, drop the synthetic release for one + CRWD's `edgar-ex99-1.htm` for the other, watch both sheets fill; kill and restart the dev server mid-watch (recovery); verify lease behavior by hitting ensure from a second process; accept + promote on the synthetic event; then CLEAR via the clear-actuals control so no synthetic actuals persist. Browser E2E via agent-browser with screenshots.
- [ ] `docs/reference/earnings-pipeline.md`: add "Print-watch v1" section (trigger flow, storage location under resolveDbDir, promote path, lease, known v1 limits incl. PDF-drop absence + accepted deviations).
- [ ] Electron deploy; verify the packaged app owns the lease and serves the panel; confirm dev server is stopped afterward (single owner on print night).

## Execution notes

- Order: Task 1 → {2, 3, 6, 7, 8} parallel → {4, 5} parallel → 9 → {10, 11, 12} parallel → 13 → 14.
- Wednesday runbook: arm NVDA + CRWD worksheets Tuesday; TWS running Wednesday 15:45; packaged app open on Today (its ensure poll owns the lease); harness runs alongside for measurement; user verifies each line before accept; promote only after the numbers check out.
