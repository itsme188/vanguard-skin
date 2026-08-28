# Architectural Decisions

Record of WHY architectural choices were made. Consult before making structural changes.
Add new entries at the bottom.

---

- **PDF parsing via Claude API, not OCR** — Vanguard PDFs are image-heavy. The Anthropic SDK sends PDF pages to Claude for structured extraction. More accurate than tesseract/pdftotext and worth the API cost (~$0.50-0.80 per statement with Opus 4.7).

- **SQLite over Postgres** — Local-first, single-user app. No need for a database server. WAL mode handles concurrent reads during imports.

- **OCC format for option symbols** — Bare tickers like "INTC" collide with the underlying stock in `securities` UNIQUE(symbol) constraint. Always use full OCC format (e.g., `INTC  260320P00045000`). Three-layer fix: (1) `ensureOCCSymbol()` in parser auto-converts, (2) `upsertSecurity()` type conflict guard, (3) `buildOCCSymbol()` utility. Pattern: underlying padded to 6 chars + YYMMDD + C/P + strike*1000 padded to 8 digits. This was a painful bug — do not revert.

- **Bond par adjustment in two places** — Both market value AND cost basis need /100 for bonds. Fixed wrong multiple times. Canonical logic is in `adjustedMarketValueSQL()` in `lib/valuation.ts`.

- **Deterministic source_key for idempotent imports** — Every record gets a hash-based key so re-importing the same file is a no-op. Do not change the hashing logic without understanding the dedup implications.

- **Thematic factor exposure — separate table, query-time inheritance** — `security_factors` is standalone (not bolted onto `securities`) because factors are opinionated macro assessments, not security identity. Options inherit factors at query time via `LEFT JOIN securities u ON u.symbol = s.underlying_symbol` + `COALESCE(sf.col, sf_u.col)`. Constants/labels/colors shared from `lib/factors.ts`. Auto-classify uses Sonnet 4 with training examples.

- **Sampling strategy per API call** — (1) Chat: Opus 4.7 + adaptive thinking (temperature locked at 1.0, `effort: high`); (2) PDF extraction: Opus 4.7 + temperature 0 (determinism for structured JSON); (3) Factor classification: Sonnet 4 + temperature 0.2 (categorization with training examples). When thinking is enabled, the API requires temperature=1.0.

- **TWS singleton on globalThis** — Module-level `let` variables reset on Turbopack HMR reload, orphaning TCP sockets. `lib/tws/client.ts` stores all TWS state on `globalThis.__tws_*` properties.

- **Single dev server rule** — NEVER run two `next dev` processes against the same project directory. Turbopack's persistent cache is single-writer; concurrent writes corrupt SST files. `.claude/launch.json` is pinned to port 3099 (same as launcher) so only one server runs.

- **Transaction type casing** — All parsers output UPPERCASE (BUY, SELL, DIVIDEND, BUY_TO_OPEN, SELL_TO_CLOSE, etc.). Tax lot compute engine uses `LOWER(type) IN (...)` for case-insensitive matching across sources.

- **Streaming for PDF API** — `client.messages.stream()` + `stream.finalMessage()` avoids 10-min timeout on large PDFs.

- **`serverExternalPackages`** — better-sqlite3 excluded from Next.js bundling (native addon).

- **`import.meta.url` in migrate.ts** — Not `__dirname`, for ESM compat with Vitest.

- **Date formatting in SSR** — Never use `toLocaleString()`/`toLocaleDateString()` in Next.js server components (hydration mismatch); use manual formatting.

- **IBKR CSV format change (2026)** — Newer exports prepend account ID line before `Statement,Header,...` row. Parser handles both formats.

- **PDF document input** — Only supported on Sonnet/Opus, NOT Haiku (returns 404). Can't cheaply downgrade PDF parsing.

- **Vanguard PDF holdings retry** — `parseVanguardPdf()` checks if first extraction covers < 80% of `total_value`; if so, makes a second focused `callClaudeForHoldingsOnly()` call ignoring transaction pages.

- **Claude API code fences** — Always strip ` ```json ``` ` wrappers from Claude API responses before JSON.parse.

- **Tax lot compute null safety** — VMFXX money market reinvestments have null `price_per_share`/`quantity`. Compute engine filters with `AND price_per_share IS NOT NULL AND quantity IS NOT NULL`.

- **Agentic chat architecture** — Hybrid static context (~2,500 tokens) + 14 dynamic DB tools. Agentic loop: stream -> detect `stop_reason: "tool_use"` -> execute server-side -> append full `finalMessage.content` (including thinking blocks) -> re-stream. Max 8 iterations. Prompt caching reduces cost across loop iterations.

- **Earnings transcript pipeline** — Layered sources: EDGAR 8-K (free, always-on) -> Motley Fool scraping (free, on-demand) -> API Ninjas (optional paid). Seeking Alpha blocks server-side fetches (Cloudflare 403). API Ninjas earnings endpoint is Premium-only ($39+/mo).

- **Desktop launcher** — `scripts/launch-dashboard.sh` (lifecycle manager) + `scripts/VanguardDashboard.applescript` (stay-open app). Port 3099. AppleScript's `do shell script` has minimal PATH — must `export PATH="/opt/homebrew/bin:$PATH"`. Stay-open applet uses idle polling (not blocking `on run`) to avoid beach ball.

- **IBKR option parsing** — Descriptions like "AAPL 21MAR25 150.0 C" -> OCC symbols "AAPL  250321C00150000". Helper: `parseIBKROptionSymbol()`.

- **Tax lot filtering** — Year picker (pill buttons) + account picker. Uses URL searchParams for server-side filtering. Generic `FilterPills` component in `YearSelector.tsx`.

- **Options support** — `adjustedMarketValueSQL()` handles bonds (/100) AND options (*multiplier) in one function. Queries use `COALESCE(s.multiplier, 1)` since explicit INSERT NULL bypasses schema DEFAULT.

- **Chat markdown rendering** — `react-markdown` + `remark-gfm` in `MarkdownMessage.tsx`. Custom component map styled with Tailwind v4 tokens. Only applied to assistant messages.

- **TWR compute engine** — Chain-linked Modified Dietz method. Uses IBKR-provided `monthly_snapshots.twr` when non-null (stored as percentage, divide by 100). Cash flow day-weighting: `W_i = days_remaining / days_in_month`. Annualization threshold: 30 days minimum.

- **Calendar: FRED dates, not Claude dates** — Macro event dates come from FRED `releases/dates` API (authoritative — sourced from BLS, Census, Fed, ISM). Claude only provides enrichment (descriptions, consensus estimates, impact ratings). This was changed mid-build after Claude hallucinated NFP on a Saturday. Government shutdowns can shift release dates, so static JSON calendars go stale — FRED fetches live. 19 tracked FRED release IDs in `TRACKED_RELEASES` constant.

- **Calendar: WSH via raw IBApi** — IBApiNext has no WSH wrappers. Access via `(ibApiNext as any).api`. WSH JSON format is undocumented — `raw_json` column preserves responses for parser iteration. Dividends/ex-dividends filtered out (user preference — too noisy).

- **Calendar: Sonnet for enrichment, not Opus** — Macro event enrichment uses Sonnet 4.7 (structured JSON extraction, not deep reasoning). Briefing generation also uses Sonnet (analysis is substantive but doesn't need Opus-level reasoning). Saves ~5x cost vs. Opus per calendar sync.

- **FOMC dates: hardcoded, not API** — The Fed publishes the FOMC schedule a year in advance (8 meetings). FRED doesn't have a clean single release_id for FOMC meetings — it publishes multiple releases (statement, minutes, projections) around each meeting. Hardcoded approach is 20 lines, zero API calls, zero failure modes. Update once a year. Source: federalreserve.gov/monetarypolicy/fomccalendars.htm.

- **Vital Knowledge via IMAP, not API** — VK newsletters arrive via email. `imapflow` connects to Gmail IMAP, searches for `updates@vitalknowledge.net`, strips HTML, truncates to 8K chars total. Ported from Stock Contest (identical code). Integrated into briefing prompt — if VK context exists, Claude gets market commentary alongside event data. Graceful degradation: returns "" on any failure.

- **Email briefing: inline styles, not CSS** — Email clients (Gmail, Outlook, Apple Mail) strip `<style>` blocks and ignore CSS classes. All styling in `briefing-html.ts` uses inline `style=""` attributes. Midnight Portfolio theme colors translate directly to hex values. Simple markdown-to-HTML converter handles the subset Claude produces (##, **, -, paragraphs) without adding a dependency like `marked`.

- **Overview chart: daily overrides monthly on merge** — `CombinedPortfolioChart` merges monthly snapshots with daily valuations by date key. Daily data overwrites monthly on the same date (more granular/recent). Monthly fills gaps for older dates. Simpler than `EquityCurveChart`'s shape-preserving normalization because the stacked-area chart uses absolute values per account, not proportional adjustment.

- **Source URL extraction: raw_text > raw_html for Substack** — `extractSourceUrl()` checks `raw_html` first (view-in-browser regex), then falls back to `raw_text` for the Substack "View this post on the web at {URL}" pattern. This was the root cause of most missing URLs — Substack emails don't always include "View in browser" in their HTML, but always include the clean URL in the plaintext body. Ghost newsletters use `/r/{hash}` redirect links (3rd occurrence = article title). Bloomberg uses "Read in browser" (not "View in browser"). Source profiles documented in memory for future reference.

- **Manual digest email with mode parameter** — `POST /api/digest/email` accepts `mode: "today" | "since_last" | "since_date"` + `sinceDate` for flexible date ranges. Default (no mode) = last 24h for backward compatibility with launchd cron. `last_digest_sent_at` and `last_briefing_sent_at` tracked in `settings` table for "since last" mode. UI panel in Feeds tab supports both daily digest and weekly briefing to arbitrary recipients.

- **Launchd retry script** — `scripts/send-daily-digest.sh` replaces raw curl in the daily digest launchd plist. Retries 3 times with 2-minute delays in case the Electron app is still starting. `DigestCatchup.tsx` shows a banner on weekday app startup if today's digest wasn't sent.

- **Holistic redesign 2026-04-29 → 2026-04-30 (Phases 0-8)** — Two-axis shift: (1) IA collapse 9 desktop tabs → 6 (cut Overview/Holdings/Calendar from top nav; absorbed into Today + Accounts; old routes kept as 5-line redirect stubs to cover external bookmarks like the iPhone home-screen shortcut). (2) Visual rebrand: Sage & Linen light explored then pivoted to Amber (Bloomberg-light) to unify with the existing Bloomberg-pro dark mode. Strip headers replace Hero cards. Card chrome is shadow-only (`border: 0` in light mode; dark keeps hairlines). IBM Plex Sans + Mono replace Geist; Instrument Serif removed entirely in Phase 8. Header bell unified to `<NotificationBell>` (fired alerts + pending newsletter levels). Cmd+K repurposed from global search → ticker-jump. Notes promoted to first-class mobile slot + ambient overlay (`Cmd+;`) accessible from any tab. Persistent chat right-rail at ≥1280px. Phase 1-3.5 supervised; Phase 4-8 autonomous with one commit per phase as the rollback unit. Plan: `~/.claude/plans/redesign-rollout-handoff.md`. Topic file: `memory/project_holistic_redesign.md`. Why now: 9-tab IA was bumping into "everything is a maintenance tab" — Today is the daily landing and absorbing Overview blocks made the user's mental model match the app's chrome.

- **Claude × Codex autonomous pairing session (2026-08-28)** — decisions made jointly on the QA-fixer review round:
  - Earnings slot floors keyed on the resolved BMO/AMC slot, never the stored `release_time` — release_time is frequently the call time for AMC names, and slot is the only thing knowable ahead of the wire.
  - Bogey `COALESCE`-preserve semantics scoped to newsletter re-scans only — manual entry and PDF upload keep full overwrite so a user correction can still clear a field.
  - Beta publish gate at r² ≥ 0.10 / ≥30 pairs DELETES the cached row rather than storing a marker — `security_betas.beta` is NOT NULL, so every consumer already treats a missing row as "no beta".
  - Narrative cache gets a read-only drift check via an input fingerprint, never an auto-regenerate on GET — regeneration costs a paid model call and must stay an explicit user action.
  - Cash-deploy equity-sleeve gap basis excludes non-equity buckets against an equity-only benchmark, rather than showing an uncloseable gap the user can never fill.
  - Recap SSE streaming deferred in full rather than patched with a client-only timeout — a partial fix would only mask the same failure mode elsewhere.
  - Deploy (Electron rebuild + push) stays a gated decision made after packaged-app E2E, not an automatic step on green tests.
