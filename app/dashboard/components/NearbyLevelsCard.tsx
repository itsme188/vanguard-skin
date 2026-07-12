import Link from "next/link";
import type { LevelNearPrice } from "@/lib/queries/briefing-levels";
import { Money, Pct } from "@/lib/privacy/components";

/**
 * Overview card surfacing active levels within ~5% of the current price.
 * Reuses `getLevelsNearPrice` — the same query that powers the weekly briefing
 * section — so the user's daily snapshot and the Sunday email stay in sync.
 *
 * Auto-hides when no levels are nearby, so users without any armed levels
 * don't see an empty card.
 */
export function NearbyLevelsCard({ levels }: { levels: LevelNearPrice[] }) {
  if (levels.length === 0) return null;

  // Cap the visible list — past 8 it just becomes noise. Rest is one click away.
  const visible = levels.slice(0, 8);
  const overflow = levels.length - visible.length;

  return (
    <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
      <div className="mb-2 flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-medium text-ink">Levels within 5% of current price</h2>
          <p className="text-[11px] text-ink-faint mt-0.5">
            Armed levels close to triggering. The nearest one is most likely to fire next.
          </p>
        </div>
        <span className="text-[11px] text-ink-faint font-mono">{levels.length}</span>
      </div>
      <ul className="divide-y divide-edge">
        {visible.map((l) => (
          <li key={l.level_id} className="py-2 flex items-baseline gap-3 text-[11px]">
            <Link
              href={`/dashboard/security/${l.security_id}`}
              className="font-mono text-[11px] font-medium text-ink hover:text-gold w-14 shrink-0"
            >
              {l.symbol}
            </Link>
            <span className="flex-1 min-w-0 flex items-baseline gap-2 flex-wrap">
              <span className="text-ink-dim uppercase">
                {l.level_type.replace("_", " ")}
              </span>
              <span className="text-ink font-mono">@ <Money value={l.level_price} precise /></span>
              {l.source_author && (
                <span className="text-ink-faint italic">— {l.source_author}</span>
              )}
            </span>
            <span className={`font-mono shrink-0 ${distanceColor(l.distance_pct)}`}>
              {l.distance_pct > 0 ? "↑" : "↓"} <Pct value={Math.abs(l.distance_pct) * 100} digits={1} />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between gap-2">
        {overflow > 0 ? (
          <span className="text-[10px] text-ink-faint">+{overflow} more</span>
        ) : (
          <span />
        )}
        <Link
          href="/dashboard/alerts?view=armed"
          className="text-[11px] font-medium text-gold-ink hover:text-gold"
        >
          View all armed levels &rarr;
        </Link>
      </div>
    </section>
  );
}

// Distance >0 = price is above the level (approaching from above for
// support/entry; past target for resistance). Keep tone neutral — user's
// own thesis determines whether "above" is good or bad.
function distanceColor(pct: number): string {
  const abs = Math.abs(pct);
  if (abs < 0.01) return "text-gold"; // <1% away — imminent
  if (abs < 0.025) return "text-ink"; // <2.5% away — close
  return "text-ink-faint"; // >2.5% — further out
}
