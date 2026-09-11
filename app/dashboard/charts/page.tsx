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
