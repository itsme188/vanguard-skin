import type { ReactNode } from "react";

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
        border: "1px solid #1f1f1f",
        background: "#050505",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          background: "#0a0a0a",
          borderBottom: "1px solid #1f1f1f",
        }}
      >
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#d4d4d4",
            fontWeight: 500,
          }}
        >
          {title}
        </span>
        {meta && (
          <span
            style={{
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#666",
            }}
          >
            {meta}
          </span>
        )}
      </header>
      <div className="t-frame-body" style={{ padding: 0 }}>
        <div>{children}</div>
      </div>
    </section>
  );
}

export function TerminalKpiRow({ items }: { items: { label: string; value: string; tone?: "up" | "down" | "amber" | "neutral" }[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${items.length}, 1fr)`,
        borderBottom: "1px solid #1f1f1f",
      }}
    >
      {items.map((kpi, i) => (
        <div
          key={kpi.label}
          style={{
            padding: "12px 16px",
            borderRight: i < items.length - 1 ? "1px solid #161616" : "none",
          }}
        >
          <div
            style={{
              fontSize: 9,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#666",
              marginBottom: 4,
            }}
          >
            {kpi.label}
          </div>
          <div
            style={{
              fontSize: 18,
              color:
                kpi.tone === "up"
                  ? "#22c55e"
                  : kpi.tone === "down"
                  ? "#ef4444"
                  : kpi.tone === "amber"
                  ? "#ffb84d"
                  : "#eee",
              fontFeatureSettings: '"tnum"',
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
    up: "#22c55e",
    down: "#ef4444",
    amber: "#ffb84d",
    header: "#666",
    muted: "#888",
  } as const;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: columns,
        gap: 0,
        padding: "5px 16px",
        borderBottom: tone === "header" ? "1px solid #1f1f1f" : "1px solid #0f0f0f",
        background: tone === "header" ? "#0a0a0a" : "transparent",
        color: tone ? colorByTone[tone] : "#d4d4d4",
        fontSize: tone === "header" ? 9 : 13,
        letterSpacing: tone === "header" ? "0.22em" : "normal",
        textTransform: tone === "header" ? "uppercase" : "none",
        fontWeight: bold ? 600 : 400,
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
