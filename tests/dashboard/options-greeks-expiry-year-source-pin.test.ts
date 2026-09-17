import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Source pin for OptionsGreeksCard.tsx's option-expiry year fix.
 *
 * QA finding analysis-greeks--expiry-column-omits-year (MEDIUM): the
 * position cell rendered `{formatStrike} {optionType[0]} {formatExpiry}`
 * where the file-local formatExpiry printed bare month + day ("Sep 17").
 * Contracts expiring one year apart (e.g. an OCC 270917C… vs a 260917P…)
 * printed the SAME label — only the separate DTE column disambiguated them.
 * The fix moves expiry formatting to the shared lib/format/option-expiry.ts
 * helper (formatOptionExpiry), which always carries the four-digit year,
 * and deletes the file-local formatExpiry so there is exactly one copy of
 * this formatting logic in the component.
 *
 * No jsdom/RTL harness exists in this repo (see
 * reference_no_dom_test_harness_source_pin) — render assertions would be
 * vacuous, so this pins the source text instead. Pattern precedent:
 * tests/dashboard/all-holdings-unknown-basis-source-pin.test.ts.
 *
 * lib/compute/options-strategy.ts carries a SIBLING formatExpiry with the
 * same year omission — it is explicitly out of scope for this fix (left
 * alone tonight) and is not touched or asserted on here.
 */
describe("OptionsGreeksCard renders the option expiry with its year", () => {
  const src = () =>
    readFileSync("app/dashboard/components/OptionsGreeksCard.tsx", "utf8");

  it("imports formatOptionExpiry from the shared lib/format/option-expiry helper", () => {
    const text = src();
    expect(text).toMatch(
      /import\s*\{\s*formatOptionExpiry\s*\}\s*from\s*"@\/lib\/format\/option-expiry"/
    );
  });

  it("no longer defines a file-local formatExpiry", () => {
    const text = src();
    expect(text).not.toMatch(/function formatExpiry\s*\(/);
  });

  it("the position cell calls the shared formatOptionExpiry helper", () => {
    const text = src();
    expect(text).toMatch(
      /\{formatStrike\(p\.strike\)\}\s*\{p\.optionType\[0\]\}\s*\{formatOptionExpiry\(p\.expiration\)\}/
    );
  });
});
