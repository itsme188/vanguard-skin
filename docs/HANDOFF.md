# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-23 — number-trust audit containment: decided, built, merged, live-repaired, deployed. Plus both overnight QA fixer branches landed, and a public-repo privacy purge.

## 1. Goal + exact files changed

**Arc 1 — QA landing:** merged fixer PR #55 (`5d24c21`: `ChatDrawer.tsx`/`OpenChatButton.tsx` open-only chat event, `SecurityChart.tsx` window-aware empty state + test, `tax-lots/page.tsx` + `security/[id]/page.tsx` security filter, `EarningsDateChip.tsx` popover clamp/dismissal) and `qa-deep-fixes-2026-08-21` (`d8f2989`: NEW `lib/compute/option-expiry.ts` single-source ET-anchored live-option cutoff applied in `hedging.ts`/`scenarios.ts`/`scenario-recipes.ts`; balanced-paren markdown links in BOTH `lib/calendar/briefing-html.ts` + `workers/cron/src/html.ts`; `lib/mutations/research.ts` rank→note clearing; `ManageSourcesModal.tsx` blur-race; `ResearchFeedsView.tsx` category labels; `WeekOverWeekBadge.tsx` rounds-to-zero; `EarningsRowChips.tsx` visible-instance gate).

**Arc 2 — privacy purge:** the Codex audit doc (real account figures) had been committed to this PUBLIC repo; history rewritten from `f57c678` forward (reset + sanitized re-commits + force-push), doc moved to `docs/private/` (NEW gitignore rule). TODO/HANDOFF entries recreated direction-only. Orphaned pre-rewrite SHAs may persist on GitHub until gc (support ticket can purge).

**Arc 3 — containment (plan `docs/superpowers/plans/2026-08-23-number-trust-containment.md`, 1× Codex plan review REVISE→addressed, merge `6ae273b`, 9-task parallel SDD):**
- `lib/mutations/securities.ts` — guard: incoming Bond/Mutual-Fund identity (type/name/derived maturity) refused onto Stock/ETF rows with equity fills.
- `scripts/repair-security-type-corruption.ts` NEW — config-driven (gitignored `data/repair-configs/`), dry-run-default readonly, all-or-nothing single-transaction apply, coupon re-home with corrected source keys, review-only contradiction detector, post-apply tax-lot + valuation recompute + daily-identity check. Post-merge fix `4487abe`: relative dynamic imports + `REPAIR_DB_PATH`/`REPAIR_CONFIG_PATH` env overrides (rehearsal caught `@/` alias breaking for dynamic imports outside repo cwd — transitively).
- `TaxReportCard.tsx` + `app/api/tax-report/route.ts` — not-for-filing banner + `-NOT-FOR-FILING` filenames on both export paths.
- `PerformanceView.tsx`/`TrustStrip.tsx`/`TrustStripDrawer.tsx` — TWR surfaces disclose statement-reported/non-independent; neutral tone; bp caption.
- `DataConfidenceIndicator.tsx` — reframed "Data Freshness", not-a-certification caption.
- `lib/compute/cash-flow-audit.ts` — `live-anchor-residual` classification (precedence below `source-seam`), seam collector lifted from `scripts/repair-missing-external-flows.ts` (which now also partitions live-anchor points as informational, never proposals).
- `lib/queries/data-confidence.ts` — passes both date maps; suppresses the score cap for live-anchor residuals while keeping a visible timing-residual label (`TimingResidualNote`).
- Tests: 8 new/extended files; suite 6,235 → 6,275.

**Live-DB repair executed** (user-approved, app quit during run): U/ET/NFLX/PLTR retyped, both mistyped Treasury coupon rows re-homed to the CUSIP security with corrected source keys, tax lots + valuations recomputed, backup retained in `data/backups/`. Both canonical statement CSVs corrected (symbol/name/amount-column fixes) so re-imports dedupe. Three deep-QA ledger findings marked fixed. `CLAUDE.md` conventions updated (`966db20`).

## 2. Tests / E2E / deploy result

- Full suite on deployed HEAD: **6,275 passed + 9 todo, 0 failed**; `npx next build` green; `verify:changed` per task.
- Every SDD task passed an independent spec+quality review first-round; final whole-branch review (most capable model): APPROVE, zero critical/important.
- Repair rehearsed end-to-end on a live-DB copy before the real run (backup → apply → recomputes → identity check → second-apply idempotence all verified); rehearsal caught the dynamic-import defect pre-write.
- Browser E2E ×2 (authenticated via minted session): pre-merge smoke of all four UI lanes on dev; post-repair verification on the packaged app (correct equity rendering, bond table clean, both retyped headers, zero console errors). `verify:smoke` script itself not run (needs the user's app password); equivalent covered by the above.
- **Deploy: SUCCESS** — `electron:deploy` green, notarization successful, `verify-bundle: OK`, installed + relaunched; `/login` 200; auto-refresh cycle clean in the packaged log.

## 3. Open concerns / rejected approaches / user decisions

- **User decisions:** containment-first (audit-sweep repair + import guard; banner-not-disable for tax exports; relabel-not-rebuild for TWR/confidence; label-and-suppress for Plaid residuals); history purge + `docs/private/` + gitignored repair-config for all real constants; live apply with app quit; CSVs corrected by Claude with diff shown.
- **Not fixed, explicitly deferred (TODO P0):** the tax-lots engine bond ÷100 / short-column defect itself (needs own spec with broker-reconciliation acceptance); independent Dietz reconciliation; Data Confidence universe/coverage query defects; noise-betas QA decision (still undecided).
- **Reviewer-attention items:** tax exports still DOWNLOAD with wrong gross columns (banner + filename are the only gate — deliberate); a genuine mid-month external flow on Plaid days now surfaces only as a non-capping timing-residual label until the statement lands (accepted trade-off, wording discloses it); `NEVER undo import batches 56/58` (would delete the repaired coupon rows).
- **Rejected:** merging live-anchor points into `seamPoints` (distinct semantics); rejecting whole import rows at the guard (would silently drop real income); `cd`-into-scratch-dir rehearsal pattern (alias breakage — use env overrides).
- Deferred minors ledgered in the merge history: stale doc comment `cash-flow-audit.ts:247`; TrustStripDrawer "Open Performance →" drops scope param; docs sanitization sweep of older committed entries (new TODO item).

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree clean; `main` pushed through this handoff commit. No open PRs. Worktrees: only fixer-owned `vanguard-skin-qa-fix` (untouched). No dev servers running; QA smoke sessions minted during verification were revoked.
- Live app = today's notarized build (installed ~17:07 local), carrying all four containment lanes + both QA fixer batches. U re-enriches on next TWS connect.
- **Date-critical:** Tuesday 2026-08-25 arm NVDA/CRWD worksheets; Wednesday 2026-08-26 ≈15:45 ET first live print-watch + `scripts/spike-print-timestamp-harness.ts --symbols NVDA,CRWD`; Thursday `--symbols RBRK`.

## 5. Claude session link

Not available in this session's environment (session URL not exposed); the commit trailers carry attribution as usual.
