/**
 * Smoke-test for A3 (deterministic macro-exposure lists).
 * Reads the live DB, builds macro-exposure lists for week-of 2026-04-27,
 * and prints what each macro event will see — verifies XMTR appears under
 * ISM Manufacturing.
 *
 * Run: npx tsx scripts/verify-a3-macro-exposures.ts
 */
import Database from "better-sqlite3";
import { buildMacroExposures } from "@/lib/calendar/briefing";
import { getEventsByWeek } from "@/lib/queries/calendar";

const db = new Database("data/vanguard.db", { readonly: true });

const events = getEventsByWeek(db, "2026-04-27");
const otherEvents = events.filter(
  (e) => e.source !== "finnhub" && !(e.source === "wsh" && e.event_type === "earnings"),
);

const exposures = buildMacroExposures(db, otherEvents);

console.log(`# Macro events with computed exposures: ${exposures.size}/${otherEvents.length}`);
console.log("");

for (const e of otherEvents) {
  const exp = e.id != null ? exposures.get(e.id) : undefined;
  if (!exp) {
    console.log(`${e.title} (${e.event_date}, ${e.event_type}): no exposure mapping`);
    continue;
  }
  console.log(`${e.title} (${e.event_date}):`);
  console.log(`  basis: ${exp.basis}`);
  console.log(`  symbols (${exp.symbols.length}): ${exp.symbols.join(", ")}`);
  console.log("");
}

db.close();
