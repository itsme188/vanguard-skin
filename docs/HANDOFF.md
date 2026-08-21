# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-20 → 08-21 (marathon, three arcs) — QA landing; the live print-watch built end-to-end and shipped; a bundle-integrity incident chain found, fixed, and gated.

## 1. Goal + exact files changed

Arc 1 — QA landing: merged fixer PR #54 + the `qa-deep-fixes-2026-08-20` branch, plus 4 review-hardening commits from a multi-agent review (`lib/levels/scan-range.ts` NEW — both scanner skip conditions single-sourced; `lib/alerts/approve.ts` + `app/api/levels/{review,}/route.ts` + `app/dashboard/alerts/page.tsx` + `LevelsPanel.tsx` — beyond-band arm guard + stale-price disclosure; `lib/queries/{notes,transcripts,security-levels}.ts` + `NotesView.tsx` + `research/page.tsx` — unified earnings-tab search + fetch-candidates from unfiltered set + render-gating; `TaxReportCard.tsx`/`TaxLotSummary.tsx` — wash-sale caption keyed to actual add-backs, LT parity; `TabDropdown.tsx`/`nav-tabs.ts`/`analysis/page.tsx` — per-tab preserved params). Plus `tests/api/notes-route.test.ts` covering the deep-fixes notes coercion.

Arc 2 — print-watch (merge `e5bf7ed`, 27 commits): spec `docs/superpowers/specs/2026-08-20-live-print-watch-design.md`, plan `docs/superpowers/plans/2026-08-20-print-watch-v1.md`, migration `085_print_watch.sql`, the whole `lib/print-watch/` module family (types, store w/ CAS lease, contracts+expected, representations ported from the validated bake-off spike, extract, cross-document reconciler, dj/edgar/ir-rss adapters, hardened-fetch, watcher), routes `app/api/print-watch/{status,ensure,drop,accept}`, `app/dashboard/today/PrintWatchPanel.tsx`, `lib/queries/earnings-worksheet-flags.ts` (armed-regardless-of-printed_at query), one-line sweep nudge in `lib/calendar/email-sweep.ts` + `process.exit` in `scripts/sweep-earnings-emails.ts`, replay suites + synthetic fixture. Also shipped same-session: clear-actuals control (migration `084_manual_actuals_at.sql`, `lib/earnings/actuals.ts`, actuals route, `BogeysEditModal.tsx`) and the deferred print-minors sweep (`worksheet-rich.ts`, `print-pdf.ts`, both verify-script join("") fixes). Spike tooling committed: `scripts/spike-print-timestamp-harness.ts`, `spike-print-tws-news.ts`, `spike-bakeoff-{corpus,parse,score}.ts`.

Arc 3 — bundle integrity (`ac2cc38`, `f65b167`, `7637f6a`): `electron-builder.yml` extraResources filter (data/.git/qa/tests/docs excluded from the bundle), `scripts/verify-bundle.js` NEW + wired into `electron:deploy`, `electron:copy-static` force-copies `next/dist/compiled/next-server/`, tsconfig gains `"dist"` in excludes, next.config.ts carries a DO-NOT-ADD-tracing-excludes warning.

## 2. Tests / E2E / deploy result

- Final full suite on deployed HEAD: **6,201 passed + 9 todo, 0 failed** (547 files; up from 5,924 at session start). `npx next build` green.
- Print-watch verification ladder: per-task reviews with fix loops (5 rounds total, incl. two reviewer-REPRODUCED defects: a disjoint-cluster false green and sign-guard false drops), final whole-branch review fix wave, **independent Codex branch review → fix wave → Codex verdict FIXES VERIFIED**; browser rehearsal on a sandbox DB copy (drop→parse→accept→promote→clear, both pre-print-floor branches DB-verified, restart recovery, drag-drop guard proven via defaultPrevented); bake-off pilot: 195 gold lines dual-vendor-agreed 195/195, 496 parses, zero wrong numbers greened.
- Deploys: three attempts. #1 failed at codesign (read-only `.git/objects` in the bundle — which EXPOSED that the real data/ had been shipping inside `Resources/standalone` since ≥8/19). #2 (tracing-excludes approach) shipped but the excludes gutted nested `dist/` dirs in node_modules — user-reported login 500s, then a Today black screen (missing `@stoqey/ib/dist`). #3 (final, live): full tracing restored, bundle gated by builder filter + `verify-bundle: OK`, installed + relaunched, auth route evaluating passwords, no module errors in the packaged log.

## 3. Open concerns / rejected approaches / user decisions

- **User decisions:** v1 print-watch ships pre-statistical-gate with the USER as the verification gate (explicit choice; greens render "agreed — verify", nothing auto-promotes; a standing pre-gate disclosure line on the panel). Codex reviewed the whole branch pre-deploy at the user's request. V1 scope cut (provenance store, per-line accept UI, correction supersession chains, AbortSignal plumbing, GET-scan depth) deferred BY RULING — inventory in TODO.md "Print-watch post-v1 backlog".
- **Reviewer-attention items:** one document parsed via two representations CAN green (matches spec independence rule + pilot measurement — flagged in case the "two sources" intuition differs); accept route's supersession recheck runs inside a `BEGIN IMMEDIATE` transaction (watch for `SQLITE_BUSY` on that route under watcher write contention); the ir-page gate requires the release to name its calendar year (dateline) — a bare fiscal-label IR page is refused (baseline pass is the primary stale-release defence); `data/` still lands in the ON-DISK `.next/standalone` (tolerated; the DMG gate is electron-builder + verify-bundle).
- **Rejected approaches:** `outputFileTracingExcludes`/`Includes` for bundle hygiene (glob semantics strip nested dist/tests dirs — caused both packaged-app outages); flash candidates participating in agreement (wire rounding would conflict everything); tie-break/outlier-wins reconciliation (false-green class).
- **Known pre-existing gap filed, not fixed:** the pre-print floor reads only `calendar_events.release_time` — a manually-added event with it empty bypasses the floor (synced rows fine).

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree clean; `main` pushed through this handoff commit. Live app = final gated build (installed 2026-08-21 ~18:09 local), print-watch routes verified in-bundle. No dev servers running. Worktrees: only the fixer-owned `vanguard-skin-qa-fix` remains (untouched).
- **Open PR #55** (fixer's overnight 2026-08-21 run, 4 QA fixes) — next session's landing review.
- **Date-critical:** Wednesday 2026-08-26 ≈15:45 ET — arm NVDA/CRWD worksheets (Tuesday), packaged app open on Today, run `scripts/spike-print-timestamp-harness.ts --symbols NVDA,CRWD`; Thursday `--symbols RBRK` (to 17:45). Harness data feeds the post-spike schema appendix.

## 5. Claude session link

https://claude.ai/code/session_01JvWJKJbYPkWm9PQKrm4AJB
