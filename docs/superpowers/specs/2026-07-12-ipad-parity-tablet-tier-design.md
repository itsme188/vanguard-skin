# iPad Parity — Tablet Tier Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm approach B — designed tablet tier, not spot fixes)
**Device target:** iPad Pro / Air 11″ (portrait 820–834 × landscape 1180–1194 logical px), Safari over Cloudflare Mesh
**User goal:** "Everything" — full parity including Import, forms, and modals; both orientations must work well

## Problem

The app has exactly two layouts pivoting on one 768px boundary (`useIsMobile` =
`max-width: 767px`; `MobileBottomNav` = `md:hidden`; desktop tabs = `hidden md:flex`).
An 11″ iPad in portrait gets the full **desktop** experience at 820–834px — a width the
desktop layout was never designed for — and drives it with a finger, an input mode the
desktop layout assumes doesn't exist (only `EarningsRowChips` has coarse-pointer
handling today). Between `md` (768) and `xl` (1280) there is almost no intentional
styling (`lg:` in 4 components, no `2xl:` in the dashboard). Landscape (1180–1194)
stays below the 1280 chat-rail threshold, so it too is uncharted.

## What the tablet tier is

A **defined rule system for the md→xl band (768–1279px) plus a touch-input layer** —
not a third layout fork. The app keeps its two layouts; the desktop layout gains
explicit, designed behavior in the band, and every interactive element gains defined
touch behavior.

### Hard guarantees

1. **Nothing changes at ≥1280px or in Electron.** Every layout rule is scoped with
   band variants (`md:max-xl:`, `md:max-lg:`, `lg:max-xl:`); every touch rule uses
   `pointer-coarse:` variants that mouse input never activates.
2. **The phone layout (<768) is untouched** — iPhone and iPad mini portrait unchanged.
3. **No breakpoint values change.** `useIsMobile` stays at 767; `md`/`lg`/`xl` stay
   at Tailwind defaults.

### Audit-calibrated, rule-driven

The work still **starts with a structured audit** (Phase 0) at 834×1194 and 1194×834
with touch emulation. Findings are classified into the rule categories below; each
rule is designed once and applied everywhere it belongs — including instances the
audit didn't happen to catch. The audit calibrates the design; it doesn't replace it.

## Foundation

**Band expression:** Tailwind v4 native stacked variants only —
`md:max-xl:` (whole band), `md:max-lg:` (portrait band, 768–1023),
`lg:max-xl:` (landscape band, 1024–1279). No custom breakpoints, no new tokens.

## Rule system

### Touch layer (T-rules, `pointer-coarse:` — inert under a mouse; also benefits iPhone)

- **T1 — tap-trap sweep.** Every `opacity-0 group-hover:opacity-100` interactive
  element: `pointer-coarse:hidden` + an always-visible affordance
  (`hidden pointer-coarse:inline-flex`). Precedent: `EarningsRowChips` PhaseChip
  (`26b566f`). Inventory grep: `opacity-0` near `onClick`.
- **T2 — 44pt tap targets.** Small icon buttons (sort headers, chip ✕s, row actions,
  header icons): hit-area extension via `after:` pseudo-element or
  `pointer-coarse:` padding. Visual size unchanged.
- **T3 — hover-only information.** Anything conveyed only by CSS `:hover` or `title`
  attributes gets a tap path (click-toggle popover, inline surfacing, or tap-once
  reveal). Click-driven popovers (DataConfidenceIndicator, TabDropdown) need
  verification only.
- **T4 — iOS input-zoom kill.** One global rule in `globals.css`:
  `@media (pointer: coarse) { input, select, textarea { font-size: 16px; } }`
  Safari auto-zooms any focused input under 16px — most of the app's 11–14px form
  fields trigger it. Highest-impact single fix. (Audit any input whose layout
  assumes the smaller font.)

### Layout rules (G-rules, band variants)

- **G1 — grid steps.** Desktop grids ≥3 columns step to 2 in the portrait band
  (`md:max-lg:grid-cols-2`); 2-col layouts step to 1 only where the audit shows real
  cramping. Applied per-grid from the audit inventory.
- **G2 — tables.** The existing `overflow-x-auto` container convention is the answer;
  the audit verifies every wide table is wrapped, unwrapped ones get wrapped. No
  column-hiding schemes.
- **G3 — fixed widths.** Any fixed-px panel/modal → `w-full max-w-[Npx]` so 834px
  never clips it.
- **G4 — charts.** Verify LightweightCharts/Recharts containers resize on orientation
  change (ResizeObserver / responsive containers); LWC touch crosshair behaves;
  explicit in-band min-heights where needed.

### Chrome rules

- **Header condensation (priority-ordered).** If the audit shows crowding at 820–834:
  lowest-priority items hide in the portrait band via `md:max-lg:hidden` —
  AppVersion first, TwsStatus text (→ dot-only) second. Title, search, settings,
  confidence indicator, chat toggle always stay.
- **TabNav.** All 6 tabs visible without scrolling in-band (compact padding via band
  variants if needed); existing `overflow-x-auto` remains the fallback.
  `TabDropdown` verified under touch.
- **No bottom nav on iPad** — desktop tabs are the navigation (this is what makes
  "Everything" reachable; the bottom nav only exposes 5 destinations).

### Overlay rules

- **Chat** stays the 480px overlay drawer across the whole band (58% of portrait
  width). No rail below 1280 (unchanged). Drawer gets `max-w-[100vw]` safety.
- **Modals** (BogeysEdit, CallNote, EarningsEmailViewer, ManageSources, …):
  `max-h-[85dvh] overflow-y-auto`, band-safe max-widths (G3), tap-sized dismiss
  affordances (T2). `EarningsEmailViewer` iframe sizing verified at band widths.
- **NotesAmbient FAB + chat input** respect safe-area padding (`pb-safe`).
- **Keyboard shortcuts** (Cmd+K/J/;) all have visible button equivalents — audit
  confirms each is touch-reachable.

### iPadOS Safari rules

- `100vh` → `100dvh` for full-height overlays (Safari's collapsing toolbar makes
  `vh` lie).
- `viewport-fit=cover` + `pb-safe` already exist from the iPhone work — verify they
  apply to the desktop-layout surfaces shown on iPad.
- Import: click-to-browse `<input type="file">` is the path (iPadOS Files picker);
  drag-drop not required. Verify accept attributes admit PDF/CSV.
- `-webkit-text-size-adjust: 100%` verified in the CSS reset.

## Explicitly out of scope

- No third layout fork, no tablet-specific components.
- No bottom nav on iPad.
- No breakpoint value changes.
- No changes at ≥1280 (desktop/Electron) or <768 (phone).
- SettingsModal stays Electron-only (settings continue to live on the Mac).
- Nightly deep-QA tablet-viewport zone: optional follow-up, not in this scope.

## Phases

- **Phase 0 — Audit.** 4 parallel browser agents at 834×1194 and 1194×834
  (`hasTouch: true`) sweep all 6 tabs + Security Detail + alerts inbox + the modal
  set. Findings classified into T/G/chrome/Safari rule categories → inventory doc.
- **Phase 1 — Foundation.** T4 global input rule, dvh sweep, text-size-adjust check,
  T1 tap-trap sweep from grep inventory, T2 pass over the shared primitives
  (`SortableHeader`, `Chip`, header icon buttons, modal dismiss buttons).
- **Phase 2 — Layout.** G1–G4 applied per the audit inventory; chrome condensation
  if flagged; overlay rules.
- **Phase 3 — Verification.** Browser-agent E2E at both viewports; 1440×900
  spot-check proving desktop unchanged; full test suite; screenshots reviewed.
- **Phase 4 — Real device.** User enrolls iPad in Cloudflare One (team `isafier`,
  same as iPhone), opens `http://100.96.0.1:3099`, live pass; findings feed back.

## Verification standard

Per repo rules: full `npx vitest run` green before any commit; E2E via browser
agents as a real user would (both viewports, touch emulation, actual taps on real
flows: alerts triage, level edit, bogeys entry, import preview, chat); no
regression screenshots at desktop width.
