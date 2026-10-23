/**
 * Pre-print bogey snapshot (Task 7, spec R6/R15): which rows count, how each
 * field becomes a typed figure, and the public-safe provenance. Synthetic data
 * on the migrated in-memory schema.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { bogeyRowKind, buildBogeySnapshot, ROW_KIND_RANK } from "@/lib/filing-summary/bogey-snapshot";
import { BOGEY_SOURCE_RANK_SQL } from "@/lib/print-watch/contracts";
import { DEEP_READ_BOGEY_LABEL } from "@/lib/earnings/bogey-claim";
import type { EarningsBogey } from "@/lib/queries/earnings-bogeys";
import type { BogeySnapshotFigure } from "@/lib/filing-summary/types";

const X1 = "11111111-1111-4111-8111-111111111111";
const X2 = "22222222-2222-4222-8222-222222222222";
const X3 = "33333333-3333-4333-8333-333333333333";

let db: Database.Database;
let sourceId: number;

function seedEvent(eventTime: string | null, date = "2026-10-22"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol)
         VALUES ('finnhub','earnings',?,?,'ZZZT earnings',?, 'ZZZT')`,
      )
      .run(date, eventTime, `k-${Math.random()}`).lastInsertRowid,
  );
}

function seedArticle(receivedAtUtc: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text)
         VALUES (?, ?, 'Preview', 'desk@example.com', 'text')`,
      )
      .run(sourceId, receivedAtUtc).lastInsertRowid,
  );
}

interface RowOpts {
  source: "pdf_upload" | "manual" | "newsletter" | "finnhub";
  label?: string | null;
  articleId?: number | null;
  uploadedAt?: string;
  epsConsensus?: number | null;
  epsWhisper?: number | null;
  revConsensus?: number | null;
  revWhisper?: number | null;
  epsVendor?: number | null;
  notes?: string | null;
  guidanceNotes?: string | null;
  extra?: unknown[] | null;
}

function seedBogey(eventId: number, o: RowOpts): number {
  return Number(
    db
      .prepare(
        `INSERT INTO earnings_bogeys (event_id, source, source_label, research_article_id, uploaded_at,
           eps_consensus, eps_whisper, revenue_consensus_usd, revenue_whisper_usd, eps_consensus_vendor,
           notes, guidance_notes, extra_metrics_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId, o.source, o.label ?? null, o.articleId ?? null, o.uploadedAt ?? "2026-10-21 15:00:00",
        o.epsConsensus ?? null, o.epsWhisper ?? null, o.revConsensus ?? null, o.revWhisper ?? null, o.epsVendor ?? null,
        o.notes ?? null, o.guidanceNotes ?? null, o.extra ? JSON.stringify(o.extra) : null,
      ).lastInsertRowid,
  );
}

const byKey = (figs: BogeySnapshotFigure[], key: string) => figs.find((f) => f.key === key);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sourceId = Number(
    db.prepare(`INSERT INTO research_sources (name) VALUES ('Synthetic Weekly')`).run().lastInsertRowid,
  );
});

describe("buildBogeySnapshot — pre-print floor", () => {
  it("excludes a newsletter that arrived 16:30 ET on an AMC print day and keeps one from 09:00 ET", () => {
    const ev = seedEvent("AMC");
    const late = seedBogey(ev, { source: "newsletter", label: "Late Letter", articleId: seedArticle("2026-10-22 20:30:00"), revConsensus: 51_000_000_000 });
    const early = seedBogey(ev, { source: "newsletter", label: "Early Letter", articleId: seedArticle("2026-10-22 13:00:00"), revConsensus: 50_000_000_000 });
    const figs = buildBogeySnapshot(db, ev);
    expect(figs.some((f) => f.key.startsWith(`b${late}.`))).toBe(false);
    const kept = byKey(figs, `b${early}.revenue_consensus_usd`);
    expect(kept?.value).toBe(50_000_000_000);
    expect(kept?.provenance).toBe("Early Letter");
    expect(kept?.rowKind).toBe("newsletter");
    expect(kept?.asOf).toBe("2026-10-22");
  });

  it("uses the 07:00 ET floor for a before-open print", () => {
    const ev = seedEvent("BMO");
    const late = seedBogey(ev, { source: "newsletter", label: "A", articleId: seedArticle("2026-10-22 12:00:00"), epsConsensus: 1.5 });
    const early = seedBogey(ev, { source: "newsletter", label: "B", articleId: seedArticle("2026-10-22 10:30:00"), epsConsensus: 1.4 });
    const keys = buildBogeySnapshot(db, ev).map((f) => f.key);
    expect(keys).toContain(`b${early}.eps_consensus`);
    expect(keys.some((k) => k.startsWith(`b${late}.`))).toBe(false);
  });

  it("judges a row with no article by uploaded_at, and always keeps a vendor row", () => {
    const ev = seedEvent("AMC");
    const lateManual = seedBogey(ev, { source: "manual", uploadedAt: "2026-10-22 20:05:00", epsConsensus: 2 });
    const vendor = seedBogey(ev, { source: "finnhub", label: "finnhub", uploadedAt: "2026-10-22 23:00:00", epsVendor: 1.23 });
    const figs = buildBogeySnapshot(db, ev);
    expect(figs.some((f) => f.key.startsWith(`b${lateManual}.`))).toBe(false);
    const v = byKey(figs, `b${vendor}.eps_consensus_vendor`);
    expect(v).toBeDefined();
    expect(v?.basis).toBe("unknown");
    expect(v?.unit).toBe("usd_per_share");
    expect(v?.provenance).toBe("Finnhub consensus");
    expect(v?.rowKind).toBe("vendor");
  });

  it("dates asOf on the Eastern day, not the UTC day", () => {
    const ev = seedEvent("AMC");
    // 01:30 UTC on the 22nd is 21:30 Eastern on the 21st.
    const id = seedBogey(ev, { source: "newsletter", label: "Night", articleId: seedArticle("2026-10-22 01:30:00"), epsConsensus: 1 });
    expect(byKey(buildBogeySnapshot(db, ev), `b${id}.eps_consensus`)?.asOf).toBe("2026-10-21");
  });
});

describe("buildBogeySnapshot — figures and provenance", () => {
  it("names a manual row 'your manual entry' whatever its source_label says", () => {
    const ev = seedEvent("AMC");
    const id = seedBogey(ev, { source: "manual", label: "CANARY-LABEL", epsConsensus: 2.1, notes: "CANARY-NOTES-7731" });
    const figs = buildBogeySnapshot(db, ev);
    const f = byKey(figs, `b${id}.eps_consensus`);
    expect(f?.provenance).toBe("your manual entry");
    expect(f?.rowKind).toBe("manual");
    expect(JSON.stringify(figs)).not.toMatch(/CANARY/);
  });

  it("names an upload 'uploaded PDF' and a deep read by its stored label", () => {
    const ev = seedEvent("AMC");
    const up = seedBogey(ev, { source: "pdf_upload", label: "sheet.pdf", epsWhisper: 2.2 });
    const deep = seedBogey(ev, { source: "newsletter", label: "Deep read", articleId: seedArticle("2026-10-22 14:00:00"), revWhisper: 52_000_000_000 });
    const figs = buildBogeySnapshot(db, ev);
    expect(byKey(figs, `b${up}.eps_whisper`)).toMatchObject({ provenance: "uploaded PDF", rowKind: "upload", basis: "unknown" });
    expect(byKey(figs, `b${deep}.revenue_whisper_usd`)).toMatchObject({ provenance: "Deep read", rowKind: "deep_read", basis: "reported", unit: "usd" });
  });

  it("types every consensus and whisper field for this print's quarter", () => {
    const ev = seedEvent("AMC");
    const id = seedBogey(ev, { source: "manual", epsConsensus: 7.1, epsWhisper: 7.3, revConsensus: 50e9, revWhisper: 51e9 });
    const figs = buildBogeySnapshot(db, ev);
    expect(figs.map((f) => f.key)).toEqual([
      `b${id}.eps_consensus`, `b${id}.eps_whisper`, `b${id}.revenue_consensus_usd`, `b${id}.revenue_whisper_usd`,
    ]);
    for (const f of figs) {
      expect(f.scale).toBe("units");
      expect(f.period).toEqual({
        kind: "quarter", role: "actual", anchor: "reported_quarter",
        endDate: null, fiscalYear: null, fiscalQuarter: null, label: "this print's quarter",
      });
    }
    expect(byKey(figs, `b${id}.eps_consensus`)).toMatchObject({ unit: "usd_per_share", basis: "unknown" });
    expect(byKey(figs, `b${id}.revenue_consensus_usd`)).toMatchObject({ unit: "usd", basis: "reported" });
  });

  it("turns extra metric lines into figures with their own period and basis, label only", () => {
    const ev = seedEvent("AMC");
    const id = seedBogey(ev, {
      source: "manual",
      extra: [
        { id: X1, label: "Family DAP", definition: "SECRET-DEFINITION", unit: "count", kind: "point", period: "Q", basis: "na", consensus: 3.6e9, whisper: null },
        { id: X2, label: "Capex", definition: "d", unit: "usd", kind: "range", period: "FY_guide", basis: "gaap", consensus: "70B", whisper: "72B" },
        { id: X3, label: "Op margin", definition: "d", unit: "pct", kind: "point", period: "NQ_guide", basis: "non_gaap", consensus: 40, whisper: null },
      ],
    });
    const figs = buildBogeySnapshot(db, ev);
    expect(JSON.stringify(figs)).not.toMatch(/SECRET-DEFINITION/);
    expect(byKey(figs, `b${id}.x.${X1}`)).toMatchObject({
      label: "Family DAP", value: 3.6e9, unit: "count", basis: "unknown",
      period: { kind: "quarter", role: "actual", anchor: "reported_quarter" },
    });
    expect(byKey(figs, `b${id}.x.${X2}`)).toMatchObject({
      label: "Capex", value: 70e9, unit: "usd", basis: "reported",
      period: { kind: "fiscal_year", role: "outlook", anchor: "fiscal_year" },
    });
    expect(byKey(figs, `b${id}.x.${X2}.whisper`)).toMatchObject({ label: "Capex (whisper)", value: 72e9 });
    expect(byKey(figs, `b${id}.x.${X3}`)).toMatchObject({
      unit: "percent", basis: "non_gaap",
      period: { kind: "quarter", role: "outlook", anchor: "next_quarter" },
    });
  });

  it("returns figures in row-id order and nothing for an unknown event", () => {
    const ev = seedEvent("AMC");
    const a = seedBogey(ev, { source: "newsletter", label: "Older", articleId: seedArticle("2026-10-20 13:00:00"), epsConsensus: 1 });
    const b = seedBogey(ev, { source: "newsletter", label: "Newer", articleId: seedArticle("2026-10-22 13:00:00"), epsConsensus: 2 });
    expect(buildBogeySnapshot(db, ev).map((f) => f.key)).toEqual([`b${a}.eps_consensus`, `b${b}.eps_consensus`]);
    expect(buildBogeySnapshot(db, 999_999)).toEqual([]);
  });
});

describe("bogeyRowKind parity with BOGEY_SOURCE_RANK_SQL (final review minor)", () => {
  it("the SQL CASE and the TypeScript kind put every source in the same rank; an unknown source is 'other source'", () => {
    // An unknown source is cast in: the stored column is free text even though the type lists the known ones.
    const rows = [
      { source: "manual", source_label: "my note" },
      { source: "pdf_upload", source_label: "file.pdf" },
      { source: "newsletter", source_label: DEEP_READ_BOGEY_LABEL },
      { source: "newsletter", source_label: "Some Newsletter" },
      { source: "newsletter", source_label: null },
      { source: "finnhub", source_label: "finnhub" },
      { source: "mystery_feed", source_label: "x" },
    ] as Array<Pick<EarningsBogey, "source" | "source_label">>;
    const mem = new Database(":memory:");
    for (const r of rows) {
      const { rank } = mem
        .prepare(`SELECT ${BOGEY_SOURCE_RANK_SQL} AS rank FROM (SELECT ? AS source, ? AS source_label)`)
        .get(DEEP_READ_BOGEY_LABEL, r.source, r.source_label) as { rank: number };
      expect(ROW_KIND_RANK[bogeyRowKind(r)], `${r.source}/${r.source_label}`).toBe(rank);
    }
    expect(rows.map((r) => bogeyRowKind(r))).toEqual([
      "manual", "upload", "deep_read", "newsletter", "newsletter", "vendor", "other",
    ]);
  });
});
