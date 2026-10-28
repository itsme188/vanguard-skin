/**
 * The arm route starts the late-arm preview kick (2026-10-28) AFTER the
 * prepare pass, so the preview is written with the deep read and rescanned
 * bogeys in it. The kick itself (which events qualify) is pinned in
 * tests/calendar/late-arm-preview.test.ts; here only the wiring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database, order: [] as string[] }));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/earnings/cloud-outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/earnings/cloud-outbox")>();
  return { ...actual, attemptPostCommitDrain: async () => ({ timedOut: false, result: null }) };
});

const kick = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => {
    hoisted.order.push("kick");
    return null;
  }),
);
vi.mock("@/lib/calendar/email-sweep", () => ({
  runLateArmPreviewKick: (...a: unknown[]) => kick(...a),
}));

import { POST } from "@/app/api/earnings/worksheet/route";
import { registerPrepareStep, __resetPrepareStepsForTests } from "@/lib/earnings/prepare-armed-event";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  hoisted.order = [];
  kick.mockClear();
  __resetPrepareStepsForTests();
});

afterEach(() => {
  __resetPrepareStepsForTests();
  hoisted.db.close();
});

function seedEvent(): number {
  return Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings','2026-09-05','ACME earnings','ACME','manual:ACME:2026-09-05')`,
      )
      .run().lastInsertRowid,
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

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("POST /api/earnings/worksheet arm — late-arm preview kick", () => {
  it("kicks the preview for the armed event after the prepare pass finishes", async () => {
    registerPrepareStep("route_step", {
      fingerprint: () => "fp",
      run: async () => {
        hoisted.order.push("prepare");
        return { status: "done" };
      },
    });
    const eventId = seedEvent();

    const res = await post({ eventId, action: "arm" });
    expect(res.status).toBe(200);
    await settle();

    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith(hoisted.db, eventId);
    expect(hoisted.order).toEqual(["prepare", "kick"]);
  });

  it("a failing prepare step still lets the kick run", async () => {
    registerPrepareStep("route_step", {
      fingerprint: () => "fp",
      run: async () => {
        throw new Error("step blew up");
      },
    });
    const eventId = seedEvent();
    await post({ eventId, action: "arm" });
    await settle();
    expect(kick).toHaveBeenCalledWith(hoisted.db, eventId);
  });

  it("disarm does not kick", async () => {
    const eventId = seedEvent();
    await post({ eventId, action: "arm" });
    await settle();
    kick.mockClear();
    await post({ eventId, action: "disarm" });
    await settle();
    expect(kick).not.toHaveBeenCalled();
  });
});
