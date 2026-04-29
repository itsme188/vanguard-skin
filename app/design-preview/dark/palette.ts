/**
 * Bloomberg-pro dark mode palette.
 * Soft black canvas, hairline borders, amber brand, semantic green/red.
 * Strictly professional — no sage, no cream, no rounded warmth.
 */
export const DARK = {
  // Surfaces
  canvas: "#0a0a0a",
  panel: "#0d0d0d",
  raised: "#111111",

  // Borders (hairline)
  border: "#1f1f1f",
  borderStrong: "#2a2a2a",
  borderRow: "#161616",

  // Text
  ink: "#e5e5e5",
  inkBody: "#d4d4d4",
  inkDim: "#888888",
  inkFaint: "#555555",

  // Brand — amber (the only warm color, used sparingly)
  amber: "#ffb84d",
  amberDim: "#bf8a3a",

  // Status — pure semantic
  up: "#22c55e",
  upDim: "#1a8c44",
  down: "#ef4444",
  downDim: "#a83232",

  // Misc accents
  blue: "#60a5fa",
  blueDim: "#3a6592",
} as const;
