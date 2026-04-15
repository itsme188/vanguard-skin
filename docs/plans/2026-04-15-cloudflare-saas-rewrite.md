# Vanguard Skin v3 — Multi-User SaaS Rewrite Scoping Document

> Created: 2026-04-15
> Context: Cloudflare migration session. v2 is feature-complete (778 tests, production Electron DMG).
> Purpose: Scope the work required to offer Vanguard Skin as a multi-user SaaS product hosted on Cloudflare infrastructure.

---

## Executive Summary

Vanguard Skin v2 is a local-first Electron app. Every feature assumes a single user, a local SQLite database, and a direct TCP connection to IBKR TWS on the same machine. A SaaS rewrite touches every layer of the stack. This document scopes each layer, estimates effort, identifies blockers, and recommends a phased approach.

**Headline estimate:** 6-9 months of focused development for a production-ready multi-user SaaS, assuming one senior full-stack developer. The work is dominated by the data layer migration (async + multi-tenant) and the TWS bridge architecture — everything else is incremental.

---

## 1. Data Layer Migration

### Current State
- **Database:** SQLite via `better-sqlite3` (synchronous, native C++ addon)
- **Pattern:** Every function in `lib/queries/` (26 files) and `lib/mutations/` (10 files) takes a `db: Database.Database` parameter
- **WAL mode**, foreign keys ON, single-writer
- **27 migrations** in `lib/db/migrations/`
- All queries are synchronous (`db.prepare().get()`, `.all()`, `.run()`)

### Target Options

| Option | Product | Sync/Async | SQL Dialect | Migration Effort |
|--------|---------|------------|-------------|-----------------|
| **Cloudflare D1** | Cloudflare-native | Async (HTTP-based) | SQLite-compatible | Medium — same SQL, but every call becomes `await` |
| **Neon Postgres** | Serverless Postgres | Async | PostgreSQL | High — SQL dialect changes (no `COALESCE` behavior differences, `INTEGER PRIMARY KEY` vs `SERIAL`, `LOWER()` differences, `GROUP_CONCAT` → `STRING_AGG`, date functions) |
| **Turso (libSQL)** | SQLite-compatible, distributed | Async | SQLite | Medium — closest to current, but not Cloudflare-native |

**Recommendation:** Cloudflare D1.

**Why:** D1 uses SQLite's query language, so the 27 migration files and all SQL strings in the codebase transfer with minimal changes. The migration effort is primarily mechanical (`db.prepare().get()` → `await db.prepare().first()`) rather than semantic (rewriting SQL logic). D1 also integrates natively with Workers/Pages, supports up to 10GB per database, and has automatic read replication.

### Migration Scope

**Every file in `lib/queries/` and `lib/mutations/` must become async.** This is the single largest refactor in the project.

| Directory | Files | Estimated Changes |
|-----------|-------|-------------------|
| `lib/queries/` | 26 | Every exported function: add `async`, change `db.prepare().get()` → `await stmt.first()`, `.all()` → `await stmt.all()` |
| `lib/mutations/` | 10 | Same async conversion + transaction handling changes (D1 uses `db.batch()` instead of `db.transaction()`) |
| `lib/compute/` | ~8 | Tax lots, valuations, TWR, XIRR, risk, factors, scenarios — all call query functions, must become async |
| `lib/import/` | ~6 | Parsers are fine (pure), but commit pipeline calls mutations |
| `app/api/` | ~25 | Every API route that calls a query/mutation |
| `tests/` | 778 tests | Every test using in-memory SQLite must switch to D1's test helper or a mock |

**Estimated effort:** 3-4 weeks for the mechanical async conversion. 1-2 weeks for test migration. 1 week for debugging edge cases (transaction semantics, batch operations, error handling).

### D1-Specific Gotchas

- **No `db.transaction()` equivalent.** D1 uses `db.batch([stmt1, stmt2, ...])` which executes statements atomically but doesn't support rollback on application-level errors. Complex transactions (e.g., import pipeline's detect-parse-commit) need redesign.
- **No `ATTACH DATABASE`.** If you ever need cross-database queries, D1 can't do it.
- **10GB limit per database.** Sufficient for years of portfolio data for hundreds of users. Not a concern.
- **Read replicas are automatic.** D1 replicates reads to the nearest PoP. Writes go to the primary. This is free performance for read-heavy dashboards.
- **Row-level security is application-enforced.** D1 has no built-in RLS. Every query must include `WHERE user_id = ?`. See Section 3.

---

## 2. TWS Dependency — The Hard Problem

### Current State
- Vanguard Skin connects to IBKR TWS on `localhost:7496` via `@stoqey/ib`
- TWS must be running on the same machine as the app
- Features dependent on TWS:
  - **Portfolio sync** (positions, account values, live prices)
  - **Historical prices** (OHLCV bars for charts)
  - **Streaming quotes** (SSE-based live data)
  - **Security enrichment** (contract details)
  - **Calendar events** (WSH company events)
  - **Option chains** (strike/expiry data)
  - **Benchmark prices** (SPY/QQQ historical data)
  - **Auto-refresh pipeline** (5-step background sync)

### The Fundamental Constraint
TWS is a desktop application that must run on the user's machine. A cloud-hosted SaaS cannot connect to a user's local TWS instance directly. This is the single hardest architectural problem in the rewrite.

### Options

#### Option A: Local Sync Agent (Recommended)
Ship a lightweight background agent (Electron tray app or standalone binary) that:
1. Connects to the user's local TWS
2. Syncs positions, prices, and events to the cloud database (D1) via authenticated API calls
3. Runs on a schedule (e.g., every 30 minutes, matching current auto-refresh)

**Pros:** Users keep their existing TWS setup. Data flows from TWS → agent → cloud. The SaaS dashboard reads from D1, never from TWS directly.

**Cons:** Users must install and run a second app. The agent needs its own auth token management. Real-time streaming quotes become impractical (agent would need a persistent WebSocket to the cloud).

**The existing Electron app IS the agent.** v2's Electron app already syncs TWS data to SQLite. The refactor is: change the sync target from local SQLite to cloud D1 via API. The Electron app becomes both a local dashboard AND a TWS sync bridge.

#### Option B: Broker Aggregator (Plaid Investments, Yodlee)
Use a third-party service that connects to IBKR on the user's behalf.

**Pros:** No local agent needed. Works from any browser.

**Cons:** Plaid Investments doesn't support IBKR's full API surface (no live quotes, no option chains, no WSH events). You'd lose 60% of the app's features. Also adds a monthly cost per connected account.

**Verdict:** Option B is a non-starter for power users. Option A preserves the full feature set.

#### Option C: IBKR Client Portal API (cloud-to-cloud)
IBKR offers a REST-based Client Portal API that doesn't require TWS.

**Pros:** No local agent for basic data (positions, account values, historical prices).

**Cons:** Client Portal API is more limited than TWS API (no WSH events, no streaming, restricted rate limits). Requires IBKR's gateway running somewhere (can be cloud-hosted but needs session management). Authentication is complex (IBKR's OAuth is non-standard).

**Verdict:** Worth investigating as a supplement to Option A. Could handle basic position sync without TWS for users who don't need real-time features.

#### Recommendation
**Option A (Local Sync Agent) as the primary path, with Option C as a future cloud-only fallback.**

The Electron app's role evolves:
- **v2 (current):** Standalone local app with embedded server
- **v3 (SaaS):** Local TWS bridge + optional local dashboard. Users can use the cloud dashboard from any device and the Electron agent syncs their TWS data.

---

## 3. Per-User Data Isolation (Multi-Tenancy)

### Current State
- Zero user concept. No `user_id` column anywhere.
- All data is implicitly owned by the single user.
- 27 migrations, ~50 tables, all single-tenant.

### Required Changes

#### Schema Migration
Add `user_id TEXT NOT NULL` to every user-owned table:
- `accounts`, `securities`, `holdings`, `transactions`, `tax_lots`
- `monthly_snapshots`, `daily_valuations`, `prices`, `benchmark_prices`
- `import_batches`, `notes`, `calendar_events`, `calendar_briefings`
- `trade_reviews`, `watchlist`, `research_articles`, `research_sources`
- `ohlcv_bars`, `chat_conversations`, `chat_messages`

Tables that are reference/system data and might be shared:
- `schema_migrations` (system)
- `security_factors` (could be shared — factor classifications are universal)

#### Query Changes
Every query in `lib/queries/` (26 files) must add `AND user_id = ?` to every `WHERE` clause. Every mutation in `lib/mutations/` (10 files) must include `user_id` in every `INSERT`.

This is the refactor that "will humble any estimate." It's not just adding a column — it's auditing every SQL statement for correctness, ensuring joins don't leak data across tenants, and writing tenant-isolation tests for every query.

**Estimated effort:** 2-3 weeks for the migration + query changes. 2 weeks for tenant-isolation tests. 1 week for edge cases (cross-account queries that currently span "all accounts" need to span "all accounts for this user").

#### Testing Strategy
- Every test gets a `testUserId` fixture
- New test suite: `tests/isolation/` — for each query, verify that user A's data is invisible to user B
- Fuzzing: insert data for user A and user B with identical account names/symbols, verify no cross-contamination

---

## 4. Authentication

### Current State
- No authentication. Tailscale/Cloudflare Mesh is the access control layer.

### Options

| Option | Complexity | Features | Cost |
|--------|-----------|----------|------|
| **Cloudflare Access** | Low | SSO (Google, GitHub, SAML), JWT verification, no user management UI needed | Free (50 users) |
| **Clerk** | Medium | Full auth UI (sign-in, sign-up, profile, org management), React components | $25/mo after 10K MAU |
| **Auth.js (NextAuth)** | Medium-High | Self-hosted, customizable, many providers | Free, but you build everything |
| **Custom (Cloudflare Access JWT)** | Low | Read `Cf-Access-Jwt-Assertion` header, extract email, look up user | Free |

**Recommendation for SaaS:** Clerk for the user-facing product. It handles sign-up, sign-in, email verification, password reset, OAuth providers, and organization management out of the box. The React components drop into Next.js cleanly.

**Recommendation for MVP/beta:** Cloudflare Access. You already have it configured (Google SSO for isafier team). Add an Access Application in front of the SaaS domain. Read the JWT to identify users. No sign-up flow needed — you manually add beta users to your Access policy.

### User Model
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- Clerk user ID or Cloudflare Access email
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  plan TEXT DEFAULT 'free',      -- free, pro, enterprise
  created_at TEXT DEFAULT (datetime('now')),
  settings TEXT                  -- JSON blob for user preferences
);
```

---

## 5. Gmail OAuth — Per-User

### Current State
- Single shared OAuth token in `.env.local` (`GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`)
- Used for: research feed ingestion (12 newsletter sources), calendar briefing emails, daily digest emails

### SaaS Changes
- Each user needs their own Gmail OAuth consent
- UI: "Connect Gmail" button in Settings → OAuth 2.0 flow → store refresh token per user
- Token storage: encrypted in D1 (or Cloudflare Workers KV for secrets)
- Background processing: scheduled Worker (cron) iterates users, refreshes tokens, fetches newsletters
- **Privacy concern:** Users are granting read access to their Gmail. Need clear privacy policy, minimal scopes (`gmail.readonly` for feed ingestion, `gmail.send` for email sending), and easy revocation.

**Estimated effort:** 2 weeks (OAuth flow UI, token management, per-user cron processing).

---

## 6. Claude API Cost Model

### Current State
- Single `ANTHROPIC_API_KEY` in `.env.local`
- Used by: chat (Opus 4.6, streaming), PDF parsing (Sonnet, 3 calls per import), trade reviews (Sonnet Q&A + Opus review), calendar briefings (Sonnet), research feed processing (Sonnet)
- Estimated cost per user per month: $5-50 depending on usage (chat-heavy users cost more)

### Options

| Model | Revenue | Complexity | User Experience |
|-------|---------|------------|-----------------|
| **BYOK (Bring Your Own Key)** | None — user pays Anthropic directly | Low — just a settings field | Friction: user must create Anthropic account, generate key, paste it |
| **Subscription + metered** | $15-30/mo + overage | Medium — need usage tracking, billing | Clean: user just signs up and uses it |
| **Freemium + limits** | Upsell to paid | Medium — need usage caps, upgrade UI | Good onramp: free users get N chat messages/month |
| **Cloudflare AI Gateway** | Pass-through with markup | Low-Medium — route through gateway for telemetry | Transparent: user doesn't see the proxy |

**Recommendation:** Start with BYOK for beta (zero revenue risk, zero billing complexity). Migrate to subscription + metered for GA launch. Use Cloudflare AI Gateway for telemetry regardless of billing model.

---

## 7. Hosting Topology

### Target Architecture

```
                    ┌─────────────────────┐
                    │   Cloudflare Pages   │
                    │   (Next.js frontend) │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Cloudflare Workers  │
                    │   (API routes)       │
                    │   + AI Gateway       │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐  ┌─────▼─────┐  ┌──────▼──────┐
    │  Cloudflare D1  │  │    R2     │  │  Workers KV  │
    │  (SQLite data)  │  │  (files)  │  │  (sessions)  │
    └────────────────┘  └───────────┘  └─────────────┘
              │
    ┌─────────▼──────────┐
    │  Electron Agent     │
    │  (user's machine)   │
    │  TWS ← → Cloud API │
    └────────────────────┘
```

### Component Mapping

| Current (v2) | SaaS (v3) | Notes |
|-------------|-----------|-------|
| Next.js dev server (localhost) | Cloudflare Pages | Static + SSR at edge |
| `app/api/*` route handlers | Cloudflare Workers (via Pages Functions) | Must not use `better-sqlite3` or `fs` |
| `better-sqlite3` | Cloudflare D1 | Async, HTTP-based |
| Local filesystem (PDF uploads) | Cloudflare R2 | S3-compatible object storage |
| `.env.local` secrets | Workers Secrets / KV | Per-environment, encrypted |
| `node-cron` / launchd plists | Workers Cron Triggers | Scheduled tasks (digest, briefing) |
| Electron app | Electron Agent (TWS bridge) | Reduced role: sync only |

### Workers Limitations to Watch
- **No native modules.** `better-sqlite3` cannot run in Workers. This is why D1 (HTTP-based) is mandatory.
- **CPU time limit:** 30s on paid plan (50ms on free). Complex computations (XIRR Newton-Raphson, tax lot matching) must be optimized or use Workers Unbound.
- **Memory limit:** 128MB. Large PDF processing might need to stream chunks.
- **No `fs` module.** File imports must go through R2.

---

## 8. Electron App's Fate

The Electron app doesn't die — it evolves.

| Capability | v2 (Current) | v3 (SaaS) |
|-----------|-------------|-----------|
| Local dashboard | Primary UI | Optional — users can use cloud dashboard instead |
| TWS connection | Direct, always-on | Same — TWS still runs locally |
| Data storage | Local SQLite | Sync to cloud D1 via API |
| Offline access | Full (local DB) | Read-only cache of last-synced data |
| Settings | Local `.env.local` | Synced to cloud user profile |
| Auto-update | GitHub Releases | Same (or R2 if GitHub limits hit) |

**The Electron app becomes a "pro" feature** — power users who want TWS integration, offline access, and local-first performance keep using it. Cloud-only users (no TWS, import CSVs/PDFs via browser) use the web dashboard exclusively.

---

## 9. Feature Parity Matrix

Not every v2 feature needs to be in v3 at launch. Prioritize by user value and implementation difficulty.

### Launch (MVP)
- [ ] User accounts + authentication (Cloudflare Access or Clerk)
- [ ] CSV/PDF import via browser (upload to R2, process in Worker)
- [ ] Portfolio dashboard (Overview, Accounts, Holdings)
- [ ] Daily valuations + equity curves
- [ ] Tax lot tracking (FIFO)
- [ ] Performance metrics (TWR, XIRR)
- [ ] Chat (Claude, BYOK)
- [ ] Notes

### Post-Launch (Phase 2)
- [ ] TWS sync agent (Electron bridge)
- [ ] Streaming quotes (WebSocket from agent to cloud)
- [ ] Calendar integration (macro events via FRED, company events via agent)
- [ ] Benchmark comparison
- [ ] Analysis tab (factors, risk, scenarios)
- [ ] Trade reviews

### Future (Phase 3)
- [ ] Gmail research feeds (per-user OAuth)
- [ ] Automated email briefings
- [ ] Options analytics (Greeks, strategies)
- [ ] Tax report export
- [ ] Mobile-optimized UI (beyond current responsive)
- [ ] Multi-user collaboration (shared portfolios, advisor mode)

---

## 10. Domain and Infrastructure

### Already Set Up (2026-04-15)
- **Domain:** `safiercap.com` (Cloudflare Registrar, auto-renew, Free plan)
- **Cloudflare team:** `isafier` (Zero Trust, Google SSO configured)
- **Mesh:** Working (Mac + iPhone enrolled, `100.96.0.1`)

### Needed for SaaS
- **Pages project:** Deploy Next.js to `app.safiercap.com` (or `dashboard.safiercap.com`)
- **D1 database:** Create via Wrangler CLI (`wrangler d1 create vanguard-skin`)
- **R2 bucket:** For file uploads (`wrangler r2 bucket create vanguard-uploads`)
- **KV namespace:** For session storage, rate limiting
- **Workers secrets:** Claude API key, Gmail OAuth client secret
- **Landing page:** `safiercap.com` — marketing site (can be static Pages)

---

## 11. Open Questions and Risks

### Blockers
1. **D1 transaction semantics.** The import pipeline uses multi-step transactions with rollback. D1's `batch()` is all-or-nothing but doesn't support conditional rollback. Need to redesign the import commit flow.
2. **Workers CPU limits.** XIRR's Newton-Raphson solver, tax lot FIFO matching, and Claude API calls can exceed 30s on complex portfolios. May need Workers Unbound ($0.02/million requests + CPU time).
3. **PDF processing in Workers.** Current PDF parsing sends the full PDF to Claude API (up to 28 pages). The PDF binary needs to go to R2 first, then a Worker reads it and calls Claude. Memory pressure on large PDFs.

### Risks
4. **Per-user isolation audit.** Missing a single `WHERE user_id = ?` clause leaks financial data across users. This is a security-critical refactor that needs automated testing and manual audit.
5. **Google OAuth review.** The current Google Cloud OAuth app is "Internal" (wolfsonfamily.com only). A public SaaS needs "External" + Google's verification review (privacy policy, ToS, security questionnaire). Can take 2-6 weeks.
6. **IBKR compliance.** Redistributing IBKR market data to multiple users may require a market data vendor agreement. The current setup is fine (single user, personal use). A multi-user SaaS displaying IBKR prices to other users is a different legal category.
7. **Anthropic API costs.** If the platform pays for Claude (not BYOK), chat-heavy users could generate significant costs. Need usage caps and monitoring from day 1.

### Open Decisions
8. **Pricing model.** Free tier? Feature-gated? Usage-based? Needs market research.
9. **Target market.** Solo investors? RIAs? Family offices? Each has different compliance requirements.
10. **Brand.** Is "Vanguard Skin" the SaaS brand? Vanguard (the company) would likely object. "SafierCap" (from the domain) is a cleaner brand for a public product.

---

## 12. Recommended Build Order

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| **0. Foundation** | 2 weeks | D1 database setup, async query wrapper, first 5 queries migrated as proof-of-concept |
| **1. Data Layer** | 6 weeks | All 36 query/mutation files async, all 27 migrations ported to D1, test suite green |
| **2. Multi-Tenant** | 4 weeks | `user_id` on all tables, tenant-isolation tests, auth integration (Cloudflare Access MVP) |
| **3. Cloud Deploy** | 3 weeks | Pages + Workers deployment, R2 file upload, Workers Cron for scheduled tasks |
| **4. Feature Parity** | 6 weeks | MVP feature set (dashboard, import, chat, metrics, notes) working end-to-end |
| **5. TWS Bridge** | 4 weeks | Electron agent refactor, cloud sync API, position/price data flowing |
| **6. Polish + Launch** | 3 weeks | Landing page, onboarding, billing, monitoring, beta invites |

**Total: ~28 weeks (7 months)**

---

## 13. What Stays the Same

Despite the scope, significant parts of the codebase transfer directly:

- **All React components** — UI layer is framework-agnostic (client components don't care about the data source)
- **All CSS/Tailwind** — "Midnight Portfolio" theme, responsive layout, mobile nav
- **Chart integrations** — Recharts, LightweightCharts v5
- **Import parsers** — CSV/PDF parsing logic is pure functions
- **Compute engines** — Tax lots, TWR, XIRR, risk metrics (just need async wrappers)
- **Chat system prompt and tools** — Tool definitions transfer, execution becomes async
- **Type definitions** — `lib/types.ts` is data-shape, not storage-shape

Estimated code reuse: **~70% of the UI layer, ~50% of the business logic, ~20% of the data layer** (SQL strings transfer, but the calling convention changes completely).
