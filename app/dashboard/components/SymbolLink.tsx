import Link from "next/link";

/**
 * Clickable symbol that navigates to the Charts tab.
 * Server-component friendly — no client state needed.
 */
export function SymbolLink({
  securityId,
  symbol,
  className,
}: {
  securityId: number;
  symbol: string;
  className?: string;
}) {
  return (
    <Link
      href={`/dashboard/charts?id=${securityId}`}
      className={`hover:text-gold hover:underline underline-offset-2 transition-colors ${className ?? ""}`}
      title={`View ${symbol} chart`}
    >
      {symbol}
    </Link>
  );
}
