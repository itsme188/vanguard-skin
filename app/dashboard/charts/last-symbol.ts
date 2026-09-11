/**
 * Persists the last-viewed Charts tab symbol so a later bare
 * /dashboard/charts visit (no explicit `?id=`) reopens where the desk left
 * off.
 *
 * CHARTS-LANDING PRECEDENCE (user ruling, 2026-09-11) — in order:
 *
 *   1. the LAST VIEWED symbol (this module), whenever one is stored
 *   2. else the largest currently-held position
 *      (lib/queries/ohlcv.ts getDefaultChartSecurityId)
 *   3. else alphabetical-first, when nothing is held
 *
 * An explicit `?id=` in the URL outranks all three — it is not a default.
 *
 * The comment here used to state 1 and 2 the other way round, which never
 * matched the code: ChartsView restores this stored symbol on mount
 * whenever one exists, so last-viewed has always won in practice. The
 * ruling confirms that behavior and this doc now matches it.
 *
 * Why the rule is split across a server and a client file: localStorage is
 * unreadable on the server, so page.tsx renders rule 2/3 and ChartsView
 * swaps in rule 1 on mount. That leaves a brief flash of the held-position
 * chart before the restore. Removing it is NOT cheap — it would mean
 * mirroring this value into a cookie so the server could read it, i.e. a
 * second store that can silently disagree with localStorage (two browsers,
 * cleared site data, a private window), to remove one frame. Deliberately
 * kept as server-default-then-swap; revisit only if the flash is reported
 * as an actual annoyance.
 *
 * See app/dashboard/charts/page.tsx and
 * app/dashboard/components/ChartsView.tsx.
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
