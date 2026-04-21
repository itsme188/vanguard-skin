"use client";

import { useState, useEffect } from "react";
import { PrivateText } from "@/lib/privacy/components";

interface Strategy {
  type: string;
  name: string;
  underlying: string;
  expiration: string | null;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  description: string;
}

/**
 * Detected option strategies card.
 * Fetches from the same options-greeks endpoint that also returns strategies.
 * Only renders if strategies are detected.
 */
export function OptionsStrategies() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/compute/options-strategies")
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data?.length > 0) setStrategies(json.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || strategies.length === 0) return null;

  return (
    <div className="bg-raised border border-edge rounded-2xl p-6 space-y-4">
      <h3 className="text-sm font-medium text-ink">Detected Strategies</h3>

      <div className="space-y-3">
        {strategies.map((s, i) => (
          <div
            key={`${s.type}-${i}`}
            className="bg-muted/30 border border-edge/50 rounded-xl p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-gold uppercase tracking-wide">
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

            <p className="text-xs text-ink-dim mt-2">{s.description}</p>

            <div className="grid grid-cols-3 gap-2 mt-3">
              <div>
                <p className="text-[10px] text-ink-faint uppercase">Max Profit</p>
                <p className="text-xs font-mono text-up">
                  {s.maxProfit != null ? (
                    <PrivateText>{formatDollar(s.maxProfit)}</PrivateText>
                  ) : (
                    "Unlimited"
                  )}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-ink-faint uppercase">Max Loss</p>
                <p className="text-xs font-mono text-down">
                  {s.maxLoss != null ? (
                    <PrivateText>{formatDollar(s.maxLoss)}</PrivateText>
                  ) : (
                    "Unlimited"
                  )}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-ink-faint uppercase">Breakeven{s.breakevens.length > 1 ? "s" : ""}</p>
                <p className="text-xs font-mono text-ink-dim">
                  {s.breakevens.map((b) => `$${b.toFixed(0)}`).join(" / ")}
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

function formatDollar(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
