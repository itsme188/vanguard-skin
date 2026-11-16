// Analysis tab sub-view param normalization — single source of truth.
//
// Canonical scheme (2026-06-09 IA fix; defense added 2026-07-05; giving added
// 2026-08-17): `?view=` with six values:
//   workspace (default) | diagnostics | performance | trade-reviews | defense | giving
// Diagnostics keeps a secondary `?mode=` (classification default | factors)
// for its internal classification/factor toggle.
//
// Back-compat aliases (must never break — documented in CLAUDE.md):
//   ?mode=factors          → diagnostics + factors  (old iPhone bookmarks)
//   ?mode=classification   → diagnostics + classification
//   ?view=reviews          → trade-reviews          (old Research param)
//
// Pure function — unit-tested in tests/lib/analysis-view-param.test.ts.

export type AnalysisSubView =
  | "workspace"
  | "diagnostics"
  | "performance"
  | "trade-reviews"
  | "defense"
  | "giving";

export type AnalysisDiagnosticsMode = "classification" | "factors";

export interface ResolvedAnalysisView {
  view: AnalysisSubView;
  /** Only meaningful when view === "diagnostics"; defaults to classification. */
  mode: AnalysisDiagnosticsMode;
}

export const ANALYSIS_SCOPES = ["vanguard", "ibkr", "roth", "all"] as const;
export type AnalysisScope = (typeof ANALYSIS_SCOPES)[number];

/**
 * The scope an Analysis sub-view opens on when the URL carries no (or an
 * unknown) `?scope=`. Owner ruling 2026-11-15, "vanguard everywhere". The
 * page resolves it once and passes it down, so a component's own fallback is
 * never reached. Trade Reviews (one account at a time, IBKR preselect) and
 * Giving (no scope) do not read it.
 */
export const DEFAULT_ANALYSIS_SCOPE: AnalysisScope = "vanguard";

export function resolveAnalysisScope(scope?: string): AnalysisScope {
  return (ANALYSIS_SCOPES as readonly string[]).includes(scope ?? "")
    ? (scope as AnalysisScope)
    : DEFAULT_ANALYSIS_SCOPE;
}

function normalizeMode(mode?: string): AnalysisDiagnosticsMode {
  return mode === "factors" ? "factors" : "classification";
}

export function resolveAnalysisView(params: {
  view?: string;
  mode?: string;
}): ResolvedAnalysisView {
  const { view, mode } = params;

  // Canonical (and legacy-alias) view values win over any stray mode param.
  switch (view) {
    case "workspace":
      return { view: "workspace", mode: "classification" };
    case "diagnostics":
      return { view: "diagnostics", mode: normalizeMode(mode) };
    case "performance":
      return { view: "performance", mode: "classification" };
    case "trade-reviews":
    case "reviews": // legacy Research-era alias
      return { view: "trade-reviews", mode: "classification" };
    case "defense":
      return { view: "defense", mode: "classification" };
    case "giving":
      return { view: "giving", mode: "classification" };
  }

  // No (or unknown) view: legacy ?mode= alias keeps old diagnostics URLs working.
  if (mode === "factors" || mode === "classification") {
    return { view: "diagnostics", mode: normalizeMode(mode) };
  }

  return { view: "workspace", mode: "classification" };
}
