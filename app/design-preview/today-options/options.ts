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
  | "amber-moss-glow-saturated"
  | "amber-moss-glow-roomy"
  | "amber-moss-glow-balanced";

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
    id: "amber-moss-glow-saturated",
    name: "Amber · Moss glow — more color",
    tagline: "Same physical extent, much more moss saturation.",
    description:
      "Pushes color hard while keeping the grounded shape. Ring 20%→30%, close drop 70%→85%, ambient halo 45%→60%. Same Y-offsets and blur values as the baseline so cards still sit grounded — just more moss pigment in every layer. The 'how saturated can it go before it's too much' direction.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss (saturated)" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss-glow-roomy",
    name: "Amber · Moss glow — more breathing room",
    tagline: "Shadow extends farther from the card. Cards have room around them.",
    description:
      "Pushes the shadow's physical reach back out. Close drop Y 6→8 + blur 18→24, ambient halo Y 14→28 + blur 36→64. Color saturation slightly reduced (70%→65%, 45%→40%) so the wider blur reads soft instead of muddy. Cards have more space around them; the moss color fills more of the page. The 'longer shadow' direction.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss (roomy)" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
  {
    id: "amber-moss-glow-balanced",
    name: "Amber · Moss glow — my best guess",
    tagline: "A touch more color + a touch more breathing room than the baseline.",
    description:
      "What I'd recommend: ring 20%→25%, close drop 70%→78% (more visible color), ambient halo opacity 45%→52% + Y 14→18 + blur 36→44 (slightly more reach without going floaty). Splits the difference between the saturated and roomy directions — both color and breathing room get a small bump from the baseline.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss (balanced)" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
  },
];

export function getOption(id: string): OptionMeta | null {
  return OPTIONS.find((o) => o.id === id) ?? null;
}
