import type { MomentumPulse as MomentumPulseData } from "@/lib/compute/momentum-spread";
import { Chip, type ChipTone } from "./Chip";

const STATUS_LABEL: Record<MomentumPulseData["status"], string> = {
  leading: "Momentum leading",
  neutral: "Neutral",
  weakening: "Momentum weakening",
  sell_off: "Sell-off in progress",
  insufficient_data: "Insufficient data",
};

const STATUS_TONE: Record<MomentumPulseData["status"], ChipTone> = {
  leading: "up",
  neutral: "neutral",
  weakening: "warn",
  sell_off: "down",
  insufficient_data: "neutral",
};

function formatSignedPct(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${(Math.abs(value) * 100).toFixed(digits)}%`;
}

function pctClassName(value: number): string {
  if (value > 0.001) return "text-up";
  if (value < -0.001) return "text-down";
  return "text-ink-dim";
}

interface MomentumPulseProps {
  pulse: MomentumPulseData | null;
}

/**
 * Today-page tile showing momentum factor pulse vs SPY.
 * Renders only when status indicates something worth seeing
 * (leading / weakening / sell_off). Hidden during calm markets
 * to keep Today scannable.
 *
 * All values are public market data — formatPercent() bypasses
 * privacy mode by design (see memory: privacy masks portfolio,
 * not market data).
 */
export function MomentumPulse({ pulse }: MomentumPulseProps) {
  if (!pulse || pulse.status === "neutral" || pulse.status === "insufficient_data") {
    return null;
  }

  const { spreads, status, asOf } = pulse;
  const rows: { label: string; spread: typeof spreads.mtum_vs_spy; aside?: string }[] = [
    { label: "MTUM", spread: spreads.mtum_vs_spy },
    { label: "SPMO", spread: spreads.spmo_vs_spy, aside: "confirms" },
    { label: "USMV", spread: spreads.usmv_vs_spy, aside: "defensive" },
  ];

  return (
    <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev md:max-w-3xl">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">Momentum pulse</h2>
        <Chip tone={STATUS_TONE[status]} size="sm">
          {STATUS_LABEL[status]}
        </Chip>
      </div>

      <table className="w-full text-[13px] font-mono tabular-nums">
        <thead className="text-[11px] uppercase tracking-wide text-ink-faint">
          <tr>
            <th className="text-left font-medium pb-1.5">Factor</th>
            <th className="text-right font-medium pb-1.5">vs SPY · 30d</th>
            <th className="text-right font-medium pb-1.5">5d</th>
            <th className="text-right font-medium pb-1.5">1d</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="py-1.5 text-ink">
                {r.label}
                {r.aside && <span className="ml-2 text-[11px] text-ink-faint">{r.aside}</span>}
              </td>
              <td className={`py-1.5 text-right ${pctClassName(r.spread.return30d)}`}>
                {formatSignedPct(r.spread.return30d)}
              </td>
              <td className={`py-1.5 text-right ${pctClassName(r.spread.return5d)}`}>
                {formatSignedPct(r.spread.return5d)}
              </td>
              <td className={`py-1.5 text-right ${pctClassName(r.spread.return1d)}`}>
                {formatSignedPct(r.spread.return1d)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-3 text-[11px] text-ink-faint">
        Public market data · as of {asOf}
      </p>
    </section>
  );
}
