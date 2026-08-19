# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-18/19 evening — app-launch runaway ROOT-CAUSED + FIXED (was the valuation recompute, NOT IMAP); canonical-CSV BUY/SELL sign normalization + 12-row repair; 4 QA product decisions recorded; Electron deployed + relaunched.

## 1. Goal + exact files changed

Goal: (a) root-cause the app-launch runaway left open by the prior session; (b) record the 4 pending QA decisions; (c) execute the sign-flipped-BUY sweep.

- `lib/compute/daily-valuation.ts` (`34379fe`) — the runaway fix. `getHoldings`/`getStatementBonds` no longer use a correlated `MAX(as_of_date) <= ?` subquery (holdings' only index is `UNIQUE(account_id, security_id, as_of_date)`; as_of_date is 3rd, so the subquery re-scanned all account rows per OUTER row — measured 466ms/call × 1,854 account/date pairs ≈ 5 min inside ONE synchronous transaction). Now: per-account sorted snapshot-date lists loaded once, new exported `findLatestDateOnOrBefore` binary search resolves the target date in JS, statements bind plain equality. Same-file Phase 2 (cash anchors) untouched.
- `lib/db/migrations/082_holdings_account_asof_index.sql` (`34379fe`) — `idx_holdings_account_asof(account_id, as_of_date)`.
- `tests/compute/daily-valuation.test.ts` (`34379fe`) — 6 unit tests for the helper.
- `lib/import/parsers/canonical-csv.ts` (`8e54b24`) — post-2026-04 BUY-family amounts auto-flip to negative / SELL-family to positive with a warning (mirrors the negative-quantity normalizer), applied BEFORE `source_key` derivation so a wrong-sign transcription and its correction dedup to the same key. Pre-2026-04 rows (legacy-positive by design), TRANSFER, income/fee types, zero/null/NaN amounts untouched. `amountCents` signature: raw string → pre-parsed number (single call site).
- `scripts/repair-buy-sign-post-april.ts` + `tests/scripts/repair-buy-sign-post-april.test.ts` (`8e54b24`) — one-off repair (dry-run default, VACUUM INTO backup, idempotent, UNIQUE-collision guard) that flips amount AND rewrites the key's cents segment together, preserving `:#N` ordinals; 14 selector/rewrite tests.
- `tests/import/canonical-csv.test.ts`, `docs/canonical-csv-guide.md`, `app/dashboard/components/CanonicalCsvGuide.tsx` (`8e54b24`) — the three synced guide surfaces.
- `docs/plans/TODO.md`, `docs/reference/conventions-detail.md` (`d3b19bd`) — reconciliation + parser-enforcement note.

## 2. Tests / E2E / deploy result

- Full pinned suite at HEAD: **5,604 passed + 9 todo, 0 failed** (504 files; +28 over the 5,576 baseline). `verify:changed` green after each change wave.
- Runaway fix equivalence proof on a scratch copy of the live DB: recompute **308,470ms → 117ms** (with the new index) with a **byte-identical** `daily_valuations` dump (662-row CSV diff empty); migration verified through the real `runMigrations` runner.
- Repair applied to the live DB: 12/12 rows (all May-2026 BUY_TO_OPEN, one account), backup at `data/backups/pre-buy-sign-post-april-2026-08-19T02-58-37-715Z.db`, idempotent re-run selects 0, no duplicate source_keys anywhere.
- **Step-7 deploy: SUCCESS** — compiled, signed, notarized, DMG built, installed to /Applications, relaunched. New binary boots clean (`Ready in 59ms`), HTTP answers in ~6ms (trust-boundary 307), migration 082 present in the live `schema_migrations`. No wedge at launch; the definitive live sync-latency datapoint arrives on the next TWS connect.

## 3. Open concerns / rejected approaches / user decisions

- **Prior session's IMAP attribution was wrong** — the saved `sample` profile's hot leaf is `sqlite3_step` under `Statement.JS_all` (2,814/2,825 samples, zero TLS frames); the stream-read frames at the top were the async resume context and the open Gmail sockets were queued behind the frozen event loop. Memory and TODO corrected. Reviewer takeaway: read profiles to the leaf.
- **Scope correction on the BUY-sign item**: the filed example row (CIEN, 2025-04) is inside the documented pre-2026-04 legacy-positive era — correct by design, deliberately NOT touched. Only post-era rows were repaired. The era filter is now enforced in the parser and documented in conventions-detail.
- Rejected: warn-only import validation (leaves the corrected-duplicate dedup class open) and repair-without-key-rewrite (breaks idempotence against the normalizing parser). Chosen: normalize-before-key-derivation + repair rewrites amount and key cents together.
- User decisions (QA ledger, `DECIDED:` plans, fixer-consumable): weekend earnings dates → warn-not-block + week-ahead off-calendar note; Int'l Exposure factor → fold 'International' into the ordinal scale as Very High (+ backfill); By-company digest blowup → each article rendered ONCE with company chips (user chose this over per-company one-line refs; email-path → PR-only); single-account Holdings → unify with the enriched All-Accounts table, Alloc % account-relative.
- Not touched (deliberate): PR #53 review + the 7 unlanded fixes on `qa-deep-fixes-2026-08-18`; AAPL/AMZN/SHOP/NFLX dropped-split repairs; stale `qa-fix-work-20260816` branch (verified merged, deletion awaits explicit OK).

## 4. Uncommitted changes / live-process state (post-session)

- Working tree clean; `main` pushed through the handoff commit. Open PR: **#53** (fixer's, un-reviewed). Fixer worktree `vanguard-skin-qa-fix` still checked out (fixer-owned).
- Live: **Vanguard Dashboard relaunched on the new build** (2.3.0, notarized) — the app is safe to use again; the runaway class is fixed at the root. Worker fallback remains in its normal fallback-only role.

## 5. Claude session link

https://claude.ai/code/session_01NGszqjYNexSectxVJEf4SK
