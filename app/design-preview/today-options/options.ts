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
  | "amber-moss-glow"
  | "amber-moss-glow-roomy"
  | "amber-moss-glow-airy"
  | "amber-moss-glow-rich";

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
    id: "amber-moss-glow",
    name: "Amber · Moss glow (current baseline)",
    tagline: "No border. Moss shadow grounded with current saturation. Reference point.",
    description:
      "Where we landed last iteration: 1px moss ring + close drop at 70% opacity (Y=6, blur=18) + ambient halo at 45% (Y=14, blur=36). Use this as the reference to compare the three new variants against.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss-glow-roomy",
    name: "Amber · Moss glow — roomy (your pick)",
    tagline: "Wide-reach shadow, soft. The direction you confirmed.",
    description:
      "What you confirmed last round. Close drop Y=8 blur=24 at 65%, ambient halo Y=28 blur=64 at 40%. Cards breathe; shadow extends well past the card edges. Reference point for the two new variants.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss-glow-airy",
    name: "Amber · Moss glow — airy (even more reach)",
    tagline: "Pushes breathing room further. Cards float in even more space.",
    description:
      "Roomy + more reach. Close drop Y=10 blur=32, ambient halo Y=40 blur=88 — significantly bigger physical extent than the roomy baseline. Opacities held proportional to keep the wider shadow soft (close 60%, ambient 38%). The 'how big can the breathing room get' direction.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss (airy)" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss-glow-rich",
    name: "Amber · Moss glow — rich (same reach, more color)",
    tagline: "Roomy's physical extent, but with louder moss saturation.",
    description:
      "Same Y-offsets and blur values as the roomy baseline (the breathing room you liked) — but opacities pushed up. Ring 20%→30%, close drop 65%→80%, ambient halo 40%→55%. The wider shadow now carries more moss pigment. Combines your two earlier preferences (more color AND more breathing room).",
    swatches: [
      { hex: "#3a4a3f", label: "Moss (rich)" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
];

export function getOption(id: string): OptionMeta | null {
  return OPTIONS.find((o) => o.id === id) ?? null;
}
