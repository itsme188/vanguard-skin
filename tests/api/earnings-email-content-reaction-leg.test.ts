/**
 * GET /api/earnings/email-content supplies `reactionLegAt` (TODO f14).
 *
 * The archive viewer rebuilds the scoreboard from the CURRENT event row, so a
 * recap sent before the reaction was measured shows reaction figures the sent
 * email never had. The viewer's "Scoreboard refreshed after send" line was
 * ready but the route sent no time. The time is read from what the stored
 * `reaction_snapshot` already carries (release instant + window); nothing new
 * is stored. Symbols and prices are synthetic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { scoreboardRefreshedAfterSend } from "@/app/dashboard/components/EarningsEmailViewer";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;
let seq = 0;

const LEG = { t_pre: 100, t_post: 104, delta_pct: 4 };
const DEAD_LEG = { t_pre: 0, t_post: 0, delta_pct: 0 };

function seed(opts: {
  phase: "preview" | "recap";
  sentAt: string;
  snapshot: unknown;
}): number {
  seq += 1;
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source, source_key, reaction_snapshot)
     VALUES ('2026-09-10', 'earnings', 'XMPL1 Q3', 'XMPL1', 'manual', ?, ?)`,
  ).run(
    `manual:XMPL1:earnings:2026-09-10:${seq}`,
    opts.snapshot == null
      ? null
      : typeof opts.snapshot === "string"
        ? opts.snapshot
        : JSON.stringify(opts.snapshot),
  );
  const eventId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md)
     VALUES (?, ?, 'desk@example.com', ?, 'The print in prose.')`,
  ).run(eventId, opts.phase, opts.sentAt);
  return eventId;
}

async function get(eventId: number, phase: "preview" | "recap") {
  const { GET } = await import("@/app/api/earnings/email-content/route");
  const res = await GET(
    new Request(`http://localhost/api/earnings/email-content?eventId=${eventId}&phase=${phase}`),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  vi.resetModules();
});

describe("GET /api/earnings/email-content — reactionLegAt", () => {
  it("is the release instant plus the snapshot's window, for a recap with a usable leg", async () => {
    // Release 20:15 UTC, window 120 minutes: legs measured at 22:15 UTC.
    const eventId = seed({
      phase: "recap",
      sentAt: "2026-09-10 20:27:00",
      snapshot: { t0_utc: "2026-09-10T20:15:00.000Z", window_min: 120, source: "tws", symbol: { ...LEG, symbol: "XMPL1" } },
    });
    const { status, body } = await get(eventId, "recap");
    expect(status).toBe(200);
    expect(body.reactionLegAt).toBe("2026-09-10T22:15:00.000Z");
    // The viewer's own rule turns that into the banner: sent before the leg.
    expect(scoreboardRefreshedAfterSend(body.sentAt, body.reactionLegAt)?.toISOString()).toBe(
      "2026-09-10T22:15:00.000Z",
    );
  });

  it("a recap sent after the leg was measured gets the time but no banner", async () => {
    const eventId = seed({
      phase: "recap",
      sentAt: "2026-09-10 22:40:00",
      snapshot: { t0_utc: "2026-09-10T20:15:00.000Z", window_min: 120, source: "tws", spy: LEG },
    });
    const { body } = await get(eventId, "recap");
    expect(body.reactionLegAt).toBe("2026-09-10T22:15:00.000Z");
    expect(scoreboardRefreshedAfterSend(body.sentAt, body.reactionLegAt)).toBeNull();
  });

  it("falls back to the 120-minute window when an older snapshot omits it", async () => {
    const eventId = seed({
      phase: "recap",
      sentAt: "2026-09-10 20:27:00",
      snapshot: { t0_utc: "2026-09-10T20:15:00.000Z", source: "yahoo", qqq: LEG },
    });
    expect((await get(eventId, "recap")).body.reactionLegAt).toBe("2026-09-10T22:15:00.000Z");
  });

  it("is null when the scoreboard shows no usable reaction leg", async () => {
    // A dead 0/0 leg renders as a dash on the scoreboard; a leg the scoreboard
    // does not show (tlt, sector) is no reason to stamp it either.
    const dead = seed({
      phase: "recap",
      sentAt: "2026-09-10 20:27:00",
      snapshot: { t0_utc: "2026-09-10T20:15:00.000Z", window_min: 120, source: "tws", spy: DEAD_LEG, tlt: LEG },
    });
    expect((await get(dead, "recap")).body.reactionLegAt).toBeNull();
  });

  it("is null with no snapshot, an unreadable one, or an unreadable release instant", async () => {
    const none = seed({ phase: "recap", sentAt: "2026-09-10 20:27:00", snapshot: null });
    expect((await get(none, "recap")).body.reactionLegAt).toBeNull();
    const broken = seed({ phase: "recap", sentAt: "2026-09-10 20:27:00", snapshot: "{not json" });
    expect((await get(broken, "recap")).body.reactionLegAt).toBeNull();
    const noT0 = seed({
      phase: "recap",
      sentAt: "2026-09-10 20:27:00",
      snapshot: { t0_utc: "soon", window_min: 120, source: "tws", spy: LEG },
    });
    expect((await get(noT0, "recap")).body.reactionLegAt).toBeNull();
    const badWindow = seed({
      phase: "recap",
      sentAt: "2026-09-10 20:27:00",
      snapshot: { t0_utc: "2026-09-10T20:15:00.000Z", window_min: "long", source: "tws", spy: LEG },
    });
    expect((await get(badWindow, "recap")).body.reactionLegAt).toBeNull();
  });

  it("is null for a preview — its scoreboard shows no reaction", async () => {
    const eventId = seed({
      phase: "preview",
      sentAt: "2026-09-10 12:00:00",
      snapshot: { t0_utc: "2026-09-10T20:15:00.000Z", window_min: 120, source: "tws", spy: LEG },
    });
    const { status, body } = await get(eventId, "preview");
    expect(status).toBe(200);
    expect(body.reactionLegAt).toBeNull();
  });

  it("leaves the rest of the response as it was", async () => {
    const eventId = seed({
      phase: "recap",
      sentAt: "2026-09-10 20:27:00",
      snapshot: { t0_utc: "2026-09-10T20:15:00.000Z", window_min: 120, source: "tws", spy: LEG },
    });
    const { body } = await get(eventId, "recap");
    expect(body).toMatchObject({
      sentAt: "2026-09-10 20:27:00",
      sentTo: "desk@example.com",
      eventDate: "2026-09-10",
      symbol: "XMPL1",
      phase: "recap",
      sentBy: "local",
      deliveryState: "sent",
    });
    expect(body.fullHtml).toContain("The print in prose.");
  });
});
