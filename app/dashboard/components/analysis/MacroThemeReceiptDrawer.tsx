"use client";

// Step 0 findings:
// - SymbolLink requires both `securityId` + `symbol` props; sourceSummary alerts only carry
//   `symbol` (no securityId), so SymbolLink cannot be used here.
// - `/dashboard/research?articleId=N` is NOT a recognized URL filter; ResearchFeedsView
//   manages article expansion via internal component state. Deep-linking to a specific
//   article from outside the page is not yet implemented.
// Decision: articles link to /dashboard/research (no filter) with the title as tooltip;
//   alert symbols render as plain text. Both can be upgraded if/when the Research page
//   gains URL-based article deep-linking and SymbolLink gains a symbol-only variant.

interface Theme {
  name: string;
  factor_label: string;
  direction: "risk-on" | "risk-off" | "neutral";
  summary: string;
}

interface SourceSummary {
  articles: Array<{ id: number; title: string }>;
  events: Array<{ id: number; symbol: string | null; event_date: string }>;
  alerts: Array<{ id: number; symbol: string }>;
}

export function MacroThemeReceiptDrawer({
  theme,
  sourceSummary,
  onClose,
}: {
  theme: Theme;
  sourceSummary: SourceSummary;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex"
      onClick={onClose}
      role="dialog"
      aria-label={`Sources for ${theme.name}`}
    >
      <div className="flex-1 bg-black/30" aria-hidden="true" />
      <aside
        className="w-full max-w-md bg-panel border-l border-edge p-5 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-ink">{theme.name}</h2>
            <p className="text-xs text-ink-faint mt-1">{theme.summary}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-faint hover:text-ink text-sm shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <section className="mb-4">
          <h3 className="text-xs uppercase tracking-wider text-ink-faint mb-2">
            Articles ({sourceSummary.articles.length})
          </h3>
          {sourceSummary.articles.length === 0 ? (
            <p className="text-xs text-ink-faint italic">None</p>
          ) : (
            <ul className="space-y-1.5">
              {sourceSummary.articles.map((a) => (
                <li key={a.id} className="text-xs text-ink-dim">
                  {/* No articleId URL filter on Research page yet; link to the feeds view */}
                  <a
                    href="/dashboard/research?view=feeds"
                    title={a.title}
                    className="hover:text-ink line-clamp-2"
                  >
                    {a.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mb-4">
          <h3 className="text-xs uppercase tracking-wider text-ink-faint mb-2">
            Macro events ({sourceSummary.events.length})
          </h3>
          {sourceSummary.events.length === 0 ? (
            <p className="text-xs text-ink-faint italic">None</p>
          ) : (
            <ul className="space-y-1.5">
              {sourceSummary.events.map((e) => (
                <li key={e.id} className="text-xs text-ink-dim">
                  {e.symbol ?? "macro"} · {e.event_date}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mb-4">
          <h3 className="text-xs uppercase tracking-wider text-ink-faint mb-2">
            Level alerts ({sourceSummary.alerts.length})
          </h3>
          {sourceSummary.alerts.length === 0 ? (
            <p className="text-xs text-ink-faint italic">None</p>
          ) : (
            <ul className="space-y-1.5">
              {sourceSummary.alerts.map((al) => (
                <li key={al.id} className="text-xs text-ink-dim">
                  {/* SymbolLink requires securityId which is not available here */}
                  {al.symbol}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
