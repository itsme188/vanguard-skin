# iPad Parity Tablet Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Portfolio Desk fully usable on an 11″ iPad (portrait 834px / landscape 1194px, Safari, touch) by giving the md→xl band designed layout rules and every interactive element defined touch behavior.

**Architecture:** No third layout fork. The desktop layout gains band-scoped rules via Tailwind v4 native stacked variants (`md:max-xl:`, `md:max-lg:`, `lg:max-xl:`) and a touch layer via `pointer-coarse:` variants. An audit at iPad viewports (Task 1) builds the inventory that parameterizes the layout tasks.

**Tech Stack:** Next.js 16 / React 19 / Tailwind CSS 4 (native `max-*` and `pointer-coarse` variants — no config changes), playwright browser agents for audit + verification.

**Spec:** `docs/superpowers/specs/2026-07-12-ipad-parity-tablet-tier-design.md`

## Global Constraints

- **Nothing changes at ≥1280px or in Electron.** Band rules only via `md:max-xl:` / `md:max-lg:` / `lg:max-xl:`. Touch rules only via `pointer-coarse:` (inert under a mouse).
- **Phone layout (<768px) untouched.** No changes to `useIsMobile` (stays `max-width: 767px`), `MobileBottomNav`, or any Tailwind breakpoint value.
- **This is CSS/markup work — no logic changes expected.** TDD unit-test cycles are replaced by browser verification at 834×1194 and 1194×834 + full-suite regression runs (`npx vitest run` must be green before EVERY commit; suite is ~3369 tests, ~15s).
- **Work on branch `ipad-tablet-tier` in the main checkout** (no parallel session is active; the dev server on :3000 serves the branch live). Do NOT create a worktree — browser verification needs the existing dev server + real DB.
- **Colored chips use `<Chip>`** (`app/dashboard/components/Chip.tsx`); never inline `bg-{color}/10 text-{color}`.
- **Privacy formatters:** never inline portfolio-derived numbers; this plan must not touch number rendering at all.
- Commit format: `fix(ipad): <what>` / `feat(ipad): <what>`.

---

### Task 1: Phase 0 audit — build the finding inventory at iPad viewports

**Files:**
- Create: `docs/superpowers/plans/2026-07-12-ipad-audit-inventory.md`

**Interfaces:**
- Produces: the inventory doc that Tasks 5–7 consume. Format per finding: `| # | viewport | route | component file | symptom | rule (T1/T2/T3/T4/G1/G2/G3/G4/CHROME/SAFARI) |`

- [ ] **Step 1: Verify the dev server is running on :3000**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/dashboard/today`
Expected: `200`. If connection refused: `cd /Users/Yitzi/code/vanguard-skin && npm run dev` in background, wait for ready, re-check. (If a stale `.next` lock blocks startup: `rm -rf .next` first — known Turbopack gotcha.)

- [ ] **Step 2: Create the branch**

```bash
git checkout -b ipad-tablet-tier
```

- [ ] **Step 3: Dispatch 4 parallel agent-browser audit agents**

All four in ONE message. Each agent: resize with `browser_resize` to its viewport, visit its routes, screenshot each, report findings as structured rows. Agent brief template (fill ROUTES and VIEWPORT):

> Audit Portfolio Desk at VIEWPORT (iPad 11″). For each route in ROUTES: navigate to `http://localhost:3000<route>`, `browser_resize` to VIEWPORT, take a screenshot, then report every instance of: (a) horizontal page scroll / clipped content, (b) grids or cards visibly cramped (text wrapping badly, columns <200px), (c) tables wider than the viewport NOT inside a scrollable container, (d) overlapping or crowded header/nav elements, (e) interactive elements smaller than ~40px that a finger would miss, (f) content hidden with no visible way to reach it without hover. Also open: the chat drawer (header chat button), one modal if the route has one (e.g. Bogeys edit on Today, level add on a security page). Report each finding as: route | what | component hint from DOM (class names/text) | severity. Do NOT fix anything. Screenshot names: `<route-slug>-<viewport>.png`.

Agent splits:
1. Portrait 834×1194 — `/dashboard/today`, `/dashboard/accounts?id=all`, `/dashboard/alerts`, `/dashboard/alerts?view=armed`
2. Portrait 834×1194 — `/dashboard/analysis`, `/dashboard/analysis?view=performance`, `/dashboard/analysis?view=defense`, `/dashboard/research?view=feeds`, `/dashboard/import`
3. Landscape 1194×834 — same routes as agents 1+2 (landscape is one agent: fewer expected findings)
4. Portrait 834×1194 — `/dashboard/charts`, one `/dashboard/security/[id]` page (pick a held equity from the charts list), `/dashboard/levels/performance`, `/dashboard/data-health`

- [ ] **Step 4: Classify findings into the inventory doc**

Write `docs/superpowers/plans/2026-07-12-ipad-audit-inventory.md`: one table, every finding a row, classified to a rule (T1 tap-trap / T2 tap-target / T3 hover-only info / T4 input zoom / G1 grid step / G2 table wrap / G3 fixed width / G4 chart resize / CHROME header-nav / SAFARI). Add the two statically-known findings if the agents didn't catch them: `ChatInterface.tsx:271` delete button (T1), `app/dashboard/levels/performance/page.tsx:71` `min-w-[720px]` table (verify wrapper, G2).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-12-ipad-audit-inventory.md
git commit -m "docs(ipad): phase-0 audit inventory at iPad 11-inch viewports"
```

---

### Task 2: Foundation — T4 input-zoom kill, text-size-adjust, dvh sweep

**Files:**
- Modify: `app/globals.css` (add touch-input block)
- Inspect/Modify: `app/dashboard/layout.tsx`, `app/dashboard/components/ChatInterface.tsx`, `app/dashboard/components/Skeletons.tsx` (`h-screen`/`100vh` → `dvh` where the element is a full-height overlay/viewport container)

**Interfaces:**
- Produces: global CSS rules all later tasks assume exist. No JS/TS API.

- [ ] **Step 1: Add the touch-input block to `app/globals.css`**

Append (near the existing utility layers, after the `pb-safe` utility):

```css
/* ── iPad / touch tier (spec 2026-07-12) ─────────────────────────────
   T4: Safari auto-zooms any focused input under 16px. Force 16px on
   coarse-pointer devices only — desktop/mouse rendering unchanged. */
@media (pointer: coarse) {
  input,
  select,
  textarea {
    font-size: 16px;
  }
}

/* SAFARI: prevent text inflation on orientation change. */
html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
```

- [ ] **Step 2: dvh sweep**

For each of the three files, find `h-screen` / `min-h-screen` / `100vh`. Rule: if the element is a full-viewport-height overlay or the app shell (content can hide behind Safari's collapsed toolbar), change to `h-dvh` / `min-h-dvh` / `100dvh`. If it's a skeleton placeholder sized loosely, leave it. Show each change in the diff; expect 1–3 line changes total.

- [ ] **Step 3: Verify in browser + check desktop unchanged**

Dispatch one agent-browser agent: at 834×1194, open `/dashboard/today`, focus the Earnings Hub "+ Add ticker" input (or any visible input) — screenshot shows NO layout jump from font-size (16px applied). Then resize 1440×900 and screenshot `/dashboard/today` — confirm identical-to-normal desktop rendering.

- [ ] **Step 4: Full suite + commit**

```bash
npx vitest run   # expect ~3369 passing
git add app/globals.css app/dashboard/layout.tsx app/dashboard/components/ChatInterface.tsx app/dashboard/components/Skeletons.tsx
git commit -m "feat(ipad): T4 touch input-zoom kill + text-size-adjust + dvh sweep"
```

---

### Task 3: T1 — ChatInterface conversation-delete tap-trap

**Files:**
- Modify: `app/dashboard/components/ChatInterface.tsx:271`

**Interfaces:** none (leaf UI change).

- [ ] **Step 1: Fix the hover-reveal delete button**

Current (line ~271): the delete button inside each conversation row is
`opacity-0 group-hover:opacity-100 focus:opacity-100` — invisible but tappable on touch, and it's DESTRUCTIVE (deletes a conversation). Change the className to make it always visible on coarse pointers and extend its hit area:

```tsx
className="shrink-0 p-2 mr-1 text-ink-faint hover:text-down opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100 transition-opacity relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
```

(Same `after:` hit-extension idiom as `EarningsRowChips.tsx`. The button stays hover-revealed for mouse users — desktop unchanged.)

- [ ] **Step 2: Confirm delete has a confirmation guard**

Read the `onDelete(conv)` handler chain. If deletion fires with NO confirm step, add a `window.confirm(...)`? NO — check first: if a confirm/undo already exists, do nothing. If it truly deletes instantly, make the coarse-pointer affordance safe instead: first tap sets a `confirmingId` state rendering the button as "Delete?" (text, `text-down`), second tap deletes; any other tap resets. Implement only if needed; report which branch was taken.

- [ ] **Step 3: Verify + regression + commit**

Browser agent at 834×1194: open chat drawer → conversation list → screenshot shows the delete affordance visible on each row (with playwright touch emulation unavailable, verify by DOM: the button has `pointer-coarse:opacity-100`). At 1440×900 confirm it's still hover-hidden.

```bash
npx vitest run
git add app/dashboard/components/ChatInterface.tsx
git commit -m "fix(ipad): chat conversation delete is a destructive hover-reveal tap-trap"
```

---

### Task 4: T2 — tap-target pass over shared primitives + header buttons

**Files:**
- Modify: `app/dashboard/components/SortableHeader.tsx` (header sort buttons + SortPicker)
- Modify: `app/dashboard/components/TabDropdown.tsx` (subview caret)
- Modify: `app/dashboard/layout.tsx` header icon buttons (theme toggle, privacy toggle, chat toggle, notification bell — whichever are `<button>`s with icon-only content; follow imports to the component files)

**Interfaces:** none (className-only changes).

- [ ] **Step 1: Apply the hit-extension idiom to each icon-only button**

For every icon-only button smaller than ~40px in these files, add:

```
relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']
```

Guard: if the button is inside a tight flex row where `-inset-2` overlaps a NEIGHBORING interactive element's extended area, use `-inset-1` there instead. Do not change padding or visual size anywhere.

- [ ] **Step 2: Verify + regression + commit**

Browser agent at 834×1194: `/dashboard/accounts?id=all#holdings` — click a sortable column header (sort applies, URL gains `?holdingsSort=`); open a tab-subview dropdown (Analysis caret) and select a subview. Confirm both work. 1440×900 screenshot: header unchanged.

```bash
npx vitest run
git add -A app/dashboard/components lib
git commit -m "feat(ipad): T2 coarse-pointer hit-area extension on shared primitives"
```

---

### Task 5: G-rules + residual T-rules — apply per the Task 1 inventory

**Files:**
- Modify: exactly the component files listed in `docs/superpowers/plans/2026-07-12-ipad-audit-inventory.md` rows classified G1/G2/G3/G4. Pre-grepped candidates (audit confirms which actually break): `WeekAheadView`, `OptionsStrategies`, `ScenarioModeling`, `OptionsGreeksCard`, `AccountSummaryCards`, `RiskMetrics`, `FixedIncomeCard`, `PerformanceView`, `IncomeYieldSection`, `DataHealthView`, `LevelsPanel`, `TaxReportCard`, `ImportFlow`, `TaxLotSummary`, `DefenseView`, `FactorAnalysis`, `analysis/ClassificationCard`, `levels/performance/page.tsx`.

**Interfaces:**
- Consumes: the inventory doc (Task 1). Each row names file + symptom + rule.

- [ ] **Step 1: Apply the matching pattern to every G-classified inventory row**

Patterns (copy exactly, adjust the column count to the finding):

```
G1 grid step (3+ cols cramped in portrait band):
  BEFORE: className="grid md:grid-cols-3 gap-4"
  AFTER:  className="grid md:grid-cols-3 md:max-lg:grid-cols-2 gap-4"

G1 grid step (2 cols cramped in portrait band — only if the audit row says so):
  BEFORE: className="grid md:grid-cols-2 gap-4"
  AFTER:  className="grid md:grid-cols-2 md:max-lg:grid-cols-1 gap-4"

G2 unwrapped wide table:
  Wrap the <table> in: <div className="overflow-x-auto">…</div>
  (repo convention — match how AccountsView holdings table does it)

G3 fixed width that clips at 834:
  BEFORE: className="w-[560px]"
  AFTER:  className="w-full max-w-[560px]"

G4 chart container without explicit height behavior in band:
  Add md:max-xl:min-h-[<audit-observed-px>] to the container; if a
  LightweightCharts container fails to resize on viewport change, check the
  component already uses a ResizeObserver (SecurityChart.tsx precedent) —
  report if not, don't rewrite chart internals in this task.

T1 (inventory rows beyond ChatInterface, handled in Task 3):
  pointer-coarse:opacity-100 on the hover-revealed element + the after:
  hit-extension idiom (Task 4 pattern); destructive actions get the
  two-tap confirm treatment from Task 3 Step 2.

T2 (inventory rows beyond the shared primitives of Task 4):
  the same after: hit-extension idiom, -inset-2 (or -inset-1 in tight rows).

T3 hover-only information:
  If a title-attribute or CSS-hover tooltip is the ONLY path to the info,
  surface it inline in the band (md:max-xl: visible sub-line) or convert to
  a click-toggle. Prefer the smallest change; EmptySection's hint idiom
  (tooltip + below-text) is the precedent for inline surfacing.
```

One commit per tab-surface group (Today, Analysis, Accounts, Research, Charts, Import) so review can bisect.

- [ ] **Step 2: Verify each surface after its group commit**

Browser agent at 834×1194 AND 1194×834 revisits the routes whose files changed; screenshots show no horizontal scroll, grids readable. 1440×900 spot-check on the two most-edited routes: desktop unchanged.

- [ ] **Step 3: Full suite after the last group**

```bash
npx vitest run
```

Commits (one per group):
```bash
git commit -m "fix(ipad): G-rules — <surface> band layout steps"
```

---

### Task 6: Chrome — header condensation + TabNav fit (only if the inventory flags them)

**Files:**
- Modify: `app/dashboard/layout.tsx` (header cluster), `app/dashboard/components/TabNav.tsx`

**Interfaces:** none.

- [ ] **Step 1: Apply priority-ordered condensation IF flagged**

If the inventory has a CHROME row for header crowding at 834: hide `AppVersion` in the portrait band (`md:max-lg:hidden` on its wrapper); if still crowded, reduce TwsStatus to its dot/icon (wrap its text label in `md:max-lg:hidden`). Never remove: title, search, settings, confidence indicator, chat toggle. If TabNav scrolls at 834: reduce in-band tab padding (`md:max-lg:px-2` on tab links). If the inventory has NO chrome rows, record "not needed" in the inventory doc and skip to Step 2 — do not condense speculatively.

- [ ] **Step 2: Verify + commit (or record no-op)**

Browser agent 834×1194 screenshot of header + tabs; 1440×900 unchanged.

```bash
npx vitest run
git add app/dashboard/layout.tsx app/dashboard/components/TabNav.tsx docs/superpowers/plans/2026-07-12-ipad-audit-inventory.md
git commit -m "fix(ipad): chrome condensation in portrait band"
```

---

### Task 7: Overlays — modals + chat drawer band safety

**Files:**
- Modify: `app/dashboard/today/BogeysEditModal.tsx`, `app/dashboard/today/CallNoteModal.tsx`, `app/dashboard/components/EarningsEmailViewer.tsx`, `app/dashboard/components/ChatDrawer.tsx`, plus any modal the inventory flagged.

**Interfaces:** none.

- [ ] **Step 1: Apply the modal band rule**

For each modal's panel element: ensure `max-h-[85dvh] overflow-y-auto` and a band-safe width (`w-full max-w-[<current>px] mx-4` if it has a fixed width). For `EarningsEmailViewer`: the iframe wrapper gets `max-h-[85dvh]`; iframe `width="100%"`. For `ChatDrawer`: add `max-w-[100vw]` to the 480px drawer panel. Every modal's ✕/close button gets the T2 hit-extension idiom (Task 4 pattern).

- [ ] **Step 2: Verify + regression + commit**

Browser agent at 834×1194: open BogeysEditModal from Today's Earnings Hub (or cockpit blocked chip), screenshot — fully on-screen, scrollable, dismissible. Open chat drawer — usable. 1440×900: unchanged.

```bash
npx vitest run
git add -A app/dashboard
git commit -m "fix(ipad): modal + drawer band sizing and dismiss tap targets"
```

---

### Task 8: Verification — E2E at both viewports + desktop-unchanged proof

**Files:** none created (screenshots to scratchpad; findings appended to inventory doc if any).

- [ ] **Step 1: Dispatch 3 parallel browser-agent E2E flows**

1. Portrait 834×1194 real flows: alerts triage (open `/dashboard/alerts`, dismiss one alert), level add/edit (Security Detail → LevelsPanel → add level → delete it), chat (open drawer, send "what moved today?", get response).
2. Portrait 834×1194: bogeys entry (Today → Earnings Hub → edit modal → enter + save + delete), Research feeds reading (open article, expand, close), Import preview (navigate to Import — verify dropzone shows a click-to-browse affordance; do NOT commit an import).
3. Landscape 1194×834: sweep all 6 tabs + Security Detail, screenshot each, confirm no horizontal scroll and all Task 5–7 fixes hold.

- [ ] **Step 2: Desktop-unchanged proof**

Browser agent at 1440×900: screenshot all 6 tabs; compare visually against pre-branch expectations (no band variant should be active ≥1280 — confirm by grep too: every new variant in the diff matches `md:max-xl|md:max-lg|lg:max-xl|pointer-coarse`):

```bash
git diff main...HEAD -- 'app/**/*.tsx' | grep -E '^\+' | grep -oE '(md:max-xl|md:max-lg|lg:max-xl|pointer-coarse|dvh)[^"]*' | sort -u
git diff main...HEAD -- 'app/**/*.tsx' | grep -E '^\+.*className' | grep -vE 'md:max-|pointer-coarse|dvh|overflow-x-auto|max-w-|w-full|max-h-' || echo "CLEAN: no unscoped class additions"
```

- [ ] **Step 3: Full suite, final**

```bash
npx vitest run          # ~3369+ green
cd workers/cron && npx vitest run   # 336 green (should be untouched)
```

- [ ] **Step 4: Fix-or-file**

Any E2E finding: fix inline if it's a missed inventory row (same rule patterns), commit; if genuinely new scope, append to the inventory doc marked `deferred` and note in the final report.

- [ ] **Step 5: Final commit + report**

```bash
git add -A docs/
git commit -m "docs(ipad): verification results + residual inventory"
```

Report: branch ready for merge; remaining human steps — (1) enroll iPad in Cloudflare One (team `isafier`, same enrollment as the iPhone), (2) open `http://100.96.0.1:3099` on the iPad, (3) live pass in both orientations; findings feed back as new inventory rows.
