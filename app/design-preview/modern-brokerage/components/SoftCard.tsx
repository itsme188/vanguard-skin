import type { CSSProperties, ReactNode } from "react";

interface Props {
  children: ReactNode;
  padding?: number;
  tint?: "cream" | "mint" | "lavender" | "rose" | "amber" | "white";
  style?: CSSProperties;
}

const TINTS: Record<NonNullable<Props["tint"]>, string> = {
  cream: "#fef9f0",
  mint: "#f0fdf4",
  lavender: "#faf5ff",
  rose: "#fff1f2",
  amber: "#fffbeb",
  white: "#ffffff",
};

export function SoftCard({ children, padding = 24, tint = "white", style }: Props) {
  return (
    <div
      style={{
        background: TINTS[tint],
        borderRadius: 16,
        padding,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04)",
        border: "1px solid rgba(0,0,0,0.04)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: "#71717a",
        marginBottom: 8,
        letterSpacing: "0.02em",
      }}
    >
      {children}
    </div>
  );
}

export function CategoryChip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "up" | "down" | "amber" | "blue" | "neutral";
}) {
  const TONE = {
    up: { bg: "#dcfce7", color: "#166534" },
    down: { bg: "#fee2e2", color: "#991b1b" },
    amber: { bg: "#fef3c7", color: "#92400e" },
    blue: { bg: "#dbeafe", color: "#1e40af" },
    neutral: { bg: "#f4f4f5", color: "#52525b" },
  } as const;
  const c = TONE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 10px",
        background: c.bg,
        color: c.color,
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
}
