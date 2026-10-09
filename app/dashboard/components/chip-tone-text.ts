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
