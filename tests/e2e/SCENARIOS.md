# E2E Scenarios — Vanguard Skin

Golden-path browser test specs for the dashboard. Each scenario is written as a self-contained agent-browser prompt; run them via the `vercel:agent-browser` sub-agent against a locally-running dev server.

## Running

**Prerequisites:**
- `npm run dev` on :3000 (or Electron on :3099). These scenarios all use the same DOM regardless of port.
- Real data in `data/vanguard.db` (or a seeded test DB at `data/test-vanguard.db`).

**Serial / individual runs:** spawn one `agent-browser` sub-agent and paste the scenario prompt verbatim.

**Parallel runs:** spawn 4 `agent-browser` sub-agents in a single message to cover 4 scenarios simultaneously.

**Pass criteria:** every scenario lists a numbered checklist. A "pass" means every item is ✅; a "regression" means one or more ❌.

## Rationale

This is the project's native E2E pattern — lightweight, no Playwright dependency, no headless-browser CI pipeline. Agent-browser reads real DOM + runs real navigation + can take screenshots. For pure-logic behavior there are already 1241 vitest tests; these scenarios exist specifically because integration behavior is what breaks when a CSS class, a server-component hook, or a query-param match subtly regresses.

---

## Scenario 1 — Today view

```
Navigate to http://localhost:3000/dashboard/today on desktop viewport (≥1024px).

Checklist:
1. Page loads without crash. Header visible.
2. Pending alerts section renders (either "No pending alerts" empty state OR a list of alert cards).
3. If alerts present: each alert card has symbol, triggered price, optional author, and a "View" link to /dashboard/security/[id].
4. IBKR holdings section renders a table with at least one row (unless the user holds zero IBKR positions).
5. Each IBKR row shows: symbol link, shares, current price, today's $ change, today's % change. (Data-quality chip is page-level on the H1, not per-row — by design.)
6. Holdings are sorted by absolute today-change descending (biggest movers top).
7. Full-width "Open chat" button is visible at the bottom-ish of the page (above the mobile bottom-nav would sit on phones).
8. Clicking the "Open chat" button dispatches a `toggle-mobile-chat` event or opens the ChatDrawer.

Screenshot the full page. Report ✅ / ❌ per item. If the chat button is present only on mobile (md:hidden inversion), that's a regression — flag it.
```

---

## Scenario 2 — Security Detail

```
1. Navigate to http://localhost:3000/dashboard/holdings and click the first symbol link.
2. Confirm the URL changes to /dashboard/security/[id].

Checklist for the Security Detail page:
1. MarketDataPanel hero renders a big amber price ($XX.XX) at the top.
2. Live HH:MM:SS clock is visible in the panel header.
3. LightweightCharts canvas is present and non-empty (canvas.width > 0, canvas.height > 0).
4. Chart has a gold 2px current-price line (solid) at the right edge.
5. LevelsPanel is present below the chart with either an empty state or level cards.
6. If this security has daily bars: KPI row renders 5 cells (Open / Day Range / 52w Range / Volume / ATR(14)).
7. If ATR row cells show `$$` doubled (e.g., `$$87.28`), that's a bare/Money regression — flag it.
8. Below-fold sections render in order: Positions, Tax Lots, Transactions, Notes, Events, Related options.
9. Sortable headers on the lots/transactions tables cycle asc → desc → cleared on click.

Take a full-page screenshot. Report ✅ / ❌ per item.
```

---

## Scenario 3 — Alerts inbox

```
Navigate to http://localhost:3000/dashboard/alerts.

Checklist:
1. Page renders a header with "Alerts" + a filter toggle.
2. If pending alerts exist: two labeled sections render — "Triggered today (N)" and "Older pending (N)".
3. Each alert card shows: symbol (link to Security Detail), triggered price, level-source chip (SMA/EMA/Static), author, time-since-trigger, action buttons (Acted / Ignored / Dismissed).
4. If a level was MA-based, a "(SMA 50)" or "(EMA 9)" chip renders next to the price.
5. Click "Acted" on the first alert: the card moves off pending AND the AlertsBell in the header decrements by 1 (verify the badge number).
6. No page reload required — the CustomEvent "alerts-updated" fires and the header bell re-fetches.
7. Open the browser console and confirm no errors logged during the interaction.

Screenshot before and after the "Acted" click. Report ✅ / ❌ per item.
```

---

## Scenario 4 — Holdings (table sort + filter)

```
Navigate to http://localhost:3000/dashboard/holdings on desktop viewport.

Checklist:
1. Page renders an AllHoldingsTable with at least 1 row.
2. Text filter input is visible above the table.
3. Type "AAPL" (or any symbol known to exist). Table filters to matching rows; chip shows "N of M" count.
4. Clear the filter. All rows restore.
5. Click the "% of Port" column header. Rows reorder (descending first click; another click flips to ascending).
6. Column header shows a sort indicator (arrow or chevron).
7. Click a symbol. URL changes to /dashboard/security/[id] via SymbolLink.
8. Back button returns to the filtered/sorted state (URL preserves sort params like ?holdingsSort=allocation_pct&holdingsDir=desc).

Report ✅ / ❌ per item. Screenshot the filtered + sorted state.
```

---

## Scenario 5 — Research Feeds

```
Navigate to http://localhost:3000/dashboard/research?view=feeds on desktop.

Checklist:
1. Page loads the Feeds sub-view (Research → Feeds is active — gold text + check in the tab-dropdown menu when opened).
2. Feed list renders at least one article OR an empty state "No feeds yet."
3. Each article row shows: source name, subject, received date, optional sentiment chip, optional ticker mentions as chip links.
4. Click an article subject. Expanded view renders either raw_html (.prose-newsletter class) or raw_text (.prose-reader class).
5. Ticker mentions (if any) are word-boundary matched — no false positives like "HOOD" inside "likelihood".
6. Click a ticker chip. URL navigates to /dashboard/security/[id].
7. No console errors during the flow.

Report ✅ / ❌ per item. Screenshot the expanded article view.
```

---

## Scenario 6 — Research Documents

```
Navigate to http://localhost:3000/dashboard/research?view=documents on desktop.

Checklist:
1. Page loads the Documents sub-view.
2. Either the document list renders, OR an empty state shows "No documents — upload a PDF above" (or similar copy).
3. FTS5 search input is visible. Type a query of 3+ characters (e.g., "growth"). Results update without a full page navigation.
4. If documents exist: each doc row shows filename, uploaded_at, extracted tickers if any, and a delete button.
5. If no documents: upload affordance is clickable (file picker opens).
6. No console errors.

Report ✅ / ❌ per item. Screenshot the search-results state.
```

---

## Scenario 7 — Calendar

```
Navigate to http://localhost:3000/dashboard/calendar on desktop.

Checklist:
1. Page loads with a calendar container split into Briefing (left) and Events (right).
2. Week navigation buttons ("Prev Week" / "Next Week" and a week-of label) are visible.
3. Click "Next Week". URL changes (weekOf param) and the events list re-renders.
4. Past events (event_date < today) that are enriched render EnrichmentChips with format "actual X · SPY ±X%".
5. Earnings rows (event_type = earnings) show a symbol link that navigates to Security Detail.
6. If a row has `reaction_snapshot.source === "polygon"`: it renders slightly differently (or has an "Upgrade to TWS" action) — note whichever UI treatment is present.
7. No console errors.

Report ✅ / ❌ per item. Screenshot a week that has a few past events with enrichment chips.
```

---

## Scenario 8 — Chat exchange

```
Navigate to http://localhost:3000/dashboard on desktop.

Checklist:
1. Click the Chat toggle button in the header (or press Cmd+J). ChatDrawer slides out from the right.
2. Drawer shows: scope selector (All / IBKR / Roth / Taxable), message list (empty or with a prior conversation), input textarea at the bottom.
3. Type a short message ("test message"). Send button enables.
4. Click Send. Message appears in the chat list immediately. A streaming response starts (if Anthropic API key is configured) OR an error toast appears (if not).
5. Verify the left sidebar shows the conversation history with the new title (generated from first message).
6. Close the drawer (Cmd+J again or X button). Re-open. Conversation persists — message is still visible.
7. Delete the test conversation via the trash icon in the sidebar. Confirmation popover appears. Confirm. Conversation disappears.
8. No console errors.

Report ✅ / ❌ per item. Note if streaming didn't start (could be a missing API key — flag but don't fail).
```

---

## Known gotchas

- **Electron-only settings modal**: Settings modal renders only under `if (isElectron) return ...`. At :3000 (browser dev server), it's invisible. Don't fail a scenario that asserts Settings presence on browser-dev.
- **Privacy toggle**: If the eye icon in the header is gold, all dollar/percent numbers render as `•••`. Scenarios assume privacy is OFF.
- **Data freshness**: Holdings / Security Detail rely on live prices via TWS or cached `prices` rows. If TWS isn't connected and prices are stale, rows may show "(est.)" — that's expected, not a regression.
- **Mobile viewport (≤768px)**: The desktop-only tab-dropdown is absent; in-page pill toggles appear instead. Scenarios assume desktop width unless otherwise noted.
