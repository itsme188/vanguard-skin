"use client";

import { useState, useEffect } from "react";
import { Count, Shares } from "@/lib/privacy/components";
import { formatUSDPrecise } from "@/lib/format";
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

/** The card lists expirations inside this many days; later ones are counted. */
export const EXPIRATION_WINDOW_DAYS = 90;
// Asked of the API so the card can COUNT what lies beyond the listed window
// (a century of days = "every live contract").
const ALL_LIVE_DAYS = 36500;

/**
 * Split the live contracts into the ones the card lists (expiring within the
 * window) and a count of the ones it does not, so the card can say how many
 * it left out instead of dropping them silently.
 */
export function splitExpirationWindow<T extends { daysToExpiry: number }>(
  options: T[],
  windowDays: number = EXPIRATION_WINDOW_DAYS,
): { within: T[]; beyondCount: number } {
  const within = options.filter((o) => o.daysToExpiry <= windowDays);
  return { within, beyondCount: options.length - within.length };
}

/**
 * Options expiration calendar — shows upcoming option expirations
 * with countdown badges. Only renders if there are expiring options.
 */
export function ExpirationCalendar({ scope }: { scope?: string }) {
  const [allOptions, setOptions] = useState<ExpiringOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch every live contract; the card lists the next 90 days and counts
    // the rest (see splitExpirationWindow).
    const qs = scope ? `&scope=${encodeURIComponent(scope)}` : "";
    fetch(`/api/compute/options-expirations?days=${ALL_LIVE_DAYS}${qs}`)
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
  const { within: options, beyondCount } = splitExpirationWindow(allOptions);
  if (allOptions.length === 0) {
    return (
      <EmptySection
        title="Option Expirations"
        reason="No options expiring within 90 days."
        hint="Shows the next 90 days of option expirations once you hold dated calls or puts. Contracts expiring later than that are counted here, not listed."
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
      {/* Window caption: the card is a 90-day view, so say so and say how
          many live contracts fall outside it. */}
      <p className="text-xs text-ink-faint">
        {options.length === 0 ? "Nothing expires in the next" : "Next"} {EXPIRATION_WINDOW_DAYS} days
        {beyondCount > 0 && (
          <> · <Count value={beyondCount} /> more beyond</>
        )}
      </p>

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
                        {/* The strike is a public contract term, not a
                            portfolio figure: it stays readable under privacy
                            (only the quantity masks). */}
                        {formatUSDPrecise(o.strike)} {o.optionType[0]}
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

