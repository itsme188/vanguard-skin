import type { ReactNode } from "react";

interface Props {
  id?: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  bare?: boolean;
}

export function PaperSection({ id, eyebrow, title, subtitle, action, children, bare }: Props) {
  return (
    <section id={id} style={{ marginTop: 64, scrollMarginTop: 80 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          paddingBottom: 16,
          marginBottom: 24,
          borderBottom: "1px solid #d8d2c3",
          flexWrap: "wrap",
        }}
      >
        <div>
          {eyebrow && (
            <p
              style={{
                fontFamily: "var(--font-geist-mono)",
                fontSize: 11,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "#8a7d65",
                margin: 0,
                marginBottom: 6,
              }}
            >
              {eyebrow}
            </p>
          )}
          <h2
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(28px, 4vw, 40px)",
              lineHeight: 1.1,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </h2>
          {subtitle && (
            <p style={{ fontSize: 15, color: "#5a5a5a", margin: 0, marginTop: 6 }}>{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      {bare ? children : <div className="lp-section-children" style={{ display: "grid", gap: 24 }}>{children}</div>}
    </section>
  );
}

export function PaperCard({ children, padding = 24 }: { children: ReactNode; padding?: number }) {
  return (
    <div
      style={{
        background: "#fffefb",
        border: "1px solid #e4dfd0",
        borderRadius: 6,
        padding,
      }}
    >
      {children}
    </div>
  );
}
