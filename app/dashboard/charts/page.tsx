export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import {
  getChartableSecurities,
  getDefaultChartSecurityId,
  getLatestPrice,
  getLatestPriceNative,
} from "@/lib/queries/ohlcv";
import { getSecurityById } from "@/lib/queries/securities";
import { getActiveWatchlistSecurityIds } from "@/lib/queries/watchlist";
import { isOptionLive } from "@/lib/compute/option-expiry";
import { ChartsView, type UnavailableChartRequest } from "../components/ChartsView";
import { classifyChartRequest } from "./last-symbol";

interface PageProps {
  searchParams: Promise<{ id?: string }>;
}

export default async function ChartsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const hasExplicitId = params.id !== undefined;
  const selectedId = params.id ? parseInt(params.id, 10) : null;

  // Option contracts past expiration (ET calendar, the shared expiry helper)
  // are left off the picker: IBKR serves no history for an expired contract,
  // so listing one only promised bars a TWS connect would never load. A
  // contract with no stored expiration is kept. A direct link to an expired
  // contract is named as such below.
  const isExpiredOption = (s: { id: number; security_type: string | null }) =>
    s.security_type?.toLowerCase() === "option" &&
    !isOptionLive(getSecurityById(db, s.id)?.expiration_date);
  const securities = getChartableSecurities(db).filter(
    (s) => !isExpiredOption(s),
  );

  // Old fallback: alphabetically-first stock/ETF (skip bonds/treasuries,
  // which have no OHLCV data). Kept as the last resort only — see
  // getDefaultChartSecurityId below.
  const alphabeticalFallback =
    securities.find((s) => s.security_type?.toLowerCase() === "stock" || s.security_type?.toLowerCase() === "etf") ??
    securities[0];

  // Charts-landing precedence (user ruling, 2026-09-11; full statement in
  // app/dashboard/charts/last-symbol.ts): last viewed, else largest
  // currently-held, else alphabetical-first. This file can only render the
  // last TWO of those — localStorage is not readable on the server — so it
  // resolves the largest CURRENTLY-HELD chartable position and leaves the
  // last-viewed restore (rule 1) to ChartsView on mount.
  //
  // Never the alphabetically-first security as the primary: that could be a
  // closed position (a quantity-0 reconciler tombstone) with no bars at
  // all. It survives only as the last resort, when nothing is held (or
  // nothing held is chartable/priced).
  const defaultHeldId = getDefaultChartSecurityId(db);
  const defaultSecurity =
    (defaultHeldId != null
      ? securities.find((s) => s.id === defaultHeldId)
      : undefined) ?? alphabeticalFallback;

  const initialSecurity =
    selectedId && !isNaN(selectedId)
      ? securities.find((s) => s.id === selectedId) ?? defaultSecurity
      : defaultSecurity;

  // An ?id= that is present but not chartable (no IB contract id, a mutual
  // fund, or no such security) is SAID, never swapped for the default: the
  // view starts with nothing selected and names the security instead. The
  // default above still feeds the picker and the Watchlist grid.
  const request = classifyChartRequest(
    params.id,
    securities.map((s) => s.id),
  );
  let unavailableRequest: UnavailableChartRequest | null = null;
  if (request.kind === "unavailable") {
    const asked = request.id != null ? getSecurityById(db, request.id) : null;
    unavailableRequest = asked
      ? {
          securityId: asked.id,
          symbol: asked.symbol,
          reason:
            asked.ib_con_id == null
              ? "no_contract"
              : isExpiredOption(asked)
                ? "expired_option"
                : "mutual_fund",
        }
      : { securityId: null, symbol: null, reason: "not_found" };
  }

  const latestPrice = initialSecurity
    ? getLatestPrice(db, initialSecurity.id)
    : null;
  // Same prices row, unconverted — the frame the chart's axis and badge use.
  const latestPriceNative = initialSecurity
    ? getLatestPriceNative(db, initialSecurity.id)
    : null;

  // Watchlist mode seeds its panels from the watchlist table, in this order.
  const watchlistSecurityIds = getActiveWatchlistSecurityIds(db);

  return (
    <ChartsView
      securities={securities}
      initialSecurity={initialSecurity ?? null}
      initialPrice={latestPrice}
      initialPriceNative={latestPriceNative?.close_price ?? null}
      hasExplicitId={hasExplicitId}
      arrivedSecurityId={request.kind === "chartable" ? request.id : null}
      unavailableRequest={unavailableRequest}
      watchlistSecurityIds={watchlistSecurityIds}
    />
  );
}
