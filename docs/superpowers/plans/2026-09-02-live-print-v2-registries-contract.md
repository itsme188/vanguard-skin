# Live print v2 — cross-slice registry contract (A creates, B calls)

Both plans quote these signatures VERBATIM. Migration numbers: A = 088, B = 089.

## lib/earnings/event-merge.ts (created by slice A)

```ts
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

## lib/earnings/prepare-armed-event.ts (created by slice A)

```ts
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
  /** [R13, 2026-09-03] ADDITIVE: aborted when the invocation blows PREPARE_STEP_TIMEOUT_MS.
   *  A step registered through the shim may still type `ctx` as `{ now }` — it stays assignable.
   *  A long step should check `ctx.signal.aborted` between units of work (and forward it to any
   *  fetch) and keep its side effects idempotent, because the runner books the row `failed` at
   *  the deadline whether or not the step notices. */
  signal: AbortSignal;
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

export const PREPARE_MAX_ATTEMPTS = 5;
export const PREPARE_CLAIM_STALE_MS = 5 * 60_000;
/** [R13, 2026-09-03] Per-invocation deadline. Strictly INSIDE PREPARE_CLAIM_STALE_MS so the
 *  claim's owner always finalises before another runner could take the row over. */
export const PREPARE_STEP_TIMEOUT_MS = 4 * 60_000;

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

## Slice B's shim (so B never touches lib/earnings/*)

`lib/print-watch/registry-shim.ts` exports `registerEventMergeHandler`, `registerPrepareStep`,
`stableHash` with the signatures above, backed by an in-memory collecting registry plus
`__shimRegistrations()` for tests. `lib/print-watch/register.ts` imports from the shim and is the
ONLY B file that names the registries. The post-merge integration task (whichever slice merges
second) swaps the import to `@/lib/earnings/event-merge` / `@/lib/earnings/prepare-armed-event`,
deletes the shim, and lands the cross-slice test.

## Migration runner (decided for B)

`.ts` migrations are discovered through a STATIC registry (`lib/db/code-migrations.ts` exporting
`CODE_MIGRATIONS: Record<string, (db: Database.Database) => void>` keyed by filename, e.g.
`"089_print_watch_document_identity.ts"`), not by `readdirSync` — the packaged app copies only
`*.sql` (electron-builder.yml extraResources filter) and has no TypeScript loader, so a runtime
`import()` of a `.ts` file would fail in production. The runner unions on-disk `.sql` names with
registry keys, sorts by the numeric prefix, and applies each inside the same per-migration
`db.transaction`. A guard test asserts every `NNN_*.ts` file under `lib/db/migrations/` is a
registry key and vice versa.

## Pinned-DNS fetch (decided for B)

`undici` is not importable in this project (not a dependency; Node does not expose it).
`hardenedFetchBytes` uses `node:https` `request()` with the `lookup` option returning the
pre-validated address and `servername` = the hostname (SNI + certificate validation intact),
`agent: false`, manual redirects, `req.destroy()` on abort, streamed cap.

## Bogey consensus basis (decided for A — deviation D1 from spec §4.1 step 2 / §5)

`compileContracts` (lib/print-watch/contracts.ts, not A's file) picks the first non-null
`eps_consensus` by rowid. A therefore stores the Finnhub EPS in a NEW column
`earnings_bogeys.eps_consensus_vendor` and leaves `eps_consensus` NULL on the `'finnhub'` row, so
the adjusted-EPS expected value can never be filled by a vendor figure without any edit to
`lib/print-watch/*`. Snapshot v11 bogey rows carry `eps_consensus_vendor`; every surface that
renders it labels it "vendor, basis unspecified". The spec's `eps_consensus_basis` column is not
added.
