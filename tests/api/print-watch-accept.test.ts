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
 *  - Re-accepting an un-accepted line (the 'pending'-with-a-value residue)
 *    runs the promote gate's supersession comparison: 409 'superseded' when
 *    the refreshed candidates disagree, unless forceSuperseded (Codex HIGH).
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
import {
  upsertPrint,
  upsertLines,
  getSheet,
  markLineAccepted,
  insertDocument,
} from "@/lib/print-watch/store";
import type {
  LineContract,
  ExpectedValue,
  PrintWatchLine,
  LineStateKind,
  TaggedCandidate,
} from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  /** `db.inTransaction` at each getSheet call — see the "reads state INSIDE
   *  the transaction" block at the bottom of this file. */
  sheetReadsInTransaction: [] as boolean[],
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Partial mock: the REAL store with getSheet instrumented. Every validation
// guard in the route is a statement about DB state another process can change
// (the watcher rewrites candidates_json on every reconcile), so the read those
// guards run against has to happen inside the route's own transaction — fix
// wave, B-residual. This records where each read actually happened.
vi.mock("@/lib/print-watch/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/print-watch/store")>(
    "@/lib/print-watch/store",
  );
  return {
    ...actual,
    getSheet: (db: Database.Database, printId: number) => {
      hoisted.sheetReadsInTransaction.push(db.inTransaction);
      return actual.getSheet(db, printId);
    },
  };
});

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
  hoisted.sheetReadsInTransaction.length = 0;
});

function insertCalendarEvent(opts: {
  eventDate: string;
  releaseTime?: string | null;
  symbol?: string;
  /** Defaults to releaseTime (the historical shape of this helper). */
  eventTime?: string | null;
  rawJson?: string | null;
}): number {
  const row = hoisted.db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key, raw_json
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?)
       RETURNING id`,
    )
    .get(
      opts.eventDate,
      opts.eventTime === undefined ? opts.releaseTime ?? null : opts.eventTime,
      opts.releaseTime ?? null,
      `${opts.symbol ?? "ACME"} earnings`,
      opts.symbol ?? "ACME",
      `finnhub:${opts.symbol ?? "ACME"}:${opts.eventDate}`,
      opts.rawJson ?? null,
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
  opts: {
    eventDate?: string;
    releaseTime?: string | null;
    symbol?: string;
    eventTime?: string | null;
    rawJson?: string | null;
  } = {},
): { eventId: number; printId: number } {
  const eventId = insertCalendarEvent({
    eventDate: opts.eventDate ?? "2026-08-10",
    releaseTime: opts.releaseTime ?? null,
    symbol: opts.symbol,
    eventTime: opts.eventTime,
    rawJson: opts.rawJson,
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

    // QA finding `today-print-watch--unaccept-one-way-no-per-line-accept-
    // promote-falls-to-gaap`: clearLineAccepted parks an un-accepted line on
    // 'pending' but LEAVES its value, and the reconciler never produces a
    // pending line with a value — so pending+value is "the desk un-accepted
    // this", not "still waiting for a source", and refusing it made an
    // accidental un-accept unrecoverable until the next watcher poll.
    it("accepts a 'pending' line that still carries its number (un-accept recovery)", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "pending", 1.42)]);

      const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data!.accepted).toEqual(["eps_adj_q"]);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
    });

    it("round-trips unaccept then re-accept in the same watch window, without a reconcile in between", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");

      const cleared = await callAccept({ eventId, unaccept: ["eps_adj_q"] });
      expect(cleared.status).toBe(200);
      const afterUnaccept = getSheet(hoisted.db, printId)[0];
      expect(afterUnaccept.state).toBe("pending");
      expect(afterUnaccept.value).toBe(1.42); // the number survives the unaccept

      const restored = await callAccept({ eventId, accept: ["eps_adj_q"] });
      expect(restored.status).toBe(200);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
    });

    it("still refuses a 'pending' line with no number — nothing to accept yet", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42),
        makeLine("revenue_q", "pending", null),
      ]);

      const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q", "revenue_q"] });

      expect(status).toBe(400);
      expect(json.error).toMatch(/revenue_q/);
      expect(json.error).toMatch(/pending/);
      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("agreed"); // rolled back
    });

    it("re-accepting an already-accepted line is a harmless no-op, not an error", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");

      const { status } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
    });
  });

  // Codex HIGH: the un-accept residue is a NUMBER, and the candidates under it
  // kept moving while the line sat accepted (upsertLines refreshes
  // candidates_json on an accepted row, reconcile.ts rule 6). So "pending with
  // a value" can mean "the desk un-accepted a number the evidence has since
  // contradicted" — and admitting that line without rechecking made
  // un-accept/re-accept a laundering path back to a figure the promote gate
  // refuses. The accept loop now runs the promote gate's own comparison.
  describe("per-line accept — supersession recheck on the un-accept residue", () => {
    function candidate(overrides: Partial<TaggedCandidate> = {}): TaggedCandidate {
      return {
        metric_id: "eps_adj_q",
        value: 1.42,
        value_high: null,
        raw_text: "1.42",
        snippet: "adjusted EPS of $1.42",
        location_hint: null,
        not_disclosed: false,
        doc_id: 7,
        representation: "repA",
        weak_pair: false,
        ...overrides,
      };
    }

    /**
     * The residue shape: state 'pending', the earlier accepted number still on
     * the line, newer evidence beneath it.
     *
     * Seeded DIRECTLY (not through the route's unaccept) since the QA fix
     * `…unaccept-after-supersede-keeps-old-value-hides-newer-candidate`:
     * un-accept now re-derives the line through the reconciler, so a
     * disagreeing pool lands on 'conflict' with no number rather than on this
     * shape. Rows already parked this way before that fix shipped still exist,
     * so the gate below has to keep holding for them — that is what these
     * tests pin. The route-driven un-accept behaviour is pinned separately in
     * "unaccept re-derives the line".
     */
    async function seedUnacceptedResidue(candidates: TaggedCandidate[]) {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "pending", 1.42, {
          candidates_json: JSON.stringify(candidates),
        }),
      ]);

      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("pending");
      expect(line.value).toBe(1.42); // residue: the accepted number survives

      return { eventId, printId };
    }

    it("409s with code 'superseded' when the refreshed candidates disagree with the residue, writing nothing", async () => {
      const { eventId, printId } = await seedUnacceptedResidue([
        candidate(),
        candidate({ value: 1.24, doc_id: 9, snippet: "adjusted EPS of $1.24" }),
      ]);

      const { status, json } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.code).toBe("superseded");
      expect(json.error).toMatch(/eps_adj_q/);
      expect(json.error).toMatch(/1\.24/);

      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("pending"); // nothing written
      expect(line.value).toBe(1.42);
      expect(saveManualActuals).not.toHaveBeenCalled();
    });

    it("forceSuperseded: true accepts the residue anyway — the desk overriding with its own eyes", async () => {
      const { eventId, printId } = await seedUnacceptedResidue([
        candidate(),
        candidate({ value: 1.24, doc_id: 9 }),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q"],
        forceSuperseded: true,
      });

      expect(status).toBe(200);
      expect(json.data!.accepted).toEqual(["eps_adj_q"]);
      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("accepted");
      expect(line.value).toBe(1.42);
    });

    it("re-accepts normally when the refreshed candidates still agree with the residue", async () => {
      const { eventId, printId } = await seedUnacceptedResidue([
        candidate(),
        candidate({ doc_id: 9, representation: "repB" }),
      ]);

      const { status } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
    });

    it("does NOT trip on a flash candidate that disagrees — wire rounding is noise, same as the promote gate", async () => {
      const { eventId, printId } = await seedUnacceptedResidue([
        candidate(),
        candidate({ value: 1.4, doc_id: 9, representation: "flash" }),
      ]);

      const { status } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
    });

    it("leaves a non-residue line alone: an 'agreed' line accepts even with a diverging candidate beneath it", async () => {
      // Structurally unreachable through the reconciler (strict unanimity
      // would call that pool a conflict) — seeded to pin the SCOPE of the
      // gate: only 'pending'-with-a-value is residue. Every other acceptable
      // state is the reconciler's own current reading of the pool, and
      // re-gating it would refuse lines the reconciler just endorsed.
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42, {
          candidates_json: JSON.stringify([candidate(), candidate({ value: 1.24, doc_id: 9 })]),
        }),
      ]);

      const { status } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("accepted");
    });
  });

  // QA finding `today-print-watch--unaccept-after-supersede-keeps-old-value-
  // hides-newer-candidate` (HIGH) — user ruling 2026-09-02, option 1. A
  // conflict line has no top-level number by construction, so the only honest
  // way to accept anything on it is to name the DOCUMENT whose figure the desk
  // verified: `accept: [{ metric_id, doc_id }]`.
  describe("per-candidate accept — accept: [{ metric_id, doc_id }]", () => {
    function cand(overrides: Partial<TaggedCandidate> = {}): TaggedCandidate {
      return {
        metric_id: "eps_adj_q",
        value: 1.42,
        value_high: null,
        raw_text: "1.42",
        snippet: "adjusted EPS of $1.42",
        location_hint: null,
        not_disclosed: false,
        doc_id: 0,
        representation: "repA",
        weak_pair: false,
        ...overrides,
      };
    }

    /** A print with two REAL documents (source_doc_id is a live FK) and a
     *  conflict line whose pool holds one figure from each. */
    function seedConflict(
      build: (docA: number, docB: number) => TaggedCandidate[],
      extraLines: PrintWatchLine[] = [],
    ) {
      const eventId = insertCalendarEvent({ eventDate: "2026-08-10" });
      const printId = upsertPrint(hoisted.db, eventId, "ACME", "2026-08-10", null);
      const docA = insertDocument(hoisted.db, printId, "dj-release", "dj", null, "sha-a", "/a").id;
      const docB = insertDocument(hoisted.db, printId, "edgar-ex99", "sec", null, "sha-b", "/b").id;
      upsertLines(hoisted.db, printId, [
        makeLine("eps_adj_q", "conflict", null, {
          snippet: null,
          candidates_json: JSON.stringify(build(docA, docB)),
        }),
        ...extraLines,
      ]);
      return { eventId, printId, docA, docB };
    }

    it("locks the named candidate's figure, snippet and document onto the conflict line", async () => {
      const { eventId, printId, docA, docB } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: 1.24, raw_text: "1.24", snippet: "adjusted EPS of $1.24" }),
      ]);
      const before = getSheet(hoisted.db, printId)[0].candidates_json;

      const { status, json } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docB }],
      });

      expect(status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data!.accepted).toEqual(["eps_adj_q"]); // envelope stays metric ids

      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("accepted");
      expect(line.value).toBe(1.24);
      expect(line.snippet).toBe("adjusted EPS of $1.24");
      expect(line.source_doc_id).toBe(docB);
      expect(line.candidates_json).toBe(before); // the rejected rival survives
      expect(docA).not.toBe(docB);
    });

    it("does NOT 409 when the named candidate is the NEWEST document — accepting the superseding document IS the re-verify", async () => {
      const { eventId, printId, docB } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: 1.24 }),
      ]);

      const { status } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docB }],
      });

      expect(status).toBe(200);
      expect(getSheet(hoisted.db, printId)[0].value).toBe(1.24);
    });

    it("409s 'superseded' when the named candidate is the STALE document a later one contradicts, writing nothing", async () => {
      const { eventId, printId, docA } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: 1.24 }),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docA }],
      });

      expect(status).toBe(409);
      expect(json.code).toBe("superseded");
      expect(json.error).toMatch(/eps_adj_q/);
      expect(json.error).toMatch(/1\.24/);

      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("conflict"); // nothing written
      expect(line.value).toBeNull();
      expect(saveManualActuals).not.toHaveBeenCalled();
    });

    it("forceSuperseded: true locks the stale document's figure anyway", async () => {
      const { eventId, printId, docA } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: 1.24 }),
      ]);

      const { status } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docA }],
        forceSuperseded: true,
      });

      expect(status).toBe(200);
      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("accepted");
      expect(line.value).toBe(1.42);
      expect(line.source_doc_id).toBe(docA);
    });

    it("400s when the named doc_id has no candidate for that metric, writing nothing", async () => {
      const { eventId, printId, docA, docB } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: 1.24 }),
      ]);
      const missing = Math.max(docA, docB) + 500;

      const { status, json } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: missing }],
      });

      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(String(missing));
      expect(json.error).toMatch(/eps_adj_q/);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("conflict");
    });

    it("400s when the named document reported the metric as not disclosed — no figure to lock in", async () => {
      const { eventId, printId, docB } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: null, raw_text: null, not_disclosed: true }),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docB }],
      });

      expect(status).toBe(400);
      expect(json.error).toMatch(/eps_adj_q/);
      expect(json.error).toMatch(/no (?:number|figure)/i);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("conflict");
    });

    it("400s on a wire-flash candidate — a flash has no document of record", async () => {
      const { eventId } = seedConflict((a) => [
        cand({ doc_id: a }),
        cand({ doc_id: 0, representation: "flash", value: 1.4 }),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: 0 }],
      });

      expect(status).toBe(400);
      expect(json.error).toMatch(/flash/i);
    });

    it("400s when one document's two readings disagree, until the desk names the representation", async () => {
      const { eventId, printId, docA } = seedConflict((a) => [
        cand({ doc_id: a, representation: "repA", value: 1.42 }),
        cand({ doc_id: a, representation: "repB", value: 1.24 }),
      ]);

      const ambiguous = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docA }],
      });
      expect(ambiguous.status).toBe(400);
      expect(ambiguous.json.error).toMatch(/representation/i);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("conflict");

      const named = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docA, representation: "repB" }],
      });
      expect(named.status).toBe(200);
      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("accepted");
      expect(line.value).toBe(1.24);
    });

    it("400s a malformed accept entry (an object without a doc_id), writing nothing", async () => {
      const { eventId, printId } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: 1.24 }),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q" }],
      });

      expect(status).toBe(400);
      expect(json.error).toMatch(/doc_id/);
      expect(getSheet(hoisted.db, printId)[0].state).toBe("conflict");
    });

    it("promotes the CANDIDATE's number in the same request, not the line's stale value", async () => {
      const { eventId, docB } = seedConflict(
        (a, b) => [cand({ doc_id: a }), cand({ doc_id: b, value: 1.24 })],
        [makeLine("revenue_q", "agreed", 5_000_000)],
      );

      const { status, json } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docB }, "revenue_q"],
        promoteHeadline: true,
      });

      expect(status).toBe(200);
      expect(json.data!.accepted).toEqual(["eps_adj_q", "revenue_q"]);
      expect(json.data!.promoted!.actualValue).toMatch(/EPS 1\.24/);
      expect(saveManualActuals).toHaveBeenCalledWith(
        hoisted.db,
        expect.objectContaining({ epsActual: 1.24, revenueActualUsd: 5_000_000 }),
      );
    });

    it("re-points an already-accepted line at a corrected document without an un-accept first", async () => {
      const { eventId, printId, docA, docB } = seedConflict((a, b) => [
        cand({ doc_id: a }),
        cand({ doc_id: b, value: 1.24 }),
      ]);
      // The desk had locked the first document's figure.
      hoisted.db
        .prepare(
          `UPDATE print_watch_lines SET state = 'accepted', value = 1.42, source_doc_id = ?
            WHERE print_id = ? AND metric_id = 'eps_adj_q'`,
        )
        .run(docA, printId);

      const { status } = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docB }],
      });

      expect(status).toBe(200);
      const line = getSheet(hoisted.db, printId)[0];
      expect(line.value).toBe(1.24);
      expect(line.source_doc_id).toBe(docB);
    });
  });

  // The finding itself, at the HTTP boundary: un-accepting a line the panel
  // flagged "⟳ superseded — re-verify" must stop rendering the superseded
  // figure and surface the rivals instead.
  describe("unaccept re-derives the line (QA: unaccept-after-supersede)", () => {
    it("lands a disagreeing pool on 'conflict' with the stale figure cleared and every rival kept", async () => {
      const eventId = insertCalendarEvent({ eventDate: "2026-08-10" });
      const printId = upsertPrint(hoisted.db, eventId, "ACME", "2026-08-10", null);
      const docA = insertDocument(hoisted.db, printId, "dj-release", "dj", null, "s-a", "/a").id;
      const docB = insertDocument(hoisted.db, printId, "edgar-ex99", "sec", null, "s-b", "/b").id;
      const pool: TaggedCandidate[] = [
        {
          metric_id: "eps_adj_q",
          value: 1.42,
          value_high: null,
          raw_text: "1.42",
          snippet: "adjusted EPS of $1.42",
          location_hint: null,
          not_disclosed: false,
          doc_id: docA,
          representation: "repA",
          weak_pair: false,
        },
        {
          metric_id: "eps_adj_q",
          value: 1.24,
          value_high: null,
          raw_text: "1.24",
          snippet: "adjusted EPS of $1.24",
          location_hint: null,
          not_disclosed: false,
          doc_id: docB,
          representation: "repA",
          weak_pair: false,
        },
      ];
      upsertLines(hoisted.db, printId, [
        makeLine("eps_adj_q", "agreed", 1.42, {
          source_doc_id: docA,
          candidates_json: JSON.stringify(pool),
        }),
      ]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");

      const { status } = await callAccept({ eventId, unaccept: ["eps_adj_q"] });

      expect(status).toBe(200);
      const line = getSheet(hoisted.db, printId)[0];
      expect(line.state).toBe("conflict");
      expect(line.value).toBeNull();
      expect(line.snippet).toBeNull();
      expect(JSON.parse(line.candidates_json)).toHaveLength(2);
    });

    it("still admits a plain re-accept when the pool agrees (the un-accept recovery path)", async () => {
      const { eventId, printId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");

      expect((await callAccept({ eventId, unaccept: ["eps_adj_q"] })).status).toBe(200);
      const cleared = getSheet(hoisted.db, printId)[0];
      expect(cleared.state).toBe("pending");
      expect(cleared.value).toBe(1.42); // empty pool: nothing to re-derive from

      expect((await callAccept({ eventId, accept: ["eps_adj_q"] })).status).toBe(200);
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

    // The pair rule above checks accepted-NESS. A `blank` line ("not
    // disclosed") is acceptable on purpose but carries value = null, so it
    // satisfies that rule while handing saveManualActuals an epsActual of
    // null — mergeFinnhubActual then writes exactly the half-pair /
    // stale-merge the rule exists to prevent.
    it("400s when an ACCEPTED line has no reported value (blank EPS), writing nothing", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "blank", null),
        makeLine("revenue_q", "agreed", 5_000_000),
      ]);

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "revenue_q"],
        promoteHeadline: true,
      });

      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/eps_adj_q/);
      expect(json.error).toMatch(/stale/i);
      expect(saveManualActuals).not.toHaveBeenCalled();

      // Nothing written: neither the accepts nor any actuals.
      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("blank");
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).toBe("agreed");
      const event = hoisted.db
        .prepare(`SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?`)
        .get(eventId) as { actual_value: string | null; manual_actuals_at: string | null };
      expect(event.actual_value).toBeNull();
      expect(event.manual_actuals_at).toBeNull();
    });

    it("400s when the accepted revenue line has no reported value", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42),
        makeLine("revenue_q", "blank", null),
      ]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");
      markLineAccepted(hoisted.db, printId, "revenue_q");

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(400);
      expect(json.error).toMatch(/revenue_q/);
      expect(saveManualActuals).not.toHaveBeenCalled();
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

  // Fix wave, finding B: the panel could SEE a superseded accepted line (the
  // "superseded — re-verify" chip) but the promote path never rechecked it, so
  // a corrected release could sit flagged on screen while the stale number was
  // written into the recap scoreboard.
  describe("promoteHeadline — supersession recheck (409 'superseded')", () => {
    function taggedCandidate(overrides: Partial<TaggedCandidate> = {}): TaggedCandidate {
      return {
        metric_id: "eps_adj_q",
        value: 1.42,
        value_high: null,
        raw_text: "1.42",
        snippet: "adjusted EPS of $1.42",
        location_hint: null,
        not_disclosed: false,
        doc_id: 7,
        representation: "repA",
        weak_pair: false,
        ...overrides,
      };
    }

    function seedPair(candidatesJson: string, revenueCandidatesJson = "[]") {
      const seeded = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42, { candidates_json: candidatesJson }),
        makeLine("revenue_q", "agreed", 5_000_000, { candidates_json: revenueCandidatesJson }),
      ]);
      markLineAccepted(hoisted.db, seeded.printId, "eps_adj_q");
      markLineAccepted(hoisted.db, seeded.printId, "revenue_q");
      return seeded;
    }

    it("409s with code 'superseded' when a non-flash candidate disagrees with the accepted EPS, writing nothing", async () => {
      const { eventId, printId } = seedPair(
        JSON.stringify([
          taggedCandidate(),
          // The correction: an 8-K/A, or a re-drop of the corrected release.
          taggedCandidate({ value: 1.24, doc_id: 9, snippet: "adjusted EPS of $1.24" }),
        ]),
      );

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.code).toBe("superseded");
      expect(json.error).toMatch(/eps_adj_q/);
      expect(json.error).toMatch(/1\.24/);
      expect(saveManualActuals).not.toHaveBeenCalled();

      // Nothing written: the accepted lines stay accepted, no actuals land.
      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("accepted");
      const event = hoisted.db
        .prepare(`SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?`)
        .get(eventId) as { actual_value: string | null; manual_actuals_at: string | null };
      expect(event.actual_value).toBeNull();
      expect(event.manual_actuals_at).toBeNull();
    });

    it("catches a diverging revenue candidate too, naming the metric", async () => {
      const { eventId } = seedPair(
        "[]",
        JSON.stringify([
          taggedCandidate({ metric_id: "revenue_q", value: 5_400_000, doc_id: 9 }),
        ]),
      );

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(409);
      expect(json.code).toBe("superseded");
      expect(json.error).toMatch(/revenue_q/);
    });

    it("does NOT trigger on a flash candidate that disagrees — wire rounding is expected noise", async () => {
      const { eventId } = seedPair(
        JSON.stringify([
          taggedCandidate(),
          taggedCandidate({ value: 1.4, representation: "flash", doc_id: 0 }),
        ]),
      );

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(200);
      expect(json.data!.promoted!.basis).toBe("adj");
      expect(saveManualActuals).toHaveBeenCalled();
    });

    it("does NOT trigger on a not_disclosed candidate, or on agreement within 1e-6", async () => {
      const { eventId } = seedPair(
        JSON.stringify([
          taggedCandidate({ value: 1.42 + 1.42e-9 }),
          taggedCandidate({ value: null, not_disclosed: true, doc_id: 11 }),
        ]),
      );

      const { status } = await callAccept({ eventId, promoteHeadline: true });
      expect(status).toBe(200);
    });

    it("forceSuperseded: true promotes the accepted value anyway", async () => {
      const { eventId, printId } = seedPair(
        JSON.stringify([taggedCandidate(), taggedCandidate({ value: 1.24, doc_id: 9 })]),
      );

      const { status, json } = await callAccept({
        eventId,
        promoteHeadline: true,
        forceSuperseded: true,
      });

      expect(status).toBe(200);
      expect(json.data!.promoted!.actualValue).toMatch(/EPS 1\.42/);
      expect(getSheet(hoisted.db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
        "accepted",
      );
    });

    it("the pre-print force does NOT double as a supersession override", async () => {
      const { eventId } = seedPair(
        JSON.stringify([taggedCandidate(), taggedCandidate({ value: 1.24, doc_id: 9 })]),
      );

      // `force` answers "the release time is still in the future" — a
      // different question, and it must not silently answer this one.
      const { status, json } = await callAccept({ eventId, promoteHeadline: true, force: true });

      expect(status).toBe(409);
      expect(json.code).toBe("superseded");
    });
  });

  // CONFIRMED defect: `divergentCandidates` (the line-level gate behind
  // `supersessionDetail`) flagged ANY non-flash rival that disagreed with
  // `line.value`, with no document ordering — unlike its per-candidate twin
  // `candidateSupersessionDetail`, which only counts a candidate from a
  // STRICTLY LATER document (`c.doc_id > chosen.source_doc_id`) as later
  // evidence. A per-candidate accept deliberately keeps the rejected OLDER
  // rival sitting in `candidates_json` (store.ts's `acceptLineCandidate` never
  // touches it) — so the desk's very next request, a plain
  // `{promoteHeadline: true}` from the panel's Promote button, ran the
  // line-level gate and 409'd on evidence it had already out-verified by
  // picking the newer document. Fix: `divergentCandidates` now ignores any
  // candidate whose `doc_id <= line.source_doc_id` once `source_doc_id` is a
  // number, matching `candidateSupersessionDetail`'s own rule.
  //
  // Parity note: the panel's `needsReverify` (tests/dashboard/print-watch-
  // panel.test.ts, describe("needsReverify — per-candidate accept document
  // order")) is fixed the same way over the identical (0.91 doc-B / 0.89
  // doc-A) figures, so the chip the desk sees and the gate the server
  // enforces read the same verdict.
  describe("promoteHeadline-only follow-up after a per-candidate accept — document-order gate", () => {
    function cand(overrides: Partial<TaggedCandidate> = {}): TaggedCandidate {
      return {
        metric_id: "eps_adj_q",
        value: 0.91,
        value_high: null,
        raw_text: "0.91",
        snippet: "adjusted EPS of $0.91",
        location_hint: null,
        not_disclosed: false,
        doc_id: 0,
        representation: "repA",
        weak_pair: false,
        ...overrides,
      };
    }

    /** Two REAL documents (docA earlier, docB later — AUTOINCREMENT ids) and
     *  a conflict-shaped eps_adj_q pool split between them, plus an
     *  already-accepted revenue_q so a promoteHeadline-only follow-up has a
     *  complete pair to work with. */
    function seedConflictWithAcceptedRevenue(
      build: (docA: number, docB: number) => TaggedCandidate[],
    ) {
      const eventId = insertCalendarEvent({ eventDate: "2026-08-10" });
      const printId = upsertPrint(hoisted.db, eventId, "ACME", "2026-08-10", null);
      const docA = insertDocument(hoisted.db, printId, "dj-release", "dj", null, "sha-order-a", "/a").id;
      const docB = insertDocument(hoisted.db, printId, "edgar-ex99", "sec", null, "sha-order-b", "/b").id;
      upsertLines(hoisted.db, printId, [
        makeLine("eps_adj_q", "conflict", null, {
          snippet: null,
          candidates_json: JSON.stringify(build(docA, docB)),
        }),
        makeLine("revenue_q", "agreed", 5_000_000),
      ]);
      markLineAccepted(hoisted.db, printId, "revenue_q");
      return { eventId, printId, docA, docB };
    }

    it("does NOT 409 when the accepted candidate is the LATER document and an older rival (0.89) still sits in candidates_json", async () => {
      const { eventId, printId, docA, docB } = seedConflictWithAcceptedRevenue((a, b) => [
        cand({ doc_id: a, value: 0.89, raw_text: "0.89", snippet: "adjusted EPS of $0.89" }),
        cand({ doc_id: b, value: 0.91 }),
      ]);

      const accepted = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docB }],
      });
      expect(accepted.status).toBe(200);
      const afterAccept = getSheet(hoisted.db, printId).find((l) => l.metric_id === "eps_adj_q")!;
      expect(afterAccept.value).toBe(0.91);
      expect(afterAccept.source_doc_id).toBe(docB);
      // The rejected older rival stays visible — never rewritten.
      expect(JSON.parse(afterAccept.candidates_json)).toHaveLength(2);
      expect(docA).toBeLessThan(docB);

      // The panel's Promote button sends exactly this — no `accept` array.
      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data!.promoted!.actualValue).toMatch(/EPS 0\.91/);
    });

    it("still 409s 'superseded' when the accepted candidate is the STALE document and a later rival (0.91) disagrees", async () => {
      const { eventId, docA } = seedConflictWithAcceptedRevenue((a, b) => [
        cand({ doc_id: a, value: 0.89, raw_text: "0.89", snippet: "adjusted EPS of $0.89" }),
        cand({ doc_id: b, value: 0.91 }),
      ]);

      // Locking the stale document needs forceSuperseded — candidateSupersessionDetail
      // already refuses this accept on its own (doc B is genuinely later).
      const accepted = await callAccept({
        eventId,
        accept: [{ metric_id: "eps_adj_q", doc_id: docA }],
        forceSuperseded: true,
      });
      expect(accepted.status).toBe(200);

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.code).toBe("superseded");
      expect(json.error).toMatch(/eps_adj_q/);
      expect(json.error).toMatch(/0\.91/);
      expect(saveManualActuals).not.toHaveBeenCalled();
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
      // Slot-floor wording (2026-08-28): a BMO row names its 07:00 ET floor.
      expect(json.error).toMatch(/before-open print/);

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

    /**
     * The live 2026-08-26/27 trap: an AMC name whose stored release_time is
     * the 17:00 CALL time refused a genuine 16:12 ET accept. The accept road
     * has no pre-print check of its own — it inherits the slot floor purely
     * through saveManualActuals, so this pins the inheritance.
     */
    it("promotes an AMC print at 16:12 ET despite a 17:00 call-time release_time (no force)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-27T20:12:00Z")); // 16:12 ET

      const { eventId, printId } = seedPrint(
        [
          makeLine("eps_adj_q", "agreed", 1.42),
          makeLine("revenue_q", "agreed", 5_000_000),
        ],
        {
          eventDate: "2026-08-27",
          releaseTime: "17:00",
          eventTime: null,
          rawJson: JSON.stringify({ entry: { hour: "amc" } }),
        },
      );

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "revenue_q"],
        promoteHeadline: true,
      });

      expect(status).toBe(200);
      expect(json.data!.promoted).not.toBeNull();
      expect(getSheet(hoisted.db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe(
        "accepted",
      );
    });
  });

  // Fix wave, B-residual: the guards used to validate a request-start
  // snapshot, and the transaction then applied decisions made from it. The
  // watcher writes candidates_json on every reconcile, so a correction landing
  // in that gap was validated away — the recheck passed on the clean snapshot
  // while the row it promoted already disagreed.
  describe("validation reads state INSIDE the transaction (B-residual)", () => {
    /** Direct SQL, deliberately NOT through upsertLines — this is what another
     *  process's committed write looks like from this request's point of view. */
    function commitRivalCandidate(printId: number, metricId: string, value: number): void {
      hoisted.db
        .prepare(`UPDATE print_watch_lines SET candidates_json = ? WHERE print_id = ? AND metric_id = ?`)
        .run(
          JSON.stringify([
            {
              metric_id: metricId,
              value,
              value_high: null,
              raw_text: String(value),
              snippet: `restated ${value}`,
              location_hint: null,
              not_disclosed: false,
              doc_id: 12,
              representation: "repA",
              weak_pair: false,
            },
          ]),
          printId,
          metricId,
        );
    }

    it("takes the sheet read the guards use from inside the transaction", async () => {
      const { eventId } = seedPrint([makeLine("eps_adj_q", "agreed", 1.42)]);
      hoisted.sheetReadsInTransaction.length = 0;

      const { status } = await callAccept({ eventId, accept: ["eps_adj_q"] });

      expect(status).toBe(200);
      expect(hoisted.sheetReadsInTransaction.length).toBeGreaterThan(0);
      // A read at request start would record `false` here — and would be a
      // snapshot another writer could have overtaken before the write landed.
      expect(hoisted.sheetReadsInTransaction[0]).toBe(true);
    });

    it("409s on a rival candidate committed after a request-start snapshot would have been taken", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42),
        makeLine("revenue_q", "agreed", 5_000_000),
      ]);
      markLineAccepted(hoisted.db, printId, "eps_adj_q");
      markLineAccepted(hoisted.db, printId, "revenue_q");

      // The correction commits — clean sheet a moment ago, superseded now.
      commitRivalCandidate(printId, "eps_adj_q", 1.24);

      const { status, json } = await callAccept({ eventId, promoteHeadline: true });

      expect(status).toBe(409);
      expect(json.code).toBe("superseded");
      expect(hoisted.sheetReadsInTransaction[0]).toBe(true);
      expect(saveManualActuals).not.toHaveBeenCalled();

      const event = hoisted.db
        .prepare(`SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?`)
        .get(eventId) as { actual_value: string | null; manual_actuals_at: string | null };
      expect(event.actual_value).toBeNull();
      expect(event.manual_actuals_at).toBeNull();
    });

    it("400s on a line another writer moved to 'conflict', and rolls the accept back", async () => {
      const { eventId, printId } = seedPrint([
        makeLine("eps_adj_q", "agreed", 1.42),
        makeLine("revenue_q", "agreed", 5_000_000),
      ]);

      // The watcher reconciles a rival document in: the line is a conflict now.
      hoisted.db
        .prepare(`UPDATE print_watch_lines SET state = 'conflict' WHERE print_id = ? AND metric_id = ?`)
        .run(printId, "revenue_q");

      const { status, json } = await callAccept({
        eventId,
        accept: ["eps_adj_q", "revenue_q"],
      });

      expect(status).toBe(400);
      expect(json.error).toMatch(/revenue_q/);
      // Nothing written — the refusal is thrown inside the transaction, so the
      // eps_adj_q accept that ran before it is rolled back with it.
      const sheet = getSheet(hoisted.db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("agreed");
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).toBe("conflict");
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
