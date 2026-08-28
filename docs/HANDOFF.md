# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-28 — AUTONOMOUS Claude × Codex pairing session (owner hands-off). Codex was the co-decider and adversarial reviewer for every phase; ~10 Codex runs, 3 of them BLOCK verdicts whose findings were all fixed before merge.

## 1. Goal + exact files changed

Six phases on branch `pair-2026-08-28-landing`, merged to main (see §4 for the SHA).

**Phase 0 — land 13 stranded QA-fixer commits** (PR #56 merge + 10 cherry-picks, two known-broken-without-follow-up pairs squashed). Codex flagged three of them; all three were real: `lib/research/sync-lock.ts` NEW + `app/api/research/sync/route.ts` + `app/api/cron/research-sync/route.ts` (module-scoped lock; manual/background/cron never overlap the select-then-spend AI stages; 409 `already_running`; `X-Sync-Runner` header); `lib/digest/send-earnings-email.ts` + `lib/earnings/reporter-recap.ts` + `workers/cron/src/fallback-earnings.ts` (manual_actuals_at bypass extended to every outbound road + Worker parity pin); `app/dashboard/today/BogeysEditModal.tsx` (notes → `<PrivateText>`). Codex's integrated review then caught defects in the fixer's own commits: `lib/levels/narrative-guard.ts` (repeated capture group kept only the last hedge word — "above the current price of X" was never a current-price claim), `MultiChart.tsx` (432px not 416), `ResearchFeedsView.tsx` (bgSyncing stuck).

**Phase 1 — earnings hardening:** `lib/alerts/print-push-message.ts` + Worker mirror (`compactRevenuePair`: shared scale, smallest distinguishing precision, one-decimal surprise); `lib/mutations/earnings-bogeys.ts` + `lib/earnings/extract-newsletter-bogeys.ts` (`preserveExisting` COALESCE mode for newsletter re-scans only; provenance advances only on contributing content; blank ≠ content; TMTB "Buyside Bogeys" KNOWN FORMATS; `guidance_notes` end-to-end); `lib/earnings/earnings-slot.ts` NEW + `pre-print-floor.ts` + `actuals.ts` + `wire-times.ts` + `lib/calendar/verify-earnings-dates.ts` (slot floors AMC 16:00 / BMO 07:00 ET; suspect ≥17:00 web-verified AMC times never stored AND ignored by the cascade; user rows exempt); `lib/calendar/enrichment-runner.ts` + `app/api/earnings/recap-modal/route.ts` (explicit-event enrichment honours the floor — Codex blocker).

**Phase 2 — 12 pending deep-QA decisions** decided jointly, 11 fixed: `lib/queries/security-detail.ts` (grouped trade-grade cards), `lib/compute/beta-confidence.ts` NEW + `scripts/refresh-vanguard-betas.ts` + `lib/mutations/security-betas.ts` (r² < 0.10 or < 30 pairs DELETES the cached row; decide-then-apply in one transaction), `lib/levels/scan-range.ts` + alerts page (move-needed relabel), `lib/compute/xirr.ts` (aggregate count = sum of members), `WhatIfCalculator.tsx` (caption), `lib/queries/data-confidence.ts` (latest + stalest), `lib/compute/cash-deploy.ts` + `CashDeployCard.tsx` (equity-sleeve gaps), migration `087_analysis_narratives_input_fingerprint.sql` + `lib/compute/analysis-narratives.ts` + `lib/queries/analysis-narratives.ts` + narrative route + `NarrativeBlock.tsx` (input fingerprint; GET read-only + drift banner with inline Refresh; regen only via POST), `lib/import/error-classify.ts` NEW + `app/api/import/route.ts` (wrong-document → 400), `ManageSourcesModal.tsx` (disabled delete + caption), `PrintWatchPanel.tsx` + `app/api/print-watch/accept/route.ts` (per-line accept; route admits pending-with-value; supersession recheck on re-accept).

**Phase 3 — ET clock** (implemented by Codex `--write`, reviewed by Claude): `lib/compute/options-greeks.ts`, `lib/compute/options-expirations.ts`, `lib/queries/options.ts` (`todayET()` with injectable `today`).

**Docs:** `docs/reference/earnings-pipeline.md`, `docs/reference/conventions-detail.md`, `docs/DECISIONS.md` (2026-08-28 entry), `CLAUDE.md` (3 bullets), `docs/plans/TODO.md` reconciled (shipped items closed; 11 follow-ups filed under "2026-08-28 pairing-session follow-ups").

## 2. Tests / E2E / deploy result

- Full suite on the branch: **588 files / 6,776 passed / 0 failed** (from 6,548 at session start); Worker suite 34 files / 489 passed; `npx next build` green; tsc shows only the pre-existing 20 errors in four untouched test files.
- One pre-existing load flake root-caused and de-flaked (`tests/print-watch/watcher.test.ts` seen-set tests: chained polls + real fs I/O vs a fixed fake-timer flush).
- Browser E2E on a secret-less dev server (:3095, `VACUUM INTO` DB copy, minted QA session): 9 PASS / 1 unverifiable (all print-watch lines already accepted), plus a re-check of two UI fixes. Evidence: `qa/verify-evidence/pair-2026-08-28/` (gitignored).
- Noise-beta root cause on a DB copy: the negative betas are statistically insignificant regressions (median r² 0.053; VTI correctly β 0.99 / r² 0.96; XLV vs official session bars reproduces the sign) — NOT price corruption; no user-run repair needed. Bonus bug fixed: skipped securities kept publishing stale betas.
- Deploy: see §4.

## 3. Open concerns / rejected approaches / user decisions

- **Joint decisions (Claude + Codex, recorded in docs/DECISIONS.md):** slot floors keyed on the BMO/AMC slot, never release_time; COALESCE preserve scoped to newsletter re-scans; beta thresholds r² 0.10 / 30 pairs with DELETE not NULL; narrative fingerprint with read-only GET; equity-sleeve gap basis; recap SSE deferred in full (client-only timeout rejected); print-watch feedback (a)(b)(d)(e)(f) deferred with dispositions; deploy is a gated decision after packaged-app E2E.
- **Rejected:** unconditional COALESCE (blocks manual clears); storing NULL betas (column NOT NULL → migration for no gain); per-article bogey keying (migration); force plumbing for the recap-modal pre-print 409 (no caller needs it).
- **Not verifiable offline:** TMTB extraction quality (needs a live model call on the next "Buyside Bogeys" issue); the drift banner clearing after Refresh (no AI key on the sandbox); per-line accept in the UI (no non-accepted line existed).
- **Follow-ups filed in TODO:** recap-modal SSE (decided shape), Promote GAAP-basis warning, "Diversified" bucket vs 0% target, data-confidence ACTIONS wording, UTC-today sibling sweep (~45 non-option sites), `rowSlot`/`prePrintMessage` consolidation, read-through consensus precedence inversion, useResearchSync debounce on non-ok, beta data hygiene (weekend tws rows, snapshot-vs-official close drift), Armed secondary contrast, bogey-as-expected push.
- **Number-trust user-run runbook still pending** (unchanged this session; exports stay NOT-FOR-FILING).

## 4. Uncommitted changes / live-process state (post-deploy)

- MERGED fast-forward to main @ `0817afd` (46 commits) and pushed (`ec1a4dd..0817afd`); PR #56 auto-marked MERGED. DEPLOY: Electron rebuild green — notarization successful, `verify-bundle: OK`, installed + relaunched; evidence: `/login` 200 on :3099, authenticated `/api/summary` + `/dashboard/today` + `/dashboard/analysis` 200, `analysis_narratives.input_fingerprint` present on the live DB (migration 087 applied at launch). Packaged-app browser check (Today / Analysis + Defense drift banner / Charts 2x2 / data-confidence drawer, read-only): all PASS, zero console errors from :3099; the temporary QA session minted for the checks was revoked.
- Live-log observation (pre-existing, 16:41Z 2026-08-28): `[levels/extract] … Your credit balance is too low to access the Anthropic API` — the Anthropic account needs credits or every AI feature (levels/bogey extraction, narratives, recaps) silently degrades. Owner action.
- QA branches now fully landed on main: `qa-auto-fixes-2026-08-24` (PR #56), `qa-deep-fixes-2026-08-24`, `qa-fix-work-20260824`, `qa-fix-work-20260828`, `qa-deep-fixes-2026-08-28`. Branch deletion is left to the owner (destructive). The fixer worktree `../vanguard-skin-qa-fix` was not touched.
- Ledger: 11 findings marked fixed with commits; 1 decision-resolved (recap SSE); `qa/findings/DECISIONS-PENDING.md` regenerated.

## 5. Claude session link

https://claude.ai/code/session_01G8YfUYLb447k7VQmCuiFVG
