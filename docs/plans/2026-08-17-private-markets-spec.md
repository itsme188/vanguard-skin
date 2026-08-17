# Private Markets Desk — Product and Data Specification

**Status:** Reviewed discovery decisions turned into a proposed implementation blueprint. This document does not authorize a migration or feature build by itself.

**Companion:** [Part 1 and Part 2 discovery record](2026-08-14-private-markets-part-1.md)

## Outcome

Portfolio Desk gains a private-markets workspace that is deliberately separate from public brokerage accounting. It records the legal investment vehicle, its source-backed cash and ownership history, its manager/company research, and its monthly review cycle. It gives the user timely visibility into calls, marks, distributions, and maaser without pretending that a bank account or an external company valuation is an account balance.

The initial product is owner-only. Its emails are never resolved through the recipient rules for shared public-market briefings.

## Domain boundaries

| Domain | Owns | Does not own |
| --- | --- | --- |
| Private vehicle | Legal/economic position, commitment, cash ledger, official mark, documents, thesis, call status | A public brokerage position or an estimated fund look-through value |
| Company | Shared research identity, external news, published valuation benchmarks, links to held-through vehicles | Legal ownership or a calculated value for a fund's indirect stake |
| Manager/platform | Grouping, source relationship, and navigation | A merged economic position across its vehicles |
| Public account | Tradable position after an in-kind distribution is received/transferred there | The source fund's historical distribution story |
| Maaser projection | Per-deal principal recovery and fixed 10% due on eligible profit | Charity recipient, payment, or funding workflow |

The core relationship is:

```text
manager / platform
       └─ vehicle (fund, SPV, SAFE, direct deal, etc.)
              ├─ ledger events, calls, marks, terms, documents, thesis
              └─ company links (one SPV may have one; a fund many)

company
       └─ research events and external valuation benchmarks
              └─ shown once, linked back to every vehicle that holds it
```

## Source-of-truth rules

1. A source document/email/web URL is evidence; structured fields are interpretations of it. Every non-manual fact must retain its source link.
2. No extracted event, mark, or ownership term becomes authoritative until the user approves it. Manual entries are explicitly marked manual.
3. Ledger events and marks are append-only corrections: amend/supersede rather than silently overwrite. Queries select the currently effective record while the old record remains auditable.
4. A statement's period end is the effective date for its financial facts; document receipt/upload time is separate provenance.
5. Values have separate namespaces:
   - an **official vehicle mark** changes only from a manager/SPV/company source;
   - an **external benchmark** is company research only and never recalculates a vehicle mark;
   - a cash or in-kind **distribution** is a ledger event and can affect DPI, principal recovery, and maaser.
6. Recompute calculated DPI/TVPI/MOIC and maaser from effective ledger events and latest official mark. Do not store a mutable total as the authority.
7. Private cash is never reconciled against public-account cash. Treasuries can be a read-only, user-designated reference backstop only.

## Proposed schema

The first migration should be a new, isolated private-markets namespace (proposed `082_private_markets_core.sql`; renumber against the then-current migration tail). It must not alter public `transactions`, `holdings`, `research_documents`, or `research_articles`.

### Identity and ownership graph

| Table | Key columns | Purpose |
| --- | --- | --- |
| `private_managers` | `id`, `name`, `kind` (`manager`, `platform`, `issuer`, `other`), `website`, `is_active` | Navigation and intake grouping. AngelList is a platform with distinct vehicles underneath it. |
| `private_companies` | `id`, `name`, `legal_name`, `website`, `status`, `notes` | One shared research identity per company/property/asset where appropriate. |
| `private_vehicles` | `id`, `manager_id`, `display_name`, `legal_name`, `vehicle_type`, `status`, `currency`, `inception_date`, `research_target`, `your_thesis`, `created_at`, `archived_at` | Legal/economic unit. `vehicle_type` initially: `closed_end_fund`, `spv`, `safe`, `direct`, `open_end_fund`, `real_estate_or_operating`, `other`. `research_target`: `manager`, `underlying`, `both`, `none`. |
| `private_vehicle_companies` | `vehicle_id`, `company_id`, `relationship` (`direct`, `portfolio`, `acquired_underlying`, `other`), `effective_date`, `ended_date` | Links a fund to many portfolio companies and an SPV to one company without merging vehicles. |
| `private_terms_versions` | `id`, `vehicle_id`, `effective_date`, `terms_kind`, `terms_json`, `source_document_id`, `supersedes_id` | Versioned source-backed terms: subscription/round/ownership/SAFE/conversion. JSON is a flexible extraction payload, not a substitute for the original document. |
| `private_public_position_links` | `id`, `vehicle_id`, `in_kind_event_id`, `account_id`, `security_id`, `linked_at` | Optional later link for an in-kind security that reaches a tracked public account. It prevents narrative disconnection; it does not make the private ledger part of public account accounting. |

`private_vehicles` carries only stable identity and workflow state. Commitment, paid-in capital, distributions, and value are never copied into mutable summary columns.

### Documents and provenance

| Table | Key columns | Purpose |
| --- | --- | --- |
| `private_documents` | `id`, `title`, `filename`, `mime_type`, `file_size_bytes`, `sha256`, `document_type`, `source_kind`, `source_uri`, `storage_key`, `received_at`, `effective_date`, `raw_text`, `processing_state`, `created_at` | Immutable metadata and extracted text for private material. `source_kind` is `upload`, `email`, `web`, or `manual`; the hash deduplicates retained file copies. |
| `private_document_vehicle_links` | `document_id`, `vehicle_id`, `role` | A document may support several vehicles; roles include ownership, statement, capital call, tax, manager update, and other. |
| `private_document_company_links` | `document_id`, `company_id`, `role` | Allows an investor update or press item to be sourced on a company timeline as well as vehicle history. |
| `private_document_event_links` | `document_id`, `ledger_event_id`, `mark_id`, `call_id`, or `company_event_id` | Explicit evidence links for financial/research facts. Use separate nullable foreign-key columns with a CHECK that exactly one target is set, rather than a polymorphic, unenforceable target. |

`storage_key` remains nullable in the initial migration. Before document bytes are copied into the app archive, make and document the retention decision: local app-managed archive, source-only links, or a hybrid. The metadata, source URI, extracted text, hash, and approval trail work under any of those choices.

### Accounting, calls, marks, and benchmarks

| Table | Key columns | Purpose |
| --- | --- | --- |
| `private_ledger_events` | `id`, `vehicle_id`, `event_type`, `direction`, `effective_date`, `amount`, `currency`, `description`, `source_group_key`, `status`, `supersedes_id`, `approved_at` | Append-only cash/position ledger. Amount is always a positive native-currency magnitude; `direction` is `outflow` or `inflow`. |
| `private_in_kind_distributions` | `ledger_event_id`, `security_id`, `security_description`, `units`, `fair_value`, `fair_value_currency`, `valuation_basis`, `valuation_date`, `confirmation_status` | Extension for an in-kind ledger event. `valuation_basis`: `manager_stated`, `public_close_proposed`, or `confirmed_private_value`. |
| `private_capital_calls` | `id`, `vehicle_id`, `announced_date`, `due_date`, `amount`, `currency`, `status`, `payment_event_id`, `supersedes_id` | Call lifecycle: `announced`, `paid`, `withdrawn`, `superseded`. A paid call links to its ledger outflow; it never implies a connected bank balance. |
| `private_commitment_snapshots` | `id`, `vehicle_id`, `as_of_date`, `commitment`, `called_to_date`, `remaining_commitment`, `distributed_to_date`, `currency`, `source_document_id` | Manager-reported totals for reconciliation and dashboard context. The ledger remains the calculated accounting record. |
| `private_vehicle_marks` | `id`, `vehicle_id`, `as_of_date`, `value`, `currency`, `mark_kind`, `source_document_id`, `supersedes_id` | Dated official manager/SPV/company value. `mark_kind` starts as `manager_reported` or `company_reported`. |
| `private_reported_metrics` | `id`, `vehicle_id`, `as_of_date`, `metric`, `value`, `source_document_id` | Manager-reported DPI/TVPI/IRR/PIC/distributions kept next to calculated metrics, never overwritten. |
| `private_company_benchmarks` | `id`, `company_id`, `as_of_date`, `benchmark_type`, `value`, `currency`, `source_url`, `source_document_id`, `notes` | Public financing valuations and other externally published context. A benchmark cannot reference a vehicle or feed a vehicle-value calculation. |

Initial allowed ledger event types:

```text
contribution | capital_call | management_fee | expense | cash_distribution |
in_kind_distribution | redemption | tax_cash | correction
```

The model intentionally permits a single document to create several ledger events through a shared `source_group_key` and multiple document-event links. A call notice may produce a capital-call amount and a separate fee outflow; a distribution notice may produce cash and in-kind events plus an informational tax estimate.

### Research, reviews, and email

| Table | Key columns | Purpose |
| --- | --- | --- |
| `private_company_events` | `id`, `company_id`, `event_type`, `effective_date`, `title`, `summary`, `source_url`, `source_document_id`, `discovered_at` | Material company/asset research events. They form the once-per-company chronological feed. |
| `private_review_cycles` | `id`, `period_start`, `period_end`, `scheduled_for`, `status`, `generated_at`, `reviewed_at` | One durable monthly review record. |
| `private_review_items` | `id`, `cycle_id`, `item_type`, `vehicle_id`, `company_id`, `document_id`, `ledger_event_id`, `company_event_id`, `disposition` | Each genuine update rendered in the review/email, with its source and user review state. No rows are created merely to say there was no update. |
| `private_review_deliveries` | `cycle_id`, `recipient`, `sent_at`, `status`, `error` | Owner-only audit of the first-business-day 8:00 AM ET email. Recipient is set from a dedicated private setting, not the public email-recipient helper. |

### Inbox and initial backfill

| Table | Key columns | Purpose |
| --- | --- | --- |
| `private_trusted_senders` | `id`, `email`, `label`, `kind`, `is_active`, `created_at` | Editable whitelist: the user's forwarding addresses and approved direct sources. |
| `private_inbox_messages` | `id`, `provider_message_id`, `from_addr`, `subject`, `received_at`, `sender_status`, `processing_status`, `original_source_uri`, `error` | Deduplicated private inbox ingestion. Unknown direct senders are queued for approval, not silently rejected. |
| `private_inbox_attachments` | `id`, `message_id`, `document_id`, `filename`, `mime_type`, `sha256` | Retains attachment-level provenance and permits one message to produce several documents. |
| `private_backfill_runs` | `id`, `source_label`, `started_at`, `completed_at`, `status` | Read-only source-folder discovery run. |
| `private_backfill_groups` | `id`, `run_id`, `manager_id`, `label`, `status`, `approved_at` | Manager/platform-sized approval unit, such as AngelList or Lead Edge. |
| `private_proposals` | `id`, `group_id`, `proposal_type`, `payload_json`, `confidence`, `source_document_id`, `status`, `review_note`, `approved_at` | Staged proposals for manager, vehicle, company, document link, term, mark, call, ledger event, or company event. Only approval applies the corresponding mutation. |

No accounting action is triggered directly from an inbox message, automated extraction, or backfill scan.

## Calculations

### Vehicle performance

For a vehicle in one reporting currency:

- **Paid-in capital (PIC):** effective outflows of `contribution`, `capital_call`, `management_fee`, and `expense`.
- **Distributions:** effective inflows of `cash_distribution`, `in_kind_distribution` (fair value), and `redemption`.
- **DPI:** distributions ÷ PIC.
- **TVPI/MOIC:** (distributions + latest official mark) ÷ PIC.
- **XIRR:** deferred until the user has reviewed enough complete dated history; use the same ledger cash flows, with in-kind distributions treated at their confirmed distribution-date fair value.

Show manager-reported values side-by-side with calculated values and the respective as-of dates. A discrepancy is a reconciliation cue, not a reason to overwrite either value.

### Maaser

Maaser is a pure projection over each vehicle's effective ledger order. It is never a manual adjustment workflow.

1. Start each deal's unrecovered principal at zero.
2. Add all effective paid-in outflows: contributions/calls, management fees, and expenses.
3. For each eligible actual distribution, apply its value first against unrecovered principal.
4. Once unrecovered principal reaches zero, 10% of every remaining part of that distribution is due as maaser.
5. Later called capital increases unrecovered principal again, even if an earlier recycling distribution restored commitment capacity.

Eligible distributions are cash, redemptions, and confirmed in-kind distributions. Official marks, NAV changes, published valuations, and tax estimates are excluded. The query should return a per-event breakdown so the Maaser workspace can explain why an amount is or is not due.

## Workflow specifications

### Manual entry

The first product slice must let the user manually create a manager, vehicle, company link, document metadata/source link, cash event, call, official mark, or thesis. Every create/edit screen must show effective date, source, and whether the fact is manual or approved from a proposal.

### Capital-call flow

1. A notice produces a proposed `private_capital_calls` row and any distinct proposed fee/expense events.
2. User approves it as **announced**; it appears in the Capital Calls workspace with due date and amount.
3. Once paid from the bank, the user records/approves the matching ledger outflow and moves the call to **paid**.
4. A withdrawn/superseded notice closes the old call without deleting it.

### Statement comparison

For a vehicle with a prior approved statement, extraction produces a field-by-field delta: commitment totals, official mark, manager metrics, new calls/distributions/redemptions, and side-pocket/NAV facts. It must identify the previous statement, show both as-of dates, and stage only newly supported proposals. It never infers a cash flow merely from a mark change.

### Document/intake routing

1. Deduplicate the original message and each attachment by provider id/hash.
2. Determine sender status from `private_trusted_senders`.
3. Create documents and extraction proposals with source links.
4. Auto-file only clear, low-risk company-news items to a linked company timeline.
5. Require review for financial/legal documents, investor updates, capital calls, ambiguous items, and unknown senders.

### Monthly review

On the first business day at 8:00 AM ET:

1. Gather approved vehicle facts received/effective since the last review and newly discovered material company events.
2. Group vehicle facts manager/platform → vehicle.
3. Render company events once each in reverse chronological order with company links and held-through vehicles.
4. Persist each rendered update as a `private_review_item`, send the owner-only email, and retain the in-app cycle.
5. Send an all-clear email if no genuine items exist.

The web-research runner must keep source URLs, publication/effective dates, and discovery time. Build it only after selecting and verifying the search provider; it must not scrape or invent updates from an LLM alone.

## Delivery plan

### Phase 1 — core registry and manual records

- Add the isolated migration for manager/company/vehicle links, documents metadata, terms versions, ledger events, calls, marks, and benchmarks.
- Build query/mutation modules with dependency injection, transaction boundaries, source-backed validation, and a small manual-entry surface.
- Add the Private Markets tab and manager/platform navigation with active and historical vehicles.
- Deliver vehicle pages with Overview, Cash Flows, Ownership & Documents, Portfolio Companies, Timeline, and Your thesis.

**Exit criterion:** a manually entered fund, SPV, SAFE, direct deal, and exited vehicle can be represented without touching public-account tables.

### Phase 2 — calculations and operational views

- Implement PIC, distributions, DPI, TVPI/MOIC, and comparison to manager-reported metrics.
- Implement Capital Calls and the read-only Treasury-backstop reference.
- Implement Maaser as the fully explained derived projection, including in-kind valuation confirmation.
- Add in-kind distribution history and the optional future link to a public account/security.

**Exit criterion:** every figure displayed on the Capital Calls, vehicle-performance, and Maaser views is traceable to effective ledger rows and a source.

### Phase 3 — documents and staged backfill

- Implement source-folder discovery for the supported file types, with document hashes and extraction proposals.
- Implement group-by-manager Backfill Review, approval, rejection, and Needs review states.
- Add statement-to-statement delta staging.

**Exit criterion:** a full manager group can be discovered read-only, reviewed, approved, and re-run idempotently without duplicate facts.

### Phase 4 — private inbox

- Add trusted-sender management, inbox/message/attachment persistence, sender approval, and classification proposals.
- Reuse safe attachment extraction utilities where compatible, but keep private inbox records and permissions separate from public Research Desk ingestion.
- Add the document retention adapter only after the archive-policy decision is made.

**Exit criterion:** an approved sender can forward a capital-call or update whose proposed facts remain review-gated; a clear news item can safely auto-file to a company record.

### Phase 5 — monthly research and private briefing

- Select and validate a web-search provider and source-quality policy.
- Implement the company-event research runner, monthly cycle generation, private email delivery/audit, and in-app review.
- Add a scheduled first-business-day 8:00 AM ET job with catch-up/idempotency safeguards consistent with the existing Mac-first/Worker-fallback model.

**Exit criterion:** a review cycle lists each real vehicle update and each company update once, sends only to the owner, and can be audited from its saved items and sources.

## Required test coverage

- Schema constraints, ownership graph links, source/dedup keys, and proposal approval atomicity.
- Ledger corrections/supersession, multiple events from one source, and manager-reported versus calculated metric differences.
- Fund versus SPV exposure: two Base Power-style SPVs remain separate while company research is shared; fund look-through is never summed into direct exposure.
- Maaser cases: no principal recovery, exact recovery, profit after recovery, fees/expenses included in principal, recycling then recall, cash + in-kind distribution, unpriced private in-kind confirmation, and excluded marks/tax estimates.
- Capital-call lifecycle: announced, paid, withdrawn, superseded, and separate fee component.
- Statement delta: a new mark alone creates no cash event; a distribution plus tax estimate creates distinct proposed events.
- Inbox sender trust/approval, attachment deduplication, review gate, and low-risk company-news auto-file boundary.
- Monthly cycle all-clear send, one-company-once rendering, private-recipient enforcement, catch-up idempotency, and source URL retention.

## Decisions still required before the affected phase

1. **Document archive policy:** app-managed local copy, source-only pointers, or hybrid; and where any local/private document bytes are encrypted/backed up.
2. **Monthly search provider:** choose a supported service and define source-quality/cost/rate-limit policy before automation.
3. **Treasury backstop UI:** select which public Treasury holdings are shown as a reference and how the user labels that relationship. It remains informational.
4. **Currency handling:** confirm whether the initial private ledger must convert non-USD vehicles or should show each vehicle in native currency until an FX policy is designed.

## Non-goals for the initial release

- Bank connections, automatic cash coverage calculations, or payment initiation.
- Inferring fund ownership/value from public company valuations.
- General partnership/K-1 tax preparation or tax advice.
- Charity recipient/payment tracking beyond the deal-level maaser calculation.
- Automatic accounting mutation from email, OCR, backfill, or statement extraction.
- Combining private positions with public brokerage performance metrics.
