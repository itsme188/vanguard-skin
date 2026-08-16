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

## Deferred decisions for Part 2

1. Whether investment theses should naturally separate into company thesis and vehicle/round thesis, or begin as flexible notes only.
2. Final document-retention policy (stored copy vs source-email indexing/links, or a hybrid).
3. How Treasury backstop holdings are designated and presented.
4. The visual priority of the Private Markets Overview: capital-call preparedness versus monthly-review updates.
5. Exact first-business-day email time and recipient safeguards.
6. Detailed schema, source-of-truth/reconciliation rules, initial-screen wireframes, email-routing implementation, document security, and backfill execution plan.

## Resume point

Resume Part 2 by choosing the default Private Markets Overview priority, then turn these decisions into a reviewed product spec and implementation plan before code or migrations.
