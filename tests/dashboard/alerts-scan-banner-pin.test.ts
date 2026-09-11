/**
 * Ledger finding alerts-scan-now-banner--claims-monitoring-while-armed-rows-say-not-scanned:
 * clicking "Scan now" said "Your levels are still active and being monitored"
 * while the same page's Armed tab showed most rows "stale price · not
 * scanned" (getArmedLevels' price_is_stale, sourced from the SAME
 * SCAN_PRICE_IS_FRESH_SQL fragment / LEVEL_PRICE_MAX_AGE_DAYS window
 * findCrossedLevels uses to skip those rows).
 *
 * Round 2 (2026-09-11): the first fix disclosed only TWO of the scanner's
 * four skip conditions, so the banner could still say "evaluated 40 of 40"
 * while the Armed tab flagged rows "outside scan range". The banner now
 * reads all four buckets plus the server-derived totalSkipped/evaluated, and
 * names each reason with the shared label rather than lumping every skip
 * under "stale price".
 *
 * This is a SOURCE SCAN, not a render test — this repo has no jsdom/RTL
 * harness. It pins: (1) the banner reads every coverage field
 * detectAndFireAlerts ships, (2) it imports shared constants/labels rather
 * than literals or re-typed copies, (3) it never re-derives the skip
 * arithmetic itself, (4) counts render through the privacy <Count>, and
 * (5) the old blanket reassurance text is reachable ONLY when nothing was
 * skipped.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
}

const ALERTS_PAGE = "app/dashboard/alerts/page.tsx";

describe("alerts page — Scan now banner discloses skipped coverage", () => {
  const src = read(ALERTS_PAGE);

  it("imports the shared freshness constant and both skip labels (never a literal 4 or re-typed copy)", () => {
    for (const name of [
      "LEVEL_PRICE_MAX_AGE_DAYS",
      "STALE_PRICE_LABEL",
      "BEYOND_SCAN_RANGE_LABEL",
    ]) {
      expect(src).toMatch(
        new RegExp(
          `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']@/lib/levels/scan-range["']`,
        ),
      );
    }
  });

  it("destructures every coverage field from the detect response, defaulting to 0", () => {
    for (const field of [
      "armed",
      "skippedStale",
      "unpriced",
      "skippedOutOfBand",
      "unresolvedMa",
      "totalSkipped",
      "evaluated",
    ]) {
      expect(src).toMatch(new RegExp(`\\b${field}\\s*=\\s*0`));
    }
  });

  it("never re-derives the skip arithmetic in the UI — totalSkipped/evaluated come from the server", () => {
    // The round-1 bug was exactly this sum, written here, missing two
    // buckets. countScanCoverage owns it now.
    expect(src).not.toMatch(/const\s+totalSkipped\s*=/);
    expect(src).not.toMatch(/const\s+evaluated\s*=/);
  });

  it("names each skip reason separately instead of lumping them under stale price", () => {
    expect(src).toContain("skipReasons");
    expect(src).toContain("{LEVEL_PRICE_MAX_AGE_DAYS} days ({STALE_PRICE_LABEL})");
    expect(src).toContain("{BEYOND_SCAN_RANGE_LABEL}");
    expect(src).toContain("with no price at all");
    expect(src).toMatch(/moving-average levels with too\s*\n?\s*little bar history/);
  });

  it("renders every banner count through the privacy <Count> component", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bCount\b[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/,
    );
    for (const field of [
      "evaluated",
      "armed",
      "totalSkipped",
      "skippedStale",
      "unpriced",
      "skippedOutOfBand",
      "unresolvedMa",
      "fired",
      "deduped",
      "scanned",
    ]) {
      expect(src).toContain(`<Count value={${field}} />`);
    }
  });

  it("keeps the 'evaluated N of M armed levels' framing", () => {
    expect(src).toMatch(
      /evaluated <Count value=\{evaluated\} \/> of\{" "\}\s*\n\s*<Count value=\{armed\} \/> armed level/,
    );
  });

  it("the old blanket reassurance ('still active and being monitored') is guarded by totalSkipped === 0, i.e. unreachable when anything was skipped", () => {
    const reassuranceIdx = src.indexOf("Your levels are still active and being monitored");
    expect(reassuranceIdx).toBeGreaterThan(-1);

    // Walk backward from the reassurance string to the nearest ternary
    // condition guarding it, and confirm it's gated on totalSkipped (not a
    // bare `scanned === 0` with no skip check).
    const window = src.slice(Math.max(0, reassuranceIdx - 1400), reassuranceIdx);
    expect(window).toMatch(/totalSkipped\s*>\s*0\s*\?/);
  });

  it("keeps the fired > 0 and already-alerted-today branches present and unchanged in wording", () => {
    expect(src).toMatch(/new alert\s*\n?\s*\{fired === 1 \? "" : "s"\} fired/);
    expect(src).toContain("already alerted today; nothing new to");
  });
});
