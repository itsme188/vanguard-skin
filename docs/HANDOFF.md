# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-17 — [R4] donation tracking SHIPPED + in-kind transfer FMV fix + nightly QA chain enrolled in the #35 boundary

## 1. Goal + exact files changed

Three chunks, in session order:

**(a) Nightly QA chain repair** (`f9cfca1`): `lib/mutations/sessions.ts` (+`revokeSessionsByLabel`), `scripts/mint-qa-session.ts` (new), `qa/run-qa.sh`, `qa/sandbox.sh` (random throwaway service secrets; `APP_EXTRA_HOSTS/ORIGINS` for `:3097` — verify-request's Host gate rejects unknown hosts before credentials), `.claude/skills/qa-deep-sweep/SKILL.md`, `tests/queries/sessions.test.ts`.

**(b) [R4] donation tracking + in-kind FMV fix** (branch `donation-tracking-r4`, fast-forwarded to main at `6ed1dd3`, 27 commits): spec `docs/superpowers/specs/2026-08-17-donation-tracking-design.md` (3 Codex rounds folded in, §14 records resolutions), plan `docs/superpowers/plans/2026-08-17-donation-tracking.md` (1 round). Code: migration `lib/db/migrations/081_donations.sql`; `lib/queries/donations.ts`, `lib/queries/giving-view.ts`, `lib/queries/securities.ts` (+CI lookup); `lib/mutations/donations.ts`, `lib/mutations/donation-links.ts`, `lib/mutations/import-batches.ts`; `lib/import/{detect,types,engine,validate,donations-commit,recovery}.ts`, `lib/import/parsers/daf-contributions.ts`; `lib/compute/{flow-adjusted,daily-valuation,twr,xirr,tax-lots,donation-reconciliation,donation-recompute}.ts`; `scripts/repair-inkind-transfer-fmv.ts`; routes `app/api/donations/**` (5 files) + `app/api/import/route.ts`; UI `app/dashboard/components/giving/*` (4 files), `ImportFlow.tsx`, `TransactionHistory.tsx`, `analysis/page.tsx`, `nav-tabs.ts`, `AnalysisViewToggle.tsx`, `lib/analysis/view-param.ts`; guide lockstep `CanonicalCsvGuide.tsx` + `docs/canonical-csv-guide.md` + `.claude/skills/import-monthly-statements/SKILL.md` + `docs/reference/conventions-detail.md` + `CLAUDE.md` invariant; 16 new/extended test files.

**(c) Session-end docs** (`a5e1108..e2dbdfc`): TODO close-out block, `docs/reference/api-patterns.md` donations domain.

## 2. Tests / E2E / deploy result

- Full pinned suite at merge HEAD: **5,566 passed + 9 todo, 0 failed** (502 files; +176 over the 5,390 baseline). `npx next build` clean (twice: pre- and post-fix-wave).
- Authenticated browser E2E on a throwaway `VACUUM INTO` DB copy (never the live DB): 7/7 after one fix — auth via minted session, DAF import preview→commit, Giving render, privacy masking (zero unmasked figures), undo round-trip (final screenshot md5-identical to pre-import), CSRF-negative 401. Evidence local-only in `qa/verify-evidence/2026-08-17-donation-e2e/`.
- Repair script live dry-run (read-only): 21 writable stamps, 0 legs-missing, 274 report-only anomalies; `--apply` deliberately deferred to the user (order matters: DAF import first).
- QA-chain live verification: sandbox unauth 401 / authed 200 / CSRF enforced; 2AM smoke 25 PASS / 2 FAIL (both residual FAILs reproduce in the pre-breakage 08-16 report — inherited drift, not auth).
- **Step-7 deploy: SUCCESS** — notarized, installed to /Applications, relaunched; app serving 200 on loopback :3099 with the new build.

## 3. Open concerns / rejected approaches / user decisions

- User decisions: DAF provider contribution CSVs are the AUTHORITATIVE donation source (statement legs corroborate only); Giving lives as an Analysis sub-view; cash DAF gifts tracked but never touch portfolio data; per-donation explicit lot assignment (no fabricated defaults); full integration incl. tax-lot consumption (Approach 2); one prior recollection about a specific donation was corrected by the provider's own record.
- Notable controller rulings during SDD (full list in the merged commits' review trail): one ruling REVERSED on implementer evidence — conservative cross-donation lot-availability math would permanently block shared-lot assignments after recompute; original best-effort semantics restored with the engine's clamp-and-warn as the authoritative guard and route-level recompute-after-write as the practical closer. Reconciliation excludes both link roles from residual bucketing. Donation-consumption events join a single sorted replay stream (sells → donations → splits) — the reviewer proved behavioral equivalence of the refactor by fuzzing 300k random schedules.
- Review-caught defects worth a reviewer's eye: repair script could have stamped values onto duplicate-suspect legs (fixed, `5da63a4`); engine lot lookup was unscoped by account/security (fixed with a RED-first test); the client import preview (`ImportFlow.tsx`) was outside the plan's file list and only the browser E2E caught it (fixed, `8d2e64a`).
- Known follow-ups filed in TODO.md: Giving read-layer post-donation-split basis (display-only, unreachable with current data); confirm-match should carry `amountForOutLeg`; reconciliation same-key-different-quantity completeness gap.
- USER-RUN residuals (ordered): import the three DAF yearly CSVs → repair dry-run + `--apply` → confirm matches + assign lots in Analysis › Giving. A bounced donation attempt flips to `bounced` automatically when the next monthly statement imports its return leg.
- Concurrent-session note: a parallel interactive session committed two private-markets docs commits into this checkout during execution (one landed mid-feature-branch, verified docs-only and merged along). Coordination message was sent; the sibling-worktree convention applies next time.

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree clean; `main` pushed through `e2dbdfc` + this handoff commit. Open PRs: none. Open issues: #34 only (process discussion).
- Live: NEW packaged app (2026-08-17 build, first with Analysis › Giving) on loopback :3099 behind the #35 boundary; cloudflared tunnel LaunchAgent; Worker fallback-only. Fixer worktree `vanguard-skin-qa-fix` (content landed) still checked out — fixer-owned, untouched.
- Tonight is the first post-repair QA night: the 2AM smoke and 2:45 deep sweep should both authenticate; the armed fixer's next run implements the 17 DECIDED ledger plans and authors the 5 USER-RUN companion scripts.

## 5. Claude session link

https://claude.ai/code/session_01JWa9waKWeZVxXWGRuNT2mz
