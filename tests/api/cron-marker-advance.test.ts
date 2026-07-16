/**
 * Tests for the stale-window fix (2026-06-09):
 * When the Mac's cron routes skip because the cloud Worker already sent,
 * they must advance last_digest_sent_at so the NEXT Mac-won email doesn't
 * re-cover days the cloud already summarised.
 *
 * Covers both /api/cron/digest and /api/cron/evening.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted setup ────────────────────────────────────────────────────
// vi.mock factories are hoisted to the top of the file by Vitest, so any
// variable they close over must also be hoisted.
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

// Use the real advanceDigestMarkerAfterCloudSend but a controllable
// checkCloudMarker so we can inject different sentAt values per test.
vi.mock("@/lib/cron/marker-check", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("@/lib/cron/marker-check")>();
  return {
    ...mod,
    checkCloudMarker: vi.fn(),
    reconcileRecentCloudSends: vi.fn(async () => ({
      advanced: false,
      confirmedCloudSends: 0,
    })),
  };
});

vi.mock("@/lib/cron/running-marker", () => ({
  setRunningMarker: vi.fn(async () => {}),
  clearRunningMarker: vi.fn(async () => {}),
  confirmMacSent: vi.fn(async () => {}),
}));

vi.mock("@/lib/digest/send-digest", () => ({
  sendDigestEmail: vi.fn(),
  DigestSendError: class extends Error {
    status = 500;
  },
}));

vi.mock("@/lib/digest/send-evening", () => ({
  sendEveningEmail: vi.fn(),
  EveningSendError: class extends Error {
    status = 500;
  },
}));

vi.mock("@/lib/calendar/market-holidays", () => ({
  isMarketHoliday: vi.fn(() => false),
  isMarketClosed: vi.fn(() => false),
}));

import {
  checkCloudMarker,
  reconcileRecentCloudSends,
} from "@/lib/cron/marker-check";
import {
  getLastDigestSentAt,
  setLastDigestSentAt,
} from "@/lib/digest/daily-digest";
import { POST as digestPost } from "@/app/api/cron/digest/route";
import { POST as eveningPost } from "@/app/api/cron/evening/route";

const SECRET = "test-secret";
process.env.CRON_SHARED_SECRET = SECRET;

function req() {
  return new Request("http://localhost/api/cron/x", {
    method: "POST",
    headers: {
      "x-cron-secret": SECRET,
      "content-type": "application/json",
    },
    body: "{}",
  });
}

describe.each([
  ["digest", digestPost],
  ["evening", eveningPost],
])(
  "cloud-skip advances last_digest_sent_at (%s)",
  (_name, post) => {
    beforeEach(() => {
      testDb.prepare(`DELETE FROM settings`).run();
      vi.mocked(checkCloudMarker).mockReset();
    });

    it("advances to the cloud sentAt minus the 5-minute overlap buffer", async () => {
      setLastDigestSentAt(testDb, "2026-06-04T12:45:00.000Z");
      vi.mocked(checkCloudMarker).mockResolvedValue({
        sentBy: "cloud",
        date: "2026-06-09",
        sentAt: "2026-06-09T13:01:00.000Z",
      });
      const res = await post(req());
      const body = await res.json();
      expect(body.skipped).toBe(true);
      // sentAt is written AFTER the cloud's Resend delivery; its Gmail fetch ran
      // minutes earlier. The buffer keeps that processing window inside the next
      // Mac email — duplication over drops.
      expect(getLastDigestSentAt(testDb)).toBe("2026-06-09T12:56:00.000Z");
    });

    it("falls back to now−30min when sentAt is missing (legacy marker)", async () => {
      vi.mocked(checkCloudMarker).mockResolvedValue({
        sentBy: "cloud",
        date: "2026-06-09",
        // sentAt intentionally absent — simulates a legacy KV marker
      });
      const before = Date.now();
      await post(req());
      const advanced = Date.parse(getLastDigestSentAt(testDb)!);
      // Should be roughly now−30min (within a generous 2-minute window)
      expect(advanced).toBeGreaterThan(before - 31 * 60 * 1000);
      expect(advanced).toBeLessThan(before - 29 * 60 * 1000 + 5000);
    });

    it("never moves the marker backwards", async () => {
      setLastDigestSentAt(testDb, "2026-06-09T18:00:00.000Z");
      vi.mocked(checkCloudMarker).mockResolvedValue({
        sentBy: "cloud",
        date: "2026-06-09",
        sentAt: "2026-06-09T13:01:00.000Z",
      });
      await post(req());
      // Current marker (18:00) is later than the cloud sentAt (13:01) — must not regress.
      expect(getLastDigestSentAt(testDb)).toBe("2026-06-09T18:00:00.000Z");
    });

    it("skips on an in-flight cloud attempt WITHOUT advancing the pointer", async () => {
      // via=attempting means the fallback may still fail — advancing past its
      // start would drop the articles it never summarized (2026-07-15).
      setLastDigestSentAt(testDb, "2026-06-04T12:45:00.000Z");
      vi.mocked(checkCloudMarker).mockResolvedValue({
        sentBy: "cloud",
        date: "2026-06-09",
        sentAt: "2026-06-09T13:00:05.000Z",
        via: "attempting",
      });
      const res = await post(req());
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(getLastDigestSentAt(testDb)).toBe("2026-06-04T12:45:00.000Z");
    });

    it("runs the on-wake reconcile before the today-marker skip decision", async () => {
      // A Mac awake at send time may have slept through YESTERDAY's cloud
      // sends — the reconcile advances the window pointer before composing.
      vi.mocked(reconcileRecentCloudSends).mockClear();
      vi.mocked(checkCloudMarker).mockResolvedValue({
        sentBy: null,
        date: "2026-06-09",
        sentAt: null,
      });
      await post(req());
      expect(reconcileRecentCloudSends).toHaveBeenCalledTimes(1);
      expect(reconcileRecentCloudSends).toHaveBeenCalledWith(testDb);
    });
  }
);
