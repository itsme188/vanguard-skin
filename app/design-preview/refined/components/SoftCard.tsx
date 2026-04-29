import type { CSSProperties, ReactNode } from "react";
import { SAGE } from "../palette";

interface Props {
  children: ReactNode;
  padding?: number;
  tint?: "surface" | "sage" | "linen" | "parchment" | "alt";
  style?: CSSProperties;
  bordered?: boolean;
}

const TINTS = {
  surface: SAGE.surface,
  sage: SAGE.sageMist,
  linen: SAGE.linen,
  parchment: SAGE.parchment,
  alt: SAGE.surfaceAlt,
} as const;

export function SoftCard({ children, padding = 22, tint = "surface", style, bordered = true }: Props) {
  return (
    <div
      style={{
        background: TINTS[tint],
        borderRadius: 12,
        padding,
        boxShadow: "0 1px 2px rgba(48, 50, 38, 0.04), 0 4px 16px rgba(48, 50, 38, 0.04)",
        border: bordered ? `1px solid ${SAGE.border}` : "none",
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Eyebrow({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-refined-mono)",
        fontSize: 13,
        fontWeight: 500,
        color: color ?? SAGE.inkDim,
        textTransform: "uppercase",
        letterSpacing: "0.14em",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 21,
        fontWeight: 600,
        margin: 0,
        color: SAGE.ink,
        letterSpacing: "-0.005em",
      }}
    >
      {children}
    </h3>
  );
}
