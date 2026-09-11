export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import {
  getChartableSecurities,
  getDefaultChartSecurityId,
  getLatestPrice,
} from "@/lib/queries/ohlcv";
import { ChartsView } from "../components/ChartsView";

interface PageProps {
  searchParams: Promise<{ id?: string }>;
}

export default async function ChartsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const hasExplicitId = params.id !== undefined;
  const selectedId = params.id ? parseInt(params.id, 10) : null;

  const securities = getChartableSecurities(db);

  // Old fallback: alphabetically-first stock/ETF (skip bonds/treasuries,
  // which have no OHLCV data). Kept as the last resort only — see
  // getDefaultChartSecurityId below.
  const alphabeticalFallback =
    securities.find((s) => s.security_type?.toLowerCase() === "stock" || s.security_type?.toLowerCase() === "etf") ??
    securities[0];

  // Charts-landing default-security ruling: default to the largest
  // CURRENTLY-HELD chartable position, never the alphabetically-first
  // security — that could be a closed position (a quantity-0 reconciler
  // tombstone) with no bars at all. Falls back to the alphabetical pick
  // only when nothing is held (or nothing held is chartable/priced). The
  // last-viewed-symbol preference (ruling step 2) is applied client-side in
  // ChartsView, since localStorage isn't readable on the server.
  const defaultHeldId = getDefaultChartSecurityId(db);
  const defaultSecurity =
    (defaultHeldId != null
      ? securities.find((s) => s.id === defaultHeldId)
      : undefined) ?? alphabeticalFallback;

  const initialSecurity =
    selectedId && !isNaN(selectedId)
      ? securities.find((s) => s.id === selectedId) ?? defaultSecurity
      : defaultSecurity;

  const latestPrice = initialSecurity
    ? getLatestPrice(db, initialSecurity.id)
    : null;

  return (
    <ChartsView
      securities={securities}
      initialSecurity={initialSecurity ?? null}
      initialPrice={latestPrice}
      hasExplicitId={hasExplicitId}
    />
  );
}
