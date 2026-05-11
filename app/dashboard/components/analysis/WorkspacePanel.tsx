"use client";

import { CashDeployCard } from "./CashDeployCard";
import { WhatIfCalculator } from "./WhatIfCalculator";
import { MacroOverlayCard } from "./MacroOverlayCard";

/**
 * Construction-mode workspace. Three cards above the diagnostics fold:
 * Cash-Deploy (2.1), What-if (2.2), Macro Overlay (4 — placeholder until P4).
 *
 * Layout: stacked on mobile, two-column on lg+ with Macro spanning both
 * columns. Cards keep their own internal width control so the inner layouts
 * stay readable.
 */
export function WorkspacePanel({ scope }: { scope: string }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <CashDeployCard scope={scope} />
      <WhatIfCalculator scope={scope} />
      <div className="lg:col-span-2">
        <MacroOverlayCard scope={scope} />
      </div>
    </div>
  );
}
