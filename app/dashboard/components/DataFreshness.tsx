import { db } from "@/lib/db";

function getFreshnessData() {
  try {
    const priceRow = db
      .prepare("SELECT MAX(date) AS latest FROM prices")
      .get() as { latest: string | null } | undefined;

    const holdingsRow = db
      .prepare("SELECT MAX(as_of_date) AS latest FROM holdings")
      .get() as { latest: string | null } | undefined;

    return {
      pricesAsOf: priceRow?.latest ?? null,
      holdingsAsOf: holdingsRow?.latest ?? null,
    };
  } catch {
    return { pricesAsOf: null, holdingsAsOf: null };
  }
}

function formatShortDate(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

export function DataFreshness() {
  const { pricesAsOf, holdingsAsOf } = getFreshnessData();

  if (!pricesAsOf && !holdingsAsOf) return null;

  return (
    <div className="flex items-center gap-3 text-[11px] text-ink-faint font-mono">
      {pricesAsOf && (
        <span title={`Last price date: ${pricesAsOf}`}>
          Prices: {formatShortDate(pricesAsOf)}
        </span>
      )}
      {holdingsAsOf && (
        <span title={`Last holdings date: ${holdingsAsOf}`}>
          Holdings: {formatShortDate(holdingsAsOf)}
        </span>
      )}
    </div>
  );
}
