import type { ReactNode } from "react";
import { SAGE } from "../palette";
import { Eyebrow } from "./SoftCard";

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
    <section id={id} style={{ marginTop: 64, scrollMarginTop: 88 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 24,
          marginBottom: 24,
          flexWrap: "wrap",
        }}
      >
        <div>
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h2
            style={{
              fontSize: "clamp(28px, 3.5vw, 38px)",
              fontWeight: 600,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
              margin: 0,
              color: SAGE.ink,
            }}
          >
            {title}
          </h2>
          {subtitle && (
            <p
              style={{
                fontSize: 15,
                color: SAGE.inkDim,
                margin: 0,
                marginTop: 8,
                maxWidth: 600,
                lineHeight: 1.55,
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </header>
      <div className="rf-section-children" style={{ display: "grid", gap: 16 }}>
        {children}
      </div>
    </section>
  );
}
