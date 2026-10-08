/**
 * Companion to `dataWindowNotice` (data-window.ts), which speaks only when the
 * series is SHORTER than the selected period. This is the plain caption for
 * the other case, so a card always names the window it was computed from and
 * two periods that share one window can be seen to share it. Null when there
 * is no window.
 */

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function dataWindowCoveredCaption(
  seriesStart: string | null,
  seriesEnd: string | null,
): string | null {
  if (!seriesStart || !seriesEnd) return null;
  return `Computed from daily data ${formatDay(seriesStart)} – ${formatDay(seriesEnd)}`;
}
