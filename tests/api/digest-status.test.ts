/**
 * GET /api/digest/status — cloud-aware status (2026-07-15).
 *
 * The status route is DigestCatchup's data source. Pre-fix it only read the
 * Mac-local last_digest_sent_at, so on every cloud-sent day the banner nagged
 * "Today's digest wasn't sent at 8:45 AM" even though the reader had the
 * email. The route now (1) runs the on-wake reconcile and (2) reports today's
 * cloud marker for honest display.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { testDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`
  );
  return { testDb: db };
});

vi.mock("@/lib/db", () => ({ db: testDb }));

vi.mock("@/lib/cron/marker-check", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/cron/marker-check")>();
  return {
    ...mod,
    checkCloudMarker: vi.fn(),
    reconcileRecentCloudSends: vi.fn(async () => ({
      advanced: false,
      confirmedCloudSends: 0,
    })),
  };
});

import {
  checkCloudMarker,
  reconcileRecentCloudSends,
} from "@/lib/cron/marker-check";
import { setLastDigestSentAt } from "@/lib/digest/daily-digest";
import { recordDigestSkip } from "@/lib/digest/digest-skip";
import { GET, POST } from "@/app/api/digest/status/route";

describe("GET /api/digest/status", () => {
  beforeEach(() => {
    testDb.prepare(`DELETE FROM settings`).run();
    vi.mocked(checkCloudMarker).mockReset();
    vi.mocked(reconcileRecentCloudSends).mockClear();
    vi.mocked(checkCloudMarker).mockResolvedValue(null);
  });

  it("GET is side-effect-free — it does NOT run the on-wake reconcile (write moved to POST, #35)", async () => {
    await GET();
    expect(reconcileRecentCloudSends).not.toHaveBeenCalled();
  });

  it("POST runs the on-wake reconcile so the pointer heals while the dashboard is open", async () => {
    const res = await POST();
    expect(reconcileRecentCloudSends).toHaveBeenCalledTimes(1);
    expect(reconcileRecentCloudSends).toHaveBeenCalledWith(testDb);
    // POST returns the same status payload shape as GET.
    const body = await res.json();
    expect(body).toHaveProperty("lastDigestSentAt");
    expect(body).toHaveProperty("cloudDigestToday");
  });

  it("reports today's cloud digest marker as cloudDigestToday", async () => {
    setLastDigestSentAt(testDb, "2026-07-15T14:42:20.000Z");
    vi.mocked(checkCloudMarker).mockResolvedValue({
      sentBy: "cloud",
      date: "2026-07-15",
      sentAt: "2026-07-15T14:47:20.000Z",
      via: "sent",
    });

    const res = await GET();
    const body = await res.json();

    expect(body.lastDigestSentAt).toBe("2026-07-15T14:42:20.000Z");
    expect(body.cloudDigestToday).toEqual({
      sentBy: "cloud",
      date: "2026-07-15",
      sentAt: "2026-07-15T14:47:20.000Z",
      via: "sent",
    });
  });

  it("returns cloudDigestToday null when the Mac sent (or nothing sent)", async () => {
    vi.mocked(checkCloudMarker).mockResolvedValue({
      sentBy: "mac",
      date: "2026-07-15",
      sentAt: "2026-07-15T12:50:00.000Z",
      via: "sent",
    });

    const res = await GET();
    const body = await res.json();

    expect(body.cloudDigestToday).toBeNull();
  });

  it("surfaces an in-flight cloud attempt so the UI can say 'sending now'", async () => {
    vi.mocked(checkCloudMarker).mockResolvedValue({
      sentBy: "cloud",
      date: "2026-07-15",
      sentAt: "2026-07-15T13:00:05.000Z",
      via: "attempting",
    });

    const res = await GET();
    const body = await res.json();

    expect(body.cloudDigestToday?.via).toBe("attempting");
  });

  it("degrades gracefully when the Worker is unreachable", async () => {
    setLastDigestSentAt(testDb, "2026-07-13T12:47:00.000Z");
    vi.mocked(checkCloudMarker).mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(body.lastDigestSentAt).toBe("2026-07-13T12:47:00.000Z");
    expect(body.cloudDigestToday).toBeNull();
  });

  it("reports the recorded empty-window skip so the banner can explain it", async () => {
    recordDigestSkip(testDb, "No processed articles in the selected range", new Date("2026-07-15T12:47:00.000Z"));

    const body = await (await GET()).json();

    expect(body.lastDigestSkip).toEqual({
      reason: "No processed articles in the selected range",
      date: "2026-07-15",
      at: "2026-07-15T12:47:00.000Z",
    });
  });

  it("reports lastDigestSkip null when no skip was recorded or the row is unreadable", async () => {
    expect((await (await GET()).json()).lastDigestSkip).toBeNull();

    testDb
      .prepare(`INSERT INTO settings (key, value) VALUES ('last_digest_skip', 'not json')`)
      .run();
    expect((await (await GET()).json()).lastDigestSkip).toBeNull();
  });

  it("GET writes nothing: the settings table is identical before and after", async () => {
    recordDigestSkip(testDb, "No processed articles in the selected range", new Date("2026-07-15T12:47:00.000Z"));
    setLastDigestSentAt(testDb, "2026-07-14T12:47:00.000Z");
    const dump = () =>
      JSON.stringify(testDb.prepare(`SELECT key, value, updated_at FROM settings ORDER BY key`).all());
    const before = dump();
    const changesBefore = testDb.prepare(`SELECT total_changes() AS n`).get().n;

    await GET();

    expect(dump()).toBe(before);
    expect(testDb.prepare(`SELECT total_changes() AS n`).get().n).toBe(changesBefore);
  });
});
