# Live Print v2 — Slice A Implementation Plan (armed-as-covered + cloud parity + registries + prepare steps)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An armed earnings worksheet makes its event *covered* everywhere a held name's event is covered — on the Mac and in the Cloudflare Worker fallback — and arming kicks off the preparation a held name gets for free (newsletter bogey rescan, vendor consensus row, intel, IBKR contract id), with date corrections carrying every piece of that state to the surviving event.

**Architecture:** Coverage becomes an event fact (`isEventArmed`) with a display-only `armed` symbol status; every selection consumer in the spec's matrix switches to `coveredForEvents`. Cloud parity rides a local `cloud_outbox` table drained to a new Worker endpoint that keeps a generation-watermarked KV delta the Worker merges over snapshot v11. Two registries (`registerEventMergeHandler`, `registerPrepareStep`) are the only contact points slice B uses; A ships their implementations plus its own handlers and steps.

**Tech Stack:** TypeScript / Next.js App Router (thin routes over `lib/`), better-sqlite3 (DI `db` param, in-memory tests), Cloudflare Worker (`workers/cron/`, separate vitest project), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-live-print-v2-design.md` §4.1, §5 (088), §6, §7, §8 A-line, §10. Cross-slice contract: the registry signatures below are copied VERBATIM from the contract both plans share; slice B's plan quotes the same text.

**Worktree:** sibling `../vanguard-skin-v2-a`, branch `live-print-v2-a`. A never edits `lib/print-watch/*`, `lib/db/migrate.ts`, or `app/dashboard/today/*` beyond the one `EarningsHub.tsx` chip change listed in Task 5 (spec §10 gives `app/dashboard/today/*` to F; the chip is a two-line display change on a file B never touches — recorded as accepted deviation D3).

## Deviations and settled mechanics (recorded before implementation; each gets a Codex look in the plan round)

- **D1 — vendor EPS never enters `eps_consensus`.** `compileContracts` (`lib/print-watch/contracts.ts:119-133`, a B/F file) fills the adjusted-EPS expected value with the first non-null `eps_consensus` by rowid. A therefore stores the Finnhub EPS in a NEW column `earnings_bogeys.eps_consensus_vendor` and leaves `eps_consensus` NULL on the `'finnhub'` row. The ruling ("Finnhub EPS never fills the adjusted-EPS bogey") holds by construction with zero edits to `lib/print-watch/*`. The spec's `eps_consensus_basis` column is NOT added; snapshot v11 bogey rows carry `eps_consensus_vendor`; every surface that renders it labels it "vendor, basis unspecified". Task 12 records this in the spec and `DECISIONS.md`.
- **D2 — the Mac never talks to KV directly.** Every Mac↔Worker marker today goes through `WORKER_MARKER_URL` `/internal/*` with `X-Cron-Secret` (`lib/cron/earnings-marker-check.ts:25`). The outbox sender POSTs to a new `/internal/armed-events`; the Worker handler does the read-compare-write on KV key `armed-events`. The generation guard lives Worker-side.
- **D3 — `EarningsHub.tsx` chip.** Two lines in `statusChipClass` / `statusChipLabel` so the new `armed` status renders (spec matrix row "display: armed chip"). No layout change.
- **D4 — `refreshEarningsIntel` does not exist.** The `intel` step calls the real entry point `ensureIntelForEvents(db, [event])` (`lib/earnings/intel.ts:115`).
- **D5 — Worker `calendar-enrich.ts` event list reads the effective collection; its push gate is untouched.** The Worker's recap road reads actuals that `calendar-enrich` produced, so an armed manual add must be enrichable in the cloud for the cloud recap to exist. The push gate at `calendar-enrich.ts:356-364` keeps held/watchlist/read-through exactly.
- **D6 — the arm route kicks the prepare pass without awaiting it, and durability lives in the sweep.** `newsletter_rescan` makes model calls (tens of seconds). The route enqueues, kicks `runPrepareSteps` with `.catch(console.warn)`, and returns the enqueued rows. Durability does NOT depend on that kick: every sweep tick first reconciles `earnings_prepare_steps` (inserts any missing registered step for every armed, unsuperseded, not-yet-past event, `ON CONFLICT DO NOTHING`) and only then claims work — so an armed event with no rows (crash between arm and enqueue, or a step registered after the arm) is picked up within one tick (Codex round 1, finding 10).
- **D7 — tombstone retention (revised after Codex round 1, finding 7).** A `removed: true` entry carries `removedAt` (ISO) and is kept in every later payload while `event_date >= todayET() − 2` OR `removedAt` is younger than 48 hours. The nightly snapshot always lands inside that 48-hour window, so a removal is never dropped from the delta before a snapshot that omits the event exists. Every path that un-arms writes the row: `disarmWorksheet`, `deleteCalendarEvent` on an armed row, and the merge callers.
- **D8 — `armWorksheet` / `disarmWorksheet` gain an IMMEDIATE transaction** (flag row + outbox row, atomic, generation allocated under the write lock — finding 9). They stay pure mutations: step rows are inserted by the route (fast path) and reconciled by every sweep tick (durable path, D6).
- **D9 — snapshot builder testability.** `scripts/snapshot-state-to-r2.ts` calls `main()` unconditionally at import, so the projection + generation read move to `lib/earnings/armed-events-projection.ts` and the script imports them; tests target the lib module AND the script's transaction is exercised by a test that opens a file-backed copy read-only and asserts `armedGeneration` equals the outbox maximum observed inside the same transaction.
- **D10 — no-op outbox rows are skipped (finding 13, 16a).** `writeArmedEventsOutboxRow` compares the freshly built entries with the previous payload's entries; when identical it writes nothing and returns `{ generation: <previous>, written: false }`. A manual add (never armed yet) and an unarmed manual edit therefore write nothing; a correction writes at most one row per outer transaction. The spec's "every mutation inserts a row" becomes "every mutation that changes the armed projection inserts a row".
- **D11 — worksheet route envelope stays backward compatible.** The existing top-level `armed` / `disarmed` fields remain (the Today client reads them); the new fields ride under `data: { enqueued, prepare }`. Full `{success, data}` conformance is a Slice F change on the client.

## Codex round 1 (2026-09-02 evening) — verdict REVISE, 19 findings

Adopted (folded into the tasks below, each marked `[C-n]`): 2 (Finnhub symbol validation + withdrawal), 3 (issue-dated newsletter labels), 4 (keep the shared repointer intact), 5 (email/skip audit merge with no-refire), 6 (bogey provenance travels with the winning values), 7 (D7 revised; delete path writes a tombstone), 9 (IMMEDIATE transactions + two-connection test), 10 (sweep reconciles missing steps), 11 (attempts counted at takeover; resets never clear a live claim; side effects are idempotent upserts by construction), 12 (prepare-step rank lattice; moved rows re-fingerprint against the target), 13 (one outbox row per outer transaction, only when changed), 14 (self-bootstrapping registries through one composition root + cold-process test; aligned with slice B's M3), 15 (per-row digest rehearsal + order-independence test), 16 (D10/D11 recorded; intel fingerprint uses `release_time`), 17 (in-window siblings; push-gate, read-through, Hub, Worker-consumer, provenance tests), 18 (local Worker E2E via `wrangler dev`; deterministic extractor for the secretless sandbox is impossible over HTTP, so the model path is proven by unit tests plus one supervised live arm after deploy; first v11 snapshot uploaded right after the Worker deploy), 19 (synthetic issuers/labels/figures in every committed example; strict allowlisted parse + size cap on the Worker endpoint).

Partially adopted: 8 — Cloudflare KV has no compare-and-swap and this Worker has no Durable Object; the Mac is the ONLY writer and now serialises its drains through an in-process mutex (Task 6), so two in-flight generations from one process cannot cross. The Worker keeps the read-compare-write as defense in depth. Residual: two Mac processes with Worker credentials draining at once (not a supported deployment) could still cross; documented, not solved.

Disputed — needs the user's ruling: 1 (D1). Codex asks for the spec's `eps_consensus_basis` column plus a basis filter in `compileContracts`. That filter is a three-line change in `lib/print-watch/contracts.ts`, a slice B/F file, and §2/§10 rule that A and B share no file. Options: (a) keep D1 as written (vendor figure in its own column; the ruling holds by construction; Codex's "renderers cannot label" is addressed because a non-null `eps_consensus_vendor` IS the label condition); (b) the user relaxes the no-shared-file rule for exactly that three-line filter, and the plan reverts to the spec's basis column. **RULED by the user, 2026-09-02 late evening: (a) — D1 stands; the no-shared-file rule is not relaxed.** Task 12 records it in the spec and `DECISIONS.md` (already appended at ruling time).

## Global Constraints

- Never hardcode a model id — `resolveFeatureModel(key)` / `generateTextForFeature(key, …)` via the registry (`lib/ai/models.ts`). The rescan reuses feature key `newsletterBogeyExtraction`.
- Every DB function takes `db: Database.Database` first. Route envelope `{success:true,…}` / `{success:false,error}`; routes thin; `/api/earnings/*` and `/api/calendar/*` are human routes (no cron auth). GET routes are read-only (`tests/api/no-state-changing-get.test.ts`).
- ET day math only: `todayET()`, `addDays()` from `lib/calendar/date-utils.ts`. Never `toISOString().slice(0,10)` for a user-facing or window-defining date. Worker mirror: `workers/cron/src/dst.ts::todayET`.
- Compare timestamps with `datetime()` on both sides.
- Mac↔Worker mirrors are parity-pinned: the resolver, the projection shape, and the chip label change on both sides in the same task, with a parity test.
- Outbound email stays direction-only; nothing in this slice adds numbers to an email.
- No new npm dependencies. Node via `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Tests: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <paths>`; Worker tests: `cd workers/cron && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <paths>`.
- Commits: write the message to a temp file, `git commit <paths…> -F <tempfile>` — pathspec commits only (a bare `git commit` sweeps a sibling worktree's staged files). Never `git stash`.
- Migration 088 is A's; 089 is B's. The runner sorts by filename, so either may land first.

## Registry contract (verbatim; slice B quotes the same block)

```ts
// lib/earnings/event-merge.ts
import type Database from "better-sqlite3";

export interface EventMergeContext {
  db: Database.Database;
  donorEventId: number;
  targetEventId: number;
}

export interface EventMergeTableResult {
  table: string;
  moved: number;
  merged: number;
  deleted: number;
  notes: string[];
}

/** SYNCHRONOUS. Runs INSIDE the caller's db.transaction (correctEarningsEventDate /
 *  reconcileEarningsDates). SQL only — no awaits, no network, no model calls. */
export type EventMergeHandler = (ctx: EventMergeContext) => EventMergeTableResult[];

/** Throws on a duplicate name. Handlers run in registration order, after A's built-in rules. */
export function registerEventMergeHandler(name: string, handler: EventMergeHandler): void;
export function listEventMergeHandlers(): string[];
export function __resetEventMergeHandlersForTests(): void;

export interface EventMergeReport {
  donorEventId: number;
  targetEventId: number;
  handlers: Array<{ name: string; tables: EventMergeTableResult[] }>;
}

/** Runs A's built-in table rules, then every registered handler. Returns `changed`; the
 *  CALLER writes one cloud_outbox 'armed-events' row per outer transaction when changed
 *  (Codex round 1, finding 13). Must be called inside an open transaction, BEFORE the
 *  donor calendar_events row is deleted (flags cascade on delete). */
export function mergeEarningsEventState(
  db: Database.Database,
  donorEventId: number,
  targetEventId: number,
): EventMergeReport;
```
(`EventMergeReport` gains `changed: boolean` — additive; slice B's handler signature is unaffected.)

```ts
// lib/earnings/prepare-armed-event.ts
import type Database from "better-sqlite3";

export type PrepareStepStatus = "pending" | "claimed" | "done" | "failed";

export type PrepareStepOutcome =
  | { status: "done"; note?: string }
  /** Precondition not met (e.g. TWS down). NOT an attempt: attempts is not incremented. */
  | { status: "pending"; reason: string }
  /** Counts as an attempt; retried on later ticks up to 5 attempts. */
  | { status: "failed"; error: string };

export interface PrepareStepContext {
  now: () => number;
}

export interface PrepareStepDefinition {
  /** Pure, synchronous. Hash of the step's inputs; a change resets the row to pending. */
  fingerprint: (db: Database.Database, eventId: number) => string;
  run: (db: Database.Database, eventId: number, ctx: PrepareStepContext) => Promise<PrepareStepOutcome>;
}

/** Throws on a duplicate name. */
export function registerPrepareStep(name: string, def: PrepareStepDefinition): void;
export function listPrepareSteps(): string[];
export function __resetPrepareStepsForTests(): void;

/** sha256 hex of JSON.stringify(parts). Used by every step's fingerprint. */
export function stableHash(parts: unknown[]): string;

/** One pending row per registered step, ON CONFLICT DO NOTHING. Returns rows inserted. */
export function enqueuePrepareSteps(db: Database.Database, eventId: number): number;

export interface PrepareStepRow {
  event_id: number;
  step: string;
  status: PrepareStepStatus;
  input_fingerprint: string | null;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}
export function getPrepareStepRows(db: Database.Database, eventId: number): PrepareStepRow[];

export interface PrepareRunReport {
  ran: number;
  done: number;
  pending: number;
  failed: number;
  skipped: number;
}
/** Claims with a fresh token (CAS), runs, finalises by CAS on the token. */
export async function runPrepareSteps(
  db: Database.Database,
  opts?: { eventId?: number; now?: () => number },
): Promise<PrepareRunReport>;
```

## File Structure

```
lib/db/migrations/088_live_print_v2_slice_a.sql        # 3 tables + earnings_bogeys rebuild (Task 1)
lib/queries/earnings-bogeys.ts                          # + 'finnhub' source, eps_consensus_vendor (Task 1)
lib/mutations/earnings-bogeys.ts                        # + eps_consensus_vendor column (Task 1)
lib/queries/earnings-worksheet-flags.ts                 # + isEventArmed, getArmedEventIds, getArmedSymbolsInHorizon (Task 2)
lib/queries/briefing-symbols.ts                         # + 'armed', getSymbolStatusDetailed, coveredForEvents (Task 2)
lib/calendar/enrichment-runner.ts                       # ET day math + coveredForEvents (Tasks 3, 4)
lib/calendar/wire-probe.ts                              # ET day math + coveredForEvents (Tasks 3, 4)
lib/transcripts/same-day.ts                             # ET day math + armed symbol (Tasks 3, 5)
lib/earnings/extract-newsletter-bogeys.ts               # coveredForEvents + per-event pure path (Tasks 4, 11)
lib/earnings/bogeys-reminder.ts                         # coveredForEvents (Task 4)
lib/calendar/verify-earnings-dates.ts                   # coveredForEvents (Task 4)
lib/earnings/wrap.ts                                    # coveredForEvents (Task 4)
lib/earnings/debrief.ts                                 # coveredForEvents (Task 4)
lib/queries/earnings-cockpit.ts                         # coveredForEvents (Task 4)
lib/digest/todays-reporters.ts                          # 'armed' chip (Task 5)
lib/digest/call-transcripts.ts                          # armed symbol counts (Task 5)
app/dashboard/today/EarningsHub.tsx                     # 'armed' chip class/label (Task 5, D3)
tests/repo/symbol-status-consumers.test.ts              # allowlist guard (Task 5)
lib/earnings/armed-events-projection.ts                 # projection + tombstones + generation read (Task 6)
lib/earnings/cloud-outbox.ts                            # writeArmedEventsOutboxRow + drainCloudOutbox (Task 6)
lib/mutations/earnings-worksheet-flags.ts               # arm/disarm write the outbox row in a txn (Task 6)
lib/mutations/calendar.ts                               # manual add/edit/correction write the outbox row (Tasks 6, 7)
lib/earnings/event-merge.ts                             # registry + built-in rules (Task 7)
lib/calendar/reconcile-earnings-dates.ts                # calls mergeEarningsEventState (Task 7)
scripts/snapshot-state-to-r2.ts                         # v11: armedEvents, armedGeneration, vendor EPS (Task 8)
workers/cron/src/state.ts                               # v11 types (Task 8)
workers/cron/src/armed-events.ts                        # effectiveCalendarEvents resolver (Task 8)
workers/cron/src/index.ts                               # POST /internal/armed-events (Task 8)
workers/cron/src/fallback-earnings.ts                   # two filters → resolver (Task 8)
workers/cron/src/todays-reporters.ts                    # resolver + 'armed' chip (Task 8)
workers/cron/src/calendar-enrich.ts                     # event list → resolver, push gate untouched (Task 8, D5)
lib/earnings/prepare-armed-event.ts                     # registry + runner (Task 9)
app/api/earnings/worksheet/route.ts                     # arm enqueues + kicks; GET returns step rows (Task 9)
lib/calendar/email-sweep.ts                             # drainCloudOutbox + runPrepareSteps hooks (Tasks 6, 9)
lib/earnings/prepare-steps/consensus-row.ts             # step (Task 10)
lib/earnings/prepare-steps/intel.ts                     # step (Task 10)
lib/earnings/prepare-steps/con-id.ts                    # step (Task 10)
lib/earnings/prepare-steps/newsletter-rescan.ts         # step + scan ledger (Task 11)
lib/earnings/prepare-steps/index.ts                     # registers the four A steps (Task 10/11)
docs/DECISIONS.md, docs/superpowers/specs/…v2-design.md, docs/reference/earnings-pipeline.md, docs/plans/TODO.md  (Task 12)
```

---

### Task 1: Migration 088 — prepare steps, scan ledger, cloud outbox, bogeys rebuild

**Files:**
- Create: `lib/db/migrations/088_live_print_v2_slice_a.sql`
- Modify: `lib/queries/earnings-bogeys.ts:3-24` (source union + row field + SELECT list)
- Modify: `lib/mutations/earnings-bogeys.ts:4-66` (input field, `CONTENT_COLUMNS`, `INSERT_SQL`)
- Test: `tests/db/migration-088-live-print-v2-a.test.ts`, `tests/mutations/earnings-bogeys.test.ts` (extend)

**Interfaces:**
- Consumes: migration runner convention (`lib/db/migrate.ts` — `.sql`, one transaction per file), rebuild precedent `069_earnings_intel_check_constraints.sql`.
- Produces: tables `earnings_prepare_steps`, `earnings_bogey_scans`, `cloud_outbox`; `earnings_bogeys.source` accepts `'finnhub'`; columns `eps_consensus_vendor REAL`, `extra_metrics_json TEXT` (F uses the latter; carried now so the table is rebuilt once). `EarningsBogeySource` gains `"finnhub"`; `UpsertBogeyInput.eps_consensus_vendor?: number | null`.

- [ ] **Step 1: Write the failing migration test**

```ts
// tests/db/migration-088-live-print-v2-a.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

/** Authoring-time column list of the rebuilt table. The migration's INSERT…SELECT
 *  copies exactly the first 18 of these (the pre-088 columns, in this order). */
const EXPECTED_BOGEY_COLUMNS = [
  "id", "event_id", "source", "source_label", "source_url", "raw_pdf_r2_key",
  "research_document_id", "research_article_id", "eps_consensus", "eps_whisper",
  "revenue_consensus_usd", "revenue_whisper_usd", "segment_breakdown_json",
  "guidance_notes", "notes", "uploaded_at", "ai_extraction_model", "expected_move_pct",
  "eps_consensus_vendor", "extra_metrics_json",
];

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("migration 088: live print v2 slice A", () => {
  it("creates the three new tables with their primary keys", () => {
    const db = fresh();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["earnings_prepare_steps", "earnings_bogey_scans", "cloud_outbox"]));
    const pk = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk("earnings_prepare_steps")).toEqual(["event_id", "step"]);
    expect(pk("earnings_bogey_scans")).toEqual(["event_id", "article_id", "extractor_version"]);
    expect(pk("cloud_outbox")).toEqual(["id"]);
  });

  it("rebuilds earnings_bogeys with exactly the authoring-time column list, in order", () => {
    const db = fresh();
    const cols = (db.prepare(`PRAGMA table_info(earnings_bogeys)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(EXPECTED_BOGEY_COLUMNS);
  });

  it("accepts source 'finnhub' and still rejects an unknown source", () => {
    const db = fresh();
    db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-03','x','k1','BETA')`).run();
    const insert = (source: string) =>
      db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (1, ?, 'lbl')`).run(source);
    expect(() => insert("finnhub")).not.toThrow();
    expect(() => insert("bogus")).toThrow(/CHECK/);
  });

  it("preserves ids, values, the UNIQUE key, and both indexes across the rebuild", () => {
    // Run every migration up to 087, seed, then apply 088 alone.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = path.join(process.cwd(), "lib", "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "088_")) db.exec(fs.readFileSync(path.join(dir, f), "utf-8"));
    db.prepare(`INSERT INTO calendar_events (id, source, event_type, event_date, title, source_key, symbol) VALUES (7,'finnhub','earnings','2026-09-03','x','k7','BETA')`).run();
    db.prepare(`INSERT INTO earnings_bogeys (id, event_id, source, source_label, eps_consensus, revenue_consensus_usd, expected_move_pct) VALUES (42, 7, 'manual', 'desk', 1.25, 1e9, 6.5)`).run();
    db.exec(fs.readFileSync(path.join(dir, files.find((f) => f.startsWith("088_"))!), "utf-8"));
    const row = db.prepare(`SELECT id, event_id, source, source_label, eps_consensus, revenue_consensus_usd, expected_move_pct, eps_consensus_vendor, extra_metrics_json FROM earnings_bogeys`).get() as Record<string, unknown>;
    expect(row).toEqual({ id: 42, event_id: 7, source: "manual", source_label: "desk", eps_consensus: 1.25, revenue_consensus_usd: 1e9, expected_move_pct: 6.5, eps_consensus_vendor: null, extra_metrics_json: null });
    expect(() => db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (7,'manual','desk')`).run()).toThrow(/UNIQUE/);
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='earnings_bogeys'`).all() as { name: string }[]).map((r) => r.name).sort();
    expect(idx).toEqual(["idx_earnings_bogeys_event", "idx_earnings_bogeys_uploaded"]);
    // FK still cascades from calendar_events.
    db.prepare(`DELETE FROM calendar_events WHERE id = 7`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 0 });
  });

  it("[C-15] applies cleanly when a later-numbered migration (slice B's 089) was recorded first", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = path.join(process.cwd(), "lib", "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
    for (const f of files.filter((f) => f < "088_")) {
      db.exec(fs.readFileSync(path.join(dir, f), "utf-8"));
      db.prepare(`INSERT INTO schema_migrations (filename) VALUES (?)`).run(f);
    }
    // Pretend 089 (a .ts migration on B's branch) already ran: the runner keys on filename, not order.
    db.prepare(`INSERT INTO schema_migrations (filename) VALUES ('089_print_watch_document_identity.ts')`).run();
    runMigrations(db);
    const applied = (db.prepare(`SELECT filename FROM schema_migrations ORDER BY id`).all() as { filename: string }[]).map((r) => r.filename);
    expect(applied.filter((f) => f.startsWith("088_"))).toHaveLength(1);
    expect(applied).toContain("089_print_watch_document_identity.ts");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('earnings_prepare_steps','earnings_bogey_scans','cloud_outbox')`).get()).toEqual({ n: 3 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/migration-088-live-print-v2-a.test.ts`
Expected: FAIL — `earnings_prepare_steps` missing; column list mismatch.

- [ ] **Step 3: Write the migration**

```sql
-- 088: live print v2, slice A (spec 2026-09-02 §4.1, §5).
-- Armed-as-covered needs: a prepare work table, a per-article scan ledger, a
-- cloud outbox for the Worker delta, and an earnings_bogeys rebuild that admits
-- the 'finnhub' consensus row. Deviation D1: the vendor EPS lives in its own
-- column so compileContracts (first non-null eps_consensus by rowid) can never
-- fill the adjusted-EPS expected value from a vendor figure.

CREATE TABLE earnings_prepare_steps (
  event_id          INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  step              TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','claimed','done','failed')),
  input_fingerprint TEXT,
  claim_token       TEXT,
  claimed_at        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, step)
);

CREATE TABLE earnings_bogey_scans (
  event_id          INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  article_id        INTEGER NOT NULL REFERENCES research_articles(id) ON DELETE CASCADE,
  extractor_version INTEGER NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('claimed','hit','no_numbers','error')),
  claim_token       TEXT,
  model_id          TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  scanned_at        TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, article_id, extractor_version)
);

CREATE TABLE cloud_outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,
  generation   INTEGER NOT NULL,
  payload_json TEXT    NOT NULL,
  written_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT,
  send_error   TEXT,
  UNIQUE (kind, generation)
);
CREATE INDEX idx_cloud_outbox_unsent ON cloud_outbox(kind, sent_at, generation);

-- earnings_bogeys rebuild (precedent: 069). Explicit column list, ids preserved.
CREATE TABLE earnings_bogeys_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('pdf_upload', 'manual', 'newsletter', 'finnhub')),
  source_label TEXT,
  source_url TEXT,
  raw_pdf_r2_key TEXT,
  research_document_id INTEGER REFERENCES research_documents(id),
  research_article_id INTEGER REFERENCES research_articles(id),
  eps_consensus REAL,
  eps_whisper REAL,
  revenue_consensus_usd REAL,
  revenue_whisper_usd REAL,
  segment_breakdown_json TEXT,
  guidance_notes TEXT,
  notes TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_extraction_model TEXT,
  expected_move_pct REAL,
  eps_consensus_vendor REAL,
  extra_metrics_json TEXT,
  UNIQUE(event_id, source, source_label)
);
INSERT INTO earnings_bogeys_new (
  id, event_id, source, source_label, source_url, raw_pdf_r2_key,
  research_document_id, research_article_id, eps_consensus, eps_whisper,
  revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json,
  guidance_notes, notes, uploaded_at, ai_extraction_model, expected_move_pct
)
SELECT
  id, event_id, source, source_label, source_url, raw_pdf_r2_key,
  research_document_id, research_article_id, eps_consensus, eps_whisper,
  revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json,
  guidance_notes, notes, uploaded_at, ai_extraction_model, expected_move_pct
FROM earnings_bogeys;
DROP TABLE earnings_bogeys;
ALTER TABLE earnings_bogeys_new RENAME TO earnings_bogeys;
CREATE INDEX idx_earnings_bogeys_event ON earnings_bogeys(event_id);
CREATE INDEX idx_earnings_bogeys_uploaded ON earnings_bogeys(uploaded_at DESC);
```

- [ ] **Step 4: Thread the new column through the bogey read and write modules**

`lib/queries/earnings-bogeys.ts`:

```ts
export type EarningsBogeySource = "pdf_upload" | "manual" | "newsletter" | "finnhub";
// in EarningsBogey (after expected_move_pct):
  /** Vendor EPS consensus (Finnhub), basis unspecified. NEVER the adjusted-EPS bogey (D1). */
  eps_consensus_vendor: number | null;
```
and add `eps_consensus_vendor` to the SELECT list of `getBogeysForEvent` (line ~37) right after `expected_move_pct`.

`lib/mutations/earnings-bogeys.ts`:

```ts
// UpsertBogeyInput, after expected_move_pct:
  /** Vendor EPS consensus (Finnhub). Stored apart from eps_consensus by design (D1). */
  eps_consensus_vendor?: number | null;
```
Append `"eps_consensus_vendor"` to `CONTENT_COLUMNS`; add the column to `INSERT_SQL` after `expected_move_pct` with one more `?`; bind `input.eps_consensus_vendor ?? null` in the same position in the `.run(...)` argument list; add `eps_consensus_vendor = excluded.eps_consensus_vendor` to `OVERWRITE_SQL` beside the other content columns (PRESERVE_SQL is generated from `CONTENT_COLUMNS` and needs no edit).

Extend `tests/mutations/earnings-bogeys.test.ts` `describe("upsertBogey")` with:

```ts
it("stores a finnhub row with the vendor EPS apart from eps_consensus", () => {
  upsertBogey(db, { event_id: eventId, source: "finnhub", source_label: "Sell-side consensus (Finnhub)", eps_consensus: null, eps_consensus_vendor: 0.50, revenue_consensus_usd: 1_234_000_000 });
  const row = db.prepare(`SELECT source, eps_consensus, eps_consensus_vendor, revenue_consensus_usd FROM earnings_bogeys WHERE event_id = ?`).get(eventId);
  expect(row).toEqual({ source: "finnhub", eps_consensus: null, eps_consensus_vendor: 0.50, revenue_consensus_usd: 1_234_000_000 });
});
```
(`eventId` is whatever the file's existing seed helper returns; reuse it.)

- [ ] **Step 5: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/migration-088-live-print-v2-a.test.ts tests/mutations/earnings-bogeys.test.ts tests/print-watch/contracts.test.ts tests/db`
Expected: PASS (contracts tests prove `compileContracts` is unaffected by the new column).

- [ ] **Step 6: Commit**

```bash
printf 'feat(db): migration 088 — prepare steps, bogey scan ledger, cloud outbox, earnings_bogeys rebuild with finnhub source + eps_consensus_vendor (live print v2 slice A, D1)\n' > /tmp/m.txt
git commit lib/db/migrations/088_live_print_v2_slice_a.sql lib/queries/earnings-bogeys.ts lib/mutations/earnings-bogeys.ts tests/db/migration-088-live-print-v2-a.test.ts tests/mutations/earnings-bogeys.test.ts -F /tmp/m.txt
```

---

### Task 2: Armed as an event fact — `isEventArmed`, `coveredForEvents`, display-only `armed` status

**Files:**
- Modify: `lib/queries/earnings-worksheet-flags.ts` (append three functions)
- Modify: `lib/queries/briefing-symbols.ts:47-146`
- Test: `tests/queries/armed-coverage.test.ts`, `tests/queries/earnings-hub.test.ts` (extend `describe("getSymbolStatus")`)

**Interfaces:**
- Consumes: `earnings_worksheet_flags(event_id UNIQUE → calendar_events.id CASCADE)`; `issuerSiblings` (`@/lib/securities/issuer-family`); `todayET`, `addDays`.
- Produces (later tasks depend on these EXACT names):

```ts
// lib/queries/earnings-worksheet-flags.ts
export function isEventArmed(db: Database.Database, eventId: number): boolean;
export function getArmedEventIds(db: Database.Database, eventIds: number[]): Set<number>;
/** UPPERCASE symbols with an unsuperseded earnings event in [today, today+horizonDays] carrying a flag. */
export function getArmedSymbolsInHorizon(db: Database.Database, opts: { today: string; horizonDays?: number }): Set<string>;

// lib/queries/briefing-symbols.ts
export type SymbolStatus = "held" | "watchlist" | "armed" | "neither";
export interface SymbolStatusReasons { held: boolean; watchlist: boolean; armed: boolean }
export function getSymbolStatusDetailed(db: Database.Database, symbols: string[], opts?: { today?: string }): Record<string, { status: SymbolStatus; reasons: SymbolStatusReasons }>;
export function getSymbolStatus(db: Database.Database, symbols: string[], opts?: { today?: string }): Record<string, SymbolStatus>;
/** Event-scoped coverage: held or watchlist (family-aware, as today) OR the event itself is armed. */
export function coveredForEvents(db: Database.Database, rows: Array<{ symbol: string | null; eventId: number }>): Set<number>;
export function coveredForEvent(db: Database.Database, symbol: string | null, eventId: number): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/queries/armed-coverage.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { isEventArmed, getArmedEventIds, getArmedSymbolsInHorizon } from "@/lib/queries/earnings-worksheet-flags";
import { getSymbolStatus, getSymbolStatusDetailed, coveredForEvents, coveredForEvent } from "@/lib/queries/briefing-symbols";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedEvent(symbol: string, date: string, extra: Partial<{ superseded: number }> = {}): number {
  const r = db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, superseded)
     VALUES ('manual','earnings',?,?,?,?,?)`,
  ).run(date, `${symbol} earnings`, `manual:${symbol}:${date}:earnings`, symbol, extra.superseded ?? 0);
  return Number(r.lastInsertRowid);
}
function seedHeld(symbol: string): void {
  const acct = db.prepare(`INSERT INTO accounts (name, account_type, institution) VALUES (?, 'taxable', 'test')`).run(`acct-${symbol}`);
  const sec = db.prepare(`INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)`).run(symbol, symbol);
  db.prepare(`INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 10, '2026-09-01')`).run(acct.lastInsertRowid, sec.lastInsertRowid);
}

describe("armed coverage (spec §4.1)", () => {
  it("isEventArmed is event-scoped: arming one event does not cover the sibling event of the same symbol", () => {
    const armedId = seedEvent("ACME", "2026-09-02");
    const siblingId = seedEvent("ACME", "2026-12-02");
    armWorksheet(db, armedId);
    expect(isEventArmed(db, armedId)).toBe(true);
    expect(isEventArmed(db, siblingId)).toBe(false);
    expect(getArmedEventIds(db, [armedId, siblingId, 999])).toEqual(new Set([armedId]));
    expect(coveredForEvent(db, "ACME", armedId)).toBe(true);
    expect(coveredForEvent(db, "ACME", siblingId)).toBe(false);
  });

  it("coveredForEvents keeps held/watchlist family coverage and adds armed events", () => {
    seedHeld("GOOG");
    const googl = seedEvent("GOOGL", "2026-10-20");   // family-held
    const snow = seedEvent("ACME", "2026-09-02");      // armed only
    const zs = seedEvent("BETA", "2026-09-03");          // nothing
    armWorksheet(db, snow);
    expect(coveredForEvents(db, [
      { symbol: "GOOGL", eventId: googl }, { symbol: "ACME", eventId: snow }, { symbol: "BETA", eventId: zs }, { symbol: null, eventId: 12345 },
    ])).toEqual(new Set([googl, snow]));
  });

  it("symbol-level armed honours the 14-day ET horizon and skips superseded rows", () => {
    const inside = seedEvent("ACME", "2026-09-10");
    const outside = seedEvent("BETA", "2026-09-30");
    const superseded = seedEvent("PATH", "2026-09-05", { superseded: 1 });
    const past = seedEvent("MDB", "2026-08-30");
    for (const id of [inside, outside, superseded, past]) armWorksheet(db, id);
    expect(getArmedSymbolsInHorizon(db, { today: "2026-09-02" })).toEqual(new Set(["ACME"]));
    const status = getSymbolStatus(db, ["ACME", "BETA", "PATH", "MDB"], { today: "2026-09-02" });
    expect(status).toEqual({ ACME: "armed", BETA: "neither", PATH: "neither", MDB: "neither" });
  });

  it("precedence is held > watchlist > armed and the reason set is exposed", () => {
    seedHeld("ACME");
    const id = seedEvent("ACME", "2026-09-05");
    armWorksheet(db, id);
    const detailed = getSymbolStatusDetailed(db, ["snow"], { today: "2026-09-02" });
    expect(detailed.ACME).toEqual({ status: "held", reasons: { held: true, watchlist: false, armed: true } });
    expect(getSymbolStatus(db, ["snow"], { today: "2026-09-02" })).toEqual({ ACME: "held" });
  });
});
```

Check the seed SQL against the real schemas before running (`PRAGMA table_info(accounts)` — if `institution`/`account_type` are not the NOT NULL columns, copy the seed helper from `tests/queries/earnings-hub.test.ts:22-42` instead; that helper is the source of truth for these tests).

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/queries/armed-coverage.test.ts`
Expected: FAIL — `isEventArmed is not a function`.

- [ ] **Step 3: Implement the flag queries**

Append to `lib/queries/earnings-worksheet-flags.ts`:

```ts
/** Event-scoped coverage fact (spec §4.1): a flag row exists for this event id. */
export function isEventArmed(db: Database.Database, eventId: number): boolean {
  return !!db.prepare(`SELECT 1 FROM earnings_worksheet_flags WHERE event_id = ?`).get(eventId);
}

export function getArmedEventIds(db: Database.Database, eventIds: number[]): Set<number> {
  const out = new Set<number>();
  if (eventIds.length === 0) return out;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT event_id FROM earnings_worksheet_flags WHERE event_id IN (${placeholders})`)
    .all(...eventIds) as { event_id: number }[];
  for (const r of rows) out.add(r.event_id);
  return out;
}

/** Symbol-level display signal only (never an event decision): UPPERCASE symbols
 *  with an unsuperseded earnings event in [today, today + horizonDays] carrying a flag. */
export function getArmedSymbolsInHorizon(
  db: Database.Database,
  opts: { today: string; horizonDays?: number },
): Set<string> {
  const end = addDays(opts.today, opts.horizonDays ?? 14);
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(ce.symbol) AS symbol
         FROM earnings_worksheet_flags f
         JOIN calendar_events ce ON ce.id = f.event_id
        WHERE ce.event_type = 'earnings'
          AND ce.symbol IS NOT NULL
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.event_date BETWEEN ? AND ?`,
    )
    .all(opts.today, end) as { symbol: string }[];
  return new Set(rows.map((r) => r.symbol));
}
```
Add `import { addDays } from "@/lib/calendar/date-utils";` at the top.

- [ ] **Step 4: Implement the status + coverage functions**

In `lib/queries/briefing-symbols.ts`, replace the `SymbolStatus` type (line 47) and restructure `getSymbolStatus` (lines 61-146) so the held/watchlist sets it already computes feed a detailed resolver:

```ts
export type SymbolStatus = "held" | "watchlist" | "armed" | "neither";
export interface SymbolStatusReasons { held: boolean; watchlist: boolean; armed: boolean }

/**
 * Held / watchlist (family-aware, unchanged) plus the DISPLAY-ONLY `armed`
 * reason: the symbol (or a share-class sibling) has an unsuperseded earnings
 * event within 14 ET days carrying a worksheet flag. Precedence held >
 * watchlist > armed > neither. Event decisions never use this — they call
 * coveredForEvents / isEventArmed (spec §4.1).
 */
export function getSymbolStatusDetailed(
  db: Database.Database,
  symbols: string[],
  opts: { today?: string } = {},
): Record<string, { status: SymbolStatus; reasons: SymbolStatusReasons }> {
  if (symbols.length === 0) return {};
  // … existing lines 66-135 compute `held: Set<string>` and `watched: Set<string>`
  //   over the family-expanded universe; keep them verbatim …
  const armedSymbols = getArmedSymbolsInHorizon(db, { today: opts.today ?? todayET() });
  const out: Record<string, { status: SymbolStatus; reasons: SymbolStatusReasons }> = {};
  for (const [input, family] of inputFamilies) {
    const reasons = {
      held: family.some((s) => held.has(s)),
      watchlist: family.some((s) => watched.has(s)),
      armed: family.some((s) => armedSymbols.has(s)),
    };
    const status: SymbolStatus = reasons.held ? "held" : reasons.watchlist ? "watchlist" : reasons.armed ? "armed" : "neither";
    out[input] = { status, reasons };
  }
  return out;
}

export function getSymbolStatus(
  db: Database.Database,
  symbols: string[],
  opts: { today?: string } = {},
): Record<string, SymbolStatus> {
  const detailed = getSymbolStatusDetailed(db, symbols, opts);
  const out: Record<string, SymbolStatus> = {};
  for (const [k, v] of Object.entries(detailed)) out[k] = v.status;
  return out;
}

/** Event-scoped coverage (spec §4.1 consumer matrix): held or watchlist
 *  (family-aware) OR isEventArmed(eventId). Returns the covered event ids. */
export function coveredForEvents(
  db: Database.Database,
  rows: Array<{ symbol: string | null; eventId: number }>,
): Set<number> {
  const out = new Set<number>();
  if (rows.length === 0) return out;
  const symbols = Array.from(new Set(rows.map((r) => r.symbol).filter((s): s is string => !!s).map((s) => s.toUpperCase())));
  const detailed = getSymbolStatusDetailed(db, symbols);
  const armed = getArmedEventIds(db, rows.map((r) => r.eventId));
  for (const r of rows) {
    const reasons = r.symbol ? detailed[r.symbol.toUpperCase()]?.reasons : undefined;
    if ((reasons && (reasons.held || reasons.watchlist)) || armed.has(r.eventId)) out.add(r.eventId);
  }
  return out;
}

export function coveredForEvent(db: Database.Database, symbol: string | null, eventId: number): boolean {
  return coveredForEvents(db, [{ symbol, eventId }]).has(eventId);
}
```
Imports to add: `import { getArmedEventIds, getArmedSymbolsInHorizon } from "./earnings-worksheet-flags";` and `import { todayET } from "@/lib/calendar/date-utils";`. Keep the existing keying behaviour (output keys are the UPPERCASED inputs — the existing tests in `tests/queries/earnings-hub.test.ts` `describe("getSymbolStatus")` must still pass unchanged).

- [ ] **Step 5: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/queries/armed-coverage.test.ts tests/queries/earnings-hub.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
printf 'feat(earnings): armed is an event fact — isEventArmed, coveredForEvents, display-only armed symbol status (v2 slice A §4.1)\n' > /tmp/m.txt
git commit lib/queries/earnings-worksheet-flags.ts lib/queries/briefing-symbols.ts tests/queries/armed-coverage.test.ts -F /tmp/m.txt
```

---

### Task 3: ET day math in the four UTC consumers

**Files:**
- Modify: `lib/calendar/enrichment-runner.ts:167-171` (`findCandidates`), `:745-746`, `:819` (`findEmailCandidates`)
- Modify: `lib/calendar/wire-probe.ts:35-37`
- Modify: `lib/transcripts/same-day.ts:251-254`
- Test: `tests/calendar/findEmailCandidates-et-day.test.ts`, extend `tests/calendar/wire-probe.test.ts` (or create if absent)

**Interfaces:**
- Consumes: `todayET(now: Date): string`, `addDays(dateStr, days)` from `lib/calendar/date-utils.ts`.
- Produces: no new exports. Behaviour: after 20:00 ET the preview / recap / reporter windows are computed on the ET calendar day.

- [ ] **Step 1: Write the failing test (proves the offset shifts a candidate window)**

```ts
// tests/calendar/findEmailCandidates-et-day.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";

function seed(db: Database.Database): number {
  const acct = db.prepare(`INSERT INTO accounts (name, account_type, institution) VALUES ('a','taxable','t')`).run();
  const sec = db.prepare(`INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('BETA','Beta Corp','stock','equity',1)`).run();
  db.prepare(`INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?,?,10,'2026-09-01')`).run(acct.lastInsertRowid, sec.lastInsertRowid);
  const ev = db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol)
     VALUES ('finnhub','earnings','2026-09-02','AMC','22:30','BETA','k','BETA')`,
  ).run();
  return Number(ev.lastInsertRowid);
}

describe("findEmailCandidates — ET calendar day (Codex round-3 finding 9)", () => {
  it("at 20:30 ET a preview 120 minutes out on TODAY's ET date is a candidate even though the UTC date has rolled", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const id = seed(db);
    // 2026-09-02 20:30 ET == 2026-09-03 00:30 UTC. UTC day math looks for
    // event_date BETWEEN 09-03 AND 09-04 and drops the 09-02 row.
    const now = new Date("2026-09-03T00:30:00Z");
    const out = findEmailCandidates(db, { now });
    expect(out).toEqual([{ eventId: id, symbol: "BETA", phase: "preview" }]);
  });
});
```
(Seed helper caveat as in Task 2 — copy the exact NOT NULL columns from `tests/queries/earnings-hub.test.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/calendar/findEmailCandidates-et-day.test.ts`
Expected: FAIL — `[]` (the row is outside the UTC window).

- [ ] **Step 3: Replace the four UTC sites**

`lib/calendar/enrichment-runner.ts` — add `import { todayET, addDays } from "./date-utils";` (check the existing import block at lines 13-36 for a `date-utils` import first and extend it).

Lines 745-746:
```ts
  const todayStr = todayET(now);
  const tomorrowStr = addDays(todayStr, 1);
```
Line 819:
```ts
  const yesterdayStr = addDays(todayStr, -1);
```
Lines 167-171 (inside `findCandidates`, which has `opts.now` available as `const now = opts.now ?? new Date()` — if it does not, add it beside `nowMs`):
```ts
  const today = todayET(now);
  const threeDaysAgo = addDays(today, -3);
```

`lib/calendar/wire-probe.ts:35-37`:
```ts
  const nowMs = now.getTime();
  const today = todayET(now);
  const yesterday = addDays(today, -1);
```
with `import { todayET, addDays } from "./date-utils";`.

`lib/transcripts/same-day.ts:251-254`:
```ts
  const today = todayET(now);
  const rangeStart = addDays(today, -(Math.ceil(UPGRADE_DEADLINE_MS / 86_400_000) + 1));
```
(`now` is `opts.now ?? new Date()` in that function; `pacingCutoff` stays a UTC timestamp string — it is compared with `datetime()` and is a duration, not a day.)

- [ ] **Step 4: Run the affected suites**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/calendar tests/transcripts tests/earnings/wire-probe.test.ts tests/calendar/findEmailCandidates-et-day.test.ts`
Expected: PASS. If an existing test pinned a UTC date near midnight, fix the TEST's `now` to an ET-unambiguous instant (e.g. `T16:00:00Z`) — never reintroduce UTC math.

- [ ] **Step 5: Commit**

```bash
printf 'fix(calendar): derive preview/recap/probe/transcript day windows on the ET calendar day, not UTC (v2 slice A; Codex round-3 finding 9)\n' > /tmp/m.txt
git commit lib/calendar/enrichment-runner.ts lib/calendar/wire-probe.ts lib/transcripts/same-day.ts tests/calendar/findEmailCandidates-et-day.test.ts -F /tmp/m.txt
```

---

### Task 4: Selection consumers switch to `coveredForEvents`

**Files:**
- Modify: `lib/calendar/enrichment-runner.ts:842-870` (`findEmailCandidates` coverage block + reporter road)
- Modify: `lib/earnings/extract-newsletter-bogeys.ts:261-291` (`getUpcomingReporters`)
- Modify: `lib/earnings/bogeys-reminder.ts:64-70`
- Modify: `lib/calendar/verify-earnings-dates.ts:135-144`
- Modify: `lib/calendar/wire-probe.ts:68-80`
- Modify: `lib/earnings/wrap.ts:99-125`
- Modify: `lib/earnings/debrief.ts:130-139`
- Modify: `lib/queries/earnings-cockpit.ts:140-157`
- Test: `tests/earnings/armed-selection-matrix.test.ts`

**Interfaces:**
- Consumes: `coveredForEvents(db, rows)` (Task 2), `getReadThroughReporterSymbols` (unchanged), `shouldSendEarningsEmail` (unchanged).
- Produces: none new. Every row-level `st === "held" || st === "watchlist"` in these eight sites becomes membership in the `coveredForEvents` set keyed by the row's event id.

- [ ] **Step 1: Write the failing matrix test (one `it` per row)**

```ts
// tests/earnings/armed-selection-matrix.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import { renderBogeysReminderLine } from "@/lib/earnings/bogeys-reminder";
import { findDateVerificationCandidates } from "@/lib/calendar/verify-earnings-dates";
import { findProbeCandidates } from "@/lib/calendar/wire-probe";
import { getExpectedRecapCluster } from "@/lib/earnings/wrap";
import { findDebriefCandidates } from "@/lib/earnings/debrief";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { __getUpcomingReportersForTests } from "@/lib/earnings/extract-newsletter-bogeys";

vi.mock("@/lib/ai/generate", () => ({ generateTextForFeature: vi.fn(), AIRefusalError: class extends Error {} }));
vi.mock("@/lib/ai/models", () => ({ resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })) }));

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); });

/** An UNHELD, UNWATCHED name with two events: `armed` (today AMC) and `sibling` (next quarter). */
function seedPair(now: Date): { armed: number; sibling: number } {
  const ins = db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol, actual_value, enriched_at)
     VALUES ('manual','earnings',?,?,?,'ACME','k'||?,'ACME',?,?)`,
  );
  const armed = Number(ins.run("2026-09-02", "AMC", "16:15", "a", null, null).lastInsertRowid);
  // [C-17] The sibling sits INSIDE every consumer's window (six days out — inside the
  // 14-day scan/reminder horizons, the verifier horizon, and the cockpit week) so a
  // consumer that leaked symbol-level "armed" eligibility would select it and fail.
  const sibling = Number(ins.run("2026-09-08", "AMC", "16:15", "b", null, null).lastInsertRowid);
  armWorksheet(db, armed);
  return { armed, sibling };
}
const NOW = new Date("2026-09-02T18:30:00Z"); // 14:30 ET — 105 min before a 16:15 print

describe("spec §4.1 consumer matrix — armed-only event is selected; its sibling is not", () => {
  it("findEmailCandidates (preview)", () => {
    const { armed } = seedPair(NOW);
    expect(findEmailCandidates(db, { now: NOW }).map((c) => c.eventId)).toEqual([armed]);
  });
  it("getUpcomingReporters (newsletter bogey scan)", () => {
    const { armed } = seedPair(NOW);
    expect(__getUpcomingReportersForTests(db, { today: "2026-09-02" }).map((r) => r.event_id)).toEqual([armed]);
  });
  it("renderBogeysReminderLine", () => {
    seedPair(NOW);
    expect(renderBogeysReminderLine(db, "2026-08-31")).toMatch(/ACME/);
  });
  it("findDateVerificationCandidates skips manual rows by design but keeps an armed vendor row", () => {
    const { armed } = seedPair(NOW);
    db.prepare(`UPDATE calendar_events SET source = 'finnhub' WHERE id = ?`).run(armed);
    expect(findDateVerificationCandidates(db, { now: NOW }).map((r) => r.id)).toEqual([armed]);
  });
  it("findProbeCandidates", () => {
    const { armed } = seedPair(NOW);
    const t = new Date("2026-09-02T19:30:00Z"); // 15:30 ET, inside (release-90m, release)
    expect(findProbeCandidates(db, t).map((r) => r.id)).toEqual([armed]);
  });
  it("getExpectedRecapCluster", () => {
    const { armed } = seedPair(NOW);
    expect(getExpectedRecapCluster(db, "2026-09-02", "AMC").map((m) => m.eventId)).toEqual([armed]);
  });
  it("findDebriefCandidates", () => {
    const { armed } = seedPair(NOW);
    db.prepare(`UPDATE calendar_events SET actual_value = 'EPS 0.62', enriched_at = '2026-09-02 22:00:00' WHERE id = ?`).run(armed);
    const out = findDebriefCandidates(db, { now: new Date("2026-09-03T11:00:00Z") });
    expect(out.unsent.map((c) => c.eventId)).toEqual([armed]);
  });
  it("buildCockpitPayload keeps the armed row and not the in-window sibling", () => {
    const { armed, sibling } = seedPair(NOW);
    const ids = buildCockpitPayload(db, NOW).rows.map((r) => r.eventId);
    expect(ids).toContain(armed);
    expect(ids).not.toContain(sibling);
  });
});
```

Every `it` above also asserts the sibling is ABSENT from the selection (add `expect(...).not.toContain(sibling)` to each — the assertion shape is "exactly `[armed]`", which already excludes it where `toEqual([armed])` is used).

[C-17] Push gates and read-through stay held/watchlist/read-through — three regression tests that must keep passing unchanged after this task, added to the EXISTING describes (they use the file's existing push mock):
- `tests/calendar/enrichment-runner.test.ts` (the push-gate describe near line 414): an armed-only, unheld, unwatched reporter whose `actual_value` transitions null → non-null does NOT call `sendEarningsPrintPush`.
- `tests/workers/cloud-enrich.test.ts` / `tests/calendar/cloud-reconcile.test.ts` (whichever holds the `reconcileCloudEnrichment` push test): same assertion through the cloud-reconcile path.
- `tests/alerts/read-through-push.test.ts`: a pair whose target is armed-only (not held, not watchlist) is excluded from `getLiveReadThroughsForReporter`.
Adjust the two result-shape accessors (`out.unsent`, `.rows[].eventId`, `WrapClusterMember.eventId`) to the real field names in `lib/earnings/debrief.ts:DebriefCandidates`, `lib/queries/earnings-cockpit.ts:CockpitPayload`, `lib/earnings/wrap.ts:WrapClusterMember` — read the interfaces before running; the assertion shape stays "only the armed id".

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/armed-selection-matrix.test.ts`
Expected: FAIL on every `it` (empty selections; `__getUpcomingReportersForTests` undefined).

- [ ] **Step 3: Rewire the eight sites**

`lib/calendar/enrichment-runner.ts:842-870` — replace the held|watchlist block:
```ts
  // ── Coverage (spec §4.1): held/watchlist family OR the event itself is armed ──
  const coveredIds = coveredForEvents(
    db,
    [...previewCandidates, ...recapCandidates, ...reporterCandidates].map((r) => ({ symbol: r.symbol, eventId: r.id })),
  );
  const isCovered = (row: { id: number }): boolean => coveredIds.has(row.id);
```
and change the three loops to `if (!row.symbol || !isCovered(row) || !isAllowed(row.symbol)) continue;`; in the read-through reporter road below, the "NOT covered" test becomes `!isCovered(row)`. Replace the `getSymbolStatus` import with `coveredForEvents` if `getSymbolStatus` is no longer referenced in this file (the push gate at line 504 still uses it — keep both imports).

`lib/earnings/extract-newsletter-bogeys.ts:261-291`:
```ts
function getUpcomingReporters(db: Database.Database, opts: { today?: string } = {}): UpcomingReporter[] {
  const today = opts.today ?? todayET();
  const endDate = addDays(today, WINDOW_DAYS_AHEAD);
  const rows = /* existing SELECT, unchanged */;
  if (rows.length === 0) return [];
  const covered = coveredForEvents(db, rows.map((r) => ({ symbol: r.symbol, eventId: r.event_id })));
  return rows
    .filter((r) => covered.has(r.event_id))
    .map((r) => ({ symbol: r.symbol.toUpperCase(), event_id: r.event_id, event_date: r.event_date }));
}
/** Test seam — the function stays private to the module's callers. */
export const __getUpcomingReportersForTests = getUpcomingReporters;
```

`lib/earnings/bogeys-reminder.ts:64-70`:
```ts
  const covered = coveredForEvents(db, rows.map((r) => ({ symbol: r.symbol, eventId: r.event_id })));
  const reporters = rows.filter((r) => covered.has(r.event_id));
```

`lib/calendar/verify-earnings-dates.ts:135-144`:
```ts
  const reporterSet = new Set(getReadThroughReporterSymbols(db).map((s) => s.toUpperCase()));
  const coveredIds = coveredForEvents(db, rows.map((r) => ({ symbol: r.symbol, eventId: r.id })));
  const covered = rows.filter((r) => coveredIds.has(r.id) || reporterSet.has(r.symbol.toUpperCase()));
```

`lib/calendar/wire-probe.ts:68-80`:
```ts
  const coveredIds = coveredForEvents(db, inWindow.map((r) => ({ symbol: r.symbol, eventId: r.id })));
  let reporters: Set<string>;
  try { reporters = new Set(getReadThroughReporterSymbols(db).map((s: string) => s.toUpperCase())); } catch { reporters = new Set(); }
  const gated = inWindow.filter((r) => coveredIds.has(r.id) || reporters.has(r.symbol.toUpperCase()));
```

`lib/earnings/wrap.ts:99` and the filter at 118-123:
```ts
  const coveredIds = coveredForEvents(db, events.map((e) => ({ symbol: e.symbol!, eventId: e.id })));
  …
  const filtered = events.filter((e) => {
    if (!coveredIds.has(e.id)) return false;
    if (sentRecaps.has(e.id) || skipped.has(e.id)) return false;
    if (!shouldSendEarningsEmail(settings, e.symbol!)) return false;
    return true;
  });
```

`lib/earnings/debrief.ts:130-139`:
```ts
  const coveredIds = coveredForEvents(db, rawRows.map((r) => ({ symbol: r.symbol, eventId: r.eventId })));
  let candidates = rawRows.filter((r) => coveredIds.has(r.eventId) && shouldSendEarningsEmail(settings, r.symbol));
```

`lib/queries/earnings-cockpit.ts:140,153-157`:
```ts
  const statusMap = getSymbolStatus(db, raw.map((r) => r.symbol));   // still used for the chip
  const coveredIds = coveredForEvents(db, raw.map((r) => ({ symbol: r.symbol, eventId: r.id })));
  …
  // Keep held + watchlist + armed (event-scoped).
  const kept = raw.filter((r) => coveredIds.has(r.id));
```

In every file, import `coveredForEvents` from `@/lib/queries/briefing-symbols`. Where `getSymbolStatus` becomes unused, remove that import (lint).

- [ ] **Step 4: Run the matrix test plus every touched module's existing suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings tests/calendar tests/queries/earnings-cockpit.test.ts tests/queries/earnings-hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
printf 'feat(earnings): selection consumers use event-scoped coverage (coveredForEvents) — armed events get what held names get (v2 slice A matrix rows 1-7, cockpit)\n' > /tmp/m.txt
git commit lib/calendar/enrichment-runner.ts lib/earnings/extract-newsletter-bogeys.ts lib/earnings/bogeys-reminder.ts lib/calendar/verify-earnings-dates.ts lib/calendar/wire-probe.ts lib/earnings/wrap.ts lib/earnings/debrief.ts lib/queries/earnings-cockpit.ts tests/earnings/armed-selection-matrix.test.ts -F /tmp/m.txt
```

---

### Task 5: Display chips, symbol-only consumers, and the consumer allowlist guard

**Files:**
- Modify: `lib/digest/todays-reporters.ts:65-90` (chip `"armed"`)
- Modify: `app/dashboard/today/EarningsHub.tsx:68-80` (chip class + label; D3)
- Modify: `lib/transcripts/same-day.ts:286-291`, `lib/digest/call-transcripts.ts:250-255` (armed symbol counts)
- Create: `tests/repo/symbol-status-consumers.test.ts`
- Test: `tests/digest/todays-reporters.test.ts` (extend), `tests/transcripts/same-day.test.ts` (extend)

**Interfaces:**
- Consumes: `SymbolStatus` now includes `"armed"` (Task 2).
- Produces: `ReporterRowView.chip` gains the value `"armed"`; the guard test's `ALLOWLIST` is the registry of every `getSymbolStatus` / `getSymbolStatusDetailed` / `coveredForEvents` / `isEventArmed` call site with its declared effect.

- [ ] **Step 1: Write the failing tests**

Extend `tests/digest/todays-reporters.test.ts` with a case that seeds an armed-only reporter for today and asserts the rendered block contains the `armed` chip text (the renderer prints the chip via `renderReporterRow` — assert on the same substring the existing `held`/`wl` cases assert on, with `armed`).

Extend `tests/transcripts/same-day.test.ts`: an armed-only (unheld) symbol with an event in the last 14 days and actuals is attempted (assert `attempted: 1`), using the file's existing fetch mock.

Create the guard:

```ts
// tests/repo/symbol-status-consumers.test.ts
/**
 * Spec §4.1: every consumer of the symbol-status / event-coverage helpers is
 * named here with its declared effect. A new call site fails this test until
 * it is classified — so nobody can silently add a held/watchlist-only gate
 * (or an event decision keyed on the display-only `armed` status).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

type Effect = "selection-covered" | "symbol-armed" | "unchanged-push-gate" | "display" | "helper";
interface AllowEntry { file: string; fn: "getSymbolStatus" | "getSymbolStatusDetailed" | "coveredForEvents" | "coveredForEvent" | "isEventArmed" | "getArmedEventIds"; effect: Effect; }

const ALLOWLIST: AllowEntry[] = [
  { file: "lib/queries/briefing-symbols.ts", fn: "getSymbolStatusDetailed", effect: "helper" },
  { file: "lib/queries/briefing-symbols.ts", fn: "getArmedEventIds", effect: "helper" },
  { file: "lib/queries/briefing-symbols.ts", fn: "coveredForEvents", effect: "helper" },
  { file: "lib/calendar/enrichment-runner.ts", fn: "getSymbolStatus", effect: "unchanged-push-gate" },
  { file: "lib/calendar/enrichment-runner.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/calendar/cloud-reconcile.ts", fn: "getSymbolStatus", effect: "unchanged-push-gate" },
  { file: "lib/alerts/read-through-push.ts", fn: "getSymbolStatus", effect: "unchanged-push-gate" },
  { file: "lib/earnings/extract-newsletter-bogeys.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/earnings/bogeys-reminder.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/calendar/verify-earnings-dates.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/calendar/wire-probe.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/earnings/wrap.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/earnings/debrief.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/queries/earnings-cockpit.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/queries/earnings-cockpit.ts", fn: "getSymbolStatus", effect: "display" },
  { file: "lib/digest/todays-reporters.ts", fn: "getSymbolStatus", effect: "display" },
  { file: "app/dashboard/today/EarningsHub.tsx", fn: "getSymbolStatus", effect: "display" },
  { file: "lib/digest/call-transcripts.ts", fn: "getSymbolStatus", effect: "symbol-armed" },
  { file: "lib/transcripts/same-day.ts", fn: "getSymbolStatus", effect: "symbol-armed" },
  // Task 6: updateCalendarEvent writes the outbox row only when the edited event is armed.
  { file: "lib/mutations/calendar.ts", fn: "isEventArmed", effect: "helper" },
];

const REPO = path.resolve(__dirname, "..", "..");
const ROOTS: Array<[string, RegExp]> = [["lib", /\.ts$/], ["app", /\.(ts|tsx)$/], ["scripts", /\.ts$/]];
const FN_RE = /\b(getSymbolStatusDetailed|getSymbolStatus|coveredForEvents|coveredForEvent|isEventArmed|getArmedEventIds)\s*\(/g;

function walk(dir: string, re: RegExp, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out); else if (re.test(e.name)) out.push(p);
  }
}

function occurrences(): Array<{ file: string; fn: string }> {
  const files: string[] = [];
  for (const [root, re] of ROOTS) walk(path.join(REPO, root), re, files);
  const out: Array<{ file: string; fn: string }> = [];
  for (const f of files) {
    const rel = path.relative(REPO, f);
    const src = fs.readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(FN_RE)) {
      // Skip the definition site (`export function name(`).
      const before = src.slice(Math.max(0, m.index! - 40), m.index!);
      if (/function\s*$/.test(before)) continue;
      out.push({ file: rel, fn: m[1] });
    }
  }
  return out;
}

describe("symbol-status / coverage consumers are classified (spec §4.1 guard)", () => {
  it("every call site appears in the allowlist", () => {
    const missing = occurrences().filter((o) => !ALLOWLIST.some((a) => a.file === o.file && a.fn === o.fn));
    expect(missing).toEqual([]);
  });
  it("every allowlist entry still exists (no stale entries)", () => {
    const occ = occurrences();
    const stale = ALLOWLIST.filter((a) => a.effect !== "helper" && !occ.some((o) => o.file === a.file && o.fn === a.fn));
    expect(stale).toEqual([]);
  });
  it("an event decision never keys on the display-only armed status", () => {
    // Any file classified selection-covered must not compare a status to "armed".
    for (const a of ALLOWLIST.filter((x) => x.effect === "selection-covered")) {
      const src = fs.readFileSync(path.join(REPO, a.file), "utf-8");
      expect(src, a.file).not.toMatch(/===\s*["']armed["']/);
    }
  });
});
```
The `helper` entries for `lib/earnings/prepare-armed-event.ts` (Task 9) will be stale until that task lands — the second `it` skips `helper` effects for that reason.

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/repo/symbol-status-consumers.test.ts tests/digest/todays-reporters.test.ts tests/transcripts/same-day.test.ts`
Expected: FAIL — the two new display/symbol cases; the guard passes or fails depending on whether Task 4 left an unclassified site (fix the ALLOWLIST to the truth, never the code, unless a site is genuinely wrong).

- [ ] **Step 3: Implement**

`lib/digest/todays-reporters.ts` (line ~87):
```ts
      const chip = st === "held" ? "held" : st === "watchlist" ? "wl" : st === "armed" ? "armed" : rtSet.has(sym) ? "rt" : "";
```
and widen the `ReporterRowView.chip` union (and the renderer in `lib/digest/todays-reporters-render.ts`, if it enumerates chips) with `"armed"`, rendering the text `armed`. Mirror the same three edits in `workers/cron/src/todays-reporters.ts` / `todays-reporters-render.ts` in Task 8 (parity).

[C-17] `EarningsHub.tsx` is a server component that imports the `db` singleton at module load, so its helpers cannot be imported by a unit test. Move the two chip helpers (lines 68-80) verbatim into a new pure module `app/dashboard/today/status-chip.ts` (no imports beyond the `SymbolStatus` type) and import them back into `EarningsHub.tsx`:
```ts
// app/dashboard/today/status-chip.ts
import type { SymbolStatus } from "@/lib/queries/briefing-symbols";

export function statusChipClass(status: SymbolStatus): string {
  if (status === "held") return "text-up bg-up/15 border border-up/30";
  if (status === "watchlist") return "text-gold-ink bg-gold/15 border border-gold/30";
  if (status === "armed") return "text-ink-dim bg-raised border border-edge-strong";
  return NEITHER_CLASS;   // = the string the existing `return` at line 71 holds today, copied verbatim
}
export function statusChipLabel(status: SymbolStatus): string {
  if (status === "held") return "HELD";
  if (status === "watchlist") return "WATCH";
  if (status === "armed") return "ARMED";
  return NEITHER_LABEL;   // = the existing return at line 77, copied verbatim
}
```
Test `tests/dashboard/status-chip.test.ts`: `statusChipLabel("armed") === "ARMED"`, `statusChipClass("armed")` contains `border-edge-strong`, and the held/watchlist/neither outputs equal today's strings (copy them into the test from lines 69-78 before moving). Contrast: `text-ink-dim` on `bg-raised` is the existing muted-chip pair used elsewhere on Today; keep ≥4.5:1.

`lib/transcripts/same-day.ts:288-291` and `lib/digest/call-transcripts.ts:252-255`:
```ts
    return st === "held" || st === "watchlist" || st === "armed";
```

- [ ] **Step 4: Run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/repo tests/digest tests/transcripts tests/queries/earnings-hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
printf 'feat(earnings): armed chip on Today hub + reporters block; symbol-only transcript consumers count armed; consumer allowlist guard (v2 slice A)\n' > /tmp/m.txt
git commit lib/digest/todays-reporters.ts lib/digest/todays-reporters-render.ts app/dashboard/today/EarningsHub.tsx app/dashboard/today/status-chip.ts lib/transcripts/same-day.ts lib/digest/call-transcripts.ts tests/repo/symbol-status-consumers.test.ts tests/dashboard/status-chip.test.ts tests/digest/todays-reporters.test.ts tests/transcripts/same-day.test.ts -F /tmp/m.txt
```

---

### Task 6: Cloud outbox — projection, writer, sender, and the mutations that write it

**Files:**
- Create: `lib/earnings/armed-events-projection.ts`
- Create: `lib/earnings/cloud-outbox.ts`
- Modify: `lib/mutations/earnings-worksheet-flags.ts:10-24` (arm/disarm in a transaction + outbox row)
- Modify: `lib/mutations/calendar.ts:700-830` (`insertCalendarEvent`, `updateCalendarEvent` in a transaction + outbox row)
- Modify: `lib/calendar/email-sweep.ts:135` (drain hook beside `reconcileCloudSentAudits`)
- Modify: `app/api/earnings/worksheet/route.ts`, `app/api/calendar/events/route.ts`, `app/api/earnings/correct-date/route.ts` (post-commit drain attempt)
- Test: `tests/earnings/armed-events-projection.test.ts`, `tests/earnings/cloud-outbox.test.ts`

**Interfaces:**
- Consumes: `cloud_outbox` (Task 1), `earnings_worksheet_flags`, `todayET`, `addDays`, env `WORKER_MARKER_URL` + `CRON_SHARED_SECRET` (same pair as `lib/cron/earnings-marker-check.ts:25-40`).
- Produces:

```ts
// lib/earnings/armed-events-projection.ts
export interface ArmedEventProjection {
  eventId: number; symbol: string; eventDate: string; eventTime: string | null; releaseTime: string | null;
  sourceKey: string; source: string; consensusValue: string | null; expectedImpact: string | null;
  securityId: number | null; epsConsensusVendor: number | null; removed?: true;
}
export interface ArmedEventsPayload { generation: number; entries: ArmedEventProjection[] }
export const ARMED_EVENTS_KIND = "armed-events";
/** Full current armed list (+ tombstones carried from the previous payload, D7). Pure read. */
export function buildArmedEventsEntries(db: Database.Database, opts: { today: string }): ArmedEventProjection[];
/** MAX(generation) of kind 'armed-events' in cloud_outbox, 0 when none. */
export function readArmedGeneration(db: Database.Database): number;

// lib/earnings/cloud-outbox.ts
/** Inserts one 'armed-events' row at generation MAX+1 with the full current list. Call INSIDE the mutation's transaction. */
export function writeArmedEventsOutboxRow(db: Database.Database, opts?: { today?: string }): { generation: number };
export interface OutboxSenderDeps { fetchFn?: typeof fetch; workerUrl?: string | null; secret?: string | null; timeoutMs?: number }
/** Drains unsent rows in generation order via POST /internal/armed-events; marks sent_at on 2xx; stops at the first failure. */
export async function drainCloudOutbox(db: Database.Database, deps?: OutboxSenderDeps): Promise<{ sent: number; failed: number; skipped: "no-worker-config" | null }>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/earnings/armed-events-projection.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet, disarmWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { buildArmedEventsEntries, readArmedGeneration } from "@/lib/earnings/armed-events-projection";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); });
const seed = (symbol: string, date: string) => Number(db.prepare(
  `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol, consensus_value)
   VALUES ('manual','earnings',?,'AMC','16:15',?,?,?,'EPS 0.50 · Rev 1,234,000,000')`).run(date, symbol, `manual:${symbol}:${date}:earnings`, symbol).lastInsertRowid);

describe("armed-events projection + outbox generations", () => {
  it("projects exactly the minimal fields and only armed events", () => {
    const a = seed("ACME", "2026-09-02"); seed("BETA", "2026-09-03");
    armWorksheet(db, a);
    expect(buildArmedEventsEntries(db, { today: "2026-09-02" })).toEqual([{
      eventId: a, symbol: "ACME", eventDate: "2026-09-02", eventTime: "AMC", releaseTime: "16:15",
      sourceKey: "manual:ACME:2026-09-02:earnings", source: "manual", consensusValue: "EPS 0.50 · Rev 1,234,000,000",
      expectedImpact: null, securityId: null, epsConsensusVendor: null,
    }]);
  });
  it("generation is monotonic across arm/disarm; a disarm leaves a tombstone kept ≥48h after removal and ≥2 ET days after the event (D7)", () => {
    const a = seed("ACME", "2026-09-02");
    expect(readArmedGeneration(db)).toBe(0);
    armWorksheet(db, a);                       // gen 1 (arm writes the row)
    disarmWorksheet(db, a);                    // gen 2
    expect(readArmedGeneration(db)).toBe(2);
    const gen2 = JSON.parse(db.prepare(`SELECT payload_json FROM cloud_outbox WHERE generation = 2`).get()!.payload_json as string);
    expect(gen2.entries).toEqual([expect.objectContaining({ eventId: a, removed: true, removedAt: expect.any(String) })]);
    const removedAt = Date.parse(gen2.entries[0].removedAt);
    // Event-date rule alone would drop it on 09-05; the 48h rule keeps it while the removal is fresh.
    expect(buildArmedEventsEntries(db, { today: "2026-09-04", nowMs: removedAt + 1 })).toEqual([expect.objectContaining({ eventId: a, removed: true })]);
    expect(buildArmedEventsEntries(db, { today: "2026-09-05", nowMs: removedAt + 47 * 3_600_000 })).toEqual([expect.objectContaining({ eventId: a, removed: true })]);
    expect(buildArmedEventsEntries(db, { today: "2026-09-05", nowMs: removedAt + 49 * 3_600_000 })).toEqual([]);
  });
  it("[C-7] deleting an armed manual event writes a tombstone row", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a);
    deleteCalendarEvent(db, a, { today: "2026-09-02" });
    const last = JSON.parse((db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`).get() as { payload_json: string }).payload_json);
    expect(last.entries).toEqual([expect.objectContaining({ eventId: a, removed: true })]);
  });
  it("[D10] an unchanged projection writes no row; a changed one gets the next generation", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a);                                                                   // gen 1
    const write = () => db.transaction(() => writeArmedEventsOutboxRow(db, { today: "2026-09-02" })).immediate();
    expect(write()).toEqual({ generation: 1, written: false });
    db.prepare(`UPDATE calendar_events SET release_time = '16:30' WHERE id = ?`).run(a);
    expect(write()).toEqual({ generation: 2, written: true });
    expect(() => writeArmedEventsOutboxRow(db)).toThrow(/inside a transaction/);
  });
  it("[C-9] two PROCESSES cannot mint the same generation — the second waits on the busy timeout, then takes the next one", async () => {
    // better-sqlite3 is synchronous, so a real race needs a second process: the parent holds
    // the write lock while a child process arms another event through the real mutation.
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "outbox-")), "t.db");
    const a1 = new Database(file, { timeout: 5000 }); a1.pragma("journal_mode = WAL"); a1.pragma("foreign_keys = ON"); runMigrations(a1);
    const e1 = Number(a1.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-02','A','k1','AAA')`).run().lastInsertRowid);
    const e2 = Number(a1.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-03','B','k2','BBB')`).run().lastInsertRowid);
    armWorksheet(a1, e1);                                                                  // gen 1
    a1.prepare("BEGIN IMMEDIATE").run();                                                   // hold the write lock
    const child = spawn(process.execPath, ["--import", "tsx", "-e",
      `import Database from "better-sqlite3"; import { armWorksheet } from "./lib/mutations/earnings-worksheet-flags";
       const db = new Database(${JSON.stringify(file)}, { timeout: 5000 }); db.pragma("foreign_keys = ON");
       process.stdout.write(String(armWorksheet(db, ${e2})));`], { cwd: process.cwd() });
    let out = ""; child.stdout.on("data", (d) => { out += String(d); });
    await new Promise((r) => setTimeout(r, 400));                                          // child is now blocked on the lock
    a1.prepare("COMMIT").run();
    const code = await new Promise<number>((r) => child.on("exit", (c) => r(c ?? -1)));
    expect(code).toBe(0);
    expect(out).toBe("true");
    const gens = (a1.prepare(`SELECT generation FROM cloud_outbox ORDER BY generation`).all() as { generation: number }[]).map((r) => r.generation);
    expect(gens).toEqual([1, 2]);                                                          // never a UNIQUE violation, never a duplicate
  });
});
```
(`deleteCalendarEvent` is imported from `@/lib/mutations/calendar`. The child runs under `--import tsx` so the `@/` alias is NOT available there — the child imports by relative path from the repo root, which is why `cwd: process.cwd()` matters. Give this `it` a 15 s timeout.)

```ts
// tests/earnings/cloud-outbox.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { drainCloudOutbox } from "@/lib/earnings/cloud-outbox";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); });
const seedArmed = () => { const id = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-02','ACME','k','ACME')`).run().lastInsertRowid); armWorksheet(db, id); return id; };

describe("drainCloudOutbox", () => {
  it("posts unsent rows in generation order with the secret header and marks sent_at on 2xx", async () => {
    seedArmed();
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> }); return new Response("{}", { status: 200 }); });
    const out = await drainCloudOutbox(db, { fetchFn: fetchFn as unknown as typeof fetch, workerUrl: "https://w.example", secret: "s3" });
    expect(out).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(calls[0].url).toBe("https://w.example/internal/armed-events");
    expect(calls[0].headers["X-Cron-Secret"]).toBe("s3");
    expect(calls[0].body).toEqual({ generation: 1, entries: [expect.objectContaining({ symbol: "ACME" })] });
    expect(db.prepare(`SELECT sent_at IS NOT NULL AS sent FROM cloud_outbox`).get()).toEqual({ sent: 1 });
  });
  it("a failure leaves the row unsent with send_error and stops the drain; the next call retries", async () => {
    seedArmed();
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 })).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await drainCloudOutbox(db, { fetchFn, workerUrl: "https://w", secret: "s" })).toEqual({ sent: 0, failed: 1, skipped: null });
    expect(db.prepare(`SELECT sent_at, send_error FROM cloud_outbox`).get()).toEqual({ sent_at: null, send_error: "HTTP 500" });
    expect(await drainCloudOutbox(db, { fetchFn, workerUrl: "https://w", secret: "s" })).toEqual({ sent: 1, failed: 0, skipped: null });
  });
  it("no Worker config → skipped, nothing marked", async () => {
    seedArmed();
    expect(await drainCloudOutbox(db, { workerUrl: null, secret: null })).toEqual({ sent: 0, failed: 0, skipped: "no-worker-config" });
  });
  it("[C-8] overlapping drains serialise: two concurrent callers produce one strictly increasing POST sequence", async () => {
    const a = seedArmed();
    db.prepare(`UPDATE calendar_events SET release_time = '16:30' WHERE id = ?`).run(a);
    db.transaction(() => writeArmedEventsOutboxRow(db)).immediate();          // gen 2
    const seen: number[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => { seen.push((JSON.parse(String(init.body)) as { generation: number }).generation); await new Promise((r) => setTimeout(r, 5)); return new Response("{}", { status: 200 }); });
    await Promise.all([drainCloudOutbox(db, { fetchFn, workerUrl: "https://w", secret: "s" }), drainCloudOutbox(db, { fetchFn, workerUrl: "https://w", secret: "s" })]);
    expect(seen).toEqual([1, 2]);                                             // never [1,1,2,2] or [1,2,1]
  });
});
```
(`writeArmedEventsOutboxRow` is imported from `@/lib/earnings/cloud-outbox` in this file.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/armed-events-projection.test.ts tests/earnings/cloud-outbox.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the projection**

```ts
// lib/earnings/armed-events-projection.ts
import type Database from "better-sqlite3";
import { addDays } from "@/lib/calendar/date-utils";

export const ARMED_EVENTS_KIND = "armed-events";
/** Tombstones are carried while event_date >= today - TOMBSTONE_LOOKBACK_DAYS (D7). */
const TOMBSTONE_LOOKBACK_DAYS = 2;

export interface ArmedEventProjection {
  eventId: number;
  symbol: string;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  sourceKey: string;
  source: string;
  consensusValue: string | null;
  expectedImpact: string | null;
  securityId: number | null;
  /** Vendor EPS from the event's 'finnhub' bogey row, basis unspecified (D1). */
  epsConsensusVendor: number | null;
  removed?: true;
  /** ISO instant the tombstone was first written (D7 48-hour retention). */
  removedAt?: string;
}
export interface ArmedEventsPayload { generation: number; entries: ArmedEventProjection[] }
/** The exact key set the projection may carry — asserted by the data-flow contract test and used by the Worker's strict parser. */
export const ARMED_EVENT_PROJECTION_KEYS = ["eventId", "symbol", "eventDate", "eventTime", "releaseTime", "sourceKey", "source", "consensusValue", "expectedImpact", "securityId", "epsConsensusVendor", "removed", "removedAt"] as const;
const TOMBSTONE_RETENTION_MS = 48 * 3_600_000;

interface ArmedRow {
  eventId: number; symbol: string; eventDate: string; eventTime: string | null; releaseTime: string | null;
  sourceKey: string; source: string; consensusValue: string | null; expectedImpact: string | null;
  securityId: number | null; epsConsensusVendor: number | null;
}

export function readArmedGeneration(db: Database.Database): number {
  const row = db.prepare(`SELECT COALESCE(MAX(generation), 0) AS g FROM cloud_outbox WHERE kind = ?`).get(ARMED_EVENTS_KIND) as { g: number };
  return row.g;
}

function readPreviousEntries(db: Database.Database): ArmedEventProjection[] {
  const row = db.prepare(`SELECT payload_json FROM cloud_outbox WHERE kind = ? ORDER BY generation DESC LIMIT 1`).get(ARMED_EVENTS_KIND) as { payload_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.payload_json) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as ArmedEventProjection[]) : [];
  } catch { return []; }
}

export function buildArmedEventsEntries(db: Database.Database, opts: { today: string; nowMs?: number }): ArmedEventProjection[] {
  const nowMs = opts.nowMs ?? Date.now();
  const live = db.prepare(
    `SELECT f.event_id AS eventId, ce.symbol, ce.event_date AS eventDate, ce.event_time AS eventTime,
            ce.release_time AS releaseTime, ce.source_key AS sourceKey, ce.source, ce.consensus_value AS consensusValue,
            ce.expected_impact AS expectedImpact, ce.security_id AS securityId,
            (SELECT b.eps_consensus_vendor FROM earnings_bogeys b WHERE b.event_id = ce.id AND b.source = 'finnhub' ORDER BY b.id LIMIT 1) AS epsConsensusVendor
       FROM earnings_worksheet_flags f
       JOIN calendar_events ce ON ce.id = f.event_id
      WHERE ce.event_type = 'earnings' AND ce.symbol IS NOT NULL AND COALESCE(ce.superseded, 0) = 0
      ORDER BY ce.event_date, f.event_id`,
  ).all() as ArmedRow[];
  const liveIds = new Set(live.map((r) => r.eventId));
  const cutoff = addDays(opts.today, -TOMBSTONE_LOOKBACK_DAYS);
  const tombstones: ArmedEventProjection[] = [];
  for (const prev of readPreviousEntries(db)) {
    if (liveIds.has(prev.eventId)) continue;                 // armed again → not removed
    const removedAt = prev.removedAt ?? new Date(nowMs).toISOString();   // first tombstone for this event: stamp now
    const fresh = nowMs - Date.parse(removedAt) < TOMBSTONE_RETENTION_MS;
    if (prev.eventDate < cutoff && !fresh) continue;         // aged out on BOTH rules (D7 revised)
    tombstones.push({ ...prev, removed: true, removedAt });
  }
  return [...live.map((r) => ({ ...r })), ...tombstones];
}

/** D10: two entry lists are "the same projection" when they serialise identically ignoring `removedAt`. */
export function sameProjection(a: ArmedEventProjection[], b: ArmedEventProjection[]): boolean {
  const norm = (xs: ArmedEventProjection[]) => JSON.stringify(xs.map(({ removedAt, ...rest }) => { void removedAt; return rest; }));
  return norm(a) === norm(b);
}
```

- [ ] **Step 4: Implement the writer + sender**

```ts
// lib/earnings/cloud-outbox.ts
import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { ARMED_EVENTS_KIND, buildArmedEventsEntries, readArmedGeneration, type ArmedEventsPayload } from "./armed-events-projection";

const DEFAULT_TIMEOUT_MS = 3000;

/** Call INSIDE a write transaction (IMMEDIATE, or a deferred one that has already written — the
 *  RESERVED lock makes MAX(generation) stable). D10: identical projection → no row. */
export function writeArmedEventsOutboxRow(db: Database.Database, opts: { today?: string; nowMs?: number } = {}): { generation: number; written: boolean } {
  if (!db.inTransaction) throw new Error("writeArmedEventsOutboxRow must run inside a transaction");
  const current = readArmedGeneration(db);
  const entries = buildArmedEventsEntries(db, { today: opts.today ?? todayET(), nowMs: opts.nowMs });
  const previous = db.prepare(`SELECT payload_json FROM cloud_outbox WHERE kind = ? ORDER BY generation DESC LIMIT 1`).get(ARMED_EVENTS_KIND) as { payload_json: string } | undefined;
  if (previous && sameProjection((JSON.parse(previous.payload_json) as ArmedEventsPayload).entries, entries)) {
    return { generation: current, written: false };
  }
  const generation = current + 1;
  const payload: ArmedEventsPayload = { generation, entries };
  db.prepare(`INSERT INTO cloud_outbox (kind, generation, payload_json) VALUES (?, ?, ?)`).run(ARMED_EVENTS_KIND, generation, JSON.stringify(payload));
  return { generation, written: true };
}

/** [C-8] One drain at a time per process: overlapping callers (sweep tick + a route's post-commit
 *  attempt) chain onto the running drain instead of racing generations onto the wire. */
let drainChain: Promise<unknown> = Promise.resolve();

export interface OutboxSenderDeps {
  fetchFn?: typeof fetch;
  workerUrl?: string | null;
  secret?: string | null;
  timeoutMs?: number;
}

export function drainCloudOutbox(
  db: Database.Database,
  deps: OutboxSenderDeps = {},
): Promise<{ sent: number; failed: number; skipped: "no-worker-config" | null }> {
  const next = drainChain.catch(() => {}).then(() => drainCloudOutboxUnlocked(db, deps));
  drainChain = next;
  return next;
}

async function drainCloudOutboxUnlocked(
  db: Database.Database,
  deps: OutboxSenderDeps,
): Promise<{ sent: number; failed: number; skipped: "no-worker-config" | null }> {
  const workerUrl = deps.workerUrl === undefined ? (process.env.WORKER_MARKER_URL ?? null) : deps.workerUrl;
  const secret = deps.secret === undefined ? (process.env.CRON_SHARED_SECRET ?? null) : deps.secret;
  if (!workerUrl || !secret) return { sent: 0, failed: 0, skipped: "no-worker-config" };
  const fetchFn = deps.fetchFn ?? fetch;
  const rows = db.prepare(
    `SELECT id, generation, payload_json FROM cloud_outbox WHERE kind = ? AND sent_at IS NULL ORDER BY generation ASC`,
  ).all(ARMED_EVENTS_KIND) as Array<{ id: number; generation: number; payload_json: string }>;
  let sent = 0;
  for (const row of rows) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${workerUrl.replace(/\/$/, "")}/internal/armed-events`, {
        method: "POST",
        headers: { "X-Cron-Secret": secret, "Content-Type": "application/json" },
        body: row.payload_json,
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      db.prepare(`UPDATE cloud_outbox SET sent_at = datetime('now'), send_error = NULL WHERE id = ?`).run(row.id);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE cloud_outbox SET send_error = ? WHERE id = ?`).run(message.slice(0, 200), row.id);
      return { sent, failed: 1, skipped: null };   // in-order: never send N+1 before N
    } finally {
      clearTimeout(timer);
    }
  }
  return { sent, failed: 0, skipped: null };
}
```
The Worker ignores a generation ≤ the one it holds (Task 8), so a retry of an already-applied row is harmless.

- [ ] **Step 5: Mutations write the row inside their own transaction**

`lib/mutations/earnings-worksheet-flags.ts`:
```ts
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";

// [C-9] IMMEDIATE: the generation is allocated under the write lock, so two connections
// (Electron server + a script, or the sweep + a route) serialise on the busy timeout
// instead of colliding on UNIQUE(kind, generation).
export function armWorksheet(db: Database.Database, eventId: number): boolean {
  return db.transaction(() => {
    const r = db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?) ON CONFLICT(event_id) DO NOTHING`).run(eventId);
    if (r.changes > 0) writeArmedEventsOutboxRow(db);
    return r.changes > 0;
  }).immediate();
}
export function disarmWorksheet(db: Database.Database, eventId: number): boolean {
  return db.transaction(() => {
    const r = db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(eventId);
    if (r.changes > 0) writeArmedEventsOutboxRow(db);
    return r.changes > 0;
  }).immediate();
}
```
(`db.transaction(fn).immediate()` is better-sqlite3's API for `BEGIN IMMEDIATE`; when `armWorksheet` is called from inside an outer transaction — the tests do this — better-sqlite3 runs it as a savepoint, which is fine.)

[C-7] `deleteCalendarEvent` (`lib/mutations/calendar.ts:831`, already transactional): inside its `txn`, before the `DELETE FROM calendar_events`, read `const wasArmed = isEventArmed(db, id);` and after the delete `if (wasArmed) writeArmedEventsOutboxRow(db, { today: opts.today });` — the flag has cascaded away, so the projection lacks the event and the writer emits the tombstone.
`lib/mutations/calendar.ts` — `insertCalendarEvent` (line 700) keeps its body unchanged: a freshly inserted manual row is never armed, so the arm that follows it writes the outbox row. `updateCalendarEvent` (line 750) gains a transaction and writes the row only when the edited event is armed (its projection changed). Replace the tail of the function — from the `if (fields.length === 0) return true;` line through `return result.changes > 0;` — with:

```ts
  if (fields.length === 0) return true; // no-op update
  return db.transaction(() => {
    const result = db
      .prepare(`UPDATE calendar_events SET ${fields.join(", ")} WHERE id = ? AND source = 'manual'`)
      .run(...values, input.id);
    // v2 slice A: an armed event's projection (date, slot, release time, consensus) just changed —
    // the Worker delta must carry the new shape. Unarmed edits write nothing.
    if (result.changes > 0 && isEventArmed(db, input.id)) writeArmedEventsOutboxRow(db);
    return result.changes > 0;
  })();
```
(`fields` / `values` are the arrays the function already builds; keep the existing UPDATE statement text exactly — the block above shows the shape, the SQL string stays whatever lines 780-800 hold today.) Imports: `import { isEventArmed } from "@/lib/queries/earnings-worksheet-flags";` and `import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";`. `correctEarningsEventDate` writes the row from inside `mergeEarningsEventState` (Task 7). Test (extend `tests/mutations/calendar-manual.test.ts` or the file that already covers `updateCalendarEvent`): editing an armed manual event's `release_time` adds one `cloud_outbox` row whose newest entry carries the new `releaseTime`; editing an unarmed one adds none.

- [ ] **Step 6: Sweep hook + post-commit attempts**

`lib/calendar/email-sweep.ts` line 135, directly after `reconcileCloudSentAudits`:
```ts
  // ── Cloud outbox drain (v2 slice A): armed-events delta to the Worker ──
  let outboxSent = 0;
  try {
    outboxSent = (await drainCloudOutbox(db)).sent;
  } catch (err) {
    console.warn("[earnings-sweep] cloud outbox drain failed:", err);
  }
```
and add `outboxSent` to `SweepSummary` + the return object (line 370-380).

Routes — after the mutation returns, before the response, in `app/api/earnings/worksheet/route.ts` (arm/disarm), `app/api/calendar/events/route.ts` (POST/PATCH) and `app/api/earnings/correct-date/route.ts`:
```ts
    try { await drainCloudOutbox(db, { timeoutMs: 2000 }); } catch (err) { console.warn("[cloud-outbox] post-commit drain failed:", err); }
```
(awaited with a 2s cap so a dead Worker costs at most 2s; the sweep retries).

- [ ] **Step 7: Run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/armed-events-projection.test.ts tests/earnings/cloud-outbox.test.ts tests/earnings/worksheet.test.ts tests/mutations tests/api/earnings-worksheet*.test.ts tests/calendar/email-sweep.test.ts`
Expected: PASS. (Existing arm/disarm tests still pass — the outbox insert is invisible to them.)

- [ ] **Step 8: Commit**

```bash
printf 'feat(cloud): armed-events outbox — full-list projection with tombstones, generation-ordered drain to the Worker, mutations write in-transaction (v2 slice A §4.1 cloud)\n' > /tmp/m.txt
git commit lib/earnings/armed-events-projection.ts lib/earnings/cloud-outbox.ts lib/mutations/earnings-worksheet-flags.ts lib/mutations/calendar.ts lib/calendar/email-sweep.ts app/api/earnings/worksheet/route.ts app/api/calendar/events/route.ts app/api/earnings/correct-date/route.ts tests/earnings/armed-events-projection.test.ts tests/earnings/cloud-outbox.test.ts -F /tmp/m.txt
```

---

### Task 7: Merge registry — `mergeEarningsEventState`, A's table rules, wired into both correction paths

**Files:**
- Create: `lib/earnings/event-merge.ts`
- Modify: `lib/mutations/calendar.ts:632-654` (call after the repoint block, before the deletes)
- Modify: `lib/calendar/reconcile-earnings-dates.ts:483-520` (call after `repointDependents(...)` inside `apply`)
- Test: `tests/earnings/event-merge.test.ts`, extend `tests/mutations/correct-earnings-event.test.ts` and `tests/calendar/reconcile-earnings-dates.test.ts`

**Interfaces:**
- Consumes: the registry contract (verbatim block above); `writeArmedEventsOutboxRow` (Task 6); tables from Task 1.
- Produces: `registerEventMergeHandler`, `mergeEarningsEventState`, `listEventMergeHandlers`, `__resetEventMergeHandlersForTests` exactly as the contract; A's built-in rules for `earnings_worksheet_flags`, `earnings_prepare_steps`, `earnings_bogey_scans`, `earnings_bogeys` (collision rule), and the `cloud_outbox` row. `earnings_emails` / `earnings_email_skips` stay on the existing repoint statements (spec: "existing repoint rules kept unchanged").

- [ ] **Step 1: Write the failing tests (one `it` per matrix row)**

```ts
// tests/earnings/event-merge.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { mergeEarningsEventState, registerEventMergeHandler, listEventMergeHandlers, __resetEventMergeHandlersForTests } from "@/lib/earnings/event-merge";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); __resetEventMergeHandlersForTests(); });
afterEach(() => __resetEventMergeHandlersForTests());
const seed = (symbol: string, date: string) => Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings',?,?,?,?)`).run(date, symbol, `k:${symbol}:${date}`, symbol).lastInsertRowid);
const step = (eventId: number, name: string, status: string, fp: string, attempts = 0) =>
  db.prepare(`INSERT INTO earnings_prepare_steps (event_id, step, status, input_fingerprint, attempts) VALUES (?,?,?,?,?)`).run(eventId, name, status, fp, attempts);
const scan = (eventId: number, articleId: number, status: string) =>
  db.prepare(`INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status) VALUES (?,?,1,?)`).run(eventId, articleId, status);

describe("mergeEarningsEventState — A's merge matrix (spec §4.1)", () => {
  it("flags: target keeps its row; printed_at is the non-null side; donor flag deleted", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    armWorksheet(db, donor); db.prepare(`UPDATE earnings_worksheet_flags SET printed_at = '2026-09-01 10:00:00' WHERE event_id = ?`).run(donor);
    armWorksheet(db, target);
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(db.prepare(`SELECT event_id, printed_at FROM earnings_worksheet_flags`).all()).toEqual([{ event_id: target, printed_at: "2026-09-01 10:00:00" }]);
    expect(report.handlers.map((h) => h.name)).toContain("builtin:worksheet_flags");
  });
  it("flags: an armed donor moving onto an unarmed target arms the target", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    armWorksheet(db, donor);
    db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(db.prepare(`SELECT event_id FROM earnings_worksheet_flags`).all()).toEqual([{ event_id: target }]);
  });
  it("prepare steps: equal fingerprints keep the more advanced status; differing fingerprints reset to pending/0", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    step(donor, "intel", "done", "fpA", 1); step(target, "intel", "failed", "fpA", 3);
    step(donor, "con_id", "done", "fpX", 1); step(target, "con_id", "pending", "fpY", 0);
    step(donor, "consensus_row", "done", "fpC", 1);            // absent on target → moves
    db.transaction(() => mergeEarningsEventState(db, donor, target))();
    const rows = db.prepare(`SELECT step, status, attempts, input_fingerprint FROM earnings_prepare_steps WHERE event_id = ? ORDER BY step`).all(target);
    expect(rows).toEqual([
      { step: "con_id", status: "pending", attempts: 0, input_fingerprint: null },
      { step: "consensus_row", status: "done", attempts: 1, input_fingerprint: "fpC" },
      { step: "intel", status: "done", attempts: 1, input_fingerprint: "fpA" },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_prepare_steps WHERE event_id = ?`).get(donor)).toEqual({ n: 0 });
  });
  it("scan ledger: terminal precedence hit > no_numbers > error > claimed; a donor hit is never lost", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    db.prepare(`INSERT INTO research_sources (name) VALUES ('src')`).run();
    for (const id of [1, 2, 3]) db.prepare(`INSERT INTO research_articles (id, source_id, subject, received_at, raw_text) VALUES (?, 1, 's', '2026-09-01', 'x')`).run(id);
    scan(donor, 1, "hit"); scan(target, 1, "claimed");
    scan(donor, 2, "error"); scan(target, 2, "no_numbers");
    scan(donor, 3, "no_numbers");
    db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(db.prepare(`SELECT article_id, status FROM earnings_bogey_scans WHERE event_id = ? ORDER BY article_id`).all(target))
      .toEqual([{ article_id: 1, status: "hit" }, { article_id: 2, status: "no_numbers" }, { article_id: 3, status: "no_numbers" }]);
  });
  it("bogeys: existing repoint kept; on a (source, source_label) collision the newer uploaded_at wins field-by-field where the other is null", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    upsertBogey(db, { event_id: target, source: "newsletter", source_label: "Desk Notes 8/21", eps_consensus: 0.60, revenue_consensus_usd: null });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-21 09:00:00' WHERE event_id = ?`).run(target);
    upsertBogey(db, { event_id: donor, source: "newsletter", source_label: "Desk Notes 8/21", eps_consensus: null, revenue_consensus_usd: 1.5e9, guidance_notes: "product rev 1.49B" });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-25 09:00:00' WHERE event_id = ?`).run(donor);
    upsertBogey(db, { event_id: donor, source: "manual", source_label: "desk", eps_consensus: 0.62 });   // no collision → repoints
    db.transaction(() => mergeEarningsEventState(db, donor, target))();
    const rows = db.prepare(`SELECT source, source_label, eps_consensus, revenue_consensus_usd, guidance_notes FROM earnings_bogeys WHERE event_id = ? ORDER BY source`).all(target);
    expect(rows).toEqual([
      { source: "manual", source_label: "desk", eps_consensus: 0.62, revenue_consensus_usd: null, guidance_notes: null },
      { source: "newsletter", source_label: "Desk Notes 8/21", eps_consensus: 0.60, revenue_consensus_usd: 1.5e9, guidance_notes: "product rev 1.49B" },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE event_id = ?`).get(donor)).toEqual({ n: 0 });
  });
  it("[C-13] reports changed=true only when something moved, merged, or was deleted; it never writes the outbox itself", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    expect(db.transaction(() => mergeEarningsEventState(db, donor, target))().changed).toBe(false);
    armWorksheet(db, donor);                                    // gen 1
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(report.changed).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cloud_outbox`).get()).toEqual({ n: 1 });   // still only the arm's row
  });
  it("[C-5] email audit: a donor's delivered recap replaces the target's failed row; a live in_progress claim is never touched; a skip on either side survives", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    const email = (eventId: number, phase: string, error: string | null) =>
      db.prepare(`INSERT INTO earnings_emails (event_id, phase, sent_at, error) VALUES (?, ?, datetime('now'), ?)`).run(eventId, phase, error);
    email(donor, "recap", null); email(target, "recap", "provider 500");          // delivered donor vs failed target → donor wins
    email(donor, "preview", "sent-by-cloud"); email(target, "preview", "in_progress");   // live claim → untouched
    db.prepare(`INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'recap', datetime('now'))`).run(donor);
    db.transaction(() => mergeEarningsEventState(db, donor, target))();
    const rows = db.prepare(`SELECT event_id, phase, error FROM earnings_emails ORDER BY phase, event_id`).all();
    expect(rows).toEqual([
      { event_id: donor, phase: "preview", error: "sent-by-cloud" },   // stays on the donor (dies with the cascade later)
      { event_id: target, phase: "preview", error: "in_progress" },
      { event_id: target, phase: "recap", error: null },              // the delivered row, re-homed
    ]);
    expect(db.prepare(`SELECT event_id FROM earnings_email_skips`).all()).toEqual([{ event_id: target }]);
  });
  it("[C-6] a winning donor value carries its provenance onto the surviving row", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    upsertBogey(db, { event_id: target, source: "pdf_upload", source_label: "sheet", eps_consensus: null, raw_pdf_r2_key: "r2/old.pdf", ai_extraction_model: "m-old" });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-20 09:00:00' WHERE event_id = ?`).run(target);
    upsertBogey(db, { event_id: donor, source: "pdf_upload", source_label: "sheet", eps_consensus: 0.61, raw_pdf_r2_key: "r2/new.pdf", ai_extraction_model: "m-new" });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-25 09:00:00' WHERE event_id = ?`).run(donor);
    db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(db.prepare(`SELECT eps_consensus, raw_pdf_r2_key, ai_extraction_model FROM earnings_bogeys WHERE event_id = ?`).get(target))
      .toEqual({ eps_consensus: 0.61, raw_pdf_r2_key: "r2/new.pdf", ai_extraction_model: "m-new" });
  });
  it("registered handlers run after the built-ins, in registration order, and duplicates throw", () => {
    const donor = seed("ACME", "2026-09-02"); const target = seed("ACME", "2026-09-03");
    const order: string[] = [];
    registerEventMergeHandler("b", () => { order.push("b"); return [{ table: "t", moved: 1, merged: 0, deleted: 0, notes: [] }]; });
    registerEventMergeHandler("c", () => { order.push("c"); return []; });
    expect(() => registerEventMergeHandler("b", () => [])).toThrow(/duplicate/);
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(order).toEqual(["b", "c"]);
    expect(listEventMergeHandlers()).toEqual(["b", "c"]);
    expect(report.handlers.at(-2)).toEqual({ name: "b", tables: [{ table: "t", moved: 1, merged: 0, deleted: 0, notes: [] }] });
  });
});
```
(`research_sources` / `research_articles` NOT NULL columns: copy the seed from `tests/earnings/extract-newsletter-bogeys.test.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/event-merge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the registry and built-ins**

```ts
// lib/earnings/event-merge.ts
import type Database from "better-sqlite3";
import { bootstrapEarningsRegistries, __isBootstrapSuppressedForTests } from "./registry-bootstrap";   // lazy: called, never evaluated-into

export interface EventMergeContext { db: Database.Database; donorEventId: number; targetEventId: number; }
export interface EventMergeTableResult { table: string; moved: number; merged: number; deleted: number; notes: string[]; }
export type EventMergeHandler = (ctx: EventMergeContext) => EventMergeTableResult[];
export interface EventMergeReport { donorEventId: number; targetEventId: number; handlers: Array<{ name: string; tables: EventMergeTableResult[] }>; changed: boolean; }

const handlers = new Map<string, EventMergeHandler>();

export function registerEventMergeHandler(name: string, handler: EventMergeHandler): void {
  if (handlers.has(name)) throw new Error(`event-merge: duplicate handler "${name}"`);
  handlers.set(name, handler);
}
export function listEventMergeHandlers(): string[] { return [...handlers.keys()]; }
/** Clears the registry AND suppresses the lazy bootstrap for this process (tests own the registry). */
export function __resetEventMergeHandlersForTests(): void { handlers.clear(); __isBootstrapSuppressedForTests(true); }

// [C-12] Full lattice: a live claim on the target outranks a donor's failure; done outranks all.
// A moved donor-only row keeps the donor's fingerprint on purpose: the runner recomputes the
// fingerprint against the TARGET event on its next pass and resets the row when it differs.
const STATUS_RANK: Record<string, number> = { pending: 0, failed: 1, claimed: 2, done: 3 };
const BOGEY_PROVENANCE = ["source_url", "raw_pdf_r2_key", "research_document_id", "research_article_id", "ai_extraction_model"] as const;
const DELIVERED_EMAIL_SQL = `(error IS NULL OR error = 'sent-by-cloud')`;
const SCAN_RANK: Record<string, number> = { claimed: 0, error: 1, no_numbers: 2, hit: 3 };
const BOGEY_CONTENT = ["eps_consensus", "eps_whisper", "revenue_consensus_usd", "revenue_whisper_usd", "expected_move_pct", "segment_breakdown_json", "guidance_notes", "notes", "eps_consensus_vendor", "extra_metrics_json"] as const;

function mergeWorksheetFlags({ db, donorEventId, targetEventId }: EventMergeContext): EventMergeTableResult {
  const donor = db.prepare(`SELECT printed_at FROM earnings_worksheet_flags WHERE event_id = ?`).get(donorEventId) as { printed_at: string | null } | undefined;
  if (!donor) return { table: "earnings_worksheet_flags", moved: 0, merged: 0, deleted: 0, notes: [] };
  const target = db.prepare(`SELECT printed_at FROM earnings_worksheet_flags WHERE event_id = ?`).get(targetEventId) as { printed_at: string | null } | undefined;
  if (target) {
    db.prepare(`UPDATE earnings_worksheet_flags SET printed_at = COALESCE(printed_at, ?) WHERE event_id = ?`).run(donor.printed_at, targetEventId);
    db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(donorEventId);
    return { table: "earnings_worksheet_flags", moved: 0, merged: 1, deleted: 1, notes: [] };
  }
  db.prepare(`UPDATE earnings_worksheet_flags SET event_id = ? WHERE event_id = ?`).run(targetEventId, donorEventId);
  return { table: "earnings_worksheet_flags", moved: 1, merged: 0, deleted: 0, notes: [] };
}

function mergePrepareSteps({ db, donorEventId, targetEventId }: EventMergeContext): EventMergeTableResult {
  const rows = db.prepare(`SELECT step, status, input_fingerprint, attempts, last_error FROM earnings_prepare_steps WHERE event_id = ?`).all(donorEventId) as Array<{ step: string; status: string; input_fingerprint: string | null; attempts: number; last_error: string | null }>;
  let moved = 0, merged = 0;
  for (const d of rows) {
    const t = db.prepare(`SELECT status, input_fingerprint FROM earnings_prepare_steps WHERE event_id = ? AND step = ?`).get(targetEventId, d.step) as { status: string; input_fingerprint: string | null } | undefined;
    if (!t) {
      db.prepare(`UPDATE earnings_prepare_steps SET event_id = ? WHERE event_id = ? AND step = ?`).run(targetEventId, donorEventId, d.step);
      moved += 1; continue;
    }
    if (t.input_fingerprint === d.input_fingerprint) {
      if ((STATUS_RANK[d.status] ?? 0) > (STATUS_RANK[t.status] ?? 0)) {
        db.prepare(`UPDATE earnings_prepare_steps SET status = ?, attempts = ?, last_error = ?, claim_token = NULL, claimed_at = NULL, updated_at = datetime('now') WHERE event_id = ? AND step = ?`).run(d.status, d.attempts, d.last_error, targetEventId, d.step);
      }
    } else {
      db.prepare(`UPDATE earnings_prepare_steps SET status = 'pending', attempts = 0, input_fingerprint = NULL, last_error = NULL, claim_token = NULL, claimed_at = NULL, updated_at = datetime('now') WHERE event_id = ? AND step = ?`).run(targetEventId, d.step);
    }
    db.prepare(`DELETE FROM earnings_prepare_steps WHERE event_id = ? AND step = ?`).run(donorEventId, d.step);
    merged += 1;
  }
  return { table: "earnings_prepare_steps", moved, merged, deleted: merged, notes: [] };
}

function mergeBogeyScans({ db, donorEventId, targetEventId }: EventMergeContext): EventMergeTableResult {
  const rows = db.prepare(`SELECT article_id, extractor_version, status, model_id, attempts, scanned_at FROM earnings_bogey_scans WHERE event_id = ?`).all(donorEventId) as Array<{ article_id: number; extractor_version: number; status: string; model_id: string | null; attempts: number; scanned_at: string | null }>;
  let moved = 0, merged = 0;
  for (const d of rows) {
    const t = db.prepare(`SELECT status FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ? AND extractor_version = ?`).get(targetEventId, d.article_id, d.extractor_version) as { status: string } | undefined;
    if (!t) {
      db.prepare(`UPDATE earnings_bogey_scans SET event_id = ? WHERE event_id = ? AND article_id = ? AND extractor_version = ?`).run(targetEventId, donorEventId, d.article_id, d.extractor_version);
      moved += 1; continue;
    }
    if ((SCAN_RANK[d.status] ?? 0) > (SCAN_RANK[t.status] ?? 0)) {
      db.prepare(`UPDATE earnings_bogey_scans SET status = ?, model_id = ?, attempts = ?, scanned_at = ?, claim_token = NULL, updated_at = datetime('now') WHERE event_id = ? AND article_id = ? AND extractor_version = ?`).run(d.status, d.model_id, d.attempts, d.scanned_at, targetEventId, d.article_id, d.extractor_version);
    }
    db.prepare(`DELETE FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ? AND extractor_version = ?`).run(donorEventId, d.article_id, d.extractor_version);
    merged += 1;
  }
  return { table: "earnings_bogey_scans", moved, merged, deleted: merged, notes: [] };
}

function mergeBogeys({ db, donorEventId, targetEventId }: EventMergeContext): EventMergeTableResult {
  // Existing rule first: plain repoint where no (source, source_label) collision exists.
  const moved = db.prepare(`UPDATE OR IGNORE earnings_bogeys SET event_id = ? WHERE event_id = ?`).run(targetEventId, donorEventId).changes;
  // Collisions: donor rows still on donorEventId. Newer uploaded_at wins field-by-field where the other is null.
  const leftovers = db.prepare(`SELECT * FROM earnings_bogeys WHERE event_id = ?`).all(donorEventId) as Array<Record<string, unknown>>;
  let merged = 0;
  for (const d of leftovers) {
    const t = db.prepare(`SELECT * FROM earnings_bogeys WHERE event_id = ? AND source = ? AND source_label IS ?`).get(targetEventId, d.source, d.source_label) as Record<string, unknown>;
    const newer = String(d.uploaded_at) > String(t.uploaded_at) ? d : t;
    const older = newer === d ? t : d;
    // [C-6] Values and provenance travel together: the row whose numbers win (the newer one)
    // also supplies source_url / PDF key / research ids / extraction model, so no figure is
    // left attributed to a document it did not come from.
    const cols = [...BOGEY_CONTENT, ...BOGEY_PROVENANCE];
    const sets = cols.map((c) => `${c} = ?`).join(", ");
    const values = [
      ...BOGEY_CONTENT.map((c) => (newer[c] ?? older[c] ?? null)),
      ...BOGEY_PROVENANCE.map((c) => (newer[c] ?? null)),
    ];
    db.prepare(`UPDATE earnings_bogeys SET ${sets}, uploaded_at = ? WHERE id = ?`).run(...values, newer.uploaded_at, t.id);
    db.prepare(`DELETE FROM earnings_bogeys WHERE id = ?`).run(d.id);
    merged += 1;
  }
  return { table: "earnings_bogeys", moved, merged, deleted: merged, notes: [] };
}

/** [C-5] Spec: "a sent phase on either side counts as sent for the target, so nothing refires";
 *  a skip on either side counts as skipped. UPDATE OR IGNORE alone would keep a target's
 *  FAILED row over a donor's DELIVERED one and re-open the send. Live 'in_progress' claims
 *  are never touched (tri-state rule). */
function mergeEmailAudit({ db, donorEventId, targetEventId }: EventMergeContext): EventMergeTableResult[] {
  const out: EventMergeTableResult[] = [];
  let moved = 0, merged = 0, deleted = 0;
  const donorEmails = db.prepare(`SELECT id, phase, error FROM earnings_emails WHERE event_id = ? AND (error IS NULL OR error != 'in_progress')`).all(donorEventId) as Array<{ id: number; phase: string; error: string | null }>;
  for (const d of donorEmails) {
    const t = db.prepare(`SELECT id, error FROM earnings_emails WHERE event_id = ? AND phase = ?`).get(targetEventId, d.phase) as { id: number; error: string | null } | undefined;
    if (!t) { db.prepare(`UPDATE earnings_emails SET event_id = ? WHERE id = ?`).run(targetEventId, d.id); moved += 1; continue; }
    if (t.error === "in_progress") continue;                                   // live claim on the target: leave both
    const donorDelivered = d.error === null || d.error === "sent-by-cloud";
    const targetDelivered = t.error === null || t.error === "sent-by-cloud";
    if (donorDelivered && !targetDelivered) {                                  // delivered history wins
      db.prepare(`DELETE FROM earnings_emails WHERE id = ?`).run(t.id);
      db.prepare(`UPDATE earnings_emails SET event_id = ? WHERE id = ?`).run(targetEventId, d.id);
      merged += 1; deleted += 1;
    }                                                                         // else: target keeps its row; donor dies with the cascade
  }
  out.push({ table: "earnings_emails", moved, merged, deleted, notes: [] });
  const skipMoved = db.prepare(`UPDATE OR IGNORE earnings_email_skips SET event_id = ? WHERE event_id = ?`).run(targetEventId, donorEventId).changes;
  out.push({ table: "earnings_email_skips", moved: skipMoved, merged: 0, deleted: 0, notes: ["skip on either side → target skipped (UNIQUE keeps the target's row)"] });
  return out;
}

export function mergeEarningsEventState(db: Database.Database, donorEventId: number, targetEventId: number): EventMergeReport {
  if (!db.inTransaction) throw new Error("mergeEarningsEventState must run inside a transaction");
  // [C-14] Self-bootstrapping (aligned with slice B's M3): no entrypoint can forget to load
  // slice B's handler, so prints/documents/lines can never silently stay on a doomed event.
  bootstrapEarningsRegistries();
  const ctx: EventMergeContext = { db, donorEventId, targetEventId };
  const report: EventMergeReport = { donorEventId, targetEventId, handlers: [], changed: false };
  report.handlers.push({ name: "builtin:worksheet_flags", tables: [mergeWorksheetFlags(ctx)] });
  report.handlers.push({ name: "builtin:prepare_steps", tables: [mergePrepareSteps(ctx)] });
  report.handlers.push({ name: "builtin:bogey_scans", tables: [mergeBogeyScans(ctx)] });
  report.handlers.push({ name: "builtin:bogeys", tables: [mergeBogeys(ctx)] });
  report.handlers.push({ name: "builtin:email_audit", tables: mergeEmailAudit(ctx) });
  for (const [name, fn] of handlers) report.handlers.push({ name, tables: fn(ctx) });
  // [C-13] The CALLER writes the outbox row — once per outer transaction, only when something changed.
  report.changed = report.handlers.some((h) => h.tables.some((t) => t.moved + t.merged + t.deleted > 0));
  return report;
}
```

- [ ] **Step 4: Wire both correction paths**

`lib/mutations/calendar.ts` — inside `runCorrection`, replace the bogey line of the repoint loop (lines 632-643) so bogeys are handled by the merge and the audit tables keep their existing statements:
```ts
    let bogeysMigrated = 0;
    let auditRowsMigrated = 0;
    let anyChanged = false;
    for (const row of doomedRows) {
      // Registry merge (v2 slice A): flags, prepare steps, scan ledger, bogeys (repoint +
      // collision rule), email/skip audit (delivered history wins, in_progress untouched),
      // every registered slice handler. Replaces the two UPDATE OR IGNORE loops that were here.
      const report = mergeEarningsEventState(db, row.id, newEventId);
      anyChanged ||= report.changed;
      bogeysMigrated += report.handlers.find((h) => h.name === "builtin:bogeys")?.tables[0].moved ?? 0;
      auditRowsMigrated += report.handlers.find((h) => h.name === "builtin:email_audit")?.tables.reduce((n, t) => n + t.moved + t.merged, 0) ?? 0;
    }
```
and after the delete loop (step 3, before `return { ok: true, … }`): `if (anyChanged) writeArmedEventsOutboxRow(db);` — [C-13] one outbox row per correction, only when the projection moved. Import `writeArmedEventsOutboxRow` and `mergeEarningsEventState` (which self-bootstraps the registries, [C-14]).

`lib/calendar/reconcile-earnings-dates.ts` — [C-4] `createDependentRepointer` is left EXACTLY as it is (its `repointBogeys` statement also serves `repointDependentsBeforeDelete`, the delete-before-cascade path). Inside `apply`, after `repointDependents(r.id, res.canonicalId, canonicalEventDate);` add:
```ts
          // v2 slice A: the repointer moved what it could; the registry merge handles the
          // (source, source_label) collisions it skipped, flags, steps, scans, and B's tables.
          anyChanged ||= mergeEarningsEventState(db, r.id, res.canonicalId).changed;
```
with `let anyChanged = false;` declared before `const apply = db.transaction(...)` and, as the LAST statement inside the `apply` callback, `if (anyChanged) writeArmedEventsOutboxRow(db, { today });`. `mergeBogeys`'s leading `UPDATE OR IGNORE` is a no-op for rows the repointer already moved, so the two compose. Already-superseded donors revisited on later syncs produce `changed: false` and write nothing (idempotent at the outbox level).

Extend the two existing test files with one case each: an armed doomed row → the surviving row is armed afterwards and exactly one new `cloud_outbox` row exists; re-running the same reconcile adds no row.

- [ ] **Step 5: Run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/event-merge.test.ts tests/mutations/correct-earnings-event.test.ts tests/calendar/reconcile-earnings-dates.test.ts tests/api/earnings-correct-date*.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
printf 'feat(earnings): event-merge registry with A table rules (flags, prepare steps, scan ledger, bogey collisions, outbox), wired into correctEarningsEventDate + reconcileEarningsDates (v2 slice A)\n' > /tmp/m.txt
git commit lib/earnings/event-merge.ts lib/mutations/calendar.ts lib/calendar/reconcile-earnings-dates.ts tests/earnings/event-merge.test.ts tests/mutations/correct-earnings-event.test.ts tests/calendar/reconcile-earnings-dates.test.ts -F /tmp/m.txt
```

---

### Task 8: Snapshot v11 and the Worker — resolver, endpoint, consumers, parity

**Files:**
- Modify: `scripts/snapshot-state-to-r2.ts:49-50,125-140,346-366,444-463,621-660` (v11 fields; reads in one transaction; `armedGeneration`)
- Modify: `workers/cron/src/state.ts:161-186,258-322` (types)
- Create: `workers/cron/src/armed-events.ts`
- Modify: `workers/cron/src/index.ts` (add `POST /internal/armed-events` beside `/internal/mac-recent-earnings-sweep` at line 579)
- Modify: `workers/cron/src/fallback-earnings.ts:294-323,582-630`; `workers/cron/src/todays-reporters.ts:69-97` (+ chip); `workers/cron/src/calendar-enrich.ts:216-219` (D5)
- Test: `tests/earnings/armed-events-projection.test.ts` (extend: snapshot slice), `workers/cron/test/armed-events.test.ts`, `workers/cron/test/fallback-earnings.test.ts` (extend), `workers/cron/test/todays-reporters.test.ts` (extend), `workers/cron/test/marker-endpoint.test.ts` (extend)

**Interfaces:**
- Consumes: `buildArmedEventsEntries`, `readArmedGeneration`, `ArmedEventProjection` (Task 6); Worker `todayET` (`workers/cron/src/dst.ts:40`).
- Produces:

```ts
// scripts/snapshot-state-to-r2.ts — Snapshot gains:
//   schemaVersion: 11;  armedGeneration: number;  armedEvents: ArmedEventProjection[];
//   earningsBogeys[].eps_consensus_vendor: number | null  (also carried in the SELECT at line 353)

// workers/cron/src/state.ts
export interface ArmedEventEntry { eventId: number; symbol: string; eventDate: string; eventTime: string | null; releaseTime: string | null; sourceKey: string; source: string; consensusValue: string | null; expectedImpact: string | null; securityId: number | null; epsConsensusVendor: number | null; removed?: true; }
export interface ArmedEventsDelta { generation: number; entries: ArmedEventEntry[] }
// Snapshot: schemaVersion union gains 11; armedGeneration?: number; armedEvents?: ArmedEventEntry[]; SnapshotBogey.eps_consensus_vendor?: number | null

// workers/cron/src/armed-events.ts
export const ARMED_EVENTS_KV_KEY = "armed-events";
export interface EffectiveCalendar { events: CalendarEventRow[]; armedEventIds: Set<number>; source: "snapshot" | "snapshot+delta" | "degraded-v10" }
export function effectiveCalendarEvents(snapshot: Snapshot, delta: ArmedEventsDelta | null): EffectiveCalendar;
export async function readArmedEventsDelta(kv: KVNamespace): Promise<ArmedEventsDelta | null>;
/** Read-compare-write: applies only when body.generation > stored generation. */
export async function applyArmedEventsDelta(kv: KVNamespace, body: unknown): Promise<{ applied: boolean; generation: number }>;
export function isCoveredInCloud(snapshot: Snapshot, eff: EffectiveCalendar, event: { id: number; symbol: string | null }): boolean;
```

- [ ] **Step 1: Write the failing Worker tests**

```ts
// workers/cron/test/armed-events.test.ts
import { describe, it, expect, vi } from "vitest";
import { effectiveCalendarEvents, applyArmedEventsDelta, readArmedEventsDelta, isCoveredInCloud } from "../src/armed-events";
import type { Snapshot, ArmedEventEntry } from "../src/state";

const entry = (eventId: number, symbol: string, eventDate: string, extra: Partial<ArmedEventEntry> = {}): ArmedEventEntry => ({
  eventId, symbol, eventDate, eventTime: "AMC", releaseTime: "16:15", sourceKey: `manual:${symbol}:${eventDate}:earnings`, source: "manual",
  consensusValue: null, expectedImpact: null, securityId: null, epsConsensusVendor: null, ...extra,
});
const snap = (over: Partial<Snapshot>): Snapshot => ({
  schemaVersion: 11, snapshotDate: "2026-09-02", generatedAt: "", heldSymbols: ["HELDCO"], settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
  calendarEvents: [{ id: 1, source: "finnhub", event_type: "earnings", event_date: "2026-09-03", event_time: "AMC", title: "HELDCO", description: null, security_id: null, symbol: "HELDCO", expected_impact: null, consensus_estimate: null, previous_value: null, raw_json: null }],
  researchSources: [], recentArticlesMeta: [], deepReadArticles: [], armedGeneration: 3, armedEvents: [], ...over,
} as unknown as Snapshot);

function makeKv() {
  const store = new Map<string, string>();
  return { store, kv: { get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => { store.set(k, v); }), delete: vi.fn(), list: vi.fn(async () => ({ keys: [] })) } as unknown as KVNamespace };
}

describe("effectiveCalendarEvents (spec §4.1 cloud)", () => {
  it("an armed-only event added after the snapshot reaches the effective collection and is covered", () => {
    const s = snap({});
    const eff = effectiveCalendarEvents(s, { generation: 4, entries: [entry(77, "ACME", "2026-09-02")] });
    expect(eff.source).toBe("snapshot+delta");
    expect(eff.events.map((e) => e.id)).toEqual([1, 77]);
    expect(eff.armedEventIds).toEqual(new Set([77]));
    expect(isCoveredInCloud(s, eff, { id: 77, symbol: "ACME" })).toBe(true);
    expect(isCoveredInCloud(s, eff, { id: 1, symbol: "HELDCO" })).toBe(true);     // held, unchanged
  });
  it("a tombstone removes a delta-only event and un-arms a snapshot event", () => {
    const s = snap({ armedEvents: [entry(1, "HELDCO", "2026-09-03")] });
    const eff = effectiveCalendarEvents(s, { generation: 4, entries: [entry(77, "ACME", "2026-09-02", { removed: true }), entry(1, "HELDCO", "2026-09-03", { removed: true })] });
    expect(eff.events.map((e) => e.id)).toEqual([1]);
    expect(eff.armedEventIds).toEqual(new Set());
  });
  it("a stale delta (generation <= snapshot.armedGeneration) is ignored; the snapshot's own armedEvents still count", () => {
    const s = snap({ armedEvents: [entry(5, "BETA", "2026-09-03")] });
    const eff = effectiveCalendarEvents(s, { generation: 3, entries: [entry(77, "ACME", "2026-09-02")] });
    expect(eff.source).toBe("snapshot");
    expect(eff.events.map((e) => e.id)).toEqual([1, 5]);
    expect(eff.armedEventIds).toEqual(new Set([5]));
  });
  it("a v10 snapshot ignores the delta and degrades to held+watchlist", () => {
    const s = snap({ schemaVersion: 10, armedGeneration: undefined, armedEvents: undefined } as Partial<Snapshot>);
    const eff = effectiveCalendarEvents(s, { generation: 9, entries: [entry(77, "ACME", "2026-09-02")] });
    expect(eff.source).toBe("degraded-v10");
    expect(eff.events.map((e) => e.id)).toEqual([1]);
    expect(isCoveredInCloud(s, eff, { id: 77, symbol: "ACME" })).toBe(false);
  });
  it("a replaced projection wins over the snapshot row of the same id", () => {
    const s = snap({});
    const eff = effectiveCalendarEvents(s, { generation: 4, entries: [entry(1, "HELDCO", "2026-09-04", { releaseTime: "07:00", eventTime: "BMO" })] });
    expect(eff.events.find((e) => e.id === 1)).toMatchObject({ event_date: "2026-09-04", event_time: "BMO", release_time: "07:00" });
  });
});

describe("applyArmedEventsDelta (KV read-compare-write)", () => {
  it("applies a higher generation, refuses a lower or equal one, rejects a malformed body", async () => {
    const { kv, store } = makeKv();
    expect(await applyArmedEventsDelta(kv, { generation: 2, entries: [] })).toEqual({ applied: true, generation: 2 });
    expect(await applyArmedEventsDelta(kv, { generation: 2, entries: [] })).toEqual({ applied: false, generation: 2 });
    expect(await applyArmedEventsDelta(kv, { generation: 1, entries: [] })).toEqual({ applied: false, generation: 2 });
    expect(await applyArmedEventsDelta(kv, { generation: 5, entries: [entry(77, "ACME", "2026-09-02")] })).toEqual({ applied: true, generation: 5 });
    expect(JSON.parse(store.get("armed-events")!)).toEqual({ generation: 5, entries: [entry(77, "ACME", "2026-09-02")] });
    await expect(applyArmedEventsDelta(kv, { generation: "x" })).rejects.toThrow(/generation/);
    expect(await readArmedEventsDelta(kv)).toEqual({ generation: 5, entries: [entry(77, "ACME", "2026-09-02")] });
  });
});
```
Extend `workers/cron/test/fallback-earnings.test.ts`: with `makeEnv()` whose KV holds `armed-events` `{generation: 9, entries:[entry(77,"ACME", <today>)]}` and a v11 snapshot (`armedGeneration: 3`) that does NOT contain event 77, the preview candidate set includes 77 (mirror of the Mac test in Task 4). Extend `todays-reporters.test.ts`: an armed-only reporter renders the `armed` chip. Extend `marker-endpoint.test.ts`: `POST /internal/armed-events` without the secret → 401; with it → `{ ok: true, applied: true, generation }`.

- [ ] **Step 2: Run to verify failure**

Run: `cd workers/cron && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/armed-events.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the Worker module**

```ts
// workers/cron/src/armed-events.ts
import type { ArmedEventEntry, ArmedEventsDelta, CalendarEventRow, Snapshot } from "./state";
import { issuerSiblings } from "./issuer-family";

export const ARMED_EVENTS_KV_KEY = "armed-events";

export interface EffectiveCalendar {
  events: CalendarEventRow[];
  armedEventIds: Set<number>;
  source: "snapshot" | "snapshot+delta" | "degraded-v10";
}

function projectionToRow(e: ArmedEventEntry): CalendarEventRow {
  return {
    id: e.eventId, source: e.source, event_type: "earnings", event_date: e.eventDate, event_time: e.eventTime,
    title: `${e.symbol} earnings`, description: null, security_id: e.securityId, symbol: e.symbol,
    expected_impact: e.expectedImpact, consensus_estimate: e.consensusValue, previous_value: null, raw_json: null,
    release_time: e.releaseTime, source_key: e.sourceKey, consensus_value: e.consensusValue, superseded: 0,
  };
}

export function effectiveCalendarEvents(snapshot: Snapshot, delta: ArmedEventsDelta | null): EffectiveCalendar {
  const byId = new Map<number, CalendarEventRow>();
  for (const e of snapshot.calendarEvents ?? []) byId.set(e.id, e);
  if (snapshot.schemaVersion < 11 || snapshot.armedGeneration == null) {
    return { events: [...byId.values()], armedEventIds: new Set(), source: "degraded-v10" };
  }
  const armed = new Set<number>();
  for (const e of snapshot.armedEvents ?? []) {
    armed.add(e.eventId);
    if (!byId.has(e.eventId)) byId.set(e.eventId, projectionToRow(e));
  }
  let source: EffectiveCalendar["source"] = "snapshot";
  if (delta && delta.generation > snapshot.armedGeneration) {
    source = "snapshot+delta";
    const snapshotIds = new Set((snapshot.calendarEvents ?? []).map((e) => e.id));
    for (const e of delta.entries) {
      if (e.removed) {
        armed.delete(e.eventId);
        if (!snapshotIds.has(e.eventId)) byId.delete(e.eventId);   // delta-only event: gone
        continue;
      }
      armed.add(e.eventId);
      byId.set(e.eventId, { ...(byId.get(e.eventId) ?? projectionToRow(e)), ...projectionToRow(e) });
    }
  }
  return { events: [...byId.values()].sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id), armedEventIds: armed, source };
}

export function isCoveredInCloud(snapshot: Snapshot, eff: EffectiveCalendar, event: { id: number; symbol: string | null }): boolean {
  if (eff.armedEventIds.has(event.id)) return true;
  if (!event.symbol) return false;
  const held = new Set((snapshot.heldSymbols ?? []).map((s) => s.toUpperCase()));
  const watch = new Set((snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()));
  return issuerSiblings(event.symbol).some((s) => held.has(s.toUpperCase()) || watch.has(s.toUpperCase()));
}

export async function readArmedEventsDelta(kv: KVNamespace): Promise<ArmedEventsDelta | null> {
  const raw = await kv.get(ARMED_EVENTS_KV_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { generation?: unknown; entries?: unknown };
    if (typeof parsed.generation !== "number" || !Array.isArray(parsed.entries)) return null;
    return { generation: parsed.generation, entries: parsed.entries as ArmedEventEntry[] };
  } catch { return null; }
}

export const ARMED_EVENTS_MAX_ENTRIES = 500;
export const ARMED_EVENTS_MAX_BODY_BYTES = 256 * 1024;

/** [C-19] Strict, allowlisted parse — the KV value can only ever hold the projection shape. */
function parseEntry(raw: unknown): ArmedEventEntry {
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === "string" ? (r[k] as string).slice(0, 200) : null);
  const num = (k: string): number | null => (typeof r[k] === "number" && Number.isFinite(r[k] as number) ? (r[k] as number) : null);
  if (!Number.isInteger(r.eventId) || typeof r.symbol !== "string" || typeof r.eventDate !== "string" || typeof r.sourceKey !== "string" || typeof r.source !== "string") {
    throw new Error("armed-events: entry missing eventId/symbol/eventDate/sourceKey/source");
  }
  const entry: ArmedEventEntry = {
    eventId: r.eventId as number, symbol: (r.symbol as string).slice(0, 16).toUpperCase(), eventDate: (r.eventDate as string).slice(0, 10),
    eventTime: str("eventTime"), releaseTime: str("releaseTime"), sourceKey: (r.sourceKey as string).slice(0, 200), source: (r.source as string).slice(0, 32),
    consensusValue: str("consensusValue"), expectedImpact: str("expectedImpact"), securityId: num("securityId"), epsConsensusVendor: num("epsConsensusVendor"),
  };
  if (r.removed === true) { entry.removed = true; if (typeof r.removedAt === "string") entry.removedAt = r.removedAt.slice(0, 40); }
  return entry;                                                     // every other key is dropped
}

export async function applyArmedEventsDelta(kv: KVNamespace, body: unknown): Promise<{ applied: boolean; generation: number }> {
  const b = body as { generation?: unknown; entries?: unknown };
  if (!b || typeof b.generation !== "number" || !Number.isInteger(b.generation) || !Array.isArray(b.entries)) {
    throw new Error("armed-events: body needs integer generation and entries[]");
  }
  if (b.entries.length > ARMED_EVENTS_MAX_ENTRIES) throw new Error(`armed-events: too many entries (${b.entries.length} > ${ARMED_EVENTS_MAX_ENTRIES})`);
  const entries = b.entries.map(parseEntry);
  const current = await readArmedEventsDelta(kv);
  const held = current?.generation ?? 0;
  if (b.generation <= held) return { applied: false, generation: held };
  await kv.put(ARMED_EVENTS_KV_KEY, JSON.stringify({ generation: b.generation, entries }));
  return { applied: true, generation: b.generation };
}
```
The `index.ts` handler checks `Number(request.headers.get("content-length") ?? 0) > ARMED_EVENTS_MAX_BODY_BYTES` → 413 before parsing. Test additions in `armed-events.test.ts`: an entry with an extra key `notes` is stored WITHOUT it; a 501-entry body throws; a missing `sourceKey` throws.

```ts
```
`state.ts`: add `ArmedEventEntry`, `ArmedEventsDelta`; `schemaVersion: 1|…|10|11`; `armedGeneration?: number; armedEvents?: ArmedEventEntry[]`; `SnapshotBogey.eps_consensus_vendor?: number | null`; extend the version comment block with `v11 — armedEvents + armedGeneration (delta watermark) + bogey eps_consensus_vendor`.

`index.ts`, after the `/internal/mac-recent-earnings-sweep` handler (line 579-584):
```ts
    if (request.method === "POST" && url.pathname === "/internal/armed-events") {
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "invalid json" }, { status: 400 }); }
      try {
        const r = await applyArmedEventsDelta(env.CRON_KV, body);
        return Response.json({ ok: true, ...r });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : "bad body" }, { status: 400 });
      }
    }
```

- [ ] **Step 4: Consumers read the resolver**

`fallback-earnings.ts` — both functions gain the effective collection; `findCandidatesFromSnapshot` already receives `kv`, `buildWrapCluster` gains a `delta: ArmedEventsDelta | null` parameter (its caller reads the delta once per run via `readArmedEventsDelta(kv)`):
```ts
  const eff = effectiveCalendarEvents(snapshot, delta);
  const muted = new Set((snapshot.earningsSettings?.mutedSymbols ?? []).map((s) => s.toUpperCase()));
  for (const e of eff.events) {
    if (e.event_type !== "earnings" || !e.symbol || e.superseded) continue;
    … (date / slot checks unchanged) …
    if (!isCoveredInCloud(snapshot, eff, e)) continue;
    const family = issuerSiblings(e.symbol).map((s) => s.toUpperCase());
    if (family.some((f) => muted.has(f))) continue;
```
`todays-reporters.ts:69-97`: candidates come from `effectiveCalendarEvents(snapshot, delta).events`; the chip becomes `held` / `wl` / `armed` (when `eff.armedEventIds.has(e.id)`) / `rt` / `""` in the same precedence as the Mac (`lib/digest/todays-reporters.ts`, Task 5); `buildTodaysReportersBlock` gains a third parameter `delta: ArmedEventsDelta | null = null` and its one caller passes the delta it read. `todays-reporters-render.ts` renders `armed` — mirror the Mac renderer text exactly.
`calendar-enrich.ts:216-219` (D5): `const events = effectiveCalendarEvents(snapshot, await readArmedEventsDelta(env.CRON_KV)).events as unknown as SnapshotCalendarEvent[];` — the push gate at 356-364 is NOT edited.

- [ ] **Step 5: Snapshot script v11**

`scripts/snapshot-state-to-r2.ts`: import `{ buildArmedEventsEntries, readArmedGeneration }` from `@/lib/earnings/armed-events-projection` (the script already imports `@/lib/...` modules, e.g. `getHeldStockSymbols`); change `schemaVersion: 10` → `11` at both sites; add `eps_consensus_vendor` to the bogey SELECT (line 353) and to the local `earningsBogeys` element type (line 125); wrap the body of `buildSnapshot` in `db.transaction(() => { … })()` so every read — including `armedGeneration: readArmedGeneration(db)` and `armedEvents: buildArmedEventsEntries(db, { today: todayET() })` — happens in one read transaction (a read-only connection accepts `BEGIN`). Replace the three UTC helpers `today()/daysAgo()/daysAhead()` (lines 199-209) with `todayET()` + `addDays()` — the snapshot's `snapshotDate` is a user-facing ET day.

Extend `tests/earnings/armed-events-projection.test.ts` with: `buildArmedEventsEntries` output is byte-for-byte what the script embeds (assert the projection's key set equals the `ArmedEventProjection` keys — the data-flow contract: never notes, reads, callouts, or document text).

- [ ] **Step 6: Run both projects**

Run: `cd workers/cron && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` then `cd ../.. && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings tests/scripts tests/workers`
Expected: PASS (all Worker tests; `tests/scripts/snapshot-state-to-r2.test.ts` unchanged — it re-implements v3 queries).

- [ ] **Step 7: Commit**

```bash
printf 'feat(cloud): snapshot v11 (armedEvents, armedGeneration, vendor EPS) + Worker armed-events resolver, /internal/armed-events, consumers on the effective collection (v2 slice A cloud parity; D2, D5)\n' > /tmp/m.txt
git commit scripts/snapshot-state-to-r2.ts workers/cron/src/state.ts workers/cron/src/armed-events.ts workers/cron/src/index.ts workers/cron/src/fallback-earnings.ts workers/cron/src/todays-reporters.ts workers/cron/src/todays-reporters-render.ts workers/cron/src/calendar-enrich.ts workers/cron/test/armed-events.test.ts workers/cron/test/fallback-earnings.test.ts workers/cron/test/todays-reporters.test.ts workers/cron/test/marker-endpoint.test.ts tests/earnings/armed-events-projection.test.ts -F /tmp/m.txt
```

---

### Task 9: Prepare registry + runner (claims by CAS, fingerprint reset, attempt cap), route + sweep wiring

**Files:**
- Create: `lib/earnings/prepare-armed-event.ts`
- Modify: `app/api/earnings/worksheet/route.ts:44-77` (arm enqueues + kicks the pass; GET returns step rows)
- Modify: `lib/calendar/email-sweep.ts:343` (run pass after the worksheet auto-print pass)
- Test: `tests/earnings/prepare-armed-event.test.ts`, `tests/api/earnings-worksheet-route.test.ts` (extend or create), `tests/calendar/email-sweep.test.ts` (extend)

**Interfaces:**
- Consumes: the registry contract (verbatim block above); `earnings_prepare_steps` (Task 1); `isEventArmed` (Task 2); `todayET`.
- Produces: every export in the contract block, plus `PREPARE_MAX_ATTEMPTS = 5`, `PREPARE_CLAIM_STALE_MS = 5 * 60_000`. The route's GET payload gains `prepare: Record<number, PrepareStepRow[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/earnings/prepare-armed-event.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import {
  registerPrepareStep, listPrepareSteps, __resetPrepareStepsForTests, enqueuePrepareSteps, runPrepareSteps,
  getPrepareStepRows, stableHash, PREPARE_MAX_ATTEMPTS,
} from "@/lib/earnings/prepare-armed-event";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); __resetPrepareStepsForTests(); });
afterEach(() => __resetPrepareStepsForTests());
const seedArmed = (date = "2026-09-03") => { const id = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings',?,'BETA','k'||?,'BETA')`).run(date, date).lastInsertRowid); armWorksheet(db, id); return id; };
const row = (eventId: number, step: string) => db.prepare(`SELECT status, attempts, input_fingerprint, claim_token, last_error FROM earnings_prepare_steps WHERE event_id = ? AND step = ?`).get(eventId, step) as { status: string; attempts: number; input_fingerprint: string | null; claim_token: string | null; last_error: string | null };

describe("prepare registry + runner (spec §4.1 prepare work table)", () => {
  it("enqueue inserts one pending row per registered step and is idempotent", () => {
    registerPrepareStep("a", { fingerprint: () => "fa", run: async () => ({ status: "done" }) });
    registerPrepareStep("b", { fingerprint: () => "fb", run: async () => ({ status: "done" }) });
    expect(() => registerPrepareStep("a", { fingerprint: () => "", run: async () => ({ status: "done" }) })).toThrow(/duplicate/);
    const id = seedArmed();
    expect(enqueuePrepareSteps(db, id)).toBe(2);
    expect(enqueuePrepareSteps(db, id)).toBe(0);
    expect(listPrepareSteps()).toEqual(["a", "b"]);
    expect(getPrepareStepRows(db, id).map((r) => [r.step, r.status])).toEqual([["a", "pending"], ["b", "pending"]]);
  });

  it("runs pending steps, records the fingerprint, and a 'pending' outcome does not count as an attempt", async () => {
    let twsUp = false;
    registerPrepareStep("con_id", { fingerprint: () => "f1", run: async () => (twsUp ? { status: "done" } : { status: "pending", reason: "TWS offline" }) });
    const id = seedArmed(); enqueuePrepareSteps(db, id);
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({ ran: 1, done: 0, pending: 1, failed: 0, skipped: 0 });
    expect(row(id, "con_id")).toMatchObject({ status: "pending", attempts: 0, last_error: "TWS offline", claim_token: null });
    twsUp = true;
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({ ran: 1, done: 1, pending: 0, failed: 0, skipped: 0 });
    expect(row(id, "con_id")).toMatchObject({ status: "done", attempts: 1, input_fingerprint: "f1" });
  });

  it("a failed step retries up to PREPARE_MAX_ATTEMPTS then is skipped", async () => {
    registerPrepareStep("x", { fingerprint: () => "f", run: async () => ({ status: "failed", error: "boom" }) });
    const id = seedArmed(); enqueuePrepareSteps(db, id);
    for (let i = 1; i <= PREPARE_MAX_ATTEMPTS; i++) {
      expect((await runPrepareSteps(db, { eventId: id })).failed).toBe(1);
      expect(row(id, "x")).toMatchObject({ status: "failed", attempts: i, last_error: "boom" });
    }
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({ ran: 0, done: 0, pending: 0, failed: 0, skipped: 1 });
  });

  it("a done step re-runs when its fingerprint changes (status and attempts reset atomically)", async () => {
    let fp = "v1"; let runs = 0;
    registerPrepareStep("consensus_row", { fingerprint: () => fp, run: async () => { runs += 1; return { status: "done" }; } });
    const id = seedArmed(); enqueuePrepareSteps(db, id);
    await runPrepareSteps(db, { eventId: id });
    await runPrepareSteps(db, { eventId: id });
    expect(runs).toBe(1);
    fp = "v2";
    expect(await runPrepareSteps(db, { eventId: id })).toMatchObject({ ran: 1, done: 1 });
    expect(runs).toBe(2);
    expect(row(id, "consensus_row")).toMatchObject({ status: "done", attempts: 1, input_fingerprint: "v2" });
  });

  it("a timed-out worker's finalisation is rejected by the claim token CAS", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    registerPrepareStep("slow", { fingerprint: () => "f", run: async () => { await gate; return { status: "done", note: "old worker" }; } });
    const id = seedArmed(); enqueuePrepareSteps(db, id);
    let t = 0;
    const oldRun = runPrepareSteps(db, { eventId: id, now: () => t });           // claims with token T1 at t=0
    t = 6 * 60_000;                                                              // > PREPARE_CLAIM_STALE_MS
    __resetPrepareStepsForTests();
    registerPrepareStep("slow", { fingerprint: () => "f", run: async () => ({ status: "failed", error: "new worker" }) });
    await runPrepareSteps(db, { eventId: id, now: () => t });                    // takes over: token T2, finalises failed
    release();
    await oldRun;                                                                // old finalisation must be a no-op
    // attempts = 1 (the dead claim, counted at takeover) + 1 (the new worker's failed run) [C-11]
    expect(row(id, "slow")).toMatchObject({ status: "failed", last_error: "new worker", attempts: 2 });
  });

  it("[C-11] a fingerprint change never clears a LIVE claim", async () => {
    let fp = "v1";
    registerPrepareStep("s", { fingerprint: () => fp, run: async () => ({ status: "done" }) });
    const id = seedArmed(); enqueuePrepareSteps(db, id);
    db.prepare(`UPDATE earnings_prepare_steps SET status = 'claimed', claim_token = 'live', claimed_at = datetime('now'), input_fingerprint = 'v1' WHERE event_id = ?`).run(id);
    fp = "v2";
    expect(await runPrepareSteps(db, { eventId: id })).toEqual({ ran: 0, done: 0, pending: 0, failed: 0, skipped: 1 });
    expect(row(id, "s")).toMatchObject({ status: "claimed", claim_token: "live" });
  });

  it("runs only events on/after today (ET) when no eventId is given; superseded and unarmed events are skipped", async () => {
    registerPrepareStep("a", { fingerprint: () => "f", run: async () => ({ status: "done" }) });
    const future = seedArmed("2026-09-05"); const past = seedArmed("2026-08-20");
    enqueuePrepareSteps(db, future); enqueuePrepareSteps(db, past);
    const out = await runPrepareSteps(db, { now: () => Date.parse("2026-09-02T18:00:00Z") });
    expect(out.done).toBe(1);
    expect(row(future, "a").status).toBe("done");
    expect(row(past, "a").status).toBe("pending");
  });

  it("[C-10] a sweep-style run inserts the missing rows for an armed future event that was never enqueued (durable path)", async () => {
    registerPrepareStep("a", { fingerprint: () => "f", run: async () => ({ status: "done" }) });
    const id = seedArmed("2026-09-05");                                          // armed, NO enqueuePrepareSteps
    const out = await runPrepareSteps(db, { now: () => Date.parse("2026-09-02T18:00:00Z") });
    expect(out).toMatchObject({ ran: 1, done: 1 });
    expect(getPrepareStepRows(db, id).map((r) => [r.step, r.status])).toEqual([["a", "done"]]);
  });

  it("stableHash is deterministic and order-sensitive", () => {
    expect(stableHash([1, "a", null])).toBe(stableHash([1, "a", null]));
    expect(stableHash([1, "a"])).not.toBe(stableHash(["a", 1]));
    expect(stableHash([1])).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/prepare-armed-event.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// lib/earnings/prepare-armed-event.ts
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { todayET } from "@/lib/calendar/date-utils";
import { bootstrapEarningsRegistries, __isBootstrapSuppressedForTests } from "./registry-bootstrap";   // lazy: called, never evaluated-into

export type PrepareStepStatus = "pending" | "claimed" | "done" | "failed";
export type PrepareStepOutcome =
  | { status: "done"; note?: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; error: string };
export interface PrepareStepContext { now: () => number; }
export interface PrepareStepDefinition {
  fingerprint: (db: Database.Database, eventId: number) => string;
  run: (db: Database.Database, eventId: number, ctx: PrepareStepContext) => Promise<PrepareStepOutcome>;
}
export interface PrepareStepRow { event_id: number; step: string; status: PrepareStepStatus; input_fingerprint: string | null; attempts: number; last_error: string | null; updated_at: string; }
export interface PrepareRunReport { ran: number; done: number; pending: number; failed: number; skipped: number; }

export const PREPARE_MAX_ATTEMPTS = 5;
export const PREPARE_CLAIM_STALE_MS = 5 * 60_000;

const steps = new Map<string, PrepareStepDefinition>();

export function registerPrepareStep(name: string, def: PrepareStepDefinition): void {
  if (steps.has(name)) throw new Error(`prepare: duplicate step "${name}"`);
  steps.set(name, def);
}
export function listPrepareSteps(): string[] { return [...steps.keys()]; }
/** Clears the registry AND suppresses the lazy bootstrap for this process (tests own the registry). */
export function __resetPrepareStepsForTests(): void { steps.clear(); __isBootstrapSuppressedForTests(true); }

export function stableHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function enqueuePrepareSteps(db: Database.Database, eventId: number): number {
  bootstrapEarningsRegistries();                                            // [C-14] self-bootstrap
  const ins = db.prepare(`INSERT INTO earnings_prepare_steps (event_id, step) VALUES (?, ?) ON CONFLICT(event_id, step) DO NOTHING`);
  let n = 0;
  for (const name of steps.keys()) n += ins.run(eventId, name).changes;
  return n;
}

export function getPrepareStepRows(db: Database.Database, eventId: number): PrepareStepRow[] {
  return db.prepare(`SELECT event_id, step, status, input_fingerprint, attempts, last_error, updated_at FROM earnings_prepare_steps WHERE event_id = ? ORDER BY step`).all(eventId) as PrepareStepRow[];
}

/** [C-10] One pending row per (armed future event, registered step) that is missing. Idempotent. */
export function reconcileMissingPrepareSteps(db: Database.Database, today: string): number {
  const ins = db.prepare(
    `INSERT INTO earnings_prepare_steps (event_id, step)
     SELECT f.event_id, ? FROM earnings_worksheet_flags f JOIN calendar_events ce ON ce.id = f.event_id
      WHERE ce.event_date >= ? AND COALESCE(ce.superseded, 0) = 0
     ON CONFLICT(event_id, step) DO NOTHING`,
  );
  let n = 0;
  for (const name of steps.keys()) n += ins.run(name, today).changes;
  return n;
}

// [C-11] Step side effects are idempotent upserts by construction (consensus_row upsert keyed
// on the finnhub label, newsletter bogeys preserve-upserted per issue, intel behind its TTL,
// contract-id enrich), so a stale runner whose finalisation is rejected can only REPEAT a
// write, never corrupt one — the token guards status and attempts, the upserts guard the data.

interface Runnable { event_id: number; step: string; status: PrepareStepStatus; input_fingerprint: string | null; attempts: number; claimed_at: string | null; }

/** Rows that could run now: pending, failed (< max attempts), stale claims, and done rows whose
 *  fingerprint drifted (checked in JS because the fingerprint is code-defined). */
function selectRunnable(db: Database.Database, opts: { eventId?: number; today: string }): Runnable[] {
  const where = opts.eventId != null ? `p.event_id = ?` : `ce.event_date >= ? AND COALESCE(ce.superseded, 0) = 0 AND EXISTS (SELECT 1 FROM earnings_worksheet_flags f WHERE f.event_id = ce.id)`;
  const arg = opts.eventId != null ? opts.eventId : opts.today;
  return db.prepare(
    `SELECT p.event_id, p.step, p.status, p.input_fingerprint, p.attempts, p.claimed_at
       FROM earnings_prepare_steps p JOIN calendar_events ce ON ce.id = p.event_id
      WHERE ${where}
      ORDER BY p.event_id, p.step`,
  ).all(arg) as Runnable[];
}

export async function runPrepareSteps(db: Database.Database, opts: { eventId?: number; now?: () => number } = {}): Promise<PrepareRunReport> {
  bootstrapEarningsRegistries();                                            // [C-14] self-bootstrap
  const now = opts.now ?? (() => Date.now());
  const report: PrepareRunReport = { ran: 0, done: 0, pending: 0, failed: 0, skipped: 0 };
  const ctx: PrepareStepContext = { now };
  const today = todayET(new Date(now()));
  // [C-10] Durable path: a sweep-style run (no eventId) first inserts any missing registered
  // step for every armed, unsuperseded, not-yet-past event, so an arm whose route-side enqueue
  // never happened (crash, or a step registered later) is picked up within one tick.
  if (opts.eventId == null) reconcileMissingPrepareSteps(db, today);
  for (const r of selectRunnable(db, { eventId: opts.eventId, today })) {
    const def = steps.get(r.step);
    if (!def) { report.skipped += 1; continue; }
    const fp = def.fingerprint(db, r.event_id);
    const staleBefore = new Date(now() - PREPARE_CLAIM_STALE_MS).toISOString().replace("T", " ").slice(0, 19);
    // Fingerprint drift resets status + attempts atomically, then the row is runnable again.
    // [C-11] Never clears a LIVE claim: a fresh 'claimed' row is left for its worker to finish.
    if (r.input_fingerprint != null && r.input_fingerprint !== fp) {
      const reset = db.prepare(
        `UPDATE earnings_prepare_steps SET status = 'pending', attempts = 0, last_error = NULL, claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = ? AND NOT (status = 'claimed' AND datetime(claimed_at) >= datetime(?))`,
      ).run(r.event_id, r.step, staleBefore).changes;
      if (reset === 0) { report.skipped += 1; continue; }
      r.status = "pending"; r.attempts = 0;
    }
    if (r.status === "done") { continue; }
    if (r.status === "failed" && r.attempts >= PREPARE_MAX_ATTEMPTS) { report.skipped += 1; continue; }
    const token = randomUUID();
    const claimed = db.prepare(
      `UPDATE earnings_prepare_steps
          SET status = 'claimed', claim_token = ?, claimed_at = datetime(?), updated_at = datetime('now'),
              attempts = attempts + CASE WHEN status = 'claimed' THEN 1 ELSE 0 END   -- [C-11] a stale-claim takeover counts the dead attempt
        WHERE event_id = ? AND step = ?
          AND (status IN ('pending','failed') OR (status = 'claimed' AND datetime(claimed_at) < datetime(?)))`,
    ).run(token, new Date(now()).toISOString().replace("T", " ").slice(0, 19), r.event_id, r.step, staleBefore).changes;
    if (claimed === 0) { report.skipped += 1; continue; }
    report.ran += 1;
    let outcome: PrepareStepOutcome;
    try { outcome = await def.run(db, r.event_id, ctx); }
    catch (err) { outcome = { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }; }
    // Compare-and-set on the token: a superseded worker's outcome never lands.
    const finalize = (status: PrepareStepStatus, attemptsDelta: number, lastError: string | null, fingerprint: string | null) =>
      db.prepare(
        `UPDATE earnings_prepare_steps
            SET status = ?, attempts = attempts + ?, last_error = ?, input_fingerprint = COALESCE(?, input_fingerprint),
                claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
          WHERE event_id = ? AND step = ? AND claim_token = ?`,
      ).run(status, attemptsDelta, lastError, fingerprint, r.event_id, r.step, token).changes;
    let landed = 0;
    if (outcome.status === "done") { landed = finalize("done", 1, null, fp); report.done += 1; }
    else if (outcome.status === "pending") { landed = finalize("pending", 0, outcome.reason.slice(0, 300), null); report.pending += 1; }
    else { landed = finalize("failed", 1, outcome.error.slice(0, 300), fp); report.failed += 1; }
    if (landed === 0) console.warn(`[prepare] ${r.step} for event ${r.event_id}: finalisation rejected (claim superseded)`);
  }
  return report;
}
```

- [ ] **Step 4: Route + sweep wiring**

`app/api/earnings/worksheet/route.ts` — import `enqueuePrepareSteps`, `runPrepareSteps`, `getPrepareStepRows` and the step registration module `@/lib/earnings/prepare-steps` (Task 10 creates it; until then import nothing and the registry is empty — tests for the route seed a step via `registerPrepareStep`). Arm branch:
```ts
    case "arm": {
      const armed = armWorksheet(db, body.eventId);
      const enqueued = enqueuePrepareSteps(db, body.eventId);
      // D6: kick the pass, never await it — model calls take tens of seconds; the sweep tick is the durable retry.
      void runPrepareSteps(db, { eventId: body.eventId }).catch((err) => console.warn("[worksheet] prepare pass failed:", err));
      try { await drainCloudOutbox(db, { timeoutMs: 2000 }); } catch (err) { console.warn("[cloud-outbox] post-commit drain failed:", err); }
      // D11: `armed` stays top-level (the Today client reads it); new fields ride under `data`.
      return Response.json({ success: true, armed, data: { enqueued, prepare: getPrepareStepRows(db, body.eventId) } });
    }
```
GET (line 67): add `prepare` keyed by event id: `const prepare: Record<number, PrepareStepRow[]> = {}; for (const id of eventIds) prepare[id] = getPrepareStepRows(db, id);` and return `{ success: true, flags, data: { prepare } }` (read-only — no enqueue, no reconcile on GET).

`lib/calendar/email-sweep.ts` after the worksheet auto-print pass (line 343):
```ts
  // ── Prepare pass for armed events (v2 slice A): re-runs every runnable step each tick until the event ──
  let prepared: PrepareRunReport = { ran: 0, done: 0, pending: 0, failed: 0, skipped: 0 };
  try { prepared = await runPrepareSteps(db, { now: () => (opts.now ?? new Date()).getTime() }); }
  catch (err) { console.warn("[earnings-sweep] prepare pass failed:", err); }
```
add `prepared` to `SweepSummary`. No entrypoint import is needed: `enqueuePrepareSteps`, `runPrepareSteps` and `mergeEarningsEventState` self-bootstrap through `bootstrapEarningsRegistries()` (Task 10) [C-14].

Tests: extend the route test with "arm returns `prepare` rows for a registered step and GET echoes them"; extend `tests/calendar/email-sweep.test.ts` with "a registered step on an armed future event runs once per tick and the summary reports it".

- [ ] **Step 5: Run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/prepare-armed-event.test.ts tests/api tests/calendar/email-sweep.test.ts tests/repo`
Expected: PASS (the runner selects armed events with an `EXISTS` on `earnings_worksheet_flags`, so it adds no `isEventArmed` call site; the Task 5 allowlist is unchanged by this task).

- [ ] **Step 6: Commit**

```bash
printf 'feat(earnings): prepare registry + CAS runner (claim/finalise by token, fingerprint reset, 5-attempt cap); arm enqueues + kicks; sweep re-runs each tick (v2 slice A)\n' > /tmp/m.txt
git commit lib/earnings/prepare-armed-event.ts app/api/earnings/worksheet/route.ts lib/calendar/email-sweep.ts tests/earnings/prepare-armed-event.test.ts tests/api/earnings-worksheet-route.test.ts tests/calendar/email-sweep.test.ts -F /tmp/m.txt
```

---

### Task 10: Steps `consensus_row`, `intel`, `con_id` + the registration module

**Files:**
- Create: `lib/earnings/prepare-steps/consensus-row.ts`, `lib/earnings/prepare-steps/intel.ts`, `lib/earnings/prepare-steps/con-id.ts`, `lib/earnings/prepare-steps/index.ts`
- Test: `tests/earnings/prepare-steps.test.ts`

**Interfaces:**
- Consumes: `registerPrepareStep`, `stableHash` (Task 9); `upsertBogey` with `source: "finnhub"` + `eps_consensus_vendor` (Task 1); `ensureIntelForEvents(db, events: IntelEvent[], opts?, deps?)` (`lib/earnings/intel.ts:115`, D4); `enrichSecurities(db, [securityId])` (`lib/tws/contracts.ts:93`) and `getIbApi()` (`lib/tws/client.ts:243`).
- Produces:

```ts
// lib/earnings/prepare-steps/consensus-row.ts
export const FINNHUB_BOGEY_LABEL = "Sell-side consensus (Finnhub)";
export function readVendorConsensus(rawJson: string | null): { eps: number | null; revenue: number | null } | null;
export const consensusRowStep: PrepareStepDefinition;
// lib/earnings/prepare-steps/intel.ts
export const intelStep: PrepareStepDefinition;   // deps seam: makeIntelStep(deps?: { ensure?: typeof ensureIntelForEvents })
// lib/earnings/prepare-steps/con-id.ts
export const conIdStep: PrepareStepDefinition;   // deps seam: makeConIdStep(deps?: { twsUp?: () => boolean; enrich?: typeof enrichSecurities })
// lib/earnings/prepare-steps/index.ts — side-effect module: registers consensus_row, intel, con_id, newsletter_rescan (Task 11) exactly once.
export function registerPrepareStepsOnce(): void;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/earnings/prepare-steps.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { __resetPrepareStepsForTests } from "@/lib/earnings/prepare-armed-event";
import { consensusRowStep, readVendorConsensus, FINNHUB_BOGEY_LABEL } from "@/lib/earnings/prepare-steps/consensus-row";
import { makeIntelStep } from "@/lib/earnings/prepare-steps/intel";
import { makeConIdStep } from "@/lib/earnings/prepare-steps/con-id";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); __resetPrepareStepsForTests(); });
afterEach(() => __resetPrepareStepsForTests());
const ctx = { now: () => Date.now() };
const RAW = JSON.stringify({ entry: { symbol: "GAMMA", date: "2026-09-03", hour: "", quarter: 2, year: 2027, epsEstimate: 4.75, epsActual: null, revenueEstimate: 45000000000, revenueActual: null }, history: [], finnhub_symbol: "GAMMA" });
const seed = (source: "finnhub" | "manual", rawJson: string | null, securityId: number | null = null) => Number(db.prepare(
  `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol, raw_json, security_id) VALUES (?,'earnings','2026-09-03','AMC','GAMMA','k','GAMMA',?,?)`).run(source, rawJson, securityId).lastInsertRowid);

describe("consensus_row step (spec §4.1 step 2, D1)", () => {
  it("reads the Finnhub estimate pair from raw_json only when the echoed symbol is in the event's issuer family [C-2]", () => {
    expect(readVendorConsensus(RAW, "GAMMA")).toEqual({ eps: 4.75, revenue: 45000000000 });
    expect(readVendorConsensus(null, "GAMMA")).toBeNull();
    expect(readVendorConsensus("{}", "GAMMA")).toBeNull();
    expect(readVendorConsensus(RAW.replace('"symbol":"GAMMA"', '"symbol":"GAMMA.MX"'), "GAMMA")).toBeNull();   // foreign-listing echo
    expect(readVendorConsensus(RAW, "BETA")).toBeNull();                                                      // wrong event
  });
  it("[C-2] withdrawal: when the vendor estimate disappears, the engine-owned finnhub row is deleted", async () => {
    const id = seed("finnhub", RAW);
    await consensusRowStep.run(db, id, ctx);
    db.prepare(`UPDATE calendar_events SET raw_json = ? WHERE id = ?`).run(JSON.stringify({ entry: { symbol: "GAMMA", epsEstimate: null, revenueEstimate: null }, finnhub_symbol: "GAMMA" }), id);
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done", note: "vendor consensus withdrawn; finnhub row removed" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE event_id = ?`).get(id)).toEqual({ n: 0 });
  });
  it("upserts ONE finnhub bogey row with the EPS in eps_consensus_vendor and eps_consensus NULL; revenue in revenue_consensus_usd", async () => {
    const id = seed("finnhub", RAW);
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done" });
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done" });
    const rows = db.prepare(`SELECT source, source_label, eps_consensus, eps_consensus_vendor, revenue_consensus_usd FROM earnings_bogeys WHERE event_id = ?`).all(id);
    expect(rows).toEqual([{ source: "finnhub", source_label: FINNHUB_BOGEY_LABEL, eps_consensus: null, eps_consensus_vendor: 4.75, revenue_consensus_usd: 45000000000 }]);
  });
  it("a manual event with no vendor consensus is done with a note and writes nothing", async () => {
    const id = seed("manual", null);
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done", note: "no vendor consensus on the event" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 0 });
  });
  it("fingerprint tracks the consensus fields", () => {
    const id = seed("finnhub", RAW);
    const a = consensusRowStep.fingerprint(db, id);
    db.prepare(`UPDATE calendar_events SET consensus_value = 'EPS 5.01 · Rev 45B' WHERE id = ?`).run(id);
    expect(consensusRowStep.fingerprint(db, id)).not.toBe(a);
  });
});

describe("intel step (D4)", () => {
  it("calls ensureIntelForEvents with the event's IntelEvent shape and is done", async () => {
    const ensure = vi.fn(async () => {});
    const id = seed("finnhub", RAW);
    const step = makeIntelStep({ ensure });
    expect(await step.run(db, id, ctx)).toEqual({ status: "done" });
    expect(ensure).toHaveBeenCalledWith(db, [{ id, symbol: "GAMMA", event_date: "2026-09-03", event_time: "AMC" }], { forceFresh: false });
  });
  it("a thrown ensure is a failed outcome (runner counts the attempt)", async () => {
    const id = seed("finnhub", RAW);
    const step = makeIntelStep({ ensure: vi.fn(async () => { throw new Error("IBKR 503"); }) });
    expect(await step.run(db, id, ctx)).toEqual({ status: "failed", error: "IBKR 503" });
  });
});

describe("con_id step (spec §4.1 step 4)", () => {
  const seedSecurity = (conId: number | null) => Number(db.prepare(`INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, ib_con_id) VALUES ('GAMMA','Gamma Inc','stock','equity',1,?)`).run(conId).lastInsertRowid);
  it("TWS down → pending (not an attempt), nothing called", async () => {
    const sec = seedSecurity(null); const id = seed("finnhub", RAW, sec);
    const enrich = vi.fn();
    expect(await makeConIdStep({ twsUp: () => false, enrich }).run(db, id, ctx)).toEqual({ status: "pending", reason: "TWS offline" });
    expect(enrich).not.toHaveBeenCalled();
  });
  it("conId already present → done without a TWS call", async () => {
    const sec = seedSecurity(123456); const id = seed("finnhub", RAW, sec);
    const enrich = vi.fn();
    expect(await makeConIdStep({ twsUp: () => true, enrich }).run(db, id, ctx)).toEqual({ status: "done", note: "already resolved" });
    expect(enrich).not.toHaveBeenCalled();
  });
  it("TWS up + null conId → enrichSecurities(db, [securityId]); done when the row now has a conId, failed when it still does not", async () => {
    const sec = seedSecurity(null); const id = seed("finnhub", RAW, sec);
    const enrichOk = vi.fn(async (d: Database.Database, ids: number[]) => { d.prepare(`UPDATE securities SET ib_con_id = 1 WHERE id = ?`).run(ids[0]); return []; });
    expect(await makeConIdStep({ twsUp: () => true, enrich: enrichOk }).run(db, id, ctx)).toEqual({ status: "done" });
    db.prepare(`UPDATE securities SET ib_con_id = NULL`).run();
    const enrichNo = vi.fn(async () => [{ symbol: "GAMMA", securityId: sec, enriched: false, error: "No security definition has been found for the request" }]);
    expect(await makeConIdStep({ twsUp: () => true, enrich: enrichNo }).run(db, id, ctx)).toEqual({ status: "failed", error: "No security definition has been found for the request" });
  });
  it("an event with no security row resolves the symbol first, and is done with a note when no row exists", async () => {
    const id = seed("manual", null, null);
    expect(await makeConIdStep({ twsUp: () => true, enrich: vi.fn() }).run(db, id, ctx)).toEqual({ status: "done", note: "no securities row for GAMMA" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/prepare-steps.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the three steps**

```ts
// lib/earnings/prepare-steps/consensus-row.ts
import type Database from "better-sqlite3";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

export const FINNHUB_BOGEY_LABEL = "Sell-side consensus (Finnhub)";

/** Finnhub estimates live in raw_json.entry (see calendar sync). Manual rows have none.
 *  [C-2] The symbol we QUERIED is canonical (CLAUDE.md): an entry whose `symbol` is not in the
 *  event symbol's issuer family is a foreign listing / ADR echo and is dropped — the same guard
 *  `lib/calendar/finnhub.ts:153` applies at sync time. */
export function readVendorConsensus(rawJson: string | null, eventSymbol: string | null): { eps: number | null; revenue: number | null } | null {
  if (!rawJson || !eventSymbol) return null;
  try {
    const parsed = JSON.parse(rawJson) as { entry?: { symbol?: unknown; epsEstimate?: unknown; revenueEstimate?: unknown }; finnhub_symbol?: unknown };
    const entry = parsed.entry;
    if (!entry) return null;
    const family = new Set(issuerSiblings(eventSymbol).map((s) => s.toUpperCase()));
    const echoed = typeof entry.symbol === "string" ? entry.symbol.toUpperCase() : null;
    const queried = typeof parsed.finnhub_symbol === "string" ? parsed.finnhub_symbol.toUpperCase() : null;
    if (!echoed || !family.has(echoed) || (queried && queried !== echoed)) return null;
    const eps = typeof entry.epsEstimate === "number" && Number.isFinite(entry.epsEstimate) ? entry.epsEstimate : null;
    const revenue = typeof entry.revenueEstimate === "number" && Number.isFinite(entry.revenueEstimate) ? entry.revenueEstimate : null;
    return eps == null && revenue == null ? null : { eps, revenue };
  } catch { return null; }
}

interface EventRow { symbol: string | null; source: string; raw_json: string | null; consensus_estimate: string | null; consensus_value: string | null; }
const readEvent = (db: Database.Database, eventId: number) =>
  db.prepare(`SELECT symbol, source, raw_json, consensus_estimate, consensus_value FROM calendar_events WHERE id = ?`).get(eventId) as EventRow | undefined;

export const consensusRowStep: PrepareStepDefinition = {
  fingerprint(db, eventId) {
    const e = readEvent(db, eventId);
    return stableHash(["consensus_row", 1, e?.source ?? null, readVendorConsensus(e?.raw_json ?? null, e?.symbol ?? null), e?.consensus_estimate ?? null, e?.consensus_value ?? null]);
  },
  async run(db, eventId) {
    const e = readEvent(db, eventId);
    if (!e) return { status: "failed", error: `event ${eventId} not found` };
    const vendor = readVendorConsensus(e.raw_json, e.symbol);
    if (!vendor) {
      // [C-2] The finnhub row is engine-owned: when the vendor has no (or a mismatched) estimate,
      // a stale row must not keep feeding the revenue bogey or the vendor-EPS label.
      const gone = db.prepare(`DELETE FROM earnings_bogeys WHERE event_id = ? AND source = 'finnhub'`).run(eventId).changes;
      return { status: "done", note: gone > 0 ? "vendor consensus withdrawn; finnhub row removed" : "no vendor consensus on the event" };
    }
    // D1: the vendor EPS goes to eps_consensus_vendor; eps_consensus stays NULL so
    // compileContracts can never adopt it as the adjusted-EPS expected value.
    upsertBogey(db, {
      event_id: eventId, source: "finnhub", source_label: FINNHUB_BOGEY_LABEL,
      eps_consensus: null, eps_consensus_vendor: vendor.eps, revenue_consensus_usd: vendor.revenue,
      notes: "Vendor consensus (Finnhub) — EPS basis unspecified; shown labelled, never the adjusted-EPS bogey.",
    });
    return { status: "done" };
  },
};
```

```ts
// lib/earnings/prepare-steps/intel.ts
import type Database from "better-sqlite3";
import { ensureIntelForEvents, type IntelEvent } from "@/lib/earnings/intel";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

export function makeIntelStep(deps: { ensure?: typeof ensureIntelForEvents } = {}): PrepareStepDefinition {
  const ensure = deps.ensure ?? ensureIntelForEvents;
  const read = (db: Database.Database, eventId: number) =>
    db.prepare(`SELECT id, symbol, event_date, event_time, release_time FROM calendar_events WHERE id = ?`).get(eventId) as (IntelEvent & { release_time: string | null }) | undefined;
  return {
    // Spec §4.1: intel = hash(symbol, eventDate, releaseTime) [C-16c]
    fingerprint(db, eventId) { const e = read(db, eventId); return stableHash(["intel", 1, e?.symbol ?? null, e?.event_date ?? null, e?.release_time ?? null]); },
    async run(db, eventId) {
      const e = read(db, eventId);
      if (!e || !e.symbol) return { status: "failed", error: `event ${eventId} has no symbol` };
      try { await ensure(db, [{ id: e.id, symbol: e.symbol, event_date: e.event_date, event_time: e.event_time }], { forceFresh: false }); }
      catch (err) { return { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }; }
      return { status: "done" };
    },
  };
}
export const intelStep = makeIntelStep();
```

```ts
// lib/earnings/prepare-steps/con-id.ts
import type Database from "better-sqlite3";
import { enrichSecurities } from "@/lib/tws/contracts";
import { getIbApi } from "@/lib/tws/client";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

interface SecRow { id: number; ib_con_id: number | null; }
function resolveSecurity(db: Database.Database, eventId: number): { symbol: string | null; sec: SecRow | null } {
  const e = db.prepare(`SELECT symbol, security_id FROM calendar_events WHERE id = ?`).get(eventId) as { symbol: string | null; security_id: number | null } | undefined;
  if (!e) return { symbol: null, sec: null };
  const sec = (e.security_id != null
    ? db.prepare(`SELECT id, ib_con_id FROM securities WHERE id = ?`).get(e.security_id)
    : db.prepare(`SELECT id, ib_con_id FROM securities WHERE UPPER(symbol) = UPPER(?) ORDER BY id LIMIT 1`).get(e.symbol ?? "")) as SecRow | undefined;
  return { symbol: e.symbol, sec: sec ?? null };
}

export function makeConIdStep(deps: { twsUp?: () => boolean; enrich?: typeof enrichSecurities } = {}): PrepareStepDefinition {
  const twsUp = deps.twsUp ?? (() => getIbApi() != null);
  const enrich = deps.enrich ?? enrichSecurities;
  return {
    fingerprint(db, eventId) { const { sec } = resolveSecurity(db, eventId); return stableHash(["con_id", 1, sec?.id ?? null, sec?.ib_con_id ?? null]); },
    async run(db, eventId) {
      const { symbol, sec } = resolveSecurity(db, eventId);
      if (!sec) return { status: "done", note: `no securities row for ${symbol ?? "?"}` };
      if (sec.ib_con_id != null) return { status: "done", note: "already resolved" };
      if (!twsUp()) return { status: "pending", reason: "TWS offline" };   // not an attempt (spec §4.1 step 4)
      const results = await enrich(db, [sec.id]);
      const after = db.prepare(`SELECT ib_con_id FROM securities WHERE id = ?`).get(sec.id) as { ib_con_id: number | null };
      if (after.ib_con_id != null) return { status: "done" };
      const err = results.find((r) => r.securityId === sec.id)?.error ?? "contract not resolved";
      return { status: "failed", error: err.slice(0, 300) };
    },
  };
}
export const conIdStep = makeConIdStep();
```
(Confirm `EnrichResult` carries `securityId` and `error` — `lib/tws/contracts.ts` — the sanity run on 2026-09-02 returned `{symbol, securityId, enriched, error}`.)

```ts
// lib/earnings/prepare-steps/index.ts
import { listPrepareSteps, registerPrepareStep } from "../prepare-armed-event";
import { consensusRowStep } from "./consensus-row";
import { intelStep } from "./intel";
import { conIdStep } from "./con-id";
import { newsletterRescanStep } from "./newsletter-rescan";   // Task 11

/** Idempotent: safe to call from every entry point (route, sweep, scripts). Order = run order. */
export function registerPrepareStepsOnce(): void {
  const have = new Set(listPrepareSteps());
  if (!have.has("newsletter_rescan")) registerPrepareStep("newsletter_rescan", newsletterRescanStep);
  if (!have.has("consensus_row")) registerPrepareStep("consensus_row", consensusRowStep);
  if (!have.has("intel")) registerPrepareStep("intel", intelStep);
  if (!have.has("con_id")) registerPrepareStep("con_id", conIdStep);
}
// NO top-level call: registration happens through bootstrapEarningsRegistries() (below), lazily,
// so the import cycle prepare-armed-event → registry-bootstrap → prepare-steps → prepare-armed-event
// never touches an uninitialised binding at module-evaluation time.
```

[C-14] The lazy bootstrap (aligned with slice B's M3 — B's plan states the same three call sites):
```ts
// lib/earnings/registry-bootstrap.ts
// Composition root for the two registries. Called by mergeEarningsEventState, enqueuePrepareSteps
// and runPrepareSteps before they read a registry, so no entrypoint can forget it. Idempotent.
import { registerPrepareStepsOnce } from "./prepare-steps";
// import { registerPrintWatch } from "@/lib/print-watch/register";   // slice B — enabled by the post-merge integration task

let done = false;
let suppressed = false;

export function bootstrapEarningsRegistries(): void {
  if (done || suppressed) return;
  done = true;
  registerPrepareStepsOnce();
  // registerPrintWatch();   // slice B (integration task)
}

/** Unit tests that register their own steps/handlers call this (via the two __reset helpers)
 *  so the real steps are not silently added under them. */
export function __isBootstrapSuppressedForTests(value?: boolean): boolean {
  if (value !== undefined) { suppressed = value; done = false; }
  return suppressed;
}
```
Cold-process test `tests/earnings/registry-bootstrap.test.ts` (B's plan lands its twin): `vi.resetModules()`, import ONLY `@/lib/earnings/prepare-armed-event` and `@/lib/earnings/event-merge`, call `enqueuePrepareSteps(db, eventId)` on an armed event with nothing else imported, and assert the four A step rows exist and `listPrepareSteps()` equals `["newsletter_rescan", "consensus_row", "intel", "con_id"]`; a second call registers nothing twice. After integration the same test also asserts B's `ir_baseline` step and B's merge handler name are present.

- [ ] **Step 4: Run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/prepare-steps.test.ts tests/earnings/prepare-armed-event.test.ts tests/api/earnings-worksheet-route.test.ts tests/calendar/email-sweep.test.ts`
Expected: PASS (Task 11's `newsletterRescanStep` import: create the file in Task 11 first if executing out of order, or temporarily register only three steps and add the fourth in Task 11 — the registration module's test asserts the final four).

- [ ] **Step 5: Commit**

```bash
printf 'feat(earnings): prepare steps consensus_row (vendor EPS apart, D1), intel (ensureIntelForEvents, D4), con_id (TWS-down is pending), registration module (v2 slice A)\n' > /tmp/m.txt
git commit lib/earnings/prepare-steps lib/earnings/registry-bootstrap.ts tests/earnings/prepare-steps.test.ts tests/earnings/registry-bootstrap.test.ts app/api/earnings/worksheet/route.ts lib/calendar/email-sweep.ts -F /tmp/m.txt
```

---

### Task 11: `newsletter_rescan` — per-event pure extraction path + `earnings_bogey_scans` ledger

**Files:**
- Modify: `lib/earnings/extract-newsletter-bogeys.ts` (export `NEWSLETTER_EXTRACTOR_VERSION`, add `extractBogeysFromArticleForEvent`, refactor the shared model-call + bogey-write into a private helper both paths use)
- Create: `lib/earnings/prepare-steps/newsletter-rescan.ts`
- Test: `tests/earnings/newsletter-rescan.test.ts`

**Interfaces:**
- Consumes: `buildExtractionPrompt(article, reporters)`, `parseExtractionResponse(raw)`, `isSymbolMentioned(text, symbol)`, `upsertBogey(..., preserveExisting: true)`, `generateTextForFeature("newsletterBogeyExtraction", …)`, `resolveFeatureModel`; `issuerSiblings`.
- Produces:

```ts
// lib/earnings/extract-newsletter-bogeys.ts
export const NEWSLETTER_EXTRACTOR_VERSION = 1;
/** Pure per-(article, event) path: same prompt + parser as the global scan, writes bogeys for THIS event only,
 *  NEVER touches research_articles.bogeys_scanned_at. */
export async function extractBogeysFromArticleForEvent(
  db: Database.Database, article: ArticleInput, event: { event_id: number; symbol: string; event_date: string },
): Promise<{ bogeysStored: number; modelId: string | null; called: boolean }>;
// lib/earnings/prepare-steps/newsletter-rescan.ts
export const RESCAN_WINDOW_DAYS = 14;
export const SCAN_MAX_ATTEMPTS = 3;
export function makeNewsletterRescanStep(deps?: { extract?: typeof extractBogeysFromArticleForEvent }): PrepareStepDefinition;
export const newsletterRescanStep: PrepareStepDefinition;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/earnings/newsletter-rescan.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({ generateTextForFeature: (...a: unknown[]) => generateTextMock(...a), AIRefusalError: class AIRefusalError extends Error {} }));
vi.mock("@/lib/ai/models", () => ({ resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })) }));

import { extractBogeysFromArticleForEvent, NEWSLETTER_EXTRACTOR_VERSION } from "@/lib/earnings/extract-newsletter-bogeys";
import { makeNewsletterRescanStep, SCAN_MAX_ATTEMPTS } from "@/lib/earnings/prepare-steps/newsletter-rescan";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); });
afterEach(() => generateTextMock.mockReset());
const ctx = { now: () => Date.parse("2026-09-02T18:00:00Z") };
const seedEvent = () => Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-02','ACME','k','ACME')`).run().lastInsertRowid);
function seedArticle(text: string, receivedAt = "2026-08-25 09:00:00", scanned: string | null = "2026-08-25 10:00:00"): number {
  const src = db.prepare(`INSERT OR IGNORE INTO research_sources (name) VALUES ('Desk Notes')`).run();
  const sourceId = (db.prepare(`SELECT id FROM research_sources WHERE name = 'Desk Notes'`).get() as { id: number }).id;
  return Number(db.prepare(`INSERT INTO research_articles (source_id, subject, received_at, raw_text, bogeys_scanned_at) VALUES (?, 'Buyside Bogeys', ?, ?, ?)`).run(sourceId, receivedAt, text, scanned).lastInsertRowid);
}
const RESPONSE = JSON.stringify([{ symbol: "ACME", eps_consensus: 0.60, revenue_consensus: 1.51e9, guidance_notes: "product rev ~1.49B" }]);

describe("extractBogeysFromArticleForEvent (spec §4.1 step 1)", () => {
  it("writes a bogey for THIS event only and never stamps bogeys_scanned_at", async () => {
    const ev = seedEvent(); const art = seedArticle("ACME buyside bogey: product rev 1.49B, EPS 0.60", "2026-08-25 09:00:00", null);
    generateTextMock.mockResolvedValue({ text: RESPONSE });
    const article = db.prepare(`SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id WHERE a.id = ?`).get(art) as never;
    const out = await extractBogeysFromArticleForEvent(db, article, { event_id: ev, symbol: "ACME", event_date: "2026-09-02" });
    expect(out).toEqual({ bogeysStored: 1, modelId: "claude-test-model", called: true });
    expect(db.prepare(`SELECT bogeys_scanned_at FROM research_articles WHERE id = ?`).get(art)).toEqual({ bogeys_scanned_at: null });
    expect(db.prepare(`SELECT source, source_label, eps_consensus, guidance_notes FROM earnings_bogeys WHERE event_id = ?`).get(ev)).toEqual({ source: "newsletter", source_label: "Desk Notes 8/25", eps_consensus: 0.60, guidance_notes: "product rev ~1.49B" });
  });
  it("an article that does not mention the symbol makes no model call", async () => {
    const ev = seedEvent(); const art = seedArticle("NVDA and CRWD only");
    const article = db.prepare(`SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id WHERE a.id = ?`).get(art) as never;
    expect(await extractBogeysFromArticleForEvent(db, article, { event_id: ev, symbol: "ACME", event_date: "2026-09-02" })).toEqual({ bogeysStored: 0, modelId: null, called: false });
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("newsletter_rescan step + earnings_bogey_scans ledger", () => {
  const ledger = (ev: number) => db.prepare(`SELECT article_id, status, attempts, model_id FROM earnings_bogey_scans WHERE event_id = ? AND extractor_version = ? ORDER BY article_id`).all(ev, NEWSLETTER_EXTRACTOR_VERSION);
  it("claims before the call, finalises hit / no_numbers, skips articles older than 14 days, and never re-calls a finalised article", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("ACME: EPS 0.60 / rev 1.51B");                    // hit
    const a2 = seedArticle("ACME mentioned, no numbers");                     // no_numbers
    const old = seedArticle("ACME numbers from July", "2026-07-01 09:00:00"); // outside window
    const extract = vi.fn(async (_db: Database.Database, article: { id: number }) => ({ bogeysStored: article.id === a1 ? 1 : 0, modelId: "m", called: true }));
    const step = makeNewsletterRescanStep({ extract });
    expect(await step.run(db, ev, ctx)).toEqual({ status: "done", note: "2 scanned, 1 hit" });
    expect(ledger(ev)).toEqual([{ article_id: a1, status: "hit", attempts: 1, model_id: "m" }, { article_id: a2, status: "no_numbers", attempts: 1, model_id: "m" }]);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls.map((c) => (c[1] as { id: number }).id)).not.toContain(old);
    await step.run(db, ev, ctx);
    expect(extract).toHaveBeenCalledTimes(2);                                 // ledger is the guard
  });
  it("a throwing extract records error and retries up to SCAN_MAX_ATTEMPTS; a stale claim is taken over", async () => {
    const ev = seedEvent(); const a1 = seedArticle("ACME EPS 0.60");
    const extract = vi.fn(async () => { throw new Error("overloaded"); });
    const step = makeNewsletterRescanStep({ extract });
    for (let i = 1; i <= SCAN_MAX_ATTEMPTS; i++) {
      expect((await step.run(db, ev, ctx)).status).toBe("failed");
      expect(ledger(ev)).toEqual([{ article_id: a1, status: "error", attempts: i, model_id: null }]);
    }
    expect(await step.run(db, ev, ctx)).toEqual({ status: "done", note: "0 scanned, 0 hit (1 exhausted)" });
    // Stale claim: simulate a crash mid-call.
    db.prepare(`UPDATE earnings_bogey_scans SET status = 'claimed', attempts = 0, claim_token = 'dead', updated_at = datetime('now', '-10 minutes') WHERE article_id = ?`).run(a1);
    const ok = vi.fn(async () => ({ bogeysStored: 1, modelId: "m", called: true }));
    expect(await makeNewsletterRescanStep({ extract: ok }).run(db, ev, ctx)).toEqual({ status: "done", note: "1 scanned, 1 hit" });
    // attempts = 1 (the dead claim, counted at takeover) + 1 (this hit) — so a crash loop is capped at SCAN_MAX_ATTEMPTS calls [C-11]
    expect(ledger(ev)).toEqual([{ article_id: a1, status: "hit", attempts: 2, model_id: "m" }]);
  });
  it("fingerprint = hash(eventId, symbol, window, extractor version)", () => {
    const ev = seedEvent();
    const step = makeNewsletterRescanStep({ extract: vi.fn() });
    expect(step.fingerprint(db, ev)).toMatch(/^[0-9a-f]{64}$/);
    expect(step.fingerprint(db, ev)).toBe(step.fingerprint(db, ev));
  });
});
```
(`research_sources` / `research_articles` NOT NULL columns: copy from `tests/earnings/extract-newsletter-bogeys.test.ts`.)

[C-3] Today the extractor labels every issue with the bare publication name (`source_label: article.source_name`, line 396), so two issues of one newsletter collide on `UNIQUE(event_id, source, source_label)` — the 2026-08-26 clobber class, only half-mitigated by `preserveExisting`. The spec requires an issue-scoped label. Both paths now use `newsletterIssueLabel(article)` = `${article.source_name} ${M}/${D}` with M/D from `received_at` in ET (`new Date(received_at + "Z")` formatted `America/New_York`, no zero padding). Add to this test file:

```ts
  it("[C-3] two issues of one newsletter for the same event are two bogey rows, never one overwritten", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("ACME EPS 0.60", "2026-08-21 09:00:00", null);
    const a2 = seedArticle("ACME EPS 0.62 rev 1.52B", "2026-08-25 09:00:00", null);
    generateTextMock.mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "ACME", eps_consensus: 0.60 }]) })
                    .mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "ACME", eps_consensus: 0.62, revenue_consensus: 1.52e9 }]) });
    const load = (id: number) => db.prepare(`SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id WHERE a.id = ?`).get(id) as never;
    await extractBogeysFromArticleForEvent(db, load(a1), { event_id: ev, symbol: "ACME", event_date: "2026-09-02" });
    await extractBogeysFromArticleForEvent(db, load(a2), { event_id: ev, symbol: "ACME", event_date: "2026-09-02" });
    expect(db.prepare(`SELECT source_label, eps_consensus FROM earnings_bogeys WHERE event_id = ? ORDER BY source_label`).all(ev))
      .toEqual([{ source_label: "Desk Notes 8/21", eps_consensus: 0.60 }, { source_label: "Desk Notes 8/25", eps_consensus: 0.62 }]);
  });
```
and update the expectations in `tests/earnings/extract-newsletter-bogeys.test.ts` that assert the bare `source_name` label to the dated form.

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/newsletter-rescan.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement the per-event path (share, do not duplicate, the prompt/parse/write)**

In `lib/earnings/extract-newsletter-bogeys.ts`, extract the body of `extractBogeysFromArticle` lines 356-420 (model call → parse → issuer-family match → `upsertBogey(..., preserveExisting: true)`) into a private
`async function callAndStore(db, article, reporters): Promise<{ bogeysStored: number; eventsMatched: number; modelId: string | null; called: boolean; failed: boolean }>` that does NOT call `markArticleScanned` and writes `source_label: newsletterIssueLabel(article)` (the one behaviour change to the global path — [C-3]). `extractBogeysFromArticle` keeps its exact contract (calls `callAndStore`, then `markArticleScanned` on every non-failed path). Add:

```ts
export const NEWSLETTER_EXTRACTOR_VERSION = 1;

/** [C-3] Issue-scoped bogey label: "<publication> <M/D>" with the issue date in ET, so two
 *  issues of one newsletter are two rows under UNIQUE(event_id, source, source_label). */
export function newsletterIssueLabel(article: Pick<ArticleInput, "source_name" | "received_at">): string {
  const d = new Date(article.received_at.replace(" ", "T") + "Z");        // received_at is UTC, space-separated
  const md = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(d);
  return `${article.source_name} ${md}`;
}

export async function extractBogeysFromArticleForEvent(
  db: Database.Database,
  article: ArticleInput,
  event: { event_id: number; symbol: string; event_date: string },
): Promise<{ bogeysStored: number; modelId: string | null; called: boolean }> {
  const reporter: UpcomingReporter = { symbol: event.symbol.toUpperCase(), event_id: event.event_id, event_date: event.event_date };
  if (!issuerSiblings(reporter.symbol).some((sym) => isSymbolMentioned(article.raw_text, sym))) {
    return { bogeysStored: 0, modelId: null, called: false };
  }
  const r = await callAndStore(db, article, [reporter]);
  if (r.failed) throw new Error("newsletter extraction failed");   // the step's ledger records error + attempts
  return { bogeysStored: r.bogeysStored, modelId: r.modelId, called: true };
}
```

- [ ] **Step 4: Implement the step + ledger**

```ts
// lib/earnings/prepare-steps/newsletter-rescan.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { extractBogeysFromArticleForEvent, NEWSLETTER_EXTRACTOR_VERSION } from "@/lib/earnings/extract-newsletter-bogeys";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

export const RESCAN_WINDOW_DAYS = 14;
export const SCAN_MAX_ATTEMPTS = 3;
const CLAIM_STALE_MINUTES = 5;

interface ArticleRow { id: number; source_name: string; subject: string; received_at: string; raw_text: string; }
interface EventRow { id: number; symbol: string | null; event_date: string; }

export function makeNewsletterRescanStep(deps: { extract?: typeof extractBogeysFromArticleForEvent } = {}): PrepareStepDefinition {
  const extract = deps.extract ?? extractBogeysFromArticleForEvent;
  return {
    fingerprint(db, eventId) {
      const e = db.prepare(`SELECT symbol FROM calendar_events WHERE id = ?`).get(eventId) as { symbol: string | null } | undefined;
      return stableHash(["newsletter_rescan", eventId, e?.symbol ?? null, RESCAN_WINDOW_DAYS, NEWSLETTER_EXTRACTOR_VERSION]);
    },
    async run(db, eventId) {
      const e = db.prepare(`SELECT id, symbol, event_date FROM calendar_events WHERE id = ?`).get(eventId) as EventRow | undefined;
      if (!e?.symbol) return { status: "failed", error: `event ${eventId} has no symbol` };
      const candidates = db.prepare(
        `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text
           FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id
          WHERE a.received_at >= datetime('now', ?) AND a.raw_text IS NOT NULL AND length(a.raw_text) > 200
          ORDER BY a.received_at DESC`,
      ).all(`-${RESCAN_WINDOW_DAYS} days`) as ArticleRow[];
      let scanned = 0, hits = 0, exhausted = 0, errors = 0;
      // Claim-first: the ledger row is inserted BEFORE the model call so a crash
      // mid-call leaves a stale claim the next run takes over (≤ 1 extra call per crash).
      for (const article of candidates) {
        const token = randomUUID();
        const claimed = db.prepare(
          `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status, claim_token, updated_at)
           VALUES (?, ?, ?, 'claimed', ?, datetime('now'))
           ON CONFLICT(event_id, article_id, extractor_version) DO UPDATE SET
             claim_token = excluded.claim_token, status = 'claimed', updated_at = datetime('now'),
             attempts = earnings_bogey_scans.attempts + CASE WHEN earnings_bogey_scans.status = 'claimed' THEN 1 ELSE 0 END   -- [C-11] a takeover counts the dead attempt
           WHERE earnings_bogey_scans.status = 'error' AND earnings_bogey_scans.attempts < ?
              OR (earnings_bogey_scans.status = 'claimed' AND datetime(earnings_bogey_scans.updated_at) < datetime('now', ?))`,
        ).run(e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION, token, SCAN_MAX_ATTEMPTS, `-${CLAIM_STALE_MINUTES} minutes`).changes;
        if (claimed === 0) {
          const row = db.prepare(`SELECT status, attempts FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ? AND extractor_version = ?`).get(e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION) as { status: string; attempts: number };
          if (row.status === "error" && row.attempts >= SCAN_MAX_ATTEMPTS) exhausted += 1;
          continue;                                            // hit / no_numbers / live claim → nothing to do
        }
        const finalize = (status: "hit" | "no_numbers" | "error", modelId: string | null, attemptDelta: number) =>
          db.prepare(
            `UPDATE earnings_bogey_scans SET status = ?, model_id = ?, attempts = attempts + ?, scanned_at = CASE WHEN ? = 'error' THEN scanned_at ELSE datetime('now') END,
                    claim_token = NULL, updated_at = datetime('now')
              WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`,
          ).run(status, modelId, attemptDelta, status, e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION, token);
        try {
          const r = await extract(db, article, { event_id: e.id, symbol: e.symbol, event_date: e.event_date });
          if (!r.called) {                                     // symbol not mentioned: not a scan, release the claim row
            db.prepare(`DELETE FROM earnings_bogey_scans WHERE event_id = ? AND article_id = ? AND extractor_version = ? AND claim_token = ?`).run(e.id, article.id, NEWSLETTER_EXTRACTOR_VERSION, token);
            continue;
          }
          scanned += 1;
          if (r.bogeysStored > 0) { hits += 1; finalize("hit", r.modelId, 1); } else finalize("no_numbers", r.modelId, 1);
        } catch {
          errors += 1;
          finalize("error", null, 1);
        }
      }
      if (errors > 0) return { status: "failed", error: `${errors} article scan(s) failed` };
      const note = exhausted > 0 ? `${scanned} scanned, ${hits} hit (${exhausted} exhausted)` : `${scanned} scanned, ${hits} hit`;
      return { status: "done", note };
    },
  };
}
export const newsletterRescanStep = makeNewsletterRescanStep();
```
Delete the "sketch" loop before committing — the plan shows the claim-first loop as the only loop; the intermediate lines are here only to make the intent unmistakable. Attribution stays deterministic through the existing `source_label` (Task 11 Step 1 note).

- [ ] **Step 5: Run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/earnings/newsletter-rescan.test.ts tests/earnings/extract-newsletter-bogeys.test.ts tests/earnings/prepare-steps.test.ts`
Expected: PASS (existing extractor tests unchanged: the global path still stamps `bogeys_scanned_at`).

- [ ] **Step 6: Commit**

```bash
printf 'feat(earnings): newsletter_rescan prepare step — per-event pure extraction path (never stamps the global marker) + earnings_bogey_scans claim ledger (v2 slice A §4.1 step 1)\n' > /tmp/m.txt
git commit lib/earnings/extract-newsletter-bogeys.ts lib/earnings/prepare-steps/newsletter-rescan.ts lib/earnings/prepare-steps/index.ts tests/earnings/newsletter-rescan.test.ts -F /tmp/m.txt
```

---

### Task 12: Record the deviations, update the reference docs, and finish the branch

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-live-print-v2-design.md` (§4.1 step 2 and §5 088 — one sentence each pointing at D1; §4.1 cloud — D2 sentence)
- Modify: `docs/DECISIONS.md` (append one entry)
- Modify: `docs/reference/earnings-pipeline.md` (new subsection "Armed coverage + prepare steps (v2 slice A)")
- Modify: `docs/reference/cron-and-workers.md` (snapshot v11 + `/internal/armed-events` + KV key `armed-events`)
- Modify: `docs/plans/TODO.md` (slice A line → shipped; TODO 68 → closed by Task 3)
- Test: none new — this task runs the whole verification ladder.

**Interfaces:** none.

- [ ] **Step 1: Spec + decision log**

Append to `docs/DECISIONS.md` (same format as the 2026-09-02 entries):

```markdown
- **Armed coverage ships without a vendor EPS basis column (2026-09-0X, live print v2 slice A)** — The Finnhub EPS consensus is stored in `earnings_bogeys.eps_consensus_vendor`, never in `eps_consensus`, because `compileContracts` (slice B/F territory) fills the adjusted-EPS expected value from the first non-null `eps_consensus` and slices A and B share no file. The user ruling "Finnhub EPS never fills the adjusted-EPS bogey" therefore holds by construction; every surface that renders the vendor figure labels it "vendor, basis unspecified". The spec's `eps_consensus_basis` column is not added (rev 4 §4.1 step 2, §5 088 amended). Cloud parity goes through a new Worker endpoint `/internal/armed-events` (the Mac never writes KV directly — same shape as every existing marker); the generation guard is Worker-side. Tombstones ride the outbox payload for two ET days. The two registries (`registerEventMergeHandler`, `registerPrepareStep`) are the only contact points slice B uses; B stubs them through a shim until both slices have merged.
```
In the spec, add after §4.1 step 2's sentence: `*(Plan deviation D1, 2026-09-0X: stored as `eps_consensus_vendor`; `eps_consensus` stays NULL on the finnhub row; no `eps_consensus_basis` column — see DECISIONS.md.)*` and the same pointer in §5 item 088; after the KV sentence in §4.1 "Cloud": `*(D2: via `POST /internal/armed-events`; the Worker does the generation compare.)*`.

- [ ] **Step 2: Reference docs**

`docs/reference/earnings-pipeline.md`: add a subsection after the print-watch section — coverage = `coveredForEvents` (held/watchlist family OR `isEventArmed`), the consumer allowlist guard test, the four prepare steps with their fingerprints and the CAS claim rule, the scan ledger, the outbox drain (sweep tick + post-commit attempt) and snapshot v11. Direction-only, no figures. `docs/reference/cron-and-workers.md`: snapshot v11 fields, the `armed-events` KV key, the resolver, the degraded-v10 behaviour.

- [ ] **Step 3: Verification ladder (evidence goes in the PR / handoff, never claims without output)**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:changed
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run
cd workers/cron && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run && cd ../..
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p workers/cron
```
Expected: all green; record the test-file / test counts.

- [ ] **Step 4: Migration rehearsal on a VACUUM copy (spec §5)**

```bash
R=/private/tmp/claude-502/-Users-Yitzi-code-vanguard-skin/rehearse; mkdir -p "$R" && sqlite3 data/vanguard.db "VACUUM INTO '$R/vanguard.db'"
# [C-15] BEFORE: per-row digest over EVERY pre-088 column (values, nulls, provenance), plus schema/index/sequence.
sqlite3 "$R/vanguard.db" "SELECT id, hex(sha3(id||'|'||event_id||'|'||source||'|'||COALESCE(source_label,'∅')||'|'||COALESCE(source_url,'∅')||'|'||COALESCE(raw_pdf_r2_key,'∅')||'|'||COALESCE(research_document_id,'∅')||'|'||COALESCE(research_article_id,'∅')||'|'||COALESCE(eps_consensus,'∅')||'|'||COALESCE(eps_whisper,'∅')||'|'||COALESCE(revenue_consensus_usd,'∅')||'|'||COALESCE(revenue_whisper_usd,'∅')||'|'||COALESCE(segment_breakdown_json,'∅')||'|'||COALESCE(guidance_notes,'∅')||'|'||COALESCE(notes,'∅')||'|'||uploaded_at||'|'||COALESCE(ai_extraction_model,'∅')||'|'||COALESCE(expected_move_pct,'∅'))) FROM earnings_bogeys ORDER BY id;" > "$R/bogeys-before.txt"
sqlite3 "$R/vanguard.db" "SELECT seq FROM sqlite_sequence WHERE name='earnings_bogeys'; SELECT name FROM sqlite_master WHERE tbl_name='earnings_bogeys' AND type='index' ORDER BY name;" > "$R/meta-before.txt"
PATH=/opt/homebrew/opt/node@24/bin:$PATH VANGUARD_DB_DIR="$R" npx tsx -e 'import Database from "better-sqlite3"; import { runMigrations } from "./lib/db/migrate"; const db = new Database(process.env.VANGUARD_DB_DIR + "/vanguard.db"); db.pragma("foreign_keys = ON"); runMigrations(db); console.log(db.prepare("SELECT filename FROM schema_migrations ORDER BY id DESC LIMIT 1").get());'
sqlite3 "$R/vanguard.db" "<the same digest SELECT>" > "$R/bogeys-after.txt"
sqlite3 "$R/vanguard.db" "SELECT seq FROM sqlite_sequence WHERE name='earnings_bogeys'; SELECT name FROM sqlite_master WHERE tbl_name='earnings_bogeys' AND type='index' ORDER BY name; PRAGMA foreign_key_check; PRAGMA integrity_check;" > "$R/meta-after.txt"
diff "$R/bogeys-before.txt" "$R/bogeys-after.txt" && diff "$R/meta-before.txt" <(head -3 "$R/meta-after.txt") && tail -2 "$R/meta-after.txt"   # expect: no diff, no FK rows, "ok"
```
Run from the repo root (tsx `@/` alias trap). `sha3()` is available in the Homebrew sqlite3 shell; if the installed shell lacks it, use `hex(...)` of the concatenation instead — the point is an exact per-row, all-column comparison, not a summary. Digest files must be identical, `sqlite_sequence.seq` unchanged, both indexes present, `foreign_key_check` empty, `integrity_check` = `ok`.

- [ ] **Step 5: Sandbox E2E (`:3095` recipe, secretless)**

Per the worktree E2E sandbox recipe (memory `reference_worktree_e2e_sandbox_recipe`): VACUUM copy + `mint-qa-session` + `DATABASE_PATH` + `APP_EXTRA_HOSTS`, `nohup env -i`, one `agent-browser`. Checks: (1) arm an unheld manual event on Today → the row shows the ARMED chip and the worksheet GET returns four `prepare` rows; (2) with TWS absent the `con_id` row reads `pending` / "TWS offline" and `attempts` stays 0 across two sweep ticks (`POST /api/cron/earnings-sweep` with the sandbox secret); (3) `cloud_outbox` has an unsent row with `send_error` naming the unreachable Worker, and no crash; (4) the newsletter rescan against the sandbox's real articles writes bogeys for the armed event only (check `earnings_bogeys` by `event_id`) and never touches `bogeys_scanned_at`; (5) correct the armed event's date via the UI → the surviving row is armed, the finnhub bogey row followed it, a new outbox generation exists. Screenshots and logs checked for private text before any commit.

[C-18] What the secretless sandbox CANNOT prove, and how each is proven instead: (a) the newsletter model path — an injected extractor is impossible over HTTP, so it is proven by the unit tests (Task 11) plus ONE supervised arm on the packaged app after deploy, watching `earnings_bogey_scans` fill for the armed event and `research_articles.bogeys_scanned_at` stay untouched; (b) the Worker endpoint, KV ordering, and resolver overlay — proven locally: `cd workers/cron && npx wrangler dev --local --port 8787` (local KV), then from the sandbox server `WORKER_MARKER_URL=http://127.0.0.1:8787 CRON_SHARED_SECRET=<sandbox secret>` so the outbox drains into the local Worker; `curl -H "X-Cron-Secret: …" http://127.0.0.1:8787/internal/armed-events` (add a GET twin of the endpoint returning the stored delta — read-only) must show the highest generation; then POST an older generation by hand and confirm `applied:false`; (c) the v11 snapshot — `PATH=… npx tsx scripts/snapshot-state-to-r2.ts` against the sandbox DB with `R2` pointed at a scratch prefix, and the Worker's `loadLatestSnapshot` unit test loading that file.

- [ ] **Step 6: TODO reconcile + handoff, then whole-branch review**

Update `docs/plans/TODO.md` (the slice A line under the live print v2 entry → "SHIPPED <sha>"; TODO 68 → `[x]` with the Task 3 commit), write `docs/HANDOFF.md`, then request the whole-branch review (superpowers:requesting-code-review) before merge. Deploys after merge: the Electron deploy chain (`npm run electron:deploy`) AND the Worker (`cd workers/cron && npx wrangler deploy`) — the snapshot v11 producer and the Worker resolver ship together. [C-18] Immediately after the Worker deploy, run the snapshot script once by hand (`PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/snapshot-state-to-r2.ts`) so the first v11 snapshot exists within minutes, not at the next 02:00 launchd run; until it lands the Worker degrades to held+watchlist (tested). Then arm one real upcoming event and confirm `cloud_outbox.sent_at` is stamped and the Worker's GET twin shows the generation.

- [ ] **Step 7: Commit**

```bash
printf 'docs: live print v2 slice A — deviations D1/D2 recorded in spec + DECISIONS, reference docs for armed coverage, prepare steps, outbox + snapshot v11; TODO reconciled\n' > /tmp/m.txt
git commit docs/superpowers/specs/2026-09-02-live-print-v2-design.md docs/DECISIONS.md docs/reference/earnings-pipeline.md docs/reference/cron-and-workers.md docs/plans/TODO.md docs/HANDOFF.md -F /tmp/m.txt
```

---

## Integration with slice B (whichever merges second)

B's `lib/print-watch/register.ts` imports the registries from `lib/print-watch/registry-shim.ts`. After both slices are on `main`: swap those imports to `@/lib/earnings/event-merge` and `@/lib/earnings/prepare-armed-event`, delete the shim, enable the `registerPrintWatch()` import + call inside `bootstrapEarningsRegistries()` (A's composition root — B's plan M3 names the same three self-bootstrapping call sites), and land `tests/earnings/event-merge-integration.test.ts`: a date correction of an armed event with a print and documents moves the flag, the prepare steps, the finnhub bogey row, AND (B's handler) the print with its documents and lines, in one transaction; `enqueuePrepareSteps` on an arm inserts five rows (A's four + B's `ir_baseline`).

## Self-review record

- Spec coverage: §4.1 "Two questions" → Task 2; ET day math → Task 3; consumer matrix rows 1-7 + cockpit → Task 4; display rows + symbol-only rows + push gates unchanged + guard test → Task 5; cloud outbox/sender/generations → Task 6; snapshot v11 + Worker resolver + parity tests → Task 8; merge registry + matrix table → Task 7; prepare table + CAS + fingerprints → Task 9; steps 1-4 → Tasks 10-11; §5 088 → Task 1; §6 worksheet route → Task 9; §7 failure modes (TWS down → pending; KV write fails → unsent + retry; correction while armed → merge) → Tasks 10, 6, 7; §8 A-line tests → one `it` each across Tasks 2-11; data-flow contract payload assertions → Tasks 6 and 8.
- Placeholder scan: done (no TBD/TODO/"similar to"); every code step has code.
- Codex round 1 (REVISE, 19 findings) folded in as `[C-n]` markers; D1 left for the user's ruling (see the header). Committed examples use synthetic issuers (ACME/BETA/GAMMA/HELDCO), a synthetic newsletter name, and round figures [C-19].
- Type consistency: `coveredForEvents(db, rows) → Set<number>` used identically in Tasks 4, 5; `writeArmedEventsOutboxRow(db, opts?) → { generation }` in Tasks 6, 7; `mergeEarningsEventState(db, donor, target) → EventMergeReport` in Task 7 and the calendar mutations; `PrepareStepDefinition` / `PrepareStepOutcome` in Tasks 9-11; `ArmedEventProjection` field set identical between the Mac projection (Task 6) and the Worker `ArmedEventEntry` (Task 8).
