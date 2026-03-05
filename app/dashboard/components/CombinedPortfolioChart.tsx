"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type {
  AccountSummary,
  PortfolioChartPoint,
} from "@/lib/queries/dashboard";

const ACCOUNT_COLORS: Record<string, string> = {
  "Vanguard Taxable": "#C9A44E",
  "Vanguard Roth IRA": "#60A5FA",
  IBKR: "#34D399",
};

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatDate(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export function CombinedPortfolioChart({
  data,
  accounts,
}: {
  data: PortfolioChartPoint[];
  accounts: AccountSummary[];
}) {
  const accountNames = accounts.map((a) => a.name);

  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <h3 className="text-sm font-medium text-ink-dim mb-4">
        Portfolio Over Time
      </h3>
      <div className="h-[240px] sm:h-[280px] md:h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          >
            <defs>
              {accountNames.map((name) => (
                <linearGradient
                  key={name}
                  id={`grad-${name.replace(/\s/g, "")}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={ACCOUNT_COLORS[name] ?? "#888"}
                    stopOpacity={0.25}
                  />
                  <stop
                    offset="100%"
                    stopColor={ACCOUNT_COLORS[name] ?? "#888"}
                    stopOpacity={0.02}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#1E2534"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              stroke="#4E5668"
              tick={{ fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatCurrency}
              stroke="#4E5668"
              tick={{ fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip
              contentStyle={{
                background: "#151A24",
                border: "1px solid #2A3244",
                borderRadius: "8px",
                color: "#E2E6F0",
                fontSize: 12,
              }}
              labelFormatter={(label) => formatDate(String(label))}
              formatter={(value, name) => [
                `$${Number(value).toLocaleString()}`,
                String(name),
              ]}
            />
            {accountNames.map((name) => (
              <Area
                key={name}
                type="monotone"
                dataKey={name}
                stackId="1"
                stroke={ACCOUNT_COLORS[name] ?? "#888"}
                fill={`url(#grad-${name.replace(/\s/g, "")})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-5 mt-3 pt-3 border-t border-edge">
        {accountNames.map((name) => (
          <div
            key={name}
            className="flex items-center gap-1.5 text-xs text-ink-dim"
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: ACCOUNT_COLORS[name] ?? "#888" }}
            />
            {name}
          </div>
        ))}
      </div>
    </div>
  );
}
