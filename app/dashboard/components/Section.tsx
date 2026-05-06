import type { ReactNode } from "react";

/**
 * Light-theme section primitive used across the dashboard. Mirrors the inline
 * pattern in EarningsHub / Alerts / PeriodComparisonTable so callers don't
 * re-implement the panel chrome.
 *
 * Pair this with `<Chip>` for colored pills and plain `<table>` markup with
 * Tailwind classes for tabular data. The terminal-aesthetic counterpart
 * (`TerminalSection`) is reserved for the dark "data module" on the Security
 * Detail page (`MarketDataPanel`).
 */
export function Section({
  title,
  subtitle,
  action,
  children,
  dense = false,
  className = "",
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** Smaller header padding for event-list-style sections. */
  dense?: boolean;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-edge bg-panel overflow-hidden card-elev ${className}`}
    >
      <header
        className={`flex items-baseline justify-between gap-3 flex-wrap border-b border-edge bg-raised ${
          dense ? "px-5 py-2.5" : "px-5 py-3"
        }`}
      >
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2
            className="font-mono uppercase font-semibold text-ink"
            style={{ fontSize: "12px", letterSpacing: "0.2em" }}
          >
            {title}
          </h2>
          {subtitle && (
            <span
              className="font-mono text-ink-faint"
              style={{ fontSize: "11px", letterSpacing: "0.1em" }}
            >
              {subtitle}
            </span>
          )}
        </div>
        {action && <div className="flex items-center gap-2">{action}</div>}
      </header>
      {children}
    </section>
  );
}
