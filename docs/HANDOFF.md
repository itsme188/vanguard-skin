# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-03 16:00 ET → 2026-09-04 16:00 ET (the ZS live-print session kept open, then continued). Focus: live print v2 **slices C and D built in parallel** in two sibling worktrees, each planned, Codex-reviewed, subagent-built, whole-branch reviewed, verified and pushed UNMERGED.

## 1. Goal + exact files changed

**On `main` (docs and one QA script only — no application code):** `qa/nightly-qa-cron.sh` (`4809db6`: the 2 AM smoke now runs once per night behind a per-day archived-report marker, and its dead `claude -p` auto-fix block is removed — it had been dead since 2026-05-30 and, had it run, would have switched the MAIN checkout to a branch at 2 AM); `docs/superpowers/plans/2026-09-03-live-print-v2-slice-c.md` (`b386fb2`, `5355024`); `docs/superpowers/plans/2026-09-03-live-print-v2-slice-d.md` (`85d5713`); `docs/plans/TODO.md` and `docs/HANDOFF.md` (`ce36267`, `2b19776`, `66548a0`, `f5168aa`, `71c479e`, `15dc0b2`, `152d8a6`, `290e9c40`, this commit).

**Branch `print-v2-slice-c` @ `c37ed1e` (25 commits over `702baaf`, worktree `../vanguard-skin-print-v2-c`, PUSHED UNMERGED).** Plan §4.3. New: `lib/print-watch/{window,scheduler,go,storage-path}.ts`, `lib/db/migrations/090_print_watch_go.sql`, `app/api/print-watch/{go,extend}/route.ts`, tests under `tests/print-watch/`, `tests/api/`, `tests/db/`. Modified: `lib/print-watch/{types,store,watcher,register,dj-adapter,edgar-adapter,hardened-fetch,ir-baseline-step}.ts`, `app/api/print-watch/status/route.ts`, `app/dashboard/today/PrintWatchPanel.tsx` (two controls plus one status line), `docs/reference/earnings-pipeline.md` §Print-watch, `docs/DECISIONS.md`.

**Branch `print-v2-slice-d` @ `4c33e361` (29 commits over `702baaf`, worktree `../vanguard-skin-print-v2-d`, PUSHED UNMERGED).** Plan §4.4. New: `lib/print-watch/{first-pass-types,read-facts,callouts,read-store,first-pass-prompt,first-pass-format,read,read-scheduler,first-pass-merge,first-pass-register}.ts`, `lib/db/migrations/091_print_watch_first_pass.sql`, `app/api/print-watch/{read,callouts/accept}/route.ts`, `app/dashboard/today/FirstPassRead.tsx`, `scripts/rehearse-additive-migrations.ts`, tests. Modified (each in the one place its task named): `lib/print-watch/{watcher,register}.ts`, `app/api/print-watch/{status,ensure,accept}/route.ts`, `app/dashboard/today/PrintWatchPanel.tsx`, `lib/ai/{feature-keys,models}.ts`, `lib/queries/earnings-intel.ts` (one additive export), `scripts/snapshot-state-to-r2.ts` (one additive export plus a direct-run guard), the two docs.

## 2. Tests / E2E / deploy result

| | slice C @ `c37ed1e` | slice D @ `4c33e361` |
|---|---|---|
| Vitest | 668 files, **8,073 passed / 0 failed** | 677 files, **8,064 passed / 0 failed** |
| `tsc --noEmit` | clean for every branch-owned file | same; 20 errors remain in four files no commit in range touches |
| `next build` | clean, 0 Turbopack tracer warnings | clean |
| Migration on a live-DB copy | 090 applied by the BUILT standalone server on cold start over an 089 copy | 091 rehearsed by `scripts/rehearse-additive-migrations.ts`, all seven invariants PASS |
| Sandbox E2E | :3095, 6/7 exact | :3094, phase A3 7/7 with one REAL model call, phase B 4/4 |

C's three suite failures under concurrent load were all in `tests/digest/send-digest-race.test.ts` (5 s timeouts); solo reruns 5/5 three times and no commit in range touches digest. C's E2E seventh step diverged only in mechanism: the built code refuses a secret-bearing link BEFORE any fetch rather than after, and the secret reached no payload. D's E2E covered the live read, callout accept and un-accept, privacy masking, canary absence, and persistence of the read across a server restart with no spurious regeneration.

**Deploy: NONE, deliberately.** Neither branch is merged; the desktop app is untouched and still the 2026-09-03 10:41 ET build. The Electron rebuild is deliberately SKIPPED this session on two grounds: `main` gained no bundled application code (the only non-docs commit is a QA cron script that is not in the bundle), and the 089 cutover must precede the next rebuild.

## 3. Open concerns / rejected approaches / decisions

- **Cutover order is a hard gate (Codex D finding 23, confirmed by the C Task 1 review):** `scripts/migrate-089-document-identity.ts --live` refuses while any migration above 089 is pending. Order: merge B → cutover from a checkout holding nothing above 089 → merge C → rebase D onto C and merge → rerun rehearsal, build and E2E on the merged tree → rebuild. Never merge C or D before `--live`.
- **Slice C rulings R-C4..R-C19.** Load-bearing ones: R-C4 the effective window pools min/max per spec §4.3 (the plan's own test carried the typo); R-C5 `hardenedFetchText` abandoned response bodies on eight early-exit paths while the scheduler held its concurrency slot until body close, so two ordinary EDGAR 404 polls would have stalled the SEC lane for 120 s at the print minute; R-C7 C's merge handler registers before B's because go rows carry no cascade; R-C12 a road's report settles at delivery and the 15 s road timer covers acquisition only, since the previous shape wrote a succeeded wire road as `failed — timed out after 15s` permanently; R-C15 the `ir_baseline` step is a no-op once the window is open, because a go press that armed the event was recording that night's release link as the baseline and filtering it out forever; R-C16 the dispatcher reconciles unplaceable work; R-C17 a disarm after a press wins.
- **Slice D rulings R-D1..R-D37.** R-D20 a client-safe format module: the PLAN itself prescribed `"use client"` imports that pull `node:child_process` and native deps into the Today bundle, and every task-scoped review passed it because the build only ran in the verification task. **R-D21 changes product behaviour and was CONFIRMED by the user on 2026-09-04 to stand as built, to be revisited only when slice F builds out the hub:** facts are accepted-only, so the parse hook always found none; B's accept route now schedules the read, making the first read follow the desk's FIRST ACCEPT within seconds. R-D22 print-watch never imports `lib/digest`. **R-D36:** validation demanded exactly three surviving call-watch lines and the live sandbox failed ELEVEN consecutive reads; those lines are forward-looking and cite nothing, so cites are optional there, 0–3 survivors finalise `done`, and a zero-survivor read carries a caveat. The next live read then produced nine read lines, three call-watch lines and two callouts.
- **Two Codex findings disputed, and the user confirmed both dispositions on 2026-09-04:** #20 bogeys, actuals and deltas render as public market data with parity to the existing sheet rather than blanket masking; #26 no fake-model seam ships in production code, so the sandbox does one real model call instead.
- **Rejected:** relitigating facts-are-accepted-only to restore an automatic parse-time read; a lane-wide IR refusal budget; watering down the docs to match unimplemented rulings (the code was landed instead).
- **Process incidents:** the delegated slice D controller died twice on the account spend limit and was resumed from its worktree ledger without re-dispatching any task; background child notices were routed to the main session rather than that controller; the TODO-gate hook fired three times on documentation heredocs naming the deploy script and was satisfied by reconciling TODO.md, never evaded.

## 4. Uncommitted changes / live-process state

`main` clean at this commit and pushed. Three branch worktrees remain, all clean and fully pushed: `../vanguard-skin-print-v2-b` (`702baaf`), `../vanguard-skin-print-v2-c` (`c37ed1e`), `../vanguard-skin-print-v2-d` (`4c33e361`); `../vanguard-skin-qa-fix` is the nightly fixer's parked worktree, leave it alone. No dev servers running (the :3094 and :3095 sandboxes were stopped by PID and both ports are free); the Playwright test browsers were killed by PID. The Electron app on :3099 is the 2026-09-03 10:41 ET build and the Worker is unchanged. Open PRs: **#64 `qa-deep-fixes-2026-09-04` and #65 `qa-auto-fixes-2026-09-04`**, five commits each, opened by the nightly QA automation during this session and not reviewed — filed in TODO.md and DEFERRED by the user until after the B/C/D landing and the rebuild. Open issue #34 is the standing review-intake charter and stays open by design. Both SDD ledgers, briefs, reports, E2E reports and screenshots are archived to `docs/private/2026-09-03-live-print-v2-slice-{c,d}-sdd/` (gitignored).

## 5. Claude session link

https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL
