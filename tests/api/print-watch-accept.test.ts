/**
 * HTTP-boundary tests for POST /api/print-watch/accept — Task 11.
 *
 * Rules under test (task-11-brief.md):
 *  - Validate the ENTIRE request first, then apply in ONE transaction
 *    (Codex #14): any invalid metric for accept (state conflict/pending, or
 *    unknown) -> 400 naming it, ZERO rows changed, saveManualActuals never
 *    called.
 *  - Unaccept clears accepted state back to 'pending' (Codex #15 re-verify
 *    path).
 *  - promoteHeadline requires a COMPLETE pair: an accepted EPS line (adj
 *    preferred over gaap, basis named in the response) AND an accepted
 *    revenue_q — else 400 explaining the stale-merge risk.
 *  - A pre_print 409 from saveManualActuals passes through with its code,
 *    and rolls back accept/unaccept writes from the SAME request.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines, getSheet, markLineAccepted } from "@/lib/print-watch/store";
import type { LineContract, ExpectedValue, PrintWatchLine, LineStateKind } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Partial mock: real implementation wrapped in a spy, so promotion tests
// exercise the true saveManualActuals logic (incl. the pre-print floor)
// while atomicity tests can assert it was never invoked.
vi.mock("@/lib/earnings/actuals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/earnings/actuals")>("@/lib/earnings/actuals");
  return {
    ...actual,
    saveManualActuals: vi.fn(actual.saveManualActuals),
  };
});

import { saveManualActuals } from "@/lib/earnings/actuals";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.useRealTimers();
  vi.mocked(saveManualActuals).mockClear();
});

function insertCalendarEvent(opts: {
  eventDate: string;
  releaseTime?: string | null;
  symbol?: string;
}): number {
  const row = hoisted.db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?)
       RETURNING id`,
    )
    .get(
      opts.eventDate,
      opts.releaseTime ?? null,
      opts.releaseTime ?? null,
      `${opts.symbol ?? "ACME"} earnings`,
      opts.symbol ?? "ACME",
      `finnhub:${opts.symbol ?? "ACME"}:${opts.eventDate}`,
    ) as { id: number };
  return row.id;
}

function makeContract(metricId: string, overrides: Partial<LineContract> = {}): LineContract {
  const base: LineContract = {
    metric_id: metricId,
    label: metricId,
    definition: `definition for ${metricId}`,
    basis: "non_gaap",
    period: "Q",
    currency: "USD",
    unit: "per_share",
    kind: "point",
    segment: null,
  };
  return { ...base, ...overrides };
}

const EXPECTED: ExpectedValue = { value: 1.5, value_high: null, whisper: null, source_label: "consensus" };

function makeLine(
  metricId: string,
  state: LineStateKind,
  value: number | null,
  overrides: Partial<PrintWatchLine> = {},
): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: makeContract(metricId, overrides.contract as Partial<LineContract> | undefined),
    expected: EXPECTED,
    state,
    value,
    value_high: null,
    snippet: `snippet for ${metricId}`,
    source_doc_id: null,
    candidates_json: "[]",
    ...overrides,
  };
}

/** Seeds a print with an event and returns { eventId, printId }. Lines are
 *  written pre-accepted-state via upsertLines (never through markLineAccepted
 *  here, so callers control exact starting states per test). */
function seedPrint(
  lines: PrintWatchLine[],
  opts: { eventDate?: string; releaseTime?: string | null; symbol?: string } = {},
): { eventId: number; printId: number } {
  const eventId = insertCalendarEvent({
    eventDate: opts.eventDate ?? "2026-08-10",
    releaseTime: opts.releaseTime ?? null,
    symbol: opts.symbol,
  });
  const printId = upsertPrint(hoisted.db, eventId, opts.symbol ?? "ACME", opts.eventDate ?? "2026-08-10", null);
  upsertLines(hoisted.db, printId, lines);
  return { eventId, printId };
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/print-watch/accept", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

type Envelope = {
  success: boolean;
  error?: string;
  code?: string;
  data?: {
    accepted: string[];
    unaccepted: string[];
    promoted: { basis: "adj" | "gaap"; actualValue: string } | null;
  };
};

async function callAccept(body: unknown) {
  const mod = await import("@/app/api/print-watch/accept/route");
  const res = await mod.POST(postReq(body));
  const json = (await res.json()) as Envelope;
  return { status: res.status, json };
}

describe("POST /api/print-watch/accept", () => {
  it("400s when eventId is missing", async () => {
    const { status, json } = await callAccept({ accept: ["eps_adj_q"] });
    expect(status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/eventId/);
  });

  it("404s when no print-watch record exists for the event", async () => {
    const eventId = insertCalendarEvent({ eventDate: "2026-08-10" });
    const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q"] });
    expect(status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(String(eventId));
  });

  describe("accept validation — atomicity (Codex #14)", () => {
    it("rejects the whole request when one metric is in 'conflict', leaving every line unchanged and never calling saveManualActuals", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42),
        makeLine("revenue_q", "conflict", null),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "revenue_q"],
      });

      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/revenue_q/);
      expect(json.error).toMatch(/conflict/);

      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("agreed"); // NOT accepted
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).toBe("conflict");
      expect(saveManualActuals).not.toHaveBeenCalled();
    });

    it("rejects a 'pending' metric by name", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "pending", null)]);

      const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(400);
      expect(json.error).toMatch(/eps_adj_q/);
      expect(json.error).toMatch(/pending/);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("pending");
    });

    it("rejects an unknown metric_id not on the sheet, writing nothing", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);

      const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q", "not_a_real_metric"] });

      expect(status).toBe(400);
      expect(json.error).toMatch(/not_a_real_metric/);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("agreed"); // untouched
      expect(saveManualActuals).not.toHaveBeenCalled();
    });

    it.each(["agreed", "flash", "single_source", "blank"] as const)(
      "accepts a '%s' line",
      async (state) => {
        const { eventId, printId } = seedPrint([makeLine("eps_adj_q", state, state === "blank" ? null : 1.42)]);

        const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q"] });

        expect(status).toBe(200);
        expect(json.success).toBe(true);
        expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
      },
    );

    it("re-accepting an already-accepted line is a harmless no-op, not an error", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");

      const { status } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
    });
  });

  describe("unaccept round-trip (Codex #15 re-verify path)", () => {
    it("clears an accepted line back off 'accepted'", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");

      const { status, json } = await callAccept({ eventId, unaccept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(json.data!.unaccepted).toEqual(["eps_adj_q"]);
      expect(getSheet(hoisted.db, printId)[0].state).not.toBe("accepted");
    });

    it("400s an unknown metric_id on unaccept, writing nothing", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");

      const { status, json } = await callAccept({ eventId, unaccept: ["not_a_real_metric"] });

      expect(status).toBe(400);
      expect(json.error).toMatch(/not_a_real_metric/);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted"); // untouched
    });

    it("accept and unaccept can combine in one request (different metrics)", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42),
        makeLine("revenue_q", "agreed", 5_000_000),
      ]);
      markLineAccepted(hoisted.db, printId, "revenue_q");

      const { status } = await callAccept({ eventId, accept: ["eps_adj_q"], unaccept: ["revenue_q"] });

      expect(status).toBe(200);
      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("accepted");
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).not.toBe("accepted");
    });

    it("400s when the same metric appears in both accept and unaccept — ambiguous, writes nothing", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);

      const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q"], unaccept: ["eps_adj_q"] });

      expect(status).toBe(400);
      expect(json.error).toMatch(/eps_adj_q/);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("agreed"); // untouched
    });
  });

  describe("promoteHeadline — complete-pair rule", () => {
    it("400s with the stale-merge explanation when only EPS is accepted", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42),
        makeLine("revenue_q", "conflict", null),
      ]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/revenue_q/);
      expect(json.error).toMatch(/stale/i);
      expect(saveManualActuals).not.toHaveBeenCalled();
    });

    it("400s when only revenue is accepted (EPS missing)", async () => {
      const { eventId, printId } = seedPrint([makeLine("revenue_q", "agreed", 5_000_000)]);
      markLineAccepted(hoisted.db, printId, "revenue_q");

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(400);
      expect(json.error).toMatch(/EPS/);
    });

    it("prefers eps_adj_q over eps_gaap_q and names the basis 'adj' in the response", async () => {
      const { eventId } = seedPrint(
        [
          makeLine("eps_adj_q", "agreed", 1.42),
          makeLine("eps_gaap_q", "agreed", 1.10),
          makeLine("revenue_q", "agreed", 5_000_000),
        ],
        { eventDate: "2026-08-10", releaseTime: null },
      );

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "eps_gaap_q", "revenue_q"],
        promoteHeadline: true,
      });

      expect(status).toBe(200);
      expect(json.data!.promoted).not.toBeNull();
      expect(json.data!.promoted!.basis).toBe("adj");
      expect(json.data!.promoted!.actualValue).toMatch(/EPS 1\.42/);
      expect(saveManualActuals).toHaveBeenCalledWith(
        hoisted.db,
        expect.objectContaining({ eventId, epsActual: 1.42, revenueActualUsd: 5_000_000 }),
      );
    });

    it("falls back to eps_gaap_q and names the basis 'gaap' when eps_adj_q isn't accepted", async () => {
      const { eventId } = seedPrint([
        makeLine("eps_gaap_q", "agreed", 1.10),
        makeLine("revenue_q", "agreed", 5_000_000),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_gaap_q", "revenue_q"],
        promoteHeadline: true,
      });

      expect(status).toBe(200);
      expect(json.data!.promoted!.basis).toBe("gaap");
      expect(json.data!.promoted!.actualValue).toMatch(/EPS 1\.10/);
      expect(saveManualActuals).toHaveBeenCalledWith(
        hoisted.db,
        expect.objectContaining({ epsActual: 1.10, revenueActualUsd: 5_000_000 }),
      );
    });

    it("promotes atomically in one call combining accept + promoteHeadline", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "flash", 2.05),
        makeLine("revenue_q", "single_source", 9_000_000),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "revenue_q"],
        promoteHeadline: true,
      });

      expect(status).toBe(200);
      expect(json.data!.accepted).toEqual(["eps_adj_q", "revenue_q"]);
      expect(json.data!.promoted!.basis).toBe("adj");

      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("accepted");
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).toBe("accepted");
    });
  });

  describe("pre_print passthrough (409, rolls back the whole request)", () => {
    it("passes through code 'pre_print' and rolls back accept writes from the same request", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));

      const { eventId, printId } = seedPrint(
        [
          makeLine("eps_adj_q", "agreed", 1.42),
          makeLine("revenue_q", "agreed", 5_000_000),
        ],
        { eventDate: "2026-08-21", releaseTime: "07:30" }, // 2 days ahead of "now"
      );

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "revenue_q"],
        promoteHeadline: true,
      });

      expect(status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.code).toBe("pre_print");
      expect(json.error).toMatch(/future/i);

      // Rolled back: neither accept write survives the aborted transaction.
      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("agreed");
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).toBe("agreed");

      const event = hoisted.db
        .prepare(`SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?`)
        .get(eventId) as { actual_value: string | null; manual_actuals_at: string | null };
      expect(event.actual_value).toBeNull();
      expect(event.manual_actuals_at).toBeNull();
    });

    it("force:true bypasses the pre-print floor and promotes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));

      const { eventId, printId } = seedPrint(
        [
          makeLine("eps_adj_q", "agreed", 1.42),
          makeLine("revenue_q", "agreed", 5_000_000),
        ],
        { eventDate: "2026-08-21", releaseTime: "07:30" },
      );

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "revenue_q"],
        promoteHeadline: true,
        force: true,
      });

      expect(status).toBe(200);
      expect(json.data!.promoted).not.toBeNull();
      expect(getSheet(hoisted.db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe("accepted");
    });
  });

  describe("envelope shapes", () => {
    it("accept-only success has promoted: null", async () => {
      const { eventId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);

      const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(json).toEqual({
        success: true,
        data: { accepted: ["eps_adj_q"], unaccepted: [], promoted: null },
      });
    });

    it("400 body field validation for a non-array accept", async () => {
      const { eventId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);

      const { status, json } = await callAccept({ eventId, accept: "eps_adj_q" });

      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/array/i);
    });
  });
});
