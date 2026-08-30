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
import {
  MIN_BETA_PAIRS,
  MIN_BETA_R_SQUARED,
  type BetaConfidenceReason,
} from "@/lib/compute/beta-confidence";
import { Pct } from "@/lib/privacy/components";

/**
 * One row of Block 3, mirrored from `lib/compute/factors.ts::FactorShareEntry`.
 * Re-declared here (like `RegressionData` below) to keep the client/server
 * boundary clean — `sharePct` / `deltaPp` are 0..100 (already percent units).
 */
export interface FactorShareEntry {
  factor: FactorColumn;
  value: string;
  securityContribution: number;
  bucketTotalExposure: number;
  sharePct: number;
  deltaPp: number;
}

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

/**
 * Read-time publish gate for the beta (see `regressionBetaVerdict`). OPTIONAL:
 * a response from before the gate existed carries no verdict, and is treated
 * as ok — the card keeps rendering the beta rather than blanking it.
 */
interface BetaVerdict {
  ok: boolean;
  reason?: BetaConfidenceReason;
}

interface ApiResponse {
  success: boolean;
  data: RegressionData | null;
  fromCache?: boolean;
  betaVerdict?: BetaVerdict;
  error?: string;
}

/**
 * Three-block factor section on the Security Detail page.
 *
 * Block 1 — Qualitative chips from `security_factors` (passed in as `factors`).
 * Block 2 — Quantitative regression vs SPY (fetched client-side, cache-first
 *   via `/api/security/[id]/regression`).
 * Block 3 — Portfolio-share contribution. Computed server-side via
 *   `computeSecurityFactorShare` and passed in as `factorShare` (no client
 *   fetch — it's a fast pure read over the factor heatmap).
 *
 * v1 hardcodes benchmark to SPY. The plan's open question on a benchmark
 * `<select>` picker is intentionally deferred per spec.
 */
export function FactorProfileSection({
  securityId,
  factors,
  factorShare,
}: {
  securityId: number;
  factors: FactorProfileFactors | null;
  factorShare: FactorShareEntry[];
}) {
  const [regression, setRegression] = useState<RegressionData | null>(null);
  const [betaVerdict, setBetaVerdict] = useState<BetaVerdict | null>(null);
  const [regLoaded, setRegLoaded] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRegLoaded(false);
    setRegError(null);
    setBetaVerdict(null);
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
        // Missing verdict = old response shape → publish (backward compatible).
        setBetaVerdict(body.betaVerdict ?? { ok: true });
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

  // ---------- Block 2: publish gate ----------
  const betaWithheld = betaVerdict !== null && !betaVerdict.ok;

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
              {/* qa finding: regression-card-publishes-betas-failing-confidence-gate.
                  A slope the regression cannot support renders as "—" in the
                  neutral tone, never as an emphasised (and colour-coded)
                  number. Vol / R² / Correlation describe the series itself and
                  stand on their own, so they keep rendering. */}
              <KpiCell
                label="Beta"
                value={betaWithheld ? "—" : regression.beta.toFixed(2)}
                tone={betaWithheld ? undefined : betaTone(regression.beta)}
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
              {regressionCaption(regression.dataPoints, betaVerdict)}
            </p>
          </>
        )}
      </div>

      {/* Block 3 — Portfolio-share contribution.
          Privacy note: sharePct/deltaPp are PORTFOLIO-DERIVED ("X% of MY
          portfolio's exposure") → masked via <Pct> under privacy mode. The
          factor label + classification chip are public qualitative data (same
          as Block 1) so they stay visible. This differs from Block 2's
          beta/vol, which are public market-data statistics and aren't masked. */}
      <div style={{ padding: "16px 20px" }}>
        <BlockLabel>Portfolio-share contribution</BlockLabel>
        {factorShare.length === 0 ? (
          <p style={emptyTextStyle}>
            (not held, or no active factor exposures to attribute)
          </p>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            {factorShare.map((entry) => (
              <div
                key={entry.factor}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "10px",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "#888",
                    minWidth: "92px",
                  }}
                >
                  {FACTOR_LABELS[entry.factor]}
                </span>
                <TerminalTag color={getFactorColor(entry.value)} size="xs">
                  {entry.value}
                </TerminalTag>
                <span style={emptyTextStyle}>
                  ~<Pct value={entry.sharePct} digits={0} /> of portfolio{" "}
                  {FACTOR_LABELS[entry.factor]} · selling cuts the bucket ~
                  <Pct value={entry.deltaPp} digits={1} />
                </span>
              </div>
            ))}
          </div>
        )}
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

/**
 * Caption under the regression cells. Always states the sample size; when the
 * publish gate withholds the beta it also says WHY, in the reader's terms —
 * a blank cell with no explanation reads as a bug. Thresholds come from the
 * gate module so the copy can never drift from the rule it describes.
 */
function regressionCaption(
  dataPoints: number,
  verdict: BetaVerdict | null
): string {
  const base = `over ${dataPoints} daily observations`;
  if (verdict === null || verdict.ok) return base;
  if (verdict.reason === "few_pairs") {
    return `${base} · beta withheld: fewer than ${MIN_BETA_PAIRS} return pairs`;
  }
  return `${base} · beta withheld: r² below ${MIN_BETA_R_SQUARED.toFixed(
    2
  )} — the market explains too little of this name's variance`;
}

/** Soft tint for beta — emerald when ≤1, amber when >1.5, neutral between. */
function betaTone(beta: number): string {
  if (beta > 1.5) return "#FB923C"; // orange-400, "more aggressive"
  if (beta < 0.5) return "#34D399"; // emerald-400, "defensive"
  return "#eee";
}
