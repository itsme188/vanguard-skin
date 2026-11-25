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
  chartLineLabels,
  chartRows,
  formatDriverMove,
  formatDriverMoveLabel,
  gainKeptShare,
  keptAxis,
} from "@/lib/analysis/gains-at-risk-view";
import {
  trialChartDollarDomain,
  trialChartLineLabels,
  trialChartRows,
} from "@/lib/analysis/gains-at-risk-trial-view";
// Types only: no engine code reaches the browser.
import type { GainsAtRiskCase, GainsAtRiskCaseKey, GainsAtRiskTrialCase } from "@/lib/compute/gains-at-risk";
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
 *
 * With trial positions (`trial` set) the chart draws the SELECTED case only:
 * the book as it is and the book with the trial positions. The line without
 * the offsetting positions is hidden then (the view says so); with none, the
 * chart is exactly the one above.
 */
export function GainsAtRiskChart({
  cases,
  selectedCase,
  driverSymbol,
  yearGain,
  trial = null,
}: {
  cases: Record<GainsAtRiskCaseKey, Pick<GainsAtRiskCase, "moves">>;
  selectedCase: GainsAtRiskCaseKey;
  driverSymbol: string;
  yearGain: YearGainResult;
  /** The trial result's cases; null or absent when there are no trial positions. */
  trial?: Record<GainsAtRiskCaseKey, Pick<GainsAtRiskTrialCase, "moves">> | null;
}) {
  const dollarTickFormatter = usePrivateFormatter((v: unknown) => formatCompactUSD(Number(v)));
  const dollarTooltipFormatter = usePrivateFormatter((v: unknown) => formatUSD(Number(v)));
  const keptTickFormatter = usePrivateFormatter((v: unknown) => `${Math.round(Number(v) * 100)}%`);

  if (trial) {
    return (
      <TrialLines
        cases={cases}
        trial={trial}
        selectedCase={selectedCase}
        driverSymbol={driverSymbol}
        yearGain={yearGain}
        dollarTickFormatter={dollarTickFormatter}
        dollarTooltipFormatter={dollarTooltipFormatter}
        keptTickFormatter={keptTickFormatter}
      />
    );
  }

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
            width={44}
            label={{ value: "gain kept", angle: 90, position: "insideRight", fontSize: 11, fill: "var(--ink-faint)" }}
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

type Formatter = (v: unknown) => string;

/** The selected case with trial positions on: two lines, as it is and with them. */
function TrialLines({
  cases,
  trial,
  selectedCase,
  driverSymbol,
  yearGain,
  dollarTickFormatter,
  dollarTooltipFormatter,
  keptTickFormatter,
}: {
  cases: Record<GainsAtRiskCaseKey, Pick<GainsAtRiskCase, "moves">>;
  trial: Record<GainsAtRiskCaseKey, Pick<GainsAtRiskTrialCase, "moves">>;
  selectedCase: GainsAtRiskCaseKey;
  driverSymbol: string;
  yearGain: YearGainResult;
  dollarTickFormatter: Formatter;
  dollarTooltipFormatter: Formatter;
  keptTickFormatter: Formatter;
}) {
  const points = trialChartRows(cases, trial, selectedCase);
  const domain = trialChartDollarDomain(points);
  const kept = keptAxis(domain, yearGain);
  const labels = trialChartLineLabels(selectedCase);
  const data = points.map((p) => ({ ...p, kept: kept ? gainKeptShare(p.asIs, yearGain) : null }));

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
            width={44}
            label={{ value: "gain kept", angle: 90, position: "insideRight", fontSize: 11, fill: "var(--ink-faint)" }}
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
          dataKey="asIs"
          name={labels.asIs}
          stroke="var(--ink-faint)"
          strokeDasharray="5 4"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="usd"
          type="linear"
          dataKey="withTrial"
          name={labels.withTrial}
          stroke="var(--gold)"
          strokeWidth={2.5}
          dot={{ r: 2 }}
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
