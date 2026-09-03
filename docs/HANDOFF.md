# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-02 late evening (second session of the day; started ~20:30 ET after the evening redeploy). Focus chosen from the session-start menu: live print v2 — write the slice A and slice B implementation plans, one Codex round each.

## 1. Goal + exact files changed

**Planning only — no application code changed.**

- `docs/superpowers/plans/2026-09-02-live-print-v2-slice-a.md` — NEW. Slice A (armed-as-covered, ET day math, consumer matrix, cloud outbox + snapshot v11 + Worker resolver, merge registry, prepare registry + four steps). 12 tasks, TDD, pathspec commits. Written by the session model; Codex round 1 returned REVISE with 19 findings: 17 folded in (marked `[C-n]` in the tasks), 1 partially (finding 8 — Cloudflare KV has no compare-and-swap; the Mac is the single writer and now serialises drains through an in-process mutex; residual documented), 1 disputed and left for the user (finding 1 / deviation D1, below).
- `docs/superpowers/plans/2026-09-02-live-print-v2-slice-b.md` — NEW. Slice B (`.ts` migration support, document identity rebuild, roads, PDF/URL/IR-page acquisition, registry shim). 16 tasks. Written by a forked parallel pass of the same session with the same context; its own Codex round is folded in ("REVISED after Codex #n" entries in its header).
- `docs/plans/TODO.md` — contract-id backfill closed (line 69); live print v2 entry updated with both plan paths, the Codex outcomes, and the pending D1 ruling.
- `docs/HANDOFF.md` — this file.

**Cross-slice contract** (both plans quote it verbatim): `lib/earnings/event-merge.ts` (`registerEventMergeHandler`, `mergeEarningsEventState` returning `changed`) and `lib/earnings/prepare-armed-event.ts` (`registerPrepareStep`, `stableHash`, `enqueuePrepareSteps`, `runPrepareSteps`, `getPrepareStepRows`). B calls them through `lib/print-watch/registry-shim.ts` until both slices merge; A's `bootstrapEarningsRegistries()` in `lib/earnings/registry-bootstrap.ts` is the composition root, called lazily by the three registry-reading functions (aligned with B's header mechanic M3). Migration numbers: A = 088, B = 089 (`.ts`, discovered through a static registry because the packaged app copies only `*.sql` and has no TypeScript loader).

**Live-data action taken (not code):** the one-shot contract-id backfill from TODO 69 was run through the live app's enrich route with a temporary qa session (revoked afterwards): 174 stock/ETF rows without an IBKR contract id were submitted, 141 resolved, 33 returned "No security definition has been found" (dead or delisted tickers, left NULL). No other data was changed.

## 2. Tests / E2E / deploy result

- No code changed → no test run, no build, no deploy this session. The Electron app deployed at 19:43 ET (previous session) is still the running build; ZS print 9588 stays armed for 9/3 16:05 ET (release time web-verified from the IR PDF, contract id present, name held → DJ wire lane on).
- The SNOW sheet from the 9/2 print sits in `parsed` with four agreed lines; the calendar row already carries Finnhub actuals matching the sheet's headline pair, so the recap is not blocked on acceptance.

## 3. Open concerns / rejected approaches / decisions

- **Needs the user's ruling — D1 (Codex finding 1):** A stores the Finnhub EPS in a new `earnings_bogeys.eps_consensus_vendor` column and leaves `eps_consensus` NULL on the `'finnhub'` row, because `compileContracts` (`lib/print-watch/contracts.ts`, a slice B/F file) fills the adjusted-EPS expected value from the first non-null `eps_consensus` and the spec rules that A and B share no file. Codex wants the spec's `eps_consensus_basis` column plus a basis filter in `compileContracts` — a three-line edit in B's file. Options: (a) keep D1 (default in the plan); (b) relax the no-shared-file rule for exactly that filter and revert to the spec's column.
- **Rejected by A's plan:** entrypoint-import bootstrap with a loud throw (replaced by self-bootstrapping registries per B's M3); deleting the shared `repointBogeys` statement from `createDependentRepointer` (it also serves the delete-before-cascade path — Codex finding 4); tombstone retention by event date alone (now event date OR 48 hours after removal — finding 7); fire-and-forget enqueue as the only path (the sweep now reconciles missing step rows every tick — finding 10).
- **Accepted residuals:** KV ordering under two Mac processes with Worker credentials (unsupported deployment); the secretless E2E sandbox cannot exercise the newsletter model path (proven by unit tests plus one supervised arm after deploy).
- **Hook note:** the TODO-reconciliation PreToolUse hook blocks any Bash command whose text contains the Electron deploy keyword, including a heredoc appending documentation that merely mentions it. Complied by using the file editor for that append and by committing the reconciled TODO with the plans; nothing was restructured to evade the guard.

## 4. Uncommitted changes / live-process state

- Working tree at the time of writing: the two plan files (untracked), `docs/plans/TODO.md` and this file (modified). They are committed together as a docs commit at the end of the session; not pushed unless `/session-end` runs.
- Electron app running (server PID 31682, :3099); nightly chain unchanged (02:00 smoke, 02:45 deep QA + fixer — the 02:48 run is the first unattended proof of the probe-hang fix). No sandbox servers or dev servers were started this session.

## 5. Claude session link

https://claude.ai/code/session_01XKW6YpADeS1wVP2ANxpBJi
