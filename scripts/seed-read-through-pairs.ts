/**
 * Seed read_through_pairs with the user's curated set as of 2026-05-02.
 *
 * Idempotent: uses INSERT OR IGNORE against UNIQUE(reporter_symbol, target_symbol),
 * so re-running adds new pairs without disturbing existing ones.
 *
 * Usage:
 *   npx tsx scripts/seed-read-through-pairs.ts          # write
 *   npx tsx scripts/seed-read-through-pairs.ts --dry-run # preview only
 *
 * Plan: docs/plans/2026-05-02-stock-to-stock-read-throughs.md
 * Migration: lib/db/migrations/044_read_through_pairs.sql
 */

import { db } from "../lib/db";

interface DirectedPair {
  reporter: string;
  target: string;
  hypothesis: string;
  groupLabel?: string;
  weight?: number;
}

const dryRun = process.argv.includes("--dry-run");

// ── Directed pairs (1 reporter → 1 target) ────────────────────────────
const directed: DirectedPair[] = [
  {
    reporter: "PRTO",
    target: "XMTR",
    hypothesis:
      "Both run on-demand digital manufacturing platforms (CNC, 3D-printing, sheet metal). Their order books move on the same industrial-CapEx cycle and component-shortage signals; PRTO's beat/miss + guide are a leading read on XMTR's quarter.",
    weight: 1.0,
  },
  {
    reporter: "HUN",
    target: "LIN",
    hypothesis:
      "Huntsman (specialty chemicals) and Linde (industrial gases) both ride the same global industrial-demand pulse — auto, construction, electronics. HUN's volume + ASP commentary is a leading indicator for LIN's quarterly tone.",
    weight: 0.7,
  },
];

// ── Ad-platform cluster ────────────────────────────────────────────────
// User listed: GOOGL, META, APP, RDDT (and "etc"). Seed the explicit four
// for now; add PINS / SNAP / TTD in a follow-up if the cluster proves
// useful. With 4 members, fan-out = 4 * 3 = 12 directed pairs.
const adCluster = ["GOOGL", "META", "APP", "RDDT"] as const;
const adClusterPairs: DirectedPair[] = [];
for (const reporter of adCluster) {
  for (const target of adCluster) {
    if (reporter === target) continue;
    adClusterPairs.push({
      reporter,
      target,
      hypothesis:
        "Both monetize digital advertising; print-time commentary on ad-pricing trends, brand vs. performance mix, and platform-specific ROAS reads across to peers in the same buying cycle.",
      groupLabel: "ad-platform-2026",
      weight: 0.85,
    });
  }
}

const allPairs: DirectedPair[] = [...directed, ...adClusterPairs];

console.log(`[seed] ${allPairs.length} pairs queued (${directed.length} directed + ${adClusterPairs.length} cluster fan-out)`);

if (dryRun) {
  console.log("[seed] --dry-run — not writing");
  for (const p of allPairs) {
    console.log(
      `  ${p.reporter} → ${p.target}` +
        (p.groupLabel ? ` (${p.groupLabel}, w=${p.weight ?? 1})` : ` (w=${p.weight ?? 1})`),
    );
  }
  process.exit(0);
}

const stmt = db.prepare(
  `INSERT OR IGNORE INTO read_through_pairs
     (reporter_symbol, target_symbol, hypothesis, group_label, weight)
   VALUES (?, ?, ?, ?, ?)`,
);

let inserted = 0;
let skipped = 0;
for (const p of allPairs) {
  const result = stmt.run(p.reporter, p.target, p.hypothesis, p.groupLabel ?? null, p.weight ?? 1.0);
  if (result.changes > 0) {
    inserted++;
    console.log(`  + ${p.reporter} → ${p.target}`);
  } else {
    skipped++;
  }
}

console.log(`[seed] inserted=${inserted} skipped=${skipped} (already present)`);
