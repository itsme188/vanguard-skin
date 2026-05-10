"use client";

import { useState, useEffect } from "react";
import { Money, Shares } from "@/lib/privacy/components";
import { EmptySection } from "./EmptySection";

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
export function ExpirationCalendar({ scope }: { scope?: string }) {
  const [options, setOptions] = useState<ExpiringOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch options expiring in the next 90 days
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    fetch(`/api/compute/options-expirations${qs}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success && Array.isArray(json.data)) {
          setOptions(json.data);
        } else {
          setOptions([]);
        }
      })
      .catch(() => setOptions([]))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) return null;
  if (options.length === 0) {
    return (
      <EmptySection
        title="Option Expirations"
        reason="No options expiring within 90 days."
        hint="Shows the next 90 days of option expirations once you hold dated calls or puts. LEAP options >90 days out are excluded by design."
      />
    );
  }

  // Group by expiration date
  const byDate = new Map<string, ExpiringOption[]>();
  for (const opt of options) {
    const group = byDate.get(opt.expiration) || [];
    group.push(opt);
    byDate.set(opt.expiration, group);
  }

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-4">
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
                        <Money value={o.strike} precise /> {o.optionType[0]}
                      </span>
                      <span
                        className={`font-mono ${
                          o.quantity < 0 ? "text-down" : "text-ink-dim"
                        }`}
                      >
                        {o.quantity > 0 ? "+" : ""}
                        <Shares value={o.quantity} />
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

