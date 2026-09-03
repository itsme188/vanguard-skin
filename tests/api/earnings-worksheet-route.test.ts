/**
 * HTTP-boundary tests for /api/earnings/worksheet — live print v2 slice A.
 *
 * Arming an event now also enqueues its prepare steps and kicks the pass
 * (D6: never awaited — a step can take tens of seconds; the 15-minute sweep
 * tick is the durable retry). D11: the top-level `armed` / `disarmed` fields
 * the Today client already reads stay exactly where they were; the new
 * payload rides under `data`. GET echoes the rows and stays read-only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// The outbox WRITER stays real (armWorksheet writes the projection row in its
// own transaction); only the sender is stubbed so this file can never talk to
// the Worker, even with WORKER_MARKER_URL exported in the shell.
const attemptPostCommitDrain = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ timedOut: false, result: null })),
);
vi.mock("@/lib/earnings/cloud-outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/earnings/cloud-outbox")>();
  return {
    ...actual,
    attemptPostCommitDrain: (...a: unknown[]) => attemptPostCommitDrain(...a),
  };
});

import { GET, POST } from "@/app/api/earnings/worksheet/route";
import {
  registerPrepareStep,
  __resetPrepareStepsForTests,
} from "@/lib/earnings/prepare-armed-event";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  attemptPostCommitDrain.mockClear();
  __resetPrepareStepsForTests();
});

afterEach(() => {
  __resetPrepareStepsForTests();
  hoisted.db.close();
});

function seedEarningsEvent(symbol = "ACME", eventDate = "2026-09-05"): number {
  return Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,?,?,?)`,
      )
      .run(eventDate, `${symbol} earnings`, symbol, `manual:${symbol}:${eventDate}`)
      .lastInsertRowid,
  );
}

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/earnings/worksheet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const stepRowCount = () =>
  (
    hoisted.db.prepare(`SELECT COUNT(*) AS n FROM earnings_prepare_steps`).get() as {
      n: number;
    }
  ).n;

/** Let the fire-and-forget prepare pass settle before the DB is closed. */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("POST /api/earnings/worksheet arm — prepare enqueue + kick (v2 slice A)", () => {
  it("arm enqueues one row per registered step and returns them under data, keeping top-level armed (D11)", async () => {
    const ran: number[] = [];
    registerPrepareStep("route_step", {
      fingerprint: () => "fp",
      run: async (_db, eventId) => {
        ran.push(eventId);
        return { status: "done" };
      },
    });
    const eventId = seedEarningsEvent();

    const res = await post({ eventId, action: "arm" });
    const json = (await res.json()) as {
      success: boolean;
      armed: boolean;
      data: { enqueued: number; prepare: Array<{ step: string; event_id: number }> };
    };

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.armed).toBe(true); // D11: unchanged top-level field
    expect(json.data.enqueued).toBe(1);
    expect(json.data.prepare.map((r) => r.step)).toEqual(["route_step"]);
    expect(json.data.prepare[0].event_id).toBe(eventId);

    // D6: the pass is kicked, not awaited — it lands on the next microtask turn.
    await flush();
    expect(ran).toEqual([eventId]);
    expect(
      hoisted.db
        .prepare(`SELECT status FROM earnings_prepare_steps WHERE event_id = ?`)
        .get(eventId),
    ).toMatchObject({ status: "done" });
  });

  it("re-arming an already-armed event enqueues nothing new and still reports the rows", async () => {
    registerPrepareStep("route_step", {
      fingerprint: () => "fp",
      run: async () => ({ status: "pending", reason: "waiting" }),
    });
    const eventId = seedEarningsEvent();
    await post({ eventId, action: "arm" });
    await flush();

    const res = await post({ eventId, action: "arm" });
    const json = (await res.json()) as {
      armed: boolean;
      data: { enqueued: number; prepare: Array<{ step: string }> };
    };
    await flush();

    expect(json.armed).toBe(false); // already armed
    expect(json.data.enqueued).toBe(0);
    expect(json.data.prepare.map((r) => r.step)).toEqual(["route_step"]);
    expect(stepRowCount()).toBe(1);
  });

  it("disarm keeps its top-level `disarmed` field", async () => {
    const eventId = seedEarningsEvent();
    await post({ eventId, action: "arm" });
    await flush();
    const res = await post({ eventId, action: "disarm" });
    expect(await res.json()).toMatchObject({ success: true, disarmed: true });
  });
});

describe("GET /api/earnings/worksheet — prepare rows are echoed, never created", () => {
  it("echoes the step rows keyed by event id", async () => {
    registerPrepareStep("route_step", {
      fingerprint: () => "fp",
      run: async () => ({ status: "pending", reason: "waiting" }),
    });
    const eventId = seedEarningsEvent();
    await post({ eventId, action: "arm" });
    await flush();

    const res = await GET(
      new Request(`http://localhost/api/earnings/worksheet?eventIds=${eventId}`),
    );
    const json = (await res.json()) as {
      success: boolean;
      flags: Record<string, { armed: boolean }>;
      data: { prepare: Record<string, Array<{ step: string; status: string }>> };
    };

    expect(json.success).toBe(true);
    expect(json.flags[String(eventId)].armed).toBe(true);
    expect(json.data.prepare[String(eventId)].map((r) => r.step)).toEqual(["route_step"]);
  });

  it("is read-only: a GET for an armed event with no rows creates none", async () => {
    registerPrepareStep("route_step", {
      fingerprint: () => "fp",
      run: async () => ({ status: "done" }),
    });
    const eventId = seedEarningsEvent();
    // Arm directly (bypassing the route) so no enqueue has happened yet.
    hoisted.db
      .prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`)
      .run(eventId);
    expect(stepRowCount()).toBe(0);

    const res = await GET(
      new Request(`http://localhost/api/earnings/worksheet?eventIds=${eventId}`),
    );
    const json = (await res.json()) as {
      data: { prepare: Record<string, unknown[]> };
    };

    expect(json.data.prepare[String(eventId)]).toEqual([]);
    expect(stepRowCount()).toBe(0);
  });
});
