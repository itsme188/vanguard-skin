import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { compileContracts } from "@/lib/print-watch/contracts";

function insertCalendarEvent(db: Database.Database, sourceKey: string, eventDate = "2026-08-20"): number {
  const result = db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key)
       VALUES ('finnhub', 'earnings', ?, 'ACME earnings', ?)`,
    )
    .run(eventDate, sourceKey);
  return Number(result.lastInsertRowid);
}

interface BogeyInput {
  source?: "pdf_upload" | "manual" | "newsletter";
  source_label?: string | null;
  eps_consensus?: number | null;
  eps_whisper?: number | null;
  revenue_consensus_usd?: number | null;
  revenue_whisper_usd?: number | null;
  segment_breakdown_json?: string | null;
  guidance_notes?: string | null;
  extra_metrics_json?: string | null;
}

function insertBogey(db: Database.Database, eventId: number, input: BogeyInput = {}): number {
  const result = db
    .prepare(
      `INSERT INTO earnings_bogeys
         (event_id, source, source_label, eps_consensus, eps_whisper,
          revenue_consensus_usd, revenue_whisper_usd, segment_breakdown_json, guidance_notes,
          extra_metrics_json)
       VALUES (@event_id, @source, @source_label, @eps_consensus, @eps_whisper,
               @revenue_consensus_usd, @revenue_whisper_usd, @segment_breakdown_json, @guidance_notes,
               @extra_metrics_json)`,
    )
    .run({
      event_id: eventId,
      source: input.source ?? "manual",
      source_label: input.source_label ?? null,
      eps_consensus: input.eps_consensus ?? null,
      eps_whisper: input.eps_whisper ?? null,
      revenue_consensus_usd: input.revenue_consensus_usd ?? null,
      revenue_whisper_usd: input.revenue_whisper_usd ?? null,
      segment_breakdown_json: input.segment_breakdown_json ?? null,
      guidance_notes: input.guidance_notes ?? null,
      extra_metrics_json: input.extra_metrics_json ?? null,
    });
  return Number(result.lastInsertRowid);
}

/** Leak guard (task-2 brief Step 1): definitions never carry a value or a
 *  disclosure hint — enforced mechanically as "no run of >4 digits". */
function assertNoDigitLeak(contracts: { definition: string }[]): void {
  for (const c of contracts) {
    expect(c.definition).not.toMatch(/\d{5,}/);
  }
}

describe("compileContracts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("always emits the standard three contracts, even with zero bogey rows", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const { contracts, expected } = compileContracts(db, eventId, "ACME");

    const ids = contracts.map((c) => c.metric_id);
    expect(ids).toContain("eps_gaap_q");
    expect(ids).toContain("eps_adj_q");
    expect(ids).toContain("revenue_q");
    expect(expected).toEqual({});

    const gaap = contracts.find((c) => c.metric_id === "eps_gaap_q")!;
    expect(gaap.basis).toBe("gaap");
    expect(gaap.period).toBe("Q");
    expect(gaap.unit).toBe("per_share");
    expect(gaap.kind).toBe("point");
    expect(gaap.segment).toBeNull();

    const adj = contracts.find((c) => c.metric_id === "eps_adj_q")!;
    expect(adj.basis).toBe("non_gaap");

    const rev = contracts.find((c) => c.metric_id === "revenue_q")!;
    expect(rev.unit).toBe("usd");

    assertNoDigitLeak(contracts);
  });

  it("never attaches an expected value to eps_gaap_q (bogeys are adjusted-basis by convention)", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, { eps_consensus: 1.5, revenue_consensus_usd: 5_000_000_000 });

    const { expected } = compileContracts(db, eventId, "ACME");
    expect(expected["eps_gaap_q"]).toBeUndefined();
  });

  it("maps eps_adj_q and revenue_q expected values from consensus/whisper, with source_label carried through", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, {
      source_label: "TMT Breakout",
      eps_consensus: 1.42,
      eps_whisper: 1.5,
      revenue_consensus_usd: 5_123_000_000,
      revenue_whisper_usd: 5_200_000_000,
    });

    const { expected } = compileContracts(db, eventId, "ACME");

    expect(expected["eps_adj_q"]).toEqual({
      value: 1.42,
      value_high: null,
      whisper: 1.5,
      source_label: "TMT Breakout",
    });
    expect(expected["revenue_q"]).toEqual({
      value: 5_123_000_000,
      value_high: null,
      whisper: 5_200_000_000,
      source_label: "TMT Breakout",
    });
  });

  it("dedupes across multiple bogey rows: first non-null by rowid wins, per field independently", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    // Row 1 (earlier rowid): no EPS consensus, but a revenue consensus.
    insertBogey(db, eventId, {
      source: "pdf_upload",
      source_label: "PDF preview",
      eps_consensus: null,
      revenue_consensus_usd: 5_000_000_000,
    });
    // Row 2 (later rowid): EPS consensus present, and a DIFFERENT (should be
    // ignored) revenue consensus.
    insertBogey(db, eventId, {
      source: "manual",
      source_label: "manual note",
      eps_consensus: 1.6,
      revenue_consensus_usd: 9_999_000_000,
    });

    const { expected } = compileContracts(db, eventId, "ACME");

    // eps_adj_q: row 1 had null, so row 2's value wins.
    expect(expected["eps_adj_q"].value).toBe(1.6);
    expect(expected["eps_adj_q"].source_label).toBe("manual note");

    // revenue_q: row 1 already had a non-null value, so it wins over row 2.
    expect(expected["revenue_q"].value).toBe(5_000_000_000);
    expect(expected["revenue_q"].source_label).toBe("PDF preview");
  });

  it("emits one seg_<slug>_revenue_q contract per segment key, with expected from that segment's consensus/whisper", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, {
      source_label: "segments source",
      segment_breakdown_json: JSON.stringify({
        "Data Center": { consensus: 3_000_000_000, whisper: 3_100_000_000 },
        "Gaming & AI": { consensus: 1_500_000_000 },
      }),
    });

    const { contracts, expected } = compileContracts(db, eventId, "ACME");

    const dc = contracts.find((c) => c.metric_id === "seg_data_center_revenue_q");
    expect(dc).toBeDefined();
    expect(dc?.segment).toBe("Data Center");
    expect(dc?.period).toBe("Q");
    expect(dc?.unit).toBe("usd");
    expect(expected["seg_data_center_revenue_q"]).toEqual({
      value: 3_000_000_000,
      value_high: null,
      whisper: 3_100_000_000,
      source_label: "segments source",
    });

    const gaming = contracts.find((c) => c.metric_id === "seg_gaming_ai_revenue_q");
    expect(gaming).toBeDefined();
    expect(gaming?.segment).toBe("Gaming & AI");
    expect(expected["seg_gaming_ai_revenue_q"]).toEqual({
      value: 1_500_000_000,
      value_high: null,
      whisper: null,
      source_label: "segments source",
    });

    assertNoDigitLeak(contracts);
  });

  it("merges segment splits across multiple bogey rows, first non-null per segment field wins", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, {
      source: "pdf_upload",
      source_label: "first upload",
      segment_breakdown_json: JSON.stringify({
        Network: { consensus: null, whisper: 800_000_000 },
      }),
    });
    insertBogey(db, eventId, {
      source: "manual",
      source_label: "second upload",
      segment_breakdown_json: JSON.stringify({
        Network: { consensus: 750_000_000, whisper: 900_000_000 },
      }),
    });

    const { contracts, expected } = compileContracts(db, eventId, "ACME");

    const networkContracts = contracts.filter((c) => c.metric_id === "seg_network_revenue_q");
    expect(networkContracts).toHaveLength(1); // no duplicate contract across rows

    // consensus was null in row 1 -> row 2's value wins; whisper was present
    // in row 1 -> row 1's value wins (never overwritten by row 2).
    // source_label tracks the CONSENSUS field's contributing row (the
    // headline number) when consensus is non-null.
    expect(expected["seg_network_revenue_q"]).toEqual({
      value: 750_000_000,
      value_high: null,
      whisper: 800_000_000,
      source_label: "second upload",
    });
  });

  it("emits revenue_guide_next + eps_adj_guide_next only when a bogey row carries guidance_notes, with no expected entries (no numeric guidance consensus in the schema)", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, { eps_consensus: 1.4 }); // no guidance yet

    let { contracts } = compileContracts(db, eventId, "ACME");
    expect(contracts.map((c) => c.metric_id)).not.toContain("revenue_guide_next");
    expect(contracts.map((c) => c.metric_id)).not.toContain("eps_adj_guide_next");

    insertBogey(db, eventId, {
      source: "pdf_upload",
      source_label: "guide row",
      guidance_notes: "FY26 guide $19.5-20.0B revenue, 24-25% op margin",
    });

    const compiled = compileContracts(db, eventId, "ACME");
    contracts = compiled.contracts;
    const revGuide = contracts.find((c) => c.metric_id === "revenue_guide_next");
    const epsGuide = contracts.find((c) => c.metric_id === "eps_adj_guide_next");
    expect(revGuide).toBeDefined();
    expect(revGuide?.period).toBe("NQ_guide");
    expect(revGuide?.kind).toBe("range");
    expect(revGuide?.definition.toLowerCase()).toContain("updated range");
    expect(epsGuide).toBeDefined();
    expect(epsGuide?.period).toBe("NQ_guide");
    expect(epsGuide?.kind).toBe("range");
    expect(epsGuide?.basis).toBe("non_gaap");

    // Guidance is free text in this schema — never numerically mapped.
    expect(compiled.expected["revenue_guide_next"]).toBeUndefined();
    expect(compiled.expected["eps_adj_guide_next"]).toBeUndefined();

    // The free-text guidance_notes content must never leak into a
    // definition — no digit run >4 anywhere, even though the raw notes
    // string above contains "19.5-20.0" / "24-25%".
    assertNoDigitLeak(contracts);
    for (const c of contracts) {
      expect(c.definition).not.toContain("19.5");
      expect(c.definition).not.toContain("20.0");
    }
  });

  it("leak guard: no expected value ever appears serialized inside any contract definition, across a fully-populated event", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, {
      source_label: "full sheet",
      eps_consensus: 1.42,
      eps_whisper: 1.5,
      revenue_consensus_usd: 5_123_456_000,
      revenue_whisper_usd: 5_200_000_000,
      segment_breakdown_json: JSON.stringify({
        "Data Center": { consensus: 3_012_345_000, whisper: 3_100_000_000 },
      }),
      guidance_notes: "FY26 guide $19.5-20.0B revenue",
    });

    const { contracts } = compileContracts(db, eventId, "ACME");
    assertNoDigitLeak(contracts);
  });
});

describe("compileContracts — desk-defined extra metric lines (spec §4.7)", () => {
  let db: Database.Database;

  const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
  const B = "0c9e2d71-4a5b-4c6d-9e8f-1a2b3c4d5e6f";

  const metric = (o: Record<string, unknown> = {}) => ({
    id: A,
    label: "Net new ARR",
    definition: "Sequential change in ARR.",
    unit: "usd",
    kind: "point",
    period: "Q",
    basis: "na",
    ...o,
  });

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("emits one x_<uuid>_<period> line per merged id, with the mapped unit and the merged numbers", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, {
      source_label: "Sheet A",
      extra_metrics_json: JSON.stringify([metric({ whisper: 310_000_000 })]),
    });
    insertBogey(db, eventId, {
      source_label: "Sheet B",
      extra_metrics_json: JSON.stringify([metric({ consensus: 300_000_000 })]),
    });

    const { contracts, expected, conflicts } = compileContracts(db, eventId, "ACME");
    expect(conflicts).toEqual([]);
    const line = contracts.find((c) => c.metric_id === `x_${A}_Q`);
    expect(line).toEqual({
      metric_id: `x_${A}_Q`,
      label: "Net new ARR",
      definition: "Sequential change in ARR.",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: null,
    });
    expect(expected[`x_${A}_Q`]).toEqual({
      value: 300_000_000,
      value_high: null,
      whisper: 310_000_000,
      source_label: "Sheet B",
    });
  });

  it("maps pct to the contract unit percent and carries kind range through", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, {
      source_label: "A",
      extra_metrics_json: JSON.stringify([
        metric({
          id: B,
          unit: "pct",
          kind: "range",
          period: "FY_guide",
          basis: "non_gaap",
          label: "FY op margin",
        }),
      ]),
    });

    const { contracts } = compileContracts(db, eventId, "ACME");
    expect(contracts.find((c) => c.metric_id === `x_${B}_FY_guide`)).toMatchObject({
      unit: "percent",
      kind: "range",
      period: "FY_guide",
      basis: "non_gaap",
      currency: "USD",
      segment: null,
    });
  });

  it("does NOT compile a conflicting id and reports it in the new conflicts key", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, {
      source_label: "A",
      extra_metrics_json: JSON.stringify([metric()]),
    });
    insertBogey(db, eventId, {
      source_label: "B",
      extra_metrics_json: JSON.stringify([metric({ unit: "pct" })]),
    });

    const { contracts, expected, conflicts } = compileContracts(db, eventId, "ACME");
    expect(conflicts).toEqual([{ id: A, fields: ["unit"] }]);
    expect(contracts.some((c) => c.metric_id.startsWith("x_"))).toBe(false);
    expect(expected[`x_${A}_Q`]).toBeUndefined();
  });

  it("ignores an unreadable extra_metrics_json without losing the rest of the sheet", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const bogeyId = insertBogey(db, eventId, { source_label: "A", eps_consensus: 1.23 });
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = '{not json' WHERE id = ?`).run(bogeyId);

    const { contracts, expected, conflicts } = compileContracts(db, eventId, "ACME");
    expect(conflicts).toEqual([]);
    expect(contracts.map((c) => c.metric_id)).toEqual(["eps_gaap_q", "eps_adj_q", "revenue_q"]);
    expect(expected["eps_adj_q"]).toMatchObject({ value: 1.23 });
  });

  it("is byte-identical to the pre-slice-F output when no row carries extra metrics", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    insertBogey(db, eventId, { source_label: "A", eps_consensus: 0.46 });

    const out = compileContracts(db, eventId, "ACME");
    expect(out.conflicts).toEqual([]);
    expect(out.contracts.map((c) => c.metric_id)).toEqual(["eps_gaap_q", "eps_adj_q", "revenue_q"]);
  });
});
