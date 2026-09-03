/**
 * Spec §4.1 consumer matrix (live print v2, slice A, Task 4; fix round 1
 * item 2): every selection consumer switches its row-level `held ||
 * watchlist` gate to membership in `coveredForEvents`' set (held/watchlist
 * family-aware OR the event's ARMED CLUSTER — the event itself, or any
 * unsuperseded same-symbol/same-event_date earnings row, carries a
 * worksheet flag; R11). One `it` per consumer — an armed event is
 * selected; a GENUINELY IN-WINDOW unarmed control is not, proving the row
 * keys on the covered EVENT SET and not on some leaked symbol-level or
 * batch-level "armed" fact.
 *
 * Each control is built to actually clear that consumer's own SQL/JS
 * pre-filter (date range, release-time delta, dedup, etc.) so it reaches
 * the coverage decision rather than being excluded for an unrelated
 * reason (a control that never reaches the coverage check can't prove
 * anything about it). Where a consumer's window spans more than one day,
 * the control is the SAME symbol on a DIFFERENT in-window date. Where the
 * window is effectively a single day/instant, the control is a DIFFERENT
 * symbol on the SAME date/time as the armed row — R11 means a same-date
 * SAME-symbol twin of an armed event is now genuinely covered (it's the
 * exact dedupe-twin scenario R11 exists for), so that shape can no longer
 * serve as a negative control; two of the consumers below additionally
 * DEDUPE same-(symbol, event_date) rows before coverage ever runs, which
 * would collapse a same-symbol twin into a single surviving row regardless
 * of arming.
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

/** General earnings-event seeder. `tag` keeps source_key unique across
 * rows that intentionally share (symbol, event_date). */
function seedEvent(opts: {
  symbol: string;
  date: string;
  tag: string;
  eventTime?: string | null;
  releaseTime?: string | null;
  actualValue?: string | null;
  enrichedAt?: string | null;
  weekOf?: string | null;
}): number {
  const r = db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol, actual_value, enriched_at, week_of)
       VALUES ('manual','earnings',?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      opts.date,
      opts.eventTime ?? null,
      opts.releaseTime ?? null,
      opts.symbol,
      `k:${opts.symbol}:${opts.date}:${opts.tag}`,
      opts.symbol,
      opts.actualValue ?? null,
      opts.enrichedAt ?? null,
      opts.weekOf ?? null,
    );
  return Number(r.lastInsertRowid);
}

/** ACME with two events: `armed` (2026-09-02 AMC) and `sibling`
 * (2026-09-08, a genuinely different quarter). Used only by the two
 * consumers below (getUpcomingReporters' 14-day horizon,
 * findDateVerificationCandidates' 7-day horizon) whose own window already
 * spans that far, so the far date is itself a real in-window control for
 * them — no bespoke fixture needed. */
function seedPair(): { armed: number; sibling: number } {
  const armed = seedEvent({ symbol: "ACME", date: "2026-09-02", eventTime: "AMC", releaseTime: "16:15", tag: "a" });
  const sibling = seedEvent({ symbol: "ACME", date: "2026-09-08", eventTime: "AMC", releaseTime: "16:15", tag: "b" });
  armWorksheet(db, armed);
  return { armed, sibling };
}

const NOW = new Date("2026-09-02T18:30:00Z"); // 14:30 ET — 105 min before a 16:15 print

describe("spec §4.1 consumer matrix — armed event is selected; an in-window unarmed control is not", () => {
  it("findEmailCandidates (preview)", () => {
    const armed = seedEvent({ symbol: "ACME", date: "2026-09-02", eventTime: "AMC", releaseTime: "16:15", tag: "armed" });
    armWorksheet(db, armed);
    // Same date + release_time as the armed row — clears the SQL
    // [today,tomorrow] date range AND the [105,135]min release-delta
    // filter identically. A DIFFERENT symbol so R11's same-date cluster
    // rule (which now legitimately covers a same-symbol twin) can't apply.
    const control = seedEvent({ symbol: "BETA", date: "2026-09-02", eventTime: "AMC", releaseTime: "16:15", tag: "control" });

    const ids = findEmailCandidates(db, { now: NOW }).map((c) => c.eventId);
    expect(ids).toContain(armed);
    expect(ids).not.toContain(control);
  });

  it("getUpcomingReporters (newsletter bogey scan)", () => {
    const { armed, sibling } = seedPair();
    const ids = __getUpcomingReportersForTests(db, { today: "2026-09-02" }).map((r) => r.event_id);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("renderBogeysReminderLine", () => {
    const weekOf = "2026-08-31"; // window is [2026-08-31, 2026-09-04]
    const armed = seedEvent({ symbol: "ACME", date: "2026-09-02", tag: "armed" });
    armWorksheet(db, armed);
    // MIN_REPORTERS=3: two more armed, in-window names clear the floor.
    const beta = seedEvent({ symbol: "BETA", date: "2026-09-01", tag: "beta" });
    armWorksheet(db, beta);
    const gamma = seedEvent({ symbol: "GAMMA", date: "2026-09-03", tag: "gamma" });
    armWorksheet(db, gamma);
    // In-window, never armed — the line's output is inherently a
    // SYMBOL-level count/list (an event-level coverage bug wouldn't move
    // the number), so the meaningful control here is a distinct symbol
    // that must never appear, not a same-symbol twin.
    const control = seedEvent({ symbol: "DELTA", date: "2026-09-03", tag: "control" });

    const line = renderBogeysReminderLine(db, weekOf);
    expect(line).toMatch(/ACME/);
    expect(line).toContain("3"); // exactly ACME + BETA + GAMMA
    expect(line).not.toContain("DELTA");
    expect(control).toBeGreaterThan(0);
  });

  it("findDateVerificationCandidates skips manual rows by design but keeps an armed vendor row", () => {
    const { armed, sibling } = seedPair();
    db.prepare(`UPDATE calendar_events SET source = 'finnhub' WHERE id = ?`).run(armed);
    const ids = findDateVerificationCandidates(db, { now: NOW }).map((r) => r.id);
    expect(ids).toEqual([armed]);
    expect(ids).not.toContain(sibling);
  });

  it("findProbeCandidates", () => {
    const t = new Date("2026-09-02T19:30:00Z"); // 15:30 ET
    const armed = seedEvent({ symbol: "ACME", date: "2026-09-02", releaseTime: "16:15", tag: "armed" });
    armWorksheet(db, armed);
    // Same date + release_time (45 min before t, inside (release-90m,
    // release)) — a different, never-armed symbol; the SQL date window
    // here is only [yesterday, today], leaving no other-date room for a
    // same-symbol control that would also clear the release-delta filter.
    const control = seedEvent({ symbol: "BETA", date: "2026-09-02", releaseTime: "16:15", tag: "control" });

    const ids = findProbeCandidates(db, t).map((r) => r.id);
    expect(ids).toContain(armed);
    expect(ids).not.toContain(control);
  });

  it("getExpectedRecapCluster", () => {
    const weekOf = mondayOf("2026-09-02");
    const armed = seedEvent({ symbol: "ACME", date: "2026-09-02", eventTime: "AMC", weekOf, tag: "armed" });
    armWorksheet(db, armed);
    // getEarningsForWeekDeduped collapses same-(symbol, event_date) rows
    // to one survivor BEFORE this ever runs, and the cluster filter here
    // requires an exact event_date match — a same-symbol twin would either
    // get deduped away or excluded by date regardless of arming. Same
    // date, different symbol, same week_of.
    const control = seedEvent({ symbol: "BETA", date: "2026-09-02", eventTime: "AMC", weekOf, tag: "control" });

    const ids = getExpectedRecapCluster(db, "2026-09-02", "AMC").map((m) => m.eventId);
    expect(ids).toContain(armed);
    expect(ids).not.toContain(control);
  });

  it("findDebriefCandidates", () => {
    const now = new Date("2026-09-03T11:00:00Z");
    const armed = seedEvent({
      symbol: "ACME",
      date: "2026-09-02",
      releaseTime: "16:15",
      actualValue: "EPS 0.62",
      enrichedAt: "2026-09-02 22:00:00",
      tag: "armed",
    });
    armWorksheet(db, armed);
    // findDebriefCandidates family-dedupes by SYMBOL alone (no date in the
    // key), so a same-symbol control on any other date would collapse into
    // the armed row's family and never reach the coverage filter at all —
    // a different, never-armed symbol instead. Still inside
    // [lookbackStart, today] = [2026-08-31, 2026-09-03]. actual_value is
    // set (the base SQL requires it); no release_time, so the
    // release-recency filter never holds it back for an unrelated reason.
    const control = seedEvent({
      symbol: "BETA",
      date: "2026-09-01",
      actualValue: "EPS 0.10",
      tag: "control",
    });

    const out = findDebriefCandidates(db, { now });
    const ids = out.unsent.map((c) => c.eventId);
    expect(ids).toContain(armed);
    expect(ids).not.toContain(control);
  });

  it("buildCockpitPayload keeps the armed row and not an in-window unarmed control", () => {
    const armed = seedEvent({ symbol: "ACME", date: "2026-09-02", eventTime: "AMC", releaseTime: "16:15", tag: "armed" });
    armWorksheet(db, armed);
    // Cockpit's own dedup collapses same-(symbol, event_date) rows before
    // coverage ever runs — a different date (yesterday, still inside the
    // cockpit's [today, yesterday] window) for the SAME symbol, never
    // armed.
    const control = seedEvent({ symbol: "ACME", date: "2026-09-01", eventTime: "AMC", tag: "control" });

    const payload = buildCockpitPayload(db, NOW);
    const ids = [
      ...payload.lanes.bmo,
      ...payload.lanes.amc,
      ...payload.lanes.unknown,
      ...payload.carryover,
    ].map((r) => r.eventId);
    expect(ids).toContain(armed);
    expect(ids).not.toContain(control);
  });
});
