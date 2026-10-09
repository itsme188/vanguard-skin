import type { ReactNode } from "react";

export type ChipTone =
  | "up"
  | "down"
  | "gold"
  | "info"
  | "neutral"
  | "warn";

export type ChipSize = "xs" | "sm";

/**
 * Background tint and text colour per tone. Chip text is 11 to 12px, the
 * small-text contrast tier: each tone reaches 4.5:1 against its own tint in
 * BOTH themes, on the page canvas, a panel and a raised surface
 * (tests/dashboard/chip-contrast-nowrap.test.tsx computes the ratios from
 * globals.css, so a token change that drops one below the floor fails).
 *
 * Where the plain token failed, the text is the same hue pulled toward the
 * far end, and the plain token stays wherever it passed:
 * - up: light 3.56 to 3.92 with the plain token, 4.98 to 5.48 at 80% + black.
 * - down: light 3.57 to 3.93, now 4.99 to 5.49 at 80% + black; dark 4.06 to
 *   4.33, now 5.11 to 5.45 at 80% + white.
 * - gold: light 3.94 to 4.32 with gold-ink, now 5.47 to 5.99 at 80% + black.
 * - info, neutral and warn passed in both themes and are unchanged.
 *
 * Exported so a chip-shaped element that cannot be a <Chip> (the
 * reconciliation difference chip) takes the same checked pairs.
 */
export const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  up: "bg-up/20 text-[color:color-mix(in_srgb,var(--up)_80%,black)] [[data-theme=dark]_&]:text-up",
  down: "bg-down/20 text-[color:color-mix(in_srgb,var(--down)_80%,black)] [[data-theme=dark]_&]:text-[color:color-mix(in_srgb,var(--down)_80%,white)]",
  gold: "bg-gold/20 text-[color:color-mix(in_srgb,var(--gold-ink)_80%,black)] [[data-theme=dark]_&]:text-gold-ink",
  info: "bg-blue/20 text-blue",
  neutral: "bg-raised text-ink-dim",
  // The theme-aware --warn token, not raw amber.
  warn: "bg-warn/20 text-warn",
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
  // whitespace-nowrap: a chip is one line. A two-word chip that wraps
  // stacks inside its rounded-full pill and paints as a blob (seen at 390px).
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full font-medium ${SIZE_CLASSES[size]} ${CHIP_TONE_CLASSES[tone]} ${upper} ${className}`}
    >
      {children}
    </span>
  );
}
