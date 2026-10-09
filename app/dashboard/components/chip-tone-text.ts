import { CHIP_TONE_CLASSES, type ChipTone } from "./Chip";

/**
 * The text-colour half of each checked Chip tone (the tone's classes minus
 * its background tint).
 *
 * For an element that keeps its own tint strength (a 10% or 15% button that
 * darkens on hover, a 5% banner) but needs small text that reaches 4.5:1 on
 * it. The Chip tones are checked on a 20% tint; a lighter tint only widens
 * the gap, and tests/repo/no-handrolled-failing-tint-pairs.test.ts measures
 * every tint strength this is used with.
 *
 * Derived, never hand-copied, so a change to the Chip table reaches every
 * user. The class names themselves are written out in Chip.tsx, which is
 * where Tailwind finds them.
 */
export const CHIP_TONE_TEXT = Object.fromEntries(
  (Object.keys(CHIP_TONE_CLASSES) as ChipTone[]).map((tone) => [
    tone,
    CHIP_TONE_CLASSES[tone]
      .split(/\s+/)
      .filter((cls) => !cls.startsWith("bg-"))
      .join(" "),
  ]),
) as Record<ChipTone, string>;

/**
 * Text on a SOLID gold fill (`bg-gold`): the primary buttons, the bell count
 * badge, the gold segment of the trade grades bar.
 *
 * The fill keeps the brand gold in both themes; the text is near-black in
 * both. Light gold (#b8860b) with the old cream `text-canvas` measured
 * 3.10:1; with `text-ink` it is 6.08:1. Dark gold (#ffb84d) keeps
 * `text-canvas` (11.52:1), so the dark theme renders exactly as before.
 * Hover states that lighten the fill (brightness, 90% opacity) only raise
 * the ratio. tests/repo/no-faded-small-status-text.test.ts pins the numbers
 * and fails on a new hand-written `bg-gold text-canvas`.
 */
export const GOLD_FILL_TEXT = "text-ink [[data-theme=dark]_&]:text-canvas";

/** The solid gold fill with its checked text. Use this, never `bg-gold text-canvas`. */
export const GOLD_FILL_CLASSES = `bg-gold ${GOLD_FILL_TEXT}`;

/**
 * A SOLID red destructive button with white text.
 *
 * The old fill, the red at 90% opacity under white text, measured 4.64:1
 * light and 4.44:1 dark, and the full red under white is 3.76:1 in the dark
 * theme (dark red is the lighter #ef4444). So the light theme takes the
 * full red (5.37:1) and the
 * dark theme takes the red at 80% toward black (5.51:1), which is close to
 * what 90% over a near-black surface already rendered. Opaque in both, so
 * the ratio no longer depends on the surface behind the button.
 */
export const DANGER_FILL_CLASSES =
  "bg-down text-white [[data-theme=dark]_&]:bg-[color:color-mix(in_srgb,var(--down)_80%,black)]";
