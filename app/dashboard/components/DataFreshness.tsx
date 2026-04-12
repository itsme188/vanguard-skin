import Link from "next/link";
import { db } from "@/lib/db";

function getFreshnessData() {
  try {
    const priceRow = db
      .prepare("SELECT MAX(date) AS latest FROM prices")
      .get() as { latest: string | null } | undefined;

    const holdingsRow = db
      .prepare("SELECT MAX(as_of_date) AS latest FROM holdings")
      .get() as { latest: string | null } | undefined;

    // Quick health check: count held securities vs those with recent prices (7 days)
    const today = new Date().toISOString().split("T")[0];
    const healthRow = db
      .prepare(
        `SELECT
          COUNT(DISTINCT h.security_id) AS total,
          COUNT(DISTINCT CASE
            WHEN p.latest_date IS NOT NULL
              AND CAST(julianday(?) - julianday(p.latest_date) AS INTEGER) <= 7
            THEN h.security_id
          END) AS priced
        FROM holdings h
        JOIN (
          SELECT account_id, MAX(as_of_date) AS max_date
          FROM holdings GROUP BY account_id
        ) latest ON latest.account_id = h.account_id AND h.as_of_date = latest.max_date
        LEFT JOIN (
          SELECT security_id, MAX(date) AS latest_date
          FROM prices GROUP BY security_id
        ) p ON p.security_id = h.security_id
        WHERE h.quantity > 0`,
      )
      .get(today) as { total: number; priced: number } | undefined;

    const total = healthRow?.total ?? 0;
    const priced = healthRow?.priced ?? 0;
    const healthPct = total > 0 ? Math.round((priced / total) * 100) : 100;

    return {
      pricesAsOf: priceRow?.latest ?? null,
      holdingsAsOf: holdingsRow?.latest ?? null,
      healthPct,
    };
  } catch {
    return { pricesAsOf: null, holdingsAsOf: null, healthPct: 100 };
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
  const { pricesAsOf, holdingsAsOf, healthPct } = getFreshnessData();

  if (!pricesAsOf && !holdingsAsOf) {
    return (
      <Link
        href="/dashboard/import"
        className="flex items-center gap-2 text-[11px] text-ink-faint font-mono hover:text-ink-dim transition-colors"
        title="No data imported yet — click to import"
      >
        <span className="w-2 h-2 rounded-full bg-ink-faint" />
        <span>No data — import files to start</span>
      </Link>
    );
  }

  const dotColor =
    healthPct >= 90
      ? "bg-up"
      : healthPct >= 70
        ? "bg-gold"
        : "bg-down";

  return (
    <Link
      href="/dashboard/data-health"
      className="flex items-center gap-2 text-[11px] text-ink-faint font-mono hover:text-ink-dim transition-colors"
      title={`Data health: ${healthPct}% coverage — click for details`}
    >
      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
      {pricesAsOf && (
        <span>
          Prices: {formatShortDate(pricesAsOf)}
        </span>
      )}
      {holdingsAsOf && (
        <span>
          Holdings: {formatShortDate(holdingsAsOf)}
        </span>
      )}
    </Link>
  );
}
