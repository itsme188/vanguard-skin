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

export interface VendorConsensus { eps: number | null; revenue: number | null; }

/**
 * Finnhub estimates live in raw_json.entry (see calendar sync). TRI-STATE [F1]:
 *
 *  - `undefined` — there is no Finnhub `entry` on this row AT ALL (a manual row,
 *    or a row whose raw_json never carried one). Nothing has been withdrawn, so
 *    the step must leave any existing finnhub bogey alone. This is the case a
 *    date correction produces: `correctEarningsEventDate` mints a manual row and
 *    the event merge repoints the donor's finnhub bogey onto it, and treating
 *    that as a withdrawal deleted the spec-mandated revenue bogey on every
 *    ordinary correction.
 *  - `null` — an entry EXISTS but its figures are withdrawn, foreign-echoed, or
 *    from the wrong event: the engine-owned finnhub row must go.
 *  - the pair otherwise.
 *
 * [C-2] The symbol we QUERIED is canonical (CLAUDE.md): an entry whose `symbol`
 * is not in the event symbol's issuer family is a foreign listing / ADR echo and
 * is dropped — the same guard `lib/calendar/finnhub.ts:153` applies at sync time.
 * A raw_json we cannot parse, or an event with no symbol to check the entry
 * against, is `null` (unchanged): the row is finnhub-shaped and unverifiable, so
 * the engine-owned bogey does not get to survive on it.
 */
export function readVendorConsensus(rawJson: string | null, eventSymbol: string | null): VendorConsensus | null | undefined {
  if (!rawJson) return undefined;
  if (!eventSymbol) return null;
  let parsed: { entry?: { symbol?: unknown; epsEstimate?: unknown; revenueEstimate?: unknown }; finnhub_symbol?: unknown };
  try {
    parsed = JSON.parse(rawJson);
  } catch { return null; }
  const entry = parsed.entry;
  if (!entry) return undefined;
  const family = new Set(issuerSiblings(eventSymbol).map((s) => s.toUpperCase()));
  const echoed = typeof entry.symbol === "string" ? entry.symbol.toUpperCase() : null;
  const queried = typeof parsed.finnhub_symbol === "string" ? parsed.finnhub_symbol.toUpperCase() : null;
  if (!echoed || !family.has(echoed) || (queried && queried !== echoed)) return null;
  const eps = typeof entry.epsEstimate === "number" && Number.isFinite(entry.epsEstimate) ? entry.epsEstimate : null;
  const revenue = typeof entry.revenueEstimate === "number" && Number.isFinite(entry.revenueEstimate) ? entry.revenueEstimate : null;
  return eps == null && revenue == null ? null : { eps, revenue };
}

/** The tri-state, flattened for the fingerprint. `undefined` and `null` mean
 *  opposite things to `run`, and JSON.stringify collapses both to `null` — so a
 *  row that went from "no entry" to "entry withdrawn" would never drift. */
function fingerprintVendor(v: VendorConsensus | null | undefined): unknown {
  return v === undefined ? "absent" : v === null ? "withdrawn" : v;
}

interface EventRow { symbol: string | null; source: string; raw_json: string | null; consensus_estimate: string | null; consensus_value: string | null; }
const readEvent = (db: Database.Database, eventId: number) =>
  db.prepare(`SELECT symbol, source, raw_json, consensus_estimate, consensus_value FROM calendar_events WHERE id = ?`).get(eventId) as EventRow | undefined;

export const consensusRowStep: PrepareStepDefinition = {
  fingerprint(db, eventId) {
    const e = readEvent(db, eventId);
    // Version 2: the vendor read became tri-state, so every row re-derives once
    // (the step is an idempotent upsert — a re-run costs nothing).
    return stableHash(["consensus_row", 2, e?.source ?? null, fingerprintVendor(readVendorConsensus(e?.raw_json ?? null, e?.symbol ?? null)), e?.consensus_estimate ?? null, e?.consensus_value ?? null]);
  },
  async run(db, eventId) {
    const e = readEvent(db, eventId);
    if (!e) return { status: "failed", error: `event ${eventId} not found` };
    const vendor = readVendorConsensus(e.raw_json, e.symbol);
    // [F1] No vendor entry at all → nothing to promote and nothing to withdraw.
    // A finnhub bogey sitting on such a row got there another way (the event
    // merge moves one onto the manual row a date correction mints) and is NOT
    // this step's to delete.
    if (vendor === undefined) return { status: "done", note: "no vendor data on this row" };
    if (vendor === null) {
      // [C-2] The finnhub row is engine-owned: when the vendor's own entry no longer carries a
      // (matching) estimate, a stale row must not keep feeding the revenue bogey or the vendor-EPS label.
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
