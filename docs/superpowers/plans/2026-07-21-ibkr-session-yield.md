# IBKR Polite Session Yield + TWS-First Straddle Road

## Context

TWS desktop keeps getting kicked ("another user logged in elsewhere"). Root cause: IBKR allows ONE brokerage session per username, and every Portfolio Desk Web API touch POSTs `/iserver/auth/ssodh/init` with `compete:"true"` — deliberately evicting the TWS login. Since earnings season ramped (~7/14), the earnings-intel straddle fetch fires this from cockpit polling (~every 30 min with a pending reporter) and preview composes; a kicked TWS then drops the app's socket, arming the TWS-disconnected Web API refresh (2 more session opens per run, every 30 min) — a feedback loop. The Worker's `fallback-earnings` also opens sessions on ticks where every candidate is then marker-skipped.

User decision: no second IBKR username. Fix = **compete:"false" everywhere (TWS wins, automation yields)** + **TWS-first straddle road** so no enrichment is lost while TWS is open. Both parts in this session.

Exploration verified: `fallback-briefing.ts` never touches IBKR (no change there). ATM/expiry selection is already pure + exported (`pickAtmStrike`, `pickPostPrintExpiry`, `computeMid`, `straddleImpliedMovePct` in `lib/earnings/implied-move.ts`). `setSyncError` clears the `isSyncing()` mutex (verified `lib/tws/sync-state.ts:96-106`).

## Step 0 — Probe compete:false (read-only, before any code change)

New `scripts/probe-ibkr-compete.ts`, modeled on `scripts/ibkr-oauth-test.ts` (the only existing code that prints the ssodh/init body). Mint LST → `GET /iserver/auth/status` → `POST ssodh/init {compete:"false", publish:"true"}` (print status + full body) → auth/status again → `GET /iserver/accounts`, `/portfolio/accounts`, `/portfolio/{acct}/positions/0` (does a yielded session serve reads, fail loudly, or serve stale data?). Optional `--compete=true` control flag.

Run twice: **(a) TWS logged in** (expect yield-shaped body AND TWS stays logged in — the core claim) and **(b) TWS closed** (expect authenticated success + working reads). Record findings in the script header (repo precedent: `lib/ibkr/option-chain.ts` header — "adjust only from a fresh probe, never docs").

Everything marked **[probe-keyed]** below is written against the docs-expected shape (`{authenticated:false, competing:true}`) and must be finalized from probe output. If the yield shows only via subsequent read failures (not the init body), detection moves to a post-init `/iserver/auth/status` check.

## Step 1 — Part A (Mac): compete flip + typed yield in `lib/ibkr/web-api.ts`

- Flip `openSession` (lines 25–32) to `{compete:"false", publish:"true"}`.
- Parse the init response (currently discarded). Add exported `class IbkrSessionYieldError extends Error` (message prefixed `"ibkr-session-yield"` — cross-package sentinel, message-matching is the established Worker idiom) and exported **[probe-keyed]** `isSessionYield(status, body)`. Yield → throw; other non-2xx → `console.warn` but keep returning the LST (no new strictness). Add optional `deps: { request?, getLst? }` param (DI pattern from `option-chain.ts`) for tests.

Consumers:
- **`lib/earnings/intel.ts`** (~lines 172–176): wrap the memoized `openSession` in try/catch — on the sentinel, log `[earnings-intel] Web API session yielded to TWS — Web API straddle road off this pass` and leave `lst=null` (`sessionTried` memoization ⇒ one attempt + one log per pass; remaining events skip the road free). Non-sentinel errors rethrow to the existing per-event catch.
- **`lib/ibkr/refresh.ts::refreshIbkrHoldingsFromWebApi`** (~line 203 catch): on `IbkrSessionYieldError`, log + `setSyncError("IBKR Web API refresh skipped — yielded to an active TWS session")` and return null instead of rethrowing (setSyncError releases the sync mutex — required, else deadlock). This kills the feedback loop. Also yield-aware log in the quote-enrichment catch (~line 220).

Tests: NEW `tests/ibkr/web-api.test.ts` (compete:false body assert, yield-shape → throw, authenticated → LST, `isSessionYield` unit cases); NEW `tests/ibkr/refresh-yield.test.ts` (`vi.mock("@/lib/ibkr/web-api")`): yield → returns null + mutex cleared.

## Step 2 — Part A (Worker): `workers/cron/src/ibkr-positions.ts`

In `fetchLiveIbkrPositions` (~line 229): flip to `compete:"false"`, inspect the init response with a local **[probe-keyed]** predicate (small duplicate — Worker is a separate package by design), throw `Error("ibkr-session-yield: …")` on yield. `fetchLiveIbkrPositionsCached` unchanged (sentinel doesn't match its `/\b(401|403)\b/` re-mint regex; rethrows → caller degrades to snapshot). Also flip/annotate `scripts/ibkr-oauth-test.ts` (or leave as manual compete tester with an explicit flag — decide at implementation; do not leave a silent compete:true default).

Tests: `workers/cron/test/ibkr-positions.test.ts` — ADD `fetchLiveIbkrPositions`-level pair via the file's oauth-client mock: "opens the brokerage session with compete:false", "throws the ibkr-session-yield sentinel on the probed yield body".

## Step 3 — Part A2 (Worker): lazy + memoized live-IBKR fetch in `fallback-earnings.ts`

Replace the eager fetch block (lines ~690–704) with a memoized `getLiveIbkr()` closure (`liveIbkrTried` flag; dryRun/no-config → null; try/catch with yield-aware log: sentinel → `console.log("[fallback-earnings] IBKR session yielded to active TWS — using snapshot positions")`, else existing warn). Keep the line-683 coarse early-out and `result.swept` untouched.

- Candidate loop: `await getLiveIbkr()` immediately before `composeAndSend` (~line 750) — after marker check, recap-content gate, and dry-run early-outs.
- `runSlotWrapSend`: change param `liveIbkr` → `getLiveIbkr` getter; resolve once after its own early-returns, right before building member sections (current uses at ~lines 522/537). Memoization keeps "one LST mint per run" across both paths.

Tests (`workers/cron/test/fallback-earnings.test.ts`): NEW "marker-skipped candidates do not trigger the live IBKR fetch" (marker via `env.CRON_KV.put("cloud-sent-earnings-…")`, pattern at ~1311); NEW "a composing candidate fetches live IBKR exactly once". Existing IBKR describe (~430–475) asserts outcomes not ordering — survives unmodified.

## Step 4 — Part B: new `lib/tws/atm-straddle.ts`

```ts
export interface OptionLegQuote { bid: number|null; ask: number|null; last: number|null }
export interface TwsAtmStraddle { expiry: string /*YYYY-MM-DD*/; strike: number; call: OptionLegQuote; put: OptionLegQuote }
export async function fetchTwsAtmStraddle(args: {
  symbol: string; conid: number; eventDate: string; eventTime: "BMO"|"AMC"|null; spot: number;
}): Promise<TwsAtmStraddle | null>   // null = fall through to next road; never throws
```

1. `getIbApi()` gate (null → null).
2. `api.getSecDefOptParams(symbol.toUpperCase(), "", SecType.STK, conid)` with 15s `Promise.race` timeout; merge expirations+strikes across exchange defs, YYYYMMDD→ISO (pattern: `app/api/tws/option-chain/route.ts:81-103`).
3. `pickPostPrintExpiry(...)` then `pickAtmStrike(...)` (reuse pure helpers from `lib/earnings/implied-move.ts`); null → null.
4. Two OPT contracts: `{symbol, secType: SecType.OPT, exchange:"SMART", currency:"USD", lastTradeDateOrContractMonth: expiry.replace(/-/g,""), strike, right:"C"|"P"}` (field set from `lib/tws/contracts.ts::buildContract`).
5. `setMarketDataType(DELAYED_FROZEN)`; parallel `getMarketDataSnapshot(contract, "", false)` per leg, each raced at `SNAPSHOT_TIMEOUT_MS=15_000`, per-leg try/catch → all-null leg; `finally` reset to REALTIME (idiom: `lib/tws/snapshot.ts`).
6. Extract bid/ask/last with local `extractTick` incl. `DELAYED_*` fallbacks (idiom: `lib/tws/streaming.ts:188-190`; its helper isn't exported).
7. Both legs all-null → null (handles the merged-strikes edge: chosen ATM strike may not exist for the chosen expiry → snapshot empty → clean fall-through). One-sided quotes pass through (intel's `computeMid` handles).

Not RateLimiter-gated (market-data snapshots aren't; 2 lines negligible). Document edges in the module header.

Tests: NEW `tests/tws/atm-straddle.test.ts` with `vi.mock("@/lib/tws/client")` (precedent `tests/tws/snapshot.test.ts`): not-connected → null; happy path (assert contract fields incl. YYYYMMDD); DELAYED_* fallback; no eligible expiry → null; both legs timeout → null (fake timers); REALTIME reset on failure.

## Step 5 — Intel wiring: TWS road first (`lib/earnings/intel.ts`)

- `IntelDeps` gains `twsConnected: () => boolean` (default `() => getIbApi() != null`) + `twsStraddle: typeof fetchTwsAtmStraddle`; wire into `defaultDeps`.
- Road order per event (existing `conid != null && spot != null` + stale-spot + 60% corrupt ceiling guards apply to both straddle roads):
  1. **Road 1a — TWS** (if `twsConnected()`): `twsStraddle(...)` → `computeMid` per leg → `straddleImpliedMovePct` → accept iff ≤ ceiling; `implied_method` stays `"straddle"` (identical semantics; road visible in the log line `[earnings-intel] straddle via TWS for SYM (expiry …)`). Own try/catch → warn + fall through.
  2. **Road 1b — Web API** (existing block, now gated on `impliedMethod == null`; yield-aware per Step 1).
  3. **Road 2 — iv_approx** (unchanged).
- Net behavior with TWS open: Road 1a wins → no Web API session opens at all; if 1a fails for one symbol, 1b yields once, logs once, self-disables for the pass — no eviction ever.

Tests (`tests/earnings/intel.test.ts`): extend `mkDeps` with `twsConnected: vi.fn(() => false)` + `twsStraddle: vi.fn(async () => null)` (all existing tests pass unchanged). New: TWS road wins → openSession/resolveChain never called; TWS null → falls to Web API; corrupt TWS straddle → falls through; stale spot skips TWS road too; session-yield rejection → one attempt across two events, both degrade to iv_approx, no throw.

## Step 6 — Verification

- `npx vitest run` (root, 3700+) and `cd workers/cron && npx vitest run` — all green before commit.
- `npx next build` compile check if lib types changed broadly.

## Step 7 — Docs (minimal)

- Root `CLAUDE.md` conventions bullet: IBKR = ONE brokerage session per username; `ssodh/init` must always use `compete:"false"`; yield surfaces as `"ibkr-session-yield"` and callers degrade (refresh skips + clears mutex, intel falls to next road, Worker uses snapshot); earnings-intel straddle is TWS-first (`lib/tws/atm-straddle.ts`).
- One line in `lib/tws/CLAUDE.md` (Web API is a polite co-tenant of the session).
- Probe findings pinned in probe-script + `web-api.ts` header comments.

## Step 8 — Deploy + live verification (user-gated per repo norms)

- Commit + `npx wrangler deploy` (workers/cron) only on explicit go-ahead.
- Restart dev server / Electron app for Mac-side changes.
- Live: (1) rerun probe with TWS open — TWS stays logged in; (2) TWS open + pending reporter → cockpit poll shows "straddle via TWS", no logout; (3) TWS closed → Web API refresh still works; (4) `wrangler tail` a marker-skipped tick — no "live IBKR refresh" log.

## Risks / accepted decisions

1. **[probe-keyed]** predicates finalize only after Step 0; if yield shows via read failures not the init body, detection moves to auth/status read-back.
2. The probe itself may evict TWS once — run when a one-time kick is acceptable.
3. refresh.ts yield UX: header shows an "error" state with the explanatory skip message (chosen default; a neutral "skipped" sync state is a possible later polish).
4. TWS road requires `securities.ib_con_id` (same guard as Web API road today — no regression).
5. Worst-case added latency with data farms down: ~2×15s per event before fall-through — acceptable for a background pass.
6. Trade retained from earlier discussion: Worker live-book read yields to a lingering overnight TWS session → cloud emails use ≤24h snapshot positions (designed degrade).
