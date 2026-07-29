# Earnings Email Archive — Design

**Date:** 2026-07-28
**Status:** Approved (user, in-session)
**QA findings:** `earnings-emails--unreachable-after-week-rollover` (DECIDED: both options — archive list + per-symbol section)

## Problem

88 of 89 sent earnings emails are unreachable in-app: the EarningsHub /
CalendarView chips only cover the currently-rendered week, so once the week
rolls over, a sent preview/recap has no read path. The viewer
(`<EarningsEmailViewer>` + `GET /api/earnings/email-content`) already rebuilds
any email deterministically — only the navigation to it is missing.

## Decisions (user, 2026-07-28)

1. **Placement:** new **"Emails" tab** on `/dashboard/alerts` (precedent:
   Conflicts tab) + an "All sent →" link from the Today EarningsHub header.
2. **List shape:** flat reverse-chronological with a symbol filter box.
3. **Security Detail:** compact per-symbol section, family-aware, rendered
   **only when ≥1 sent email exists** for the issuer family.

## Components

### Query — `lib/queries/earnings-emails.ts::getSentEarningsEmails`

`getSentEarningsEmails(db, { symbol?, limit? })` → rows joined
`earnings_emails × calendar_events`:

```
{ event_id, phase, symbol, event_date, sent_at, sent_by_cloud }
```

- Sorted `sent_at DESC` (index `idx_earnings_emails_sent_at` exists).
- **Excludes `error = 'in_progress'`** (tri-state convention — every new
  reader must exclude live claims). `error = 'sent-by-cloud'` rows are
  included with `sent_by_cloud: 1` — the viewer shows its "no local copy"
  state and the deterministic scoreboard still renders.
- `symbol` filter is **family-aware** via `issuerSiblings()` (GOOG page finds
  GOOGL emails) and matches `calendar_events.symbol`.
- `limit` defaults generous (500) — ~90 rows today, ~30/quarter growth.

### API — `GET /api/earnings/emails?symbol=&limit=`

In-app (no cron auth), `{ success, count, emails }` envelope — mirrors
`/api/earnings/conflicts` list mode. Serves the client-side alerts tab.
Security Detail does NOT use it (server component queries directly).

### Alerts "Emails" tab

- `filter` union gains `"emails"` (`?view=emails`).
- Fetches from the API **when the tab activates** (not on every alerts visit);
  count shown on the tab chip from the same response.
- Row: `SymbolLink` + phase `Chip` (preview gold / recap info) + event date +
  sent time formatted with `timeZone: "America/New_York"` + muted "cloud"
  chip when `sent_by_cloud`. Click opens `<EarningsEmailViewer>`.
- Symbol filter `<input>` above the list — client-side substring match on the
  loaded rows (no re-fetch; the full list is small).

### Security Detail section — `SecurityEarningsEmails`

New client component (name `EarningsEmailsSection` is taken by the Settings
panel). The security page (server) calls `getSentEarningsEmails` with the
security's symbol and passes rows down; the component renders a `Section`
with compact rows + the viewer, and the page skips it entirely when the list
is empty (matches Positions/Tax Lots conditional rendering).

### Discoverability

EarningsHub header gains a small "All sent →" link to
`/dashboard/alerts?view=emails`.

## Out of scope (noted interactions)

- **Privacy-mode masking of the viewer iframe** is its own DECIDED finding
  (`earnings-email-viewer--privacy-mode-leaks-share-count-account-return`);
  this archive adds read paths to the same iframe, raising that fix's value.
- Week navigation on Today (`today-week-ahead--no-week-navigation`) is a
  separate DECIDED item; this archive satisfies the email half only.

## Testing

- Query unit tests (in-memory): ordering, in-progress exclusion, cloud flag,
  family-aware symbol filter, limit.
- API contract test in `tests/contracts/api-component-contracts.test.ts`
  (client component fetches the new route).
- Browser E2E after build: tab renders rows, viewer opens from archive + from
  Security Detail, cloud row shows "no local copy".
