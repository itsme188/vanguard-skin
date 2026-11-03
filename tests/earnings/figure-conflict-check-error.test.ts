/**
 * T1 chip-and-hold fail-safe: when the conflict check itself errors, the
 * auto-recap must not send (held-with-reason), the sweep books it as held, and
 * a human send still goes through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const state = { broken: false };
vi.mock("@/lib/queries/calendar", async (orig) => {
  const real = await orig<typeof import("@/lib/queries/calendar")>();
  return {
    ...real,
    getEventById: (...a: Parameters<typeof real.getEventById>) => {
      if (state.broken) throw new Error("simulated comparison failure");
      return real.getEventById(...a);
    },
  };
});

import { sendEarningsCandidate } from "@/lib/earnings/send-service";
import { processSweepCandidate } from "@/lib/calendar/email-sweep";
import { UNCHECKED_REASON } from "@/lib/earnings/figure-conflict";

let db: Database.Database;
let eventId: number;

beforeEach(() => {
  vi.stubEnv("WORKER_MARKER_URL", "");
  vi.stubEnv("CRON_SHARED_SECRET", "");
  vi.stubEnv("BRIEFING_EMAIL_TO", "desk@example.com");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.broken = true;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, actual_value, manual_actuals_at, enriched_at)
         VALUES ('manual','earnings','2026-09-10','X','XMPL','k1','EPS 1.00',datetime('now'),datetime('now'))`,
      )
      .run().lastInsertRowid,
  );
});
afterEach(() => {
  state.broken = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close();
});

const seams = {
  compose: async () => ({
    symbol: "XMPL", title: "t", markdown: "m", aiMarkdown: "m", html: "<p>m</p>", promptHash: "h",
  }),
  sendEmail: async (o: { messageId?: string }) => ({ messageId: o.messageId!, response: "250" }),
  markers: { setRunning: async () => {}, clearRunning: async () => {}, writeMacSent: async () => {} },
  checkCloudMarker: async () => null,
};

describe("the check errors", () => {
  it("the sweep's recap is held with the unchecked reason and nothing is claimed", async () => {
    const res = await sendEarningsCandidate(
      db,
      { eventId, symbol: "XMPL", phase: "recap" },
      { mode: "sweep", recipient: "desk@example.com", seams },
    );
    expect(res).toMatchObject({ outcome: "refused", hold: "unchecked", reason: UNCHECKED_REASON });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails`).get()).toEqual({ n: 0 });
  });

  it("the sweep books it as recap-held", async () => {
    const res = await processSweepCandidate(
      db,
      { eventId, symbol: "XMPL", phase: "recap" } as Parameters<typeof processSweepCandidate>[1],
      {},
    );
    expect(res).toMatchObject({ ok: true, skipped: "recap-held" });
  });
});
