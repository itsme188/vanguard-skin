# Late periodic report (10-Q / 10-K filed after the print night) — design

Status: BUILT (branch `late-periodic-10q`, 2026-11-01). Owner rulings of
2026-10-29 applied. As built, the late filing is NOT a new role: the owner
approved schema (migration 100) adds `filing_summary_filings.arrival`
(`evening` default, `late`) and stores the late report as role `companion`,
arrival `late`, plus a `filing_summary_late_watch` table (one row per print:
watching / found / ended / cancelled, `window_ends_at`, `last_polled_at`).
Item 3 below ("new role `late_periodic`") is superseded by that shape. Foreign
filers' 6-K interim reports are left out (not reliably identifiable). The
built behaviour is documented in `docs/reference/earnings-pipeline.md`
§Filing summary, "Late periodic report".

Correction after a live check (2026-11-01): item 2's "after 21:00 on the
event date" is dropped. A report counts when its header acceptance is after
the earnings filing's and the event does not already hold it as a
non-rejected evening filing: SEC's submissions list can lag acceptance, and
Alphabet's 10-Q (accepted 20:29 on 2026-10-28) was not listed at the 21:00
catch-up.

## Problem

The armed-print filing summary (`lib/filing-summary/`, 2026-10-22) reads the
earnings 8-K plus every allow-listed companion filed the same evening, up to
21:00 Eastern (R11). It then sets `past_cutoff`, and a filing accepted on a
later day is ignored entirely ("a header day other than the event date is
ignored").

Some issuers file the quarterly report the next morning. Alphabet (2026-10-28
print) did: the release and the call pointed at items that only the 10-Q
detailed, and the summary never saw the 10-Q. Microsoft filed its 10-Q at
16:07 the same day, so its summary included it.

## Owner rulings already given

- **In-app only (2026-10-29).** No email, no debrief section and no push
  for the late report.

## Proposed design

1. **A second, narrow watch window per armed print: the late periodic
   report.** After `past_cutoff`, keep checking the issuer's EDGAR submissions
   for a 10-Q or 10-K (and a foreign filer's 6-K carrying the interim report).
   The window ends at **16:00 Eastern on the next trading day after the event
   date**. Cadence: once every 10 minutes from 06:00 to 16:00 that day (one
   submissions request each; the existing header cache and prefilter apply).
   Default chosen to cover "early the next morning" without polling for days;
   reversible.
2. **What counts.** The first 10-Q / 10-K whose header `<ACCEPTANCE-DATETIME>`
   is after the earnings filing's, from the same CIK, for the same fiscal
   period (period of report matches the print's quarter end). A 10-Q filed
   on the evening of the event date is already a companion today; this
   window only adds filings accepted after 21:00 on the event date or on the
   next trading day.
3. **Stored as its own role, not as a companion.** New role `late_periodic`
   on `filing_summary_filings` (a migration, shown to the owner first). The
   evening summary is never re-run or edited: its claims stay as published.
4. **Read as a follow-up section.** One extra run over the late filing only,
   with the same per-print choice of model family and effort and the same
   hard rules (R1 typed figures, R9 established operands, "Checked" means
   found in the cited line). The prompt gets the evening summary's claims as
   context and is asked for **what the 10-Q adds or changes**: items the
   release or call referred to, segment or line items not in the release,
   changes to figures, new risk or legal items. Not a second summary of the
   quarter.
5. **Where it shows.** On the print's filings page
   (`app/dashboard/print/[eventId]/filings/`) as a separate block headed with
   the form, the acceptance time and the words "filed after the print". The
   Hub row's filing-summary chip gains a small "10-Q added" marker while the
   block is unread. Every owner-facing word goes in
   `lib/filing-summary/labels.ts`.
6. **No email, no push, no Worker.** Mac-only like the rest of the filing
   summary; no snapshot field.
7. **AI outage.** The late run follows the 2026-10-29 rule: an account-level
   failure never spends an attempt.

## Open questions (my defaults in brackets; reversible)

- Window end [16:00 Eastern next trading day]. A filer that takes longer
  (rare for large caps) would need a manual "Look again" button; [build the
  button too, since it is cheap].
- 10-K for a fiscal-year-end print [yes, same rule].
- Amended filings (10-Q/A) [ignored].

## Tests to require

- A 10-Q accepted at 21:05 on the event date and one at 07:30 the next
  trading day are both picked up; one at 16:01 the next day is not.
- A 10-Q from another CIK or for another period is ignored.
- The evening summary's stored claims are byte-identical before and after
  the late run.
- The late section obeys R1 and R9 (reuse the existing section tests).
- No email composer, push sender or Worker file reads the new role.
