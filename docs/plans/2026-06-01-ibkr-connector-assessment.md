# IBKR Claude Connector — Capabilities-vs-Gaps Assessment

**Date:** 2026-06-01
**Status:** Landscape map / decision-support — NO build committed
**Author:** session research, grounded against the live IBKR account via the connector

## TL;DR

The IBKR Claude connector is IBKR's **hosted Web API** exposed through Claude.ai's
OAuth. It runs inside the agent/Claude session — it is **NOT callable from the
project's own runtime** (Next.js / Electron / Cloudflare Worker). That single fact
splits every possible use into two very different buckets:

- **Agent-tool use (certain, zero build):** the assistant uses the connector in a
  session to read the live account and act on the project's data. **This is a
  slam-dunk and can start today.**
- **Product-integration use (high value, auth-gated):** the *app* would integrate
  IBKR's underlying **Web API with its own credentials** — the connector proves the
  data exists and is good, but cannot be reused by the app. Retail headless auth is
  the gating risk (see §5).

**Verdict:** pursue the agent-tool tier now (it closes a carried backlog item and a
known data bug with no new auth); treat the cloud/product tiers as "feasibility-spike
first" because IBKR's retail Web API auth is hostile to headless/cron use.

## 1. What the connector actually is (the critical distinction)

| | This connector | The project's current IBKR path |
|---|---|---|
| Transport | IBKR **Web API**, hosted, via Claude.ai OAuth | TWS socket, `@stoqey/ib` IBApiNext, port 7496, client ID 1 |
| Requires TWS running? | **No** | **Yes** (TWS must be open; stale-socket + rate-limit pain) |
| Callable from app code? | **No** — only from a Claude session | Yes (it IS the app's code) |
| Auth | Claude.ai did the OAuth integration | local socket, no auth |

The app cannot "call the connector." Any *product* use means the app speaks to
IBKR's Web API directly with its own OAuth — a separate integration the connector
merely validates the value of.

## 2. Verified capabilities (probed live against the real account this session)

All read-only; confirmed returning the **personal** account (net liq ≈ $484k, matches
the IBKR statement lineage):

- **`get_account_summary`** — net liq, equity-with-loan, buying power, gross position
  value, cash, available funds, initial/maintenance margin, excess liquidity,
  leverage, day-trades. ✓ live.
- **`get_account_balances`** — cash + market value per currency.
- **`get_account_positions`** — per position: qty, `market_price`, `market_value`,
  **`average_price` (= per-share cost basis)**, `unrealized_pnl`, `asset_class`,
  `contract_id`, OCC-format option descriptions, **shorts** (negative qty), and
  zero-qty closed rows. ✓ live (e.g. SPY 100 sh, avg 473.31, +$28.3k unrealized).
- **`get_account_trades`** — period windows (TODAY … YEAR_TO_DATE, completed
  quarters). **DAYS_90 returned 1,019 trades** with `trade_id`, `symbol`,
  `company_name`, `sec_type`, `side`, `size`, `price`, `order_type`, `tif`,
  `trade_time` (ISO UTC), `exchange`, **`commission`**, `net_amount`, `realized_pnl`,
  `order_id`. Month split: Mar 473 / **Apr 256** / May 248 / Jun 42. ✓
- **`get_price_snapshot`** — live last/bid-ask/change/prior-close/**implied & historical
  vol**/52wk hi-lo/cumulative-perf(1d…5y)/dividend-yield/YTD, per `contract_id`.
  SPY probe returned `is_close:false` with a fresh timestamp → **real-time**, not
  frozen. (Frozen/delayed-frozen explicitly NOT supported.)
- **`get_price_history`** — OHLCV bars 30s→1month, optional corporate actions + outside-RTH.
- **`search_contracts`** — symbol/name → `contract_id`.
- **Order tools** (`create/delete/get_order_instruction`) — **trading; out of scope**,
  do not wire.

## 3. Mapping to documented project gaps

| Project gap (source) | Connector coverage | Confidence |
|---|---|---|
| **IBKR April 2026 transactions gap** (carried TODO, "waiting on statement") | `get_account_trades` returns the 256 April trades **now** | **Certain** |
| **`cost_basis` NULL intra-day** (`getCrossAccountPositions` COALESCE workaround) | `average_price` is the live cost basis per position | **Certain** |
| **TWS must be running** + stale socket | Web API needs no TWS | High (app-side) |
| **TWS price rate-limit (~40 min full fetch)** | Web API snapshot/history not socket-rate-limited | High (app-side) |
| **Cloud fallback: "TWS-dependent sections absent"** (Mac asleep → no live IBKR positions/prices in briefings/evening email) | Web API *could* fill — IF headless auth works | **Risky** (see §5) |
| **Data-confidence / reconciliation** | Live broker source-of-truth to audit DB drift | Certain (agent) / High (app) |

A deeper observation: the connector exposes the **same data the project imports from
IBKR statements** (positions, trades w/ commissions, cost basis, account values). So
the IBKR Web API isn't just a *price* source — it's a candidate **primary IBKR data
layer**, reducing reliance on both TWS and monthly statements.

## 4. Opportunity tiers (ranked by value × feasibility)

**Tier 1 — Agent data-ops (certain, zero/low code, do now)**
- Close the **April transactions gap**: pull trades, transform to the canonical
  import shape (the parsers + `import_batches` flow already exist), preview → commit.
  No waiting on the statement.
- **Cost-basis backfill / audit**: reconcile `average_price` into rows where the app
  holds NULL; flag DB-vs-broker drift (qty, cost, P&L).
- **Reconciliation reports**: live positions/balances vs the app's latest snapshot.
- Cost: assistant-time only. No new auth, no new code paths in the product.

**Tier 2 — TWS-independent refresh fallback on the Mac (high value, auth-gated but viable)**
- A Web API client in the app used **when TWS is down / rate-limited**: positions +
  cost basis + balances + snapshot prices without the socket.
- Feasible *on the Mac* because a Client Portal Gateway / interactive login can live
  there. Would harden the documented TWS pain points.
- Cost: real integration + IBKR Web API OAuth setup. **Spike auth first.**

**Tier 3 — Worker / cloud IBKR data path (highest strategic value, feasibility RISKY)**
- Let the Cloudflare Worker pull live IBKR positions/prices for cloud briefings +
  evening email when the Mac/TWS is asleep — closes the single biggest cloud-fallback
  limitation.
- **Blocker:** IBKR's retail Web API (Client Portal) traditionally needs a Gateway
  process with a **browser login that expires ~daily** — hostile to a headless
  Worker. Third-party OAuth 1.0a (headless-capable) is institutional/approval-gated.
  **May be infeasible for a retail account without a hosted-gateway workaround.**
- Cost: unknown until the auth spike resolves; do not commit before that.

**Out of scope:** order placement / modification (the connector supports it; the
project is read-only analytics by design — keep it that way).

## 5. The gating unknown: app-side auth

Everything in Tier 2/3 depends on how the *app* authenticates to IBKR's Web API
(the connector's own claude.ai OAuth cannot be reused):

- **Client Portal API + Gateway:** runs locally, browser login, session expires
  ~daily → OK-ish on the Mac (Tier 2), bad for the Worker (Tier 3).
- **OAuth 1.0a (third-party):** headless-capable but historically requires an IBKR
  application/approval; uncertain for retail in 2026.
- A **2026 hosted-OAuth** option (if IBKR shipped one alongside this connector) would
  change the calculus — **this is the thing to verify in a feasibility spike.**

A 1–2 hour spike (read IBKR's current Web API auth docs + test a token flow) would
de-risk Tier 2/3 before any build is scoped.

## 6. Recommendation (no commitment)

1. **Now, no build:** use the connector (Tier 1) to close the April gap and backfill
   cost basis — both are open items, both certain.
2. **Next, cheap:** a short **auth feasibility spike** to learn whether headless /
   long-lived IBKR Web API auth is available for this retail account. Its result
   decides whether Tier 2/3 are real.
3. **Only then:** scope Tier 2 (Mac TWS-independent fallback) and/or Tier 3 (cloud
   path) as their own brainstorm → spec → plan.

No code, schema, or auth changes are proposed by this document.
