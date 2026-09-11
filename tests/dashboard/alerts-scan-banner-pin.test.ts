/**
 * Ledger finding alerts-scan-now-banner--claims-monitoring-while-armed-rows-say-not-scanned:
 * clicking "Scan now" said "Your levels are still active and being monitored"
 * while the same page's Armed tab showed most rows "stale price · not
 * scanned" (getArmedLevels' price_is_stale, sourced from the SAME
 * SCAN_PRICE_IS_FRESH_SQL fragment / LEVEL_PRICE_MAX_AGE_DAYS window
 * findCrossedLevels uses to skip those rows).
 *
 * This is a SOURCE SCAN, not a render test — this repo has no jsdom/RTL
 * harness. It pins: (1) the banner reads detectAndFireAlerts' new coverage
 * fields, (2) it imports the shared constant/label rather than a literal
 * "4"/re-typed copy, and (3) the old blanket reassurance text is reachable
 * ONLY when nothing was skipped, so it can never again claim "still active
 * and being monitored" while the Armed tab is showing stale-price chips.
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

  it("imports the shared freshness constant and stale-price label (never a literal 4 or re-typed copy)", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bLEVEL_PRICE_MAX_AGE_DAYS\b[^}]*\}\s*from\s*["']@\/lib\/levels\/scan-range["']/,
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\bSTALE_PRICE_LABEL\b[^}]*\}\s*from\s*["']@\/lib\/levels\/scan-range["']/,
    );
  });

  it("destructures the new coverage fields from the detect response, defaulting to 0", () => {
    expect(src).toMatch(/armed\s*=\s*0/);
    expect(src).toMatch(/skippedStale\s*=\s*0/);
    expect(src).toMatch(/unpriced\s*=\s*0/);
  });

  it("the new 'evaluated N of M' copy quotes the shared constant and label, not a literal", () => {
    expect(src).toContain("evaluated ${evaluated} of ${armed} armed level");
    expect(src).toContain("${LEVEL_PRICE_MAX_AGE_DAYS} days (${STALE_PRICE_LABEL})");
    expect(src).toContain("have no price yet");
  });

  it("the old blanket reassurance ('still active and being monitored') is guarded by totalSkipped === 0, i.e. unreachable when anything was skipped", () => {
    const reassuranceIdx = src.indexOf("Your levels are still active and being monitored");
    expect(reassuranceIdx).toBeGreaterThan(-1);

    // Walk backward from the reassurance string to the nearest ternary
    // condition guarding it, and confirm it's gated on totalSkipped (not a
    // bare `scanned === 0` with no skip check).
    const window = src.slice(Math.max(0, reassuranceIdx - 900), reassuranceIdx);
    expect(window).toMatch(/totalSkipped\s*>\s*0\s*\n?\s*\?/);
  });

  it("keeps the fired > 0 and already-alerted-today branches present and unchanged in wording", () => {
    expect(src).toContain("new alert${fired === 1 ? \"\" : \"s\"} fired");
    expect(src).toContain("already alerted today; nothing new to report.");
  });
});
