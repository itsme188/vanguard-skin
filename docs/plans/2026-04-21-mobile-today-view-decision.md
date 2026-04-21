# Mobile Today View — Architectural Decision (Theme B1)

**Date:** 2026-04-21
**Status:** Decided
**Recommendation:** Ship the **snapshot path (B2)** first. Defer live TWS SSE (B3) until snapshot feel-tests prove insufficient.

---

## Question

Can the Electron main process hold a TWS connection while the mobile web view comes and goes (iPhone via Cloudflare Mesh)? And if so, is live streaming worth the cost over a last-known-snapshot path?

## Findings

### 1. TWS lives in the Next.js server child — not in Electron main

`electron/main.ts` spawns a **child Node.js process** running the standalone Next.js server on port 3099, bound to `0.0.0.0` (LAN + Mesh reachable). TWS state is a `globalThis` singleton inside that server process (`lib/tws/client.ts:10–27`), not in Electron main. Main only triggers `POST /api/tws/connect` with `clientId: 1` on app startup (`main.ts:242`).

**Implication:** The mobile iPhone → Cloudflare Mesh → `100.96.0.1:3099` hits the *same* Next.js server that owns the TWS socket. There is no cross-process bridge to build. Any existing `/api/tws/*` endpoint works over Mesh.

### 2. SSE streaming infra is already multi-client

`/api/tws/stream` (`app/api/tws/stream/route.ts`) uses `registerClient()` to track active SSE clients. The quote cache is shared via `globalThis.__streaming_state.cache`. Streaming auto-starts on first client, auto-stops 30s after last disconnect. **Adding the iPhone as a second client costs nothing** — no new connection to TWS, no new clientId, no new infra.

### 3. `clientId 3` is free, but we don't need it

Assignments per global CLAUDE.md: `0` = TWS itself, `1` = Vanguard Skin, `2` = Stock Contest. `3` is free. But since the mobile view hits the existing server, no second connection is needed.

### 4. Current data freshness in the DB (sampled 2026-04-21)

| Source | Latest date | Rows |
|---|---|---|
| `prices` source='tws' | 2026-04-21 | 1,825 |
| `daily_valuations` data_quality='live' | 2026-04-21 | 9 |
| `daily_valuations` data_quality='estimated' | 2026-04-21 | 34 |
| `daily_valuations` data_quality='recent' | 2026-03-27 | 1 |

Background auto-refresh runs every 30 min while connected (`lib/hooks/useAutoRefresh.ts`). Mid-session, snapshot data is ≤30 min stale. The `data_quality` column already labels freshness per-valuation — the mobile UI can surface "live" vs "est." with no new logic.

### 5. The true gating constraint: Mac awake + TWS running

**Neither path solves the phone-while-Mac-is-asleep case.** When the Mac sleeps, TWS disconnects; live streaming breaks, snapshot just returns older values. Both paths degrade, just differently:

- **Live path when Mac off:** SSE stays open, no updates arrive, UI shows stale cache. Worse UX (user thinks "it's broken").
- **Snapshot path when Mac off:** UI shows last-known values with a visible "as of Xh ago" timestamp via `data_quality`. Honest UX.

This is a subtle but decisive point in favor of snapshot. Live path's upside (sub-second updates) only materializes when the Mac is already awake — which is exactly the case where the user isn't looking at their phone.

### 6. Three surfaces, three data paths

| Surface | Endpoint | TWS needed? |
|---|---|---|
| Pending alerts | `GET /api/alerts?response=pending` | No (DB-backed) |
| Chat | `POST /api/chat` | No (Claude API) |
| IBKR holdings | `GET /api/accounts` or new `/api/portfolio/today` | Only for live prices; DB has last-known |

**Only holdings have a live-vs-snapshot question.** Alerts and chat are DB/API reads — no TWS dependency.

## Decision

**Ship B2 snapshot path first.** Reasons:

1. **Doesn't help the phone-while-away case.** The live path's premium feature (sub-second ticks) only fires when the Mac is on — precisely when the user isn't looking at their phone. Snapshot with honest `data_quality` labels is strictly better UX for the actual use case.
2. **Existing infra suffices.** `data_quality` column, `/api/alerts`, `/api/chat`, and a simple holdings query give us a complete page with no new backend work.
3. **Cellular + battery.** SSE over cellular Mesh is heavy — persistent connection + keep-alives. Snapshot is a single round-trip, pull-to-refresh adds agency.
4. **Ship-and-iterate.** Live streaming can slot in later as progressive enhancement on an already-shipped Today view — no wasted work.

**Defer B3 (live TWS path)** until the snapshot Today view has had ~2 weeks of daily use and we have concrete complaints like "I watch prices during lunch and this feels stuck."

## Next session scope (B2 snapshot path)

**Route:** `/dashboard/today` (or `/m/today` — TBD at implementation time). Mobile-first single-column, desktop also serves it.

**Sections, top to bottom:**
1. **Alerts** — `/api/alerts?response=pending&limit=20`. Empty state: "No pending alerts." (Current DB has 0 — critical to get this right.)
2. **Chat** — reuse `ChatDrawer` full-screen mobile overlay (already exists per CLAUDE.md: "full-screen overlay on mobile"). Button: "Open chat."
3. **IBKR holdings** — positions + last known price + unrealized P&L + `data_quality` chip. Sort by `|unrealized_gain|` desc or alphabetical — decide at build time.

**Scope fences:**
- No charts on this page. Sparse style budget per B2 spec.
- No inline trading actions. Read-only.
- Add "Today" entry to `MobileBottomNav.tsx` — likely replace "Home" since Today *is* the new home on mobile. Keep existing `/dashboard` reachable via hamburger.
- Pull-to-refresh via standard browser behavior; "Refresh" button calls `/api/tws/auto-refresh` with `level=quick`.

**Tests:** mobile breakpoint renders all three sections; `data_quality` chip renders correctly for `live` / `estimated` / `recent` / `computed`.

**Estimate:** 1 full session (~4-6 hours).

## Carried forward (will not block B2)

- **iPhone wake-up alerts** still blocked on Pushover signup (Theme A7, unrelated).
- **B3 live SSE** queued as optional follow-up. Implementation sketch: mobile subscribes to `/api/tws/stream`, merges with cached snapshot, falls back to snapshot on error.
- **Clientless operation** (Mac asleep) is a separate design question — outside Theme B scope.
