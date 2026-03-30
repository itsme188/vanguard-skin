"use client";

import { useState, useEffect } from "react";

interface ExpiringOption {
  securityId: number;
  symbol: string;
  underlying: string;
  optionType: "CALL" | "PUT";
  strike: number;
  expiration: string;
  daysToExpiry: number;
  quantity: number;
  accountName: string;
}

/**
 * Options expiration calendar — shows upcoming option expirations
 * with countdown badges. Only renders if there are expiring options.
 */
export function ExpirationCalendar() {
  const [options, setOptions] = useState<ExpiringOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch options expiring in the next 90 days
    fetch("/api/compute/options-greeks")
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data.positions?.length > 0) {
          const expiring = json.data.positions
            .filter((p: { daysToExpiry: number }) => p.daysToExpiry >= 0 && p.daysToExpiry <= 90)
            .sort((a: { daysToExpiry: number }, b: { daysToExpiry: number }) => a.daysToExpiry - b.daysToExpiry)
            .map((p: {
              symbol: string;
              underlying: string;
              type: string;
              strike: number;
              expiration: string;
              daysToExpiry: number;
              quantity: number;
            }) => ({
              securityId: 0,
              symbol: p.symbol,
              underlying: p.underlying,
              optionType: p.type as "CALL" | "PUT",
              strike: p.strike,
              expiration: p.expiration,
              daysToExpiry: p.daysToExpiry,
              quantity: p.quantity,
              accountName: "",
            }));
          if (expiring.length > 0) setOptions(expiring);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || options.length === 0) return null;

  // Group by expiration date
  const byDate = new Map<string, ExpiringOption[]>();
  for (const opt of options) {
    const group = byDate.get(opt.expiration) || [];
    group.push(opt);
    byDate.set(opt.expiration, group);
  }

  return (
    <div className="bg-raised border border-edge rounded-2xl p-6 space-y-4">
      <h3 className="text-sm font-medium text-ink">Option Expirations</h3>

      <div className="space-y-3">
        {Array.from(byDate.entries()).map(([date, opts]) => {
          const dte = opts[0].daysToExpiry;
          return (
            <div key={date} className="flex items-start gap-3">
              {/* DTE badge */}
              <div
                className={`flex-shrink-0 w-14 h-14 rounded-xl flex flex-col items-center justify-center ${
                  dte <= 7
                    ? "bg-down/20 text-down"
                    : dte <= 30
                    ? "bg-gold/20 text-gold"
                    : "bg-blue/20 text-blue"
                }`}
              >
                <span className="text-lg font-mono font-bold leading-none">{dte}</span>
                <span className="text-[10px] uppercase">days</span>
              </div>

              {/* Options expiring on this date */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-ink-faint font-mono">
                  {formatDate(date)}
                </p>
                <div className="mt-1 space-y-1">
                  {opts.map((o, i) => (
                    <div
                      key={`${o.symbol}-${i}`}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="font-mono text-ink font-medium">
                        {o.underlying}
                      </span>
                      <span className="text-ink-dim">
                        {formatStrike(o.strike)} {o.optionType[0]}
                      </span>
                      <span
                        className={`font-mono ${
                          o.quantity < 0 ? "text-down" : "text-ink-dim"
                        }`}
                      >
                        {o.quantity > 0 ? `+${o.quantity}` : o.quantity}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatStrike(strike: number): string {
  return strike % 1 === 0 ? `$${strike}` : `$${strike.toFixed(2)}`;
}
