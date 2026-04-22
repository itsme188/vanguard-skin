import type { ReactNode } from "react";

export type ChipTone =
  | "up"
  | "down"
  | "gold"
  | "info"
  | "neutral"
  | "warn";

export type ChipSize = "xs" | "sm";

const TONE_CLASSES: Record<ChipTone, string> = {
  up: "bg-up/20 text-up",
  down: "bg-down/20 text-down",
  gold: "bg-gold/20 text-gold",
  info: "bg-blue/20 text-blue",
  neutral: "bg-raised text-ink-dim",
  warn: "bg-amber-500/20 text-amber-300",
};

const SIZE_CLASSES: Record<ChipSize, string> = {
  xs: "text-[11px] px-1.5 py-0.5",
  sm: "text-xs px-2 py-0.5",
};

export function Chip({
  children,
  tone = "neutral",
  size = "sm",
  uppercase = false,
  title,
  className = "",
}: {
  children: ReactNode;
  tone?: ChipTone;
  size?: ChipSize;
  uppercase?: boolean;
  title?: string;
  className?: string;
}) {
  const upper = uppercase ? "uppercase tracking-wide" : "";
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full font-medium ${SIZE_CLASSES[size]} ${TONE_CLASSES[tone]} ${upper} ${className}`}
    >
      {children}
    </span>
  );
}
