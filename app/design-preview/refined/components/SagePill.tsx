import type { ReactNode } from "react";
import { SAGE } from "../palette";

interface Props {
  children: ReactNode;
  tone?: "up" | "down" | "neutral" | "brand" | "accent" | "linen";
  size?: "xs" | "sm";
  variant?: "filled" | "outlined";
  mono?: boolean;
}

const TONES = {
  up: { bg: SAGE.upTint, color: SAGE.up, border: SAGE.upGlow },
  down: { bg: SAGE.downTint, color: SAGE.down, border: SAGE.downGlow },
  neutral: { bg: SAGE.surfaceAlt, color: SAGE.inkDim, border: SAGE.border },
  brand: { bg: SAGE.brand, color: SAGE.surface, border: SAGE.brand },
  accent: { bg: SAGE.sageMist, color: SAGE.brandSoft, border: SAGE.upGlow },
  linen: { bg: SAGE.linen, color: SAGE.inkDim, border: SAGE.border },
} as const;

const SIZES = {
  xs: { fs: 12, px: 9, py: 2 },
  sm: { fs: 13, px: 11, py: 3 },
} as const;

export function SagePill({ children, tone = "neutral", size = "sm", variant = "filled", mono }: Props) {
  const t = TONES[tone];
  const s = SIZES[size];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${s.py}px ${s.px}px`,
        background: variant === "filled" ? t.bg : "transparent",
        color: t.color,
        border: variant === "outlined" ? `1px solid ${t.border}` : "none",
        borderRadius: 999,
        fontSize: s.fs,
        fontWeight: 500,
        fontFamily: mono ? "var(--font-refined-mono)" : "var(--font-refined-sans)",
        letterSpacing: mono ? "0.02em" : "0",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
