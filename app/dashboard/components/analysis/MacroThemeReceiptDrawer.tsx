"use client";

import { useEffect } from "react";

// Step 0 findings:
// - SymbolLink requires both `securityId` + `symbol` props; sourceSummary alerts only carry
//   `symbol` (no securityId), so SymbolLink cannot be used here.
// - The Research page reads `?view=feeds&article=<id>` and opens that one article, so
//   each cited article links straight to it (title as tooltip).
// Decision: alert symbols render as plain text; they can be upgraded if/when
//   SymbolLink gains a symbol-only variant.

interface SourceSummary {
  articles: Array<{ id: number; title: string }>;
  // title / event_type are absent on a summary cached before they were stored.
  events: Array<{ id: number; symbol: string | null; event_date: string; title?: string; event_type?: string }>;
  alerts: Array<{ id: number; symbol: string }>;
}

/**
 * What to call a cited calendar event. The event's own name first — a macro
 * release has no symbol, so "symbol or the word macro" left most rows reading
 * a bare "macro" (QA finding
 * analysis-macro-sources--generic-links-unlabeled-events). A name that does
 * not already carry the ticker gets it as a prefix. Older cached summaries
 * have no name: fall back to the symbol, then the event type, and only then
 * to a plain "Unnamed event".
 */
export function macroEventLabel(e: SourceSummary["events"][number]): string {
  const title = typeof e.title === "string" ? e.title.trim() : "";
  const symbol = typeof e.symbol === "string" ? e.symbol.trim() : "";
  if (title) {
    return symbol && !title.toUpperCase().includes(symbol.toUpperCase())
      ? `${symbol} · ${title}`
      : title;
  }
  if (symbol) return symbol;
  const type = typeof e.event_type === "string" ? e.event_type.trim() : "";
  return type ? type.replace(/_/g, " ") : "Unnamed event";
}

// The stored inputs belong to the WEEK, not to one theme: the model returns a
// name, a factor, a direction and a summary per theme and cites nothing. The
// drawer used to open under a single theme's name and summary, which read as
// that theme's evidence while every theme showed the same list (QA finding
// analysis-macro-sources--receipt-drawer-same-10-articles-for-every-theme).
export const MACRO_INPUTS_HEADING = "Inputs to this week's macro read";
export const MACRO_INPUTS_NOTE =
  "The most recent articles, macro events and level alerts gathered for this week's themes (up to 10 of each). The same list sits behind every theme: which input supports which theme is not recorded.";

export function MacroThemeReceiptDrawer({
  sourceSummary,
  onClose,
}: {
  sourceSummary: SourceSummary;
  onClose: () => void;
}) {
  // Close on Escape — same idiom as TrustStripDrawer; without it a keyboard
  // user is stuck behind the backdrop (QA 2026-07-12).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[55] flex"
      onClick={onClose}
      role="dialog"
      aria-label={MACRO_INPUTS_HEADING}
    >
      <div className="flex-1 bg-black/30" aria-hidden="true" />
      <aside
        className="w-full max-w-md bg-panel border-l border-edge p-5 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-ink">{MACRO_INPUTS_HEADING}</h2>
            <p className="text-xs text-ink-faint mt-1">{MACRO_INPUTS_NOTE}</p>
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
                  {/* The Research page opens one article from ?article=<id> */}
                  <a
                    href={`/dashboard/research?view=feeds&article=${a.id}`}
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
                  {macroEventLabel(e)} · {e.event_date}
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
