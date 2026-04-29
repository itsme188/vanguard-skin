import type { ReactNode } from "react";
import { DARK } from "../palette";

interface Props {
  id?: string;
  title: string;
  meta?: string;
  children: ReactNode;
}

export function TerminalFrame({ id, title, meta, children }: Props) {
  return (
    <section
      id={id}
      style={{
        marginTop: 32,
        scrollMarginTop: 56,
        border: `1px solid ${DARK.border}`,
        background: DARK.canvas,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          background: DARK.panel,
          borderBottom: `1px solid ${DARK.border}`,
        }}
      >
        <span
          style={{
            fontSize: 12,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: DARK.ink,
            fontWeight: 500,
          }}
        >
          {title}
        </span>
        {meta && (
          <span
            style={{
              fontSize: 12,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: DARK.inkDim,
            }}
          >
            {meta}
          </span>
        )}
      </header>
      <div className="d-frame-body" style={{ padding: 0 }}>
        <div>{children}</div>
      </div>
    </section>
  );
}

export function TerminalKpiRow({
  items,
}: {
  items: { label: string; value: string; tone?: "up" | "down" | "amber" | "neutral" }[];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${items.length}, 1fr)`,
        borderBottom: `1px solid ${DARK.border}`,
      }}
    >
      {items.map((kpi, i) => (
        <div
          key={kpi.label}
          style={{
            padding: "14px 18px",
            borderRight: i < items.length - 1 ? `1px solid ${DARK.borderRow}` : "none",
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: DARK.inkDim,
              marginBottom: 6,
              fontWeight: 500,
            }}
          >
            {kpi.label}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 500,
              color:
                kpi.tone === "up"
                  ? DARK.up
                  : kpi.tone === "down"
                  ? DARK.down
                  : kpi.tone === "amber"
                  ? DARK.amber
                  : DARK.ink,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.01em",
            }}
          >
            {kpi.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TerminalRow({
  cells,
  columns,
  tone,
  bold,
}: {
  cells: ReactNode[];
  columns: string;
  tone?: "up" | "down" | "amber" | "header" | "muted";
  bold?: boolean;
}) {
  const colorByTone = {
    up: DARK.up,
    down: DARK.down,
    amber: DARK.amber,
    header: DARK.inkDim,
    muted: DARK.inkDim,
  } as const;
  const isHeader = tone === "header";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: columns,
        gap: 0,
        padding: "8px 18px",
        borderBottom: isHeader ? `1px solid ${DARK.border}` : `1px solid ${DARK.borderRow}`,
        background: isHeader ? DARK.panel : "transparent",
        color: tone ? colorByTone[tone] : DARK.inkBody,
        fontSize: isHeader ? 11 : 15,
        letterSpacing: isHeader ? "0.22em" : "normal",
        textTransform: isHeader ? "uppercase" : "none",
        fontWeight: isHeader ? 500 : bold ? 600 : 400,
        alignItems: "center",
      }}
    >
      {cells.map((c, i) => (
        <span key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c}
        </span>
      ))}
    </div>
  );
}
