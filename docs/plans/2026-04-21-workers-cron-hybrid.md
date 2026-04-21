# Phase 4 — Workers Cron Hybrid Pattern (design doc)

**Status:** design only — not yet approved for implementation.
**Prerequisite:** Phase 1 (AI Gateway, shipped `8c82c1e`), Phase 3 (R2, code ready, awaiting bucket).

## Problem

The Sunday 3pm weekly briefing and 9am daily digest jobs run on macOS `launchd`. If the Mac is asleep, closed, or traveling without a laptop, the launchd job doesn't fire. Silent miss, no retry. Over the course of a year this is ~5-10 missed briefings.

## Principle

**Local-first stays the default.** The Mac is still the primary execution environment when on. Workers Cron is a *fallback*, not a replacement. This preserves the design philosophy (CLAUDE.md line 1) and avoids the OAuth/DB-replication complexity of a full cloud migration.

## Architecture

Two-tier execution:

```
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (cron: 0 20 * * 0 for Sun 3pm ET)         │
│                                                               │
│  1. Attempt primary path:                                    │
│     POST https://mesh-hostname/api/cron/briefing             │
│     timeout 120s                                              │
│  2. If 2xx: log success. Done.                               │
│  3. If timeout / 5xx / network error: fall through to cloud. │
│  4. Cloud fallback:                                           │
│     a. Read R2 state snapshot (calendar_events + articles)   │
│     b. Call Claude via AI Gateway for briefing synthesis     │
│     c. Send email via Gmail (refresh token from Workers KV)  │
│     d. Write "cloud-sent" marker to R2 (for Mac dedup)       │
└──────────────────────────────────────────────────────────────┘
              │                               │
              ▼ primary                       ▼ fallback (Mac off)
     ┌─────────────────┐              ┌──────────────────┐
     │ Local Electron  │              │ Cloudflare Edge  │
     │  :3099 server   │              │  Workers + R2    │
     │                 │              │                  │
     │ Existing launchd│              │ Stale-by-≤24h    │
     │ logic, unchanged│              │ state, stripped- │
     │                 │              │ down briefing    │
     └─────────────────┘              └──────────────────┘
```

## Components

### 1. New local API routes (lightweight wrappers)

- `POST /api/cron/briefing` — calls the existing weekly briefing generation + email send logic. Auth header check against a shared secret (Workers sends `X-Cron-Secret`).
- `POST /api/cron/digest` — same shape for the daily digest.

Both routes re-use existing functions in `lib/calendar/briefing.ts` and `lib/gmail/*`. Zero feature code changes; just a new entry point.

Estimated effort: ~1 hr.

### 2. Nightly state snapshot (Mac → R2)

- New launchd job at 2am daily: runs `scripts/snapshot-state-to-r2.ts`.
- Script reads `calendar_events` (week window), `research_articles` (last 14 days, summary-level only), `settings.last_digest_sent_at`, `settings.last_briefing_sent_at` from SQLite.
- Writes `state/briefing-context-{YYYY-MM-DD}.json` to R2.
- Keeps last 7 snapshots, prunes older.

**Why**: the cloud fallback needs *some* state to produce a useful briefing. A 24h-stale snapshot is vastly better than a placeholder "briefing unavailable" email.

Estimated effort: ~2 hr (script + launchd plist + R2 prune logic).

### 3. Worker project (`workers/cron/`)

```
workers/cron/
├── wrangler.toml         # worker config, KV + R2 bindings, cron triggers
├── src/
│   ├── index.ts          # scheduled() handler, routes to briefing or digest
│   ├── primary.ts        # HTTP call to local webhook
│   ├── fallback-briefing.ts
│   ├── fallback-digest.ts
│   ├── gmail-send.ts     # OAuth token refresh + Gmail send
│   └── state.ts          # read snapshot from R2
└── package.json
```

Bindings in `wrangler.toml`:
- KV namespace `CRON_TOKENS` — Gmail OAuth refresh token, last-send markers
- R2 bucket `vanguard-skin-statements` (reused from Phase 3) — state snapshots
- Secrets: `ANTHROPIC_API_KEY` (for AI Gateway), `CRON_SHARED_SECRET` (for webhook auth), `MESH_HOSTNAME`

Cron triggers:
- `0 20 * * 0` (Sun 3pm ET = 20:00 UTC) — weekly briefing
- `0 13 * * 1-5` (Weekdays 9am ET = 13:00 UTC) — daily digest

Estimated effort: ~4 hr (first Worker project; OAuth flow is the long pole).

### 4. Gmail OAuth migration

One-time interactive flow:
1. User visits a local page that initiates OAuth.
2. Page receives the refresh token.
3. User copies it into Workers KV via `wrangler kv:key put --namespace-id=... refresh-token "..."`.

Access tokens refresh in the Worker on demand using the refresh token + `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (both Worker secrets). Refreshed access tokens cache in KV with 55-min TTL.

**Concern**: the existing `googleapis` SDK doesn't run in Workers (uses Node APIs). We'll write a minimal Google OAuth + Gmail `messages.send` client using `fetch`. ~100 lines, well-documented API.

Estimated effort: ~2 hr.

### 5. Dedup protocol

Primary path succeeds → Mac's existing logic writes `settings.last_briefing_sent_at` as today. Nothing else needed.

Cloud fallback fires → Worker writes `cloud-sent-marker-{YYYY-MM-DD}` key in KV. Mac's next daily snapshot checks for this marker before writing its own `last_briefing_sent_at`, so the next Mac-triggered run doesn't double-send.

The window for duplicates: Worker fallback fires, Mac wakes up before 4pm, launchd still runs the Sunday 3pm job (it's catch-up style). To handle this: the local `POST /api/cron/briefing` route checks KV for today's cloud-sent marker before generating. If marker exists, route returns 200 "already sent by cloud fallback" and exits.

Estimated effort: ~1 hr.

### 6. Smoke-test strategy

1. Deploy Worker. Trigger manually via `wrangler tail` + `curl` against the Worker's `fetch()` endpoint (not cron).
2. Verify primary path: Mac running, POST succeeds, briefing arrives via existing Mac path.
3. Verify fallback: quit Electron app, trigger Worker again, confirm cloud-generated briefing arrives.
4. Verify dedup: re-trigger Worker after Mac send; confirm no duplicate email.
5. Live cron test: wait for one actual Sunday 3pm firing.

## Estimated total effort

- Routes: 1 hr
- Snapshot script + launchd: 2 hr
- Worker project + wrangler: 4 hr
- Gmail OAuth migration: 2 hr
- Dedup protocol + marker logic: 1 hr
- Testing + polish: 2 hr
- **Total: ~12 hr (≈ 1.5 working days)**

## Open questions for user

1. **Preferred trigger for implementation**: immediately (after Phase 2 + 3 verified), or wait until you actually miss a briefing while traveling?
2. **OAuth client source**: reuse existing Google OAuth client (`GMAIL_*` env vars) or create a new one specifically for the Worker? (Existing client is tied to the local OAuth redirect URI `localhost:3099` — would need to add the Worker's URL. New client is cleaner separation.)
3. **Cloud briefing quality degradation**: acceptable for the fallback to say at the top "(briefing generated from cached state as of <date> — Mac was offline)"? Or suppress that note?
4. **Budget ceiling**: Workers free tier covers ~100k invocations/day. Our cron fires ~6/week. KV + R2 usage is tiny. Expected monthly cost: $0. Acceptable?

## What's explicitly NOT in this plan

- **Cloud-only replacement of Mac cron**: violates local-first principle. Off the table.
- **TWS integration in the cloud**: impossible; TWS is local-only.
- **Real-time portfolio data in cloud briefings**: cloud uses snapshot data ≤24h old. Live TWS data stays Mac-only.
- **Migrating every launchd job**: only the two email-sending jobs. Auto-refresh, snapshot-state-to-r2, etc. stay on Mac.

## Recommendation

Don't implement until you feel the pain — either a missed briefing during travel, or a decision to travel with predictable reliability. Until then, this doc captures the design so we can execute in a single focused session when the trigger fires.
