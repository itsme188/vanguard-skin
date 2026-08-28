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
 *
 * CashDeployCard and WhatIfCalculator hold their computed result (gap table /
 * exposure delta) in local useState that is never cleared when `scope`
 * changes — the scope pills are `<a href>` client navigations that just pass
 * a new `scope` prop in, they don't unmount the tree. Without a remount, a
 * user who runs a calculation under "All accounts" and then clicks the
 * "Roth" pill sees the Roth scope label over the still-stale All-accounts
 * numbers (observed 15x overstatement). `key={scope}` forces React to
 * discard and remount these two cards on every scope switch (distinct
 * per-card key prefixes — two siblings sharing one key makes React
 * duplicate a card instead of remounting it), which resets
 * their state to initial. MacroOverlayCard doesn't need this: its result
 * lives behind a `useEffect` keyed on `[scope]` that sets `loading` true
 * synchronously before the new fetch, so the render gates stale themes
 * behind the loading state instead of showing them under the new label.
 */
export function WorkspacePanel({ scope }: { scope: string }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <CashDeployCard key={`cash-deploy-${scope}`} scope={scope} />
      <WhatIfCalculator key={`what-if-${scope}`} scope={scope} />
      <div className="lg:col-span-2">
        <MacroOverlayCard scope={scope} />
      </div>
    </div>
  );
}
