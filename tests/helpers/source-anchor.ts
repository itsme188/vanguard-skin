/**
 * Source-pin anchor helpers.
 *
 * Source-pin tests locate a region of a source file with `src.indexOf(needle)`
 * and slice from it. When the needle disappears, indexOf returns -1 and
 * `slice(-1, ...)` yields a tiny/empty string, so every "not contains"
 * assertion passes vacuously and the pin silently guards nothing. These
 * helpers throw instead.
 *
 * Genuine "may be absent" checks should keep using plain indexOf/includes.
 */

/** Index of `needle` in `src` (from `from`); throws if the anchor is absent. */
export function anchorIndex(
  src: string,
  needle: string,
  from = 0,
  label?: string,
): number {
  const idx = src.indexOf(needle, from);
  if (idx === -1) {
    const shown = needle.length > 120 ? `${needle.slice(0, 120)}...` : needle;
    throw new Error(
      `anchor not found${label ? ` (${label})` : ""}: ${JSON.stringify(shown)}` +
        (from ? ` (searched from offset ${from})` : ""),
    );
  }
  return idx;
}

/**
 * Text from the start of `startNeedle` up to (not including) the next
 * `endNeedle` after it. Throws if either anchor is absent.
 */
export function sliceBetween(
  src: string,
  startNeedle: string,
  endNeedle: string,
): string {
  const start = anchorIndex(src, startNeedle, 0, "start");
  const end = anchorIndex(src, endNeedle, start + startNeedle.length, "end");
  return src.slice(start, end);
}
