"use client";

import { useState, useEffect } from "react";
import { Money, PrivateText } from "@/lib/privacy/components";
import apiFetch from "@/lib/http/apiFetch";
import { EmptySection } from "./EmptySection";
import {
  pricingIncompleteNote,
  type PricingIncompleteReason,
} from "@/lib/compute/options-strategy";

interface Strategy {
  type: string;
  name: string;
  underlying: string;
  expiration: string | null;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  description: string;
  /** A leg has no usable mark: payoff figures are withheld (null here is NOT "unlimited"). */
  pricingIncomplete?: boolean;
  /** Why: missing price, zero mark, or an option marked below intrinsic value. */
  pricingIncompleteReason?: PricingIncompleteReason | null;
}

/**
 * Detected option strategies card.
 * Fetches from the same options-greeks endpoint that also returns strategies.
 * Only renders if strategies are detected.
 */
export function OptionsStrategies({ scope }: { scope?: string }) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    apiFetch(`/api/compute/options-strategies${qs}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data?.length > 0) setStrategies(json.data);
        else setStrategies([]);
      })
      .catch(() => setStrategies([]))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) return null;
  if (strategies.length === 0) {
    return (
      <EmptySection
        title="Detected Strategies"
        reason="No recognized options strategy detected."
        hint="The detector recognizes covered calls and protective puts from stock plus one option leg, and matched multi-leg spreads from offsetting option legs. Unmatched or all-long option legs remain in the Options Greeks card above."
      />
    );
  }

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-4">
      <h3 className="text-sm font-medium text-ink">Detected Strategies</h3>

      <div className="space-y-3">
        {strategies.map((s, i) => (
          <div
            key={`${s.type}-${i}`}
            className="bg-muted/30 border border-edge/50 rounded-xl p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-gold-ink uppercase tracking-wide">
                  {formatStrategyType(s.type)}
                </span>
                <p className="text-sm text-ink mt-0.5">{s.name}</p>
              </div>
              {s.expiration && (
                <span className="text-xs text-ink-faint font-mono">
                  Exp {s.expiration}
                </span>
              )}
            </div>

            <p className="text-xs text-ink-dim mt-2">
              <PrivateText>{s.description}</PrivateText>
            </p>
            {s.pricingIncomplete && (
              <p className="text-xs text-ink-faint mt-1">
                {pricingIncompleteNote(s.pricingIncompleteReason)}
              </p>
            )}

            <div className="grid grid-cols-3 gap-2 mt-3">
              <div>
                <p className="text-[10px] text-ink-faint uppercase">Max Profit</p>
                <p className="text-xs font-mono text-up">
                  {s.pricingIncomplete ? (
                    <span className="text-ink-faint">Not available</span>
                  ) : s.maxProfit != null ? (
                    <Money value={s.maxProfit} />
                  ) : (
                    "Unlimited"
                  )}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-ink-faint uppercase">Max Loss</p>
                <p className="text-xs font-mono text-down">
                  {s.pricingIncomplete ? (
                    <span className="text-ink-faint">Not available</span>
                  ) : s.maxLoss != null ? (
                    <Money value={s.maxLoss} />
                  ) : (
                    "Unlimited"
                  )}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-ink-faint uppercase">Breakeven{s.breakevens.length > 1 ? "s" : ""}</p>
                <p className="text-xs font-mono text-ink-dim">
                  {s.pricingIncomplete && (
                    <span className="text-ink-faint">Not available</span>
                  )}
                  {s.breakevens.map((b) => `$${b.toFixed(2)}`).join(" / ")}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatStrategyType(type: string): string {
  return type.replace(/_/g, " ");
}
