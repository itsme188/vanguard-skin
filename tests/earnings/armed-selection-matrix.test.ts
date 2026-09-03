/**
 * Spec §4.1 consumer matrix (live print v2, slice A, Task 4): every
 * selection consumer switches its row-level `held || watchlist` gate to
 * membership in `coveredForEvents`' set (held/watchlist family-aware OR the
 * event itself is armed). One `it` per consumer — an armed-only, unheld,
 * unwatched name's event is selected; an in-window sibling event for the
 * SAME symbol that is NOT armed is not (armed is an event fact, not a
 * symbol fact — a leaked symbol-level "armed" eligibility would select the
 * sibling too and fail these).
 *
 * Push gates and the read-through-target check that feeds them are
 * deliberately EXCLUDED from this rewiring (regression coverage lives in
 * tests/calendar/enrichment-runner.test.ts, tests/calendar/cloud-reconcile.test.ts,
 * and tests/alerts/read-through-push.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import { renderBogeysReminderLine } from "@/lib/earnings/bogeys-reminder";
import { findDateVerificationCandidates } from "@/lib/calendar/verify-earnings-dates";
import { findProbeCandidates } from "@/lib/calendar/wire-probe";
import { getExpectedRecapCluster } from "@/lib/earnings/wrap";
import { findDebriefCandidates } from "@/lib/earnings/debrief";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { __getUpcomingReportersForTests } from "@/lib/earnings/extract-newsletter-bogeys";
import { mondayOf } from "@/lib/calendar/date-utils";

vi.mock("@/lib/ai/generate", () => ({ generateTextForFeature: vi.fn(), AIRefusalError: class extends Error {} }));
vi.mock("@/lib/ai/models", () => ({ resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })) }));

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

/** An UNHELD, UNWATCHED name with two events: `armed` (today AMC) and `sibling` (next quarter).
 * `week_of` is set too — getExpectedRecapCluster's query (getEarningsForWeekDeduped)
 * pre-filters on it, not on event_date. */
function seedPair(): { armed: number; sibling: number } {
  const ins = db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol, actual_value, enriched_at, week_of)
     VALUES ('manual','earnings',?,?,?,'ACME','k'||?,'ACME',?,?,?)`,
  );
  const armed = Number(
    ins.run("2026-09-02", "AMC", "16:15", "a", null, null, mondayOf("2026-09-02")).lastInsertRowid,
  );
  // [C-17] The sibling sits INSIDE every consumer's SQL-level pre-filter for
  // at least one consumer (it does vary by window; the point of each `it` is
  // that the row selected is armed-only-by-EVENT, never by symbol) so a
  // consumer that leaked symbol-level "armed" eligibility would select it
  // and fail.
  const sibling = Number(
    ins.run("2026-09-08", "AMC", "16:15", "b", null, null, mondayOf("2026-09-08")).lastInsertRowid,
  );
  armWorksheet(db, armed);
  return { armed, sibling };
}

/** Insert + arm a standalone earnings event for `symbol` on `eventDate`,
 * unheld and unwatched. Used to clear renderBogeysReminderLine's
 * MIN_REPORTERS floor without changing what the assertion is testing
 * (coverage of an armed-only name). */
function seedArmedOnly(symbol: string, eventDate: string): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol)
         VALUES ('manual','earnings',?,'AMC','16:15',?,?,?)`,
      )
      .run(eventDate, symbol, `k:${symbol}`, symbol).lastInsertRowid,
  );
  armWorksheet(db, id);
  return id;
}

const NOW = new Date("2026-09-02T18:30:00Z"); // 14:30 ET — 105 min before a 16:15 print

describe("spec §4.1 consumer matrix — armed-only event is selected; its sibling is not", () => {
  it("findEmailCandidates (preview)", () => {
    const { armed, sibling } = seedPair();
    const ids = findEmailCandidates(db, { now: NOW }).map((c) => c.eventId);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("getUpcomingReporters (newsletter bogey scan)", () => {
    const { armed, sibling } = seedPair();
    const ids = __getUpcomingReportersForTests(db, { today: "2026-09-02" }).map((r) => r.event_id);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("renderBogeysReminderLine", () => {
    seedPair();
    // MIN_REPORTERS=3: clear the floor with two more armed-only names inside
    // the [2026-08-31, 2026-09-04] window without touching what's asserted —
    // ACME's armed-only event still has to clear the coverage filter itself.
    seedArmedOnly("BETA", "2026-09-01");
    seedArmedOnly("GAMMA", "2026-09-03");
    const line = renderBogeysReminderLine(db, "2026-08-31");
    expect(line).toMatch(/ACME/);
  });

  it("findDateVerificationCandidates skips manual rows by design but keeps an armed vendor row", () => {
    const { armed, sibling } = seedPair();
    db.prepare(`UPDATE calendar_events SET source = 'finnhub' WHERE id = ?`).run(armed);
    const ids = findDateVerificationCandidates(db, { now: NOW }).map((r) => r.id);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("findProbeCandidates", () => {
    const { armed, sibling } = seedPair();
    const t = new Date("2026-09-02T19:30:00Z"); // 15:30 ET, inside (release-90m, release)
    const ids = findProbeCandidates(db, t).map((r) => r.id);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("getExpectedRecapCluster", () => {
    const { armed, sibling } = seedPair();
    const ids = getExpectedRecapCluster(db, "2026-09-02", "AMC").map((m) => m.eventId);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("findDebriefCandidates", () => {
    const { armed, sibling } = seedPair();
    db.prepare(`UPDATE calendar_events SET actual_value = 'EPS 0.62', enriched_at = '2026-09-02 22:00:00' WHERE id = ?`).run(
      armed,
    );
    const out = findDebriefCandidates(db, { now: new Date("2026-09-03T11:00:00Z") });
    const ids = out.unsent.map((c) => c.eventId);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("buildCockpitPayload keeps the armed row and not the in-window sibling", () => {
    const { armed, sibling } = seedPair();
    const payload = buildCockpitPayload(db, NOW);
    const ids = [
      ...payload.lanes.bmo,
      ...payload.lanes.amc,
      ...payload.lanes.unknown,
      ...payload.carryover,
    ].map((r) => r.eventId);
    expect(ids).toContain(armed);
    expect(ids).not.toContain(sibling);
  });
});
