# iPad 11″ Audit Inventory — Phase 0 (2026-07-12)

Audited at 834×1194 (portrait) and 1194×834 (landscape), Safari-class viewport via
playwright agents against the live dev server. 4 parallel agents; every finding
verified against a URL+dimension-checked screenshot (agents shared one browser and
re-verified each capture due to contention).

**Structural result: clean.** No route shows page-level horizontal scroll in either
orientation. None of the 18 pre-grepped `grid-cols-3+` components cramp — G1 grid
steps are NOT needed. All wide tables are inside `overflow-x-auto` containers (G2
wrapping not needed). Charts (LWC + Recharts) render and size correctly (G4 clean).
No G3 fixed-width clipping. Landscape header/nav fits on one line. Chat drawer and
BogeysEditModal fit and function in both orientations.

The real problems: pervasive under-sized tap targets (T2), one destructive
hover-only control (T1), the Accounts table's low-contrast scroll affordance, and
FAB-over-content overlap.

## Findings

| # | vp | route | file | symptom | rule | sev |
|---|----|-------|------|---------|------|-----|
| 1 | P | /dashboard/accounts?id=all | `app/dashboard/components/AccountsView.tsx` (holdings table) + `app/globals.css:506-521` | Value column hard-clips mid-digit on every row incl. total; existing 32px right-edge fade is too low-contrast to notice (landscape agent confirmed fade exists but is missable) | G2-affordance | high |
| 2 | P | /dashboard/alerts | alerts inbox fired-row (`app/dashboard/alerts/` components) | dismiss "×" is 7×16px — smallest target in app, destructive | T2 | high |
| 3 | P | /dashboard/alerts + /dashboard/alerts?view=armed | NotesAmbient FAB (bottom-right pencil) vs list rows | fixed FAB overlaps row content (AMZN "NOW $…" hidden behind pencil) in the bottom ~72–120px band of long lists | OVERLAY (FAB clearance) | med-high |
| 4 | P/L | /dashboard/today | `app/dashboard/today/EarningsRowChips.tsx` | row chips ~30×19px; TSM row ✕ dismiss 18×19px (file already has pointer-coarse for skip-✕ — extend to all chips) | T2 | med |
| 5 | P | /dashboard/alerts | alert card actions | Approve 65×25 / Reject 55×25; Acted/Ignore 25px tall; filter tabs + sort pills 25px | T2 | med |
| 6 | P | /dashboard/security/[id] | `app/dashboard/components/LevelsPanel.tsx` | PAUSE ~65×28, remove "×" ~29×28 (destructive), ACCEPT ~86×31, "+ Add Level" 31px | T2 | med |
| 7 | P/L | chat drawer | `app/dashboard/components/ChatInterface.tsx:271` | conversation delete is `opacity-0 group-hover:` — invisible-but-tappable destructive action on touch (code-confirmed) | T1 | med |
| 8 | P | /dashboard/research?view=feeds | article card ticker chips | ticker chips ~38×20px links, dozens per page | T2 | med |
| 9 | P | /dashboard/import | Import History "Undo" link | 29×16px mutating action (removes an import batch) | T2 | med |
| 10 | P | /dashboard/analysis | Cash-Deploy card `input[placeholder="Amount to deploy"]` | 128px-wide input truncates its own placeholder | G3-ish (width) | med |
| 11 | P | all | `app/dashboard/layout.tsx` header | icon-row targets under 40px: bell 18×18, gear ~16, confidence pill 36×17, Chat 68×30 | T2 | low-med |
| 12 | P | /dashboard/alerts | toolbar | "Approve all"/"Suggest all"/"Scan now" 30px tall | T2 | low-med |
| 13 | P | all | header brand | "Portfolio Desk" wordmark wraps to 2 lines at 834px | CHROME | low |
| 14 | P | all | TwsStatus pill | "TWS Disconnected · Plaid synced 13h ago" wraps to 2 lines at 834px | CHROME | low |
| 15 | P | /dashboard/analysis | Cash-Deploy "Suggest"/"+ Add leg"/"Compute Δ" | 30px tall | T2 | low |
| 16 | P | /dashboard/analysis | Macro-this-week "View sources →" links | 17px tall | T2 | low |
| 17 | P | /dashboard/analysis | `app/dashboard/components/TabDropdown.tsx` | subview menu rows ~32px | T2 | low |
| 18 | P | /dashboard/charts + security detail | `SecurityChart.tsx` toolbar | toolbar overflows with native-scrollbar-only affordance (no fade) | G2-affordance | low |
| 19 | P | /dashboard/security/[id] | quote-stats strip | 4+1 uneven wrap (ATR alone on row 2) | G1 (minor) | low |
| 20 | P | /dashboard/import | Import History table | Type badge wraps mid-word; Date column wraps to 3 lines/row | G1 (minor) | low |
| 21 | P | /dashboard/today | Bogeys modal buttons | Cancel/Save/✕ under 40px (modal otherwise fits perfectly) | T2 | low |
| 22 | P | /dashboard/research?view=feeds | toolbar | "Email…" button sits flush against right viewport edge (reads as clipped) | cosmetic | low |

## Excluded / clarified

- Black "N" circle bottom-left = **Next.js dev-tools indicator** (dev-server only,
  absent in Electron/production; DOM-confirmed by agent B). Not a finding. The real
  FAB overlap (#3) is the cream pencil NotesAmbient FAB bottom-right.
- Landscape sweep: zero layout findings beyond #4's chip sizing — landscape is
  structurally clean.
- Import "Browse Files" button exists and is adequately sized — iPadOS file-picker
  path confirmed (spec SAFARI requirement pass).
- No hover-only findings besides #7 in live sweeps (T1 clean elsewhere).

## Not verified (residual)

- Charts "Watchlist" multi-chart sub-view — browser contention prevented a stable
  capture. Re-check in Task 8 verification.
- T4 input-zoom is invisible to playwright (Safari-only behavior) — fix ships on
  spec, verified on real device in Phase 4.

## Task routing

- Task 2 (foundation T4/dvh/text-size-adjust): unchanged, ships on spec.
- Task 3 (T1 ChatInterface delete): finding #7.
- Task 4 (T2 primitives): findings #11, #17 (+ SortableHeader per plan).
- Task 5 (per-surface, replaces the G-heavy scope — grids were clean): #2, #4, #5,
  #6, #8, #9, #10, #12, #15, #16, #19, #20, #22 (T2 idiom + small width/wrap fixes)
  and #18 (toolbar fade).
- Task 6 (chrome): #13, #14.
- Task 7 (overlays): #1 (fade strengthening — lives in globals.css table-fade
  utility), #3 (FAB clearance), #21 (modal buttons), + planned modal max-h/dvh pass.

## Post-Task-5 discovery (controller browser verification)

**Finding #23 (root cause of #1): `ScrollFade.tsx` is inert app-wide — pre-existing bug on main (`fb543a7`).**
The component toggles `is-scrollable` on the INNER `overflow-x-auto` div, but the
`.scroll-fade.is-scrollable::after` gradient rule (globals.css ~518-538) requires the
class on the SAME element as `.scroll-fade` (the outer wrapper). Verified live at
834×1194: inner div carries `is-scrollable`, wrapper's `::after` opacity stays 0
while genuinely overflowing. Affects every consumer (HoldingsTable, AllHoldingsTable,
TaxLotTables, FactorHeatmap, TransactionHistory, and Task 5's SecurityChart toolbar).
Explains #1's "zero visual affordance" — the Accounts fade never rendered.
**Secondary**: gradient color is `var(--color-panel)` which resolves LIGHT (#fff)
inside the dark MarketDataPanel module → a corrected fade there needs the panel's
scoped vars to override the fade color. → Routed to Task 7.
Desktop check at 1440×900: PASS — neither toolbar overflows at desktop, no fade
engages, rendering identical (both Charts + Security Detail measured).
