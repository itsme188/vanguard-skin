/**
 * Cloud outbox writer + sender (live print v2, slice A §4.1).
 *
 * Writer: every mutation that changes the armed projection appends one
 * `cloud_outbox` row INSIDE its own transaction, so the row and the state it
 * describes commit together — a crash can never leave the Worker holding a
 * generation the Mac does not.
 *
 * Sender: a drain posts unsent rows to the Worker in generation order and
 * stops at the first transport failure (5xx, network, timeout). The Worker
 * ignores a generation <= the one it holds (Task 8), which makes a retry of an
 * already-applied row harmless. Every payload is the full list, so a row the
 * Worker rejected (400) or one below a delivered generation is closed rather
 * than replayed — see `drainCloudOutbox`.
 */
import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import {
  ARMED_EVENTS_KIND,
  buildArmedEventsEntries,
  buildRemovedEventIds,
  buildSupersededEventIds,
  readArmedGeneration,
  readPreviousArmedEntries,
  readPreviousRemovedEventIds,
  readPreviousSupersededEventIds,
  sameProjection,
  sameRemovedEventIds,
  sameSupersededEventIds,
  type ArmedEventsPayload,
} from "./armed-events-projection";

const DEFAULT_TIMEOUT_MS = 3000;
/** Post-commit pushes hand off to the sweep rather than making a user wait. */
const DEFAULT_POST_COMMIT_CAP_MS = 2000;

/**
 * Append the current armed projection at generation MAX+1.
 *
 * Call INSIDE a write transaction (IMMEDIATE, or a deferred one that has
 * already written — the RESERVED lock is what makes MAX(generation) stable
 * across connections). D10: an identical projection writes no row and reports
 * the generation that already stands.
 */
export function writeArmedEventsOutboxRow(
  db: Database.Database,
  opts: { today?: string; nowMs?: number; removedEvents?: Array<{ id: number; eventDate: string }> } = {},
): { generation: number; written: boolean } {
  if (!db.inTransaction) {
    throw new Error("writeArmedEventsOutboxRow must run inside a transaction");
  }
  const current = readArmedGeneration(db);
  const today = opts.today ?? todayET();
  const entries = buildArmedEventsEntries(db, {
    today,
    nowMs: opts.nowMs,
  });
  const supersededEventIds = buildSupersededEventIds(db, { today });
  const removedEventIds = buildRemovedEventIds(db, {
    today,
    nowMs: opts.nowMs,
    removedEvents: opts.removedEvents,
  });
  // Read the previous entries through the projection's GUARDED reader: a
  // truncated payload must be treated as "no previous entries", never thrown
  // from inside armWorksheet's transaction, or one corrupt row would wedge
  // every future arm/disarm/edit.
  if (
    sameProjection(readPreviousArmedEntries(db), entries) &&
    sameSupersededEventIds(readPreviousSupersededEventIds(db), supersededEventIds) &&
    sameRemovedEventIds(readPreviousRemovedEventIds(db), removedEventIds)
  ) {
    return { generation: current, written: false };
  }
  const generation = current + 1;
  const payload: ArmedEventsPayload = { generation, entries, supersededEventIds, removedEventIds };
  db.prepare(`INSERT INTO cloud_outbox (kind, generation, payload_json) VALUES (?, ?, ?)`).run(
    ARMED_EVENTS_KIND,
    generation,
    JSON.stringify(payload),
  );
  return { generation, written: true };
}

export interface PostCommitDrainResult {
  /** True when the cap fired first — the drain is still running in background. */
  timedOut: boolean;
  /** The drain's own result, or null when it timed out or failed. */
  result: OutboxDrainResult | null;
}

/**
 * The post-commit push a mutating route makes after its write lands.
 *
 * `drainCloudOutbox` chains onto whatever drain is already in flight, so its
 * own `timeoutMs` caps only ITS fetches — a caller queued behind a sweep drain
 * over N rows would wait N × timeout. This caps the WHOLE wait: the chained
 * drain races a timer, and when the timer wins the caller is handed
 * `{ timedOut: true }` while the drain keeps running in the background (the
 * sweep is the backstop either way). Never throws.
 */
export async function attemptPostCommitDrain(
  db: Database.Database,
  opts: { capMs?: number; deps?: OutboxSenderDeps } = {},
): Promise<PostCommitDrainResult> {
  const capMs = opts.capMs ?? DEFAULT_POST_COMMIT_CAP_MS;
  // The cap governs the WHOLE wait, so it must also govern the fetch inside it:
  // a caller-supplied `timeoutMs` longer than `capMs` would leave a fetch (and
  // its abort timer) running well past the handoff. Spread FIRST, cap LAST.
  const drain: Promise<PostCommitDrainResult> = drainCloudOutbox(db, {
    ...opts.deps,
    timeoutMs: capMs,
  }).then(
    (result) => ({ timedOut: false, result }),
    (err) => {
      console.warn("[cloud-outbox] post-commit drain failed:", err);
      return { timedOut: false, result: null };
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<PostCommitDrainResult>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, result: null }), capMs);
  });
  const out = await Promise.race([drain, capped]);
  clearTimeout(timer);
  if (out.timedOut) {
    console.warn(
      `[cloud-outbox] post-commit drain still running after ${capMs}ms — handing off to the sweep`,
    );
  }
  return out;
}

/** Sent rows are kept this long for diagnosis, then pruned. */
export const CLOUD_OUTBOX_SENT_RETENTION_DAYS = 30;

/**
 * Delete delivered outbox rows older than the retention window. Without this
 * the table grows one row per projection change forever.
 *
 * Three rules, all in the one statement:
 *   - an UNSENT row is never touched — it is the retry queue;
 *   - the NEWEST row of each kind always survives, however old:
 *     `readArmedGeneration` takes MAX(generation) from it (deleting it would
 *     restart the counter below what the Worker holds) and
 *     `readPreviousArmedEntries` reads its payload for the tombstone
 *     carry-forward (deleting it would re-publish every tombstone);
 *   - `sent_at` is compared through `datetime()` on BOTH sides, so a
 *     T-separated stamp ages exactly like a space-separated one.
 *
 * Idempotent, and transactional (a savepoint when the caller is already inside
 * a transaction). Returns the number of rows deleted. `now` is a test seam.
 */
export function pruneSentCloudOutbox(db: Database.Database, opts: { now?: string } = {}): number {
  const now = opts.now ?? new Date().toISOString();
  const prune = db.transaction(
    (): number =>
      db
        .prepare(
          `DELETE FROM cloud_outbox
            WHERE sent_at IS NOT NULL
              AND datetime(sent_at) < datetime(?, '-${CLOUD_OUTBOX_SENT_RETENTION_DAYS} days')
              AND generation < (SELECT MAX(newest.generation) FROM cloud_outbox newest
                                 WHERE newest.kind = cloud_outbox.kind)`,
        )
        .run(now).changes,
  );
  return prune();
}

/** [C-8] One drain at a time per process: overlapping callers (a sweep tick and
 *  a route's post-commit attempt) chain onto the running drain instead of
 *  racing generations onto the wire. */
let drainChain: Promise<unknown> = Promise.resolve();

export interface OutboxSenderDeps {
  fetchFn?: typeof fetch;
  workerUrl?: string | null;
  secret?: string | null;
  timeoutMs?: number;
}

export interface OutboxDrainResult {
  sent: number;
  failed: number;
  skipped: "no-worker-config" | null;
}

/**
 * The Worker's reply to POST /internal/armed-events. `applied:false` means the
 * Worker kept what it already had — ordinary for a replayed generation, and the
 * ONE symptom of the restored-DB wedge when the generation it names is higher
 * than anything this Mac has ever minted.
 */
interface ArmedEventsAck {
  applied?: unknown;
  generation?: unknown;
}

/** Host (with port) of the Worker URL — never its credentials, never the secret.
 *  A `send_error` that doesn't name its target is unusable in a diagnosis. */
function targetHost(workerUrl: string): string {
  try {
    return new URL(workerUrl).host;
  } catch {
    return workerUrl.replace(/^[a-z]+:\/\//i, "").split("/")[0];
  }
}

/**
 * Drains unsent rows in generation order via POST /internal/armed-events and
 * marks `sent_at` on 2xx.
 *
 * THE OUTPUT THIS PROTECTS: once the network is up the Worker ends up holding
 * the Mac's NEWEST generation, whichever older generations failed and however.
 * Every payload is the FULL list, so an older generation carries nothing the
 * newest does not. Four rules follow from that:
 *
 *   - an unsent row below the highest generation already delivered is obsolete:
 *     it is never posted, it is CLOSED (`sent_at` set, `send_error` =
 *     "superseded by generation N");
 *   - a row the Worker rejects (HTTP 400) does not stop the drain. It is closed
 *     the same way as soon as a later generation is delivered; while it is the
 *     newest it stays unsent and is retried once per drain (the rejection may
 *     be a transient Worker fault);
 *   - a 5xx, a network error or a timeout stops the drain: retry later, in
 *     order;
 *   - the restored-database refusal fires only when the Worker holds a
 *     generation above this Mac's own MAX(generation). A lower-or-equal answer
 *     to an old row is an ordinary replay.
 */
export function drainCloudOutbox(
  db: Database.Database,
  deps: OutboxSenderDeps = {},
): Promise<OutboxDrainResult> {
  const next = drainChain.catch(() => {}).then(() => drainCloudOutboxUnlocked(db, deps));
  drainChain = next;
  return next;
}

/** Highest generation the Worker is known to hold from this Mac: a row is
 *  stamped `sent_at` only when it was delivered, or when a HIGHER generation
 *  was (a closed row), so the maximum is always a delivered one. */
function readHighestDeliveredGeneration(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(generation), 0) AS g FROM cloud_outbox
        WHERE kind = ? AND sent_at IS NOT NULL`,
    )
    .get(ARMED_EVENTS_KIND) as { g: number };
  return row.g;
}

/**
 * Close every unsent row below `delivered`: the Worker already holds a newer
 * full list, so posting these could change nothing. The note keeps the last
 * real error (if any) so the row still says why it never went out itself.
 * Returns the number of rows closed.
 */
function closeSupersededOutboxRows(db: Database.Database, delivered: number): number {
  if (delivered <= 0) return 0;
  return db
    .prepare(
      `UPDATE cloud_outbox
          SET sent_at = datetime('now'),
              send_error = substr(
                'superseded by generation ' || CAST(? AS INTEGER) ||
                CASE WHEN send_error IS NULL OR send_error LIKE 'superseded by generation %' THEN ''
                     ELSE ' (never delivered; last error: ' || send_error || ')' END,
                1, 200)
        WHERE kind = ? AND sent_at IS NULL AND generation < ?`,
    )
    .run(delivered, ARMED_EVENTS_KIND, delivered).changes;
}

async function drainCloudOutboxUnlocked(
  db: Database.Database,
  deps: OutboxSenderDeps,
): Promise<OutboxDrainResult> {
  const workerUrl =
    deps.workerUrl === undefined ? (process.env.WORKER_MARKER_URL ?? null) : deps.workerUrl;
  const secret = deps.secret === undefined ? (process.env.CRON_SHARED_SECRET ?? null) : deps.secret;
  if (!workerUrl || !secret) return { sent: 0, failed: 0, skipped: "no-worker-config" };
  const fetchFn = deps.fetchFn ?? fetch;
  const host = targetHost(workerUrl);
  // Housekeeping rides on the drain (every sweep tick and every post-commit
  // push) instead of a timer of its own. Best-effort: a prune that fails must
  // never cost a delivery, and the next drain simply tries again.
  try {
    pruneSentCloudOutbox(db);
  } catch (err) {
    console.warn("[cloud-outbox] prune of sent rows failed:", err);
  }
  // Obsolete rows first: anything unsent below a generation the Worker already
  // took is never posted (this is also what clears a queue head left behind by
  // an earlier rejected generation).
  closeSupersededOutboxRows(db, readHighestDeliveredGeneration(db));
  const rows = db
    .prepare(
      `SELECT id, generation, payload_json FROM cloud_outbox
        WHERE kind = ? AND sent_at IS NULL ORDER BY generation ASC`,
    )
    .all(ARMED_EVENTS_KIND) as Array<{ id: number; generation: number; payload_json: string }>;
  let sent = 0;
  let failed = 0;
  // Highest generation delivered by THIS drain; rows it rejected below that
  // are closed on the way out, whichever way the drain ends.
  let deliveredNow = 0;
  const finish = (result: OutboxDrainResult): OutboxDrainResult => {
    closeSupersededOutboxRows(db, deliveredNow);
    return result;
  };
  const markDelivered = (row: { id: number; generation: number }) => {
    db.prepare(
      `UPDATE cloud_outbox SET sent_at = datetime('now'), send_error = NULL WHERE id = ?`,
    ).run(row.id);
    deliveredNow = Math.max(deliveredNow, row.generation);
    sent += 1;
  };
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
      if (res.status === 400) {
        // The Worker refused THIS payload. Record it and move on: a later
        // generation is a complete list of its own and must still go out. The
        // row stays unsent (it is retried next drain while it is the newest)
        // and is closed by `finish` once anything newer lands.
        db.prepare(`UPDATE cloud_outbox SET send_error = ? WHERE id = ?`).run(
          `${host}: HTTP 400`.slice(0, 200),
          row.id,
        );
        failed += 1;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      // [F2] The restored-DB wedge. A Mac whose DB came back from a backup
      // restarts its generation counter below the one KV holds, so every POST
      // is refused as a stale replay and the cloud silently stops hearing about
      // arms. `applied:false` alone is NOT that — it is also the correct reply
      // to a legitimate re-send, and to an OLD row replayed after a newer one
      // landed — so only a generation STRICTLY GREATER than this Mac's own
      // MAX(generation) proves the Worker holds state this Mac never produced.
      // Anything else (a generation this Mac did mint, a body that isn't JSON,
      // a 2xx with no body) stays an ordinary success: the status is the
      // contract, this parse is a diagnostic on top of it.
      let ack: ArmedEventsAck | null = null;
      try {
        ack = (await res.json()) as ArmedEventsAck;
      } catch {
        ack = null;
      }
      if (
        ack != null &&
        ack.applied === false &&
        typeof ack.generation === "number" &&
        ack.generation > readArmedGeneration(db)
      ) {
        db.prepare(`UPDATE cloud_outbox SET send_error = ? WHERE id = ?`).run(
          `${host}: worker holds generation ${ack.generation} > local ${row.generation} — KV key armed-events needs a reset`.slice(
            0,
            200,
          ),
          row.id,
        );
        console.warn(
          `[cloud-outbox] ${host} holds generation ${ack.generation} > local ${row.generation} — the KV key needs a reset (see docs/reference/cron-and-workers.md §15)`,
        );
        // Same in-order rule as a transport failure: nothing later goes out
        // while the Worker is refusing this one.
        failed += 1;
        return finish({ sent, failed, skipped: null });
      }
      if (
        ack != null &&
        ack.applied === false &&
        typeof ack.generation === "number" &&
        ack.generation > row.generation
      ) {
        // An old row replayed after the Worker took something newer that this
        // Mac did mint. Not a failure and not a delivery of THIS row: leave it
        // for `finish` to close once the newer generation is confirmed, and
        // keep going so that newer generation is posted now.
        continue;
      }
      markDelivered(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Name the target: an unadorned "fetch failed" says nothing about WHICH
      // Worker was unreachable. The host only — never the URL's credentials.
      db.prepare(`UPDATE cloud_outbox SET send_error = ? WHERE id = ?`).run(
        `${host}: ${message}`.slice(0, 200),
        row.id,
      );
      // In-order delivery: never send N+1 before N landed.
      failed += 1;
      return finish({ sent, failed, skipped: null });
    } finally {
      clearTimeout(timer);
    }
  }
  return finish({ sent, failed, skipped: null });
}
