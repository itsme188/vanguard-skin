import type { ReactNode } from "react";

/**
 * Shared section + table primitives for the Terminal aesthetic on the
 * Security Detail page. Keeps page.tsx and per-section components free of
 * repeated inline color/font/spacing declarations.
 *
 * Visual language:
 *   - Near-black container (#0d0d0d) with a thin #1f1f1f border.
 *   - Uppercase section title in mono 11px with 0.18em tracking, color #ccc.
 *   - Optional subtitle in mono 10px color #666.
 *   - Table cells: mono, tabular numerics, hairline #161616 dividers.
 */

export function TerminalSection({
  title,
  subtitle,
  action,
  children,
  dense = false,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  /** Dense = smaller padding for event-list-style sections. */
  dense?: boolean;
}) {
  return (
    <section
      className="rounded-lg overflow-hidden"
      style={{ background: "#0d0d0d", border: "1px solid #1f1f1f" }}
    >
      <div
        className="flex items-center justify-between gap-4"
        style={{
          padding: dense ? "10px 20px" : "14px 20px",
          borderBottom: "1px solid #1f1f1f",
          background: "#0a0a0a",
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "var(--font-mono), monospace",
              fontSize: "12px",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "#ccc",
              fontWeight: 500,
              margin: 0,
            }}
          >
            {title}
          </h2>
          {subtitle && (
            <p
              style={{
                fontFamily: "var(--font-mono), monospace",
                fontSize: "11px",
                color: "#666",
                marginTop: "4px",
                letterSpacing: "0.1em",
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {action && <div>{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Styled <th> for terminal tables. Use inside <thead><tr>.
 */
export function TerminalTH({
  children,
  align = "left",
  width,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
}) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "11px 20px",
        fontFamily: "var(--font-mono), monospace",
        fontSize: "11px",
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: "#888",
        fontWeight: 400,
        borderBottom: "1px solid #1f1f1f",
        background: "#0a0a0a",
        width,
      }}
    >
      {children}
    </th>
  );
}

/**
 * Styled <td> for terminal tables. Numeric cells should pass `mono`.
 */
export function TerminalTD({
  children,
  align = "left",
  mono = false,
  color,
  className = "",
  colSpan,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  mono?: boolean;
  color?: string;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      className={className}
      colSpan={colSpan}
      style={{
        textAlign: align,
        padding: "13px 20px",
        fontFamily: mono ? "var(--font-mono), monospace" : "Geist, system-ui, sans-serif",
        fontSize: "14px",
        color: color ?? "#ddd",
        fontVariantNumeric: mono ? "tabular-nums" : undefined,
        borderBottom: "1px solid #161616",
      }}
    >
      {children}
    </td>
  );
}

/**
 * "Quote-strip" KPI cell — uppercase mono label above a big mono value.
 * Used for the 5-across KPI row on MarketDataPanel (Open / Day range / 52w
 * range / Volume / ATR). Handles null gracefully with `—`.
 *
 * The cell paints its own right border so callers can stack them in a flex
 * row without wiring separators. The outermost cell's border is harmless —
 * the parent container masks it via `overflow: hidden`.
 */
export function KpiCell({
  label,
  value,
  subvalue,
  tone,
}: {
  label: string;
  value: ReactNode;
  subvalue?: ReactNode;
  /** Subtle color tint for the primary value. Defaults to near-white. */
  tone?: string;
}) {
  return (
    <div
      style={{
        // flex-basis 160px (not 0): with basis 0 the cells shrink to ~70px
        // at 390px and clip values to "$4.." — the parent's flex-wrap never
        // triggers because the cells CAN shrink. A real basis wraps narrow
        // viewports to 2 cells per row; 16px side padding leaves ~163px of
        // content at 390px, enough for a full "$268.66 – $273.23" range
        // (deep-QA finding + browser-verified at 390×844).
        flex: "1 1 160px",
        minWidth: 0,
        padding: "14px 16px",
        borderRight: "1px solid #1f1f1f",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono), monospace",
          fontSize: "10px",
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "#666",
          marginBottom: "6px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono), monospace",
          fontSize: "15px",
          fontWeight: 600,
          color: tone ?? "#eee",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.2,
          // Wrap, never ellipsis: dual-endpoint ranges ("$268.66 – $273.23")
          // clipped to "$268.66 – $27…" at 390px no matter how the cell
          // basis was tuned. A wrapped second line is always readable
          // (deep-QA finding, browser-verified at 390×844).
          overflowWrap: "break-word",
        }}
      >
        {value}
      </div>
      {subvalue != null && (
        <div
          style={{
            fontFamily: "var(--font-mono), monospace",
            fontSize: "11px",
            color: "#777",
            fontVariantNumeric: "tabular-nums",
            marginTop: "3px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {subvalue}
        </div>
      )}
    </div>
  );
}

/**
 * Small inline "pill" used for grade letters, term markers (LT/ST), etc.
 * Rendered as a filled square block — no rounded pills.
 */
export function TerminalTag({
  children,
  color,
  variant = "filled",
  size = "sm",
}: {
  children: ReactNode;
  color: string;
  variant?: "filled" | "outline";
  size?: "xs" | "sm";
}) {
  if (variant === "outline") {
    return (
      <span
        style={{
          display: "inline-block",
          color,
          border: `1px solid ${color}`,
          fontFamily: "var(--font-mono), monospace",
          fontSize: size === "xs" ? "10px" : "11px",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          padding: size === "xs" ? "2px 7px" : "3px 9px",
          borderRadius: "2px",
          fontWeight: 600,
        }}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        background: color,
        color: "#0a0a0a",
        fontFamily: "var(--font-mono), monospace",
        fontSize: size === "xs" ? "10px" : "11px",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        padding: size === "xs" ? "2px 7px" : "3px 9px",
        borderRadius: "2px",
        fontWeight: 700,
      }}
    >
      {children}
    </span>
  );
}
