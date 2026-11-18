**Waiting on:** USER: the first real one-click "Read for bogeys" on an armed print is the live check of that button (TODO "Live watches"); nothing else from this session. Carried over: USER rule on the open Analysis tab decisions (record `analysis-tab-owner-decisions`) and confirm the 2025 return used the IBKR 1099-B (record `ibkr-1099b-2025-confirm`); CLAUDE run a Codex review of the Plaid session-dating plan, then build it (record `plaid-session-dating`).

# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

Session: 2026-11-17 → 2026-11-18, bogey intake. Agents: Claude (Fable 5.2 on 11-17, Opus 5.5 on 11-18, orchestrating); Opus and Sonnet subagents built the tasks; two Opus subagents reviewed by running the code; Codex reviewed the plan.

## 1. Goal and files changed

Goal: the owner could not get earnings bogeys onto armed prints without a lot of manual work. A source they read was never scanned, a preview that names the ticker only in its title was skipped, the upload refused anything that was not a statement, and hand entry refused ordinary wording. Owner-approved five-part fix plus the scan gate change from the day before.

Landed on `main`:
- PR #187, `72774c7d` (2026-11-17): the bogey-scan gate also reads FundaAI "Preview" posts. Deployed 2026-11-18 13:31 Eastern from `a6cc1d77`.
- PR #189, `43b5e52d` (2026-11-18): bogey intake. Plan with the Codex round-1 amendments: `docs/superpowers/plans/2026-11-18-bogey-intake.md`. By area:
  - Scan rules from settings: `lib/earnings/bogey-scan-eligibility.ts` (`getBogeyScanRules`, `setBogeyScanMode`, `bogeyScanSourceSql`, `isBogeyScanArticle`), `app/api/research/bogey-scan-sources/route.ts`, the switch in `app/dashboard/components/ManageSourcesModal.tsx`, and the three readers' gate use.
  - Title-only tickers: `articleNamesSymbol` in `lib/earnings/extract-newsletter-bogeys.ts`, used by the global scan, the per-event extractor and the not-read list.
  - Extractor and read route: `lib/earnings/extract-bogeys.ts` (text input, context, `cause` kept), `lib/earnings/watch-metrics.ts` (`alignToExistingLines`, `existingWatchSpecsForEvent`), `lib/earnings/read-bogeys-for-event.ts`, `lib/earnings/read-bogeys-types.ts`, `app/api/earnings/bogeys/read/route.ts`, `app/api/earnings/bogeys/upload/route.ts`.
  - Not-read list: `lib/earnings/unread-previews.ts`, `app/api/earnings/bogeys/unread/route.ts`, `app/api/earnings/bogeys/read-article/route.ts`, `app/dashboard/today/UnreadPreviews.tsx`, mounted in `app/dashboard/today/EarningsHub.tsx`; `recompileLivePrint` is now exported from `lib/mutations/earnings-bogeys.ts`.
  - Edit box: `app/dashboard/today/BogeysEditModal.tsx`, `app/dashboard/today/bogey-read-fill.ts`, `lib/earnings/desk-figure.ts`.
  - Import tab: `app/dashboard/components/ImportFlow.tsx`, `app/dashboard/components/ReadAsBogeysButton.tsx`, `lib/import/not-a-statement.ts`, `lib/import/error-classify.ts` (message unchanged), `lib/ui/current-monday.ts`.
  - Outage wording for a click: `aiUnavailableForClick` in `lib/earnings/ai-unavailable.ts`.
  - Docs: `CLAUDE.md` (gate line), `docs/DECISIONS.md` 2026-11-17 and 2026-11-18, `docs/reference/earnings-pipeline.md`, `docs/plans/TODO.md`.
- `df16c869`: TODO reconciliation. No migration, no schema change, no Worker change.

## 2. Checks run and results

- Branch: `bash scripts/verify.sh full --base main`: 1,816 files, 21,872 passed, 0 failed (4 skipped, 9 todo). `npx tsc --noEmit -p .` clean. `npm run build` passes. Rerun in the main checkout at `df16c869` after the deploy for the stop gate.
- Codex plan review: REVISE with 17 findings; 16 folded into the plan as binding amendments, one declined with the reason recorded (A7, the Import tab files directly as the Hub upload already does).
- Two run-the-code reviews (wave 1 and wave 2): 12 findings, all fixed. One plan amendment was reversed and recorded (A4 revised: commas must group thousands, because "3,35B" read silently as 335B).
- Gate parity, read-only on the live database: the settings-based gate matches the deployed rule on all 1,676 articles from the last 90 days.
- Sandbox (database copy, :3090), checked in the browser pane and Playwright:
  - The not-read list (and the fix that ranks title-named articles first).
  - The edit box: lenient typing and the range refusal, plus the save read back from the sandbox database.
  - The paste reader's outage message.
  - The Sources switch round trip.
  - The Import image fallback through a real file upload (nothing sent to `/api/import`).
  - Phone width (no sideways scroll).
- Live, after the deploy: `POST /api/earnings/bogeys/read` with an invented-figure PANW note returned the figures and aligned the ARR line to the existing line's id. Counts of `earnings_bogeys` and `earnings_bogey_scans` were unchanged. The live not-read list shows the FundaAI PANW preview first.
- Deploy: `npm run deploy` from `df16c869`. Build id matches, codesign verified, a fresh listener answers on :3099.

## 3. Open concerns, rejected approaches, owner decisions

- **Owner decisions (2026-11-18).** Build all five intake fixes. Ship the FundaAI gate before the PANW print, then ship the intake work the same afternoon ("there's enough time to do the app rebuild").
- **Not exercised live:** the one-click "Read for bogeys" writes to the live database, so the owner's first click is its live check (TODO live watch). The sandbox has no AI key, so the AI paths are proven by route tests with a mocked extractor and database assertions, plus the one live read above.
- **Accepted behaviour:** turning a source on in the switch makes the armed deep read re-run on its next pass, which is an automatic AI call (amendment A1, documented).
- **Known limit:** the not-read list and the per-article reader find a ticker, not a company name; name-only mentions are left to the deep read for enabled sources.
- **Rejected:** a general multi-company paste box (A8); holding Import-tab uploads for review before filing (declined in A7).
- **Operator work on live data, 2026-11-17/18, through the app's own routes:**
  - Hand-entered FundaAI rows on the NVDA and PANW prints; the PANW upload row was deleted after it duplicated a watch line.
  - The NVDA preview email was resent.
  - Temporary `qa` sessions were minted and revoked each time.

## 4. Uncommitted changes and live-process state

- `main` = `origin/main` at this handoff commit; the main checkout is clean.
- Installed app: build `mAYVIzIdtSDJpvvoHYvl1` from `df16c869` on :3099.
- Sibling worktree `/Users/Yitzi/code/vanguard-skin-bogey-intake` holds this handoff commit. Branches `claude/bogey-intake-2026-11-18` (squash-merged; content equals `43b5e52d`), `claude/bogey-intake-docs-2026-11-18` (pushed to main) and `claude/nvda-earnings-preview-numbers-7f18ee` (squash-merged as #187) can be removed after `git diff --quiet <branch> main` checks.
- Its `node_modules` is an APFS clone of the main checkout's (gitignored); Turbopack refuses a symlink there.
- Sandbox `bogey-intake` is stopped; its evidence is kept under the coordination directory.
- No dev server or background job is left running.
- Open PRs, none from this session: #175, #176, #177, #179, #181, #182, #183, #186.

## 5. Agent and session

Claude (Opus 5.5 on 2026-11-18, Fable 5.2 on 2026-11-17), Claude desktop app, local session. No shareable session link.
