# Evening Email + Cross-Source Synthesis + Deliverability Hardening

| Field | Value |
|---|---|
| Date | 2026-05-08 |
| Owner | Isaac |
| Status | Design approved (brainstorming complete) — pending spec review + implementation plan |
| Approach | B (Synthesis everywhere) — see Approaches Considered below |

## 1. Context

The portfolio dashboard currently sends three categories of email:

1. **Sunday weekly briefing** — Sun 3pm ET, Opus 4.7-generated week-ahead from Vital Knowledge + Finnhub earnings + macro events.
2. **Morning daily digest** — Mon-Fri 8:45am ET, alerts triggered since last digest + per-source layout of newsletters received in the same window.
3. **Earnings preview/recap** — per-event, T-2h before release / T+enrichment after release; not on a clock cron.

Three problems motivate this design:

- **Newsletter inbox post-morning-digest is uncovered.** Newsletters arriving 8:45am-evening (notably TMT Breakout's EOD recap, which lands 5-6pm "almost never later than 7pm") never get the digest treatment. The user is reading them ad-hoc in the inbox.
- **The morning digest's per-source layout is repetitive on quiet days.** When 12 articles arrive across 5 sources, the user reads "5 sentiment headers, 5 separate summaries" rather than "what mattered today across these sources." The existing in-app `<DigestEmailViewer>` already offers a by-company toggle for the same articles — but the email itself remains per-source.
- **Deliverability has shown signs of wear.** A recent Eli email landed in junk. With more recipients on the morning digest (brother) and a new evening surface coming online, a deliverability audit is overdue.

## 2. Goals (in scope)

1. **New evening email** — Mon-Thu 7:00pm ET + Fri 5:30pm ET. Wraps the day's post-morning-digest newsletter flow plus a small flag for unusual price moves in held Vanguard names.
2. **Cross-source synthesis** — replace the per-source layout in the morning digest (and use the same synthesis in the evening email) with a Sonnet-generated narrative grouped by company/topic, citing sources inline. Per-source rendering survives as the layout for low-volume days (<5 articles) and as the in-app `<DigestEmailViewer>` toggle.
3. **Deliverability hardening** — audit DKIM/SPF/DMARC/Resend dashboard; add `List-Unsubscribe`, `List-Unsubscribe-Post`, `Reply-To`, `Message-ID` headers to all outbound mail.
4. **Per-email recipients UI** — Settings UI section that lets the user override BRIEFING_EMAIL_TO per email type (Sunday / morning / evening) with a stored list. Default: same recipients across all three.

### 2.1 Non-goals (out of scope, explicit)

- One-click `List-Unsubscribe-Post=One-Click` server handler. Including the header is in scope; the `mailto:unsubscribe@...` route handler that records suppressions is deferred.
- Subject-line redesign (parked).
- Read-status tracking via Resend's open/click pixel (parked).
- Mobile rendering audit on real Outlook/Gmail (parked but should run after this ships).
- Synthesis applied to Sunday briefing (Opus already does cross-source synthesis there manually).
- Anomaly flag on IBKR or Roth holdings — Vanguard only.
- P&L or position-size data in any email body (privacy: brother is a recipient).

## 3. Approaches considered

### Approach A — Minimum scope (parked synthesis)
Evening email reusing existing per-source layout. Synthesis deferred. ~4 days. Rejected because evening + morning would feel structurally identical; the synthesis is what gives each its own value.

### Approach B — Synthesis everywhere (CHOSEN)
Evening email + cross-source synthesis on both digests + deliverability. Single composer, adaptive layout. ~6 days.

### Approach C — Synthesis-first, defer evening
Cross-source synthesis on morning only first; evening parked. Rejected because user's primary ask was the evening email.

## 4. Architecture

### 4.1 New files (10)

| File | Purpose |
|---|---|
| `lib/digest/send-evening.ts` | Evening composer (mirrors `send-digest.ts` shape) |
| `lib/digest/synthesize.ts` | Sonnet 4.6 cross-source synthesis (shared by morning + evening) |
| `lib/digest/anomalies.ts` | 2× beta Vanguard anomaly block |
| `lib/queries/security-betas.ts` | Cached-beta read |
| `lib/mutations/security-betas.ts` | Cached-beta write |
| `app/api/cron/evening/route.ts` | Mac cron endpoint (X-Cron-Secret-gated) |
| `scripts/send-evening-email.sh` | launchd wrapper (retry × 3, 120s backoff — same shape as `send-daily-digest.sh`) |
| `~/Library/LaunchAgents/com.vanguard-skin.evening-email.plist` | launchd schedule |
| `workers/cron/src/fallback-evening.ts` | Worker fallback path |
| `lib/db/migrations/048_security_betas.sql` | Beta cache table |

### 4.2 Modified files (~12)

- `lib/digest/send-digest.ts` — call shared synthesis composer
- `lib/digest/daily-digest.ts` — adaptive layout (synthesis at ≥5 articles, per-source below)
- `lib/digest/group-by-company.ts` — promote `bucketByCompany` from viewer-only to email-side use
- `workers/cron/wrangler.toml` — 4 new cron triggers (Mon-Thu summer/winter + Fri summer/winter)
- `workers/cron/src/index.ts` — dispatch `evening` job type alongside `briefing` / `digest`
- `workers/cron/src/dedup.ts` — extend `JobType` to include `evening`
- `workers/cron/src/primary.ts` — extend body shape for evening
- `workers/cron/src/fallback-digest.ts` — port to synthesis composer
- `lib/cron/marker-check.ts` + `lib/cron/running-marker.ts` — extend for `evening`
- `scripts/snapshot-state-to-r2.ts` — bump to schemaVersion 3 (cached betas, Vanguard symbols, recipients setting, last_digest_sent_at)
- `electron/settings-store.ts` + `app/dashboard/components/SettingsModal.tsx` — recipients UI
- `lib/email.ts` — `List-Unsubscribe` + `List-Unsubscribe-Post` + `Reply-To` + `Message-ID` headers (also applies to Worker `resend.ts`)

### 4.3 Cron triggers (Worker side after change)

| Existing | New (this design) |
|---|---|
| `0 19 * * SUN` (Sun 3pm ET summer) — briefing | `0 23 * * MON-THU` (Mon-Thu 7pm ET summer) — evening |
| `0 20 * * SUN` (Sun 3pm ET winter) — briefing | `0 0 * * TUE-FRI` (Mon-Thu 7pm ET winter, +1 UTC day) — evening |
| `45 12 * * MON-FRI` (Mon-Fri 8:45am ET summer) — digest | `30 21 * * FRI` (Fri 5:30pm ET summer) — evening |
| `45 13 * * MON-FRI` (Mon-Fri 8:45am ET winter) — digest | `30 22 * * FRI` (Fri 5:30pm ET winter) — evening |
| `*/15 * * * *` — calendar enrich | — |
| **5 triggers total** | **9 triggers total** (well under Cloudflare's 1000-per-account limit) |

`scheduled()` continues to gate via `Intl.DateTimeFormat("America/New_York")` — only the right seasonal slot fires.

**Watch out for the winter day-shift on Mon-Thu evening triggers.** The winter cron uses `TUE-FRI` because 7pm EST is 00:00 UTC of the *next* day. A future maintainer reading `0 0 * * TUE-FRI` and expecting "Mon-Thu evening" will need this comment to avoid a head-scratch. The Fri 5:30pm slot has no day-shift because both summer and winter fall pre-midnight UTC.

### 4.4 Schedule rationale (locked)

- **7pm Mon-Thu**: TMT Breakout's EOD recap arrives 5-6pm "almost never later than 7pm" — this is the email that wraps the day's trading. Wake time anchored to that publisher.
- **5:30pm Fri**: Friday newsletter flow ends earlier; user wraps before weekend.
- **No Sat/Sun evening**: weekend coverage is the existing Sunday 3pm briefing.

## 5. Data flow

### 5.1 ASCII diagram (full primary + fallback flow)

```
┌─────────────────────────────────────────────────────────────────┐
│  TRIGGER (whichever fires first wins via shared KV markers)     │
├─────────────────────────────────────────────────────────────────┤
│  Mac launchd (Mon-Thu 19:00 / Fri 17:30 local) ──┐              │
│       OR                                          ├─→ same email │
│  Worker cron (4 DST-paired UTC slots) ───────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────── PRIMARY PATH (Mac) ─────────────────────────┐
│  scripts/send-evening-email.sh (retry × 3, 120s backoff)       │
│    ↓                                                            │
│  POST /api/cron/evening (X-Cron-Secret)                        │
│    ↓                                                            │
│  Pre-check: GET worker /internal/marker?type=evening           │
│    ├─ cloud-sent? → return {skipped:true}, exit                │
│    └─ proceed                                                  │
│  POST worker /internal/running-marker?type=evening&action=set  │
│    ↓                                                            │
│  sinceSnapshot = getLastDigestSentAt(db) || (now - 24h)        │
│    ↓                                                            │
│  syncPortfolio()  ← live prices for anomaly computation        │
│    ↓                                                            │
│  fetchNewArticles + processUnprocessedArticles                 │
│    ↓                                                            │
│  COMPOSER (lib/digest/send-evening.ts):                        │
│    1. formatTriggeredAlertsSection(db, sinceSnapshot)          │
│    2. formatVanguardAnomaliesBlock(db) [§7]                    │
│    3. articles = getRecentArticles(db, sinceSnapshot)          │
│    4. if (articles.length >= 5):                               │
│         buckets = bucketByCompany(articles)                    │
│         synth = synthesize(buckets) [§6]                       │
│         render synth + concise per-source tail                 │
│       else:                                                    │
│         render per-source (existing path)                      │
│    ↓                                                            │
│  sendEmail({ fromLocalPart: "evening", subject: ... })         │
│    ↓                                                            │
│  setLastDigestSentAt(db, now)  ← shared marker w/ morning      │
│  POST worker /internal/sent-marker?type=evening                │
│  POST worker /internal/running-marker?type=evening&action=clear│
└─────────────────────────────────────────────────────────────────┘

┌──────────── FALLBACK PATH (Worker) ──────────────────────────────┐
│  scheduled() → callPrimary(timeout 300s) → timeout/5xx/network   │
│    ↓                                                              │
│  re-read markers (mac-sent? mac-running? cloud-sent?) → if any,  │
│    skip                                                           │
│    ↓                                                              │
│  runFallbackEvening(env):                                        │
│    · readR2Snapshot() — schemaVersion 3                          │
│    · sinceSnapshot = snapshot.last_digest_sent_at                │
│    · recipient = snapshot.evening_email_recipients               │
│    · fetch articles via Gmail REST                               │
│    · if snap.schemaVersion >= 3 && betas present:                │
│        fetch SPY + Vanguard symbols' last 2 closes via Yahoo     │
│        compute anomaly block                                     │
│    · synthesize via Sonnet through AI Gateway (or per-source)    │
│    · sendEmail via Resend REST                                   │
│    · writeMarker("cloud", "evening", date)                       │
└───────────────────────────────────────────────────────────────────┘
```

### 5.2 Shared marker dedup (the load-bearing decision)

Single `last_digest_sent_at` setting, shared between morning and evening:

| Cycle | Reads since | Updates marker after success |
|---|---|---|
| Mon morning (8:45am) | Sun 7pm marker (Sun N/A → Sat 8:45am marker) | Yes |
| Mon evening (7pm) | Mon 8:45am marker | Yes |
| Tue morning (8:45am) | Mon 7pm marker | Yes |
| Tue evening (7pm) | Tue 8:45am marker | Yes |

Every article and alert appears in exactly one email. No overlap, no gap. Race-condition guards (`sinceSnapshot` capture before async work; `skipMarkerUpdate` flag for catch-up flows) port directly from morning digest.

**Edge case — empty cycles do NOT update the marker (intentional).** A cycle that produces zero articles, zero alerts, and zero anomalies returns `{skipped: true}` without sending an email AND without calling `setLastDigestSentAt`. The next cycle then reads `sinceSnapshot` from the same prior marker and naturally back-fills any articles/alerts that arrived in the meantime. This is intentional behavior already in `lib/digest/send-digest.ts:120-127`. The new evening composer must mirror it. **A future "skip empty cycles entirely" refactor must preserve this back-fill semantic** — skipping the cycle without scanning is fine, but pre-emptively bumping the marker to "now" without scanning would silently drop any articles that arrived in the previous window.

## 6. Cross-source synthesis (`lib/digest/synthesize.ts`)

### 6.1 Input shape

```ts
type BucketInput = {
  symbol: string | null;       // null for macro/no-symbol bucket
  companyName: string | null;  // resolved via securities table
  articles: ArticleRef[];      // each with source, sentiment, summary, source_url
};
```

Produced by existing `lib/digest/group-by-company.ts::bucketByCompany`. Multi-symbol articles fan out across buckets. No-symbol articles collect to a `(no symbol)` macro bucket.

### 6.2 Prompt structure (Sonnet 4.6 via AI Gateway, `feature="dailyDigestSynthesis"`)

```
SYSTEM:
You are synthesizing newsletter coverage for a portfolio investor's day-end
recap. Write one section per company/topic that surfaces what mattered
TODAY across sources, with citations.

CRITICAL OUTPUT RULES:
- First character must be `#`. No preamble, no narration ("I'll now...",
  "Good, here is..."), no closing commentary.
- Use ## CompanyName as section headers (or ## Macro for the no-symbol bucket).
- Cite sources inline as [SourceName](url) — the SourceName link is mandatory
  whenever you reference any claim.
- Connect threads ACROSS sources where they exist. If only one source mentions
  something, say so ("Only Vital Knowledge flagged X today").
- Skip companies/topics with thin coverage (1 article, no portfolio relevance) —
  weave them into a closing "## Also covered" line at the end.
- 60-150 words per section. Skip if no meaningful synthesis is possible.
- DO NOT include P&L numbers, position sizes, or anything that would reveal
  what the user owns. Write as if for an analyst peer.

USER:
Held tickers: [list of held symbols]
Watchlist: [list of watchlist symbols]
Today's anomaly flags: [list of names from anomaly block, no $ amounts]

Per-company buckets (today's articles only):
## NVDA (NVIDIA)
- Vital Knowledge (bullish): summary text...
- TMT Breakout (neutral): summary text...
[etc.]

Render the synthesis now.
```

### 6.3 Defense against AI failures

- `stripModelPreamble()` (existing in `lib/digest/send-earnings-email.ts`) — promote to a shared helper. Trims any leading lines that aren't `#`, `|`, `-`, `*`, `>`, code fence.
- Empty result OR result < 200 chars → throw `SynthesisEmptyError`, caller falls back to per-source layout.
- `finish_reason === "length"` → log + throw same error.
- `maxOutputTokens: 4096` (sufficient for ~10 company sections).
- Web_search NOT enabled — synthesis works only from provided article summaries (no hallucination of new facts).

### 6.4 The per-source layout is preserved (in-app viewer + low-volume fallback)

`generateDigestSince` (the existing per-source rendering function in `lib/digest/daily-digest.ts`) is **not deleted**. It survives in two roles:

1. **Adaptive low-volume fallback** in the email itself: when articles < 5, the email renders per-source. When articles ≥ 5, the email renders synthesis above + a concise per-source tail below for traceability.
2. **In-app `<DigestEmailViewer>` toggle**: the modal already returns BOTH `bySourceHtml` and `byCompanyHtml` from `GET /api/digest/preview`. The synthesis layout becomes a third option (`synthesisHtml`) the modal can toggle between. Per-source rendering remains available on demand.

### 6.5 Why Sonnet 4.6 not Opus 4.7

- Synthesis is structured-narrative, not deep-reasoning. Sonnet handles this class well (precedent: earnings preview/recap composer).
- Cost: ~$0.10/email vs Opus ~$0.50/email — 5× saving daily adds up.
- Latency: ~3-5s vs Opus 8-15s — material on the cron path.
- Quality regression watch: 48h post-launch monitoring; one-line flip to Opus via `FEATURE_MODELS["dailyDigestSynthesis"]` if needed.

## 7. Anomaly block (`lib/digest/anomalies.ts`)

### 7.1 Algorithm (per Vanguard-held security)

```
1. Get latest close + prior close for security        → actual_pct
2. Get latest close + prior close for SPY             → spy_pct
3. Read cached_beta from security_betas table        → beta
   (skip if NULL or < 30 days of history)
4. expected_pct = spy_pct × beta
5. threshold = max(2 × |expected_pct|, 1.0%)         ← 1% floor
6. flag if |actual_pct| > threshold
```

### 7.2 Why the 1% absolute floor

On a flat market day (SPY ±0.1%) with beta-1 stocks, expected = ±0.1%, threshold without floor = ±0.2%. The floor caps noise on quiet days where every name moving more than 0.2% would otherwise flag.

### 7.3 Render output (markdown)

```markdown
## Significant Moves in Vanguard Holdings (vs. expected)

- **GOOG** -3.4% — expected -1.2% (beta 1.6 × SPY -0.75%). 2.8× expected.
- **TER**  +5.1% — expected +1.5% (beta 2.0 × SPY +0.75%). 3.4× expected.
- **NVDA** -4.2% — expected +0.8% (beta 1.1 × SPY +0.75%). Direction flipped.
```

### 7.4 Sorting & cap

Top 5 by `|actual| / threshold` ratio (most-anomalous first). If >5 names flag, append `*(N more flagged — see /dashboard/today)*`.

### 7.5 Privacy compliance

- No $ amounts, no share counts, no position size or "n% of portfolio".
- Only public-market data: % moves, beta, ticker, company name. Same level of detail as a Bloomberg ticker scroll.

### 7.6 No-flag day

Block omitted entirely (vs rendering "no anomalies today" which would be noise).

### 7.7 Beta cache refresh (`scripts/refresh-vanguard-betas.ts`)

- Runs nightly at 2am via existing `com.vanguard-skin.state-snapshot.plist` (chained after snapshot-state-to-r2; no new plist).
- For each Vanguard-held security: 60-day OLS regression of daily returns vs SPY.
- Writes to `security_betas (security_id, lookback_days=60, beta, computed_at)` UPSERT on UNIQUE.
- Skip securities with <30 days of price history.
- Idempotent — re-run is a no-op if same day.

## 8. Worker fallback (`workers/cron/src/fallback-evening.ts`)

### 8.1 R2 snapshot extension (schemaVersion 2 → 3)

`scripts/snapshot-state-to-r2.ts` adds:

```ts
{
  schemaVersion: 3,
  // ...existing v2 fields
  vanguardHoldings: [
    { symbol, securityId, accountId },
  ],
  securityBetas: [
    { securityId, lookbackDays: 60, beta, computedAt },
  ],
  settings: {
    // ...existing
    last_digest_sent_at,             // shared marker
    evening_email_recipients,        // user-configured override of BRIEFING_EMAIL_TO
    digest_email_recipients,         // ditto for morning digest
    briefing_email_recipients,       // ditto for Sunday briefing
  },
}
```

### 8.2 Backward compat

Worker fallback reads `schemaVersion` and treats v2 snapshots as missing the new fields → graceful degrade (anomaly block omitted in fallback if betas absent; recipients fall back to env var). Mac side reads v3 onwards.

### 8.3 Fallback flow (pseudocode)

```ts
async function runFallbackEvening(env: Env): Promise<FallbackResult> {
  const snap = await readR2Snapshot(env);
  if (!snap || snap.schemaVersion < 2) return { kind: "error", error: "snapshot too old" };

  const sinceSnapshot = snap.settings.last_digest_sent_at ?? (now - 24h);
  const recipient = snap.settings.evening_email_recipients ?? env.BRIEFING_EMAIL_TO;

  const articles = await fetchArticlesFromGmail(env, sinceSnapshot);

  let anomaliesMd = "";
  if (snap.schemaVersion >= 3 && snap.securityBetas?.length) {
    const symbols = ["SPY", ...snap.vanguardHoldings.map(h => h.symbol)];
    const lastTwoCloses = await fetchYahooLast2Closes(symbols);
    anomaliesMd = computeAnomaliesFromBetas(snap, lastTwoCloses);
  }

  const bodyMd = articles.length >= 5
    ? await synthesizeViaAIGateway(env, bucketByCompany(articles))
    : renderPerSource(articles);

  const fullMd = [
    formatAlertsFromSnapshot(snap, sinceSnapshot),
    anomaliesMd,
    bodyMd
  ].filter(Boolean).join("\n\n---\n\n");

  await sendEmail(env, {
    to: recipient,
    subject: `📊 Evening Recap — ${formatDate(now)}`,
    html: briefingToHtml(fullMd, title),
    fromLocalPart: "evening"
  });

  return { kind: "success" };
}
```

### 8.4 Yahoo dependency

We already use Yahoo for reaction-snapshot bars in calendar enrichment. Reusing `workers/cron/src/yahoo.ts` — no new external dependency. Yahoo's `query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d` returns last-N daily closes free, no auth.

### 8.5 Latency budget

SPY + ~50 Vanguard symbols × Yahoo fetch in parallel ≈ 3-5s. Sonnet synthesis ≈ 3-5s. Resend send ≈ 1s. Total ≈ 10s — well under Worker CPU/wall-time limits.

## 9. Deliverability hardening

### 9.1 Investigative pass (run BEFORE shipping headers — establishes baseline)

| Check | Command / Location | Pass criteria |
|---|---|---|
| DKIM | `dig +short TXT resend._domainkey.myportfoliodesk.com` | Returns Resend's selector key |
| SPF | `dig +short TXT myportfoliodesk.com` | Includes `include:_spf.resend.com` |
| DMARC | `dig +short TXT _dmarc.myportfoliodesk.com` | At least `v=DMARC1; p=quarantine; rua=mailto:...` |
| Subdomain isolation | Resend dashboard domains page | `myportfoliodesk.com` + `send.myportfoliodesk.com` both verified |
| MX (inbound) | `dig +short MX myportfoliodesk.com` | Cloudflare Email Routing catch-all active |
| Suppression list | Resend dashboard → Suppressions | Eli's address NOT listed; if listed, investigate why |
| Past 30d delivery | Resend dashboard → Logs | Bounce rate <2%, complaint rate <0.1% per recipient domain |

### 9.2 Header changes

Applied to `lib/email.ts::sendEmail()` AND `workers/cron/src/resend.ts`:

```ts
"List-Unsubscribe": `<mailto:unsubscribe@myportfoliodesk.com?subject=unsubscribe>`,
"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
"Reply-To": process.env.REPLY_TO_ADDRESS ?? `replies@${RESEND_FROM_DOMAIN}`, // see §9.5 — verify routing first
"Message-ID": `<${nanoid()}@${RESEND_FROM_DOMAIN}>`,
```

### 9.3 Eli's-junk-folder root-cause hypothesis

- **Most likely**: missing `List-Unsubscribe` is the single biggest signal Gmail uses to penalize "newsletter-shaped" emails. 2024+ Gmail essentially requires it for senders >5000/day and recommends it for all senders.
- **Secondary**: subject-line emoji (`📰 Morning Research Digest...`) might trigger a heuristic. Don't change subjects in this design but flag for follow-up if audit shows pattern correlation.
- **Tertiary**: warm-up. Resend domains under <100/month volume can be flagged as "low reputation" — adding the evening email helps by 2× the volume.

### 9.4 One-click unsubscribe handler (deferred, see Non-Goals §2.1)

`mailto:unsubscribe@...` is included in headers but the inbound handler that records the suppression is deferred to a separate session.

### 9.5 Reply-To routing — verify before shipping the header

Before flipping `Reply-To: replies@myportfoliodesk.com` live, confirm Cloudflare Email Routing has a rule forwarding `replies@` to a real inbox the user reads. Two options:

1. **Add a Cloudflare Email Routing rule** for `replies@myportfoliodesk.com` → user's personal Gmail (or another mailbox). Verify by sending a test reply and confirming arrival.
2. **Default `Reply-To` to the user's personal email** if no routing is set up. Less polished (replies leak the personal address) but safer than letting a recipient hit a black-hole.

Pick option 1 in the implementation plan. If Cloudflare routing setup is out-of-scope for this session, fall back to option 2 with a TODO to migrate later.

## 10. Recipients UI (SettingsModal.tsx)

### 10.1 UI

```
[ Settings → Email Recipients ]
─────────────────────────────────────
 Sunday Briefing recipients:  [ comma-separated emails ]
                              ↑ defaults to BRIEFING_EMAIL_TO when empty
 Morning Digest recipients:   [ comma-separated emails ]
                              ↑ defaults to BRIEFING_EMAIL_TO when empty
 Evening Email recipients:    [ comma-separated emails ]
                              ↑ defaults to BRIEFING_EMAIL_TO when empty
─────────────────────────────────────
```

### 10.2 Storage

Existing `settings` key-value table. Three keys:
- `briefing_email_recipients`
- `digest_email_recipients`
- `evening_email_recipients`

All optional — fallback to `BRIEFING_EMAIL_TO` env var when null. Worker reads from snapshot.

### 10.3 Why surface all three

The user might want different audiences per email *generally*. Costs near-zero extra UI; decoupling now avoids a refactor when brother is dropped from one but kept on another.

### 10.4 Electron settings threading (existing four-touch pattern)

Per CLAUDE.md `Electron env-var threading` rule: AppSettings field, bootstrap from .env.local, sanitize for UI, env pass-through in main.ts.

## 11. Migration / DB schema

### 11.1 Migration 048: `security_betas`

```sql
CREATE TABLE security_betas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  lookback_days INTEGER NOT NULL,
  beta REAL NOT NULL,
  computed_at TEXT NOT NULL,
  UNIQUE(security_id, lookback_days)
);

CREATE INDEX idx_security_betas_security ON security_betas(security_id);
```

Idempotent re-run safe. Drop is non-destructive (no foreign-key references inbound).

## 12. Testing

### 12.1 Unit tests (in-memory SQLite)

- `tests/digest/anomalies.test.ts` — 2× beta math, 1% floor, beta-skip when null, sorting, top-5 cap
- `tests/digest/synthesize.test.ts` — `stripModelPreamble` defense, empty-result fallback, length-truncation handling, prompt assembly with held tickers, mocks Sonnet response
- `tests/digest/send-evening.test.ts` — mirrors existing send-digest tests: race condition (snapshot-before-await), skipMarkerUpdate semantics, sinceSnapshot fallback when settings empty
- `tests/digest/adaptive-layout.test.ts` — <5 articles → per-source path; ≥5 → synthesis path with per-source tail; synthesis-empty → falls back to per-source
- `tests/queries/security-betas.test.ts` — read/write/UPSERT/skip-stale
- `tests/cron/marker-check.test.ts` — extend for `evening` job type
- `tests/email/headers.test.ts` — verify `List-Unsubscribe` + `List-Unsubscribe-Post` + `Message-ID` + `Reply-To` are emitted

### 12.2 Worker tests

- `workers/cron/test/fallback-evening.test.ts` — schema v2 fallback (no anomaly block), schema v3 (with anomaly block), Yahoo failure → graceful degrade
- `workers/cron/test/dedup.test.ts` — extend with `evening` JobType
- `workers/cron/test/dst.test.ts` — verify summer/winter UTC slot mapping for new triggers

### 12.3 Integration test

`tests/integration/evening-email-end-to-end.test.ts` — boots in-memory DB, fixtures (12 articles, 3 Vanguard holdings with cached betas, price data) → runs full composer → asserts markdown contains alert section, anomaly section, synthesized narrative; asserts privacy compliance (no $ amounts, no share counts).

### 12.4 Manual smoke (pre-launch)

- Trigger `POST /api/cron/evening` from dev server with X-Cron-Secret. Inspect rendered HTML in `<DigestEmailViewer>` modal (existing in-app preview).
- Force-fire Worker fallback: `wrangler deploy` to staging, `curl -X POST .../internal/trigger?type=evening&fallbackOnly=true`.
- Verify Resend dashboard shows the email with all new headers.

## 13. Rollout plan (phased, 6 days)

| Day | What ships | Visible? |
|---|---|---|
| 1 | Migration 048 + nightly beta refresh script + `lib/digest/anomalies.ts` + tests | No (beta cache populates overnight) |
| 2 | `lib/digest/synthesize.ts` + adaptive-layout switch in `daily-digest.ts` + tests. Morning digest now uses synthesis path | Tomorrow morning's digest is in synthesis layout |
| 3 | Deliverability hardening: header changes + audit pass on Resend dashboard + DNS records | Subtle — better deliverability |
| 4 | `lib/digest/send-evening.ts` + `app/api/cron/evening/route.ts` + launchd plist (Mac primary path). Manually-triggered first; observe one Mon-Thu cycle | First evening email arrives |
| 5 | Worker fallback (`fallback-evening.ts`) + R2 schemaVersion 3 + new wrangler.toml triggers + extend `index.ts` job dispatcher | Evening email arrives reliably even with Mac off |
| 6 | Recipients UI in SettingsModal + electron settings threading + Mac-side reads from settings table + Worker reads from snapshot | Per-email recipient controls |

### 13.1 Phase-1 safety

Cross-source synthesis ships to morning digest BEFORE the new evening email. If synthesis quality is poor, we revert that single change before committing the rest. Evening email never goes out with broken synthesis because per-source fallback exists in both code paths.

### 13.2 Rollback per layer

- **Synthesis**: `FEATURE_MODELS["dailyDigestSynthesis"]` model swap or full removal of synthesis branch. Adaptive layout makes both paths live in the codebase, so removing synthesis is one boolean.
- **Evening email**: `launchctl unload com.vanguard-skin.evening-email.plist` + remove Worker triggers. R2 schema can stay at v3 — backward compat means v2-shape readers ignore extras.
- **Beta cache**: idempotent table — drop is non-destructive.

## 14. Error handling

| Failure | Handling |
|---|---|
| TWS not connected | Continue without `syncPortfolio()` — anomaly block uses last `prices` table snapshot. Log warning. |
| Gmail not configured | Skip `fetchNewArticles` — still send (alerts + anomalies only). |
| Synthesis call times out / returns malformed | Caught by length-and-shape check → fall back to per-source layout. Tag email subject with `(per-source)` for one cycle so issue is visible in inbox. |
| Yahoo fetch fails (Worker fallback) | Anomaly block omitted in fallback only (graceful degrade). Mac primary unaffected. |
| Beta cache empty (new install / DB reset) | Nightly refresh hasn't run — anomaly block omitted, log warning. |
| `last_digest_sent_at` unset (first run ever) | Default to (now − 24h), same as morning digest's existing fallback. |
| Worker primary timeout | 300s timeout, then re-read markers, then fallback (existing pattern from morning digest). |
| Resend API failure | `EveningSendError(status: 500)` thrown. launchd retries 3× with 120s backoff (existing wrapper pattern). |

## 15. Observability

- **Cloudflare AI Gateway dashboard** filtered by `feature=dailyDigestSynthesis` — track Sonnet cost + latency + error rate
- **Mac log path**: `~/Library/Logs/vanguard-evening-email.log` (new wrapper)
- **Worker**: `wrangler tail` for real-time
- **KV markers**: `GET /internal/marker?type=evening` returns mac/cloud/running flags
- **Synthesis-fallback counter**: when `synthesize()` throws `SynthesisEmptyError` and the composer falls back to per-source layout, log a structured line `synthesis_fallback: { reason, articleCount, date }` AND increment a settings key `synthesis_fallbacks_last_30d` (a JSON-encoded ring buffer of the last 30 days). New endpoint `GET /api/digest/synthesis-health` returns the buffer for in-app surfacing. **Why this matters**: silent quality degradation (synthesis empty / model self-talk leaking past `stripModelPreamble` / Sonnet API outage) is the highest-likelihood drift mode of this design. Without an explicit counter, the only signal is "the user notices the email looks different" — too late.

## 16. Out of scope / parking lot

- One-click `mailto:unsubscribe@...` Worker handler
- Subject-line redesign (emoji, count, top symbols)
- Read-status tracking via Resend pixel
- Mobile rendering audit on real Outlook + Gmail (recommend running this AFTER ship)
- Anomaly flag on IBKR or Roth holdings
- Synthesis on Sunday briefing (Opus already does it manually)
- Per-recipient personalization (different content per recipient)

## 17. References — existing files to read before implementing

| File | Why |
|---|---|
| `lib/digest/send-digest.ts` | Race-condition guards (snapshot-before-await, skipMarkerUpdate). Mirror these in `send-evening.ts`. |
| `lib/digest/daily-digest.ts` | `formatTriggeredAlertsSection`, `getRecentArticles` consumer. Adaptive-layout switch goes here. |
| `lib/digest/group-by-company.ts` | `bucketByCompany` — input pre-pass for synthesis. Already-built. |
| `lib/digest/send-earnings-email.ts` | `stripModelPreamble`, `briefingToHtml` integration patterns, web_search disabling pattern, `composeEarningsEmail` extraction (the 2026-05-05 generate-recap-now refactor) — synthesis composer should follow the same extraction discipline. |
| `lib/email.ts::sendEmail` | Where new headers go. Resend SMTP integration. |
| `workers/cron/src/index.ts` | `runJob`, `parseJobFromClock`, marker-dance pattern. Extend for evening. |
| `workers/cron/src/fallback-digest.ts` | Pattern for the Worker fallback path. Mirror in `fallback-evening.ts`. |
| `workers/cron/src/yahoo.ts` | Last-N closes API (used for reaction snapshots). Reuse for live prices in fallback. |
| `scripts/snapshot-state-to-r2.ts` | Existing snapshot writer. Bump schemaVersion 3. |
| `lib/queries/research.ts::getRecentArticles` | Article query already used by digest path. |
| `lib/compute/factors.ts` | Existing OLS regression vs SPY for factor analysis. Reuse for nightly beta refresh. |
| `app/dashboard/components/SettingsModal.tsx` | UI section pattern (existing earnings settings precedent). |
| `electron/settings-store.ts` | Four-touch pattern (AppSettings, bootstrap, sanitize, env pass-through). |

## 18. Decisions log (verbatim user inputs that shaped the spec)

| Decision | User input |
|---|---|
| Primary purpose | "Mostly number four [afternoon news + alerts]... capture the emails that I get after 8:45 am, all the way through to TMT breakouts end of day recap, which usually comes in 5-6:00. It's almost never later than 7." |
| No P&L | "I don't want my holdings P&L... it's also going out to my brother." |
| Anomaly threshold | "Vanguard only, 2x beta" |
| Improvement scope | "Deliverability hardening, Cross-source synthesis (morning digest)" |
| Fallback | "Yes, full fallback" |
| Recipients | "You decide — expose a UI toggle" |
| Approach | "B — Synthesis everywhere (Recommended)" |
