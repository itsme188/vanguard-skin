"use client";

import { useEffect, useState } from "react";
import {
  TerminalSection,
  TerminalTag,
  KpiCell,
} from "../../components/TerminalSection";
import {
  FACTOR_COLUMNS,
  FACTOR_LABELS,
  getFactorColor,
  type FactorColumn,
} from "@/lib/factors";

/**
 * Subset of `security_factors` that this section renders. Only the 9 factor
 * columns plus security_id need to be passed in — the section reads the rest
 * from the API.
 */
export interface FactorProfileFactors {
  interest_rate_sensitive: string | null;
  growth_vs_value: string | null;
  cyclical: string | null;
  international_exposure: string | null;
  geopolitical_onshoring: string | null;
  tariff_exposure: string | null;
  ai_exposure: string | null;
  crypto_adjacent: string | null;
  regulatory_risk: string | null;
}

interface RegressionData {
  beta: number;
  vol: number; // annualized stddev (decimal — multiply by 100 for %)
  correlation: number;
  rSquared: number;
  dataPoints: number;
}

interface ApiResponse {
  success: boolean;
  data: RegressionData | null;
  fromCache?: boolean;
  error?: string;
}

/**
 * Three-block factor section on the Security Detail page.
 *
 * Block 1 — Qualitative chips from `security_factors` (passed in as `factors`).
 * Block 2 — Quantitative regression vs SPY (fetched client-side, cache-first
 *   via `/api/security/[id]/regression`).
 * Block 3 — Portfolio-share contribution. DEFERRED (see TODO below) — needs
 *   scope-aware factor totals + delta math; out of scope for B4 v1.
 *
 * v1 hardcodes benchmark to SPY. The plan's open question on a benchmark
 * `<select>` picker is intentionally deferred per spec.
 */
export function FactorProfileSection({
  securityId,
  factors,
}: {
  securityId: number;
  factors: FactorProfileFactors | null;
}) {
  const [regression, setRegression] = useState<RegressionData | null>(null);
  const [regLoaded, setRegLoaded] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRegLoaded(false);
    setRegError(null);
    fetch(`/api/security/${securityId}/regression?benchmark=SPY`)
      .then((r) => r.json() as Promise<ApiResponse>)
      .then((body) => {
        if (cancelled) return;
        if (!body.success) {
          setRegError(body.error ?? "Failed to load regression");
          setRegLoaded(true);
          return;
        }
        setRegression(body.data);
        setRegLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setRegError(err instanceof Error ? err.message : "Network error");
        setRegLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [securityId]);

  // ---------- Block 1: qualitative chips ----------
  const presentFactors = factors
    ? FACTOR_COLUMNS.flatMap((col) => {
        const value = factors[col as keyof FactorProfileFactors];
        if (!value || value === "Unknown") return [];
        return [{ col, value }];
      })
    : [];

  return (
    <TerminalSection
      title="Factor Profile"
      subtitle="Qualitative + quantitative exposure for this security"
    >
      {/* Block 1 — Qualitative chips */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid #1f1f1f",
        }}
      >
        <BlockLabel>Qualitative classifications</BlockLabel>
        {!factors ? (
          <p style={emptyTextStyle}>
            (no factor classifications yet — run Auto-Classify Factors on the
            Analysis page)
          </p>
        ) : presentFactors.length === 0 ? (
          <p style={emptyTextStyle}>
            (no non-Unknown factor classifications recorded)
          </p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
            {presentFactors.map(({ col, value }) => (
              <div
                key={col}
                style={{ display: "flex", alignItems: "center", gap: "6px" }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "10px",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "#888",
                  }}
                >
                  {FACTOR_LABELS[col as FactorColumn]}
                </span>
                <TerminalTag color={getFactorColor(value)} size="xs">
                  {value}
                </TerminalTag>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Block 2 — Quantitative regression vs SPY */}
      <div
        style={{
          padding: "16px 0 0",
          borderBottom: "1px solid #1f1f1f",
        }}
      >
        <div style={{ padding: "0 20px" }}>
          <BlockLabel>Quantitative regression · vs SPY · 252d</BlockLabel>
        </div>
        {!regLoaded ? (
          <p style={{ ...emptyTextStyle, padding: "0 20px 16px" }}>
            Loading regression…
          </p>
        ) : regError ? (
          <p style={{ ...emptyTextStyle, padding: "0 20px 16px" }}>
            (failed to load regression: {regError})
          </p>
        ) : !regression ? (
          <p style={{ ...emptyTextStyle, padding: "0 20px 16px" }}>
            (insufficient price history to compute regression)
          </p>
        ) : (
          <>
            <div style={{ display: "flex", marginTop: "8px" }}>
              <KpiCell
                label="Beta"
                value={regression.beta.toFixed(2)}
                tone={betaTone(regression.beta)}
              />
              <KpiCell
                label="Vol (ann)"
                value={`${(regression.vol * 100).toFixed(1)}%`}
              />
              <KpiCell label="R²" value={regression.rSquared.toFixed(2)} />
              <KpiCell
                label="Correlation"
                value={regression.correlation.toFixed(2)}
              />
            </div>
            <p
              style={{
                ...emptyTextStyle,
                padding: "10px 20px 16px",
                marginTop: 0,
              }}
            >
              over {regression.dataPoints} daily observations
            </p>
          </>
        )}
      </div>

      {/* Block 3 — Portfolio-share contribution. DEFERRED.
          TODO(P3 follow-up): compute `position_value × factor_weight ÷ Σ scope
          factor exposure` per active factor for this security. Requires:
            (a) latest market value of this security across owned accounts
            (b) scope-aware factor totals per bucket (e.g. all accounts' AI
                exposure value), reusing the analysis-page allocations CTE
            (c) delta math: "selling this would reduce 'AI exposure: High'
                bucket by N percentage points"
          Scoped out of B4 v1 — substantive new query worth its own slice. */}
      <div style={{ padding: "16px 20px" }}>
        <BlockLabel>Portfolio-share contribution</BlockLabel>
        <p style={emptyTextStyle}>
          (portfolio-share contribution coming in a follow-up)
        </p>
      </div>
    </TerminalSection>
  );
}

function BlockLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono), monospace",
        fontSize: "10px",
        letterSpacing: "0.22em",
        textTransform: "uppercase",
        color: "#666",
        marginBottom: "10px",
      }}
    >
      {children}
    </div>
  );
}

const emptyTextStyle: React.CSSProperties = {
  fontFamily: "Geist, system-ui, sans-serif",
  fontSize: "13px",
  color: "#888",
  margin: 0,
};

/** Soft tint for beta — emerald when ≤1, amber when >1.5, neutral between. */
function betaTone(beta: number): string {
  if (beta > 1.5) return "#FB923C"; // orange-400, "more aggressive"
  if (beta < 0.5) return "#34D399"; // emerald-400, "defensive"
  return "#eee";
}
