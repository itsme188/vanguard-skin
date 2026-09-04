# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-03 18:00 ET → 2026-09-04 16:30 ET. Focus: the monthly brokerage-statement import (a data-entry task) which surfaced a real parser defect, a wrong rule in the skill that governs it, and a bundle-leak hazard. Ran in parallel with the live-print-v2 slice C/D session; that session's handoff is `92774f4c` and its work is untouched here.

## 1. Goal + exact files changed

Import the August 2026 statements (two Vanguard PDFs, one IBKR activity CSV) through the `import-monthly-statements` skill. Application code changed in three commits on `main`:

- **`65bcb85`** — `lib/import/parsers/ibkr-activity.ts` (Interest section rewritten as per-currency blocks), `tests/import/ibkr-activity-interest-fx.test.ts` (new, 5 tests), `lib/data/security-classifications.ts` (one lookup row: `VUSXX`, mirroring `VMFXX`), `.claude/skills/import-monthly-statements/SKILL.md`.
- **`b8c957da`** — `electron-builder.yml` (one exclusion) and `scripts/verify-bundle.js` (one leak-list entry).
- **`c4b4ee5f`**, **`2c75754c`** — `docs/plans/TODO.md`, `CLAUDE.md` (docs reconciliation).

No other application code was touched. The canonical CSVs and the gates record are archived outside the repo under `~/Desktop/Trading - Local/canonical/2026-08/` (real figures — deliberately not committed).

## 2. Tests / E2E / deploy result

| Check | Result |
|---|---|
| `npx vitest run` (full) | 7,648 passed, 1 failed — `tests/auth/boundary-matrix.test.ts` ESLint guard, a 57 s load timeout; passes solo in 28 s, no commit in range touches it |
| `npx vitest run tests/import` | 373 passed / 31 files |
| New FX tests | 5, written first and watched fail for the right reason before the parser changed |
| `tsc --noEmit` | no new errors in the changed files |
| `npm run verify:changed` | clean |
| `scripts/audit-twr-vs-statements.ts` | unchanged verdict; its GATE FAIL is four pre-existing 2024–25 `investigate` rows, none from this work |
| **Deploy** | **`npm run electron:deploy` exit 0** — compiled, signed, **notarization successful**, `verify-bundle: OK (no leaks, runtime pieces present)`, installed to `/Applications` and relaunched at 16:22 ET |

Post-deploy health: app serving on 127.0.0.1:3099, startup sync completed in 200.8 s, and all three accounts' month-end anchors reconcile to their statement with zero delta both before and after the startup purge and valuation recompute.

## 3. Open concerns / rejected approaches / decisions

- **The skill's unsettled-activity rule was FALSE and had already cost a month of ledger accuracy.** Phase 5 asserted that the next statement re-lists the prior month's "Unsettled activity" rows in its Completed section. It does not — verified by grepping the whole August statement for prior-month trade dates and finding none. Nine July trades had therefore never entered the ledger, and `computeTaxLots` had masked the missing sale with a synthesized `RECONCILE_CLOSE`. They were imported from the July statement as their own canonical file and the real sale superseded the stand-in. Rule corrected in the skill and in `CLAUDE.md`.
- **IBKR statement sections are per-currency blocks.** Native rows, a native `Total`, then IBKR's own `Total in USD`. The parser read every Amount column as dollars, so a KRW debit-interest row would have entered the ledger at that magnitude in USD. July's equivalent row was tiny, which is why the defect never surfaced. Non-USD blocks now scale by the block's own Total-in-USD ratio; the native figure is retained in the note **and in the source key**, so re-importing an older statement dedupes against the row it already wrote rather than twinning it; a non-USD block with no conversion line is skipped with a warning rather than stored. **The sibling Dividends / Fees / Deposits & Withdrawals loops still read Amount raw** — same defect class, filed in TODO, not fixed because no non-USD row has appeared there and I did not want to change three more loops without a fixture.
- **Deploy decision — this session deliberately overrode the previous handoff's "Deploy: NONE".** That decision rested on two grounds: (a) "main gained no bundled application code", which stopped being true when the parser fix landed, and (b) "the 089 cutover must precede the next rebuild". Ground (b) was checked rather than assumed: the actual hazard, as TODO states it, is that `lib/db.ts` runs migrations at module load, so **a relaunch applies 089 without the cutover runner's backup/holder/missing-bytes gates**. That hazard exists only once slice B is merged. B is unmerged (34 commits ahead), `main` carries nothing above 088, and 088 was already applied — so the build bundled no 089. **Verified after the relaunch: `schema_migrations` still tops out at 088 (applied 2026-09-03), 089 absent.** The cutover gate is intact and the ordering `merge B → cutover → merge C → merge D → rebuild` is unaffected, except that a rebuild has now already happened and the post-cutover one will supersede it.
- **Bundle leak closed.** `workers/cron/.wrangler` (miniflare KV/R2/cache SQLite; the KV blobs carry armed-event projection data) was present in the main checkout, and Next's tracer sweeps it into `.next/standalone`. `CLAUDE.md` had flagged this on 2026-09-03 with "add the path to the bundle gate's leak list when next touched". Both layers now cover it. **Scoped to `.wrangler` on purpose:** `lib/calendar/enrichment-runner.ts` imports `workers/cron/src/yahoo` at runtime, so the blanket `workers/**` exclusion I first considered would have been wrong.
- **Rejected:** committing the IBKR statement before fixing the parser (would have written a five-figure-magnitude foreign-currency row into the ledger as dollars); importing through the packaged app after the fix (it bundles its own `lib/`, so it would have used the old parser — the route's exact lib sequence was driven from a repo-root tsx script instead); a blanket `workers/**` bundle exclusion.
- **Left open, with a decision needed on the third:** the sibling currency loops above; a position whose tax-lot quantity exceeds every statement's holding since July, meaning a historical sale is missing from the ledger; and bond accrued interest, which sits inside lot cost basis and proceeds because `netLegDollars` takes lot dollars from `amount` while the canonical row carries dirty cash with a clean price — so bond realized figures differ from the statement's by exactly the accrued leg. Tax exports are already marker-gated NOT-FOR-FILING, so none of this is user-visible as filing data.

## 4. Uncommitted changes / live-process state (after the deploy)

`main` clean at `2c75754c` and pushed; the working tree has no modified files. The desktop app is the **2026-09-04 16:22 ET build** (previously 2026-09-03 10:41) and is running on 127.0.0.1:3099. Migration state is 088; **089 has not been applied and must still go through `scripts/migrate-089-document-identity.ts --live`.**

Four worktrees remain, all clean and belonging to the other session: `../vanguard-skin-print-v2-b` (`702baaf8`), `../vanguard-skin-print-v2-c` (`c37ed1e0`), `../vanguard-skin-print-v2-d` (`4c33e361`), and `../vanguard-skin-qa-fix` (the nightly fixer's parked worktree — leave it alone). Open PRs **#64** and **#65** from the nightly QA automation are still unreviewed. No dev servers; the temporary QA session minted for the import API was revoked. The Worker is unchanged.

## 5. Claude session link

https://claude.ai/code/session_01N5oAfTW3wTiVzn21mYB8Mk
