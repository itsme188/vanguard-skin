/**
 * Four cohesive design directions for the Today page.
 *
 * Each option overrides design tokens within a `[data-preview="<id>"]`
 * scope so the shared TodayPreview component renders four distinct
 * visual treatments without code duplication. Token overrides live in
 * `options.css`; this file is just the metadata + descriptions shown
 * on the landing page.
 */

export type OptionId =
  | "quiet"
  | "zones"
  | "newsprint"
  | "forest"
  | "sienna"
  | "amber"
  | "amber-slate"
  | "amber-moss"
  | "amber-sienna";

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
    id: "forest",
    name: "Forest",
    tagline: "Deeper greens. Richer brand. Same cream paper.",
    description:
      "Punchier Sage & Linen. The brand moss goes from quiet `#3a4a3f` to deep forest `#1f3a28` — same family, real depth. Adds a rich amber accent (`#c08c3b`) for moments of warmth. Cream canvas slightly more pigmented. The earth tones stay; they just speak louder.",
    swatches: [
      { hex: "#1f3a28", label: "Deep forest" },
      { hex: "#c08c3b", label: "Amber accent" },
      { hex: "#fffefa", label: "Ivory" },
      { hex: "#f1ead4", label: "Warm cream" },
    ],
  },
  {
    id: "sienna",
    name: "Sienna",
    tagline: "Burnt-sienna brand. Browns lead. Moss recedes.",
    description:
      "Inverts the palette weight. Sienna `#a05a4f` becomes the brand color — the warm reddish-brown leads headlines, eyebrows, brand surfaces. Moss steps back to a quieter status role. Distinctive, warm, less green-dominant. A different identity built from the same pigments.",
    swatches: [
      { hex: "#a05a4f", label: "Burnt sienna" },
      { hex: "#fffefa", label: "Ivory cards" },
      { hex: "#f4ecd9", label: "Warm cream" },
      { hex: "#5a7a5c", label: "Sage (data)" },
    ],
  },
  {
    id: "amber",
    name: "Amber",
    tagline: "Bloomberg-light. Vivid amber brand. White cards.",
    description:
      "What the dark Bloomberg-pro mode looks like flipped to light. Brand becomes vivid amber `#b8860b`. Cards are pure white on a near-white cream. Status colors push toward true emerald + ruby for energetic data. High-contrast, energetic, financial-terminal-meets-newsroom. Pale tan borders.",
    swatches: [
      { hex: "#b8860b", label: "Vivid amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#0d9456", label: "Emerald" },
      { hex: "#c8311c", label: "Ruby" },
    ],
  },
  {
    id: "amber-slate",
    name: "Amber · Slate edges",
    tagline: "Amber base. Cards framed in the slate blue you picked earlier.",
    description:
      "Same slate blue (`#3d556e`) you approved as the 4th-color accent in light mode — now applied at full strength on every card border. Cool counterpoint to the warm amber brand. Cohesive with the rest of the app since slate is already in the production palette.",
    swatches: [
      { hex: "#3d556e", label: "Slate edge" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss",
    name: "Amber · Moss edges",
    tagline: "Amber base. Cards framed in the original moss green.",
    description:
      "The deep moss `#3a4a3f` from the original Sage & Linen brand color, now used as a structural element. Earthy and confident — the green you started with returns as the frame around every card while amber leads accents.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss edge" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-sienna",
    name: "Amber · Sienna edges",
    tagline: "Amber base. Cards framed in burnt sienna brown.",
    description:
      "The burnt sienna `#a05a4f` from the original Sage & Linen palette (currently the `--down` status color) as borders. Warm reddish-brown frames pair with the amber brand for an entirely warm-led identity — no cool tones in the chrome at all.",
    swatches: [
      { hex: "#a05a4f", label: "Sienna edge" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
];

export function getOption(id: string): OptionMeta | null {
  return OPTIONS.find((o) => o.id === id) ?? null;
}
