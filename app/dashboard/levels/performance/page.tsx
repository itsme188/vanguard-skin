export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { getSourcePerformance } from "@/lib/queries/level-performance";
import { Chip } from "../../components/Chip";

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function pnlTone(n: number | null): "up" | "down" | "neutral" {
  if (n == null) return "neutral";
  if (n > 0.1) return "up";
  if (n < -0.1) return "down";
  return "neutral";
}

export default function LevelPerformancePage() {
  const rows = getSourcePerformance(db, { minAlerts: 1 });

  return (
    <div className="space-y-6 md:max-w-5xl md:mx-auto">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl text-gold font-medium">Source Performance</h1>
          <p className="text-sm text-ink-faint mt-1">
            Hit-rate and forward P&amp;L by level source. Scores fill in as
            alerts accumulate — the first few weeks will look sparse.
          </p>
        </div>
        <Link
          href="/dashboard/alerts"
          className="text-[12px] text-ink-faint hover:text-ink"
        >
          ← alerts inbox
        </Link>
      </header>

      <section className="rounded-xl border border-edge bg-panel overflow-hidden">
        <div className="px-4 py-3 border-b border-edge bg-raised/30">
          <div className="text-[11px] uppercase tracking-wider text-ink-faint font-mono">
            Attribution rule
          </div>
          <p className="text-[12px] text-ink-dim mt-1 leading-relaxed max-w-3xl">
            For each fired alert:{" "}
            <code className="text-ink">pnl = (close_N_days_later − triggered_price) / triggered_price</code>.
            Windows: 30 / 60 / 90 calendar days. &quot;Acted vs ignored&quot;
            compares average 30-day P&amp;L between the two response buckets,
            shown only when both sides have ≥ 3 samples. The rule ignores
            prior position state — if the user was already long and acted
            on a resistance level to trim, the reported P&amp;L will have
            the opposite sign of the trade&rsquo;s actual outcome. This is
            a known limitation of v1; v2 may condition on position state.
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-[13px] text-ink-dim">
              Not enough data yet — 0 alerts fired.
            </p>
            <p className="text-[12px] text-ink-faint mt-1">
              Scoreboard will fill in as you respond to alerts.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-edge text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="text-left px-4 py-2 font-medium">Source</th>
                <th className="text-right px-4 py-2 font-medium">Alerts</th>
                <th className="text-right px-4 py-2 font-medium">Hit rate</th>
                <th className="text-right px-4 py-2 font-medium">Responses</th>
                <th className="text-right px-4 py-2 font-medium">P&amp;L 30d (acted)</th>
                <th className="text-right px-4 py-2 font-medium">P&amp;L 60d</th>
                <th className="text-right px-4 py-2 font-medium">P&amp;L 90d</th>
                <th className="text-right px-4 py-2 font-medium">vs Ignored (30d)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.source_author}
                  className="border-b border-edge/50 last:border-0"
                >
                  <td className="px-4 py-3 text-ink font-medium">
                    {r.source_author}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-ink-dim">
                    {r.alerts_fired}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-ink-dim">
                    {r.hit_rate.toFixed(1)}%
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[11px] text-ink-faint whitespace-nowrap">
                    <span className="text-up">{r.responses.acted}a</span>
                    {" · "}
                    <span className="text-ink-dim">{r.responses.ignored}i</span>
                    {" · "}
                    <span className="text-down">{r.responses.dismissed}d</span>
                    {" · "}
                    <span className="text-ink-faint">
                      {r.responses.pending}p
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    <Chip tone={pnlTone(r.pnl_acted_30d)} size="xs">
                      {fmtPct(r.pnl_acted_30d)}
                    </Chip>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    <Chip tone={pnlTone(r.pnl_acted_60d)} size="xs">
                      {fmtPct(r.pnl_acted_60d)}
                    </Chip>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    <Chip tone={pnlTone(r.pnl_acted_90d)} size="xs">
                      {fmtPct(r.pnl_acted_90d)}
                    </Chip>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    <Chip tone={pnlTone(r.pnl_acted_vs_ignored_30d)} size="xs">
                      {fmtPct(r.pnl_acted_vs_ignored_30d)}
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
