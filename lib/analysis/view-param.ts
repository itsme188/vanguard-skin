// Analysis tab sub-view param normalization — single source of truth.
//
// Canonical scheme (2026-06-09 IA fix; defense added 2026-07-05): `?view=` with five values:
//   workspace (default) | diagnostics | performance | trade-reviews | defense
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
  | "defense";

export type AnalysisDiagnosticsMode = "classification" | "factors";

export interface ResolvedAnalysisView {
  view: AnalysisSubView;
  /** Only meaningful when view === "diagnostics"; defaults to classification. */
  mode: AnalysisDiagnosticsMode;
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
  }

  // No (or unknown) view: legacy ?mode= alias keeps old diagnostics URLs working.
  if (mode === "factors" || mode === "classification") {
    return { view: "diagnostics", mode: normalizeMode(mode) };
  }

  return { view: "workspace", mode: "classification" };
}
