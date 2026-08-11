# Session Handoff — for Codex review

> Rolling file, overwritten at each `/session-end`. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-10 (late-evening session, ended past midnight 08-11)

## 1. Goal + files changed

Four QA-ledger/backlog tasks closed end-to-end, each root-caused against live data before any fix:

**(a) Earnings preview audit-row drag** (`a252a35`, `74533ab`):
- `lib/calendar/reconcile-earnings-dates.ts` — preview-phase `earnings_emails`/`earnings_email_skips` rows now repoint to the canonical event only when their send date plausibly covers that print date; recaps/bogeys unchanged.
- `scripts/repair-earnings-preview-audit.ts` (new) + `tests/scripts/repair-earnings-preview-audit.test.ts` (new), `tests/calendar/reconcile-earnings-dates.test.ts` (+5).

**(b) IBKR daily-valuation/risk-series collapses** (`2c41f4d`, `8f33163`):
- `lib/compute/daily-valuation.ts` — month-end cash anchors use a 5-day lookback instead of exact-date join (weekend month-ends silently skipped the anchor, leaving the following month on the Phase-1 cash placeholder).
- `scripts/backfill-prices-from-ohlcv.ts` (new, generic bars→prices insert-only backfill) + tests; `scripts/repair-split-basis-2024-year-end.ts` (new, guarded normalization of pre-split statement-basis rows) + tests.

**(c) Alerts approve-time insta-fire guard** (`2597bac`, `52a7444`, `a33b83e`):
- `lib/alerts/approve.ts` (new `approveLevelGuarded`), `lib/queries/security-levels.ts` (extracted `checkLevelTriggerState`, shared by scanner + guard), `lib/mutations/security-levels.ts`, `app/api/levels/review/route.ts` (409 `would_fire_immediately` + `force`), `app/dashboard/alerts/page.tsx` (per-card confirm, Approve-all partition/summary confirm, in-flight state, gold-ink contrast fix), `lib/db/migrations/077_level_armed_crossed_at.sql`, `lib/alerts/{detect,notify-pushover}.ts`, Worker parity: `workers/cron/src/{pushover,level-scan,state}.ts` + `scripts/snapshot-state-to-r2.ts`.

**(d) Stale-close residual repair** — no code; live-DB runs of the existing `repair-ah-closes.ts` after an ohlcv backfill (13 rows for one thinly-traded name).

Docs: `docs/plans/TODO.md` (reconciled ×3), `CLAUDE.md` (two new invariants: preview-repoint plausibility + guard/scanner single source; split-adjusted-bars basis rule).

## 2. Tests / E2E / deploy

- Full bare suite (Mac + Worker): **4,657 passed / 430 files** (baseline 4,633; +21 new, 0 removed).
- Three browser E2E passes on the live packaged app: Today earnings hub (post-repair state clean, zero console errors); alerts guard cancel-path twice (exactly one 409, no force PATCH, DB byte-identical after cancel, nothing armed/fired); Analysis risk metrics (all four series collapses gone, drawdown window now a real market event, TWR reconciliation banner still green at 0 bp).
- Live repairs applied with backups + idempotent re-runs: preview audit rows (3 repoints, 1 phantom event delete, 1 actuals backfill), price backfill (8,598 rows), split-basis normalization (6 rows), AH-close residuals (13 rows). Backups under `data/backups/pre-*-2026-08-10.db`.
- Deploys: Electron ×4 (final: installed + relaunched, exit 0, health check green); Cloudflare Worker ×1 (`wrangler deploy`, alert-copy parity).

## 3. Open concerns, rejected approaches, user decisions

- **The QA fixer's diagnosis was wrong on (a):** it blamed `correctEarningsEventDate`; zero suppression rows + surviving superseded events proved the mover was `reconcileEarningsDates`' unconditional child repointing. The same unconditional migration DOES exist in `correctEarningsEventDate` but needs a different design (its doomed rows are deleted, so "leave behind" would CASCADE-destroy archived prose) — follow-up filed in TODO, not built.
- **User corrections mattered twice:** the user corrected the fixer's claim about one upcoming print (it had already reported days earlier — the DB row was a phantom that got deleted), and approved deleting that user-created manual row + backfilling the real print's actuals from its own vendor payload (with a recap-skip row so no stale email retro-fires).
- **(b) was a three-layer fix; layer 3 was found only by E2E:** TWS historical bars are split-adjusted; year-end statement rows were pre-split basis for three names — mixing bases faked a giant day-one drawdown and mis-scaled one closed short position's era. Normalized product-preserving. New CLAUDE.md invariant records the rule.
- **Rejected in (c):** changing the scanner's threshold semantics (documented deliberate) — the fix guards the approval boundary only. The >50%-past plausibility skip arms without warning by design (mirrors the scanner's own skip); E2E confirmed.
- **Sibling gaps flagged, not fixed:** `lib/alerts/generate-suggestion.ts` prompt wording ("was just crossed") misrepresents force-armed levels; Codex advisory issues #41–#45 batch-filed in TODO; performance-view equity curve may plot raw totals while risk metrics are flow-adjusted (watch item, possibly by design).
- **Public-repo hygiene flag (for the existing TODO item):** `scripts/repair-split-basis-2024-year-end.ts` and its test carry real historical position quantities as guard constants, and two commit messages/TODO entries reference one of them. Same class as the previously-filed tracked-files item; left for the user's redact-vs-accept decision there.

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree: clean after the handoff commit. No open PRs; no unmerged qa-* branches.
- Live: packaged app (final build with all four fixes + migration 077) on :3099, healthy; dev server on :3000 (standing mobile workflow, recompiled with new code); nightly QA fixer worktree at `../vanguard-skin-qa-fix` (deliberate, do not remove); Cloudflare Worker at current deploy.
- Watch items: the genuine NBIS preview email should fire Wednesday ~05:00–05:30 ET (proof the (a) unblock holds); tonight's QA sweep should re-verify the three closed ledger findings; DMG build succeeded this session (Errno-28 item downgraded to watch).

## 5. Claude session link

https://claude.ai/code/session_01SmM7krAmtWWBXRtnxWspe4
