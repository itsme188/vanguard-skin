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
      // Touch hit-extension uses ±6px vertical (not the standard ±8px):
      // symbol links render inside dense table rows whose pitch can be
      // ~35px, and a positioned ::after wins hit-testing over in-flow
      // content — ±8px would let each row's link steal taps from the
      // rows above/below it.
      className={`relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:-inset-x-0.5 hover:text-gold hover:underline underline-offset-2 transition-colors ${className ?? ""}`}
      title={`View ${symbol} details`}
    >
      {symbol}
    </Link>
  );
}
