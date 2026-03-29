import Link from "next/link";

/**
 * Clickable symbol that navigates to the Security Detail page.
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
      href={`/dashboard/security/${securityId}`}
      className={`hover:text-gold hover:underline underline-offset-2 transition-colors ${className ?? ""}`}
      title={`View ${symbol} details`}
    >
      {symbol}
    </Link>
  );
}
