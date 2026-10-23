/**
 * The pre-print bogey snapshot a filing summary is judged against (spec §5,
 * Codex round 2 R6 and R15). Taken once at run start and frozen into the run,
 * so a later edit or delete of a bogey row never changes an old summary.
 *
 * Which rows count: the event's bogey rows that hold content
 * (`getBogeysWithContentForEvent`), kept only when their evidence predates the
 * print's pre-release slot floor, the same floor the armed deep read uses
 * (`AMC_FLOOR_ET` / `BMO_FLOOR_ET` composed on the event date; a print with no
 * known side takes the before-open floor, as the deep read does). A row is
 * dated by its linked article's `received_at`, else by its own `uploaded_at`.
 * Vendor (Finnhub) rows are always kept: the consensus is not a newsletter
 * written after the release.
 *
 * What a row says, and nothing more (R6): a consensus or whisper field is
 * "this print's reported quarter, actual"; per-share fields and the vendor EPS
 * consensus carry basis `unknown` (no row says GAAP or adjusted today), revenue
 * fields basis `reported`. Extra metric lines carry their own coarse period and
 * basis.
 *
 * Privacy (R15): only figures, the line LABEL, a public-safe provenance and the
 * Eastern date leave this module. Never `notes`, `guidance_notes`, an extra
 * line's definition, a manual or upload row's own `source_label`, or anything
 * from a portfolio table.
 */
import type Database from "better-sqlite3";
import { getBogeysWithContentForEvent, type EarningsBogey } from "@/lib/queries/earnings-bogeys";
import { parseExtraMetrics, type ExtraMetricSpec } from "@/lib/print-watch/extra-metrics";
import { DEEP_READ_BOGEY_LABEL, VENDOR_BOGEY_SOURCE } from "@/lib/earnings/bogey-claim";
import { AMC_FLOOR_ET, BMO_FLOOR_ET } from "@/lib/earnings/pre-print-floor";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { todayET } from "@/lib/calendar/date-utils";
import type { Basis, BogeySnapshotFigure, FigureUnit, PeriodSpec } from "@/lib/filing-summary/types";

type RowKind = BogeySnapshotFigure["rowKind"];

/**
 * The row's kind, by the same rule as `BOGEY_SOURCE_RANK_SQL`
 * (lib/print-watch/contracts.ts): manual (rank 0), upload (1), deep read (2,
 * a newsletter row carrying the deep read label), newsletter (3). The SQL's
 * last rank (4) holds the vendor row (`finnhub`) AND any unknown source; an
 * unknown source is `other` ("other source"), never labelled as Finnhub's
 * consensus. Parity is pinned in tests/filing-summary/bogey-snapshot.test.ts.
 */
export function bogeyRowKind(row: Pick<EarningsBogey, "source" | "source_label">): RowKind {
  if (row.source === "manual") return "manual";
  if (row.source === "pdf_upload") return "upload";
  if (row.source === "newsletter" && row.source_label === DEEP_READ_BOGEY_LABEL) return "deep_read";
  if (row.source === "newsletter") return "newsletter";
  if (row.source === VENDOR_BOGEY_SOURCE) return "vendor";
  return "other";
}

/** The SQL rank (BOGEY_SOURCE_RANK_SQL) each kind falls in. */
export const ROW_KIND_RANK: Record<RowKind, number> = {
  manual: 0,
  upload: 1,
  deep_read: 2,
  newsletter: 3,
  vendor: 4,
  other: 4,
};

/** Public-safe provenance (R15). A manual or upload row's own label is never shown. */
function provenanceFor(kind: RowKind, sourceLabel: string | null): string {
  switch (kind) {
    case "manual": return "your manual entry";
    case "upload": return "uploaded PDF";
    case "vendor": return "Finnhub consensus";
    case "other": return "other source";
    case "deep_read": return sourceLabel ?? DEEP_READ_BOGEY_LABEL;
    case "newsletter": return sourceLabel?.trim() ? sourceLabel : "newsletter";
  }
}

/** Stored timestamps are space-separated UTC unless they carry a zone. NaN when unreadable. */
function storedInstantMs(raw: string | null): number {
  if (!raw) return Number.NaN;
  const s = raw.trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  return Date.parse(s.replace(" ", "T") + (hasZone ? "" : "Z"));
}

const THIS_QUARTER: PeriodSpec = {
  kind: "quarter", role: "actual", endDate: null, fiscalYear: null, fiscalQuarter: null,
  anchor: "reported_quarter", label: "this print's quarter",
};
const NEXT_QUARTER: PeriodSpec = {
  kind: "quarter", role: "outlook", endDate: null, fiscalYear: null, fiscalQuarter: null,
  anchor: "next_quarter", label: "next quarter outlook",
};
const FISCAL_YEAR: PeriodSpec = {
  kind: "fiscal_year", role: "outlook", endDate: null, fiscalYear: null, fiscalQuarter: null,
  anchor: "fiscal_year", label: "fiscal year outlook",
};

const EXTRA_PERIOD: Record<ExtraMetricSpec["period"], PeriodSpec> = {
  Q: THIS_QUARTER, NQ_guide: NEXT_QUARTER, FY_guide: FISCAL_YEAR,
};
const EXTRA_UNIT: Record<ExtraMetricSpec["unit"], FigureUnit> = {
  usd: "usd", per_share: "usd_per_share", pct: "percent", count: "count",
};
const EXTRA_BASIS: Record<ExtraMetricSpec["basis"], Basis> = {
  gaap: "reported", non_gaap: "non_gaap", na: "unknown",
};

/** The fixed fields, in output order. */
const FIELDS: ReadonlyArray<{
  field: "eps_consensus" | "eps_whisper" | "revenue_consensus_usd" | "revenue_whisper_usd" | "eps_consensus_vendor";
  label: string; unit: FigureUnit; basis: Basis;
}> = [
  { field: "eps_consensus", label: "EPS consensus", unit: "usd_per_share", basis: "unknown" },
  { field: "eps_whisper", label: "EPS whisper", unit: "usd_per_share", basis: "unknown" },
  { field: "revenue_consensus_usd", label: "Revenue consensus", unit: "usd", basis: "reported" },
  { field: "revenue_whisper_usd", label: "Revenue whisper", unit: "usd", basis: "reported" },
  { field: "eps_consensus_vendor", label: "EPS consensus (vendor)", unit: "usd_per_share", basis: "unknown" },
];

interface EventRow { event_date: string; event_time: string | null; raw_json: string | null }

/**
 * Every pre-print bogey figure for the event, ordered by row id then field
 * (stable, so the prompt fingerprint does not move with arrival order).
 * Keys: `b<rowId>.<field>`, `b<rowId>.x.<extraId>` (an extra line's consensus)
 * and `b<rowId>.x.<extraId>.whisper` (its whisper).
 */
export function buildBogeySnapshot(db: Database.Database, eventId: number): BogeySnapshotFigure[] {
  const ev = db
    .prepare(`SELECT event_date, event_time, raw_json FROM calendar_events WHERE id = ?`)
    .get(eventId) as EventRow | undefined;
  if (!ev) return [];

  const slot = deriveEarningsSlot({ event_time: ev.event_time, raw_json: ev.raw_json });
  const cutoff = composeReleaseInstant(ev.event_date, slot === "amc" ? AMC_FLOOR_ET : BMO_FLOOR_ET);
  const cutoffMs = cutoff ? cutoff.getTime() : Number.NaN;

  const rows = getBogeysWithContentForEvent(db, eventId).slice().sort((a, b) => a.id - b.id);
  const receivedStmt = db.prepare(`SELECT received_at FROM research_articles WHERE id = ?`);

  const out: BogeySnapshotFigure[] = [];
  for (const row of rows) {
    const kind = bogeyRowKind(row);
    const article = row.research_article_id === null
      ? undefined
      : (receivedStmt.get(row.research_article_id) as { received_at: string } | undefined);
    const datedMs = storedInstantMs(article ? article.received_at : row.uploaded_at);
    // Unreadable date: no way to show it predates the print, so it is left out.
    if (!Number.isFinite(datedMs)) continue;
    // An unknown floor (unreadable event date) keeps vendor rows only.
    if (kind !== "vendor" && !(Number.isFinite(cutoffMs) && datedMs < cutoffMs)) continue;

    const provenance = provenanceFor(kind, row.source_label);
    const asOf = todayET(new Date(datedMs));
    const base = { scale: "units" as const, provenance, asOf, rowKind: kind };

    for (const f of FIELDS) {
      const value = row[f.field];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      out.push({ key: `b${row.id}.${f.field}`, label: f.label, value, unit: f.unit, period: { ...THIS_QUARTER }, basis: f.basis, ...base });
    }

    // A row whose extra lines fail validation contributes none of them.
    for (const spec of parseExtraMetrics(row.extra_metrics_json).specs) {
      const common = { unit: EXTRA_UNIT[spec.unit], basis: EXTRA_BASIS[spec.basis], period: { ...EXTRA_PERIOD[spec.period] }, ...base };
      if (typeof spec.consensus === "number" && Number.isFinite(spec.consensus)) {
        out.push({ key: `b${row.id}.x.${spec.id}`, label: spec.label, value: spec.consensus, ...common });
      }
      if (typeof spec.whisper === "number" && Number.isFinite(spec.whisper)) {
        out.push({ key: `b${row.id}.x.${spec.id}.whisper`, label: `${spec.label} (whisper)`, value: spec.whisper, ...common });
      }
    }
  }
  return out;
}
