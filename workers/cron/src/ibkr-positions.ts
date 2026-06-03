/**
 * Live IBKR position layer for the Worker (Tier 3 delivery).
 *
 * The cloud composers read positions from the nightly R2 snapshot, which freezes
 * at 2am and stays frozen for DAYS while the Mac is asleep (travel). The IBKR
 * account rotates heavily, so its snapshot rows go stale fast. This module pulls
 * the CURRENT IBKR book over the headless Web API (proven in src/ibkr-oauth.ts)
 * and merges it into the composer's position view — replacing the stale snapshot
 * IBKR rows (never appending, or the same position double-counts) while leaving
 * the slow-moving Vanguard/Roth statement rows untouched.
 *
 * Pure transforms (OCC parse, raw→position map, family filter, merge) are unit
 * tested; the network fetch is proven by the deployed /internal/ibkr-test.
 */

import {
  getLiveSessionToken,
  signedRequest,
  type IbkrWorkerConfig,
} from "./ibkr-oauth";
import type { PositionView } from "./fallback-earnings";

// ── Types ───────────────────────────────────────────────────────────

export interface LiveIbkrPosition {
  symbol: string;
  securityType: string;
  underlyingSymbol: string | null;
  optionType: "CALL" | "PUT" | null;
  strikePrice: number | null;
  expirationDate: string | null;
  multiplier: number | null;
  quantity: number;
  costBasis: number | null;
  mktPrice: number | null;
}

interface RawPosition {
  assetClass?: string;
  conid?: number;
  contractDesc?: string;
  position?: number;
  avgCost?: number;
  mktPrice?: number;
  [k: string]: unknown;
}

// Mirror of lib/ibkr/map-positions.ts ASSET_CLASS_TO_TYPE — keep in sync.
const ASSET_CLASS_TO_TYPE: Record<string, string> = {
  STK: "Stock",
  OPT: "Option",
  FOP: "Option",
  WAR: "Warrant",
  BOND: "Bond",
  BILL: "Bond",
  FUND: "Mutual Fund",
  FUT: "Future",
  CASH: "Cash",
};

// ── OCC parsing (port of lib/import/occ-symbol.ts::parseOCCSymbol) ───

const OCC_RE = /^.{6}\d{6}[CP]\d{8}$/;

export function parseOcc(symbol: string): {
  underlying: string;
  expirationDate: string;
  optionType: "CALL" | "PUT";
  strike: number;
} | null {
  if (!OCC_RE.test(symbol)) return null;
  const underlying = symbol.slice(0, 6).trim();
  const yy = symbol.slice(6, 8);
  const mm = symbol.slice(8, 10);
  const dd = symbol.slice(10, 12);
  const cp = symbol.slice(12, 13);
  const strikeRaw = symbol.slice(13, 21);
  return {
    underlying,
    expirationDate: `20${yy}-${mm}-${dd}`,
    optionType: cp === "C" ? "CALL" : "PUT",
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}

/** Extract the OCC symbol + multiplier from an option `contractDesc` bracket. */
export function extractOccFromContractDesc(
  contractDesc: string,
): { occ: string; multiplier: number } | null {
  const m = /\[(.{21})\s+(\d+)\]\s*$/.exec(contractDesc);
  if (!m) return null;
  return { occ: m[1], multiplier: parseInt(m[2], 10) };
}

// ── Raw → normalized position (port of lib/ibkr/map-positions.ts) ────

export function mapLivePosition(raw: RawPosition): LiveIbkrPosition {
  const assetClass = (raw.assetClass ?? "STK").toUpperCase();
  const securityType = ASSET_CLASS_TO_TYPE[assetClass] ?? "Stock";
  const quantity = raw.position ?? 0;
  const avgCost = raw.avgCost ?? 0;
  const costBasis = avgCost ? quantity * avgCost : null;
  const mktPrice = typeof raw.mktPrice === "number" ? raw.mktPrice : null;
  const contractDesc = raw.contractDesc ?? "";

  if (securityType === "Option") {
    const extracted = extractOccFromContractDesc(contractDesc);
    if (extracted) {
      const parsed = parseOcc(extracted.occ);
      if (parsed) {
        return {
          symbol: extracted.occ,
          securityType: "Option",
          underlyingSymbol: parsed.underlying,
          optionType: parsed.optionType,
          strikePrice: parsed.strike,
          expirationDate: parsed.expirationDate,
          multiplier: extracted.multiplier,
          quantity,
          costBasis,
          mktPrice,
        };
      }
    }
    // Fall through: option we couldn't parse — keep the raw desc as symbol.
  }

  return {
    symbol: contractDesc.trim() || `conid:${raw.conid ?? "?"}`,
    securityType,
    underlyingSymbol: null,
    optionType: null,
    strikePrice: null,
    expirationDate: null,
    multiplier: null,
    quantity,
    costBasis,
    mktPrice,
  };
}

// ── Family filtering + view projection ──────────────────────────────

/** Project live IBKR positions matching the issuer family into PositionViews. */
export function livePositionViewsForFamily(
  positions: LiveIbkrPosition[],
  family: readonly string[],
  accountName: string,
): PositionView[] {
  const fam = new Set(family.map((s) => s.toUpperCase()));
  const out: PositionView[] = [];
  for (const p of positions) {
    if (!p.quantity) continue;
    const symMatch = p.symbol && fam.has(p.symbol.toUpperCase());
    const underMatch = p.underlyingSymbol && fam.has(p.underlyingSymbol.toUpperCase());
    if (!symMatch && !underMatch) continue;
    out.push({
      account_name: accountName,
      symbol: p.symbol,
      security_type: p.securityType,
      underlying_symbol: p.underlyingSymbol,
      option_type: p.optionType,
      strike_price: p.strikePrice,
      expiration_date: p.expirationDate,
      multiplier: p.multiplier,
      quantity: p.quantity,
      cost_basis: p.costBasis,
    });
  }
  return out;
}

/**
 * Merge snapshot position views with the live IBKR read.
 *   - live === null  → snapshot verbatim (IBKR not configured / fetch failed).
 *   - live present   → drop EVERY snapshot row whose account is the IBKR account
 *     (stale), then append the live IBKR family rows. Non-IBKR snapshot rows
 *     (Vanguard/Roth) are kept verbatim. An empty live array therefore correctly
 *     reflects a full exit (the stale row vanishes rather than lingering).
 */
export function combineFamilyPositions(
  snapshotViews: PositionView[],
  live: LiveIbkrPosition[] | null,
  family: readonly string[],
  ibkrAccountName: string,
): PositionView[] {
  if (live === null) return snapshotViews;
  const ibkrKey = ibkrAccountName.toLowerCase();
  const nonIbkr = snapshotViews.filter(
    (v) => !v.account_name.toLowerCase().includes(ibkrKey),
  );
  return [...nonIbkr, ...livePositionViewsForFamily(live, family, ibkrAccountName)];
}

/** Current holdings as context symbols: stock symbols + option underlyings, deduped. */
export function liveSymbolsForContext(positions: LiveIbkrPosition[]): string[] {
  const out = new Set<string>();
  for (const p of positions) {
    if (!p.quantity) continue;
    if (p.securityType === "Option") {
      if (p.underlyingSymbol) out.add(p.underlyingSymbol.toUpperCase());
    } else if (p.symbol && !p.symbol.startsWith("conid:")) {
      out.add(p.symbol.toUpperCase());
    }
  }
  return [...out];
}

// ── Network fetch (best-effort; proven live via /internal/ibkr-test) ─

/**
 * Mint an LST, open the brokerage session, and read the current positions for
 * the first portfolio account. Best-effort: callers should swallow errors and
 * fall back to the snapshot. Returns mapped, non-zero positions.
 */
export async function fetchLiveIbkrPositions(
  cfg: IbkrWorkerConfig,
): Promise<LiveIbkrPosition[]> {
  const lst = await getLiveSessionToken(cfg);
  // Brokerage session is required before /portfolio reads return live data.
  await signedRequest(cfg, lst.token, "POST", "/iserver/auth/ssodh/init", {
    compete: "true",
    publish: "true",
  });

  const acctRes = await signedRequest(cfg, lst.token, "GET", "/portfolio/accounts");
  if (!acctRes.ok) throw new Error(`portfolio/accounts HTTP ${acctRes.status}`);
  const accts = (await acctRes.json()) as Array<{ accountId: string }>;
  if (!accts.length) throw new Error("no portfolio accounts");
  const accountId = accts[0].accountId;

  const raw: RawPosition[] = [];
  for (let page = 0; page < 50; page++) {
    const res = await signedRequest(
      cfg,
      lst.token,
      "GET",
      `/portfolio/${accountId}/positions/${page}`,
    );
    if (!res.ok) {
      if (page === 0) throw new Error(`positions HTTP ${res.status}`);
      break;
    }
    const batch = (await res.json()) as RawPosition[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    raw.push(...batch);
    if (batch.length < 30) break; // IBKR pages ~30/page
  }

  return raw.filter((p) => (p.position ?? 0) !== 0).map(mapLivePosition);
}
