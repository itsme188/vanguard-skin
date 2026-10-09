/**
 * GET /api/earnings/email-content supplies `actualsChangedAt` (U20).
 *
 * The viewer rebuilds the scoreboard from the current event row. The only stamp
 * that moves when an actual changes after a send is `manual_actuals_at`
 * (hand-entered or promoted actuals). `enriched_at` is a first-completion stamp
 * and is deliberately not evidence of a later change. Synthetic data only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;
let seq = 0;

function seed(opts: {
  phase?: "preview" | "recap";
  sentAt: string;
  manualActualsAt?: string | null;
  enrichedAt?: string | null;
}): number {
  seq += 1;
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source, source_key, manual_actuals_at, enriched_at)
     VALUES ('2026-09-10', 'earnings', 'XMPL2 Q3', 'XMPL2', 'manual', ?, ?, ?)`,
  ).run(`manual:XMPL2:earnings:2026-09-10:${seq}`, opts.manualActualsAt ?? null, opts.enrichedAt ?? null);
  const eventId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md)
     VALUES (?, ?, 'desk@example.com', ?, 'The print in prose.')`,
  ).run(eventId, opts.phase ?? "recap", opts.sentAt);
  return eventId;
}

async function get(eventId: number, phase: "preview" | "recap" = "recap") {
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

describe("GET /api/earnings/email-content — actualsChangedAt", () => {
  it("is the stamp when manual actuals were entered after the send (same format)", async () => {
    const id = seed({ sentAt: "2026-09-10 20:27:00", manualActualsAt: "2026-09-10 21:05:00" });
    expect((await get(id)).body.actualsChangedAt).toBe("2026-09-10 21:05:00");
  });

  it("is null when the stamp is earlier than the send", async () => {
    const id = seed({ sentAt: "2026-09-10 20:27:00", manualActualsAt: "2026-09-10 20:10:00" });
    expect((await get(id)).body.actualsChangedAt).toBeNull();
  });

  it("is null when the stamp equals the send", async () => {
    const id = seed({ sentAt: "2026-09-10 20:27:00", manualActualsAt: "2026-09-10 20:27:00" });
    expect((await get(id)).body.actualsChangedAt).toBeNull();
  });

  it("is null when there is no stamp, even if enrichment ran later", async () => {
    const id = seed({ sentAt: "2026-09-10 20:27:00", enrichedAt: "2026-09-11 08:00:00" });
    expect((await get(id)).body.actualsChangedAt).toBeNull();
  });

  it("compares mixed formats by instant: ISO-with-T stamp vs space-separated send", async () => {
    // Later by one minute only when both are read as UTC; a string compare of
    // 'T' vs ' ' would call the earlier ISO value later.
    const later = seed({ sentAt: "2026-09-10 20:27:00", manualActualsAt: "2026-09-10T20:28:00.000Z" });
    expect((await get(later)).body.actualsChangedAt).toBe("2026-09-10T20:28:00.000Z");
    const earlier = seed({ sentAt: "2026-09-10 20:27:00", manualActualsAt: "2026-09-10T20:26:00.000Z" });
    expect((await get(earlier)).body.actualsChangedAt).toBeNull();
  });

  it("is null for an unreadable stamp", async () => {
    const id = seed({ sentAt: "2026-09-10 20:27:00", manualActualsAt: "yesterday" });
    expect((await get(id)).body.actualsChangedAt).toBeNull();
  });

  it("is null for a preview", async () => {
    const id = seed({ phase: "preview", sentAt: "2026-09-10 12:00:00", manualActualsAt: "2026-09-10 21:05:00" });
    expect((await get(id, "preview")).body.actualsChangedAt).toBeNull();
  });
});
