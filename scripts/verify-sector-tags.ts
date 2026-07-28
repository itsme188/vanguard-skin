/**
 * Web-search-verified GICS sector sweep (dry-run by default).
 *   npx tsx scripts/verify-sector-tags.ts               # dry-run, unverified rows
 *   npx tsx scripts/verify-sector-tags.ts --apply       # write + stamp
 *   npx tsx scripts/verify-sector-tags.ts --all         # include already-verified rows
 *   npx tsx scripts/verify-sector-tags.ts --apply UNH AMZN   # re-verify named symbols
 */

import { db } from "../lib/db";
import { runSectorVerification } from "../lib/securities/verify-sector-tags";

const KNOWN_FLAGS = new Set(["--apply", "--all"]);

async function main() {
  const args = process.argv.slice(2);

  // Any arg starting with "-" that isn't a recognized flag is almost
  // certainly a typo (e.g. "-apply" for "--apply") rather than a symbol —
  // real ticker symbols never start with a dash. Silently letting it fall
  // through to the symbol filter means the sweep would run scoped to a
  // single bogus "-apply" symbol instead of applying, with no error.
  const unknownFlags = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknownFlags.length > 0) {
    console.error(
      `Unknown flag(s): ${unknownFlags.join(", ")}. Expected --apply and/or --all (single-dash typos like "-apply" are rejected, not treated as a symbol filter).`,
    );
    process.exit(1);
  }

  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const symbols = args.filter((a) => !a.startsWith("-"));

  console.log(
    `Running sector verification sweep (${apply ? "APPLY" : "dry-run"}${all ? ", all rows" : ""}${
      symbols.length > 0 ? `, symbols: ${symbols.join(", ")}` : ""
    })...`,
  );

  const result = await runSectorVerification(db, {
    apply,
    all,
    symbols: symbols.length > 0 ? symbols : undefined,
  });

  const changed = result.rows.filter((r) => r.changed);
  const confirmed = result.rows.filter((r) => !r.changed);

  if (changed.length > 0) {
    console.log("\nSYMBOL  old → new  (rationale)");
    for (const r of changed) {
      console.log(`${r.symbol.padEnd(8)}${r.oldSector ?? "—"} → ${r.newSector}  (${r.rationale})`);
    }
  }
  console.log(`\nconfirmed: ${confirmed.length}`);

  if (result.unresolved.length > 0) {
    console.log("\nUnresolved:");
    for (const u of result.unresolved) {
      console.log(`  ${u.symbol}: ${u.reason}`);
    }
  }

  console.log(`\noption rows synced: ${result.optionRowsUpdated}`);

  if (apply) {
    console.log(`
Next steps:
  1. npx tsx scripts/reprocess-sector-etf-gaps.ts        (re-map reaction-snapshot gaps)
  2. Force-regen macro themes: POST /api/analysis/macro-themes {scope} per scope
  3. Analysis narratives self-refresh weekly — no action
  4. Browser-check Defense tab + Analysis allocation + a repaired name's Security Detail`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
