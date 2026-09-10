/**
 * Persists the last-viewed Charts tab symbol so a later bare
 * /dashboard/charts visit (no explicit `?id=`) reopens where the desk left
 * off, per the charts-landing default-security ruling: default order is
 * (1) largest currently-held position (lib/queries/ohlcv.ts
 * getDefaultChartSecurityId), (2) this last-viewed symbol, (3)
 * alphabetical-first as a last resort when nothing is held. See
 * app/dashboard/charts/page.tsx and app/dashboard/components/ChartsView.tsx.
 *
 * Mirrors the readManual/writeManual pattern in
 * app/dashboard/today/hub-live/expansion.ts: pure, DOM-free (no jsdom/RTL
 * in this repo), an injectable Storage-like param for unit tests, and every
 * access wrapped — a private window, cleared site data, or a
 * blocked-storage browser throws on the accessor itself, and that's fine
 * (a per-viewer convenience, never load-bearing).
 */

export const LAST_CHART_SYMBOL_KEY = "vgs:charts:lastSymbolId";

function defaultStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** null = no stored preference, or the stored value is missing/garbage
 *  (blank, non-numeric, non-positive, non-integer). */
export function readLastChartSymbolId(
  storage?: Pick<Storage, "getItem">,
): number | null {
  try {
    const s = storage ?? defaultStorage();
    if (!s) return null;
    const raw = s.getItem(LAST_CHART_SYMBOL_KEY);
    if (raw == null || raw === "") return null;
    const id = Number(raw);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
    return id;
  } catch {
    return null;
  }
}

export function writeLastChartSymbolId(
  id: number,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const s = storage ?? defaultStorage();
    s?.setItem(LAST_CHART_SYMBOL_KEY, String(id));
  } catch {
    /* a per-viewer convenience, never load-bearing — a blocked store is fine */
  }
}
