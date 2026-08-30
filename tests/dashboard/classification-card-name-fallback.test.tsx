import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ClassificationCard } from "@/app/dashboard/components/analysis/ClassificationCard";
import { PrivacyProvider } from "@/lib/privacy/context";
import { ToastProvider } from "@/app/dashboard/components/Toast";
import { displaySecurityName } from "@/lib/format";
import type { ConcentrationMetrics, ClassificationCoverage } from "@/lib/queries/analysis";

// securities.name can be the EMPTY STRING (not NULL) on some IBKR-synced
// rows. The Unclassified Securities table rendered `{s.name ?? "—"}` — the
// `??` only catches null/undefined, so an empty-string name rendered a
// blank cell instead of the em-dash fallback. Fixed by routing through
// displaySecurityName (lib/format.ts), the same helper HoldingsTable/
// AllHoldingsTable already use for the identical blank-name bug there.
//
// This repo has no @testing-library/react and no jsdom (confirmed: neither
// is in package.json or node_modules) — the only rendering precedent,
// tests/dashboard/nearby-levels-privacy.test.tsx, uses react-dom/server's
// renderToStaticMarkup, which never runs effects or handles click events.
// The Unclassified Securities table this fix touches is gated behind local
// `showCoverage` state (useState(false), toggled only by a button onClick)
// with no prop to force it open — so the fixed table row is NOT reachable
// through a pure SSR render here (before or after the fix). Two things
// together stand in for that render assertion:
//   1. displaySecurityName itself is exhaustively unit-tested in
//      tests/lib/format.test.ts, including the exact `name: ""` -> "—"
//      case this finding is about — the component now delegates 100% of
//      the fallback decision to that function.
//   2. A source-scan regression guard below pins the component to calling
//      displaySecurityName(s.name) at the unclassified-row name cell and
//      catches the exact old buggy pattern (`s.name ?? "—"`) if it ever
//      comes back.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function sampleConcentration(): ConcentrationMetrics {
  return {
    hhi: 0.08,
    effective_positions: 12.5,
    // Empty so the recharts <ResponsiveContainer> block (which needs real
    // DOM measurement, unavailable in this SSR-only harness) never renders.
    top_positions: [],
    warnings: [],
  };
}

function sampleCoverage(): ClassificationCoverage {
  return {
    total: 10,
    classified: 9,
    unclassified: 1,
    coverage_pct: 90,
    by_source: [{ source: "manual", count: 9 }],
    unclassified_securities: [{ id: 1, symbol: "QQQ", name: "", security_type: "ETF" }],
  };
}

describe("ClassificationCard unclassified-securities name fallback", () => {
  it("renders without throwing given an unclassified security with an empty-string name", () => {
    const html = renderToStaticMarkup(
      <PrivacyProvider>
        <ToastProvider>
          <ClassificationCard concentration={sampleConcentration()} coverage={sampleCoverage()} />
        </ToastProvider>
      </PrivacyProvider>
    );
    expect(html).toContain("Classification");
  });

  it("source: the unclassified-row name cell calls displaySecurityName, not a bare ?? fallback", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/dashboard/components/analysis/ClassificationCard.tsx"),
      "utf8"
    );
    expect(source).toMatch(/\{displaySecurityName\(s\.name\)\}/);
    expect(source).not.toMatch(/\{s\.name\s*\?\?\s*"—"\}/);
  });

  it("displaySecurityName itself (what the fix now delegates to) turns an empty-string name into the em-dash", () => {
    expect(displaySecurityName("")).toBe("—");
    expect(displaySecurityName(null)).toBe("—");
    expect(displaySecurityName("Invesco QQQ Trust")).toBe("Invesco QQQ Trust");
  });
});
