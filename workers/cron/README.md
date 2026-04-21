# vanguard-skin-cron (Phase 4 Worker)

Cloudflare Worker that acts as a reliable cron trigger for the Mac's weekly
briefing and daily digest emails. Primary path calls the Mac over Cloudflare
Mesh; cloud fallback (Session C) generates + sends from the edge when the Mac
is unreachable.

**Status: Session B (primary-only)** — cron + dedup + Mac-webhook call are
wired. Fallback generation is a stub; non-success outcomes are logged only.

## One-time setup

Run these in order. Skip Gmail steps until you start Session C — they're only
needed for the cloud fallback.

### 1. Install deps

From this directory:

```bash
npm install
```

### 2. Authenticate wrangler with your Cloudflare account

```bash
npx wrangler login
```

This opens a browser to the Cloudflare dashboard. Grant permissions, then
verify:

```bash
npx wrangler whoami
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create CRON_KV
```

Copy the returned `id` (looks like `abc123def456...`) and paste it into
`wrangler.toml` replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 4. Set Worker secrets

Session B requires these two:

```bash
npx wrangler secret put CRON_SHARED_SECRET
# Paste the same value that's in your Mac .env.local

npx wrangler secret put MESH_HOSTNAME
# e.g., http://100.96.0.1:3099 (Cloudflare Mesh IP) — include scheme, no trailing slash
```

Session C also needs these (can defer until then):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_GATEWAY_ID
npx wrangler secret put BRIEFING_EMAIL_TO
npx wrangler secret put FROM_EMAIL

# Gmail OAuth — see "Gmail OAuth setup" below
npx wrangler secret put WORKER_GMAIL_CLIENT_ID
npx wrangler secret put WORKER_GMAIL_CLIENT_SECRET
npx wrangler secret put WORKER_GMAIL_REFRESH_TOKEN
```

### 5. Local smoke test

```bash
npx wrangler dev
```

Leave it running. In another terminal:

```bash
# Health check — no auth required
curl http://localhost:8787/health

# Marker status — needs CRON_SHARED_SECRET header
curl -H "X-Cron-Secret: <secret>" \
  "http://localhost:8787/internal/marker?type=briefing"
# → {"sentBy":null,"date":"2026-04-21"}

# Trigger a primary-path run manually (requires your Mac dev server on :3000
# with the CRON_SHARED_SECRET matching, and MESH_HOSTNAME pointing at localhost
# for local testing — see note below)
curl -X POST -H "X-Cron-Secret: <secret>" \
  "http://localhost:8787/internal/trigger?type=briefing"
```

> **Local-mesh caveat for `wrangler dev`:** a locally-running `wrangler dev`
> still runs the Worker in Cloudflare's workerd sandbox but outbound fetch
> calls go through your local network. Pointing `MESH_HOSTNAME` at
> `http://localhost:3000` for the smoke test is the easiest way to exercise
> primary-path end-to-end before deploying. Switch it back to the Mesh IP
> (`http://100.96.0.1:3099`) before deploying to production.

### 6. Deploy

```bash
npx wrangler deploy
```

Grab the deployed URL from the output — something like
`https://vanguard-skin-cron.<your-subdomain>.workers.dev`.

### 7. Wire the Mac to the Worker's marker endpoint

On the Mac side, add to `.env.local`:

```
WORKER_MARKER_URL=https://vanguard-skin-cron.<your-subdomain>.workers.dev
```

Restart the dev server. The Mac's `/api/cron/*` routes will now pre-check the
Worker's `/internal/marker` endpoint before regenerating and short-circuit if
the cloud fallback already delivered today.

## Gmail OAuth setup (Session C prerequisite)

Run this once, from the repo root:

```bash
# 1. Create a new OAuth 2.0 Desktop client at https://console.cloud.google.com
# 2. Save client ID + secret into the repo root .env.local:
#      WORKER_GMAIL_CLIENT_ID=...apps.googleusercontent.com
#      WORKER_GMAIL_CLIENT_SECRET=GOCSPX-...
# 3. Run the helper script:
npx tsx scripts/worker-gmail-oauth-setup.ts
```

The script opens your browser, captures the auth code, prints a refresh token.
Stash it via `npx wrangler secret put WORKER_GMAIL_REFRESH_TOKEN` from this
directory.

## Operations

### View live logs

```bash
npx wrangler tail
```

### Inspect KV markers

```bash
# List keys
npx wrangler kv key list --binding=CRON_KV

# Read a specific marker
npx wrangler kv key get --binding=CRON_KV mac-sent-briefing-2026-04-27
```

### Manually clear a marker (rare)

```bash
npx wrangler kv key delete --binding=CRON_KV mac-sent-briefing-2026-04-27
```

### Check cron schedule in production

Cloudflare dashboard → Workers & Pages → `vanguard-skin-cron` → Triggers tab.

## Cron schedule & DST

The Worker registers **four** cron triggers:

| Cron          | UTC hour | Purpose                          |
|---------------|----------|----------------------------------|
| `0 19 * * 0`  | Sun 19Z  | Briefing (summer — EDT, UTC-4)   |
| `0 20 * * 0`  | Sun 20Z  | Briefing (winter — EST, UTC-5)   |
| `0 13 * * 1-5`| Weekday 13Z | Digest (summer)               |
| `0 14 * * 1-5`| Weekday 14Z | Digest (winter)               |

On each firing, the `scheduled()` handler computes the current ET wall-clock
hour and day-of-week. If they don't match the expected 3pm-Sun / 9am-weekday
slot, the firing is a no-op log and exits.

This gates out the "off-season" trigger without needing seasonal redeploys.

## What's NOT in this Worker

- No TWS access (impossible from cloud — TWS is Mac-local only).
- No direct SQLite access (state is replicated via R2 nightly snapshots
  written by `scripts/snapshot-state-to-r2.ts`).
- No full parity with the Mac briefing content — Vital Knowledge IMAP fetch
  stays Mac-only; the cloud uses snapshotted VK bodies from R2.
- No email sending in Session B — cloud fallback is a stub until Session C.
