/**
 * Small pure helpers for the security page's Open Tax Lots and Recent Sales
 * sections. Plain module (no JSX) so the wording rules can be unit-tested.
 */

/**
 * Contracts still open across a security's expired option lots.
 *
 * The line used to count LOTS ("2 expired lots"), which is a bookkeeping
 * unit: two purchases of one contract series are two lots. What is awaiting a
 * closing entry is a number of contracts, the same unit the Tax Lots page
 * uses for its own expired line. A short lot stores a positive remaining
 * quantity (`is_short` carries the side), so the absolute value is summed.
 */
export function expiredContractQuantity(
  lots: ReadonlyArray<{ quantity_remaining: number }>
): number {
  return lots.reduce((sum, lot) => sum + Math.abs(lot.quantity_remaining), 0);
}

export interface TaxLotsLink {
  href: string;
  label: string;
}

/**
 * The "more sales" link under Recent Sales.
 *
 * The Tax Lots page shows one sale year at a time. Without a year it opens on
 * the current calendar year (or the newest year with any sale), which for a
 * security last sold in an earlier year is an empty Closed Sales table. The
 * link therefore names the year of this security's newest sale, and says so
 * in its label; the page's year pills lead to the older ones.
 */
export function recentSalesTaxLotsLink(
  securityId: number,
  sales: ReadonlyArray<{ sale_date: string }>
): TaxLotsLink {
  const base = `/dashboard/tax-lots?security=${securityId}`;
  let newest: string | null = null;
  for (const sale of sales) {
    const date = sale.sale_date;
    if (!/^\d{4}-\d{2}-\d{2}/.test(date ?? "")) continue;
    if (newest === null || date > newest) newest = date;
  }
  if (newest === null) return { href: base, label: "Open in Tax Lots →" };
  const year = newest.slice(0, 4);
  return { href: `${base}&year=${year}`, label: `Open ${year} sales in Tax Lots →` };
}
