/**
 * Four cohesive design directions for the Today page.
 *
 * Each option overrides design tokens within a `[data-preview="<id>"]`
 * scope so the shared TodayPreview component renders four distinct
 * visual treatments without code duplication. Token overrides live in
 * `options.css`; this file is just the metadata + descriptions shown
 * on the landing page.
 */

export type OptionId = "quiet" | "zones" | "newsprint" | "editorial";

export interface OptionMeta {
  id: OptionId;
  name: string;
  tagline: string;
  description: string;
  swatches: { hex: string; label: string }[];
}

export const OPTIONS: OptionMeta[] = [
  {
    id: "quiet",
    name: "Quiet",
    tagline: "Uniform ivory cards. Color through accents only.",
    description:
      "Every card sits on the same panel-ivory. The page is calm; the data is the color. Moss eyebrows, sage gain numbers, sienna loss numbers, slate metadata. Cohesion through discipline — no surface zones.",
    swatches: [
      { hex: "#fffefa", label: "Panel" },
      { hex: "#f7f4ed", label: "Canvas" },
      { hex: "#3a4a3f", label: "Moss accent" },
      { hex: "#3d556e", label: "Slate accent" },
    ],
  },
  {
    id: "zones",
    name: "Zones",
    tagline: "Brand surfaces in sage. Context surfaces in warm tan. Data in ivory.",
    description:
      "Three surface tones used systematically. Hero and brand-anchor cards in pigmented sage. Macro/context cards in pigmented warm tan. Data cards in ivory. Each surface tells you what kind of content it holds.",
    swatches: [
      { hex: "#d4e3d0", label: "Sage (brand)" },
      { hex: "#e8d2af", label: "Warm tan (context)" },
      { hex: "#fffefa", label: "Ivory (data)" },
      { hex: "#3a4a3f", label: "Moss" },
    ],
  },
  {
    id: "newsprint",
    name: "Newsprint",
    tagline: "Pure white cards on cool cream. Color lives in chips.",
    description:
      "Cards become pure white paper sitting on a cooler, slightly grey-tinted cream. Color is concentrated in eyebrows, status chips, and dividers. Like a quality finance newspaper — black ink, white paper, occasional accent of red/green/blue. Maximum clarity.",
    swatches: [
      { hex: "#ffffff", label: "White (panel)" },
      { hex: "#f3f1e8", label: "Cool cream" },
      { hex: "#2d3a30", label: "Deep moss" },
      { hex: "#a05a4f", label: "Sienna" },
    ],
  },
  {
    id: "editorial",
    name: "Editorial",
    tagline: "Magazine page. Bigger type. Cards bleed into canvas.",
    description:
      "Less Bloomberg, more Financial Times. Serif headlines. Bigger body type. Card boundaries soften — most are just dividers. Vertical rhythm leads the eye. Reads like the morning briefing email rendered as a page.",
    swatches: [
      { hex: "#f1ead4", label: "Warm paper" },
      { hex: "#3a4a3f", label: "Moss (headlines)" },
      { hex: "#1f211c", label: "Ink (body)" },
      { hex: "#a05a4f", label: "Sienna" },
    ],
  },
];

export function getOption(id: string): OptionMeta | null {
  return OPTIONS.find((o) => o.id === id) ?? null;
}
