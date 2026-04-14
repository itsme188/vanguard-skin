# Gmail Integration — How It Works

This document describes the Gmail integration in the Vanguard Skin project: how it connects to Gmail, fetches newsletter emails, processes them with AI, and stores the results.

## Overview

The Gmail integration serves two purposes:

1. **Newsletter ingestion** — Automatically fetches financial newsletters from Gmail, processes them with Claude AI to extract summaries/sentiment/tickers, and stores them as searchable research articles.
2. **Outbound email** — Sends weekly calendar briefings and daily research digests via Gmail SMTP.

These are independent systems that use different authentication methods.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Gmail Account                        │
│                                                          │
│  Newsletters arrive ──► Gmail API (OAuth 2.0, read-only) │
│                              │                           │
│  Outbound email ◄── Gmail SMTP (App Password)           │
└──────────────────────────────┼───────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────┐
│                   lib/gmail/ (Core)                       │
│                                                          │
│  auth.ts ──── OAuth 2.0 client setup + token management  │
│  fetch.ts ─── Fetches emails, extracts text + HTML body  │
│  discover.ts ─ Scans for newsletter senders (unsubscribe)│
│  process.ts ── Claude Sonnet AI analysis per article     │
│  sanitize.ts ─ Allowlist HTML sanitizer (XSS prevention) │
│  extract-url.ts ─ Finds "view in browser" source URLs    │
└──────────────────────────────┬───────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────┐
│                   SQLite Database                         │
│                                                          │
│  research_sources ──── Newsletter registry               │
│  research_articles ─── Fetched + AI-enriched articles    │
│  research_article_securities ── Article↔ticker links     │
└──────────────────────────────────────────────────────────┘
```

---

## File-by-File Breakdown

### `lib/gmail/auth.ts` — OAuth 2.0 Authentication

Sets up a Gmail API client using Google's OAuth 2.0 refresh token flow. The `googleapis` library handles access token refresh automatically.

**Key functions:**
- `isGmailConfigured()` — Checks if all 3 env vars are set
- `getGmailClient()` — Returns an authenticated `gmail_v1.Gmail` client
- `getOAuthConsentUrl()` — Generates the Google consent URL (used during initial setup)
- `exchangeCodeForTokens()` — Trades an authorization code for a refresh token
- `verifyGmailConnection()` — Pings Gmail to confirm the token works

**Required env vars:**
```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REFRESH_TOKEN=1//...
```

### `lib/gmail/fetch.ts` — Email Fetching

Fetches new newsletter emails from Gmail for all active sources in the database.

**How it works:**
1. Reads all active `research_sources` from the database
2. For each source, builds a Gmail search query: `from:sender@example.com newer_than:7d`
3. Fetches matching messages via `gmail.users.messages.list`
4. For each message, extracts headers (subject, sender, date) and body (plain text + HTML)
5. Inserts into `research_articles` with `gmail_message_id` as dedup key (`INSERT OR IGNORE`)

**Body extraction** handles Gmail's MIME structure:
- Single-part messages: decode base64 body directly
- Multipart: find `text/plain` and `text/html` parts
- Nested multipart: recurse into child parts
- HTML bodies are sanitized before storage; plain text is extracted via `stripHtml()` as fallback

Also includes:
- `backfillArticleHtml()` — Re-fetches HTML for old articles that were stored without it
- `backfillSourceUrls()` — Extracts "view in browser" URLs from stored HTML

### `lib/gmail/discover.ts` — Newsletter Discovery

Scans Gmail for likely newsletter senders by searching for emails with `unsubscribe` headers (a reliable newsletter signal).

**How it works:**
1. Searches Gmail: `has:unsubscribe newer_than:90d` (last 90 days, up to 200 messages)
2. Fetches metadata headers (From, Subject, Date) for each match
3. Groups by sender email, counts frequency
4. Returns top 50 senders sorted by message count

This powers a "Discover Sources" button in the UI — the user picks which senders to add as research sources.

### `lib/gmail/process.ts` — AI Article Processing

Processes unprocessed articles with Claude Sonnet to extract structured financial intelligence.

**How it works:**
1. Queries `research_articles WHERE processed_at IS NULL` (up to 20 at a time)
2. Loads the user's current portfolio holdings for context
3. For each article, calls Claude Sonnet with a tool-use prompt that forces structured output:
   - **summary** — 2-3 sentence summary
   - **key_themes** — Up to 5 topics (e.g., "fed policy", "tech earnings")
   - **sentiment** — bullish / bearish / neutral / mixed
   - **sentiment_score** — -1.0 to 1.0
   - **mentioned_symbols** — Ticker symbols found in the article
   - **portfolio_relevance** — One sentence on relevance to the user's holdings
4. Links mentioned symbols to `securities` in the database (many-to-many via `research_article_securities`)

**The Claude prompt includes:**
- The article text (capped at 15,000 chars)
- The source name, subject, and sender
- Current portfolio holdings for relevance scoring
- Optional per-source processing instructions (stored in `research_sources.processing_prompt`)

### `lib/gmail/sanitize.ts` — HTML Sanitizer

Allowlist-based HTML sanitizer that strips everything except known-safe tags and attributes. Used before storing newsletter HTML for later rendering in the UI.

**What it does:**
- Removes `<script>`, `<style>`, `<iframe>`, `<form>`, `<svg>` (with all their content)
- Removes HTML comments, tracking pixels (1x1 images), hidden images
- Strips all tags not in the allowlist (keeps their text content)
- For allowed tags, strips all attributes not in the allowlist
- Blocks `javascript:`, `data:`, `vbscript:` URLs
- Only allows `https://` and `http://` for image `src`
- Trims email footer boilerplate (unsubscribe links, copyright notices, physical addresses)

**Allowed tags:** `p`, `br`, `hr`, `div`, `span`, headings, text formatting, `a`, `img`, lists, tables, `blockquote`, `pre`, `code`

**Allowed attributes:** `href`/`title` on links, `src`/`alt`/`width`/`height` on images, `colspan`/`rowspan` on table cells

### `lib/gmail/extract-url.ts` — Source URL Extraction

Finds per-article URLs from newsletter HTML so articles can link back to the original web version.

**Strategy (priority order):**
1. Find anchor tags with "view in browser" / "read online" text
2. Find direct article URLs for known domains (e.g., `vitalknowledge.net/article/...`)

Strips tracking parameters (e.g., `?fromEmail=1`) from extracted URLs.

### `lib/email.ts` — Outbound Email (SMTP)

Sends emails via Gmail SMTP using a Gmail App Password (separate from the OAuth flow above). Used for:
- Weekly calendar briefing emails
- Daily research digest emails

**Required env vars (different from OAuth):**
```
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

Generate an App Password at https://myaccount.google.com/apppasswords (requires 2FA enabled).

### `scripts/gmail-oauth-setup.ts` — One-Time Setup Script

Interactive script that walks through the OAuth consent flow:

1. Reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `.env.local`
2. Starts a temporary HTTP server on `localhost:3456`
3. Opens the Google consent screen in the browser
4. Captures the authorization code via the OAuth redirect
5. Exchanges the code for a refresh token
6. Prints the `GOOGLE_REFRESH_TOKEN` for the user to add to `.env.local`

**Usage:** `npx tsx scripts/gmail-oauth-setup.ts`

---

## Database Schema

Created by migration `019_research_feeds.sql`:

```sql
-- Newsletter registry
research_sources (
  id, name, sender_email, sender_pattern, subject_pattern,
  is_active, fetch_frequency, max_age_days, processing_prompt, created_at
)

-- Fetched + AI-enriched articles
research_articles (
  id, source_id, gmail_message_id (UNIQUE), gmail_thread_id,
  received_at, subject, sender, raw_text, raw_html, source_url,
  summary, key_themes, sentiment, sentiment_score,
  mentioned_symbols, portfolio_relevance, ai_model, processed_at, created_at
)

-- Many-to-many: articles <-> portfolio securities
research_article_securities (
  id, article_id, security_id, mention_context, sentiment
  UNIQUE(article_id, security_id)
)
```

A later migration (024) added the `source_url` and `raw_html` columns to `research_articles`.

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/gmail/status` | GET | Check if Gmail OAuth is connected |
| `/api/research/sync` | POST | Fetch new articles + AI process (SSE streaming) |
| `/api/research/discover` | POST | Scan Gmail for newsletter senders |
| `/api/research/articles` | GET | Query processed articles (with filters) |
| `/api/research/sources` | GET/POST/PATCH/DELETE | Manage newsletter source registry |
| `/api/digest/email` | POST | Compile + send daily research digest |
| `/api/calendar/email` | POST | Generate + send weekly calendar briefing |

---

## Data Flow

```
1. User clicks "Discover Sources" in the UI
   → POST /api/research/discover
   → Scans Gmail for newsletter senders
   → Returns list for user to pick from

2. User adds sources to the registry
   → POST /api/research/sources

3. User clicks "Sync" (or cron job fires)
   → POST /api/research/sync
   → For each active source:
     a. Build Gmail query (from:sender newer_than:Nd)
     b. Fetch matching emails via Gmail API
     c. Extract text + HTML body
     d. Insert into research_articles (dedup by gmail_message_id)
     e. Process with Claude Sonnet (summary, sentiment, tickers)
     f. Link mentioned tickers to portfolio securities

4. Research tab shows processed articles
   → GET /api/research/articles
   → Filtered by source, security, date range, search text
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `googleapis` | Gmail API client (OAuth 2.0) |
| `@anthropic-ai/sdk` | Claude Sonnet for article analysis |
| `nodemailer` | Outbound email via Gmail SMTP |
| `better-sqlite3` | SQLite database |

---

## Setup Guide (for someone adapting this code)

### 1. Google Cloud Project
1. Go to https://console.cloud.google.com
2. Create a project (or select existing)
3. Enable the **Gmail API**
4. Go to **Credentials > Create Credentials > OAuth client ID**
5. Application type: **Desktop app**
6. Copy the Client ID and Client Secret

### 2. Environment Variables
Add to `.env.local`:
```
# Gmail OAuth (for reading newsletters)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...

# Gmail SMTP (for sending emails) — separate from OAuth
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

# Claude API (for article AI processing)
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Get a Refresh Token
```bash
npx tsx scripts/gmail-oauth-setup.ts
```
This opens a browser, you grant read-only Gmail access, and it prints a `GOOGLE_REFRESH_TOKEN` to add to `.env.local`.

### 4. Create the Database Tables
Run migration `019_research_feeds.sql` against your SQLite database (or adapt the schema for your database of choice).

---

## What You'd Need to Change to Reuse This

The Gmail fetching and processing code is fairly modular, but it has these project-specific ties:

- **SQLite via better-sqlite3** — All functions take a `db` parameter. Replace with your database client.
- **Portfolio holdings context** — `process.ts` loads current holdings to tell Claude what's relevant to you. Remove or replace with your own context.
- **Claude API for processing** — Uses `@anthropic-ai/sdk` directly. You could swap for any LLM.
- **`stripHtml()` import** — Imported from `lib/vital-knowledge.ts` (a simple regex HTML stripper). Replace with any HTML-to-text utility.

The `auth.ts`, `discover.ts`, `sanitize.ts`, and `extract-url.ts` files are essentially standalone and could be copied as-is.
