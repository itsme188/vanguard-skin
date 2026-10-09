export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import {
  getAllocationByDimension,
  getConcentrationMetrics,
  getClassificationCoverage,
  getAnalysisDataCoverage,
  getFactorHeatmap,
  getFactorCoverage,
  type AllocationDimension,
} from "@/lib/queries/analysis";
import { getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { getTradeReviews } from "@/lib/queries/trade-reviews";
import { getAvailableReviewPeriods } from "@/lib/compute/trade-roundtrips";
import { FACTOR_COLUMNS } from "@/lib/factors";
import { AnalysisView, type AnalysisMode } from "../components/AnalysisView";
import { TradeReviewView } from "../components/TradeReviewView";
import { PerformanceView } from "../components/PerformanceView";
import { DefenseView } from "../components/DefenseView";
import { IncomeYieldSection } from "../components/IncomeYieldSection";
import { TrustStrip } from "../components/analysis/TrustStrip";
import { WorkspacePanel } from "../components/analysis/WorkspacePanel";
import { AnalysisViewToggle } from "../components/AnalysisViewToggle";
import { GivingView } from "../components/giving/GivingView";
import { resolveAnalysisView } from "@/lib/analysis/view-param";
import { SignificantMovesCard } from "../components/SignificantMovesCard";
import { MomentumPulse } from "../components/MomentumPulse";
import { computeMomentumPulse } from "@/lib/compute/momentum-spread";
import Link from "next/link";
import type { Metadata } from "next";

interface PageProps {
  searchParams: Promise<{
    dimension?: string;
    scope?: string;
    mode?: string;
    view?: string;
    period?: string;
  }>;
}

const CLASSIFICATION_DIMENSIONS: AllocationDimension[] = [
  "fund_category", "geography", "market_cap_category", "style",
  "sector", "asset_class", "security_type", "credit_rating", "account", "symbol",
];

const FACTOR_DIMENSIONS: AllocationDimension[] = [...FACTOR_COLUMNS];

// The label lib/queries/analysis.ts gives a holding with no stored credit
// rating (its credit_rating bucket expression). Any other bucket is a rating.
const UNRATED_BUCKET = "Unrated";

const VALID_SCOPES = ["vanguard", "ibkr", "roth", "all"] as const;
type AccountScope = (typeof VALID_SCOPES)[number];

// Same set + labels as the Performance sub-view's scope pills (PerformanceView.tsx
// SCOPES) — reused here so the Workspace landing gets the identical control instead
// of a new design (deep-QA: Workspace was silently scoped to Vanguard with no pill
// row and no visible label; Diagnostics/Performance already had working pills).
const SCOPE_PILLS: { key: AccountScope; label: string }[] = [
  { key: "all", label: "All accounts" },
  { key: "vanguard", label: "Vanguard" },
  { key: "ibkr", label: "IBKR" },
  { key: "roth", label: "Roth" },
];

function resolveAccountIds(scope: AccountScope): number[] | undefined {
  if (scope === "all") return undefined;

  const rows = db
    .prepare("SELECT id, name FROM accounts")
    .all() as Array<{ id: number; name: string }>;

  if (scope === "vanguard") {
    const ids = rows
      .filter((r) => {
        const n = r.name.toLowerCase();
        return n.includes("vanguard") && !n.includes("roth");
      })
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  if (scope === "ibkr") {
    const ids = rows
      .filter((r) => r.name.toLowerCase().includes("ibkr"))
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  if (scope === "roth") {
    const ids = rows
      .filter((r) => r.name.toLowerCase().includes("roth"))
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  return undefined;
}

// Header "Tax Lots" link. The tax-lots page filters by ?account=<account
// name>; carry it when the scope on screen is exactly ONE account, so the
// button never silently widens the user to all accounts. A scope of several
// accounts (or "all") keeps the bare link: the tax-lots page has no
// multi-account filter to carry it into.
function taxLotsHref(scope: AccountScope): string {
  const ids = resolveAccountIds(scope);
  if (!ids || ids.length !== 1) return "/dashboard/tax-lots";
  const row = db.prepare("SELECT name FROM accounts WHERE id = ?").get(ids[0]) as
    | { name: string }
    | undefined;
  return row
    ? `/dashboard/tax-lots?account=${encodeURIComponent(row.name)}`
    : "/dashboard/tax-lots";
}

const VIEW_TITLES: Record<string, string> = {
  workspace: "Analysis",
  diagnostics: "Analysis · Diagnostics",
  performance: "Analysis · Performance",
  "trade-reviews": "Analysis · Trade Reviews",
  defense: "Analysis · Defense",
  giving: "Analysis · Giving",
};

// Per-sub-view tab title (qa:page-head--same-tab-title-every-route-...).
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { view } = resolveAnalysisView(await searchParams);
  return { title: VIEW_TITLES[view] ?? "Analysis" };
}

export default async function AnalysisPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // ── Sub-view dispatch — canonical `?view=` scheme with legacy aliasing
  // (?mode=factors / ?mode=classification / ?view=reviews) resolved by the
  // single-source normalizer in lib/analysis/view-param.ts.
  const resolved = resolveAnalysisView(params);

  if (resolved.view === "trade-reviews") {
    const accounts = db
      .prepare("SELECT id, name FROM accounts ORDER BY name")
      .all() as { id: number; name: string }[];
    const ibkr = accounts.find((a) => a.name.toLowerCase().includes("ibkr"));
    // The sub-view menu carries ?scope= here like every other sub-view, so a
    // Roth or Vanguard arrival preselects that account. The view reviews ONE
    // account at a time (it has its own account select), so a scope of several
    // accounts preselects the first by name. No scope, "all" or an unknown
    // scope keeps the IBKR default.
    const scopedIds =
      VALID_SCOPES.includes(params.scope as AccountScope) && params.scope !== "all"
        ? resolveAccountIds(params.scope as AccountScope)
        : undefined;
    const scoped = scopedIds ? accounts.find((a) => scopedIds.includes(a.id)) : undefined;
    const defaultAccountId = scoped?.id ?? ibkr?.id ?? accounts[0]?.id ?? null;
    const reviews = defaultAccountId ? getTradeReviews(db, defaultAccountId) : [];
    const reviewPeriods = defaultAccountId
      ? getAvailableReviewPeriods(db, defaultAccountId)
      : [];

    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium text-ink">Trade Reviews</h2>
            <p className="text-sm text-ink-faint mt-0.5">
              Monthly AI trade analysis.
            </p>
          </div>
          <AnalysisViewToggle currentView="trade-reviews" scope={params.scope} />
        </div>
        <TradeReviewView
          initialReviews={reviews}
          accounts={accounts}
          initialPeriods={reviewPeriods}
          defaultAccountId={defaultAccountId}
        />
      </div>
    );
  }

  if (resolved.view === "performance") {
    // md:space-y-0 — the pill toggle is md:hidden, so on desktop the wrapper
    // must not introduce a margin above PerformanceView (no layout shift).
    return (
      <div className="space-y-6 md:space-y-0">
        <AnalysisViewToggle currentView="performance" scope={params.scope} />
        <PerformanceView scope={params.scope} period={params.period} />
      </div>
    );
  }

  if (resolved.view === "defense") {
    const defenseScope: AccountScope =
      VALID_SCOPES.includes(params.scope as AccountScope)
        ? (params.scope as AccountScope)
        : "all";
    // md:space-y-0 — mirrors the performance branch: the pill toggle is
    // md:hidden, so on desktop the wrapper must not introduce a margin
    // above DefenseView (no layout shift).
    return (
      <div className="space-y-6 md:space-y-0">
        <AnalysisViewToggle currentView="defense" scope={params.scope} />
        {/* DefenseView falls back to "all" for an absent or unknown scope, so
            the active pill does too (not the "vanguard" default the other
            branches below use). md:mb-6 stands in for the space-y gap that
            md:space-y-0 removes on desktop. */}
        <DefenseScopePills active={defenseScope} />
        <DefenseView scope={params.scope} />
      </div>
    );
  }

  if (resolved.view === "giving") {
    // Account-agnostic (spec §10): GivingView takes NO scope prop — giving
    // is a portfolio-wide ledger, not a per-scope slice. AnalysisViewToggle
    // still gets scope so switching to another sub-view round-trips it.
    return (
      <div className="space-y-6 md:space-y-0">
        <AnalysisViewToggle currentView="giving" scope={params.scope} />
        <GivingView />
      </div>
    );
  }

  const scope: AccountScope =
    VALID_SCOPES.includes(params.scope as AccountScope)
      ? (params.scope as AccountScope)
      : "vanguard";

  if (resolved.view === "workspace") {
    // ── Default landing: Workspace ────────────────────────────────────────
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-medium text-ink">Analysis</h2>
            <p className="text-sm text-ink-faint mt-0.5">
              Portfolio construction workspace — deploy cash, model what-ifs, watch macro themes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/dashboard/analysis?view=diagnostics&scope=${scope}`}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink hover:border-ink-faint transition-colors"
            >
              Diagnostics ↓
            </Link>
            <Link
              href={taxLotsHref(scope)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink hover:border-ink-faint transition-colors"
            >
              Tax Lots
            </Link>
          </div>
        </div>

        <AnalysisViewToggle currentView="workspace" scope={params.scope} />

        {/* Account scope pills — identical control + labels to Diagnostics
            (AnalysisView.tsx) and Performance (PerformanceView.tsx); selecting
            one updates ?scope= the same way. A visible label sits alongside so
            the active scope is always named, not just inferred from a
            highlighted pill (deep-QA: Workspace's only scope hint used to be
            a tiny italic tag on the Macro card, three tabs removed from the
            what-if total it explains). */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div
            className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 self-start w-fit"
            role="group"
            aria-label="Account scope"
          >
            {SCOPE_PILLS.map((s) => (
              <Link
                key={s.key}
                // Workspace's canonical nav identity is view-ABSENT (see
                // nav-tabs.ts: matchParam.value is null for Workspace) — the
                // "← Workspace" link below uses the same bare-scope shape.
                // Hardcoding ?view=workspace here would still route to the
                // same page (resolveAnalysisView treats it as equivalent),
                // but it breaks TabDropdown's subviewMatches active-highlight
                // check ('workspace' !== null), so the nav's Workspace row
                // would lose its highlight while on this exact page.
                href={`/dashboard/analysis?scope=${s.key}`}
                aria-current={scope === s.key ? "true" : undefined}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  scope === s.key
                    ? "bg-panel text-ink shadow-sm"
                    : "text-ink-dim hover:text-ink"
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <p className="text-xs text-ink-faint">
            Scope:{" "}
            <span className="font-medium text-ink-dim">
              {SCOPE_PILLS.find((s) => s.key === scope)?.label ?? scope}
            </span>
          </p>
        </div>

        {/* Actionable tools lead; the TrustStrip data-quality readout sits
            below the fold-line so construction work comes first. */}
        <WorkspacePanel scope={scope} />

        <TrustStrip scope={scope} />

        <IncomeYieldSection scope={scope} />
      </div>
    );
  }

  // ── Diagnostics (?view=diagnostics; legacy ?mode=classification|factors
  // URLs alias here so old iPhone bookmarks keep working) ──
  const mode: AnalysisMode = resolved.mode;

  const defaultDimension: AllocationDimension =
    mode === "factors" ? "tariff_exposure" : "fund_category";

  // A dimension is valid only for the mode on screen: a factor key under
  // Classification (or the reverse) used to render with no pill selected.
  const modeDimensions: readonly string[] =
    mode === "factors" ? FACTOR_DIMENSIONS : CLASSIFICATION_DIMENSIONS;
  const requested = params.dimension;

  let accountIds, allocation, exposureSummary, concentration, coverage, dataCoverage, factorHeatmap, factorCoverage;
  let creditRatingAvailable = true;
  let dimension: AllocationDimension = defaultDimension;
  let dimensionNotice: string | null = null;
  try {
    accountIds = resolveAccountIds(scope);

    // Credit Rating is offered only while some holding in scope carries a
    // rating. With none stored the breakdown is a single "Unrated 100%"
    // bucket over a book whose bonds are Treasuries (owner ruling, option 3:
    // hide it rather than assert that). Factor mode never offers it.
    const creditRows =
      mode === "factors" ? [] : getAllocationByDimension(db, "credit_rating", accountIds);
    creditRatingAvailable = creditRows.some((r) => r.group_name !== UNRATED_BUCKET);

    // An unknown ?dimension= (a stale or hand-edited link) falls back to the
    // mode's default AND says so: the fallback used to render under the bad
    // URL with nothing to show the requested breakdown does not exist.
    const hiddenCreditRating =
      mode !== "factors" && requested === "credit_rating" && !creditRatingAvailable;
    if (requested && modeDimensions.includes(requested) && !hiddenCreditRating) {
      dimension = requested as AllocationDimension;
    } else if (hiddenCreditRating) {
      dimensionNotice =
        "No holding in this scope carries a credit rating, so that breakdown is hidden. Showing the default breakdown instead.";
    } else if (requested) {
      dimensionNotice =
        "That link asked for a breakdown this view does not have. Showing the default breakdown instead.";
    }

    allocation =
      dimension === "credit_rating"
        ? creditRows
        : getAllocationByDimension(db, dimension, accountIds);
    exposureSummary = getPortfolioExposureSummary(db, accountIds);
    concentration = getConcentrationMetrics(db, accountIds);
    coverage = getClassificationCoverage(db, accountIds);
    dataCoverage = getAnalysisDataCoverage(db, accountIds);

    factorHeatmap = mode === "factors" ? getFactorHeatmap(db, accountIds) : undefined;
    factorCoverage = mode === "factors" ? getFactorCoverage(db, accountIds) : undefined;
  } catch {
    throw new Error("Failed to load analysis data. The database may be unavailable.");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-medium text-ink">Analysis · Diagnostics</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            {mode === "factors"
              ? "Thematic factor exposure analysis across your portfolio"
              : "Portfolio factor analysis, allocation breakdown, and concentration metrics"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dashboard/analysis?scope=${scope}`}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink hover:border-ink-faint transition-colors"
          >
            ← Workspace
          </Link>
          <Link
            href={taxLotsHref(scope)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink hover:border-ink-faint transition-colors"
          >
            Tax Lots
          </Link>
        </div>
      </div>

      <AnalysisViewToggle currentView="diagnostics" scope={params.scope} />

      {/* ── Moved off Today by live print v2 (spec §4.6): the two market-wide
              read-outs belong with the other diagnostics, not on the earnings
              surface. SignificantMovesCard self-loads from the db singleton;
              MomentumPulse is prop-driven, so the pulse is computed here. ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        <SignificantMovesCard accountIds={accountIds} scopeLabel={SCOPE_PILLS.find((s) => s.key === scope)?.label ?? scope} />
        <MomentumPulse pulse={computeMomentumPulse(db)} />
      </div>

      <TrustStrip scope={scope} />

      {dimensionNotice && (
        <p role="status" className="text-sm text-ink-dim">
          {dimensionNotice}
        </p>
      )}

      <AnalysisView
        allocation={allocation}
        exposureSummary={exposureSummary}
        concentration={concentration}
        coverage={coverage}
        dataCoverage={dataCoverage}
        currentDimension={dimension}
        currentScope={scope}
        currentMode={mode}
        factorHeatmap={factorHeatmap}
        factorCoverage={factorCoverage}
        creditRatingAvailable={creditRatingAvailable}
      />

      <IncomeYieldSection scope={scope} />
    </div>
  );
}

// Account scope pills for the Defense view — same control as Workspace /
// Diagnostics / Performance, with hrefs that keep ?view=defense. Declared
// after the page so the Workspace pill group stays the first SCOPE_PILLS map
// in the file (tab-dropdown-preserved-params.test.ts slices from there).
function DefenseScopePills({ active }: { active: AccountScope }) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 self-start w-fit md:mb-6"
      role="group"
      aria-label="Account scope"
    >
      {SCOPE_PILLS.map((s) => (
        <Link
          key={s.key}
          href={`/dashboard/analysis?view=defense&scope=${s.key}`}
          aria-current={active === s.key ? "true" : undefined}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            active === s.key
              ? "bg-panel text-ink shadow-sm"
              : "text-ink-dim hover:text-ink"
          }`}
        >
          {s.label}
        </Link>
      ))}
    </div>
  );
}
