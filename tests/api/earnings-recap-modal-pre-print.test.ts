/**
 * HTTP-boundary tests for POST /api/earnings/recap-modal — the pre-print
 * floor on the "Generate" button (Codex review blocker, 2026-08-28).
 *
 * The route runs a single-event enrichment pass before composing. That pass
 * bypasses the release-window filter by design, so a click before the print
 * window opens could fetch an erroneous early vendor actual, write it, stamp
 * enriched_at (arming the recap send gate) and fire the print push. The
 * runner still refuses that row on the shared pre-print floor and the route
 * still composes nothing.
 *
 * TRANSPORT (QA 2026-09-07, finding
 * today-earningshub-gen-recap--pre-print-409-console-error-red-toast): the
 * refusal now travels as a 200 carrying { success:false, prePrint:true,
 * code:"pre_print" } instead of a 409, matching the route's OWN precedent
 * for the no-actuals-yet guard a few lines below it ("return 200 with a
 * structured flag so a routine click doesn't log a browser console error").
 * Clicking "gen recap" on a row whose window has not opened is a routine,
 * expected click; it must not put a red 409 in the browser console.
 *
 * No force override is plumbed here: the bogeys modal's "Save actuals" road
 * owns the human confirm, and this surface has no such affordance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  compose: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Stub the composer (the route's only other collaborator) so these tests
// stay on the HTTP boundary and never reach the AI stack. EarningsEmailError
// is re-declared here because the route's `instanceof` check resolves
// against whatever this module exports.
vi.mock("@/lib/digest/send-earnings-email", () => {
  class EarningsEmailError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return { EarningsEmailError, composeEarningsEmail: hoisted.compose };
});

vi.mock("@/lib/alerts/print-push", () => ({
  sendEarningsPrintPush: vi.fn(async () => ({ pushed: true })),
}));
import { sendEarningsPrintPush } from "@/lib/alerts/print-push";

const EVENT_DATE = "2026-08-27"; // EDT — ET = UTC−4

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  hoisted.compose.mockReset();
  vi.mocked(sendEarningsPrintPush).mockClear();
  vi.stubGlobal("fetch", vi.fn());
  process.env.FINNHUB_API_KEY = "test_finnhub_key";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.FINNHUB_API_KEY;
});

function seedAmcEvent(): number {
  const row = hoisted.db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key, week_of
       ) VALUES ('finnhub','earnings',?, 'AMC', '17:00', 'CRWX earnings',
                 'CRWX', ?, ?)
       RETURNING id`,
    )
    .get(EVENT_DATE, `finnhub:CRWX:${EVENT_DATE}`, EVENT_DATE) as { id: number };
  return row.id;
}

function postReq(body: unknown): Request {
  return new Request("http://test/api/earnings/recap-modal", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/earnings/recap-modal — pre-print floor", () => {
  it("refuses with a 200 pre_print envelope before the slot window opens — an expected click is not an HTTP error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T19:30:00Z")); // 15:30 ET
    const eventId = seedAmcEvent();

    const mod = await import("@/app/api/earnings/recap-modal/route");
    const res = await mod.POST(postReq({ eventId }));

    // 200, not 409: the browser console must stay clean on a routine click.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      prePrint: boolean;
      code: string;
      error: string;
      opensAt: string | null;
    };
    expect(body.success).toBe(false);
    expect(body.prePrint).toBe(true);
    expect(body.code).toBe("pre_print");
    expect(body.error).toMatch(/after-close print/);
    expect(body.error).toContain("4:00 PM ET");
    // The window the caller is waiting for, as an instant it can render.
    expect(body.opensAt).toBe(new Date("2026-08-27T20:00:00Z").toISOString());

    // Nothing fetched, nothing written, nothing pushed, nothing composed.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(hoisted.compose).not.toHaveBeenCalled();
    expect(sendEarningsPrintPush).not.toHaveBeenCalled();
    const row = hoisted.db
      .prepare(
        `SELECT actual_value, enriched_at, enrichment_attempted_at
           FROM calendar_events WHERE id = ?`,
      )
      .get(eventId) as {
      actual_value: string | null;
      enriched_at: string | null;
      enrichment_attempted_at: string | null;
    };
    expect(row.actual_value).toBeNull();
    expect(row.enriched_at).toBeNull();
    expect(row.enrichment_attempted_at).toBeNull();
  });

  it("composes normally once the slot window has opened", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:12:00Z")); // 16:12 ET
    const eventId = seedAmcEvent();

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "CRWX", date: EVENT_DATE, epsActual: 1.42, epsEstimate: 1.35 },
        ],
      }),
    });
    hoisted.compose.mockResolvedValue({
      symbol: "CRWX",
      title: "CRWX Earnings Recap",
      markdown: "# recap",
      aiMarkdown: "# recap",
      html: "<p>recap</p>",
      promptHash: "abc",
    });

    const mod = await import("@/app/api/earnings/recap-modal/route");
    const res = await mod.POST(postReq({ eventId }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      symbol: string;
      enriched: { actual: string | null } | null;
    };
    expect(body.success).toBe(true);
    expect(body.symbol).toBe("CRWX");
    expect(body.enriched?.actual).toContain("EPS 1.42");
    expect(hoisted.compose).toHaveBeenCalledOnce();
  });
});
