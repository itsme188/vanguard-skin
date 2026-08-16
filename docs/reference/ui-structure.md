> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# UI Structure

## Security Detail Page

- Route: `/dashboard/security/[id]` — hub page for a single security
- Shows: chart (SecurityChart), positions (cross-account), tax lots (open + closed), transactions, notes, events, factor exposure, transcripts
- Every symbol in the app links here via `SymbolLink` component
- Watchlist button toggles add/remove with star icon
- `lib/queries/security-detail.ts` — consolidated queries calling existing sub-queries


## Tab Structure

- **6 desktop tabs (post-redesign 2026-04-30):** Today | Accounts | Analysis | Research | Charts | Import. Cuts from the prior 9: Overview → absorbed into Today; Holdings → absorbed into Accounts cross-account section (`/dashboard/accounts?id=all#holdings`) + Cmd+K ticker-jump; Calendar → absorbed into Today week-ahead block. Old routes redirect (`/dashboard/overview`, `/dashboard/holdings`, `/dashboard/calendar`, `/dashboard/levels/review`) — kept as 5-line redirect stubs to cover external bookmarks (iPhone home-screen shortcuts).
- **Chat** is persistent right rail on desktop ≥1280px + full-screen overlay on mobile (ChatDrawer.tsx). Toggle via header button or Cmd+J.
- **Cmd+K** is global ticker-jump — typing a symbol routes to `/dashboard/security/[id]` (replaces the prior global-search role).
- **Alerts** inbox is unified (`/dashboard/alerts`): fired alerts + pending newsletter-extracted levels in one auto-promoted stream. Header bell `<NotificationBell>` shows combined count; old separate `AlertsBell` + `ReviewBell` deleted.
- **NotesAmbient** overlay (`Cmd+;` or floating FAB) is accessible from any tab; saves to localStorage drafts and posts to Notes.
- **Reconciliation** merged into Accounts tab as collapsible section.
- **Notes** renamed to **Research** (redirect from /dashboard/notes)
- **Research** tab has 3 views: Notes (default) | Feeds | Documents (newsletter articles + uploaded PDFs). Trade Reviews relocated to Analysis sub-view in Phase 5.
- **Analysis** tab has 5 sub-views: Performance (TWR + XIRR + period selector) | Classification (default) | Factor Exposure | Trade Reviews | Defense (hedging analysis, added 2026-07-05). Use `?view=performance` / `?view=trade-reviews` / `?view=defense` for the sub-views; `?mode=factors` for the Factor Exposure view (kept the legacy `mode` param for backward compat).
- Old routes (/dashboard/notes, /dashboard/reconciliation, /dashboard/chat) redirect to new locations
- **Tab-subview dropdowns (desktop)**: tabs with `subviews` in `nav-tabs.ts` (currently Research + Analysis) render a caret ▾ next to the label; clicking opens `TabDropdown.tsx` — a menu of subviews with keyboard nav (ArrowDown opens, Arrow keys/Home/End cycle, Enter selects, Escape/outside-click close). Menu uses `position:fixed` + `getBoundingClientRect()` to escape the parent `<nav>`'s `overflow-x-auto` clip (absolute positioning gets silently cut off). Mobile keeps the in-page pill toggle (`ResearchViewToggle`, `AnalysisView` mode toggle — both gated `md:hidden`). `TabDropdown` reads `useSearchParams()` so it's wrapped in `<Suspense>` inside `TabNav.tsx` with a plain-`<Link>` fallback — required to keep static pre-rendering working for dashboard pages without `force-dynamic`.


## Mobile Responsive

- **Bottom nav** (`MobileBottomNav.tsx`): 5 icons — Today, Research, Chat (gold center), Notes, Analysis. `md:hidden electron:hidden`. Notes maps to `/dashboard/research?view=notes` (Notes is a sub-view of Research, promoted to a first-class mobile destination).
- **Desktop tabs** hidden on mobile (`hidden md:flex` on TabNav `<nav>`). Maintenance tabs (Accounts, Charts, Import) only in desktop nav.
- **Chat**: full-screen overlay on mobile (`fixed inset-0`, slide-up via `translate-y`), 480px side drawer on desktop. Uses `useIsMobile` hook + `toggle-mobile-chat` DOM event.
- **Chat right-rail collapse (xl+)** — `ChatDrawer.tsx` exposes a chevron at the rail's top-right that hides it; layout reservation (`xl:pr-[480px]` previously) is now driven by the `--chat-rail-width` CSS variable + the `chat-rail-reserve` class on the dashboard layout div. State persists via `vgs:chatRail` localStorage; an anti-FOUC script in `app/layout.tsx` mirrors it to `<html data-chat-rail="open"|"collapsed">` before React hydrates so first paint matches. Header `ChatToggleButton` now uses `chat-toggle-rail-aware` — visible at xl only when the rail is collapsed (CSS attribute selector in `globals.css`). When components need to respond to the rail state (e.g. `EarningsHub` switching between desktop grid and mobile cards at `<2xl` if rail open), use the `[data-chat-rail="open"]` attribute selector — no JS state needed; cascade flips instantly when ChatDrawer toggles.
- **Header**: simplified on mobile — only Title + Search + Settings. DataConfidenceIndicator, TwsStatus, ChatDrawer toggle, AppVersion hidden via `hidden md:flex`.
- **ChatDrawer rendered at layout root** (not inside header) so mobile full-screen overlay works. Do NOT wrap in `hidden md:flex`.
- **Breakpoint**: `md:` (768px) separates phone from tablet/desktop. Mobile-first defaults.
- **Safe area**: `pb-safe` utility in globals.css, `viewport-fit=cover` meta tag for iPhone notch/home indicator.
- **Remote access (post #35 cutover, 2026-08-14)**: the Next server binds loopback-only (`127.0.0.1:3099`) — no LAN/mesh interface, permanently (spec §5.3 invariant, `docs/superpowers/specs/2026-08-14-packaged-app-trust-boundary-design.md`). The iPhone reaches the dashboard via a named Cloudflare Tunnel to `app.myportfoliodesk.com`, gated by Cloudflare Access in front and an app-level login (DB-backed session + CSRF) behind it — Access approval alone grants nothing; the app still requires its own authenticated session. The Cloudflare Mesh / `100.96.0.1:3099` path described in earlier revisions of this doc is retired.


## Benchmark & Risk

- Benchmark prices stored in `benchmark_prices` table (migration 014), separate from portfolio `prices`
- Benchmark sync requires TWS connection; falls back to `ohlcv_bars` then `prices` table for cached data
- TWS `getHistoricalData` requires `conId` in contract for reliability — symbol-only contracts time out
- `lib/tws/benchmark.ts` auto-resolves conId via `getContractDetails` for unknown benchmark symbols
- Risk metrics computed from `daily_valuations` — no external data needed
- Sharpe ratio uses 4.5% risk-free rate (configurable via `riskFreeRate` option)
- Recharts `formatter` on Tooltip needs untyped params: `(value) => [formatFn(Number(value)), label]`
- Recharts `minTickGap={40}` on XAxis prevents duplicate labels with dense daily data

