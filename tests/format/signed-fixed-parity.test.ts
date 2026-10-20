/**
 * Round-then-sign, one rule on both sides (TODO 2026-10-12 follow-up (a)).
 *
 *   Mac:    lib/format/signed-fixed.ts
 *   Worker: workers/cron/src/signed-fixed.ts (hand-mirrored, import-free)
 *
 * The sign belongs to the ROUNDED figure: a value that rounds to zero prints
 * with no sign ("0.0%", "$0.00"), never "-0.0%", "+0.0%" or "$-0.00". The
 * minus of a dollar figure goes before the "$" ("-$0.05").
 *
 * Three links, so drift anywhere fails:
 *   1. the two files are byte-identical below their header comment;
 *   2. both helpers give the same string over one table of inputs;
 *   3. the pinned answers, plus "every non-zero output is byte-identical to the
 *      old sign-then-toFixed formula" (only the rounds-to-zero case and the
 *      dollar minus placement changed).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as mac from "@/lib/format/signed-fixed";
import * as worker from "@/workers/cron/src/signed-fixed";

function stripHeader(source: string): string {
  return source.split("*/").slice(1).join("*/");
}

const VALUES = [
  0, -0, 0.04, -0.04, 0.049, -0.049, 0.05, -0.05, 0.06, -0.06,
  0.004, -0.004, 0.005, -0.005, 0.0051, -0.0051, 0.0049, -0.0049,
  0.4, -0.4, 0.5, -0.5, 0.6, -0.6, 1.26, -1.26, 99.95, -99.95,
  123.456, -123.456, 1e-12, -1e-12, 1e21, -1e21,
  Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
];
const DIGITS = [0, 1, 2];
const OPTION_SETS: mac.SignedFixedOptions[] = [
  {},
  { suffix: "%" },
  { prefix: "$" },
  { prefix: "$", plus: false },
  { suffix: "%", plus: false },
];

describe("signed-fixed parity (Mac lib/format/signed-fixed.ts ↔ Worker mirror)", () => {
  it("files are byte-identical below the header", () => {
    const macSrc = stripHeader(
      readFileSync(new URL("../../lib/format/signed-fixed.ts", import.meta.url), "utf-8"),
    );
    const workerSrc = stripHeader(
      readFileSync(new URL("../../workers/cron/src/signed-fixed.ts", import.meta.url), "utf-8"),
    );
    expect(workerSrc).toBe(macSrc);
  });

  it("gives the same string for every input in the table", () => {
    for (const v of VALUES) {
      for (const d of DIGITS) {
        for (const opts of OPTION_SETS) {
          expect(worker.signedFixed(v, d, opts), `${v} / ${d} / ${JSON.stringify(opts)}`).toBe(
            mac.signedFixed(v, d, opts),
          );
        }
        expect(worker.signedPct(v, d)).toBe(mac.signedPct(v, d));
        expect(worker.signedUsd(v, d)).toBe(mac.signedUsd(v, d));
      }
    }
  });
});

describe("signedFixed rule", () => {
  it("a figure that rounds to zero carries no sign", () => {
    expect(mac.signedPct(-0.04, 1)).toBe("0.0%");
    expect(mac.signedPct(0.04, 1)).toBe("0.0%");
    expect(mac.signedPct(0, 1)).toBe("0.0%");
    expect(mac.signedPct(-0, 1)).toBe("0.0%");
    expect(mac.signedPct(-0.004, 2)).toBe("0.00%");
    expect(mac.signedPct(-1e-12, 2)).toBe("0.00%");
    expect(mac.signedUsd(-0.004, 2)).toBe("$0.00");
    expect(mac.signedUsd(0.004, 2)).toBe("$0.00");
    expect(mac.signedFixed(-0.004, 2, { prefix: "$", plus: false })).toBe("$0.00");
  });

  it("otherwise the sign of the figure, with a dollar minus before the $", () => {
    expect(mac.signedPct(-0.06, 1)).toBe("-0.1%");
    expect(mac.signedPct(0.06, 1)).toBe("+0.1%");
    expect(mac.signedPct(1.26, 1)).toBe("+1.3%");
    expect(mac.signedPct(-1.26, 2)).toBe("-1.26%");
    expect(mac.signedUsd(-0.05, 2)).toBe("-$0.05");
    expect(mac.signedUsd(0.05, 2)).toBe("+$0.05");
    expect(mac.signedFixed(1.2, 2, { prefix: "$", plus: false })).toBe("$1.20");
    expect(mac.signedFixed(-1.2, 2, { prefix: "$", plus: false })).toBe("-$1.20");
  });

  it("a non-finite value keeps the old shape", () => {
    expect(mac.signedPct(Number.NaN, 1)).toBe("NaN%");
    expect(mac.signedPct(Number.POSITIVE_INFINITY, 1)).toBe("+Infinity%");
    expect(mac.signedPct(Number.NEGATIVE_INFINITY, 1)).toBe("-Infinity%");
  });

  it("every figure that does not round to zero prints exactly what the old formula printed", () => {
    for (const v of VALUES) {
      for (const d of DIGITS) {
        if (Number(Math.abs(v).toFixed(d)) === 0) continue;
        const oldPct = `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
        expect(mac.signedPct(v, d), `${v} / ${d}`).toBe(oldPct);
        // Old dollar shape put the minus after the "$"; only that moved.
        const oldUsd = `${v >= 0 ? "+" : ""}$${v.toFixed(d)}`.replace("$-", "-$");
        expect(mac.signedUsd(v, d), `${v} / ${d}`).toBe(oldUsd);
        const oldUnsignedUsd = `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`;
        expect(mac.signedFixed(v, d, { prefix: "$", plus: false }), `${v} / ${d}`).toBe(oldUnsignedUsd);
      }
    }
  });
});
