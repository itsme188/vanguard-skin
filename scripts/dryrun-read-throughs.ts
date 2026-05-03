/**
 * Dry-run the read-throughs block render against real DB data, without
 * calling Sonnet. Pass an event id; the script builds the same context
 * the composer would build and prints the rendered "## Read-throughs"
 * markdown block (or a notice that none rendered).
 *
 * Usage: npx tsx scripts/dryrun-read-throughs.ts <eventId>
 */

import { db } from "../lib/db";
import {
  buildReadThroughEntries,
  renderReadThroughsBlock,
} from "../lib/digest/send-earnings-email";
import { issuerSiblings } from "../lib/securities/issuer-family";

const eventId = Number(process.argv[2]);
if (!Number.isFinite(eventId)) {
  console.error("usage: npx tsx scripts/dryrun-read-throughs.ts <eventId>");
  process.exit(1);
}

const ev = db
  .prepare(
    `SELECT id, symbol, event_date, event_type FROM calendar_events WHERE id = ?`,
  )
  .get(eventId) as
  | { id: number; symbol: string | null; event_date: string; event_type: string }
  | undefined;

if (!ev) {
  console.error(`event id=${eventId} not found`);
  process.exit(1);
}

console.log(
  `Event: id=${ev.id} symbol=${ev.symbol} date=${ev.event_date} type=${ev.event_type}\n`,
);

const family = issuerSiblings(ev.symbol ?? "");
console.log(`Family (issuerSiblings): ${family.join(", ")}\n`);

const entries = buildReadThroughEntries(db, family, ev.event_date);
console.log(`Matched read-through entries: ${entries.length}\n`);

if (entries.length === 0) {
  console.log("No read-throughs would render for this event.");
  process.exit(0);
}

const block = renderReadThroughsBlock({
  symbol: (ev.symbol ?? "").toUpperCase(),
  readThroughs: entries,
});

console.log("─".repeat(60));
console.log("Rendered prompt block:");
console.log("─".repeat(60));
console.log(block);
