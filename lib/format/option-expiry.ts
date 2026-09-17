/**
 * Formats an option expiration date with its year, e.g. "Sep 17, 2027".
 *
 * Used anywhere an option position's expiry is shown next to its strike —
 * QA finding analysis-greeks--expiry-column-omits-year: the Options Greeks
 * table's bare month/day label made a 2026 contract and a 2027 contract
 * print identically, so only the separate DTE column disambiguated them.
 *
 * Accepts both shapes this repo's option rows carry: ISO "YYYY-MM-DD" and
 * the compact "YYYYMMDD" a handful of TWS-enriched rows store instead (see
 * the matching comment on the sibling formatExpiry in
 * lib/compute/options-strategy.ts ~line 548 — that copy is intentionally
 * left alone, out of scope for this fix).
 *
 * Invalid or empty input returns the input unchanged rather than risking
 * "undefined NaN".
 */
export function formatOptionExpiry(expiry: string): string {
  if (!expiry) return expiry;

  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (iso) {
    year = parseInt(iso[1], 10);
    month = parseInt(iso[2], 10) - 1;
    day = parseInt(iso[3], 10);
  } else {
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(expiry);
    if (compact) {
      year = parseInt(compact[1], 10);
      month = parseInt(compact[2], 10) - 1;
      day = parseInt(compact[3], 10);
    }
  }

  if (year === null || month === null || day === null) return expiry;
  if (month < 0 || month > 11 || day < 1 || day > 31) return expiry;

  return `${months[month]} ${day}, ${year}`;
}
