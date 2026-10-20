# Session Handoff — for Codex review

**Waiting on:** USER: (1) confirm the Mac app deploy (`npm run deploy`) finished; it was running at session end. (2) First live check of the deep read and the watch lines on an armed name (TODO w1, w6). (3) Rule on TODO w5: should the preview email list topic-only watch lines? The two decision records from the last handoff (`broker-realized-gain-reports`, `tax-preparer-short-term-gift`) were not touched. CODEX: a review of section 3 is welcome, especially the bogey source ranking. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session date:** 2026-10-20, Eastern time. A cloud session (claude.ai/code), owner present; the owner ran the Mac-side verification, the push of the Mac's local `main`, the merge and the deploys.

**Register note:** this session ran in a cloud container with its own clone, so it could not read or write the coordination register on the Mac (`npm run inbox`, decision records, locks). Item (3) above should be registered as a `decision` record from the Mac: `npm run coord -- task register --id preview-email-topic-watch-lines --owner user --status decision --next "Should the preview email list topic-only watch lines?"`.

## 0. State at the end

- `main` holds everything from this session through PR #117 (merge `9603551`). This close-out commit is on `claude/zen-ritchie-dek9gs`, restarted from that merge, in its own pull request.
- **Verified:** `bash scripts/verify.sh full --base main` on the Mac at the PR head `26699252`: passed.
- **Deployed:** Worker `vanguard-skin-cron`, version `ba8380d7-77dd-479a-9823-bcdd9c6b24a8` (owner, from `workers/cron`). Mac app: `npm run deploy` in progress at session end; outcome not seen by this session.
- **The Mac's local `main` held 12 unpushed nightly-fixer commits** (through `ac87fdac`). The owner scanned their test diffs for real figures (only OCC symbols with synthetic tickers and one expired SPY format example in a comment) and pushed them before the merge; PR #117 was merged on top.

## 1. Goal + what changed

**Goal (owner):** make the Earnings Hub dependable for this week's prints: (1) no bugs, (2) earnings items from the to-do list, (3) track the company-specific figures previews talk about (Micron's margins, Nike's China) on the live sheet; then (4) on arm, a frontier-model deep read of the week's newsletters for the name.

Files (commits `670e496`, `b101b62`, `823d304`, `1e89d3c`, `b36e4f7`, `b61924a`, `d6f1a48`, merge `2669925`):
- Watch metrics: `lib/earnings/watch-metrics.ts` (new), `lib/earnings/extract-newsletter-bogeys.ts`, `lib/earnings/extract-bogeys.ts`, `lib/earnings/prepare-steps/newsletter-rescan.ts`, `app/api/earnings/bogeys/upload/route.ts`.
- Deep read: `lib/earnings/deep-read-bogeys.ts` (new), `lib/earnings/prepare-steps/newsletter-synthesis.ts` (new), `lib/earnings/prepare-steps/index.ts`, `lib/earnings/bogey-claim.ts`, `lib/ai/models.ts`, `lib/ai/feature-keys.ts`, `lib/print-watch/contracts.ts`, `app/dashboard/today/live-print/PrepareStatus.tsx`.
- Bug fixes: `lib/mutations/earnings-bogeys.ts`, `lib/print-watch/window.ts`, `app/dashboard/today/EarningsHubLive.tsx`.
- To-do items: `lib/calendar/finnhub.ts`, `lib/queries/bogey-event-match.ts`, `app/dashboard/today/BogeysUploadButton.tsx`, `lib/format/signed-fixed.ts` (new), `workers/cron/src/signed-fixed.ts` (new), `lib/digest/send-earnings-email.ts`, `lib/calendar/briefing.ts`, `lib/earnings/post-print-sheet.ts`, `lib/format/finnhub-figure.ts`, `workers/cron/src/fallback-earnings.ts`, `workers/cron/src/todays-reporters.ts`.
- Tests: new `tests/earnings/watch-metrics.test.ts`, `tests/earnings/deep-read-bogeys.test.ts`, `tests/format/signed-fixed-*.test.ts`, `workers/cron/test/signed-fixed-formatters.test.ts`; updated pins in nine existing test files.
- Docs: `CLAUDE.md` (two conventions), `docs/DECISIONS.md` (2026-10-20 entry), `docs/reference/earnings-pipeline.md` (§Watch metrics from previews, §The armed-event deep read, prepare-step table), `docs/plans/TODO.md`, `.gitignore` (Python caches).

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Mac, `bash scripts/verify.sh full --base main` at `26699252` | passed |
| Cloud container, `npx vitest run` after merging `main` (Node 22) | 17,299 passed, 10 failed in 4 files; the same 4 files fail on an unchanged checkout there (`tests/verify/*` need the Node 24 runner, `risk-empty-account-scope`, flaky `watcher` timing) and all pass on the Mac |
| Worker suite (`workers/cron`) | 1,025 passed |
| `tsc --noEmit` | clean |
| Browser pass | not run |
| Real model call | none: the deep read and the extractors are tested against a mocked model |
| Deploy | Worker deployed; Mac app in progress (above) |

## 3. Open concerns, rejected approaches, decisions

- **Bogey source ranking is a behaviour change taken under the owner's request for "proper bogeys".** `BOGEY_SOURCE_RANK_SQL`: manual, upload, deep read, single-article newsletter, vendor; then rowid. It also settles the bug audit's open point that the vendor row minted at arm time outranked the desk's own sheet. Email readers stay newest-first. Reversible in one place.
- **Watch metrics ride `extra_metrics_json`**, not a new table, so compile, recompile, conflicts and the modal are reused. Ids are derived from the figure (name tokens, period, unit, basis), so sources converge; kind is derived from the period because it is a conflict field the id does not carry.
- **R20 changed shape:** it read the bogey row, which has no extractor version, so the version bump would have re-read nothing. The global scan now banks its own ledger row (`attempts = 0`); R20 reads that. Cost: one re-read per (armed event, mentioning article) in the 14-day window.
- **The deep read never sees stored numbers**, so it cannot relabel a vendor figure as the newsletters'. It reads only articles received before the slot floor, so a recap cannot become a bogey.
- **Slot-default window:** for exactly the stamps 08:00 and 16:15 the window opens at 06:00 / 15:55; the end is unchanged. Chosen over changing the release-time cascade, which many readers share.
- **Not built:** next-quarter revenue / EPS guide bogeys still free text (w3); a newsletter landing after a sheet has evidence adds no watch line (w4); stored duplicate unlabelled manual rows not removed (w2, owner deletes them in the modal or asks for a rehearsed repair).
- **Bug-audit items judged display-only or unconfirmed and left:** countdown from a stored call time, a reaction chip that skips the validity check, a double-press on arm, an expanded row collapsing when its print appears.

## 4. Uncommitted changes / live state

None in this checkout beyond this close-out commit. No worktrees. PR #117 merged; this close-out is its own pull request. Live: Worker `ba8380d7`; Mac app build depends on the in-progress deploy.

## 5. Agent + session

Claude Code, cloud session https://claude.ai/code/session_01Ki7FxQXS6LJxhkrGL1sSxD
