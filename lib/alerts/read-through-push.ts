/**
 * Live read-through pairs for a printing reporter (#13).
 *
 * Feeds the widened push-at-print gate: a reporter that is neither held nor
 * watchlisted still pushes when it has ≥1 pair whose TARGET is currently
 * held/watchlist. Pairs whose target was exited contribute nothing — the
 * gate narrows itself as positions close.
 *
 * Spec: docs/superpowers/specs/2026-07-16-read-through-push-design.md
 */

import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import type { PrintPushReadThrough } from "./print-push-message";

const LIVE_PAIR_CAP = 3;

export function getLiveReadThroughsForReporter(
  db: Database.Database,
  symbol: string,
): PrintPushReadThrough[] {
  const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
  const placeholders = family.map(() => "?").join(",");
  const pairs = db
    .prepare(
      `SELECT target_symbol, weight, hypothesis FROM read_through_pairs
        WHERE UPPER(reporter_symbol) IN (${placeholders})
        ORDER BY weight DESC, target_symbol ASC`,
    )
    .all(...family) as { target_symbol: string; weight: number; hypothesis: string | null }[];
  if (pairs.length === 0) return [];

  const status = getSymbolStatus(
    db,
    pairs.map((p) => p.target_symbol),
  );
  return pairs
    .map((p) => ({ pair: p, st: status[p.target_symbol.toUpperCase()] }))
    .filter((x) => x.st === "held" || x.st === "watchlist")
    .slice(0, LIVE_PAIR_CAP)
    .map((x) => ({
      target: x.pair.target_symbol.toUpperCase(),
      targetStatus: x.st === "held" ? "held" : "watchlist",
      hypothesis: x.pair.hypothesis,
    }));
}
