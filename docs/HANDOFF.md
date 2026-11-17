**Waiting on:** CLAUDE: deploy `main` (`72774c7d` plus this handoff) with `npm run deploy -- --task bogey-scan-fundaai-previews` after 21:00 Eastern on 2026-11-17; it was held on purpose so the app is not restarted around an armed print (section 3). If the session that holds the timer has ended, any agent under a session-end authorization may run it. USER, carried over from the last handoff: rule on the open Analysis tab decisions (register record `analysis-tab-owner-decisions`) and confirm the 2025 return used the IBKR 1099-B (record `ibkr-1099b-2025-confirm`). CLAUDE, carried over: Codex review of the Plaid session-dating plan, then build it (record `plaid-session-dating`).

# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

Session: 2026-11-17, bogey scans also read FundaAI "Preview" posts. Agent: Claude (Fable 5.2, one agent, no subagents).

## 1. Goal and files changed

Goal: the owner found that a FundaAI preview for a print due the same afternoon had reached neither the sheet nor the preview email. First the figures were entered by hand and the email resent (operator work, no code). Then, by owner ruling, the bogey-scan gate was widened so FundaAI previews are read from now on.

Landed as one squash merge: PR #187, `72774c7d` on `main` (7 files).

- `lib/earnings/bogey-scan-eligibility.ts`: the gate. It passes every TMT Breakout article (unchanged) and a FundaAI post whose subject starts with "Preview" and a bar. `BOGEY_SCAN_SOURCE_SQL` now reads the article subject (alias `a`) as well as the source name (alias `rs`). The code twin is `isBogeyScanArticle(sourceName, subject)`; it replaces `isBogeyScanSource`.
- `lib/earnings/deep-read-bogeys.ts`: comment only.
- `tests/earnings/bogey-scan-eligibility.test.ts`: rewritten for the two-part rule.
- `CLAUDE.md`, `docs/DECISIONS.md` (entry 2026-11-17), `docs/reference/earnings-pipeline.md`, `docs/plans/TODO.md`.

The three readers that share the gate (`lib/earnings/extract-newsletter-bogeys.ts`, `lib/earnings/prepare-steps/newsletter-rescan.ts`, `lib/earnings/deep-read-bogeys.ts`) needed no change of their own. No migration, no prompt change, no extractor-version change, no Worker change.

## 2. Checks run and results

- `bash scripts/verify.sh full --base main` on the branch before the commit: 1,803 test files, 21,716 tests passed, 0 failed, 4 skipped, 9 todo.
- `npx tsc --noEmit -p .`: clean.
- The four scan test files on their own (gate, global scan, rescan, deep read): 80 passed.
- The new predicate, run read-only against the live article list over 90 days: every FundaAI Preview post passes, none of FundaAI's other post types does, every TMT Breakout article passes as before.
- Not done: no browser check. The change is server-side article selection; no page shows it. No end-to-end scan was run against a real FundaAI preview, because none is waiting for a covered print that is still ahead. `docs/plans/TODO.md` "Live watches" carries the first-occurrence check.
- Deploy: NOT run yet. See the first line and section 3.

## 3. Open concerns, rejected approaches, owner decisions

- **Deploy held until after the print window.** The change landed about an hour before an armed print. A deploy quits and relaunches the installed app, which owns the in-process print watcher, the broker connection and the evening filing-summary tick. The change does nothing for that print (its figures were already entered by hand), so restarting the app in that window was all risk and no gain. The agent chose the hold; the owner had authorized session-end including the deploy and may override.
- **Owner ruling: previews only.** Scanning every FundaAI post was rejected: about seven times the volume, and the earlier non-preview FundaAI rows carried almost no figures. The cost reason behind the 2026-11-02 TMT-only ruling still stands.
- **How FundaAI figures are stored is prompt behaviour, not a code rule.** In earlier FundaAI rows the extractor put the author's own estimate in the whisper slot and left consensus to the Street figure. If one ever lands in a consensus slot, fix the prompt, not the gate.
- **Owner choice on the hand-entered row:** the Street revenue consensus stayed the revenue bogey; the FundaAI revenue estimate went into the note. The hand-entered row holds the FundaAI EPS estimate in the EPS consensus slot because that slot was empty. A later automatic scan of the same article would store it as a whisper on a separate `newsletter` row; the hand-entered row outranks it.
- **After deploy,** the global scan's 30-day lookback will select the few recent FundaAI previews it never scanned. It calls the model only for one that names a covered company with a print still ahead.
- **A temporary `qa`-labelled session was minted on the live database twice** (`scripts/mint-qa-session.ts`) to call the app's own routes, and revoked each time. The live nightly QA runs on a sandbox copy and mints its own.

## 4. Uncommitted changes and live-process state

- `main` and `origin/main`: PR #187 merged, plus this handoff commit. The main checkout is clean; it must be fast-forwarded before the deploy (the deploy wrapper checks HEAD == `origin/main`).
- Installed app: still the build from before this session (`feec9baa`), running on :3099. It does not have the gate change.
- Branches: `claude/nvda-earnings-preview-numbers-7f18ee` (merged by squash; its content equals `main` at the merge) and `claude/handoff-2026-11-17` (this commit) can be deleted after the deploy. Worktree: `.claude/worktrees/portfolio-assistant-review-7148e7`.
- No dev server, no sandbox, no background job other than the deploy timer in the agent session.
- Open PRs, none from this session: #175, #176, #177, #179, #181, #182, #183, #186 (nightly QA auto-fixes awaiting owner review).
- Live data written this session, through the app's own routes: one `manual` bogey row on an armed earnings event, and one resend of that event's preview email.

## 5. Agent and session

Claude (Fable 5.2), Claude desktop app, local session. No shareable session link.
