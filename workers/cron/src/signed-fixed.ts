/**
 * Round-then-sign fixed-point formatting. Import-free on purpose.
 *
 * The sign belongs to the ROUNDED figure: a value that rounds to zero at the
 * requested precision prints with no sign at all ("0.0%", "$0.00"), never
 * "-0.0%" / "+0.0%" / "$-0.00". Otherwise a negative prints "-" and, unless
 * `plus: false`, a positive prints "+". The sign always sits before the
 * prefix, so a dollar figure reads "-$0.05" / "+$0.05".
 *
 * The digits are exactly `Math.abs(value).toFixed(digits)`, which is the same
 * digit string `value.toFixed(digits)` prints after its own minus. A
 * non-finite value keeps the old shape ("NaN%", "+Infinity%", "-Infinity%").
 *
 * PARITY: hand-mirrored from lib/format/signed-fixed.ts and pinned by
 * tests/format/signed-fixed-parity.test.ts. Change both files together and
 * deploy the Worker with the change.
 */
export interface SignedFixedOptions {
  /** Printed between the sign and the digits, e.g. "$". */
  prefix?: string;
  /** Printed after the digits, e.g. "%". */
  suffix?: string;
  /** Print "+" for a positive figure (default true). */
  plus?: boolean;
}

export function signedFixed(
  value: number,
  digits: number,
  options: SignedFixedOptions = {},
): string {
  const { prefix = "", suffix = "", plus = true } = options;
  const body = Math.abs(value).toFixed(digits);
  const roundsToZero = Number(body) === 0;
  const sign = roundsToZero ? "" : value < 0 ? "-" : value > 0 && plus ? "+" : "";
  return `${sign}${prefix}${body}${suffix}`;
}

/** Signed percent: `signedPct(1.234, 1)` → "+1.2%", `signedPct(-0.04, 1)` → "0.0%". */
export function signedPct(value: number, digits: number): string {
  return signedFixed(value, digits, { suffix: "%" });
}

/** Signed dollars: `signedUsd(-0.05, 2)` → "-$0.05", `signedUsd(-0.004, 2)` → "$0.00". */
export function signedUsd(value: number, digits: number): string {
  return signedFixed(value, digits, { prefix: "$" });
}
