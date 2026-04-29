import type { ReactNode } from "react";

interface Props {
  id?: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function HeroBlock({ id, eyebrow, title, subtitle, action, children }: Props) {
  return (
    <section id={id} style={{ marginTop: 80, scrollMarginTop: 88 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 24,
          marginBottom: 28,
          flexWrap: "wrap",
        }}
      >
        <div>
          {eyebrow && (
            <p
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "#a1a1aa",
                margin: 0,
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {eyebrow}
            </p>
          )}
          <h2
            style={{
              fontSize: "clamp(32px, 4vw, 44px)",
              fontWeight: 600,
              letterSpacing: "-0.025em",
              lineHeight: 1.05,
              margin: 0,
              color: "#0a0a0a",
            }}
          >
            {title}
          </h2>
          {subtitle && (
            <p style={{ fontSize: 17, color: "#52525b", margin: 0, marginTop: 8, maxWidth: 600, lineHeight: 1.5 }}>
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </header>
      <div className="mb-section-children" style={{ display: "grid", gap: 20 }}>{children}</div>
    </section>
  );
}
