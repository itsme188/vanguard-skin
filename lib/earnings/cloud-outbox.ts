/**
 * Cloud outbox writer + sender (live print v2, slice A §4.1).
 *
 * Writer: every mutation that changes the armed projection appends one
 * `cloud_outbox` row INSIDE its own transaction, so the row and the state it
 * describes commit together — a crash can never leave the Worker holding a
 * generation the Mac does not.
 *
 * Sender: a drain posts unsent rows to the Worker in generation order and
 * stops at the first failure, so the Worker never sees N+1 before N. The
 * Worker ignores a generation <= the one it holds (Task 8), which makes a
 * retry of an already-applied row harmless.
 */
import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import {
  ARMED_EVENTS_KIND,
  buildArmedEventsEntries,
  readArmedGeneration,
  readPreviousArmedEntries,
  sameProjection,
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
  opts: { today?: string; nowMs?: number } = {},
): { generation: number; written: boolean } {
  if (!db.inTransaction) {
    throw new Error("writeArmedEventsOutboxRow must run inside a transaction");
  }
  const current = readArmedGeneration(db);
  const entries = buildArmedEventsEntries(db, {
    today: opts.today ?? todayET(),
    nowMs: opts.nowMs,
  });
  // Read the previous entries through the projection's GUARDED reader: a
  // truncated payload must be treated as "no previous entries", never thrown
  // from inside armWorksheet's transaction, or one corrupt row would wedge
  // every future arm/disarm/edit.
  if (sameProjection(readPreviousArmedEntries(db), entries)) {
    return { generation: current, written: false };
  }
  const generation = current + 1;
  const payload: ArmedEventsPayload = { generation, entries };
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
  const drain: Promise<PostCommitDrainResult> = drainCloudOutbox(db, {
    timeoutMs: capMs,
    ...opts.deps,
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

/** Drains unsent rows in generation order via POST /internal/armed-events;
 *  marks sent_at on 2xx; stops at the first failure. */
export function drainCloudOutbox(
  db: Database.Database,
  deps: OutboxSenderDeps = {},
): Promise<OutboxDrainResult> {
  const next = drainChain.catch(() => {}).then(() => drainCloudOutboxUnlocked(db, deps));
  drainChain = next;
  return next;
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
  const rows = db
    .prepare(
      `SELECT id, generation, payload_json FROM cloud_outbox
        WHERE kind = ? AND sent_at IS NULL ORDER BY generation ASC`,
    )
    .all(ARMED_EVENTS_KIND) as Array<{ id: number; generation: number; payload_json: string }>;
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
      db.prepare(
        `UPDATE cloud_outbox SET sent_at = datetime('now'), send_error = NULL WHERE id = ?`,
      ).run(row.id);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE cloud_outbox SET send_error = ? WHERE id = ?`).run(
        message.slice(0, 200),
        row.id,
      );
      // In-order delivery: never send N+1 before N landed.
      return { sent, failed: 1, skipped: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return { sent, failed: 0, skipped: null };
}
