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
import { GET } from "@/app/api/digest/status/route";

describe("GET /api/digest/status", () => {
  beforeEach(() => {
    testDb.prepare(`DELETE FROM settings`).run();
    vi.mocked(checkCloudMarker).mockReset();
    vi.mocked(reconcileRecentCloudSends).mockClear();
    vi.mocked(checkCloudMarker).mockResolvedValue(null);
  });

  it("runs the on-wake reconcile so the pointer heals while the dashboard is open", async () => {
    await GET();
    expect(reconcileRecentCloudSends).toHaveBeenCalledTimes(1);
    expect(reconcileRecentCloudSends).toHaveBeenCalledWith(testDb);
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
});
