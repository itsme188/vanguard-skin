# Live Print v2 — Slice C Implementation Plan ("print is live" go action, effective window, acquisition scheduler)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desk that knows the print is out presses one control and the watcher acquires from every road at once — inside a window that opens the moment the press lands and can be stretched thirty minutes at a time — with the request itself durable, claimed by compare-and-set, and answered per road; and all outbound polling moves under one process-global scheduler that fans the roads out in parallel, paces every host, and coalesces passes.

**Architecture:** `effectiveWindow(print)` is the ONE definition of when a print is live (scheduled term ± forced term ± extension), read by `desiredState`, `ensurePrintWatch`, the pass, the DJ query bounds and the EDGAR window. A go press is a durable `print_watch_go_requests` row plus a once-only `forced_open_at` stamp; the lease owner claims it by CAS, runs the pasted input through the existing roads (`ingestDocument` / `deliverFromUrl`) and wakes an immediate acquisition pass; the per-road outcomes land in `result_json`. `AcquisitionScheduler` owns every outbound request: per-host-family token buckets (SEC ≤ 2/s across CIKs), per-family concurrency caps, `Promise.allSettled` fan-out of the DJ / EDGAR / IR roads inside one pass with a linked `AbortSignal` per road, one-pending-pass coalescing per print, and an explicit wake. The per-print write queue keeps serialising parses and sheet writes; the scheduler serialises acquisition.

**Tech Stack:** TypeScript / Next.js 16 App Router (thin routes over `lib/`), better-sqlite3 (DI `db` param, `.immediate()` transactions, CAS by `UPDATE … WHERE`), `node:crypto` (`randomUUID`, `sha256`), `AbortController` / `AbortSignal.any` (Node 24), Vitest (in-memory SQLite through the real migrations, fake timers / injected clocks, seams for TWS / EDGAR / IR / extraction), React 19 client component (two controls on the existing panel).

**Spec:** `docs/superpowers/specs/2026-09-02-live-print-v2-design.md` — §4.3 (this slice), §5 item 090, §6 routes, §7 failure modes ("TWS down at go → wire road `skipped: TWS offline`; the forced window keeps EDGAR and IR polling; `con_id` stays pending", "another process holds the lease → the go request is claimed within 2 seconds of the ensure wake; stale claim taken over at 60 seconds"), §8 C-line tests, §9 ruling 2 ("the first go stamps once; extension is an explicit control; a repeat press never extends"), §10 slices. Slice B's plan (`docs/superpowers/plans/2026-09-02-live-print-v2-slice-b.md`) and its shipped modules are the base this slice stacks on.

**Worktree:** sibling `../vanguard-skin-print-v2-c` on branch `print-v2-slice-c`, branched from `print-v2-slice-b` at `702baaf` (slice B is complete, reviewed, pushed and UNMERGED — C stacks on it; B merges first, then C rebases or merges after). Slice D builds in parallel in `../vanguard-skin-print-v2-d` on the same base; see Global Constraints for the two files both slices touch and the merge order.

## Plan-level mechanics and deviations (recorded before the Codex round)

- **M-C1 — Migration 090 is plain `.sql`** (two nullable `ALTER TABLE … ADD COLUMN` on `print_watch_prints` + one new table + two indexes; no rebuild). `print_watch_go_requests.print_id` references `print_watch_prints(id)` with NO cascade, so a go row can never vanish silently — which means **C's merge handler must run BEFORE B's** (B's handler deletes a donor print on a both-prints merge): `register.ts` registers C's handler on the line ABOVE B's. C's handler repoints go rows donor → target and carries `forced_open_at` (earliest) / `window_extended_until` (latest) onto the target print; on a re-home (donor is the surviving print) it does nothing — the ids survive.
- **M-C2 — One window function.** `lib/print-watch/window.ts::effectiveWindow(inputs)` takes the print row's `event_date`, `release_time_et`, `forced_open_at`, `window_extended_until` and returns `{ startMs, endMs }` or `null` (no term at all: an unresolved TAS row that was never forced). `composeReleaseInstant` (ET wall-clock → instant) is IMPORTED from `@/lib/calendar/reaction-snapshot` (its existing home; the watcher already imports it from there) — nothing moves. The watcher's `PrintRuntime.window` is re-read from the DB row at every ensure AND at the start of every pass — a go or extend from ANOTHER process changes the row, and the lease owner must see it without a restart.
- **M-C3 — The wake path.** In-process: `requestGo` runs its transaction, then calls the watcher's exported `wakePrintWatch(db, printId)` = `ensurePrintWatch(db)` + `scheduler.wake(printId)`. Cross-process (the lease owner is a different Next process — packaged `:3099` while the desk used dev `:3000`, or the sweep): the lease owner runs a two-second **go dispatcher** tick (`GO_DISPATCH_MS = 2_000`, one indexed `SELECT` per tick) that claims takeable requests and wakes their prints; the tick starts from `ensurePrintWatch` whenever a queued/claimed go row exists or a print's forced window is live, and stops itself after ten idle ticks. That satisfies "claimed within 2 seconds of the ensure wake" without a second lease.
- **M-C4 — Scheduler shape.** `AcquisitionScheduler` is pure over injected `now`/`sleep`: `throttle(host, signal)` = token bucket + concurrency slot per HOST FAMILY (`*.sec.gov` share one family `sec.gov`: 2 tokens/s, concurrency 2; every other family: 5 tokens/s, concurrency 2 — the old 200 ms spacing became a rate); `fetchFor(signal)` wraps global `fetch` with the throttle keyed by the request URL's host family and merges the pass signal into `init.signal` (`AbortSignal.any`); `runPass(printId, runner, reason)` coalesces (one running pass per print, at most one pending); `wake(printId)` resolves the loop's cadence wait early with reason `go`. TWS (DJ) is not an HTTP host: the DJ lane keeps the adapter's own pacing (spec: "TWS spacing as today") and only gains the abort signal.
- **M-C5 — Fan-out and cancellation.** A pass runs `pollDjSource`, `pollEdgarSource`, `pollIrSource` under `Promise.allSettled`, each with its own `AbortController` whose signal is linked to the pass signal and aborted by a per-road timer (`ROAD_TIMEOUT_MS` = the existing `SOURCE_TIMEOUT_MS`). Adapters now cancel: `pollEdgar` receives the throttled fetch (which carries the signal), `pollDjNews` gains a trailing `signal?: AbortSignal` and throws an `AbortError` between article fetches, `pollIrPage` / the IR lane pass the signal to `hardenedFetchBytes` (which already composes it with its own budget — slice B fix wave A2). The old `withSourceTimeout` (race without cancellation) is deleted.
- **M-C6 — Lease renewal inside a pass.** `renewLeaseIfDue` runs at pass start, and a `LEASE_RENEW_MS` (20 s) interval inside `runPass` renews while a pass is in flight; a failed renewal aborts the pass signal. A pass is bounded by `ROAD_TIMEOUT_MS`, well inside the 60 s TTL.
- **M-C7 — Go input persistence.** A pasted file is written content-addressed under the print directory through the watcher's byte writer, now exported as `writeAcquiredBytes(printId, sha, ext, buf)`; the request row stores `input_sha256` AND `input_bytes_path` (a column the spec's list omits — added because the claim must re-read the bytes without recomputing the storage path; recorded as a deviation). A pasted URL is validated by `validatePublicUrl` and stored REDACTED (`redactUrl`) in `input_url`; the claim runs it through `deliverFromUrl` using the ORIGINAL URL kept in memory only for the in-process path — cross-process claims re-fetch the redacted URL, which is the same URL minus secret-bearing query keys (a paste with a `token=` parameter loses it on the cross-process path; the desk sees `fetch_failed` with the reason and can re-press in the owning process — recorded, accepted).
- **M-C8 — Route shapes.** `POST /api/print-watch/go` body `{ eventId, url?, filename?, contentBase64? }` (at most one of `url` / file; base64 length precheck as the drop route) → `{ success:true, data:{ requestId, forcedOpenAt, printId } }`; `GET /api/print-watch/go?requestId=N` → the row (pure read); `POST /api/print-watch/extend` `{ eventId }` → `{ windowExtendedUntil, effectiveWindow }`. `GET /status` adds `forcedOpenAt`, `windowExtendedUntil`, `effectiveWindow: { start, end } | null`, `goRequest` (latest row's `id/status/attempts/requestedAt/result`). All routes are `human` by default (no `route-policy.ts` entry).
- **M-C9 — Panel.** Two controls on the print card header: **Print is live** (POSTs go with `{ eventId }` only — the pasted-link/file inputs on go are exercised by the routes and the E2E; the paste box is slice F's) and **Extend 30 min**; a one-line go status from `goRequest`. Exactly those edits to `PrintWatchPanel.tsx` (the R-B10/R-B16 precedent).
- **M-C10 — Forced window and the query bounds.** The DJ query start and the EDGAR window start are `effectiveWindow.startMs`, so a go press looks back sixty minutes (a release that hit before the desk pressed is still found). The EDGAR adapter's own `WINDOW_LOOKBACK_MS` stays.
- **M-C11 — `desiredState` keeps its shape.** With an effective window a TAS event can now be `window_open` (forced); `expired` when now is past the end; `acquired`/`parsed` never downgrade.
- **M-C12 — Timestamps.** Every new column is an ISO-8601 UTC string written by code (`new Date(ms).toISOString()`) and read with `Date.parse` — never SQL `datetime('now')` defaults on these rows (the spec's "ISO UTC strings, `Date.parse`").

## Codex round 1 (2026-09-03, read-only) — REVISE, 18 findings

Adopted in full (each folded into the task it touches as an **Amendments (Codex round 1)** block — the amendment REPLACES the code it names): #1 (the dispatcher runs for the life of the lease, not twenty idle seconds — M-C3 revised), #3 (validate → stage bytes → ONE immediate transaction for arm/enqueue/print/stamp/request → post-commit prepare/drain/wake; staged bytes unlinked on rollback), #4 (a wake failure after commit still acks; the row is queued and the dispatcher owns it), #5 (extend computes and writes inside one immediate transaction and wakes the owner), #6 (ordinary failures REQUEUE with attempts kept, terminal `failed` only at the cap; `datetime()` on both sides), #7 (claims heartbeat between phases; token ownership re-checked before every phase; the acquisition phase is bounded by the road timers), #8 (the merge handler invalidates in-flight claims on repointed rows; the runner's token check stops the old worker; the dispatcher re-runs against the target print), #9 in part (the pasted-URL road inside a go request and the RSS feed fetch go through the scheduler's throttled fetch; redirect hops stay inside one throttle — residual, documented; DJ keeps the TWS adapter's pacing — the spec's own words), #10 (DJ helpers become abort-aware; `withSourceTimeout` stays for the conId backfill; EDGAR rethrows `AbortError`), #11 (renewal timer before any awaited work, guarded, `leaseHeld` reset on every stop path), #12 (`runPass` is generic; every pass path returns a fresh local report; RSS maps to the `ir` road; a `system` road carries non-road failures), #13 (slot held until the body closes; first-runner coalescing; `reset` aborts active controllers), #14 (SHA recomputed on replay; a CHECK constraint pins input coherence), #15 (089 applied from the B worktree on the copy first; invariants + `foreign_key_check` + `integrity_check`), #16 (`safeErrorText` scrubs URLs and local paths in every persisted/returned/logged error; proxy classification tests for the three routes), #17 (a file-backed two-connection dispatcher test; the E2E's live SEC/model use is an explicit opt-in smoke; the two snippet bugs fixed), #18 (go resolves the event by id — any unsuperseded earnings event — and `ensurePrintWatch` runs prints whose forced window is live regardless of event date; ET date helpers only).

**Two decisions for the user (folded as written; reversible):** (a) finding #2 — a pasted link that carries a secret-bearing query key (`redactUrl(url) !== url`) is REFUSED at the press ("download the file and drop it instead") rather than persisted in a secret store; (b) finding #9 — the DJ wire keeps the TWS adapter's own pacing with no cross-print governor, exactly as spec §4.3 says ("TWS spacing as today").

## Global Constraints

- Never hardcode a model id (this slice makes no model calls). Every DB function takes `db: Database.Database` first (DI for tests). Route envelope `{success:true,data}` / `{success:false,error}`; routes thin (logic in `lib/print-watch/*`). `lib/auth/route-policy.ts` gets NO new entries — every `/api/print-watch/*` route is `human` by default. **GET routes are read-only** — `tests/api/no-state-changing-get.test.ts` scans every GET body; `GET /api/print-watch/go` and `GET /status` call readers only.
- Timestamps on the new columns are ISO UTC strings via `toISOString()` / `Date.parse`; user-facing dates ET-anchored (`todayET()`). Never `new Date().toISOString().slice(0,10)` for a date.
- No new npm dependencies. Node via `PATH=/opt/homebrew/opt/node@24/bin:$PATH`. `AbortSignal.any` is available (Node 24).
- Every outbound HTTP request the watcher makes goes through the scheduler's `throttle`/`fetchFor` (SEC family ≤ 2 requests per second across CIKs, concurrency 2); the DJ lane keeps the TWS adapter's pacing. `redactUrl` is the only way a URL reaches a message, a row, or the status payload.
- **Slice ownership.** C creates `lib/print-watch/{window,go,scheduler}.ts`, migration `090_print_watch_go.sql`, routes `app/api/print-watch/{go,extend}/`, and edits `lib/print-watch/{types,store,watcher,register,edgar-adapter,dj-adapter}.ts`, `app/api/print-watch/status/route.ts`, `app/dashboard/today/PrintWatchPanel.tsx` (two controls + one status line only), `docs/reference/earnings-pipeline.md` (§Print-watch only), `docs/DECISIONS.md` (append), tests. NEVER `lib/earnings/*`, `lib/calendar/*`, `lib/mutations/*`, `workers/*`, `qa/*` (C CALLS `armWorksheet`, `enqueuePrepareSteps`, `runPrepareSteps`, `attemptPostCommitDrain` — it does not edit them).
- **Parallel-slice touchpoints (D builds on the same base):** D edits `lib/print-watch/watcher.ts` in exactly one place — a post-commit hook call after the parse transaction in `processDocument` — and `lib/print-watch/register.ts` in one line (its merge handler, registered AFTER B's). C edits `watcher.ts` in the window/state/loop/lane regions and `register.ts` on the line BEFORE B's. D ALSO adds fields to `app/api/print-watch/status/route.ts` (`read`, `callouts`) and a mount + two optional fields to `PrintWatchPanel.tsx`, and registers its own merge handler BEFORE B's (its tables also reference prints) — so C and D each insert a line above B's in `register.ts`. Merge order: B → C → D; D rebases onto C and resolves the expected small textual conflicts by KEEPING BOTH sides in `register.ts` (order C/D relative to each other is irrelevant; both must precede B's), the status route's map, and the panel's props/imports. The two `watcher.ts` regions do not overlap.
- Migration number 090 is reserved for C (091 D, 092 E). Never renumber; never share a number. 090 is additive and safe to apply implicitly at app start — but it lands only AFTER the 089 cutover (B's runbook) because the runner applies pending migrations in order.
- Tests: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <paths>`; no wall-clock sleeps (inject `now`/`sleep`, use `vi.useFakeTimers` + `advanceTimersByTimeAsync`); any fixture the code compares against `todayET()` is seeded relative to it. Commits: message in a temp file, commit BY PATHSPEC — `git commit <paths> -F <tempfile>` — never a bare `git commit`, never `git stash`/`checkout`/`clean`/`reset` (parallel agents share the worktree). The ONLY git commands an implementer runs: status/diff/log/show/rev-parse, `git add <paths>`, `git commit <paths> -F`.
- Never edit `qa/nightly-deep-qa.sh`; never run git branch/worktree cleanup while the desktop deploy chain is building; never open `data/vanguard.db` from a task (rehearsals use a `VACUUM INTO` copy).

## File Structure

```
lib/db/migrations/090_print_watch_go.sql                # forced_open_at, window_extended_until, print_watch_go_requests (Task 1)
lib/print-watch/types.ts                               # PrintRow + two columns; GoRequestRow, GoRequestStatus, GoInputKind, RoadReport (Task 1)
lib/print-watch/store.ts                               # getPrintById, stampForcedOpen, extendPrintWindow, go-request CRUD + CAS (Task 1)
lib/print-watch/window.ts                              # WINDOW_* constants, effectiveWindow, extendedUntil, windowToIso (Task 2)
lib/print-watch/scheduler.ts                           # AcquisitionScheduler: host-family buckets, concurrency, fetchFor, runPass coalescing, wake/waitForWake (Task 3)
lib/print-watch/edgar-adapter.ts                       # unchanged signature — the throttled fetch carries the signal; resolveCik same (Task 4 verifies)
lib/print-watch/dj-adapter.ts                          # pollDjNews(…, signal?) aborts between article fetches (Task 4)
lib/print-watch/go.ts                                  # requestGo, runGoRequest, GoRefused, C's merge handler (Task 5)
lib/print-watch/register.ts                            # + one line: C's handler registered BEFORE B's (Task 5)
lib/print-watch/watcher.ts                             # window via effectiveWindow; loop → scheduler passes with fan-out + linked signals; writeAcquiredBytes export; go dispatcher; status fields; wakePrintWatch (Task 6)
app/api/print-watch/go/route.ts                        # POST go, GET go?requestId (Task 7)
app/api/print-watch/extend/route.ts                    # POST extend (Task 7)
app/api/print-watch/status/route.ts                    # + forcedOpenAt, windowExtendedUntil, effectiveWindow, goRequest (Task 7)
app/dashboard/today/PrintWatchPanel.tsx                # Print is live + Extend 30 min + go status line (Task 8)
docs/reference/earnings-pipeline.md                    # §Print-watch: effective window, go, extend, scheduler (Task 9)
docs/DECISIONS.md                                      # slice C mechanics M-C1/M-C3/M-C7 (Task 9)
tests/db/migration-090-print-watch-go.test.ts          # Task 1
tests/print-watch/{window,scheduler,go}.test.ts        # Tasks 2, 3, 5
tests/print-watch/dj-adapter.test.ts                   # extended (Task 4)
tests/print-watch/watcher.test.ts                      # extended: fan-out, wake, forced window, extend, dispatcher (Task 6)
tests/api/print-watch-go.test.ts                       # go + extend + status fields (Task 7) — a NEW file (no shared test file with D)
tests/dashboard/print-watch-panel.test.ts              # + goStatusText / windowText helpers (Task 8)
```

**Suggested waves for subagent-driven execution (disjoint files per wave):** W1 = Task 1 ∥ Task 2 ∥ Task 3 ∥ Task 4 (no W1 task touches `watcher.ts`); W2 = Task 5 (needs 1, 2); W3 = Task 6 (needs 2, 3, 4, 5); W4 = Task 7 ∥ Task 8 ∥ Task 9 (8 codes against the status wire shape defined in Task 7's Interfaces, in a separate file); Task 10 = verification.

---

### Task 1: Migration 090, row types, and the go-request store

**Files:**
- Create: `lib/db/migrations/090_print_watch_go.sql`
- Modify: `lib/print-watch/types.ts` (`PrintRow` + two columns; new types)
- Modify: `lib/print-watch/store.ts` (append the functions below)
- Test: `tests/db/migration-090-print-watch-go.test.ts`; extend `tests/print-watch/store.test.ts` (the exhaustive `print_watch_%` table list gains one name)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 2, 5, 6, 7 consume):

```ts
// lib/print-watch/types.ts (changed/added)
export interface PrintRow {
  id: number; event_id: number; symbol: string; event_date: string; release_time_et: string | null;
  state: PrintWatchState; created_at: string; updated_at: string;
  /** ISO UTC; stamped ONCE by the first go press (spec §9 ruling 2). */
  forced_open_at: string | null;
  /** ISO UTC; every "Extend 30 min" press writes max(now, current end) + 30m. */
  window_extended_until: string | null;
}
export type GoRequestStatus = "queued" | "claimed" | "done" | "failed";
export type GoInputKind = "none" | "url" | "file";
export interface GoRequestRow {
  id: number; print_id: number; status: GoRequestStatus; requested_at: string;
  input_kind: GoInputKind; input_url: string | null; input_sha256: string | null; input_bytes_path: string | null;
  claim_token: string | null; claimed_at: string | null; attempts: number;
  result_json: string | null; finished_at: string | null;
}
/** One road's answer to a go request — what `result_json` holds. */
export interface RoadReport { road: "user-drop" | "user-url" | "dj" | "edgar" | "ir"; outcome: string; detail: string }

// lib/print-watch/store.ts (added)
export const GO_CLAIM_STALE_MS = 60_000;
export const GO_MAX_ATTEMPTS = 3;
export function getPrintById(db: Database.Database, printId: number): PrintRow | null;
/** Sets forced_open_at only when NULL. Returns the stamped (or existing) value. */
export function stampForcedOpen(db: Database.Database, printId: number, nowIso: string): string;
export function extendPrintWindow(db: Database.Database, printId: number, untilIso: string): void;
export function insertGoRequest(db: Database.Database, req: { printId: number; inputKind: GoInputKind; inputUrl: string | null; inputSha256: string | null; inputBytesPath: string | null; requestedAt: string }): number;
export function getGoRequest(db: Database.Database, id: number): GoRequestRow | null;
export function latestGoRequest(db: Database.Database, printId: number): GoRequestRow | null;
/** queued, or claimed with a stale claim, with attempts left — oldest first. */
export function listTakeableGoRequests(db: Database.Database, nowMs: number): GoRequestRow[];
/** CAS claim: returns true when THIS token now owns the row; increments attempts. */
export function claimGoRequest(db: Database.Database, id: number, token: string, nowMs: number): boolean;
/** CAS finalise: false when the token no longer owns the row (taken over). */
export function finalizeGoRequest(db: Database.Database, id: number, token: string, status: "done" | "failed", resultJson: string, nowMs: number): boolean;
/** Stale claims that have spent their attempts become `failed` (nothing else could ever finalise them). */
export function failCappedGoRequests(db: Database.Database, nowMs: number): number;
export function movePrintGoState(db: Database.Database, donorPrintId: number, targetPrintId: number): { moved: number; forcedOpenAt: string | null; windowExtendedUntil: string | null };
```

- [ ] **Step 1: Write the failing migration test**

`tests/db/migration-090-print-watch-go.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("migration 090 — print-watch go", () => {
  it("adds the two window columns to print_watch_prints, nullable", () => {
    const cols = db.prepare("PRAGMA table_info(print_watch_prints)").all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("forced_open_at")?.notnull).toBe(0);
    expect(byName.get("window_extended_until")?.notnull).toBe(0);
  });

  it("creates print_watch_go_requests with the status and input_kind CHECKs and both indexes", () => {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'print_watch_go_requests'").get() as { sql: string };
    expect(table.sql).toContain("CHECK (status IN ('queued','claimed','done','failed'))");
    expect(table.sql).toContain("CHECK (input_kind IN ('none','url','file'))");
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='print_watch_go_requests'").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(idx).toEqual(["idx_pw_go_requests_print", "idx_pw_go_requests_status"]);
  });

  it("refuses a go row whose print does not exist, and does NOT cascade-delete go rows with their print", () => {
    expect(() =>
      db.prepare(`INSERT INTO print_watch_go_requests (print_id, requested_at) VALUES (999, '2026-09-03T20:00:00.000Z')`).run(),
    ).toThrow(/FOREIGN KEY/);
    const eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
    const printId = Number(db.prepare(`INSERT INTO print_watch_prints (event_id, symbol, event_date, release_time_et) VALUES (?, 'ACME', '2026-09-10', '16:05')`).run(eventId).lastInsertRowid);
    db.prepare(`INSERT INTO print_watch_go_requests (print_id, requested_at) VALUES (?, '2026-09-03T20:00:00.000Z')`).run(printId);
    expect(() => db.prepare(`DELETE FROM print_watch_prints WHERE id = ?`).run(printId)).toThrow(/FOREIGN KEY/);
  });

  it("is recorded once and idempotent on a re-run", () => {
    const before = db.prepare(`SELECT count(*) AS n FROM schema_migrations WHERE filename = '090_print_watch_go.sql'`).get() as { n: number };
    expect(before.n).toBe(1);
    runMigrations(db);
    const after = db.prepare(`SELECT count(*) AS n FROM schema_migrations WHERE filename = '090_print_watch_go.sql'`).get() as { n: number };
    expect(after.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/migration-090-print-watch-go.test.ts`
Expected: FAIL — `forced_open_at` undefined / no such table `print_watch_go_requests`.

- [ ] **Step 3: Write the migration**

`lib/db/migrations/090_print_watch_go.sql`:

```sql
-- 090: live print v2, slice C (spec §4.3, §5).
-- The "print is live" go action needs: a once-only forced-open stamp and a
-- stackable extension on the print row, and a durable, claimable request
-- row per press. Additive only (no rebuild): 089's document/lines rebuild
-- is untouched. Timestamps on these columns are ISO-8601 UTC strings written
-- by code (`toISOString()`), read with Date.parse — never datetime('now')
-- text, so the window arithmetic never mixes the two clocks.
--
-- print_id has NO ON DELETE CASCADE on purpose: a go row must never vanish
-- silently. Slice C's event-merge handler repoints these rows to the
-- surviving print BEFORE slice B's handler deletes a donor print (it is
-- registered ahead of B's for exactly that reason).

ALTER TABLE print_watch_prints ADD COLUMN forced_open_at TEXT;
ALTER TABLE print_watch_prints ADD COLUMN window_extended_until TEXT;

CREATE TABLE print_watch_go_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id         INTEGER NOT NULL REFERENCES print_watch_prints(id),
  status           TEXT    NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','claimed','done','failed')),
  requested_at     TEXT    NOT NULL,
  input_kind       TEXT    NOT NULL DEFAULT 'none'
                           CHECK (input_kind IN ('none','url','file')),
  input_url        TEXT,
  input_sha256     TEXT,
  input_bytes_path TEXT,
  claim_token      TEXT,
  claimed_at       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  result_json      TEXT,
  finished_at      TEXT
);
CREATE INDEX idx_pw_go_requests_print  ON print_watch_go_requests(print_id, id);
CREATE INDEX idx_pw_go_requests_status ON print_watch_go_requests(status, claimed_at);
```

- [ ] **Step 4: Types**

In `lib/print-watch/types.ts`, extend `PrintRow` with `forced_open_at: string | null` and `window_extended_until: string | null` (with the doc comments from Interfaces) and add `GoRequestStatus`, `GoInputKind`, `GoRequestRow`, `RoadReport` right after `PrintRow`, exactly as in Interfaces.

- [ ] **Step 5: Store functions**

Append to `lib/print-watch/store.ts` (and add `GoInputKind`, `GoRequestRow` to its type imports):

```ts
// ── slice C: forced window + go requests ───────────────────────────────────

export const GO_CLAIM_STALE_MS = 60_000;
export const GO_MAX_ATTEMPTS = 3;

export function getPrintById(db: Database.Database, printId: number): PrintRow | null {
  const row = db.prepare(`SELECT * FROM print_watch_prints WHERE id = ?`).get(printId) as PrintRow | undefined;
  return row ?? null;
}

/** The FIRST go press stamps; every later press reads the stamp back (spec
 *  §9 ruling 2: "the first go stamps once … a repeat press never extends"). */
export function stampForcedOpen(db: Database.Database, printId: number, nowIso: string): string {
  db.prepare(
    `UPDATE print_watch_prints SET forced_open_at = COALESCE(forced_open_at, ?), updated_at = datetime('now') WHERE id = ?`,
  ).run(nowIso, printId);
  const row = db.prepare(`SELECT forced_open_at FROM print_watch_prints WHERE id = ?`).get(printId) as { forced_open_at: string };
  return row.forced_open_at;
}

export function extendPrintWindow(db: Database.Database, printId: number, untilIso: string): void {
  db.prepare(
    `UPDATE print_watch_prints SET window_extended_until = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(untilIso, printId);
}

export function insertGoRequest(
  db: Database.Database,
  req: { printId: number; inputKind: GoInputKind; inputUrl: string | null; inputSha256: string | null; inputBytesPath: string | null; requestedAt: string },
): number {
  const r = db
    .prepare(
      `INSERT INTO print_watch_go_requests (print_id, status, requested_at, input_kind, input_url, input_sha256, input_bytes_path)
       VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
    )
    .run(req.printId, req.requestedAt, req.inputKind, req.inputUrl, req.inputSha256, req.inputBytesPath);
  return Number(r.lastInsertRowid);
}

export function getGoRequest(db: Database.Database, id: number): GoRequestRow | null {
  const row = db.prepare(`SELECT * FROM print_watch_go_requests WHERE id = ?`).get(id) as GoRequestRow | undefined;
  return row ?? null;
}

export function latestGoRequest(db: Database.Database, printId: number): GoRequestRow | null {
  const row = db
    .prepare(`SELECT * FROM print_watch_go_requests WHERE print_id = ? ORDER BY id DESC LIMIT 1`)
    .get(printId) as GoRequestRow | undefined;
  return row ?? null;
}

const GO_TAKEABLE_SQL = `(status = 'queued' OR (status = 'claimed' AND claimed_at < ?)) AND attempts < ${GO_MAX_ATTEMPTS}`;

export function listTakeableGoRequests(db: Database.Database, nowMs: number): GoRequestRow[] {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  return db
    .prepare(`SELECT * FROM print_watch_go_requests WHERE ${GO_TAKEABLE_SQL} ORDER BY id ASC`)
    .all(stale) as GoRequestRow[];
}

/** Compare-and-set claim. ISO strings sort as instants, so the stale test is
 *  a plain string compare on the same clock the writer used. */
export function claimGoRequest(db: Database.Database, id: number, token: string, nowMs: number): boolean {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests
          SET status = 'claimed', claim_token = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND ${GO_TAKEABLE_SQL}`,
    )
    .run(token, new Date(nowMs).toISOString(), id, stale);
  return r.changes === 1;
}

export function finalizeGoRequest(
  db: Database.Database,
  id: number,
  token: string,
  status: "done" | "failed",
  resultJson: string,
  nowMs: number,
): boolean {
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests
          SET status = ?, result_json = ?, finished_at = ?, claim_token = NULL
        WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(status, resultJson, new Date(nowMs).toISOString(), id, token);
  return r.changes === 1;
}

export function failCappedGoRequests(db: Database.Database, nowMs: number): number {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  const r = db
    .prepare(
      `UPDATE print_watch_go_requests
          SET status = 'failed', finished_at = ?, claim_token = NULL,
              result_json = COALESCE(result_json, '[{"road":"none","outcome":"failed","detail":"abandoned claim at the attempt cap"}]')
        WHERE status = 'claimed' AND claimed_at < ? AND attempts >= ${GO_MAX_ATTEMPTS}`,
    )
    .run(new Date(nowMs).toISOString(), stale);
  return r.changes;
}

/** Merge support (slice C's event-merge handler): go rows follow the surviving
 *  print; the forced stamp keeps the EARLIEST press and the extension the
 *  LATEST end, so a merge can only widen what the desk already opened. */
export function movePrintGoState(
  db: Database.Database,
  donorPrintId: number,
  targetPrintId: number,
): { moved: number; forcedOpenAt: string | null; windowExtendedUntil: string | null } {
  const moved = db
    .prepare(`UPDATE print_watch_go_requests SET print_id = ? WHERE print_id = ?`)
    .run(targetPrintId, donorPrintId).changes;
  const donor = getPrintById(db, donorPrintId);
  const target = getPrintById(db, targetPrintId);
  if (!donor || !target) {
    return { moved, forcedOpenAt: target?.forced_open_at ?? null, windowExtendedUntil: target?.window_extended_until ?? null };
  }
  const forced = [donor.forced_open_at, target.forced_open_at].filter((v): v is string => v !== null).sort()[0] ?? null;
  const extended = [donor.window_extended_until, target.window_extended_until].filter((v): v is string => v !== null).sort().at(-1) ?? null;
  db.prepare(
    `UPDATE print_watch_prints SET forced_open_at = ?, window_extended_until = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(forced, extended, targetPrintId);
  return { moved, forcedOpenAt: forced, windowExtendedUntil: extended };
}
```

- [ ] **Step 6: Store tests**

Append inside the top-level `describe` of `tests/print-watch/store.test.ts` (after the parse-claim tests) and add `print_watch_go_requests` to the file's exhaustive `print_watch_%` table-name assertion:

```ts
  describe("slice C — forced window + go requests", () => {
    function seedPrint(sourceKey = "go-k"): number {
      const eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME',?, 'ACME')`).run(sourceKey).lastInsertRowid);
      return upsertPrint(db, eventId, "ACME", "2026-09-10", "16:05");
    }

    it("stampForcedOpen stamps once and returns the first stamp on a repeat press", () => {
      const printId = seedPrint();
      expect(stampForcedOpen(db, printId, "2026-09-10T20:01:00.000Z")).toBe("2026-09-10T20:01:00.000Z");
      expect(stampForcedOpen(db, printId, "2026-09-10T20:30:00.000Z")).toBe("2026-09-10T20:01:00.000Z");
      expect(getPrintById(db, printId)?.forced_open_at).toBe("2026-09-10T20:01:00.000Z");
    });

    it("claimGoRequest is a CAS: one winner, attempts incremented, a live claim is not takeable, a stale one is", () => {
      const printId = seedPrint();
      const t0 = Date.parse("2026-09-10T20:00:00.000Z");
      const id = insertGoRequest(db, { printId, inputKind: "none", inputUrl: null, inputSha256: null, inputBytesPath: null, requestedAt: new Date(t0).toISOString() });
      expect(claimGoRequest(db, id, "tok-a", t0)).toBe(true);
      expect(claimGoRequest(db, id, "tok-b", t0 + 1_000)).toBe(false);
      expect(getGoRequest(db, id)?.attempts).toBe(1);
      expect(listTakeableGoRequests(db, t0 + 1_000)).toEqual([]);
      expect(listTakeableGoRequests(db, t0 + GO_CLAIM_STALE_MS + 1).map((r) => r.id)).toEqual([id]);
      expect(claimGoRequest(db, id, "tok-b", t0 + GO_CLAIM_STALE_MS + 1)).toBe(true);
      expect(getGoRequest(db, id)?.attempts).toBe(2);
      expect(finalizeGoRequest(db, id, "tok-a", "done", "[]", t0 + GO_CLAIM_STALE_MS + 2)).toBe(false);
      expect(finalizeGoRequest(db, id, "tok-b", "done", "[]", t0 + GO_CLAIM_STALE_MS + 2)).toBe(true);
      expect(getGoRequest(db, id)?.status).toBe("done");
    });

    it("a stale claim at the attempt cap is failed by failCappedGoRequests, never re-claimed", () => {
      const printId = seedPrint();
      const t0 = Date.parse("2026-09-10T20:00:00.000Z");
      const id = insertGoRequest(db, { printId, inputKind: "none", inputUrl: null, inputSha256: null, inputBytesPath: null, requestedAt: new Date(t0).toISOString() });
      for (let i = 0; i < GO_MAX_ATTEMPTS; i += 1) {
        expect(claimGoRequest(db, id, `tok-${i}`, t0 + i * (GO_CLAIM_STALE_MS + 1))).toBe(true);
      }
      const later = t0 + GO_MAX_ATTEMPTS * (GO_CLAIM_STALE_MS + 1);
      expect(listTakeableGoRequests(db, later)).toEqual([]);
      expect(failCappedGoRequests(db, later)).toBe(1);
      const row = getGoRequest(db, id)!;
      expect(row.status).toBe("failed");
      expect(row.result_json).toContain("abandoned claim at the attempt cap");
    });

    it("movePrintGoState repoints go rows and keeps the earliest forced stamp / latest extension", () => {
      const donor = seedPrint("go-k1");
      const target = seedPrint("go-k2");
      const id = insertGoRequest(db, { printId: donor, inputKind: "none", inputUrl: null, inputSha256: null, inputBytesPath: null, requestedAt: "2026-09-10T20:00:00.000Z" });
      stampForcedOpen(db, donor, "2026-09-10T20:00:00.000Z");
      stampForcedOpen(db, target, "2026-09-10T21:00:00.000Z");
      extendPrintWindow(db, donor, "2026-09-10T23:00:00.000Z");
      const out = movePrintGoState(db, donor, target);
      expect(out).toEqual({ moved: 1, forcedOpenAt: "2026-09-10T20:00:00.000Z", windowExtendedUntil: "2026-09-10T23:00:00.000Z" });
      expect(getGoRequest(db, id)?.print_id).toBe(target);
      expect(getPrintById(db, target)?.forced_open_at).toBe("2026-09-10T20:00:00.000Z");
    });
  });
```

(Import `stampForcedOpen`, `extendPrintWindow`, `insertGoRequest`, `getGoRequest`, `listTakeableGoRequests`, `claimGoRequest`, `finalizeGoRequest`, `failCappedGoRequests`, `movePrintGoState`, `getPrintById`, `GO_CLAIM_STALE_MS`, `GO_MAX_ATTEMPTS` from `@/lib/print-watch/store`. `seedPrint` needs distinct `source_key` values because `calendar_events.source_key` is unique.)

- [ ] **Step 7: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/ tests/print-watch/store.test.ts`
Expected: PASS (the 089 suite and the code-migrations registry guard stay green — 090 is `.sql`, so the registry is unchanged).

- [ ] **Step 8: Commit**

```bash
cat > /tmp/msg-c1.txt <<'MSG'
feat(db): migration 090 — forced window columns and durable go requests (live print v2 slice C)

print_watch_go_requests has no cascade on print_id by design: slice C's
merge handler repoints rows before slice B's deletes a donor print.
Store gains the CAS claim/finalize pair, the once-only forced stamp, the
extension write, and the merge mover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit lib/db/migrations/090_print_watch_go.sql lib/print-watch/types.ts lib/print-watch/store.ts tests/db/migration-090-print-watch-go.test.ts tests/print-watch/store.test.ts -F /tmp/msg-c1.txt
```

**Amendments (Codex round 1 — findings #6, #14, #18):**

1. In `090_print_watch_go.sql`, add the input-coherence CHECK to `print_watch_go_requests` (after `finished_at TEXT`):

```sql
  ,
  CHECK (
    (input_kind = 'none' AND input_url IS NULL AND input_sha256 IS NULL AND input_bytes_path IS NULL) OR
    (input_kind = 'url'  AND input_url IS NOT NULL) OR
    (input_kind = 'file' AND input_sha256 IS NOT NULL AND input_bytes_path IS NOT NULL)
  )
```

and a migration test: inserting `input_kind='file'` with a NULL `input_sha256` throws `/CHECK/`; `input_kind='url'` with a NULL `input_url` throws; a coherent row of each kind inserts.

2. Store — REPLACE the takeable/claim/finalize/cap block with this (the stale test uses `datetime()` on BOTH sides per the repo rule; ordinary failures REQUEUE):

```ts
const GO_TAKEABLE_SQL = `(status = 'queued' OR (status = 'claimed' AND datetime(claimed_at) < datetime(?))) AND attempts < ${GO_MAX_ATTEMPTS}`;

export function listTakeableGoRequests(db: Database.Database, nowMs: number): GoRequestRow[] {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  return db.prepare(`SELECT * FROM print_watch_go_requests WHERE ${GO_TAKEABLE_SQL} ORDER BY id ASC`).all(stale) as GoRequestRow[];
}

export function claimGoRequest(db: Database.Database, id: number, token: string, nowMs: number): boolean {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  const r = db.prepare(
    `UPDATE print_watch_go_requests SET status = 'claimed', claim_token = ?, claimed_at = ?, attempts = attempts + 1
      WHERE id = ? AND ${GO_TAKEABLE_SQL}`,
  ).run(token, new Date(nowMs).toISOString(), id, stale);
  return r.changes === 1;
}

/** Heartbeat: renews claimed_at under the token so a long phase (a PDF ingest
 *  with model calls) is never mistaken for an abandoned claim. False = the
 *  token no longer owns the row — the caller must stop. */
export function heartbeatGoRequest(db: Database.Database, id: number, token: string, nowMs: number): boolean {
  const r = db.prepare(
    `UPDATE print_watch_go_requests SET claimed_at = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
  ).run(new Date(nowMs).toISOString(), id, token);
  return r.changes === 1;
}

/** An ordinary failure below the cap: back to queued (attempts kept, partial
 *  reports kept) so the next dispatcher tick retries. */
export function requeueGoRequest(db: Database.Database, id: number, token: string, resultJson: string): boolean {
  const r = db.prepare(
    `UPDATE print_watch_go_requests SET status = 'queued', claim_token = NULL, result_json = ?
      WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
  ).run(resultJson, id, token);
  return r.changes === 1;
}

export function finalizeGoRequest(db, id, token, status: "done" | "failed", resultJson, nowMs): boolean {
  const r = db.prepare(
    `UPDATE print_watch_go_requests SET status = ?, result_json = ?, finished_at = ?, claim_token = NULL
      WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
  ).run(status, resultJson, new Date(nowMs).toISOString(), id, token);
  return r.changes === 1;
}

/** Rows that have spent their attempts — a stale claim OR a requeued row at
 *  the cap — become `failed`; nothing else could ever finalise them. */
export function failCappedGoRequests(db: Database.Database, nowMs: number): number {
  const stale = new Date(nowMs - GO_CLAIM_STALE_MS).toISOString();
  const r = db.prepare(
    `UPDATE print_watch_go_requests
        SET status = 'failed', finished_at = ?, claim_token = NULL,
            result_json = COALESCE(result_json, '[{"road":"system","outcome":"failed","detail":"abandoned at the attempt cap"}]')
      WHERE attempts >= ${GO_MAX_ATTEMPTS} AND (status = 'queued' OR (status = 'claimed' AND datetime(claimed_at) < datetime(?)))`,
  ).run(new Date(nowMs).toISOString(), stale);
  return r.changes;
}

/** Prints whose FORCED window is live right now, whatever their event date —
 *  ensurePrintWatch runs these beside the ±1-day armed set (finding #18). */
export function listForcedLivePrints(db: Database.Database, nowMs: number): PrintRow[] {
  const since = new Date(nowMs - 4 * 60 * 60_000).toISOString(); // forced + extensions never exceed a few hours
  return db.prepare(
    `SELECT * FROM print_watch_prints WHERE forced_open_at IS NOT NULL AND datetime(forced_open_at) >= datetime(?) AND state NOT IN ('disarmed')`,
  ).all(since) as PrintRow[];
}

/** Merge support (finding #8): repoint rows AND invalidate any in-flight claim
 *  on them (status → queued, token cleared, attempts kept) so the old worker's
 *  next token check fails and the dispatcher re-runs against the target print. */
export function movePrintGoState(db, donorPrintId, targetPrintId) {
  const moved = db.prepare(
    `UPDATE print_watch_go_requests
        SET print_id = ?, status = CASE WHEN status = 'claimed' THEN 'queued' ELSE status END,
            claim_token = CASE WHEN status = 'claimed' THEN NULL ELSE claim_token END
      WHERE print_id = ?`,
  ).run(targetPrintId, donorPrintId).changes;
  // … the forced/extension carry exactly as before …
}
```

Also add `RoadReport.road` member `"system"` to the union in `types.ts` (non-road failures — finding #12). Tests: the CAS test now expects `requeueGoRequest` to put the row back to `queued` at attempts 1 (takeable again immediately), a heartbeat to move `claimed_at` so the row is NOT takeable at the old stale instant, and `failCappedGoRequests` to fail a queued row at attempts 3; `listForcedLivePrints` returns a print with a recent stamp and ignores one stamped five hours ago.

---

### Task 2: `window.ts` — the one effective-window definition

**Files:**
- Create: `lib/print-watch/window.ts`
- Test: `tests/print-watch/window.test.ts`

**Interfaces:**
- Consumes: `PrintRow` fields (Task 1).
- Produces (Tasks 5, 6, 7 consume):

```ts
// lib/print-watch/window.ts
export const WINDOW_PRE_MS = 10 * 60_000;    // scheduled term: release − 10m
export const WINDOW_POST_MS = 45 * 60_000;   // scheduled term: release + 45m
export const FORCED_PRE_MS = 60 * 60_000;    // forced term: press − 60m
export const FORCED_POST_MS = 90 * 60_000;   // forced term: press + 90m
export const EXTEND_MS = 30 * 60_000;
export interface WindowInputs {
  event_date: string;
  release_time_et: string | null;
  forced_open_at: string | null;
  window_extended_until: string | null;
}
export interface EffectiveWindow {
  startMs: number;
  endMs: number;
  /** The release instant when the scheduled term is present, else null (unresolved TAS). */
  scheduledMs: number | null;
  forcedMs: number | null;
  extendedUntilMs: number | null;
}
// composeReleaseInstant is NOT defined here: window.ts imports it from `@/lib/calendar/reaction-snapshot`
// (`export function composeReleaseInstant(eventDate: string, releaseTimeEt: string): Date | null` — null on a malformed date/time) and re-exports it for the tests.
export { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
/** start = min(release − 10m, forced − 60m); end = max(release + 45m, forced + 90m, extended_until); each term only when its input is present; null when none is. */
export function effectiveWindow(p: WindowInputs): EffectiveWindow | null;
/** ISO UTC of max(now, current end) + 30m — what "Extend 30 min" writes; presses stack. */
export function extendedUntil(current: EffectiveWindow | null, nowMs: number): string;
export function windowToIso(w: EffectiveWindow | null): { start: string; end: string } | null;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/window.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  effectiveWindow, extendedUntil, windowToIso, composeReleaseInstant,
  WINDOW_PRE_MS, WINDOW_POST_MS, FORCED_PRE_MS, FORCED_POST_MS, EXTEND_MS,
} from "@/lib/print-watch/window";

const RELEASE = composeReleaseInstant("2026-09-03", "16:05")!.getTime(); // 20:05Z (EDT); the helper returns Date | null

describe("effectiveWindow", () => {
  it("scheduled term only: [release − 10m, release + 45m]", () => {
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: null })!;
    expect(w.startMs).toBe(RELEASE - WINDOW_PRE_MS);
    expect(w.endMs).toBe(RELEASE + WINDOW_POST_MS);
    expect(w.scheduledMs).toBe(RELEASE);
    expect(w.forcedMs).toBeNull();
  });

  it("unresolved TAS row with no press → null (no term at all)", () => {
    expect(effectiveWindow({ event_date: "2026-09-03", release_time_et: null, forced_open_at: null, window_extended_until: null })).toBeNull();
  });

  it("forced term only (TAS row that was pressed): [press − 60m, press + 90m]", () => {
    const press = "2026-09-03T21:00:00.000Z";
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: null, forced_open_at: press, window_extended_until: null })!;
    expect(w.startMs).toBe(Date.parse(press) - FORCED_PRE_MS);
    expect(w.endMs).toBe(Date.parse(press) + FORCED_POST_MS);
    expect(w.scheduledMs).toBeNull();
    expect(w.forcedMs).toBe(Date.parse(press));
  });

  it("both terms: start is the MIN of the starts, end the MAX of the ends", () => {
    const early = new Date(RELEASE - 2 * 60 * 60_000).toISOString(); // pressed 2h before the release
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: early, window_extended_until: null })!;
    expect(w.startMs).toBe(Date.parse(early) - FORCED_PRE_MS);
    expect(w.endMs).toBe(RELEASE + WINDOW_POST_MS);
    const late = new Date(RELEASE + 40 * 60_000).toISOString(); // pressed 40m after the release
    const w2 = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: late, window_extended_until: null })!;
    expect(w2.startMs).toBe(Date.parse(late) - FORCED_PRE_MS); // pooled MIN: the forced lookback reaches 10m further back than the schedule
    expect(w2.endMs).toBe(Date.parse(late) + FORCED_POST_MS);
  });

  it("an extension only ever raises the end", () => {
    const until = new Date(RELEASE + 3 * 60 * 60_000).toISOString();
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: until })!;
    expect(w.endMs).toBe(Date.parse(until));
    const earlierUntil = new Date(RELEASE).toISOString(); // an extension that ends before the scheduled end is inert
    const w2 = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: earlierUntil })!;
    expect(w2.endMs).toBe(RELEASE + WINDOW_POST_MS);
  });

  it("an unparseable stamp is ignored, not thrown", () => {
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: "not-a-date", window_extended_until: "nope" })!;
    expect(w.startMs).toBe(RELEASE - WINDOW_PRE_MS);
    expect(w.endMs).toBe(RELEASE + WINDOW_POST_MS);
  });
});

describe("extendedUntil", () => {
  it("stacks: max(now, current end) + 30m", () => {
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: null });
    const beforeEnd = RELEASE; // now inside the window → current end + 30m
    expect(Date.parse(extendedUntil(w, beforeEnd))).toBe(RELEASE + WINDOW_POST_MS + EXTEND_MS);
    const afterEnd = RELEASE + 2 * 60 * 60_000; // now past the window → now + 30m
    expect(Date.parse(extendedUntil(w, afterEnd))).toBe(afterEnd + EXTEND_MS);
    const second = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: extendedUntil(w, beforeEnd) });
    expect(Date.parse(extendedUntil(second, beforeEnd))).toBe(RELEASE + WINDOW_POST_MS + 2 * EXTEND_MS);
  });
  it("with no window at all, now + 30m", () => {
    expect(Date.parse(extendedUntil(null, 1_000_000))).toBe(1_000_000 + EXTEND_MS);
  });
});

describe("windowToIso", () => {
  it("serialises both bounds as ISO UTC and passes null through", () => {
    expect(windowToIso(null)).toBeNull();
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: null });
    expect(windowToIso(w)).toEqual({ start: new Date(RELEASE - WINDOW_PRE_MS).toISOString(), end: new Date(RELEASE + WINDOW_POST_MS).toISOString() });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/window.test.ts`
Expected: FAIL — cannot find module `@/lib/print-watch/window`.

- [ ] **Step 3: Implement**

`lib/print-watch/window.ts`:

```ts
/**
 * The ONE definition of when a print is live (spec §4.3 "Effective window,
 * one definition"). Every consumer — desiredState, ensurePrintWatch, the
 * acquisition pass, the DJ query bounds, the EDGAR window — reads this, so a
 * go press or an extension changes every one of them at once.
 *
 *   start = min(release − WINDOW_PRE_MS, forced − FORCED_PRE_MS)
 *   end   = max(release + WINDOW_POST_MS, forced + FORCED_POST_MS, window_extended_until)
 *
 * Each term is present only when its input is; an unresolved TAS row that was
 * never pressed has no window at all (null) and is drop-zone only. Stamps are
 * ISO-8601 UTC strings read with Date.parse; an unparseable stamp is ignored
 * rather than thrown (a corrupt column must not take the watcher down).
 */

export const WINDOW_PRE_MS = 10 * 60_000;
export const WINDOW_POST_MS = 45 * 60_000;
export const FORCED_PRE_MS = 60 * 60_000;
export const FORCED_POST_MS = 90 * 60_000;
export const EXTEND_MS = 30 * 60_000;

export interface WindowInputs {
  event_date: string;
  release_time_et: string | null;
  forced_open_at: string | null;
  window_extended_until: string | null;
}

export interface EffectiveWindow {
  startMs: number;
  endMs: number;
  scheduledMs: number | null;
  forcedMs: number | null;
  extendedUntilMs: number | null;
}

import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
export { composeReleaseInstant };

function parseIso(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function effectiveWindow(p: WindowInputs): EffectiveWindow | null {
  const scheduledRaw = p.release_time_et ? composeReleaseInstant(p.event_date, p.release_time_et)?.getTime() : undefined;
  const scheduledMs = scheduledRaw === undefined || scheduledRaw === null || Number.isNaN(scheduledRaw) ? null : scheduledRaw;
  const forcedMs = parseIso(p.forced_open_at);
  const extendedUntilMs = parseIso(p.window_extended_until);

  const starts: number[] = [];
  const ends: number[] = [];
  if (scheduledMs !== null) {
    starts.push(scheduledMs - WINDOW_PRE_MS);
    ends.push(scheduledMs + WINDOW_POST_MS);
  }
  if (forcedMs !== null) {
    starts.push(forcedMs - FORCED_PRE_MS);
    ends.push(forcedMs + FORCED_POST_MS);
  }
  if (starts.length === 0) return null;
  if (extendedUntilMs !== null) ends.push(extendedUntilMs);
  return { startMs: Math.min(...starts), endMs: Math.max(...ends), scheduledMs, forcedMs, extendedUntilMs };
}

export function extendedUntil(current: EffectiveWindow | null, nowMs: number): string {
  const base = current ? Math.max(nowMs, current.endMs) : nowMs;
  return new Date(base + EXTEND_MS).toISOString();
}

export function windowToIso(w: EffectiveWindow | null): { start: string; end: string } | null {
  if (!w) return null;
  return { start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString() };
}
```

Read `composeReleaseInstant` in `lib/calendar/reaction-snapshot.ts` first: it returns a `Date` for an ET `HH:MM` on a date (the watcher's `windowFor` already wraps it and treats a null-ish result as "no window"). If it can return `null`/`NaN` for an unparseable time, keep the `?.getTime() ?? null` guard in `effectiveWindow` and add `Number.isNaN` protection; a NaN instant must yield no scheduled term, not a NaN window.

- [ ] **Step 4: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-c2.txt <<'MSG'
feat(print-watch): effectiveWindow — one definition of when a print is live (scheduled, forced, extended)

Pure module; consumers rewire onto it in the watcher task.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit lib/print-watch/window.ts tests/print-watch/window.test.ts -F /tmp/msg-c2.txt
```

---

### Task 3: `scheduler.ts` — the process-global `AcquisitionScheduler`

**Files:**
- Create: `lib/print-watch/scheduler.ts`
- Test: `tests/print-watch/scheduler.test.ts`

**Interfaces:**
- Consumes: nothing new (pure over injected `now`/`sleep`; `FetchLike` type from `./hardened-fetch`).
- Produces (Tasks 5, 6 consume):

```ts
// lib/print-watch/scheduler.ts
export interface HostPolicy { ratePerSecond: number; concurrency: number }
export const SEC_FAMILY = "sec.gov";
export const DEFAULT_POLICY: HostPolicy = { ratePerSecond: 5, concurrency: 2 };
export const HOST_POLICIES: Record<string, HostPolicy> = { [SEC_FAMILY]: { ratePerSecond: 2, concurrency: 2 } };
/** "www.sec.gov" | "data.sec.gov" | "efts.sec.gov" → "sec.gov"; any other host → itself (lower-cased). */
export function hostFamily(hostname: string): string;
export type PassReason = "cadence" | "burst" | "go" | "stranded";
export interface SchedulerSeams { now: () => number; sleep: (ms: number) => Promise<void> }
export class AbortedError extends Error { readonly name = "AbortError" }
export class AcquisitionScheduler {
  constructor(policies?: Record<string, HostPolicy>, seams?: Partial<SchedulerSeams>);
  /** Waits for a token AND a concurrency slot for the host's family; resolves to the release function. Rejects with AbortedError when the signal aborts while waiting. */
  throttle(hostname: string, signal?: AbortSignal): Promise<() => void>;
  /** global fetch wrapped with throttle(host of the URL) and the signal merged into init.signal. `FetchLike` takes a string URL. */
  fetchFor(signal: AbortSignal, fetchImpl?: FetchLike): FetchLike;
  /** One running pass per print; a request while one runs is remembered ONCE and runs after. Returns when the pass this call caused (or joined) has finished. */
  runPass(printId: number, runner: (signal: AbortSignal) => Promise<void>, reason: PassReason): Promise<void>;
  passInFlight(printId: number): boolean;
  /** Ends a waitForWake early with reason "go" (or the given reason). Safe to call when nothing waits (remembered until the next wait). */
  wake(printId: number, reason?: PassReason): void;
  /** The loop's cadence sleep: resolves early on wake(). */
  waitForWake(printId: number, timeoutMs: number): Promise<PassReason | "timeout">;
  /** Tests / restarts. */
  reset(): void;
}
export const acquisitionScheduler: AcquisitionScheduler;   // the process-global instance the watcher uses
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/scheduler.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { AcquisitionScheduler, hostFamily, SEC_FAMILY, AbortedError } from "@/lib/print-watch/scheduler";

/** A manual clock: `sleep` parks the caller until `advance` moves time past its wake-up. */
function makeClock(start = 1_000_000) {
  let now = start;
  const sleepers: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((resolve) => sleepers.push({ at: now + ms, resolve })),
    async advance(ms: number) {
      now += ms;
      for (const s of sleepers.splice(0).sort((a, b) => a.at - b.at)) {
        if (s.at <= now) s.resolve();
        else sleepers.push(s);
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("hostFamily", () => {
  it("folds every sec.gov host into one family and keeps others as themselves", () => {
    expect(hostFamily("www.sec.gov")).toBe(SEC_FAMILY);
    expect(hostFamily("data.sec.gov")).toBe(SEC_FAMILY);
    expect(hostFamily("EFTS.SEC.GOV")).toBe(SEC_FAMILY);
    expect(hostFamily("ir.acme.example")).toBe("ir.acme.example");
    expect(hostFamily("sec.gov.evil.example")).toBe("sec.gov.evil.example");
  });
});

describe("AcquisitionScheduler.throttle", () => {
  it("SEC family: at most 2 requests per second across CIKs, and the bucket refills", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const r1 = await s.throttle("data.sec.gov");
    const r2 = await s.throttle("www.sec.gov");
    r1(); r2();
    let third = false;
    const p = s.throttle("efts.sec.gov").then((rel) => { third = true; rel(); });
    await clock.advance(100);
    expect(third).toBe(false); // no token yet
    await clock.advance(500);  // 600ms → one token refilled at 2/s
    await p;
    expect(third).toBe(true);
  });

  it("concurrency cap: a third in-flight request waits for a release, not for a token", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 2 } }, clock);
    const r1 = await s.throttle("x.example");
    await s.throttle("x.example");
    let third = false;
    const p = s.throttle("x.example").then((rel) => { third = true; rel(); });
    await clock.advance(1_000);
    expect(third).toBe(false);
    r1();
    await p;
    expect(third).toBe(true);
  });

  it("rejects with AbortedError when the signal aborts while waiting, and the slot is not consumed", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 1, concurrency: 1 } }, clock);
    const r1 = await s.throttle("x.example");
    const ac = new AbortController();
    const p = s.throttle("x.example", ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    r1();
    const r2 = await s.throttle("x.example"); // the aborted waiter left nothing behind
    r2();
  });

  it("fetchFor throttles by the URL's host family and merges the pass signal into init.signal", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const seen: Array<{ url: string; aborted: boolean }> = [];
    const fake = async (url: string, init?: RequestInit) => {
      seen.push({ url, aborted: init?.signal?.aborted ?? false });
      return new Response("ok");
    };
    const ac = new AbortController();
    const f = s.fetchFor(ac.signal, fake);
    await f("https://data.sec.gov/submissions/CIK1.json");
    await f("https://www.sec.gov/Archives/x.htm");
    let third = false;
    const p = f("https://efts.sec.gov/y").then(() => { third = true; });
    await clock.advance(100);
    expect(third).toBe(false); // same family, bucket empty
    await clock.advance(500);
    await p;
    expect(seen.map((x) => x.aborted)).toEqual([false, false, false]);
    ac.abort();
    await expect(f("https://data.sec.gov/z")).rejects.toBeInstanceOf(AbortedError);
  });
});

describe("AcquisitionScheduler.runPass", () => {
  it("coalesces: one running pass per print, one pending pass at most, and the pending one runs after", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    let release!: () => void;
    const runs: string[] = [];
    const first = s.runPass(7, async () => { runs.push("a"); await new Promise<void>((r) => { release = r; }); }, "cadence");
    await Promise.resolve();
    expect(s.passInFlight(7)).toBe(true);
    const second = s.runPass(7, async () => { runs.push("b"); }, "burst");
    const third = s.runPass(7, async () => { runs.push("c"); }, "burst"); // coalesced into the pending slot with `second`
    release();
    await first; await second; await third;
    expect(runs).toEqual(["a", "b"]); // exactly one pending pass ran; "c" was folded into it
    expect(s.passInFlight(7)).toBe(false);
  });

  it("passes for different prints run concurrently", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const order: string[] = [];
    let releaseA!: () => void;
    const a = s.runPass(1, async () => { order.push("a-start"); await new Promise<void>((r) => { releaseA = r; }); order.push("a-end"); }, "cadence");
    const b = s.runPass(2, async () => { order.push("b"); }, "cadence");
    await b;
    releaseA();
    await a;
    expect(order).toEqual(["a-start", "b", "a-end"]);
  });

  it("a runner that throws does not wedge the print: the next pass runs", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    await expect(s.runPass(3, async () => { throw new Error("boom"); }, "cadence")).rejects.toThrow("boom");
    let ran = false;
    await s.runPass(3, async () => { ran = true; }, "cadence");
    expect(ran).toBe(true);
  });
});

describe("AcquisitionScheduler.wake / waitForWake", () => {
  it("waitForWake resolves early with the wake reason, and times out otherwise", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const waiting = s.waitForWake(5, 10_000);
    s.wake(5);
    expect(await waiting).toBe("go");
    const t = s.waitForWake(5, 10_000);
    await clock.advance(10_000);
    expect(await t).toBe("timeout");
  });

  it("a wake that arrives before the wait is remembered once", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    s.wake(9, "burst");
    expect(await s.waitForWake(9, 10_000)).toBe("burst");
    const t = s.waitForWake(9, 1_000);
    await clock.advance(1_000);
    expect(await t).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/scheduler.test.ts`
Expected: FAIL — cannot find module `@/lib/print-watch/scheduler`.

- [ ] **Step 3: Implement**

`lib/print-watch/scheduler.ts`:

```ts
/**
 * The process-global acquisition scheduler (spec §4.3 "Scheduler"; v1 §4.2
 * left it unbuilt). It owns every outbound request the print-watch makes:
 *
 *  - per-HOST-FAMILY token buckets + concurrency caps (`throttle`) — the SEC
 *    hosts (www / data / efts) share ONE bucket at 2 requests/second across
 *    every CIK, which is what the SEC's fair-access policy actually measures;
 *  - a fetch wrapper (`fetchFor`) that applies the throttle by the request's
 *    host and merges the pass signal into `init.signal`, so an aborted pass
 *    cancels the socket (AbortSignal.any, Node 24);
 *  - per-print pass coalescing (`runPass`): one pass runs at a time per print,
 *    a pass requested meanwhile is remembered ONCE and runs after, so a burst
 *    of hits never queues a pile of identical passes;
 *  - an explicit wake (`wake` / `waitForWake`) so a go request ends the loop's
 *    cadence sleep NOW instead of at the next tick.
 *
 * Pure over injected `now`/`sleep`, so every rule above is unit-tested on a
 * manual clock. TWS (the DJ wire) is not an HTTP host and keeps the adapter's
 * own pacing; it only receives the pass signal.
 */
import type { FetchLike } from "./hardened-fetch";

export interface HostPolicy {
  ratePerSecond: number;
  concurrency: number;
}

export const SEC_FAMILY = "sec.gov";
export const DEFAULT_POLICY: HostPolicy = { ratePerSecond: 5, concurrency: 2 };
export const HOST_POLICIES: Record<string, HostPolicy> = {
  [SEC_FAMILY]: { ratePerSecond: 2, concurrency: 2 },
};

export function hostFamily(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h === SEC_FAMILY || h.endsWith(`.${SEC_FAMILY}`) ? SEC_FAMILY : h;
}

export type PassReason = "cadence" | "burst" | "go" | "stranded";

export interface SchedulerSeams {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export class AbortedError extends Error {
  override readonly name = "AbortError";
  constructor(message = "aborted") {
    super(message);
  }
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  inFlight: number;
}

interface PassState {
  running: Promise<void> | null;
  pending: { reason: PassReason; runner: (signal: AbortSignal) => Promise<void>; done: Promise<void>; resolve: () => void; reject: (e: unknown) => void } | null;
}

interface Waiter {
  resolve: (r: PassReason | "timeout") => void;
}

const POLL_MS = 50;

export class AcquisitionScheduler {
  private readonly policies: Record<string, HostPolicy>;
  private readonly seams: SchedulerSeams;
  private readonly buckets = new Map<string, Bucket>();
  private readonly passes = new Map<number, PassState>();
  private readonly waiters = new Map<number, Waiter>();
  private readonly pendingWakes = new Map<number, PassReason>();

  constructor(policies: Record<string, HostPolicy> = HOST_POLICIES, seams: Partial<SchedulerSeams> = {}) {
    this.policies = policies;
    this.seams = {
      now: seams.now ?? (() => Date.now()),
      sleep: seams.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  private bucketFor(family: string): { bucket: Bucket; policy: HostPolicy } {
    const policy = this.policies[family] ?? DEFAULT_POLICY;
    let bucket = this.buckets.get(family);
    if (!bucket) {
      bucket = { tokens: policy.ratePerSecond, lastRefillMs: this.seams.now(), inFlight: 0 };
      this.buckets.set(family, bucket);
    }
    return { bucket, policy };
  }

  private refill(bucket: Bucket, policy: HostPolicy): void {
    const now = this.seams.now();
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(policy.ratePerSecond, bucket.tokens + (elapsed / 1000) * policy.ratePerSecond);
    bucket.lastRefillMs = now;
  }

  async throttle(hostname: string, signal?: AbortSignal): Promise<() => void> {
    const { bucket, policy } = this.bucketFor(hostFamily(hostname));
    for (;;) {
      if (signal?.aborted) throw new AbortedError(`throttle(${hostname}) aborted`);
      this.refill(bucket, policy);
      if (bucket.tokens >= 1 && bucket.inFlight < policy.concurrency) {
        bucket.tokens -= 1;
        bucket.inFlight += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          bucket.inFlight = Math.max(0, bucket.inFlight - 1);
        };
      }
      const untilToken = bucket.tokens >= 1 ? 0 : ((1 - bucket.tokens) / policy.ratePerSecond) * 1000;
      await this.seams.sleep(Math.max(POLL_MS, Math.min(untilToken || POLL_MS, 1000)));
    }
  }

  /** `FetchLike` is `(url: string, init?) => Promise<Response>` (hardened-fetch.ts) — string URLs only. */
  fetchFor(signal: AbortSignal, fetchImpl: FetchLike = (url, init) => fetch(url, init)): FetchLike {
    return async (url, init) => {
      const release = await this.throttle(new URL(url).hostname, signal);
      try {
        const merged = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
        return await fetchImpl(url, { ...init, signal: merged });
      } finally {
        release();
      }
    };
  }

  passInFlight(printId: number): boolean {
    return this.passes.get(printId)?.running !== null && this.passes.has(printId);
  }

  runPass(printId: number, runner: (signal: AbortSignal) => Promise<void>, reason: PassReason): Promise<void> {
    let state = this.passes.get(printId);
    if (!state) {
      state = { running: null, pending: null };
      this.passes.set(printId, state);
    }
    if (state.running) {
      // Coalesce: keep ONE pending pass; a later request joins it. The latest
      // runner wins (it sees the newest runtime), the first reason is kept.
      if (state.pending) {
        state.pending.runner = runner;
        return state.pending.done;
      }
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      state.pending = { reason, runner, done, resolve, reject };
      return done;
    }
    const controller = new AbortController();
    const running = (async () => {
      try {
        await runner(controller.signal);
      } finally {
        state!.running = null;
        const next = state!.pending;
        state!.pending = null;
        if (next) {
          this.runPass(printId, next.runner, next.reason).then(next.resolve, next.reject);
        } else if (!state!.running) {
          this.passes.delete(printId);
        }
      }
    })();
    state.running = running;
    return running;
  }

  wake(printId: number, reason: PassReason = "go"): void {
    const w = this.waiters.get(printId);
    if (w) {
      this.waiters.delete(printId);
      w.resolve(reason);
      return;
    }
    if (!this.pendingWakes.has(printId)) this.pendingWakes.set(printId, reason);
  }

  async waitForWake(printId: number, timeoutMs: number): Promise<PassReason | "timeout"> {
    const remembered = this.pendingWakes.get(printId);
    if (remembered) {
      this.pendingWakes.delete(printId);
      return remembered;
    }
    return new Promise<PassReason | "timeout">((resolve) => {
      const waiter: Waiter = { resolve: (r) => { this.waiters.delete(printId); resolve(r); } };
      this.waiters.set(printId, waiter);
      void this.seams.sleep(timeoutMs).then(() => {
        if (this.waiters.get(printId) === waiter) waiter.resolve("timeout");
      });
    });
  }

  reset(): void {
    this.buckets.clear();
    this.passes.clear();
    for (const w of this.waiters.values()) w.resolve("timeout");
    this.waiters.clear();
    this.pendingWakes.clear();
  }
}

export const acquisitionScheduler = new AcquisitionScheduler();
```

- [ ] **Step 4: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/scheduler.test.ts`
Expected: PASS. Then `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep scheduler` prints nothing.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-c3.txt <<'MSG'
feat(print-watch): AcquisitionScheduler — host-family token buckets, concurrency caps, throttled fetch, per-print pass coalescing, explicit wake

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit lib/print-watch/scheduler.ts tests/print-watch/scheduler.test.ts -F /tmp/msg-c3.txt
```

**Amendments (Codex round 1 — finding #13):**

1. `fetchFor` holds the concurrency slot until the RESPONSE BODY closes (a streamed SEC exhibit is one request for the whole read), releasing on body end, error, cancel, or a headers-only failure:

```ts
  fetchFor(signal: AbortSignal, fetchImpl: FetchLike = (url, init) => fetch(url, init)): FetchLike {
    return async (url, init) => {
      const release = await this.throttle(new URL(url).hostname, signal);
      let handedOff = false;
      try {
        const merged = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
        const res = await fetchImpl(url, { ...init, signal: merged });
        if (!res.body) return res;
        handedOff = true;
        const guarded = res.body.pipeThrough(new TransformStream({ flush: () => release(), cancel: () => release() }));
        return new Response(guarded, { status: res.status, statusText: res.statusText, headers: res.headers });
      } finally {
        if (!handedOff) release();
      }
    };
  }
```

Test: the concurrency test for `fetchFor` reads the body of the first response only AFTER a third request has been issued; the third stays blocked until the first body is consumed (the second slot is taken by request two).

2. Coalescing is FIRST-RUNNER-WINS (a pending pass re-reads the runtime anyway; the test already expects `["a","b"]`): in `runPass`, when `state.pending` exists, do NOT replace `pending.runner` — just return `pending.done`.

3. `runPass` is generic — `runPass<T>(printId, runner: (signal) => Promise<T>, reason): Promise<T>` — and the running pass's `AbortController` is kept on the state so `reset()` can `abort()` every active controller and reject every pending `done` with `AbortedError` before clearing the maps. `passInFlight` reads `state.running !== null`.

---

### Task 4: Adapters cancel — `pollDjNews` honours an `AbortSignal`; EDGAR rides the throttled fetch

**Files:**
- Modify: `lib/print-watch/dj-adapter.ts` (`pollDjNews` gains a trailing `signal?: AbortSignal`; checked before the historical-news call and between article fetches)
- Test: extend `tests/print-watch/dj-adapter.test.ts`; add one EDGAR cancellation case to `tests/print-watch/edgar-adapter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 6 consumes):

```ts
// lib/print-watch/dj-adapter.ts
export async function pollDjNews(
  ib: IBApiLike, conId: number, windowStartUtc: string, nowUtc: string, state: DjPollState, nowMs: number,
  signal?: AbortSignal,          // NEW, trailing and optional — every existing caller and seam keeps compiling
): Promise<DjPollOutput>;
// Throws a DOMException/Error named "AbortError" when `signal` is aborted before the
// historical-news request or between two article-body fetches. State is left
// exactly as before the aborted step (no part group mutated, no id marked seen).

// lib/print-watch/edgar-adapter.ts — NO signature change. `pollEdgar(cik, startIso, endIso, seen, fetchFn)` and
// `resolveCik(symbol, fetchFn)` already take the fetch; Task 6 passes `acquisitionScheduler.fetchFor(signal)`,
// which throttles by host family and carries the signal into every request the adapter makes.
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/print-watch/dj-adapter.test.ts` (reuse the file's existing fake `IBApiLike` builder — the one that scripts `reqHistoricalNews` headlines and `reqNewsArticle` bodies — under a new `describe`):

```ts
describe("pollDjNews — cancellation", () => {
  it("throws AbortError before the historical-news request when the signal is already aborted, touching no state", async () => {
    const ib = fakeIb({ headlines: [], articles: {} });   // the file's existing helper
    const state = createDjPollState();
    const ac = new AbortController();
    ac.abort();
    await expect(pollDjNews(ib, 1, "20260903-20:00:00", "20260903-20:10:00", state, Date.now(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(ib.calls.historicalNews).toBe(0);
    expect(state.seenArticleIds.size).toBe(0);
  });

  it("throws AbortError between article fetches and leaves the part group retryable", async () => {
    // Two-part release: the first body resolves, then the signal aborts, the second body is never requested.
    const ib = fakeIb({
      headlines: [twoPartHeadline("A1", 1), twoPartHeadline("A2", 2)],
      articles: { A1: "part one", A2: "part two" },
    });
    const state = createDjPollState();
    const ac = new AbortController();
    ib.onArticle = (id) => { if (id === "A1") ac.abort(); };
    await expect(pollDjNews(ib, 1, "20260903-20:00:00", "20260903-20:10:00", state, Date.now(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(ib.calls.article).toEqual(["A1"]);
    expect(state.partGroups.size).toBe(1);        // the group is still there for the next poll
    expect(state.seenArticleIds.size).toBe(0);    // nothing retired
  });

  it("without a signal the behaviour is unchanged (one call, both parts stitched)", async () => {
    const ib = fakeIb({
      headlines: [twoPartHeadline("A1", 1), twoPartHeadline("A2", 2)],
      articles: { A1: "part one", A2: "part two" },
    });
    const state = createDjPollState();
    const out = await pollDjNews(ib, 1, "20260903-20:00:00", "20260903-20:10:00", state, Date.now());
    expect(out.completedReleases.map((r) => r.stitchedText)).toEqual(["part one\n\npart two"]);
  });
});
```

If the existing test file has no `fakeIb` / `twoPartHeadline` helpers under those names, use the file's own equivalents (read the file first; keep its fixture shape — the two-part headline format and the quiescence rule are already exercised there) and add an `onArticle` hook + call counters to that fake. Do not create a second fake.

Add to `tests/print-watch/edgar-adapter.test.ts`:

```ts
describe("pollEdgar — cancellation via the caller's fetch", () => {
  it("rejects when the fetch it was handed throws AbortError, and marks nothing seen", async () => {
    const seen = new Set<string>();
    const abortingFetch = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
    await expect(pollEdgar("0000000001", "2026-09-03T19:55:00.000Z", "2026-09-03T20:40:00.000Z", seen, abortingFetch)).rejects.toMatchObject({ name: "AbortError" });
    expect(seen.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/dj-adapter.test.ts tests/print-watch/edgar-adapter.test.ts`
Expected: the two DJ cancellation cases FAIL (no `signal` parameter — the poll completes); the EDGAR case may already pass (the adapter propagates a throwing fetch) — that is fine, it pins the contract.

- [ ] **Step 3: Implement the DJ change**

In `lib/print-watch/dj-adapter.ts`, add the parameter and two checks:

```ts
function throwIfAborted(signal: AbortSignal | undefined, where: string): void {
  if (signal?.aborted) {
    const err = new Error(`pollDjNews aborted ${where}`);
    err.name = "AbortError";
    throw err;
  }
}

export async function pollDjNews(
  ib: IBApiLike,
  conId: number,
  windowStartUtc: string,
  nowUtc: string,
  state: DjPollState,
  nowMs: number,
  signal?: AbortSignal,
): Promise<DjPollOutput> {
  throwIfAborted(signal, "before the historical-news request");
  const windowStartMs = parseTwsDateTimeMs(windowStartUtc);
  // … existing body unchanged down to the part-body loop …
```

and inside the part-body loop (the `for (const part of parts)` inside the `try`), check BEFORE each body request:

```ts
      for (const part of parts) {
        throwIfAborted(signal, "between article fetches");
        const text = await reqNewsArticleOnce(ib, { providerCode: g.providerCode, articleId: part.articleId });
        chunks.push(text);
      }
```

The surrounding `try { … } catch { continue; }` swallows fetch failures to keep the group retryable — an abort must NOT be swallowed into `continue`: change the catch to

```ts
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      continue; // leave the group in state — retried next poll
    }
```

(The group is untouched either way, so an abort leaves it retryable exactly like a failed part fetch.)

- [ ] **Step 4: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/dj-adapter.test.ts tests/print-watch/edgar-adapter.test.ts tests/print-watch/watcher.test.ts`
Expected: PASS (the watcher's fake `pollDjNews` seam ignores the extra argument; nothing else changes).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-c4.txt <<'MSG'
feat(print-watch): pollDjNews honours an AbortSignal between article fetches; EDGAR cancellation pinned through the caller's fetch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit lib/print-watch/dj-adapter.ts tests/print-watch/dj-adapter.test.ts tests/print-watch/edgar-adapter.test.ts -F /tmp/msg-c4.txt
```

**Amendments (Codex round 1 — finding #10):**

1. DJ helpers become abort-aware: `reqHistoricalNewsOnce(ib, params, signal?)` and `reqNewsArticleOnce(ib, params, signal?)` race their internal wait against the signal — on abort they reject with an Error named `AbortError` and detach their TWS listeners (the underlying request cannot be cancelled on the wire, but nothing waits on it any more). `pollDjNews` passes `signal` into both. Test: a historical-news call that never answers rejects the moment the signal aborts (fake timers; no 25-second wait).

2. EDGAR: inside `pollEdgar`'s per-filing `try/catch`, rethrow when `err.name === "AbortError"` — cancellation must never be counted as an ordinary filing failure that yields "ok — 0 filing(s)". Test: an aborting fetch on the SECOND filing rejects `pollEdgar` with `AbortError` and marks neither accession seen.

3. `withSourceTimeout` is NOT deleted (the Task 6 list was wrong): `backfillConId` keeps it (a bounded conId lookup with no abort path); only the road timers move to `withRoad`.

---

### Task 5: `go.ts` — the durable go request, its claim/run loop, and C's merge handler

**Files:**
- Create: `lib/print-watch/go.ts`
- Modify: `lib/print-watch/register.ts` (ONE line: register C's merge handler BEFORE B's)
- Test: `tests/print-watch/go.test.ts`

**Interfaces:**
- Consumes: Task 1 store functions and types; Task 2 `effectiveWindow`/`extendedUntil`; `validatePublicUrl` (`./ssrf`), `redactUrl` (`./hardened-fetch`), `classifyBytes` + `URL_FETCH_MAX_BYTES` (`./url-fetch`), `sha256Hex` (`./delivery`); slice A's `armWorksheet` (`@/lib/mutations/earnings-worksheet-flags`), `enqueuePrepareSteps` + `runPrepareSteps` (`@/lib/earnings/prepare-armed-event`), `attemptPostCommitDrain` (`@/lib/earnings/cloud-outbox`), `getArmedWorksheetEvents` (`@/lib/queries/earnings-worksheet-flags`); `registerEventMergeHandler` types (`@/lib/earnings/event-merge`).
- The watcher (Task 6) is reached ONLY through `GoSeams` with lazily-imported defaults — `go.ts` has no static import of `./watcher` (the watcher's go dispatcher imports `runGoRequest` from here; a static import both ways would be an evaluation cycle).
- Produces (Tasks 6, 7 consume):

```ts
// lib/print-watch/go.ts
export class GoRefused extends Error {}           // → HTTP 400 at the route
export interface GoInput { url?: string; filename?: string; contentBase64?: string }
export interface GoRequestAck { requestId: number; printId: number; forcedOpenAt: string; newlyArmed: boolean }
export interface GoSeams {
  now: () => number;
  /** symbol / date / release time for an ARMED event inside the watch horizon, or null. Default: getArmedWorksheetEvents(db, [yesterday, today, tomorrow]) + the watcher's buildArmedEventDto (lazy import). */
  resolveEvent: (db: Database.Database, eventId: number) => Promise<{ symbol: string; eventDate: string; releaseTimeEt: string | null } | null>;
  /** Default: the watcher's writeAcquiredBytes (lazy import). */
  writeBytes: (printId: number, sha: string, ext: string, buf: Buffer) => Promise<string>;
  /** Default: the watcher's wakePrintWatch (lazy import) = ensurePrintWatch + scheduler.wake. */
  wake: (db: Database.Database, printId: number) => Promise<void>;
  /** Default: the watcher's ingestDocument (lazy import). */
  ingest: (db: Database.Database, printId: number, kind: "user-drop", source: string, url: string | null, buf: Buffer) => Promise<{ outcome: string; rejectReason?: string; docId: number }>;
  /** Default: roads.deliverFromUrl. */
  deliverUrl: (db: Database.Database, printId: number, url: string) => Promise<{ outcome: string; detail: string }>;
  /** Default: the watcher's runForcedPass (lazy import) — one fan-out pass NOW, returning one RoadReport per road. */
  acquire: (db: Database.Database, printId: number) => Promise<RoadReport[]>;
  /** Default: armWorksheet + enqueuePrepareSteps + a detached runPrepareSteps + attemptPostCommitDrain (the worksheet route's arm branch, reused not re-implemented). */
  arm: (db: Database.Database, eventId: number) => Promise<boolean>;
}
export function requestGo(db: Database.Database, eventId: number, input: GoInput, seams?: Partial<GoSeams>): Promise<GoRequestAck>;
/** Claim by CAS and run: input road (file/url) then a forced pass; finalise done/failed. Returns the finalised row, or null when the claim was lost. */
export function runGoRequest(db: Database.Database, requestId: number, seams?: Partial<GoSeams>): Promise<GoRequestRow | null>;
/** Extend 30 min (spec: max(now, current end) + 30m; presses stack). Returns the new until + window. */
export function extendGoWindow(db: Database.Database, eventId: number, nowMs?: number): { printId: number; windowExtendedUntil: string; effectiveWindow: { start: string; end: string } | null };
export const PRINT_WATCH_GO_MERGE_HANDLER_NAME = "print-watch-go";
export function mergePrintWatchGoState(ctx: EventMergeContext): EventMergeTableResult[];
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/go.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { requestGo, runGoRequest, extendGoWindow, mergePrintWatchGoState, GoRefused, type GoSeams } from "@/lib/print-watch/go";
import { getGoRequest, getPrintById, getPrintByEventId, upsertPrint, latestGoRequest } from "@/lib/print-watch/store";
import { effectiveWindow, EXTEND_MS, FORCED_PRE_MS } from "@/lib/print-watch/window";
import { sha256Hex } from "@/lib/print-watch/delivery";

let db: Database.Database;
const NOW = Date.parse("2026-09-10T19:00:00.000Z"); // 15:00 ET on the event date, an hour before a 16:05 print

function seedEvent(sourceKey = "go-ev"): number {
  return Number(
    db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, release_time) VALUES ('manual','earnings','2026-09-10','ACME',?, 'ACME','16:05')`).run(sourceKey).lastInsertRowid,
  );
}

function fakeSeams(over: Partial<GoSeams> = {}): GoSeams & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { arm: [], writeBytes: [], wake: [], ingest: [], deliverUrl: [], acquire: [] };
  const seams: GoSeams = {
    now: () => NOW,
    resolveEvent: async () => ({ symbol: "ACME", eventDate: "2026-09-10", releaseTimeEt: "16:05" }),
    arm: async (_db, eventId) => { calls.arm.push([eventId]); return true; },
    writeBytes: async (printId, sha, ext) => { calls.writeBytes.push([printId, sha, ext]); return `/tmp/pw/${printId}/${sha}.${ext}`; },
    wake: async (_db, printId) => { calls.wake.push([printId]); },
    ingest: async (_db, printId, kind, source) => { calls.ingest.push([printId, kind, source]); return { outcome: "parsed", docId: 41 }; },
    deliverUrl: async (_db, printId, url) => { calls.deliverUrl.push([printId, url]); return { outcome: "rejected", detail: "wrong period" }; },
    acquire: async (_db, printId) => { calls.acquire.push([printId]); return [{ road: "dj", outcome: "skipped", detail: "TWS offline" }, { road: "edgar", outcome: "ok", detail: "0 filings" }, { road: "ir", outcome: "skipped", detail: "no IR page" }]; },
    ...over,
  };
  return Object.assign(seams, { calls });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("requestGo", () => {
  it("arms, creates the print, stamps forced_open_at ONCE, inserts a queued request, and wakes", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, {}, seams);
    expect(seams.calls.arm).toEqual([[eventId]]);
    const print = getPrintByEventId(db, eventId)!;
    expect(ack.printId).toBe(print.id);
    expect(ack.forcedOpenAt).toBe(new Date(NOW).toISOString());
    expect(print.forced_open_at).toBe(ack.forcedOpenAt);
    const req = getGoRequest(db, ack.requestId)!;
    expect(req).toMatchObject({ print_id: print.id, status: "queued", input_kind: "none", attempts: 0 });
    expect(seams.calls.wake).toEqual([[print.id]]);
    // the window opened NOW: forced term [press − 60m, press + 90m] ∪ scheduled term
    const w = effectiveWindow(print)!;
    expect(w.startMs).toBe(NOW - FORCED_PRE_MS);
    // a second press: new request row, SAME stamp (spec §9 ruling 2)
    const again = await requestGo(db, eventId, {}, { ...seams, now: () => NOW + 10 * 60_000 });
    expect(again.forcedOpenAt).toBe(ack.forcedOpenAt);
    expect(again.requestId).not.toBe(ack.requestId);
  });

  it("persists a pasted file content-addressed BEFORE acknowledging, with sha and path on the row", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const html = Buffer.from("<html><body>ACME reports second quarter results</body></html>");
    const ack = await requestGo(db, eventId, { filename: "release.html", contentBase64: html.toString("base64") }, seams);
    const req = getGoRequest(db, ack.requestId)!;
    expect(req.input_kind).toBe("file");
    expect(req.input_sha256).toBe(sha256Hex(html));
    expect(req.input_bytes_path).toBe(`/tmp/pw/${ack.printId}/${sha256Hex(html)}.html`);
    expect(seams.calls.writeBytes[0]).toEqual([ack.printId, sha256Hex(html), "html"]);
  });

  it("stores a pasted URL REDACTED and refuses a non-public one before touching anything", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, { url: "https://ir.acme.example/q2?token=SECRET&x=1" }, seams);
    const req = getGoRequest(db, ack.requestId)!;
    expect(req.input_kind).toBe("url");
    expect(req.input_url).toBe("https://ir.acme.example/q2?x=1");
    expect(req.input_url).not.toContain("SECRET");
    await expect(requestGo(db, eventId, { url: "https://127.0.0.1/x" }, seams)).rejects.toBeInstanceOf(GoRefused);
    await expect(requestGo(db, eventId, { url: "http://ir.acme.example/q2" }, seams)).rejects.toBeInstanceOf(GoRefused);
    expect(seams.calls.arm.length).toBe(1); // the refused presses armed nothing new (validation runs first)
  });

  it("refuses both a url and a file, a binary file, an oversize file, and an event that cannot be resolved", async () => {
    const eventId = seedEvent();
    await expect(requestGo(db, eventId, { url: "https://ir.acme.example/q2", contentBase64: "aGk=" }, fakeSeams())).rejects.toThrow(/one of/);
    const binary = Buffer.alloc(64, 0);
    await expect(requestGo(db, eventId, { contentBase64: binary.toString("base64") }, fakeSeams())).rejects.toThrow(/binary/);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    await expect(requestGo(db, eventId, { contentBase64: big.toString("base64") }, fakeSeams())).rejects.toThrow(/10 MB/);
    await expect(requestGo(db, eventId, {}, fakeSeams({ resolveEvent: async () => null }))).rejects.toThrow(/not armable|not found/);
    expect(getPrintByEventId(db, eventId)).toBeNull();
  });
});

describe("runGoRequest", () => {
  it("claims, runs the input road then a forced pass, and finalises done with one report per road", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const html = Buffer.from("<html>ACME</html>");
    const ack = await requestGo(db, eventId, { contentBase64: html.toString("base64") }, seams);
    const readSeams = fakeSeams({ ...seams, ingest: seams.ingest });
    const row = (await runGoRequest(db, ack.requestId, { ...readSeams, readBytes: async () => html } as Partial<GoSeams>))!;
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(1);
    const reports = JSON.parse(row.result_json!) as Array<{ road: string; outcome: string }>;
    expect(reports.map((r) => r.road)).toEqual(["user-drop", "dj", "edgar", "ir"]);
    expect(reports[0]).toMatchObject({ road: "user-drop", outcome: "parsed" });
    expect(readSeams.calls.acquire).toEqual([[ack.printId]]);
  });

  it("a URL input runs deliverFromUrl on the STORED (redacted) url", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, { url: "https://ir.acme.example/q2?sig=S" }, seams);
    const row = (await runGoRequest(db, ack.requestId, seams))!;
    expect(seams.calls.deliverUrl).toEqual([[ack.printId, "https://ir.acme.example/q2"]]);
    expect(JSON.parse(row.result_json!)[0]).toMatchObject({ road: "user-url", outcome: "rejected", detail: "wrong period" });
  });

  it("a lost claim returns null and changes nothing; a throwing pass finalises failed with the message", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, {}, seams);
    const { claimGoRequest } = await import("@/lib/print-watch/store");
    claimGoRequest(db, ack.requestId, "someone-else", NOW); // a live claim by another owner
    expect(await runGoRequest(db, ack.requestId, seams)).toBeNull();
    expect(getGoRequest(db, ack.requestId)!.status).toBe("claimed");
    const eventId2 = seedEvent("go-ev-2");
    const ack2 = await requestGo(db, eventId2, {}, seams);
    const row = (await runGoRequest(db, ack2.requestId, fakeSeams({ acquire: async () => { throw new Error("scheduler exploded"); } })))!;
    expect(row.status).toBe("failed");
    expect(row.result_json).toContain("scheduler exploded");
  });
});

describe("extendGoWindow", () => {
  it("writes max(now, current end) + 30m and stacks on a repeat press; a repeat GO never extends", async () => {
    const eventId = seedEvent();
    const seams = fakeSeams();
    const ack = await requestGo(db, eventId, {}, seams);
    const before = effectiveWindow(getPrintById(db, ack.printId)!)!;
    const first = extendGoWindow(db, eventId, NOW);
    expect(Date.parse(first.windowExtendedUntil)).toBe(before.endMs + EXTEND_MS);
    const second = extendGoWindow(db, eventId, NOW);
    expect(Date.parse(second.windowExtendedUntil)).toBe(before.endMs + 2 * EXTEND_MS);
    await requestGo(db, eventId, {}, { ...seams, now: () => NOW + 60_000 });
    expect(getPrintById(db, ack.printId)!.window_extended_until).toBe(second.windowExtendedUntil);
    expect(() => extendGoWindow(db, 999_999, NOW)).toThrow(GoRefused);
  });
});

describe("mergePrintWatchGoState", () => {
  it("both prints: go rows follow the target, earliest stamp / latest extension carried; re-home: no-op", async () => {
    const donorEvent = seedEvent("go-d");
    const targetEvent = seedEvent("go-t");
    const seams = fakeSeams();
    const donorAck = await requestGo(db, donorEvent, {}, seams);
    upsertPrint(db, targetEvent, "ACME", "2026-09-10", "16:05");
    const out = mergePrintWatchGoState({ db, donorEventId: donorEvent, targetEventId: targetEvent });
    const goTable = out.find((t) => t.table === "print_watch_go_requests")!;
    expect(goTable.moved).toBe(1);
    expect(latestGoRequest(db, getPrintByEventId(db, targetEvent)!.id)!.id).toBe(donorAck.requestId);
    expect(getPrintByEventId(db, targetEvent)!.forced_open_at).toBe(donorAck.forcedOpenAt);
    // re-home (no target print): nothing to do
    const donor2 = seedEvent("go-d2");
    const target2 = seedEvent("go-t2");
    await requestGo(db, donor2, {}, seams);
    expect(mergePrintWatchGoState({ db, donorEventId: donor2, targetEventId: target2 })).toEqual([]);
  });
});
```

Note on `readBytes`: `GoSeams` gains `readBytes: (path: string) => Promise<Buffer>` (default `fs.promises.readFile`) so the claim can re-read a pasted file without touching the disk in tests — add it to the interface above.

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/go.test.ts`
Expected: FAIL — cannot find module `@/lib/print-watch/go`.

- [ ] **Step 3: Implement**

`lib/print-watch/go.ts`:

```ts
/**
 * The "print is live" action (spec §4.3 "Durable request"). A press is a ROW,
 * not a call: `requestGo` persists everything the desk handed us (arming the
 * event, stamping the forced window once, writing a pasted file content-
 * addressed, storing a pasted link redacted) and inserts a queued request
 * BEFORE acknowledging, so a crash after the ack loses nothing. Whoever holds
 * the watcher lease claims it by compare-and-set (`runGoRequest`): the input
 * road first, then one fan-out pass over the wire/EDGAR/IR roads, and the
 * per-road outcomes land in `result_json` for the panel to show.
 *
 * No static import of ./watcher: the watcher's go dispatcher imports
 * `runGoRequest` from here, and a static import in both directions is an
 * evaluation-order cycle. The watcher is reached through `GoSeams`, whose
 * defaults import it lazily inside the function bodies.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { enqueuePrepareSteps, runPrepareSteps } from "@/lib/earnings/prepare-armed-event";
import { attemptPostCommitDrain } from "@/lib/earnings/cloud-outbox";
import { getArmedWorksheetEvents } from "@/lib/queries/earnings-worksheet-flags";
import type { EventMergeContext, EventMergeTableResult } from "@/lib/earnings/event-merge";
import { todayET } from "@/lib/calendar/date-utils";
import { validatePublicUrl } from "./ssrf";
import { redactUrl } from "./hardened-fetch";
import { classifyBytes, URL_FETCH_MAX_BYTES } from "./url-fetch";
import { sha256Hex } from "./delivery";
import {
  upsertPrint, getPrintByEventId, getPrintById, stampForcedOpen, extendPrintWindow,
  insertGoRequest, getGoRequest, claimGoRequest, finalizeGoRequest, movePrintGoState,
} from "./store";
import { effectiveWindow, extendedUntil, windowToIso } from "./window";
import type { GoInputKind, GoRequestRow, RoadReport } from "./types";

export class GoRefused extends Error {}

export interface GoInput {
  url?: string;
  filename?: string;
  contentBase64?: string;
}

export interface GoRequestAck {
  requestId: number;
  printId: number;
  forcedOpenAt: string;
  newlyArmed: boolean;
}

export interface GoSeams {
  now: () => number;
  resolveEvent: (db: Database.Database, eventId: number) => Promise<{ symbol: string; eventDate: string; releaseTimeEt: string | null } | null>;
  writeBytes: (printId: number, sha: string, ext: string, buf: Buffer) => Promise<string>;
  readBytes: (path: string) => Promise<Buffer>;
  wake: (db: Database.Database, printId: number) => Promise<void>;
  ingest: (db: Database.Database, printId: number, kind: "user-drop", source: string, url: string | null, buf: Buffer) => Promise<{ outcome: string; rejectReason?: string; docId: number }>;
  deliverUrl: (db: Database.Database, printId: number, url: string) => Promise<{ outcome: string; detail: string }>;
  acquire: (db: Database.Database, printId: number) => Promise<RoadReport[]>;
  arm: (db: Database.Database, eventId: number) => Promise<boolean>;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_SEAMS: GoSeams = {
  now: () => Date.now(),
  resolveEvent: async (db, eventId) => {
    const today = todayET();
    const rows = getArmedWorksheetEvents(db, [addDays(today, -1), today, addDays(today, 1)]);
    const row = rows.find((r) => r.eventId === eventId);
    if (!row) return null;
    const { buildArmedEventDto } = await import("./watcher");
    const dto = buildArmedEventDto(db, row);
    return { symbol: dto.symbol, eventDate: dto.eventDate, releaseTimeEt: dto.releaseTimeEt };
  },
  writeBytes: async (printId, sha, ext, buf) => (await import("./watcher")).writeAcquiredBytes(printId, sha, ext, buf),
  readBytes: (p) => fsp.readFile(p),
  wake: async (db, printId) => (await import("./watcher")).wakePrintWatch(db, printId),
  ingest: async (db, printId, kind, source, url, buf) => (await import("./watcher")).ingestDocument(db, printId, kind, source, url, buf),
  deliverUrl: async (db, printId, url) => (await import("./roads")).deliverFromUrl(db, printId, url),
  acquire: async (db, printId) => (await import("./watcher")).runForcedPass(db, printId),
  arm: async (db, eventId) => {
    // The worksheet route's arm branch, reused: arm, enqueue A's prepare
    // steps, kick a pass without awaiting it, hand the generation to the Worker.
    const armed = armWorksheet(db, eventId);
    enqueuePrepareSteps(db, eventId);
    void runPrepareSteps(db, { eventId }).catch((err) => console.warn("[print-watch/go] prepare pass failed:", err));
    await attemptPostCommitDrain(db);
    return armed;
  },
};

const BASE64_MAX_CHARS = Math.ceil(URL_FETCH_MAX_BYTES / 3) * 4 + 4;

interface ParsedInput {
  kind: GoInputKind;
  url: string | null;          // the ORIGINAL url (in-process claim uses it)
  redactedUrl: string | null;  // what the row stores
  bytes: Buffer | null;
  ext: "html" | "txt" | "pdf" | null;
}

function parseInput(input: GoInput): ParsedInput {
  const hasUrl = typeof input.url === "string" && input.url.trim() !== "";
  const hasFile = typeof input.contentBase64 === "string" && input.contentBase64 !== "";
  if (hasUrl && hasFile) throw new GoRefused("Send one of a link or a file, not both.");
  if (hasUrl) {
    const verdict = validatePublicUrl(input.url!.trim());
    if (!verdict.ok) throw new GoRefused(`Link refused: ${verdict.reason}.`);
    return { kind: "url", url: input.url!.trim(), redactedUrl: redactUrl(input.url!.trim()), bytes: null, ext: null };
  }
  if (hasFile) {
    if (input.contentBase64!.length > BASE64_MAX_CHARS) throw new GoRefused("File refused: larger than 10 MB.");
    const bytes = Buffer.from(input.contentBase64!, "base64");
    const shape = classifyBytes(bytes);
    if (shape === "binary") throw new GoRefused("File refused: binary content — print-watch reads HTML, plain text, or PDF.");
    return { kind: "file", url: null, redactedUrl: null, bytes, ext: shape === "html" ? "html" : shape === "pdf" ? "pdf" : "txt" };
  }
  return { kind: "none", url: null, redactedUrl: null, bytes: null, ext: null };
}

/** In-process memory of the ORIGINAL pasted url per request (never persisted). */
const originalUrls = new Map<number, string>();

export async function requestGo(
  db: Database.Database,
  eventId: number,
  input: GoInput,
  seams: Partial<GoSeams> = {},
): Promise<GoRequestAck> {
  const s: GoSeams = { ...DEFAULT_SEAMS, ...seams };
  const parsed = parseInput(input);           // validation first: a refused press arms nothing
  const newlyArmed = await s.arm(db, eventId);
  const ev = await s.resolveEvent(db, eventId);
  if (!ev) throw new GoRefused("Event is not armable inside the watch horizon (yesterday–tomorrow) or was not found.");
  const printId = upsertPrint(db, eventId, ev.symbol, ev.eventDate, ev.releaseTimeEt);

  // Bytes BEFORE the transaction: content-addressed, so a failed transaction
  // leaves nothing wrong on disk and a retry rewrites the same path.
  let sha: string | null = null;
  let bytesPath: string | null = null;
  if (parsed.bytes) {
    sha = sha256Hex(parsed.bytes);
    bytesPath = await s.writeBytes(printId, sha, parsed.ext ?? "txt", parsed.bytes);
  }

  const nowIso = new Date(s.now()).toISOString();
  const { requestId, forcedOpenAt } = db
    .transaction(() => {
      const forcedOpenAt = stampForcedOpen(db, printId, nowIso);
      const requestId = insertGoRequest(db, {
        printId, inputKind: parsed.kind, inputUrl: parsed.redactedUrl, inputSha256: sha, inputBytesPath: bytesPath, requestedAt: nowIso,
      });
      return { requestId, forcedOpenAt };
    })
    .immediate();
  if (parsed.url) originalUrls.set(requestId, parsed.url);

  await s.wake(db, printId);
  return { requestId, printId, forcedOpenAt, newlyArmed };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runGoRequest(
  db: Database.Database,
  requestId: number,
  seams: Partial<GoSeams> = {},
): Promise<GoRequestRow | null> {
  const s: GoSeams = { ...DEFAULT_SEAMS, ...seams };
  const token = randomUUID();
  if (!claimGoRequest(db, requestId, token, s.now())) return null;
  const req = getGoRequest(db, requestId)!;
  const reports: RoadReport[] = [];
  let status: "done" | "failed" = "done";
  try {
    if (req.input_kind === "file" && req.input_bytes_path && req.input_sha256) {
      const bytes = await s.readBytes(req.input_bytes_path);
      const r = await s.ingest(db, req.print_id, "user-drop", `go:${req.input_sha256}`, null, bytes);
      reports.push({ road: "user-drop", outcome: r.outcome, detail: r.rejectReason ?? "" });
    } else if (req.input_kind === "url" && req.input_url) {
      const url = originalUrls.get(requestId) ?? req.input_url;
      originalUrls.delete(requestId);
      const r = await s.deliverUrl(db, req.print_id, url);
      reports.push({ road: "user-url", outcome: r.outcome, detail: r.detail });
    }
    reports.push(...(await s.acquire(db, req.print_id)));
  } catch (err) {
    status = "failed";
    reports.push({ road: "dj", outcome: "failed", detail: errText(err) });
  }
  if (!finalizeGoRequest(db, requestId, token, status, JSON.stringify(reports), s.now())) return null;
  return getGoRequest(db, requestId);
}

export function extendGoWindow(
  db: Database.Database,
  eventId: number,
  nowMs: number = Date.now(),
): { printId: number; windowExtendedUntil: string; effectiveWindow: { start: string; end: string } | null } {
  const print = getPrintByEventId(db, eventId);
  if (!print) throw new GoRefused("No print-watch row for this event — arm it (or press Print is live) first.");
  const until = extendedUntil(effectiveWindow(print), nowMs);
  extendPrintWindow(db, print.id, until);
  return { printId: print.id, windowExtendedUntil: until, effectiveWindow: windowToIso(effectiveWindow(getPrintById(db, print.id)!)) };
}

export const PRINT_WATCH_GO_MERGE_HANDLER_NAME = "print-watch-go";

/** Registered BEFORE slice B's handler (register.ts): B deletes a donor print
 *  on a both-prints merge, and go rows reference prints without a cascade. */
export function mergePrintWatchGoState(ctx: EventMergeContext): EventMergeTableResult[] {
  const donor = getPrintByEventId(ctx.db, ctx.donorEventId);
  const target = getPrintByEventId(ctx.db, ctx.targetEventId);
  if (!donor || !target) return [];
  const out = movePrintGoState(ctx.db, donor.id, target.id);
  return [
    { table: "print_watch_go_requests", moved: out.moved, merged: 0, deleted: 0, notes: [] },
    { table: "print_watch_prints", moved: 0, merged: 1, deleted: 0, notes: [`forced_open_at=${out.forcedOpenAt ?? "null"} window_extended_until=${out.windowExtendedUntil ?? "null"} carried to the target print`] },
  ];
}
```

(`todayET` lives in `lib/calendar/date-utils.ts`; `getArmedWorksheetEvents` and `ArmedWorksheetEventRow` in `lib/queries/earnings-worksheet-flags.ts` — verified.)

In `lib/print-watch/register.ts`, inside `registerPrintWatch()`, insert ABOVE the existing B line:

```ts
  registerEventMergeHandler(PRINT_WATCH_GO_MERGE_HANDLER_NAME, mergePrintWatchGoState); // slice C — MUST precede B's (see go.ts)
```

with `import { mergePrintWatchGoState, PRINT_WATCH_GO_MERGE_HANDLER_NAME } from "./go";` — a static import of `./go` from `register.ts` is fine (go.ts imports nothing from the watcher statically). Add a registration-order test to `tests/print-watch/cross-slice-registration.test.ts`: after `registerPrintWatch()`, `listEventMergeHandlers()` lists `"print-watch-go"` BEFORE `"print-watch"`.

- [ ] **Step 4: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/go.test.ts tests/print-watch/cross-slice-registration.test.ts tests/earnings/ tests/print-watch/merge-handler.test.ts`
Expected: PASS. `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'print-watch/(go|register)'` prints nothing (the lazy `import("./watcher")` defaults reference `writeAcquiredBytes`, `wakePrintWatch`, `runForcedPass`, which Task 6 adds — until then TypeScript reports them missing on the dynamic import's type: to keep this task green on its own, type the lazy module as `Promise<typeof import("./watcher") & { writeAcquiredBytes?: …; wakePrintWatch?: …; runForcedPass?: … }>` and throw a clear `Error("watcher exports missing — Task 6 not landed")` when undefined; Task 6 removes the optional typing).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-c5.txt <<'MSG'
feat(print-watch): durable go requests — requestGo, CAS claim/run, extend, and the go merge handler registered ahead of B's

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit lib/print-watch/go.ts lib/print-watch/register.ts tests/print-watch/go.test.ts tests/print-watch/cross-slice-registration.test.ts -F /tmp/msg-c5.txt
```

**Amendments (Codex round 1 — findings #2, #3, #4, #5, #6, #7, #8, #14, #16, #18):**

REPLACE `requestGo`, `runGoRequest`, `extendGoWindow` and the merge handler with these (the `GoSeams` interface gains `resolveEvent` taking the event id and returning `null` only for a missing or SUPERSEDED `calendar_events` row — any date; and `wake` may throw without failing the press):

```ts
/** Scrub anything that could carry a signed URL or a local path before it is
 *  persisted, returned, or logged (finding #16). */
export function safeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/[^\s"')]+/g, (m) => redactUrl(m))
    .replace(/\/(?:Users|home|private|var)\/[^\s"')]+/g, "<path>")
    .slice(0, 500);
}

function parseInput(input: GoInput): ParsedInput {
  // … as before, plus: a link that carries a secret-bearing query key is
  // REFUSED at the press — it cannot be persisted honestly (user decision (a)):
  if (hasUrl) {
    const trimmed = input.url!.trim();
    const verdict = validatePublicUrl(trimmed);
    if (!verdict.ok) throw new GoRefused(`Link refused: ${verdict.reason}.`);
    if (redactUrl(trimmed) !== trimmed) throw new GoRefused("Link refused: it carries a secret-bearing query parameter — download the release and drop the file instead.");
    return { kind: "url", url: trimmed, redactedUrl: trimmed, bytes: null, ext: null };
  }
  // …
}

export async function requestGo(db, eventId, input, seams = {}): Promise<GoRequestAck> {
  const s: GoSeams = { ...DEFAULT_SEAMS, ...seams };
  const parsed = parseInput(input);                                   // 1. validate — a refused press changes nothing
  const ev = await s.resolveEvent(db, eventId);                        // 2. resolve by id: missing/superseded → refused, still nothing changed
  if (!ev) throw new GoRefused("No earnings event with that id, or it has been superseded.");

  let sha: string | null = null;                                       // 3. stage bytes (content-addressed; unlinked on rollback)
  let bytesPath: string | null = null;
  if (parsed.bytes) {
    sha = sha256Hex(parsed.bytes);
    bytesPath = await s.writeBytes(printId0(db, eventId), sha, parsed.ext ?? "txt", parsed.bytes);
  }

  const nowIso = new Date(s.now()).toISOString();
  let committed: { requestId: number; printId: number; forcedOpenAt: string; newlyArmed: boolean };
  try {
    committed = db.transaction(() => {                                 // 4. ONE immediate transaction
      const newlyArmed = armWorksheet(db, eventId);                    //    (a nested transaction is a savepoint; the outbox row rides inside)
      enqueuePrepareSteps(db, eventId);
      const printId = upsertPrint(db, eventId, ev.symbol, ev.eventDate, ev.releaseTimeEt);
      const forcedOpenAt = stampForcedOpen(db, printId, nowIso);
      const requestId = insertGoRequest(db, { printId, inputKind: parsed.kind, inputUrl: parsed.redactedUrl, inputSha256: sha, inputBytesPath: bytesPath, requestedAt: nowIso });
      return { requestId, printId, forcedOpenAt, newlyArmed };
    }).immediate();
  } catch (err) {
    if (bytesPath && !documentOwnsBytes(db, sha!)) await s.unlink(bytesPath).catch(() => {});
    throw err;
  }
  void runPrepareSteps(db, { eventId }).catch((e) => console.warn("[print-watch/go] prepare pass failed:", safeErrorText(e)));   // 5. post-commit side effects
  await attemptPostCommitDrain(db).catch((e) => console.warn("[print-watch/go] outbox drain failed:", safeErrorText(e)));
  let wakeError: string | null = null;
  try { await s.wake(db, committed.printId); } catch (e) { wakeError = safeErrorText(e); }   // the row is durable; the dispatcher owns it now (finding #4)
  return { ...committed, wakeError };
}
```

`printId0(db, eventId)` = the existing print id if any, else a deterministic staging directory key `pending-<eventId>` (the byte writer takes a string directory key; the final content-addressed path is stored on the row) — simpler: write bytes into `<storageRoot>/staging/<sha>.<ext>` and have `runGoRequest` move them under the print directory on first successful read (`fs.rename`). Pick the staging-directory form; `writeAcquiredBytes(dirKey: number | string, …)` accepts either. `documentOwnsBytes(db, sha)` = `SELECT 1 FROM print_watch_documents WHERE sha256 = ? LIMIT 1`. `GoRequestAck` gains `wakeError: string | null`. `GoSeams` gains `unlink: (path) => Promise<void>` (default `fsp.unlink`) and `resolveEvent` becomes: read `calendar_events` by id (`SELECT id, symbol, event_date, superseded FROM calendar_events WHERE id = ?`), refuse when missing or `superseded = 1`, then `getArmedWorksheetEvents(db, [event_date])` AFTER the arm (call it inside the transaction from the default `arm`? no — resolve the DTO with the watcher's `buildArmedEventDto` on the row returned for that date once armed; if the row is absent even after arming, refuse). Implement `resolveEvent` as: `(db, eventId) => { const row = …calendar_events…; if (!row || row.superseded) return null; return { symbol: row.symbol, eventDate: row.event_date, releaseTimeEt: deriveReleaseTimeEt(db, row) } }` where `deriveReleaseTimeEt` is whatever `buildArmedEventDto` uses today (read it; reuse the same helper — `deriveEarningsSlot`/release-time floor from `lib/earnings/wire-times.ts` — never re-implement).

```ts
export async function runGoRequest(db, requestId, seams = {}): Promise<GoRequestRow | null> {
  const s: GoSeams = { ...DEFAULT_SEAMS, ...seams };
  const token = randomUUID();
  if (!claimGoRequest(db, requestId, token, s.now())) return null;
  const owns = () => heartbeatGoRequest(db, requestId, token, s.now());   // renews claimed_at AND proves ownership (finding #7)
  let req = getGoRequest(db, requestId)!;
  const reports: RoadReport[] = [];
  try {
    if (req.input_kind === "file" && req.input_bytes_path && req.input_sha256) {
      const bytes = await s.readBytes(req.input_bytes_path);
      if (sha256Hex(bytes) !== req.input_sha256) throw new Error("input bytes changed on disk since the press");   // finding #14
      if (!owns()) return null;
      const r = await s.ingest(db, req.print_id, "user-drop", `go:${req.input_sha256}`, null, bytes);
      reports.push({ road: "user-drop", outcome: r.outcome, detail: r.rejectReason ?? "" });
    } else if (req.input_kind === "url" && req.input_url) {
      if (!owns()) return null;
      const r = await s.deliverUrl(db, req.print_id, req.input_url);     // the stored url IS the original (credential links are refused at the press)
      reports.push({ road: "user-url", outcome: r.outcome, detail: r.detail });
    }
    if (!owns()) return null;
    req = getGoRequest(db, requestId)!;                                   // re-read: a merge may have re-homed us (finding #8) — the owns() above already failed in that case
    reports.push(...(await s.acquire(db, req.print_id)));
  } catch (err) {
    reports.push({ road: "system", outcome: "failed", detail: safeErrorText(err) });
    const attempts = getGoRequest(db, requestId)?.attempts ?? GO_MAX_ATTEMPTS;
    if (attempts < GO_MAX_ATTEMPTS) { requeueGoRequest(db, requestId, token, JSON.stringify(reports)); return getGoRequest(db, requestId); }
    finalizeGoRequest(db, requestId, token, "failed", JSON.stringify(reports), s.now());
    return getGoRequest(db, requestId);
  }
  if (!finalizeGoRequest(db, requestId, token, "done", JSON.stringify(reports), s.now())) return null;
  return getGoRequest(db, requestId);
}

export function extendGoWindow(db, eventId, nowMs = Date.now()) {
  const out = db.transaction(() => {                                    // finding #5: read + compute + write under one immediate transaction
    const print = getPrintByEventId(db, eventId);
    if (!print) throw new GoRefused("No print-watch row for this event — arm it (or press Print is live) first.");
    const until = extendedUntil(effectiveWindow(print), nowMs);
    extendPrintWindow(db, print.id, until);
    return { printId: print.id, windowExtendedUntil: until, effectiveWindow: windowToIso(effectiveWindow(getPrintById(db, print.id)!)) };
  }).immediate();
  return out;
}
/** The route (Task 7) calls `wakePrintWatch(db, out.printId)` after `extendGoWindow` returns, so a stopped loop resumes at once (finding #5). */
```

The pasted-URL road inside a go request goes through the scheduler (finding #9): `DEFAULT_SEAMS.deliverUrl` = `(db, printId, url) => deliverFromUrl(db, printId, url, { fetchBytes: (u, opts) => throttledFetchBytes(u, opts) })` where `throttledFetchBytes` acquires `acquisitionScheduler.throttle(host)` around `hardenedFetchBytes` (export a small `throttledFetchBytes` from the watcher next to `writeAcquiredBytes`, Task 6).

Merge handler (finding #8): unchanged shape; `movePrintGoState` now also invalidates in-flight claims (Task 1 amendment). Add to the merge test: a `claimed` row on the donor becomes `queued` with `claim_token NULL` on the target.

Tests to REPLACE/ADD in `tests/print-watch/go.test.ts`: (i) "a credential-bearing link is refused at the press and nothing is armed"; (ii) "a refused press leaves NO state: not armed, no print, no request, staged bytes unlinked" (resolveEvent → null after a file input; assert `seams.calls.unlink` has the staged path); (iii) "a wake that throws still acks with wakeError and the row is queued"; (iv) "an ordinary failure requeues with attempts kept; the third failure finalises failed" (acquire throws thrice across three runGoRequest calls with a fresh token each; assert status transitions queued→queued→failed, attempts 1→2→3, partial `system` report present); (v) "a claim lost to a merge stops the worker: heartbeat false → runGoRequest returns null, no acquire call"; (vi) "the stored file's SHA is re-verified: a modified file fails the request with a system report"; (vii) `extendGoWindow` inside one transaction (two immediate calls in sequence stack); (viii) `safeErrorText` scrubs a signed URL and a home path. Remove the `originalUrls` map and its test ("runs deliverFromUrl on the STORED url" now asserts the stored url equals the pasted one).

---

### Task 6: The watcher on the scheduler — effective window, fan-out passes with cancellation, go wake and dispatcher, status fields

**Files:**
- Modify: `lib/print-watch/watcher.ts` (regions named below — locate by SYMBOL, never by line)
- Test: extend `tests/print-watch/watcher.test.ts` (new `describe("slice C — window, fan-out, go")`)

**Interfaces:**
- Consumes: `effectiveWindow`, `windowToIso`, `EffectiveWindow` (Task 2); `acquisitionScheduler`, `AbortedError`, `PassReason` (Task 3); `pollDjNews(..., signal)` (Task 4); `runGoRequest` (Task 5); store additions (Task 1).
- Produces (Tasks 5's defaults and 7 consume):

```ts
// lib/print-watch/watcher.ts (added / changed exports)
export const ROAD_TIMEOUT_MS = 15_000;                       // = the former SOURCE_TIMEOUT_MS value
export const GO_DISPATCH_MS = 2_000;
export const GO_DISPATCH_IDLE_TICKS = 10;
export async function writeAcquiredBytes(printId: number, sha: string, ext: string, buf: Buffer): Promise<string>;   // the former private writeBytes, exported
/** ensurePrintWatch + scheduler.wake(printId) + one dispatcher pass — the in-process go wake (M-C3). */
export async function wakePrintWatch(db: Database.Database, printId: number): Promise<void>;
/** One fan-out pass NOW for a print this process runs; per-road reports. A print this process does not own → three `skipped` reports naming the reason. */
export async function runForcedPass(db: Database.Database, printId: number): Promise<RoadReport[]>;
/** Claims every takeable go request and runs it (detached); returns how many it claimed. Exported for tests. */
export async function dispatchGoRequests(db: Database.Database): Promise<number>;
export interface WatchStatusRow {
  printId: number; eventId: number; symbol: string; state: PrintWatchState;
  sources: Record<string, string>; coverage: string[];
  forcedOpenAt: string | null;                               // NEW
  windowExtendedUntil: string | null;                        // NEW
  effectiveWindow: { start: string; end: string } | null;    // NEW
  goRequest: { id: number; status: GoRequestStatus; attempts: number; requestedAt: string; result: RoadReport[] | null } | null;  // NEW (latest)
}
// WatcherSeams (changed): fetchImpl: FetchLike (NEW — the raw fetch the scheduler wraps; default `(url, init) => fetch(url, init)`; tests inject an abort-aware fake so no test ever opens a socket);
//                         resolveCik: (symbol: string, fetchFn?: FetchLike) => Promise<string | null>;
//                         pollEdgar: (cik, windowStartIso, windowEndIso, seen, fetchFn?: FetchLike) => Promise<EdgarFiling[]>;
//                         pollDjNews: (ib, conId, windowStartUtc, nowUtc, state, nowMs, signal?: AbortSignal) => Promise<DjPollOutput>;
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/print-watch/watcher.test.ts` a new top-level `describe`. Use the file's existing harness exactly: the `fake` object (`fake.nowMs`, `fake.twsUp`, `fake.cik`, `fake.dj()` / `fake.djCalls`, `fake.edgar()` / `fake.edgarCalls`, `fake.ir()`, `fake.fetchCalls`), installed through `_setTestSeams` in `beforeEach`, plus `seedArmedEvent`, `seedAcmePrint`, `waitUntil`, `vi.useFakeTimers()` + `advanceTimersByTimeAsync`. Extend the harness's two seam fakes so the new arguments are observable: the `pollEdgar` fake forwards its 5th argument to `fake.edgar(fetchFn)`, the `pollDjNews` fake forwards its 7th to `fake.dj(signal)`. Add a `fetchImpl` seam to the harness: `fetchImpl: (url, init) => new Promise((_, reject) => { const s = init?.signal; if (s?.aborted) return reject(abortErr()); s?.addEventListener("abort", () => reject(abortErr()), { once: true }); })` (never resolves, rejects on abort with an Error named `AbortError`) — the throttled fetch the EDGAR lane hands the adapter is built on it, so no test opens a socket. Every deferred/promise below is resolved by the test, never by wall-clock.

```ts
describe("slice C — window, fan-out, go", () => {
  it("polls DJ, EDGAR and IR in ONE pass, concurrently: a stalled EDGAR does not delay the DJ ingest", async () => {
    const { eventId, printId } = seedAcmePrint();               // in-window armed print with a conId + cik
    let releaseEdgar!: () => void;
    fake.edgar = () => new Promise((resolve) => { releaseEdgar = () => resolve([]); });
    fake.twsUp = true;
    fake.dj = () => ({ completedReleases: [acmeRelease()], flashes: [] });   // the file's ACME completed-release fixture
    ensurePrintWatch(db);
    await waitUntil(() => listDocuments(db, printId).length === 1);   // DJ ingested while EDGAR is still pending
    expect(fake.edgarCalls).toBe(1);
    releaseEdgar();
    await waitUntil(() => getWatchStatus(db).find((r) => r.printId === printId)!.sources.edgar.startsWith("ok"));
    void eventId;
  });

  it("a road that exceeds ROAD_TIMEOUT_MS is ABORTED (its signal fires) and the pass still completes with the other roads' results", async () => {
    const { printId } = seedAcmePrint();
    // The throttled fetch carries the pass signal: a road that only resolves
    // when that signal fires is exactly "hung until cancelled".
    fake.edgar = (fetchFn?: (url: string, init?: RequestInit) => Promise<Response>) =>
      new Promise<never>((_resolve, reject) => {
        void fetchFn?.("https://data.sec.gov/probe").catch(reject);
      });
    fake.twsUp = true;
    fake.dj = () => ({ completedReleases: [], flashes: [] });
    ensurePrintWatch(db);
    await vi.advanceTimersByTimeAsync(ROAD_TIMEOUT_MS + 1_000);
    const row = getWatchStatus(db).find((r) => r.printId === printId)!;
    expect(row.sources.edgar).toMatch(/timed out|abort/i);
    expect(row.sources.dj).toMatch(/^ok/);
  });

  it("a go request before the scheduled window forces it open, runs a pass at once, and lands one report per road", async () => {
    // release 3h from now: scheduled term has not opened
    const { eventId } = seedArmedEvent({ symbol: "ACME", issuerName: "Acme Corp", eventTime: hhmmEt(fake.nowMs + 3 * 60 * 60_000) });
    ensurePrintWatch(db);
    let printId = getPrintByEventId(db, eventId)!.id;
    expect(getPrintById(db, printId)!.state).toBe("scheduled");
    fake.twsUp = false;                                            // TWS down at go → wire road skipped (spec §7)
    fake.edgar = () => [];
    const ack = await requestGo(db, eventId, {});                 // REAL requestGo; defaults reach this process's watcher
    printId = ack.printId;
    await waitUntil(() => getGoRequest(db, ack.requestId)?.status === "done");
    expect(getPrintById(db, printId)!.state).toBe("window_open");
    const result = JSON.parse(getGoRequest(db, ack.requestId)!.result_json!) as Array<{ road: string; outcome: string }>;
    expect(result.map((r) => r.road)).toEqual(["dj", "edgar", "ir"]);
    // the pass ran NOW, not at the next cadence tick
    expect(fake.edgarCalls).toBeGreaterThanOrEqual(1);
    // TWS down at go → the wire road is `skipped: TWS offline` (spec §7), EDGAR still polled
    expect(result.find((r) => r.road === "dj")).toMatchObject({ outcome: "skipped" });
  });

  it("the DJ and EDGAR query bounds start at the EFFECTIVE window start (press − 60m), not the scheduled one", async () => {
    const { eventId } = seedArmedEvent({ symbol: "ACME", issuerName: "Acme Corp", eventTime: hhmmEt(fake.nowMs + 3 * 60 * 60_000) });
    ensurePrintWatch(db);
    let djStart = "";
    let edgarStart = "";
    // extend the harness's two seam fakes to record the window-start arguments they receive (fake.djStarts / fake.edgarStarts arrays)
    fake.twsUp = true;
    fake.dj = () => ({ completedReleases: [], flashes: [] });
    fake.edgar = () => [];
    const ack = await requestGo(db, eventId, {});
    await waitUntil(() => getGoRequest(db, ack.requestId)?.status === "done");
    edgarStart = fake.edgarStarts.at(-1)!;
    djStart = fake.djStarts.at(-1)!;
    expect(Date.parse(edgarStart)).toBe(fake.nowMs - FORCED_PRE_MS);
    expect(djStart).toBe(formatTwsDateTime(new Date(fake.nowMs - FORCED_PRE_MS)));
  });

  it("an extension written by ANOTHER process is honoured at the next pass (the window is re-read from the row)", async () => {
    const { printId } = seedAcmePrint();
    ensurePrintWatch(db);
    const before = getWatchStatus(db).find((r) => r.printId === printId)!.effectiveWindow!;
    extendPrintWindow(db, printId, new Date(Date.parse(before.end) + 30 * 60_000).toISOString());   // "another process" wrote the row
    await vi.advanceTimersByTimeAsync(CADENCE_MS + 100);
    fake.nowMs = Date.parse(before.end) + 10 * 60_000;      // past the OLD end, inside the extension
    await vi.advanceTimersByTimeAsync(CADENCE_MS + 100);
    expect(getPrintById(db, printId)!.state).toBe("window_open");   // not expired
  });

  it("go dispatcher: a request queued by another process is claimed within 2 seconds by the lease owner and runs", async () => {
    const { printId } = seedAcmePrint();
    fake.twsUp = false;
    fake.edgar = () => [];
    ensurePrintWatch(db);
    const id = insertGoRequest(db, { printId, inputKind: "none", inputUrl: null, inputSha256: null, inputBytesPath: null, requestedAt: new Date(fake.nowMs).toISOString() });
    ensurePrintWatch(db);                                      // the owner's ensure starts the dispatcher tick
    await vi.advanceTimersByTimeAsync(GO_DISPATCH_MS + 50);
    await waitUntil(() => getGoRequest(db, id)?.status === "done");
    expect(getGoRequest(db, id)!.attempts).toBe(1);
  });

  it("losing the lease mid-pass aborts the pass", async () => {
    const { printId } = seedAcmePrint();
    fake.edgar = (fetchFn?: (url: string, init?: RequestInit) => Promise<Response>) =>
      new Promise<never>((_r, reject) => { void fetchFn?.("https://data.sec.gov/x").catch(reject); });
    fake.twsUp = false;
    ensurePrintWatch(db);
    await vi.advanceTimersByTimeAsync(10);
    // another process takes the lease: our renewal fails on the next interval.
    // Write the row in the EXACT shape `acquireWatcherLease` stores (read store.ts —
    // holder id + expiry); if the harness already has a lease-steal helper, use it.
    stealLease(db, "other-process", fake.nowMs + 60_000);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS + 100);
    const row = getWatchStatus(db).find((r) => r.printId === printId)!;
    expect(row.sources.edgar).toMatch(/abort|lease/i);
  });

  it("status carries forcedOpenAt, windowExtendedUntil, effectiveWindow and the latest goRequest", async () => {
    const { eventId } = seedArmedEvent({ symbol: "ACME", issuerName: "Acme Corp", eventTime: hhmmEt(fake.nowMs + 60 * 60_000) });
    ensurePrintWatch(db);
    fake.twsUp = false;
    fake.edgar = () => [];
    const ack = await requestGo(db, eventId, {});
    await waitUntil(() => getGoRequest(db, ack.requestId)?.status === "done");
    const row = getWatchStatus(db).find((r) => r.printId === ack.printId)!;
    expect(row.forcedOpenAt).toBe(ack.forcedOpenAt);
    expect(row.effectiveWindow).toEqual({ start: new Date(fake.nowMs - FORCED_PRE_MS).toISOString(), end: expect.any(String) });
    expect(row.goRequest).toMatchObject({ id: ack.requestId, status: "done", attempts: 1 });
    expect(row.goRequest!.result!.map((r) => r.road)).toEqual(["dj", "edgar", "ir"]);
  });
});
```

Helpers this block assumes (add them to the harness if absent): `stealLease(db, holder, expiresAtMs)` → overwrites the `print_watch_lease` settings row in the store's own shape; `hhmmEt(ms)` → `"HH:MM"` in America/New_York for an instant on the seeded event date; `acmeRelease()` → the file's existing ACME completed-release fixture; `fake.djStarts` / `fake.edgarStarts` → arrays the two seam fakes push their window-start argument into; `fake.edgarCalls` already exists. Imports needed: `ROAD_TIMEOUT_MS`, `GO_DISPATCH_MS`, `getWatchStatus`, `ensurePrintWatch` from the watcher; `requestGo` from `./go`; `getGoRequest`, `insertGoRequest`, `getPrintById`, `extendPrintWindow`, `listDocuments`, `getPrintByEventId` from the store; `FORCED_PRE_MS` from `./window`; `formatTwsDateTime` from `./dj-adapter`; `CADENCE_MS` and `LEASE_RENEW_MS` — export both constants from the watcher for the tests (they are module constants today).

- [ ] **Step 2: Run them to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/watcher.test.ts -t "slice C"`
Expected: FAIL — `ROAD_TIMEOUT_MS`/`GO_DISPATCH_MS` not exported; `requestGo`'s lazy defaults throw "watcher exports missing"; status rows lack the new fields.

- [ ] **Step 3: Implement — constants, imports, the window**

At the top of `watcher.ts`:

```ts
import { effectiveWindow, windowToIso, type EffectiveWindow } from "./window";
import { acquisitionScheduler, AbortedError, type PassReason } from "./scheduler";
import { runGoRequest } from "./go";
import { getPrintById, listTakeableGoRequests, failCappedGoRequests, latestGoRequest } from "./store";
import type { FetchLike } from "./hardened-fetch";
import type { RoadReport } from "./types";
```

Delete `WINDOW_PRE_MS`, `WINDOW_POST_MS`, `SEC_SPACING_MS`, `DEFAULT_SPACING_MS`, `lastRequestAt`, `spaceHost`, `withSourceTimeout`, the `PrintWindow` interface and `windowFor`. Export the loop constants and add the new ones:

```ts
export const CADENCE_MS = 10_000;
export const LEASE_RENEW_MS = 20_000;
export const ROAD_TIMEOUT_MS = 15_000;      // the former SOURCE_TIMEOUT_MS value, unchanged
export const GO_DISPATCH_MS = 2_000;
export const GO_DISPATCH_IDLE_TICKS = 10;
```

`PrintRuntime.window` becomes `EffectiveWindow | null`, plus `lastReports: RoadReport[]`. The window comes from the ROW, never from the DTO:

```ts
/** The one window (spec §4.3): scheduled ± forced ± extension, read from the
 *  print ROW so a go/extend written by another process is seen (M-C2). */
function windowForPrint(db: Database.Database, printId: number): EffectiveWindow | null {
  const row = getPrintById(db, printId);
  return row ? effectiveWindow(row) : null;
}
```

In `ensurePrintWatch`: replace `const window = windowFor(dto);` with `const window = windowForPrint(db, printId);` (after `upsertPrint`, which now runs first), keep `rt.window = window` on both branches, keep the `inWindow` / `startLoop` / stranded logic unchanged. At the END of `ensurePrintWatch` (after `retireFinishedRuntimes`), add:

```ts
  // Slice C: go requests queued by ANY process are claimed here, by the lease
  // owner, within GO_DISPATCH_MS (M-C3).
  void dispatchGoRequests(db);
  ensureGoDispatcher(db);
```

`desiredState` is unchanged in shape (it already reads `rt.window.startMs/endMs`).

- [ ] **Step 4: Implement — the loop on the scheduler, the pass, the roads**

Replace the body of the task inside `startLoop` (the `while (rt.live)` loop):

```ts
  const task = (async () => {
    let reason: PassReason = "cadence";
    while (rt.live) {
      try {
        await acquisitionScheduler.runPass(rt.printId, (signal) => pass(db, rt, signal), reason);
      } catch (err) {
        statusFor(rt.printId).sources.loop = errText(err);
      }
      if (!rt.live) break;
      if (rt.burst) {
        // A hit on any road makes the others worth re-reading NOW.
        rt.burst = false;
        reason = "burst";
        continue;
      }
      const woke = await acquisitionScheduler.waitForWake(rt.printId, CADENCE_MS);
      reason = woke === "timeout" ? "cadence" : woke;
    }
  })();
```

Replace `pollOnce` with `pass` (same position in the file):

```ts
/**
 * One acquisition pass (spec §4.3 "Scheduler"): the three roads run in
 * PARALLEL under Promise.allSettled, each on its own linked AbortSignal with
 * a per-road timer, so a stalled EDGAR never delays a DJ ingest and a hung
 * request is CANCELLED, not merely abandoned. Lease renewal rides a timer
 * for the duration of the pass; losing it aborts every road at once.
 * Returns one RoadReport per road (what a go request records).
 */
async function pass(db: Database.Database, rt: PrintRuntime, signal: AbortSignal): Promise<RoadReport[]> {
  const status = statusFor(rt.printId);
  if (!renewLeaseIfDue(db)) return skippedReports("lease lost");

  rt.window = windowForPrint(db, rt.printId);   // a go/extend elsewhere changes the row (M-C2)
  const window = rt.window;
  if (!window) {
    rt.live = false; // drop-zone-only print: nothing to poll
    return skippedReports("no window");
  }
  if (seams.now() > window.endMs) {
    rt.live = false;
    const current = readPrintRow(db, rt.printId)?.state;
    if (current && current !== "parsed" && current !== "disarmed") setPrintState(db, rt.printId, "expired");
    return skippedReports("window closed");
  }

  // Crash recovery (Codex #6): anything a previous process acquired but never
  // parsed gets drained on every pass, not just at ingest time.
  await runQueue(db, rt.printId);

  const passController = new AbortController();
  const passSignal = AbortSignal.any([signal, passController.signal]);
  const renew = setInterval(() => {
    if (!renewLeaseIfDue(db)) passController.abort(new Error("watcher lease lost mid-pass"));
  }, LEASE_RENEW_MS);
  let twsUp: boolean | null = null;
  try {
    const [dj, edgar, ir] = await Promise.allSettled([
      withRoad("dj", passSignal, async (s) => { twsUp = await pollDjSource(db, rt, window, s); }),
      withRoad("edgar", passSignal, (s) => pollEdgarSource(db, rt, window, s)),
      withRoad("ir", passSignal, (s) => pollIrSource(db, rt, s)),
    ]);
    for (const [name, r] of [["dj", dj], ["edgar", edgar], ["ir", ir]] as const) {
      if (r.status === "rejected") status.sources[name] = errText(r.reason);
    }
  } finally {
    clearInterval(renew);
  }
  refreshCoverage(db, rt, twsUp);
  rt.lastReports = (["dj", "edgar", "ir"] as const).map((road) => ({
    road,
    outcome: roadOutcome(status.sources[road] ?? ""),
    detail: status.sources[road] ?? "",
  }));
  return rt.lastReports;
}

/** "ok — …" → ok; "tws offline" / "no IR page configured" / "CIK unresolved" → skipped; anything else → failed. */
function roadOutcome(note: string): string {
  if (note.startsWith("ok")) return "ok";
  if (/offline|no conId|none configured|no IR|CIK unresolved|no window/i.test(note)) return "skipped";
  return "failed";
}

function skippedReports(detail: string): RoadReport[] {
  return (["dj", "edgar", "ir"] as const).map((road) => ({ road, outcome: "skipped", detail }));
}

/** A road on its own linked signal: the per-road timer ABORTS it (the socket
 *  closes — Task 4 / hardenedFetchBytes), and the pass signal reaches it too. */
async function withRoad<T>(label: string, parent: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const signal = AbortSignal.any([parent, ac.signal]);
  const timer = setTimeout(() => ac.abort(new Error(`${label} timed out after ${ROAD_TIMEOUT_MS / 1000}s`)), ROAD_TIMEOUT_MS);
  try {
    return await run(signal);
  } catch (err) {
    if (signal.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason.message : `${label} aborted`;
      throw new Error(reason);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

Road signatures and bodies — the changed lines only:

```ts
async function pollDjSource(db, rt, window: EffectiveWindow, signal: AbortSignal): Promise<boolean | null> {
  // … unchanged up to the pollDjNews call …
    const out = await seams.pollDjNews(
      conn.ib, rt.dto.conId,
      formatTwsDateTime(new Date(window.startMs)),   // effective start: press − 60m on a forced window (M-C10)
      formatTwsDateTime(new Date(seams.now())),
      rt.djState, seams.now(),
      signal,                                        // Task 4
    );
  // … the rest unchanged; a TWS-down result keeps `status.sources.dj = "tws offline"` (→ report outcome `skipped`, spec §7) …
}

async function pollEdgarSource(db, rt, window: EffectiveWindow, signal: AbortSignal): Promise<void> {
  const status = statusFor(rt.printId);
  const fetchFn = acquisitionScheduler.fetchFor(signal, seams.fetchImpl);   // SEC family: ≤ 2/s across CIKs, signal on every request; seams.fetchImpl is the raw fetch (injected in tests)
  try {
    if (rt.dto.cik === null && !rt.cikAttempted) {
      rt.cikAttempted = true;
      const cached = cikCache.get(rt.dto.symbol.toUpperCase());
      if (cached !== undefined) rt.dto.cik = cached;
      else {
        const cik = await seams.resolveCik(rt.dto.symbol, fetchFn);   // no spaceHost: the throttle paces
        cikCache.set(rt.dto.symbol.toUpperCase(), cik);
        rt.dto.cik = cik;
      }
    }
    if (rt.dto.cik === null) { status.sources.edgar = "CIK unresolved"; return; }
    const filings = await seams.pollEdgar(
      rt.dto.cik,
      new Date(window.startMs).toISOString(),
      new Date(seams.now()).toISOString(),
      rt.seenAccessions,
      fetchFn,
    );
    // … ingest loop unchanged …
  } catch (err) {
    status.sources.edgar = errText(err);
  }
}

async function pollIrSource(db, rt, signal: AbortSignal): Promise<void> {
  const rss = irConfigFor(rt.dto.symbol);
  if (rss) return pollIrRssSource(db, rt, rss, signal);
  return pollIrPageSource(db, rt, signal);
}
```

In `pollIrRssSource` and `pollIrPageSource`: delete every `await spaceHost(...)`; wrap the lane's `fetchBytes` as
`const fetchBytes: typeof hardenedFetchBytes = async (url, opts) => { const release = await acquisitionScheduler.throttle(new URL(url).hostname, signal); try { return await seams.fetchBytes(url, { ...opts, signal }); } finally { release(); } };`
and use it for the page and every followed link (the existing `allowHost` wrapper stays around it). The RSS lane's feed fetch goes through the same throttle.

`DEFAULT_SEAMS`: `fetchImpl: (url, init) => fetch(url, init)`, `resolveCik: (symbol, fetchFn) => resolveCik(symbol, fetchFn)`, `pollEdgar: (cik, s, e, seen, fetchFn) => pollEdgar(cik, s, e, seen, fetchFn)`, `pollDjNews: (ib, conId, s, now, state, nowMs, signal) => pollDjNews(ib, conId, s, now, state, nowMs, signal)`.

- [ ] **Step 5: Implement — exports, the wake, the forced pass, the dispatcher, the status fields**

```ts
export async function writeAcquiredBytes(printId: number, sha: string, ext: string, buf: Buffer): Promise<string> {
  // ← the former `writeBytes` body, unchanged; rename every internal call site.
}

export async function wakePrintWatch(db: Database.Database, printId: number): Promise<void> {
  ensurePrintWatch(db);
  acquisitionScheduler.wake(printId, "go");
  await dispatchGoRequests(db);
}

export async function runForcedPass(db: Database.Database, printId: number): Promise<RoadReport[]> {
  const rt = runtimes.get(printId);
  if (!rt || !holdsLease()) return skippedReports("watcher not live in this process");
  await acquisitionScheduler.runPass(printId, (signal) => pass(db, rt, signal), "go");
  return rt.lastReports;
}

function holdsLease(): boolean {
  return leaseHeld;   // the boolean `claimLease` already maintains; expose it (add `let leaseHeld = false` next to the lease state if there is no such flag, set on claim/renew success, cleared on failure)
}

let goDispatcher: { timer: ReturnType<typeof setInterval>; idle: number } | null = null;

export async function dispatchGoRequests(db: Database.Database): Promise<number> {
  if (!holdsLease()) return 0;
  const now = seams.now();
  failCappedGoRequests(db, now);
  let claimed = 0;
  for (const row of listTakeableGoRequests(db, now)) {
    if (!runtimes.has(row.print_id)) continue;   // not one of ours — the owner of that print dispatches it
    claimed += 1;
    void runGoRequest(db, row.id).catch((err) => console.warn(`[print-watch] go request ${row.id} failed:`, err));
  }
  return claimed;
}

function ensureGoDispatcher(db: Database.Database): void {
  if (goDispatcher || !holdsLease()) return;
  const wanted =
    listTakeableGoRequests(db, seams.now()).length > 0 ||
    Array.from(runtimes.values()).some((rt) => rt.window?.forcedMs !== null && rt.window !== null && seams.now() <= rt.window.endMs);
  if (!wanted) return;
  const timer = setInterval(() => {
    void (async () => {
      const n = await dispatchGoRequests(db);
      if (!goDispatcher) return;
      goDispatcher.idle = n > 0 ? 0 : goDispatcher.idle + 1;
      if (goDispatcher.idle >= GO_DISPATCH_IDLE_TICKS) {
        clearInterval(goDispatcher.timer);
        goDispatcher = null;
      }
    })();
  }, GO_DISPATCH_MS);
  goDispatcher = { timer, idle: 0 };
}
```

`_setTestSeams(null)` must also clear the dispatcher (`clearInterval`, `goDispatcher = null`) and call `acquisitionScheduler.reset()`.

`getWatchStatus`: add to each row

```ts
      forcedOpenAt: print.forced_open_at,
      windowExtendedUntil: print.window_extended_until,
      effectiveWindow: windowToIso(effectiveWindow(print)),
      goRequest: (() => {
        const g = latestGoRequest(db, print.id);
        if (!g) return null;
        let result: RoadReport[] | null = null;
        try { result = g.result_json ? (JSON.parse(g.result_json) as RoadReport[]) : null; } catch { result = null; }
        return { id: g.id, status: g.status, attempts: g.attempts, requestedAt: g.requested_at, result };
      })(),
```

Finally remove the optional typing Task 5 left on go.ts's lazy watcher import (the three exports now exist).

- [ ] **Step 6: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ tests/api/print-watch-routes.test.ts tests/api/print-watch-sources.test.ts tests/api/print-watch-accept.test.ts tests/api/no-state-changing-get.test.ts`
Expected: PASS (every pre-existing watcher test still green — the fakes ignore the extra `signal`/`fetchFn` arguments; the IR-lane tests that asserted `spaceHost` pacing, if any, now assert the throttle's slot instead). Then `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'lib/print-watch|tests/print-watch'` prints nothing.

- [ ] **Step 7: Commit**

```bash
cat > /tmp/msg-c6.txt <<'MSG'
feat(print-watch): the watcher runs on the acquisition scheduler — effective window from the row, parallel roads on linked abort signals, go wake + 2-second dispatcher, status window/go fields

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit lib/print-watch/watcher.ts lib/print-watch/go.ts tests/print-watch/watcher.test.ts -F /tmp/msg-c6.txt
```

**Amendments (Codex round 1 — findings #1, #9, #10, #11, #12, #18):**

1. **Dispatcher for the life of the lease (finding #1).** `ensureGoDispatcher` starts the 2-second tick when this process ACQUIRES the lease (call it from `claimLease` on success) and never stops it on idle; `stopGoDispatcher()` runs when the lease is lost or released and from `_setTestSeams(null)`. Delete `GO_DISPATCH_IDLE_TICKS`. Test: a request inserted by a second CONNECTION (file-backed DB, `new Database(file)`) while the owner has been idle for ten minutes is still claimed within `GO_DISPATCH_MS` without any call to `ensurePrintWatch`.

2. **Forced prints beyond ±1 day (finding #18).** In `ensurePrintWatch`, the reconciled set is the armed events for `[yesterday, today, tomorrow]` UNION the prints from `listForcedLivePrints(db, now)` (their events fetched with `getArmedWorksheetEvents(db, [print.event_date])`); an unarmed print with a live forced window is treated as armed for this pass (the press armed it). The "no longer armed → disarmed/expired" loop skips prints in that forced set.

3. **Renewal before any awaited work, guarded (finding #11).** In `pass`, create `passController` and start the `LEASE_RENEW_MS` interval BEFORE `runQueue`, with the callback wrapped: `try { if (!renewLeaseIfDue(db)) passController.abort(...) } catch (err) { passController.abort(err instanceof Error ? err : new Error(String(err))); }`. `leaseHeld = false` on every path that gives the lease up (renewal failure, `_setTestSeams(null)`, process shutdown hook). Test: a `renewLeaseIfDue` that THROWS (seam it) aborts the pass and does not crash the process.

4. **Fresh local report on every path; RSS → ir; system road (finding #12).** `pass` returns `RoadReport[]` built from local outcome variables set in this pass (not from `rt.lastReports`); the early exits return `skippedReports(reason)`; the RSS lane writes `status.sources.rss` (kept for the ladder) AND the report maps it to `road: "ir"`; an exception escaping a road's `withRoad` becomes `{ road: <that road>, outcome: "failed", detail: safeErrorText(err) }`, and an exception outside the roads becomes `{ road: "system", … }`. `runForcedPass` returns `acquisitionScheduler.runPass<RoadReport[]>(printId, (signal) => pass(db, rt, signal), "go")` directly.

5. **All outbound polling under the scheduler (finding #9).** `pollIrRss(cfg, seenLinks, baseline, fetchFn?)` gains a fetch parameter (adapter edit — C owns `lib/print-watch/*` on the stacked branch) and the seam passes `acquisitionScheduler.fetchFor(signal, seams.fetchImpl)`; export `throttledFetchBytes(url, opts)` (throttle by host around `seams.fetchBytes`) for `go.ts`'s URL road. Residual, documented in DECISIONS: redirect hops inside `hardenedFetchBytes` share the outer throttle slot (max 3 hops); DJ keeps the TWS adapter's pacing (spec).

6. **`withSourceTimeout` stays for `backfillConId`** (finding #10); the DJ lane passes `signal` and catches `AbortError` into `status.sources.dj = "timed out — aborted"`.

7. Test additions (finding #17): the "second-process claim" test uses a SECOND `better-sqlite3` connection on a temp-file DB (mirroring `tests/print-watch/delivery.test.ts`'s two-connection case) to insert the go row; no call to `ensurePrintWatch` after the insert; assert the claim within `GO_DISPATCH_MS`. Fix the two snippet bugs: `composeReleaseInstant` returns `Date | null` (verified in `lib/calendar/reaction-snapshot.ts`) — the window test uses `!.getTime()` on a known-good input and `effectiveWindow` guards null/NaN; the `runGoRequest` test builds ONE `fakeSeams()` and passes `{ ...seams, readBytes: async () => html }` so all call ledgers are on one object.

---

### Task 7: Routes — `POST/GET /api/print-watch/go`, `POST /api/print-watch/extend`, status fields

**Files:**
- Create: `app/api/print-watch/go/route.ts`, `app/api/print-watch/extend/route.ts`
- Modify: `app/api/print-watch/status/route.ts` (spread the four new fields)
- Test: `tests/api/print-watch-go.test.ts` (NEW file — slice D's route tests live in their own files; no shared test file)

**Interfaces:**
- Consumes: `requestGo`, `extendGoWindow`, `GoRefused` (Task 5); `getGoRequest` (Task 1); `getWatchStatus` rows (Task 6).
- Produces (Task 8 codes against these wire shapes):

```ts
// POST /api/print-watch/go  body { eventId: number; url?: string; filename?: string; contentBase64?: string }
//   200 { success:true, data:{ requestId, printId, forcedOpenAt, newlyArmed } }
//   400 { success:false, error } — GoRefused (both inputs, SSRF/http link, binary, >10 MB, event not armable), bad body
//   500 { success:false, error } — message-only
// GET  /api/print-watch/go?requestId=N   (pure read)
//   200 { success:true, data:{ request:{ id, printId, status, attempts, requestedAt, finishedAt, inputKind, inputUrl, result: RoadReport[] | null } } }
//   400 missing/invalid id · 404 unknown id
// POST /api/print-watch/extend  body { eventId }
//   200 { success:true, data:{ printId, windowExtendedUntil, effectiveWindow:{start,end}|null } } · 400 GoRefused
// GET  /api/print-watch/status — each print gains forcedOpenAt, windowExtendedUntil, effectiveWindow, goRequest (Task 6's WatchStatusRow fields, verbatim)
```

- [ ] **Step 1: Write the failing tests**

`tests/api/print-watch-go.test.ts` — copy the harness head of `tests/api/print-watch-routes.test.ts` (the `vi.hoisted` db, the `@/lib/db` mock, `NextRequest`, `runMigrations`), then:

```ts
// Beyond the routes harness: the go path arms the event (A's prepare steps + the Worker drain)
// and reaches the watcher through go.ts's lazy defaults. Neither may touch the network here.
vi.mock("@/lib/earnings/prepare-armed-event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/prepare-armed-event")>()),
  runPrepareSteps: vi.fn(async () => ({ ran: 0, done: 0, pending: 0, failed: 0, skipped: 0 })),
}));
vi.mock("@/lib/earnings/cloud-outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/cloud-outbox")>()),
  attemptPostCommitDrain: vi.fn(async () => ({ attempted: false })),
}));
const watcherSpies = vi.hoisted(() => ({ wake: vi.fn(async () => {}), forced: vi.fn(async () => [{ road: "dj", outcome: "skipped", detail: "tws offline" }, { road: "edgar", outcome: "ok", detail: "ok — 0 filing(s)" }, { road: "ir", outcome: "skipped", detail: "IR: none configured" }]) }));
vi.mock("@/lib/print-watch/watcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/print-watch/watcher")>();
  return { ...actual, ensurePrintWatch: () => {}, wakePrintWatch: watcherSpies.wake, runForcedPass: watcherSpies.forced,
           writeAcquiredBytes: async (printId: number, sha: string, ext: string) => `/tmp/pw-test/${printId}/${sha}.${ext}` };
});

function seedArmedEvent(): number {
  const today = todayET();
  const eventId = Number(hoisted.db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, release_time) VALUES ('manual','earnings',?,'ACME','go-route-k','ACME','16:05')`).run(today).lastInsertRowid);
  hoisted.db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ACME','Acme Corp','Stock')`).run();
  return eventId;
}

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://test${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/print-watch/go", () => {
  it("acks a press with the request id, print id and the ONCE-stamped forcedOpenAt; the row is queued; the watcher is woken", async () => {
    const eventId = seedArmedEvent();
    const { POST } = await import("@/app/api/print-watch/go/route");
    const r1 = await POST(post("/api/print-watch/go", { eventId }));
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.success).toBe(true);
    expect(b1.data).toMatchObject({ requestId: expect.any(Number), printId: expect.any(Number), forcedOpenAt: expect.any(String) });
    expect(getGoRequest(hoisted.db, b1.data.requestId)?.status).toBe("queued");
    expect(watcherSpies.wake).toHaveBeenCalledWith(expect.anything(), b1.data.printId);
    const r2 = await POST(post("/api/print-watch/go", { eventId }));
    const b2 = await r2.json();
    expect(b2.data.forcedOpenAt).toBe(b1.data.forcedOpenAt);
    expect(b2.data.requestId).not.toBe(b1.data.requestId);
  });

  it("400s: both inputs, a non-public link, a plain-http link, a binary file, an oversize file (before decoding), a bad eventId", async () => {
    const eventId = seedArmedEvent();
    const { POST } = await import("@/app/api/print-watch/go/route");
    const cases: Array<[unknown, RegExp]> = [
      [{ eventId, url: "https://ir.acme.example/x", contentBase64: "aGk=" }, /one of/],
      [{ eventId, url: "https://127.0.0.1/x" }, /refused/i],
      [{ eventId, url: "http://ir.acme.example/x" }, /https/],
      [{ eventId, contentBase64: Buffer.alloc(32, 0).toString("base64") }, /binary/],
      [{ eventId, contentBase64: "A".repeat(15 * 1024 * 1024) }, /10 MB/],
      [{ eventId: "x" }, /eventId/],
    ];
    for (const [body, re] of cases) {
      const res = await POST(post("/api/print-watch/go", body));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toMatch(re);
    }
  });

  it("GET ?requestId= returns the row (pure read) and never the local bytes path; 400 without an id; 404 unknown", async () => {
    const eventId = seedArmedEvent();
    const { POST, GET } = await import("@/app/api/print-watch/go/route");
    const ack = (await (await POST(post("/api/print-watch/go", { eventId, contentBase64: Buffer.from("<html>ACME</html>").toString("base64") }))).json()).data;
    const res = await GET(new NextRequest(`http://test/api/print-watch/go?requestId=${ack.requestId}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.request).toMatchObject({ id: ack.requestId, printId: ack.printId, status: "queued", inputKind: "file", result: null });
    expect(JSON.stringify(json)).not.toContain("/tmp/pw-test");
    expect((await GET(new NextRequest("http://test/api/print-watch/go"))).status).toBe(400);
    expect((await GET(new NextRequest("http://test/api/print-watch/go?requestId=99999"))).status).toBe(404);
  });
});

describe("POST /api/print-watch/extend", () => {
  it("stacks 30 minutes per press and returns the new effective window; 400 with no print", async () => {
    const eventId = seedArmedEvent();
    const { POST: go } = await import("@/app/api/print-watch/go/route");
    const { POST: extend } = await import("@/app/api/print-watch/extend/route");
    await go(post("/api/print-watch/go", { eventId }));
    const r1 = await (await extend(post("/api/print-watch/extend", { eventId }))).json();
    const r2 = await (await extend(post("/api/print-watch/extend", { eventId }))).json();
    expect(Date.parse(r2.data.windowExtendedUntil) - Date.parse(r1.data.windowExtendedUntil)).toBe(30 * 60_000);
    expect(r2.data.effectiveWindow.end).toBe(r2.data.windowExtendedUntil);
    const bad = await extend(post("/api/print-watch/extend", { eventId: 424242 }));
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/print-watch/status (slice C fields)", () => {
  it("carries forcedOpenAt, windowExtendedUntil, effectiveWindow and goRequest for the print", async () => {
    const eventId = seedArmedEvent();
    const { POST: go } = await import("@/app/api/print-watch/go/route");
    const ack = (await (await go(post("/api/print-watch/go", { eventId }))).json()).data;
    const { GET } = await import("@/app/api/print-watch/status/route");
    const json = await (await GET()).json();
    const print = json.data.prints.find((p: { printId: number }) => p.printId === ack.printId);
    expect(print.forcedOpenAt).toBe(ack.forcedOpenAt);
    expect(print.effectiveWindow).toEqual({ start: expect.any(String), end: expect.any(String) });
    expect(print.goRequest).toMatchObject({ id: ack.requestId, status: "queued", attempts: 0 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/api/print-watch-go.test.ts`
Expected: FAIL — cannot find module `@/app/api/print-watch/go/route`.

- [ ] **Step 3: Implement the routes**

`app/api/print-watch/go/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requestGo, GoRefused, type GoInput } from "@/lib/print-watch/go";
import { getGoRequest } from "@/lib/print-watch/store";
import type { RoadReport } from "@/lib/print-watch/types";

export const dynamic = "force-dynamic";

/** 10 MB of bytes, as base64 characters — checked BEFORE Buffer.from so an
 *  oversize body never allocates (the drop route's precheck, same number). */
const BASE64_MAX_CHARS = Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4;

/**
 * POST /api/print-watch/go — "print is live" (spec §4.3). Thin: parse, call
 * requestGo, map GoRefused → 400. Human route by proxy default (session +
 * CSRF + trusted Origin); no route-policy entry.
 */
export async function POST(req: NextRequest) {
  let body: { eventId?: unknown; url?: unknown; filename?: unknown; contentBase64?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Body must be JSON." }, { status: 400 });
  }
  const eventId = body.eventId;
  if (typeof eventId !== "number" || !Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json({ success: false, error: "Body field 'eventId' must be a positive integer." }, { status: 400 });
  }
  const input: GoInput = {};
  if (body.url !== undefined) {
    if (typeof body.url !== "string") return NextResponse.json({ success: false, error: "'url' must be a string." }, { status: 400 });
    input.url = body.url;
  }
  if (body.contentBase64 !== undefined) {
    if (typeof body.contentBase64 !== "string") return NextResponse.json({ success: false, error: "'contentBase64' must be a string." }, { status: 400 });
    if (body.contentBase64.length > BASE64_MAX_CHARS) return NextResponse.json({ success: false, error: "File refused: larger than 10 MB." }, { status: 400 });
    input.contentBase64 = body.contentBase64;
    if (typeof body.filename === "string") input.filename = body.filename;
  }
  try {
    const ack = await requestGo(db, eventId, input);
    return NextResponse.json({ success: true, data: ack });
  } catch (err) {
    if (err instanceof GoRefused) return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/** GET /api/print-watch/go?requestId=N — a PURE READ of one request row
 *  (tests/api/no-state-changing-get.test.ts scans this body). The local bytes
 *  path never leaves the process. */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("requestId");
  const id = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: "Query 'requestId' must be a positive integer." }, { status: 400 });
  }
  const row = getGoRequest(db, id);
  if (!row) return NextResponse.json({ success: false, error: `No go request ${id}.` }, { status: 404 });
  let result: RoadReport[] | null = null;
  try {
    result = row.result_json ? (JSON.parse(row.result_json) as RoadReport[]) : null;
  } catch {
    result = null;
  }
  return NextResponse.json({
    success: true,
    data: {
      request: {
        id: row.id, printId: row.print_id, status: row.status, attempts: row.attempts,
        requestedAt: row.requested_at, finishedAt: row.finished_at, inputKind: row.input_kind, inputUrl: row.input_url, result,
      },
    },
  });
}
```

`app/api/print-watch/extend/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extendGoWindow, GoRefused } from "@/lib/print-watch/go";

export const dynamic = "force-dynamic";

/** POST /api/print-watch/extend { eventId } — "Extend 30 min" (spec §4.3):
 *  window_extended_until = max(now, current end) + 30m; presses stack. */
export async function POST(req: NextRequest) {
  let body: { eventId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Body must be JSON." }, { status: 400 });
  }
  const eventId = body.eventId;
  if (typeof eventId !== "number" || !Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json({ success: false, error: "Body field 'eventId' must be a positive integer." }, { status: 400 });
  }
  try {
    return NextResponse.json({ success: true, data: extendGoWindow(db, eventId) });
  } catch (err) {
    if (err instanceof GoRefused) return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
```

`app/api/print-watch/status/route.ts`: inside the `prints` map, add after `coverage: row.coverage,`:

```ts
        forcedOpenAt: row.forcedOpenAt,
        windowExtendedUntil: row.windowExtendedUntil,
        effectiveWindow: row.effectiveWindow,
        goRequest: row.goRequest,
```

(`getWatchStatus` computed them — the GET stays a pure read.)

- [ ] **Step 4: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/api/print-watch-go.test.ts tests/api/print-watch-routes.test.ts tests/api/no-state-changing-get.test.ts`
Expected: PASS (the repo-wide GET scan admits the new GET — it calls only `getGoRequest`).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-c7.txt <<'MSG'
feat(print-watch): go and extend routes; status carries the effective window and the latest go request

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit app/api/print-watch/go/route.ts app/api/print-watch/extend/route.ts app/api/print-watch/status/route.ts tests/api/print-watch-go.test.ts -F /tmp/msg-c7.txt
```

**Amendments (Codex round 1 — findings #4, #5, #16):**

- `POST /go` returns 200 with `data.wakeError` (string or null) when the press committed but the wake threw — never a 500 for a durable row; the 500 path uses `safeErrorText(err)`; the route's unknown-error branch never returns `err.message` raw.
- `POST /extend` calls `wakePrintWatch(db, out.printId)` after `extendGoWindow` and returns 200 even if the wake throws (`wakeError` in data).
- Add proxy-level classification pins to `tests/api/print-watch-go.test.ts` (the pattern `tests/api/print-watch-sources.test.ts` uses): `classifyRoute("POST", "/api/print-watch/go") === "human"`, same for `GET /api/print-watch/go` and `POST /api/print-watch/extend`; and one negative each for a missing session, a missing CSRF token, and an untrusted Origin, written the way `tests/auth/boundary-matrix.test.ts` drives the proxy's decision for a human route (reuse its helpers; do not re-implement the proxy).

---

### Task 8: Panel — "Print is live", "Extend 30 min", and the go status line

**Files:**
- Modify: `app/dashboard/today/PrintWatchPanel.tsx` (wire-shape types; two pure helpers; two buttons + one status line in `PrintCard` — nothing else)
- Test: extend `tests/dashboard/print-watch-panel.test.ts`

**Interfaces:**
- Consumes: the status wire shape from Task 7 (`forcedOpenAt`, `windowExtendedUntil`, `effectiveWindow`, `goRequest`), `POST /api/print-watch/go`, `POST /api/print-watch/extend`.
- Produces (exported for the panel test):

```ts
export interface GoRequestSummary { id: number; status: "queued" | "claimed" | "done" | "failed"; attempts: number; requestedAt: string; result: Array<{ road: string; outcome: string; detail: string }> | null }
export function goStatusText(go: GoRequestSummary | null): string | null;
export function windowText(w: { start: string; end: string } | null, nowMs: number): string;
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/dashboard/print-watch-panel.test.ts` (it already imports pure helpers from the panel and reads the panel source with `readFileSync` for static assertions):

```ts
describe("goStatusText", () => {
  it("is null with no request, names the phase while queued/claimed, and lists one road outcome per road when done", () => {
    expect(goStatusText(null)).toBeNull();
    expect(goStatusText({ id: 1, status: "queued", attempts: 0, requestedAt: "2026-09-03T20:00:00.000Z", result: null })).toBe("Print is live — queued, waking the watcher…");
    expect(goStatusText({ id: 1, status: "claimed", attempts: 1, requestedAt: "2026-09-03T20:00:00.000Z", result: null })).toBe("Print is live — acquiring (attempt 1)…");
    expect(goStatusText({ id: 1, status: "done", attempts: 1, requestedAt: "2026-09-03T20:00:00.000Z", result: [
      { road: "user-url", outcome: "rejected", detail: "wrong period" }, { road: "dj", outcome: "skipped", detail: "tws offline" }, { road: "edgar", outcome: "ok", detail: "ok — 1 filing(s), 1 exhibit(s)" }, { road: "ir", outcome: "skipped", detail: "IR: none configured" },
    ] })).toBe("Print is live — link: rejected (wrong period) · DJ: skipped (tws offline) · EDGAR: ok · IR: skipped (IR: none configured)");
    expect(goStatusText({ id: 1, status: "failed", attempts: 3, requestedAt: "2026-09-03T20:00:00.000Z", result: [{ road: "dj", outcome: "failed", detail: "scheduler exploded" }] })).toBe("Print is live — FAILED after 3 attempt(s): scheduler exploded");
  });
});

describe("windowText", () => {
  const w = { start: "2026-09-03T19:55:00.000Z", end: "2026-09-03T20:50:00.000Z" };
  it("says when the window opens, that it is open until, or that it closed — in ET — and drop-zone only with no window", () => {
    expect(windowText(null, Date.parse("2026-09-03T19:00:00.000Z"))).toBe("no auto window — drop zone only");
    expect(windowText(w, Date.parse("2026-09-03T19:00:00.000Z"))).toBe("window opens 3:55 PM ET");
    expect(windowText(w, Date.parse("2026-09-03T20:10:00.000Z"))).toBe("window open until 4:50 PM ET");
    expect(windowText(w, Date.parse("2026-09-03T21:00:00.000Z"))).toBe("window closed 4:50 PM ET");
  });
});

describe("PrintWatchPanel source — slice C controls", () => {
  const src = readFileSync("app/dashboard/today/PrintWatchPanel.tsx", "utf8");
  it("posts go and extend through apiFetch exactly once each and renders the go status inside the card", () => {
    expect(src.match(/apiFetch\("\/api\/print-watch\/go"/g)?.length).toBe(1);
    expect(src.match(/apiFetch\("\/api\/print-watch\/extend"/g)?.length).toBe(1);
    expect(src).toContain("Print is live");
    expect(src).toContain("Extend 30 min");
    expect(src).toContain("goStatusText(print.goRequest)");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/print-watch-panel.test.ts`
Expected: FAIL — `goStatusText` / `windowText` not exported; the source assertions fail.

- [ ] **Step 3: Implement**

In `app/dashboard/today/PrintWatchPanel.tsx`:

1. Extend the wire-shape `PrintStatusEntry` interface (the one documented as `GET /api/print-watch/status`) with:

```ts
  forcedOpenAt?: string | null;
  windowExtendedUntil?: string | null;
  effectiveWindow?: { start: string; end: string } | null;
  goRequest?: GoRequestSummary | null;
```

and add the exported `GoRequestSummary` interface from Interfaces.

2. Add the two pure helpers (next to `ladderText`):

```ts
const ROAD_LABELS: Record<string, string> = { "user-url": "link", "user-drop": "file", dj: "DJ", edgar: "EDGAR", ir: "IR" };

/** One line for the go request's state — plain outcomes, no figures. */
export function goStatusText(go: GoRequestSummary | null): string | null {
  if (!go) return null;
  if (go.status === "queued") return "Print is live — queued, waking the watcher…";
  if (go.status === "claimed") return `Print is live — acquiring (attempt ${go.attempts})…`;
  const roads = (go.result ?? []).map((r) => {
    const label = ROAD_LABELS[r.road] ?? r.road;
    return r.outcome === "ok" ? `${label}: ok` : `${label}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`;
  });
  if (go.status === "failed") {
    const why = (go.result ?? []).find((r) => r.outcome === "failed")?.detail ?? "no detail";
    return `Print is live — FAILED after ${go.attempts} attempt(s): ${why}`;
  }
  return `Print is live — ${roads.join(" · ")}`;
}

function etClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET";
}

/** The effective window in desk language (public timing, not portfolio data). */
export function windowText(w: { start: string; end: string } | null, nowMs: number): string {
  if (!w) return "no auto window — drop zone only";
  if (nowMs < Date.parse(w.start)) return `window opens ${etClock(w.start)}`;
  if (nowMs <= Date.parse(w.end)) return `window open until ${etClock(w.end)}`;
  return `window closed ${etClock(w.end)}`;
}
```

3. In `PrintCard`, add state `const [goPending, setGoPending] = useState(false); const [extending, setExtending] = useState(false);` and two handlers:

```ts
  async function handleGo() {
    if (noEventId) { setActionError("This print has no event reference from the server — cannot press go."); return; }
    setGoPending(true);
    setActionError(null);
    try {
      const res = await apiFetch("/api/print-watch/go", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: print.eventId }) });
      const data = (await res.json()) as { success?: boolean; error?: string; data?: { requestId: number } };
      if (!res.ok || !data.success) { setActionError(data.error ?? `Go failed (HTTP ${res.status}).`); return; }
      setActionNote("Print is live — acquiring from every road now.");
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Go failed.");
    } finally {
      setGoPending(false);
    }
  }

  async function handleExtend() {
    if (noEventId) { setActionError("This print has no event reference from the server — cannot extend."); return; }
    setExtending(true);
    setActionError(null);
    try {
      const res = await apiFetch("/api/print-watch/extend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: print.eventId }) });
      const data = (await res.json()) as { success?: boolean; error?: string; data?: { windowExtendedUntil: string } };
      if (!res.ok || !data.success) { setActionError(data.error ?? `Extend failed (HTTP ${res.status}).`); return; }
      setActionNote(`Window extended to ${etClock(data.data!.windowExtendedUntil)}.`);
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Extend failed.");
    } finally {
      setExtending(false);
    }
  }
```

4. In the card header's right-hand group (next to the existing upload `<label>`), add the two buttons and, under the ladder line, the status line — the ONLY JSX additions:

```tsx
        <button
          type="button"
          onClick={handleGo}
          disabled={goPending || print.goRequest?.status === "queued" || print.goRequest?.status === "claimed"}
          className="text-[12px] font-mono border border-edge rounded px-2 py-1 hover:bg-raised disabled:opacity-60"
          title="Acquire from every road now and open the window if it is not open"
        >
          Print is live
        </button>
        {print.effectiveWindow !== null && print.effectiveWindow !== undefined && (
          <button type="button" onClick={handleExtend} disabled={extending} className="text-[12px] font-mono border border-edge rounded px-2 py-1 hover:bg-raised disabled:opacity-60" title="Keep polling 30 minutes longer (presses stack)">
            Extend 30 min
          </button>
        )}
```

```tsx
      <p className="text-[12px] font-mono text-ink-dim">
        {windowText(print.effectiveWindow ?? null, Date.now())}
        {goStatusText(print.goRequest ?? null) ? ` · ${goStatusText(print.goRequest ?? null)}` : ""}
      </p>
```

(`goStatusText(print.goRequest)` must appear verbatim once for the static test; write the line as `const goLine = goStatusText(print.goRequest ?? null);` above the JSX if you prefer — then the assertion string is `goStatusText(print.goRequest`.) `Date.now()` on the client is fine here: the poll refreshes every 10 s, and the text is timing copy, not a figure.

- [ ] **Step 4: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/print-watch-panel.test.ts` and `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint app/dashboard/today/PrintWatchPanel.tsx` (the no-raw-api-fetch rule must stay satisfied — both calls go through `apiFetch`).
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-c8.txt <<'MSG'
feat(today): print-watch card gains Print is live, Extend 30 min, and the go status line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit app/dashboard/today/PrintWatchPanel.tsx tests/dashboard/print-watch-panel.test.ts -F /tmp/msg-c8.txt
```

---

### Task 9: Reference doc and DECISIONS

**Files:**
- Modify: `docs/reference/earnings-pipeline.md` (§Print-watch: the `**Trigger flow.**` paragraph's window sentence; a new `**Go action (v2 slice C).**` paragraph after it; one sentence in `**Known limits.**`)
- Modify: `docs/DECISIONS.md` (append)

- [ ] **Step 1: Edit `earnings-pipeline.md`**

In `**Trigger flow.**`, replace the sentence beginning `Inside [release−10m, release+45m] it polls:` up to `it polls:` with:

`Inside the EFFECTIVE window (`lib/print-watch/window.ts`: start = min(release − 10m, press − 60m), end = max(release + 45m, press + 90m, extension) — the scheduled term needs a resolved release time, the forced term exists once "Print is live" has been pressed, "Extend 30 min" stacks 30-minute extensions, and every consumer reads this one function) it polls the roads IN PARALLEL under the acquisition scheduler (`lib/print-watch/scheduler.ts`: per-host-family token buckets — SEC ≤ 2 requests/second across CIKs — concurrency caps, a per-road abort timer that cancels the socket, one coalesced pass per print):`

Insert after the Trigger-flow paragraph:

`**Go action (v2 slice C).** "Print is live" (`POST /api/print-watch/go` → `lib/print-watch/go.ts::requestGo`) is a durable request: it arms the event if needed, stamps `print_watch_prints.forced_open_at` ONCE (a repeat press never widens the window — extension is the explicit control), persists a pasted file content-addressed or a pasted link redacted BEFORE acknowledging, inserts a `print_watch_go_requests` row, and wakes the watcher. The lease owner claims the row by compare-and-set (a claim older than 60 s is stale and taken over; three attempts, then `failed`), runs the input road, then one fan-out pass; the per-road outcomes land in `result_json` and on the card. Another process's press is picked up within 2 s by the lease owner's dispatcher tick. TWS down at go → the wire road reports `skipped: tws offline` while EDGAR and the IR page still poll.`

In `**Known limits.**` add: `A go pressed from a process that does not hold the lease re-fetches a pasted link from its redacted form (secret-bearing query keys are dropped) — press from the owning process (the packaged app) when the link carries a token.`

- [ ] **Step 2: Append to `docs/DECISIONS.md`** (dated 2026-09-03, direction-only):

`- **Live print v2 slice C (plan mechanics, 2026-09-03).** (M-C1) `print_watch_go_requests.print_id` has no cascade and slice C's merge handler is registered AHEAD of slice B's so go rows are repointed before a donor print is deleted. (M-C3) The cross-process wake is a 2-second dispatcher tick run by the lease owner (no second lease), which satisfies "claimed within 2 seconds of the ensure wake". (M-C7) The request row stores `input_bytes_path` beside `input_sha256` (a column §4.3 omits) so a claim re-reads a pasted file without recomputing the storage path; a pasted link is stored redacted, so a cross-process claim refetches it without secret-bearing keys. (M-C4) SEC pacing is a shared token bucket across www/data/efts at 2 requests/second; other hosts 5/second; DJ keeps the TWS adapter's pacing. (M-C5) The three roads run in parallel on linked AbortSignals with a per-road timer; adapters cancel (DJ between article fetches, EDGAR/IR through the throttled fetch).`

- [ ] **Step 3: Commit**

```bash
cat > /tmp/msg-c9.txt <<'MSG'
docs: earnings-pipeline §Print-watch — effective window, go action, scheduler; DECISIONS — slice C mechanics

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
MSG
git commit docs/reference/earnings-pipeline.md docs/DECISIONS.md -F /tmp/msg-c9.txt
```

---

### Task 10: Verification — suites, build, 090 on a copy, sandbox E2E

**Files:** none new. Evidence, not code.

- [ ] **Step 1: The verification loop**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:changed
ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^ FAIL |Test Files|Tests  '
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build
```

Expected: `verify:changed` green; full suite green (the baseline on the B branch is 7,932 at `702baaf`; report the new count and name any flaky file — the known `watcher.test.ts › IR page lane › "with a step-recorded baseline…"` flake is filed); `next build` clean.

- [ ] **Step 2: 090 on a copy of the live database (additive, applied by the runner)**

```bash
S=/private/tmp/claude-502/-Users-Yitzi-code-vanguard-skin/ea73316b-a720-4b92-bdd7-f433386ed19c/scratchpad   # or any scratch dir
sqlite3 -readonly /Users/Yitzi/code/vanguard-skin/data/vanguard.db "VACUUM INTO '$S/c-090.db'"
# 089 first (slice B's explicit runner — this branch stacks on B):
REPAIR_DB_PATH=$S/c-090.db PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse
# then 090 the way production will get it — the BUILT server's runner on cold start (dummy secrets: the trust boundary fails closed on blanks):
(nohup env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin PORT=3094 HOSTNAME=127.0.0.1 DATABASE_PATH="$S/c-090.db" APP_EXTRA_HOSTS=127.0.0.1:3094 APP_EXTRA_ORIGINS=http://127.0.0.1:3094 ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real CRON_SHARED_SECRET=smoke ELECTRON_SERVICE_CRED=smoke node .next/standalone/server.js > "$S/c-090.log" 2>&1 & echo $! > "$S/c-090.pid"); sleep 8; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3094/login
sqlite3 "$S/c-090.db" "SELECT filename FROM schema_migrations ORDER BY id DESC LIMIT 2; PRAGMA table_info(print_watch_prints);" | grep -E '090|forced_open_at|window_extended_until'
kill "$(cat "$S/c-090.pid")"
```

Expected: `/login` 200; `090_print_watch_go.sql` recorded; both columns present; the go-requests table exists; every existing print row has NULL in both new columns.

- [ ] **Step 3: Sandbox E2E (the worktree dev server on :3095 — `docs/private` / memory "worktree E2E sandbox recipe": VACUUM copy + `scripts/mint-qa-session.ts --db <copy>` + `env -i` with only the real `ANTHROPIC_API_KEY` + dummy CRON/ELECTRON secrets; TWS is never contacted by the watcher)**

Scenarios (one browser agent, screenshots under a scratch dir, no private data in the report):
1. Arm an event whose release is ≥ 2 h ahead (or use a copy where one exists); the card says `window opens …`; state `scheduled`.
2. Press **Print is live** → within 2 s the card's state chip reads `window_open`, the status line says `Print is live — queued/acquiring…` then `… DJ: skipped (tws offline) · EDGAR: ok … · IR: …`; `GET /api/print-watch/go?requestId=` shows `done` with three reports; `GET /status` carries `forcedOpenAt` and `effectiveWindow.start` = press − 60 min.
3. Press **Extend 30 min** twice → `window open until` moves by 60 min; `windowExtendedUntil` in status matches.
4. Press **Print is live** again → a new request id, the same `forcedOpenAt`, the window end unchanged.
5. `POST /api/print-watch/go` with `{ eventId, url: "https://www.sec.gov/?token=SECRET" }` → 200; the request's `result` has a `user-url` report; no `SECRET` anywhere in the status or go payloads. With `{ eventId, url: "https://127.0.0.1/x" }` → 400.
6. `POST /api/print-watch/go` with a small HTML file (base64) → the `user-drop` report; the document appears in `documentRoads` with kind `user-drop`.
7. Console clean; `GET /status` twice 5 s apart identical (read-only).

- [ ] **Step 4: Record the evidence in the SDD ledger** (counts only) and stop the sandbox by PID.

- [ ] **Step 5: Deploy note (no action in this task)**

C merges AFTER B. The order next session is B's 089 cutover runbook (quit app → backup → `--rehearse` → `--live`), then C merges, then the desktop app is rebuilt; 090 is additive and applies implicitly on that launch (proved in Step 2).

---

**Amendments (Codex round 1 — findings #15, #17):**

- Step 2 is REPLACED: (a) `VACUUM INTO` the copy; (b) apply 089 to the copy FROM THE B WORKTREE (`cd ../vanguard-skin-print-v2-b && REPAIR_DB_PATH=<copy> npx tsx scripts/migrate-089-document-identity.ts --rehearse` — B's runner refuses when a later migration is pending, so it must run from a tree where 090 does not exist); (c) record `SELECT count(*), sum(length(hex(quote(symbol||event_date||COALESCE(release_time_et,'')||state)))) FROM print_watch_prints` (a cheap row digest) and `PRAGMA foreign_key_check` / `PRAGMA integrity_check` on the copy; (d) cold-start the BUILT C server on the copy; (e) assert `schema_migrations` ends `…089…, 090_print_watch_go.sql`, the digest is unchanged, every row has NULL in both new columns, `foreign_key_check` empty, `integrity_check` ok.
- Step 3 (E2E) is split: the sandbox scenario uses the worktree dev server with the watcher SEAMS driven by a test hook? No — the app has no runtime seam switch; keep the sandbox E2E as an explicit **opt-in live smoke** (real SEC over the throttled fetch — public data; the real Anthropic key only; TWS never contacted) and add a **seams-driven integration test** in `tests/print-watch/watcher.test.ts` (Task 6's go test already covers press → window_open → pass → reports without any network). The live smoke's event is seeded relative to `todayET()` in the sandbox copy (an ACME row two hours ahead, armed), never a real ticker's print.

## Self-review (run after writing; findings fixed inline)

**Spec coverage (§4.3):** durable request row with the listed columns → Task 1 (+ `input_bytes_path`, M-C7); arm-if-not-armed + prepare steps → Task 5 (`GoSeams.arm` reuses the worksheet route's branch); `forced_open_at` stamped once → Task 1 `stampForcedOpen` + Task 5 test "same stamp"; input persisted before ack → Task 5 (`writeBytes` before the transaction, row inserted in it, ack after); wake within 2 s → Task 6 `wakePrintWatch` (in-process) + dispatcher tick (cross-process, M-C3); CAS claim / 60 s stale / 3 attempts → Task 1 store + Task 5 `runGoRequest`; route returns `{ requestId, forcedOpenAt }` → Task 7; row polls the request and shows per-road outcomes → Task 8 `goStatusText` from `goRequest.result`; C's merge handler → Task 5 (registered ahead of B's, M-C1). Effective window: one definition, all consumers → Task 2 + Task 6 (`windowForPrint` everywhere, DJ/EDGAR bounds from `window.startMs`); `WINDOW_PRE_MS`/`WINDOW_POST_MS` → Task 2; extend stacks, repeat go never extends → Task 5 (`extendGoWindow`, `stampForcedOpen`) + tests; ISO UTC + `Date.parse` → M-C12, Tasks 1–2. Scheduler: per-host token buckets (SEC ≤ 2/s across CIKs) + concurrency caps + parallel fan-out with AbortSignal cancellation + coalescing + explicit wake → Tasks 3, 4, 6; write queue kept → Task 6 (`runQueue`/`enqueueWrite` untouched). §5 090 → Task 1. §6 routes → Task 7. §7 failure modes: TWS down at go → `skipped` report (Task 6 `roadOutcome`), lease-elsewhere claim within 2 s / stale takeover at 60 s → Tasks 1, 6. §8 C-line: input persisted before ack (T5), window lookback (T6 "query bounds"), repeat press (T5), extend stacks (T5/T7), second-process claim (T6 dispatcher test), stale takeover (T1), scheduler fan-out / coalescing / buckets / cancellation (T3, T4, T6).

**Placeholder scan:** none — every code step carries its code; the two "unchanged" markers in Task 6 name the exact existing bodies to keep.

**Type consistency:** `RoadReport.road` is the union `"user-drop" | "user-url" | "dj" | "edgar" | "ir"` in Task 1 and every producer (Tasks 5, 6) and consumer (Tasks 7, 8) uses those strings; `GoSeams` in Task 5 includes `readBytes` (added by the note under its tests); `WatchStatusRow`'s four new fields (Task 6) are the exact names the status route spreads (Task 7) and the panel reads (Task 8); `effectiveWindow` returns `EffectiveWindow | null` (Task 2) and the watcher's `PrintRuntime.window` takes that type (Task 6); `fetchFor` returns `FetchLike` (string URL) matching `hardened-fetch.ts` (Task 3) and is what `pollEdgar`'s fifth parameter accepts (Task 4/6).
