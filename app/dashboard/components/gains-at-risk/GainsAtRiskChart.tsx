"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usePrivateFormatter } from "@/lib/privacy/components";
import { formatCompactUSD, formatUSD } from "@/lib/format";
import {
  chartDollarDomain,
  chartDollarTicks,
  chartLineLabels,
  chartRows,
  formatDriverMove,
  formatDriverMoveLabel,
  gainKeptShare,
  keptAxis,
} from "@/lib/analysis/gains-at-risk-view";
// Types only: no engine code reaches the browser.
import type { GainsAtRiskCase, GainsAtRiskCaseKey } from "@/lib/compute/gains-at-risk";
import type { YearGainResult } from "@/lib/compute/year-gain";

/** Every 5% of the sweep gets a tick; the 2.5% points sit between them. */
const X_TICKS = [-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1];

/**
 * The book's profit or loss across the driver sweep in BOTH cases (the gap
 * between the two book lines is how much rests on names falling together),
 * plus the selected case's book without its offsetting positions
 * (`chartRows`: that case's `losersPnlUsd`, on the down split). Only the
 * sweep's moves are plotted, on a numeric axis, so a custom table row never
 * bends a line. The selected case's book line is drawn heavier.
 *
 * The x axis is the driver's own move: market data, labelled plain with
 * `formatDriverMove`. Every dollar and share figure goes through
 * `usePrivateFormatter`. The right-hand "gain kept" axis shows only when a
 * share of the year's gain can be stated (`keptAxis`); its domain is the
 * dollar domain rescaled, and its series sits on the selected case's book
 * line, invisible.
 */
export function GainsAtRiskChart({
  cases,
  selectedCase,
  driverSymbol,
  yearGain,
}: {
  cases: Record<GainsAtRiskCaseKey, Pick<GainsAtRiskCase, "moves">>;
  selectedCase: GainsAtRiskCaseKey;
  driverSymbol: string;
  yearGain: YearGainResult;
}) {
  const dollarTickFormatter = usePrivateFormatter((v: unknown) => formatCompactUSD(Number(v)));
  const dollarTooltipFormatter = usePrivateFormatter((v: unknown) => formatUSD(Number(v)));
  const keptTickFormatter = usePrivateFormatter((v: unknown) => `${Math.round(Number(v) * 100)}%`);

  const points = chartRows(cases, selectedCase);
  const domain = chartDollarDomain(points);
  const kept = keptAxis(domain, yearGain);
  const labels = chartLineLabels(selectedCase);
  const data = points.map((p) => ({ ...p, kept: kept ? gainKeptShare(p[selectedCase], yearGain) : null }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 8, right: kept ? 4 : 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" vertical={false} />
        <XAxis
          dataKey="move"
          type="number"
          domain={["dataMin", "dataMax"]}
          ticks={X_TICKS}
          tickFormatter={formatDriverMove}
          tick={{ fontSize: 11, fill: "var(--ink-faint)" }}
          label={{ value: driverSymbol, position: "insideBottomRight", offset: -2, fontSize: 11, fill: "var(--ink-faint)" }}
        />
        <YAxis
          yAxisId="usd"
          domain={domain}
          ticks={chartDollarTicks(domain)}
          allowDataOverflow
          tickFormatter={dollarTickFormatter}
          tick={{ fontSize: 11, fill: "var(--ink-faint)" }}
          width={56}
        />
        {kept && (
          <YAxis
            yAxisId="kept"
            orientation="right"
            domain={kept.domain}
            ticks={kept.ticks}
            allowDataOverflow
            tickFormatter={keptTickFormatter}
            tick={{ fontSize: 11, fill: "var(--ink-faint)" }}
            width={64}
            label={{ value: "gain kept", angle: 90, position: "insideRight", dx: 14, fontSize: 11, fill: "var(--ink-faint)" }}
          />
        )}
        <ReferenceLine yAxisId="usd" y={0} stroke="var(--edge-strong)" />
        <Tooltip
          formatter={dollarTooltipFormatter}
          labelFormatter={formatDriverMoveLabel}
          contentStyle={{
            background: "var(--panel)",
            border: "1px solid var(--edge)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--ink)",
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "var(--ink-dim)" }} />
        <Line
          yAxisId="usd"
          type="linear"
          dataKey="measured"
          name={labels.measured}
          stroke="var(--gold)"
          strokeWidth={selectedCase === "measured" ? 2.5 : 1.5}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
        <Line
          yAxisId="usd"
          type="linear"
          dataKey="selloff"
          name={labels.selloff}
          stroke="var(--down)"
          strokeWidth={selectedCase === "selloff" ? 2.5 : 1.5}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
        <Line
          yAxisId="usd"
          type="linear"
          dataKey="without"
          name={labels.without}
          stroke="var(--ink-faint)"
          strokeDasharray="5 4"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        {kept && (
          <Line
            yAxisId="kept"
            type="linear"
            dataKey="kept"
            stroke="transparent"
            dot={false}
            activeDot={false}
            legendType="none"
            tooltipType="none"
            isAnimationActive={false}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
