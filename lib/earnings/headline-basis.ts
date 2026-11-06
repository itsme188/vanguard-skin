/**
 * The basis of the stored headline EPS actual (T1 slice 2).
 *
 * `calendar_events.actual_value` carries no basis. It is read back here:
 *   - an unstamped row (`manual_actuals_at` null) holds the vendor feed's own
 *     figure: `vendor`;
 *   - a stamped row was promoted from the print-watch sheet or hand-entered.
 *     The promote route prefers the accepted ADJUSTED EPS line and falls back
 *     to the accepted GAAP line (app/api/print-watch/accept/route.ts), so the
 *     sheet says which one the stored figure is: the line whose accepted value
 *     equals the stored EPS (adjusted first). Nothing matches, or no sheet
 *     (a hand-entered figure): `non_gaap`, because the 2026-10-08 ruling
 *     labels a worksheet or hand-entered figure "adjusted"
 *     (lib/earnings/actuals-basis.ts).
 *
 * Revenue has no GAAP/adjusted distinction (`na`) and is always scorable.
 * PURE READ.
 */
import type Database from "better-sqlite3";
import { getPrintByEventId, getSheet } from "@/lib/print-watch/store";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import type { FigureBasis } from "@/lib/earnings/basis-scoring";

export function resolveEpsActualBasis(
  db: Database.Database,
  event: { id: number; actual_value: string | null; manual_actuals_at?: string | null },
): FigureBasis {
  if (!event.manual_actuals_at) return "vendor";
  const stored = parseFinnhubFigure(event.actual_value).eps;
  if (stored === null) return "non_gaap";
  try {
    const print = getPrintByEventId(db, event.id);
    if (!print) return "non_gaap";
    const lines = getSheet(db, print.id);
    const accepted = (id: string) => {
      const l = lines.find((x) => x.metric_id === id);
      return l && l.state === "accepted" && l.value !== null ? l.value : null;
    };
    const same = (v: number | null) => v !== null && Math.abs(v - stored) < 0.005;
    if (same(accepted("eps_adj_q"))) return "non_gaap";
    if (same(accepted("eps_gaap_q"))) return "gaap";
  } catch (err) {
    // A sheet that cannot be read leaves the ruling's default, never a guess at GAAP.
    console.warn(
      `[headline-basis] sheet read failed for event ${event.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return "non_gaap";
}
