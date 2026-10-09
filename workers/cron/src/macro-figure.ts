/**
 * Worker hand copy of lib/calendar/macro-figure.ts (the Worker bundle cannot
 * cross the Next.js path-alias boundary). Everything below the mirror marker
 * is byte-identical to the Mac file; test/macro-figure-parity.test.ts pins
 * that, and both sides answer tests/fixtures/macro-figure-cases.json.
 *
 * Never edit this file alone: change the Mac file, then copy the part below
 * the marker here.
 */

// ── mirrored below this line ──

/**
 * The unit a macro figure is printed in.
 *   pct    a percent                      "+0.3%", "4.7%"
 *   count  a number with a K/M/B/T suffix "229K", "4.17M"
 *   usd    a dollar amount                "-$88.6B", "$1.25"
 *   plain  a bare number                  "57.1"
 * A bare number and a suffixed count are kept apart: nothing in the string
 * says whether "57.1" is an index level or a count, so they are never
 * compared with each other.
 */
export type MacroUnit = "pct" | "count" | "usd" | "plain";

export interface MacroFigure {
  /** The figure in ones (a count or dollars) or in percent points. Signed. */
  value: number;
  unit: MacroUnit;
  /** One unit in the last printed place: 0.1 for "0.3%", 1000 for "229K". */
  step: number;
}

const SUFFIX_SCALE: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  mn: 1_000_000,
  b: 1_000_000_000,
  bn: 1_000_000_000,
  t: 1_000_000_000_000,
};

// sign, "$", sign, digits (plain or comma-grouped), decimals, K/M/B/T, "%",
// and an optional trailing basis tag that is read past and not interpreted.
const FIGURE_RE =
  /^([+\-−–]?)\s*(\$?)\s*([+\-−–]?)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(bn|mn|[kmbt])?\s*(%?)(?:\s*(?:m\/m|mom|y\/y|yoy|q\/q|qoq|saar))?$/i;

/**
 * Parse one macro figure. The WHOLE string must be a single figure; a range,
 * a sentence, an earnings line ("EPS 2.00 ...") or anything else returns
 * null. No guessing.
 */
export function parseMacroFigure(raw: string | null | undefined): MacroFigure | null {
  if (typeof raw !== "string") return null;
  const m = FIGURE_RE.exec(raw.trim());
  if (!m) return null;
  const [, signBefore, dollar, signAfter, whole, decimals, suffix, percent] = m;
  if (signBefore && signAfter) return null;
  if (percent && (dollar || suffix)) return null;

  const places = decimals ? decimals.length : 0;
  if (places > 6) return null;
  const pow = 10 ** places;
  // Work in whole printed steps so "4.17M" is exactly 4,170,000.
  const steps = Number(`${whole.replace(/,/g, "")}${decimals ?? ""}`);
  if (!Number.isFinite(steps)) return null;
  const scale = suffix ? SUFFIX_SCALE[suffix.toLowerCase()] : 1;
  const sign = (signBefore || signAfter) && (signBefore || signAfter) !== "+" ? -1 : 1;

  const unit: MacroUnit = percent ? "pct" : dollar ? "usd" : suffix ? "count" : "plain";
  return { value: (sign * steps * scale) / pow, unit, step: scale / pow };
}

/** An actual is refused when it is MORE than this many times both yardsticks. */
export const MACRO_SIZE_LIMIT = 10;

/**
 * A yardstick is usable only when it is more than one printed step away from
 * zero. "0.0%" is zero; "0.1%" is one step from zero, so a ratio against it
 * is rounding noise ("0.14%" and "0.06%" both print as "0.1%"). The same
 * figure printed finer ("0.10%") is ten steps from zero and is usable.
 */
function isComparable(figure: MacroFigure): boolean {
  return Math.abs(figure.value) > figure.step * (1 + 1e-9);
}

/**
 * The size check (owner ruling 2026-10-08): "an actual more than ten times
 * both consensus and prior is refused and stored empty with a reason."
 *
 * Returns the reason when ALL of these hold, else null:
 *   - actual, consensus and previous each parse as one figure;
 *   - all three are in the SAME unit;
 *   - consensus and previous are both usable yardsticks (not zero and not
 *     within one printed step of zero): a near-zero yardstick is "not
 *     comparable", never an automatic refusal;
 *   - |actual| is more than ten times |consensus| AND more than ten times
 *     |previous|.
 *
 * Size is judged on absolute values; a sign flip alone is not a size problem.
 * The check never fires on a guess: a missing or unreadable figure, or mixed
 * units, means the actual stands.
 */
export function macroActualProblem(
  actual: string | null | undefined,
  consensus: string | null | undefined,
  previous: string | null | undefined,
): string | null {
  const a = parseMacroFigure(actual);
  const c = parseMacroFigure(consensus);
  const p = parseMacroFigure(previous);
  if (!a || !c || !p) return null;
  if (a.unit !== c.unit || a.unit !== p.unit) return null;
  if (!isComparable(c) || !isComparable(p)) return null;

  const size = Math.abs(a.value);
  const over = (yardstick: MacroFigure) =>
    size > MACRO_SIZE_LIMIT * Math.abs(yardstick.value) * (1 + 1e-9);
  if (!over(c) || !over(p)) return null;

  return (
    `Actual ${String(actual).trim()} is more than ten times both the consensus ` +
    `(${String(consensus).trim()}) and the previous reading (${String(previous).trim()}). ` +
    `It looks like a different basis or scale, so it was not stored.`
  );
}

/**
 * How a refusal travels on the Worker's cloud payload: the payload's `reason`
 * is this prefix followed by the sentence from macroActualProblem.
 */
export const ACTUAL_REFUSED_PREFIX = "actual_refused: ";

/** The refusal sentence carried by a payload `reason`, or null for any other reason. */
export function refusedReasonFromPayload(reason: unknown): string | null {
  if (typeof reason !== "string" || !reason.startsWith(ACTUAL_REFUSED_PREFIX)) return null;
  const text = reason.slice(ACTUAL_REFUSED_PREFIX.length).trim();
  return text === "" ? null : text;
}

/** How often a FRED series reports. Monthly unless its config says otherwise. */
export type MacroFrequency = "monthly" | "quarterly" | "weekly";

/**
 * The data period a FRED observation refers to, in the form stored in
 * calendar_events.reference_period:
 *   monthly    "2026-08"     (FRED dates a month by its first day)
 *   quarterly  "2026-Q2"     (FRED dates a quarter by its first day)
 *   weekly     "2026-08-29"  (the observation date itself, a week-ending day)
 * Read straight off the date string: no Date object, no time zone.
 */
export function referencePeriodFor(
  observationDate: string | null | undefined,
  frequency: MacroFrequency,
): string | null {
  if (typeof observationDate !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(observationDate);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (frequency === "weekly") return observationDate;
  if (frequency === "quarterly") return `${m[1]}-Q${Math.floor((month - 1) / 3) + 1}`;
  return `${m[1]}-${m[2]}`;
}

/** True for a string in one of the three stored reference-period forms. */
export function isReferencePeriod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-(?:(?:0[1-9]|1[0-2])|Q[1-4]|(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/.test(value)
  );
}
