import { db } from "@/lib/db";
import { getChartableSecurities, getLatestPrice } from "@/lib/queries/ohlcv";
import { ChartsView } from "../components/ChartsView";

interface PageProps {
  searchParams: Promise<{ id?: string }>;
}

export default async function ChartsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const selectedId = params.id ? parseInt(params.id, 10) : null;

  const securities = getChartableSecurities(db);

  // Default to first stock (skip bonds/treasuries which have no OHLCV data)
  const defaultSecurity =
    securities.find((s) => s.security_type?.toLowerCase() === "stock" || s.security_type?.toLowerCase() === "etf") ??
    securities[0];

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
    />
  );
}
