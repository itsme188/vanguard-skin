/**
 * Bogey intake 2026-11-18, amendment A2: an extracted watch line joins the
 * sheet line it names, even when that line was typed by hand (a random v4 id,
 * not the derived one). Matching is by identity (normalised label, period,
 * unit, basis), never by label alone, and an ambiguous match is left alone.
 *
 * Synthetic tickers and invented figures only: the repo is public.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  alignToExistingLines,
  existingWatchSpecsForEvent,
  watchMetricId,
} from "@/lib/earnings/watch-metrics";
import type { ExtraMetricSpec } from "@/lib/print-watch/extra-metrics";

const MANUAL_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const MANUAL_ID_2 = "5a6b7c8d-1e2f-4a3b-8c4d-9e0f1a2b3c4d";

function spec(over: Partial<ExtraMetricSpec> & { label: string }): ExtraMetricSpec {
  const base = {
    unit: "usd" as const,
    period: "Q" as const,
    basis: "na" as const,
    kind: "point" as const,
    definition: "As stated in the release.",
    consensus: null,
    whisper: null,
  };
  const merged = { ...base, ...over };
  return { id: over.id ?? watchMetricId(merged), ...merged };
}

describe("alignToExistingLines", () => {
  it("manual_uuid_line_reused: a hand-typed line with the same identity gives its id", () => {
    const existing = [spec({ id: MANUAL_ID, label: "Net new ARR" })];
    const extracted = [spec({ label: "Net New ARR", consensus: 120_000_000 })];
    const out = alignToExistingLines(extracted, existing);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(MANUAL_ID);
    expect(out[0].consensus).toBe(120_000_000);
  });

  it("matches through basis and period words in the label (normalised key)", () => {
    const existing = [spec({ id: MANUAL_ID, label: "Gross margin", unit: "pct", basis: "non_gaap" })];
    const extracted = [spec({ label: "Non-GAAP gross margin", unit: "pct", basis: "non_gaap" })];
    expect(alignToExistingLines(extracted, existing)[0].id).toBe(MANUAL_ID);
  });

  it("never matches on label alone: a different period, unit or basis keeps the extracted id", () => {
    const existing = [spec({ id: MANUAL_ID, label: "Gross margin", unit: "pct", basis: "non_gaap" })];
    const otherPeriod = spec({ label: "Gross margin", unit: "pct", basis: "non_gaap", period: "NQ_guide", kind: "range" });
    const otherUnit = spec({ label: "Gross margin", unit: "usd", basis: "non_gaap" });
    const otherBasis = spec({ label: "Gross margin", unit: "pct", basis: "gaap" });
    const out = alignToExistingLines([otherPeriod, otherUnit, otherBasis], existing);
    expect(out.map((s) => s.id)).toEqual([otherPeriod.id, otherUnit.id, otherBasis.id]);
  });

  it("ambiguous_match_left_alone: two existing lines match, the extracted id stays", () => {
    const existing = [
      spec({ id: MANUAL_ID, label: "Net new ARR" }),
      spec({ id: MANUAL_ID_2, label: "Net-new ARR" }),
    ];
    const extracted = spec({ label: "Net new ARR" });
    const out = alignToExistingLines([extracted], existing);
    expect(out[0].id).toBe(extracted.id);
  });

  it("an aligned line takes the existing line's kind so the two never conflict", () => {
    const existing = [spec({ id: MANUAL_ID, label: "Units shipped", unit: "count", kind: "range" })];
    const extracted = [spec({ label: "Units shipped", unit: "count", kind: "point" })];
    const out = alignToExistingLines(extracted, existing);
    expect(out[0]).toMatchObject({ id: MANUAL_ID, kind: "range" });
  });

  it("two extracted lines never end on one id", () => {
    const existing = [spec({ id: MANUAL_ID, label: "Net new ARR" })];
    const a = spec({ label: "Net new ARR" });
    const b = spec({ id: "6b7c8d9e-2f3a-4b4c-9d5e-0f1a2b3c4d5e", label: "Net-new ARR" });
    const out = alignToExistingLines([a, b], existing);
    expect(new Set(out.map((s) => s.id)).size).toBe(2);
    expect(out[0].id).toBe(MANUAL_ID);
  });

  it("does not modify its inputs", () => {
    const existing = [spec({ id: MANUAL_ID, label: "Net new ARR" })];
    const extracted = [spec({ label: "Net new ARR" })];
    const before = extracted[0].id;
    alignToExistingLines(extracted, existing);
    expect(extracted[0].id).toBe(before);
  });
});

describe("existingWatchSpecsForEvent", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns every row's lines once each, and skips an unreadable row", () => {
    db.prepare(
      `INSERT INTO calendar_events (id, event_date, event_type, title, symbol, source, source_key)
       VALUES (1, '2026-11-20', 'earnings', 'ACME Q3', 'ACME', 'manual', 'manual:ACME:1')`,
    ).run();
    const line = spec({ id: MANUAL_ID, label: "Net new ARR" });
    const ins = db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (1, ?, ?, ?)`,
    );
    ins.run("manual", "a", JSON.stringify([line]));
    ins.run("pdf_upload", "b", JSON.stringify([line, spec({ label: "Gross margin", unit: "pct" })]));
    ins.run("newsletter", "c", "{not json");
    const out = existingWatchSpecsForEvent(db, 1);
    expect(out.map((s) => s.label)).toEqual(["Net new ARR", "Gross margin"]);
    expect(out[0].id).toBe(MANUAL_ID);
    expect(existingWatchSpecsForEvent(db, 999)).toEqual([]);
  });
});
