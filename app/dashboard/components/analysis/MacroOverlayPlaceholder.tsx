/**
 * P4 placeholder. The full macro overlay (Sonnet-generated themes for the
 * week + cross-links into Cash-Deploy gap prioritization) is scheduled for
 * Phase 4. Until then, a simple empty-state shell holds the slot in the
 * Workspace so the 3-card layout doesn't collapse.
 */
export function MacroOverlayPlaceholder({ scope }: { scope: string }) {
  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm font-medium text-ink">Macro this week</h3>
        <p className="text-xs text-ink-faint mt-0.5">
          AI-distilled themes from research feeds + macro releases
          <span className="ml-2 text-ink-faint italic">· {scope}</span>
        </p>
      </header>
      <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
        <p className="text-xs text-ink-faint">
          Coming in Phase 4. Sunday-briefing-time generation, one pass per scope per week.
        </p>
      </div>
    </section>
  );
}
