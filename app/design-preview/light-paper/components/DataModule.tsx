import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  dense?: boolean;
}

export function DataModule({ title, subtitle, action, children, dense }: Props) {
  return (
    <div
      style={{
        background: "#0a0a0a",
        border: "1px solid #1f1f1f",
        borderRadius: 4,
        overflow: "hidden",
        fontFamily: "var(--font-geist-mono)",
        color: "#ddd",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #1f1f1f",
          background: "#0d0d0d",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#888",
              fontWeight: 500,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{subtitle}</div>
          )}
        </div>
        {action && (
          <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.18em", textTransform: "uppercase" }}>
            {action}
          </div>
        )}
      </div>
      <div style={{ padding: dense ? 12 : 18 }}>{children}</div>
    </div>
  );
}

export function DataLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-geist-mono)",
        fontSize: 10,
        letterSpacing: "0.22em",
        textTransform: "uppercase",
        color: "#888",
      }}
    >
      {children}
    </span>
  );
}
