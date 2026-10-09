/**
 * repair-alert-suggestions.ts — one-time repair for stored alert advice that
 * quotes a moving-average price the card no longer shows.
 *
 * Finding: alerts-inbox--ma-alert-card-shows-stale-creation-price-and-ai-repeats-it
 * (regression-2). The advice sentence was written against the level's creation
 * snapshot and frozen in level_alerts.suggested_action; the card now shows the
 * real threshold, and the bulk suggest pass skips non-NULL rows.
 *
 * What it does: lists MA-sourced alerts (price_source sma_* / ema_*) whose
 * stored advice quotes at least one price that is neither the card's threshold
 * nor the price the alert fired at, and does not quote the threshold. With
 * --apply --acknowledge-repair it sets suggested_action to NULL for exactly
 * those rows, so the next suggest pass (or the card's "Regenerate advice"
 * button) refills them. It makes NO AI call. Idempotent: a cleared row is no
 * longer listed. Dry run by default.
 *
 * "The card's threshold" is the same figure buildSuggestionContext uses:
 * recorded threshold_price, else the live resolved MA, else the level price.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/repair-alert-suggestions.ts
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-alert-suggestions.ts --apply --acknowledge-repair
 */
import path from "node:path";
import Database from "better-sqlite3";
import { buildSuggestionContext } from "../lib/alerts/generate-suggestion";
import { formatLevelPrice } from "../lib/chart/price-formatter";

export const ACK_FLAG = "--acknowledge-repair";

export function assertRepairAcknowledged(argv: string[], apply: boolean): void {
  if (apply && !argv.includes(ACK_FLAG)) {
    throw new Error(
      `--apply clears stored advice; re-run with ${ACK_FLAG} to confirm. (A dry run needs no flag.)`,
    );
  }
}

export interface QuotedPrice {
  value: number;
  decimals: number;
}

/** Price-looking numbers in prose: "$1,234.50", "$147", or a bare "98.25". */
export function quotedPrices(text: string): QuotedPrice[] {
  const out: QuotedPrice[] = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)|(?<![\d.,$])(\d[\d,]*\.\d{2,})(?![\d])/g;
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[2]).replace(/,/g, "");
    const dot = raw.indexOf(".");
    out.push({ value: Number(raw), decimals: dot === -1 ? 0 : raw.length - dot - 1 });
  }
  return out;
}

/** True when the quoted figure is `target` at the precision the prose used. */
function matches(q: QuotedPrice, target: number): boolean {
  const f = 10 ** q.decimals;
  return Math.round(q.value * f) === Math.round(target * f);
}

export interface StaleAdvice {
  alertId: number;
  symbol: string;
  currency: string | null;
  threshold: number;
  advice: string;
}

export function findStaleMaAdvice(db: Database.Database): StaleAdvice[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.suggested_action AS advice, a.triggered_price, s.symbol, s.currency
       FROM level_alerts a
       JOIN security_levels sl ON sl.id = a.level_id
       JOIN securities s ON s.id = a.security_id
       WHERE a.suggested_action IS NOT NULL
         AND (sl.price_source LIKE 'sma\\_%' ESCAPE '\\' OR sl.price_source LIKE 'ema\\_%' ESCAPE '\\')
       ORDER BY a.id`,
    )
    .all() as {
    id: number;
    advice: string;
    triggered_price: number;
    symbol: string;
    currency: string | null;
  }[];

  const stale: StaleAdvice[] = [];
  for (const r of rows) {
    const ctx = buildSuggestionContext(db, r.id);
    if (!ctx) continue;
    const quoted = quotedPrices(r.advice);
    if (quoted.length === 0) continue;
    if (quoted.some((q) => matches(q, ctx.levelPrice))) continue;
    const foreign = quoted.some((q) => !matches(q, r.triggered_price));
    if (!foreign) continue;
    stale.push({
      alertId: r.id,
      symbol: r.symbol,
      currency: r.currency,
      threshold: ctx.levelPrice,
      advice: r.advice,
    });
  }
  return stale;
}

/** Clears the flagged rows' advice. Returns how many rows it cleared. No AI call. */
export function clearStaleAdvice(db: Database.Database): number {
  const ids = findStaleMaAdvice(db).map((r) => r.alertId);
  if (ids.length === 0) return 0;
  const clear = db.prepare("UPDATE level_alerts SET suggested_action = NULL WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) clear.run(id);
  })();
  return ids.length;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  assertRepairAcknowledged(process.argv, apply);
  const dbPath = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  try {
    const stale = findStaleMaAdvice(db);
    console.log(`${apply ? "APPLY" : "DRY RUN"} on ${dbPath}`);
    console.log(`${stale.length} moving-average alert(s) with advice that quotes a stale price.`);
    for (const r of stale) {
      console.log(
        `  alert ${r.alertId} ${r.symbol}: card threshold ${formatLevelPrice(r.currency, r.threshold)}; advice: ${r.advice}`,
      );
    }
    if (!apply) {
      console.log(`Nothing changed. Re-run with --apply ${ACK_FLAG} to clear these.`);
      return;
    }
    const cleared = clearStaleAdvice(db);
    console.log(
      `Cleared ${cleared} row(s). No AI call was made; the next suggest pass or the card's Regenerate advice button refills them.`,
    );
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes("repair-alert-suggestions")) main();
