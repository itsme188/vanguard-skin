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
  | "amber-slate-thin"
  | "amber-slate-glow"
  | "amber-moss-thin"
  | "amber-moss-glow";

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
    id: "amber-slate-thin",
    name: "Amber · Slate thin border + saturated shadow",
    tagline: "3px slate border + heavily slate-tinted depth shadow.",
    description:
      "Border thinned from the chunky 6px down to 3px so it reads as a visible accent rather than a frame. Shadow saturation pushed hard — close drop at 55% opacity slate, ambient halo at 35%, plus a tight 1px ring inside. The slate color is now everywhere your eye goes: the thin border line, the colored close shadow under the card, and the colored ambient halo around it.",
    swatches: [
      { hex: "#3d556e", label: "Slate border" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-slate-glow",
    name: "Amber · Slate glow (no border)",
    tagline: "No border at all. The slate shadow does all the edge work.",
    description:
      "Removes the border entirely. The shadow takes over: a 1px slate ring acts as the card outline, then a heavily-saturated slate close drop + ambient halo create the depth. Cards look like they're floating in slate atmosphere — no hard line, just colored air around them. Most ambient version.",
    swatches: [
      { hex: "#3d556e", label: "Slate halo" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss-thin",
    name: "Amber · Moss thin border + saturated shadow",
    tagline: "3px moss border + heavily moss-tinted depth shadow.",
    description:
      "Same approach as the slate-thin variant but in moss `#3a4a3f`. Visible accent border + heavily saturated moss shadow (55% close, 35% halo). Picks up where moss-edges and moss-frame left off — finds the middle weight where both color and depth are simultaneously unmistakable.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss border" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss-glow",
    name: "Amber · Moss glow (no border)",
    tagline: "No border. Moss shadow does all the edge work.",
    description:
      "Same as slate-glow but in moss. No border at all; the moss-tinted shadow with its 1px ring + close drop + ambient halo defines and floats every card. Compare side-by-side with moss-thin to decide whether the page wants a hard border line at all.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss halo" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
];

export function getOption(id: string): OptionMeta | null {
  return OPTIONS.find((o) => o.id === id) ?? null;
}
