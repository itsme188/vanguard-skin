# Private Markets Desk — Part 1 Discovery Notes

**Status:** Brainstorming; no schema, UI, inbox, or ingestion implementation has started.

## Purpose

Portfolio Desk should grow into a private-markets workspace alongside its public-market dashboard and Research Desk. It needs to track private funds, AngelList SPVs, SAFEs, and direct/private-company positions, while preserving the legal/economic record and creating a dependable monthly research and review habit.

Initial examples discussed: Tiger Global PIP 11, Lead Edge Capital Fund 5, Essence VC Fund 2, AngelList vehicles including a DefenseTech/HardTech VC fund, two Base Power SPVs through Packy McCormick, and a Plutus SAFE.

## Product model agreed so far

### Vehicle is the record of ownership; company is the record of research

- The primary organizing and accounting unit is an **investment vehicle**: fund, SPV, SAFE, or direct position. It owns the commitment, cash-flow ledger, ownership documents, and terms.
- An **underlying company** is a shared research entity. It can be linked to multiple vehicles without merging those legal positions (for example, distinct Base Power rounds remain distinct SPVs).
- The user will provide portfolio-company holdings for funds. Those companies receive the same monthly company-news research as direct investments.
- Fund look-through never becomes an assumed legal/economic allocation without a source.

### Navigation

- Private Markets should be a new top-level tab.
- Its left rail combines workflow views—Overview, Monthly Review, Capital Calls, Documents & Private Inbox, Companies—with vehicles grouped by **manager/platform**, not by legal type.
- Active vehicles appear in the primary rail. Exited, fully distributed, or inactive investments live in a collapsed, searchable Historical group.
- A vehicle page will eventually contain Overview, Cash Flows, Ownership & Documents, Portfolio Companies, and Timeline.

## Capital-call and accounting model

- Track total commitment, funded/called capital, uncalled commitment, manually set liquidity-reserve target, announced calls, payments, distributions, fees/expenses, exit/redemption proceeds, adjustments, and relevant tax cash movements.
- A proposed capital call extracted from a notice moves through a clear lifecycle: **upcoming/announced → paid**, with withdrawn/superseded handling when necessary. The original email/document remains attached.
- The purpose is liquidity preparedness: surface known calls and manual reserve targets; do not apply a generic reserve percentage.
- **Do not track or connect bank balances.** Calls are paid from the user's bank account, outside Portfolio Desk.
- Treasuries may be a designated read-only backstop for calls. They are not a public-portfolio cash-coverage calculation or an assumed source of funds.
- Calculate private-investment metrics from the ledger and latest official marks: paid-in capital, distributions, DPI, and TVPI/MOIC. XIRR is deferred until cash-flow history is sufficiently complete.
- Store manager-reported DPI/TVPI next to Portfolio Desk's calculated values, with date and source; legitimate differences must be explainable rather than hidden.

### Value and distribution rules

- Maintain two explicitly separate values:
  1. **Official vehicle mark** — the manager/SPV/company-reported dollar value for the user's position, dated and source-linked.
  2. **External benchmark** — a publicly reported company valuation (for example, a financing-round post-money), also dated and source-linked. It is context, never an implied mark on the user's position.
- Example: Essence VC Fund 2 still holds an acquired-company position now represented by Databricks shares. Higher public Databricks benchmarks inform the fund look-through/TVPI story but do **not** increase DPI until value is actually distributed to LPs.
- Support both cash and in-kind distributions. An in-kind event records the security, units, date, and manager-reported fair value at distribution.
- A distributed security remains permanently visible in the Private Markets Desk as part of its originating fund's history. It has its own custody location; if later transferred into a tracked public account, it may be linked to that account as well without losing its private-market origin or being double-counted.

## Ownership and documents

- Preserve signed ownership, subscription, tax, and other source documents.
- When source material supports it, capture structured terms: units/shares, ownership percentage, price, round, effective date, and SAFE-specific terms such as principal, cap, discount, MFN, and conversion state.
- Data is source-backed and versioned: conversions, new rounds, or corrections add history rather than overwrite prior ownership facts.
- Storage policy remains open. The desired direction is to retain the document in Portfolio Desk, but it must also retain classification/provenance and a link to the original email. The ultimate archival/back-end policy has not been decided.

## `privates@myportfoliodesk.com` intake

- A dedicated private-markets address will accept forwarded emails and attachments.
- It should classify and suggest links to vehicles/companies and categories such as capital call, tax document, ownership document, investor update, company news/research, or other.
- **Auto-file:** clear, low-risk company news to the linked company's research timeline.
- **Require user review:** financial/legal documents, capital calls, investor updates, and ambiguous material. Review approves or corrects classification/linking before it affects the ledger or permanent filing.
- The original source remains attached even for automatically filed material.

## Monthly research and review

- Perform a web search once per month for each direct/private company and fund portfolio company, focusing on material fundraising, product/company developments, partnerships/customers, leadership changes, regulatory developments, and adverse signals—not generic press.
- Combine fresh web findings with newly received investor updates, documents, and capital calls into a monthly Private Markets Update Brief.
- Deliver it both as a fixed-schedule email and as a durable, fully detailed in-app review. Default timing: **first business day of the month, morning**.
- Private-markets briefings are single-owner communications and may include dollar amounts and other private-investment figures. This is intentionally distinct from the shared/public-market email privacy policy; the feature must enforce the restricted-recipient boundary.
- The in-app review retains source links, the ability to mark a vehicle reviewed, and an auditable history of what was new in each cycle.

## Onboarding direction

- The user intends to backfill as much history as possible from existing records and may provide access to folders containing documents.
- Initial import should be a **read-only discovery pass**: identify likely vehicles, companies, commitments, calls, distributions, ownership terms, and documents; create source-linked proposals with confidence; require user approval before creating accounting records.
- The register can then continue to grow through the private inbox and manual additions.

## Part 2 decisions

### Review workspace and research

- The Private Markets Overview is a **monthly-review and intelligence workspace**, not a capital-call dashboard. Capital calls remain an exception-oriented workflow and surface prominently only when action is needed.
- Each review has two distinct views of new material:
  1. **Vehicle updates**, grouped as manager/platform → vehicle, for official manager material, marks, capital calls, documents, and accounting events.
  2. **Company developments**, a single chronological feed in which a company appears once even when it is held through several vehicles. Each item links to that company record, which shows its linked vehicles as “held through.”
- The monthly brief must list every genuine update; it should not manufacture “quiet” entries for companies or vehicles without news. It is still sent as an all-clear email when there are no genuine updates.
- Send the private-markets review email only to the owner, on a fixed schedule: **first business day of each month at 8:00 AM Eastern**. Dollar amounts may appear in this private email.
- On a company record, direct/SPV exposure rows remain distinct by vehicle/round, with a separately labeled combined total. Do not include an unquantified fund look-through in that total. The company summary should cover invested capital, latest official value, and TVPI/MOIC where supported.

### Flexible vehicle coverage

- The desk should support every investment structure at least at a skeletal level: closed-end funds, SPVs, SAFEs, direct positions, open-ended and side-pocket funds, real-estate/operating LLCs, and historical/exited vehicles.
- Every vehicle gets a common core: manager/platform, legal entity, type, status, source documents, cash ledger, official marks, and review history.
- Type-specific modules add only relevant facts: commitments and calls for closed-end funds; NAV, side pockets, subscriptions, withdrawals, and redemptions for open-ended funds; terms and conversion events for SAFEs; basic documents and ledger support for real estate/operating entities.
- Each vehicle can be assigned a research target of manager, underlying asset/company/property, both, or none.

### Backfill, statements, and sources

- Initial backfill is staged **manager by manager**. A read-only discovery pass creates source-linked proposals for vehicles, documents, companies, marks, and ledger events; the user approves a coherent group before it affects the accounting record.
- Ambiguous or conflicting material remains in **Needs review** and must not create a ledger entry or official mark.
- Statement ingestion should compare consecutive statements automatically. Financial events use the statement-period end as their effective date, while receipt/upload time is retained separately. Proposed changes still require review before becoming official.
- A single source can produce more than one logical event—for example a distribution plus a tax estimate, or cash plus an in-kind stock distribution.
- The supplied private-record archive demonstrates that ingestion must handle PDFs, DOCX files, images/screenshots, ZIP archives, and CSV exports, including tax records, statements, calls/distributions/redemptions, manager updates, agreements, and ownership instruments.

### Thesis and inbound email safeguards

- Begin with one editable **Your thesis** note per vehicle, optionally linked to an underlying company. Preserve a manager's stated thesis/rationale as a source document rather than blending it with the user's view. Separate company and entry/round thesis fields can be added later if the notes demand it.
- `privates@` accepts material forwarded from user-owned approved addresses and from an editable Trusted Senders address book. New direct senders enter a sender-approval queue rather than being rejected outright.
- Even trusted financial/legal material, capital calls, and investor updates require review. Clear low-risk company news may auto-file to the linked company timeline.

### Maaser workspace

- Add a dedicated **Maaser** workspace as well as a per-vehicle view. Each investment vehicle/deal is calculated independently.
- Apply a fixed rule: no maaser is due until the deal has recovered **all cash paid in**, including investment calls, management fees, and expenses. Thereafter, 10% of each further actual cash or in-kind distribution is due as maaser.
- Only actual distributions count; marks, NAV, tax estimates, and paper gains do not. A recycling distribution recovers principal, and a later recalled amount becomes new unrecovered principal.
- For an in-kind distribution, use the manager-stated fair value on the distribution date. If that is unavailable for a public security, propose the public close for review; unpriced/private assets require confirmation.
- The app stops at the calculated deal-level maaser amount. Charity recipients, payments, and funding decisions are intentionally outside this feature.

## Resume point

The Part 2 discovery decisions are captured above. Next, turn them into a reviewed product specification: a proposed data model and source-of-truth rules, followed by a scoped implementation plan and migration proposal before code changes.
