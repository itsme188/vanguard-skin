/**
 * Live print v2 slice A, spec §4.1 step 2 — the vendor consensus prepare
 * step. An armed event's Finnhub-sourced raw_json carries a sell-side EPS +
 * revenue estimate pair; this step promotes it into `earnings_bogeys` as an
 * engine-owned `finnhub` row so the worksheet shows it alongside any
 * newsletter/manual bogeys.
 *
 * D1 (user-ruled): the vendor EPS goes to `eps_consensus_vendor`, never
 * `eps_consensus` — the finnhub row must never be adoptable as the
 * adjusted-EPS bogey (compileContracts and every other eps_consensus reader
 * would otherwise silently start trusting an unlabelled basis).
 */
import type Database from "better-sqlite3";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

export const FINNHUB_BOGEY_LABEL = "Sell-side consensus (Finnhub)";

/** Finnhub estimates live in raw_json.entry (see calendar sync). Manual rows have none.
 *  [C-2] The symbol we QUERIED is canonical (CLAUDE.md): an entry whose `symbol` is not in the
 *  event symbol's issuer family is a foreign listing / ADR echo and is dropped — the same guard
 *  `lib/calendar/finnhub.ts:153` applies at sync time. */
export function readVendorConsensus(rawJson: string | null, eventSymbol: string | null): { eps: number | null; revenue: number | null } | null {
  if (!rawJson || !eventSymbol) return null;
  try {
    const parsed = JSON.parse(rawJson) as { entry?: { symbol?: unknown; epsEstimate?: unknown; revenueEstimate?: unknown }; finnhub_symbol?: unknown };
    const entry = parsed.entry;
    if (!entry) return null;
    const family = new Set(issuerSiblings(eventSymbol).map((s) => s.toUpperCase()));
    const echoed = typeof entry.symbol === "string" ? entry.symbol.toUpperCase() : null;
    const queried = typeof parsed.finnhub_symbol === "string" ? parsed.finnhub_symbol.toUpperCase() : null;
    if (!echoed || !family.has(echoed) || (queried && queried !== echoed)) return null;
    const eps = typeof entry.epsEstimate === "number" && Number.isFinite(entry.epsEstimate) ? entry.epsEstimate : null;
    const revenue = typeof entry.revenueEstimate === "number" && Number.isFinite(entry.revenueEstimate) ? entry.revenueEstimate : null;
    return eps == null && revenue == null ? null : { eps, revenue };
  } catch { return null; }
}

interface EventRow { symbol: string | null; source: string; raw_json: string | null; consensus_estimate: string | null; consensus_value: string | null; }
const readEvent = (db: Database.Database, eventId: number) =>
  db.prepare(`SELECT symbol, source, raw_json, consensus_estimate, consensus_value FROM calendar_events WHERE id = ?`).get(eventId) as EventRow | undefined;

export const consensusRowStep: PrepareStepDefinition = {
  fingerprint(db, eventId) {
    const e = readEvent(db, eventId);
    return stableHash(["consensus_row", 1, e?.source ?? null, readVendorConsensus(e?.raw_json ?? null, e?.symbol ?? null), e?.consensus_estimate ?? null, e?.consensus_value ?? null]);
  },
  async run(db, eventId) {
    const e = readEvent(db, eventId);
    if (!e) return { status: "failed", error: `event ${eventId} not found` };
    const vendor = readVendorConsensus(e.raw_json, e.symbol);
    if (!vendor) {
      // [C-2] The finnhub row is engine-owned: when the vendor has no (or a mismatched) estimate,
      // a stale row must not keep feeding the revenue bogey or the vendor-EPS label.
      const gone = db.prepare(`DELETE FROM earnings_bogeys WHERE event_id = ? AND source = 'finnhub'`).run(eventId).changes;
      return { status: "done", note: gone > 0 ? "vendor consensus withdrawn; finnhub row removed" : "no vendor consensus on the event" };
    }
    // D1: the vendor EPS goes to eps_consensus_vendor; eps_consensus stays NULL so
    // compileContracts can never adopt it as the adjusted-EPS expected value.
    upsertBogey(db, {
      event_id: eventId, source: "finnhub", source_label: FINNHUB_BOGEY_LABEL,
      eps_consensus: null, eps_consensus_vendor: vendor.eps, revenue_consensus_usd: vendor.revenue,
      notes: "Vendor consensus (Finnhub) — EPS basis unspecified; shown labelled, never the adjusted-EPS bogey.",
    });
    return { status: "done" };
  },
};
