/**
 * Manually sync the calendar (macro + Finnhub earnings + Nasdaq cross-check)
 * for one or more weeks. Use when the automated Sunday sync hasn't covered a
 * week yet — e.g. the 2026-07 earnings-season ramp where weeks 07-06 and
 * 07-13 had zero events (audit: docs/plans/2026-07-04-earnings-season-audit.md).
 *
 * Usage:
 *   npx tsx scripts/sync-calendar-weeks.ts 2026-07-06 2026-07-13
 *
 * Each argument must be a Monday (validateWeekOf enforces this).
 * WSH (TWS) is skipped explicitly — this is a headless CLI path.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { syncCalendarForWeek } from "../lib/calendar/sync";

async function main() {
  const weeks = process.argv.slice(2);
  if (weeks.length === 0) {
    console.error("Usage: npx tsx scripts/sync-calendar-weeks.ts <monday-YYYY-MM-DD> [...]");
    process.exit(1);
  }

  for (const weekOf of weeks) {
    console.log(`— syncing week ${weekOf}`);
    const result = await syncCalendarForWeek(db, weekOf, {
      includeWsh: false,
      onProgress: (e) => console.log(`  [${e.phase}] ${e.message}`),
    });
    console.log(
      `  finnhub ${result.finnhubEvents} (${result.finnhubNew} new) · ` +
        `nasdaq ${result.nasdaqEvents} (${result.nasdaqNew} new) · ` +
        `macro ${result.macroEvents} (${result.macroNew} new) · ` +
        `errors: ${result.errors.length ? result.errors.join("; ") : "none"}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
