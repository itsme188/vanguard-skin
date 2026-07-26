# QA Auto-Fix Pipeline — Design

**Date:** 2026-07-26
**Status:** Approved (brainstorm session 2026-07-26)
**Problem:** The nightly deep-QA sweep finds and dedupes bugs into `qa/findings/ledger.json`, but fixes strand: `qa-deep-fixes-*` branches never merge (import-NaN fix sat unmerged while the finding re-reported), judgment-call findings accumulate re-confirmation notes for weeks (drawer z-index bug had its exact fix written in the ledger since 7/23), and repeat findings get closed as fake non-repro flips. The pipeline finds problems; nothing reliably turns them into shipped solutions.

## Decisions locked in brainstorm

| Question | Decision |
|---|---|
| End state | Fix + review gate — but **LOW-severity fixes auto-merge to main**; MEDIUM/HIGH go to a sanitized PR the user merges |
| Trigger | Chained after the nightly deep sweep (same launchd run), plus invocable on demand as `/qa-fix-findings` |
| Fix scope | All open findings except those requiring a product/data-source decision (`needs-decision` — proposed options written to ledger, never auto-fixed) |
| Delivery | Auto-merge lows (plus higher-severity findings whose ledger note already prescribes the exact fix — see Merge gate); sanitized GitHub PR for the rest (public repo — no dollar values, positions, or screenshots in PR bodies) |
| Deploy | Auto `electron:deploy` after any auto-merge, so the next sweep verifies against the fixed build |

## Architecture (Approach B from brainstorm)

A separate `/qa-fix-findings` skill invoked by a second headless `claude -p` run, chained by `qa/nightly-deep-qa.sh` after the sweep's run-log verification succeeds. Not an extension of `/qa-deep-sweep` (context exhaustion risk, a fix-phase crash must never corrupt sweep results) and not a parallel Workflow fan-out (findings overlap surfaces; headless parallelism is structurally blocked by shared MCP servers).

### Nightly flow

```
02:45  deep sweep (unchanged) → ledger.json updated, run log written
  ↓ on verified sweep completion (run-log check passes)
       fixer: headless `claude -p "/qa-fix-findings"` (own pick_model probe, own log)
  ↓
       anti-strand check → classify → fix (cap 4/night, worktree) → test gate → split:
         LOW + green        → merge to main
         MEDIUM/HIGH + green → sanitized PR on qa-auto-fixes-YYYY-MM-DD
         needs-decision      → ledger tag + 2-3 proposed options, no code
  ↓ if anything merged to main
       electron:deploy (headless; APPLE_API_* sourced from ~/.zshrc)
  ↓
       Pushover summary: merged+deployed / PR awaiting review / needs-your-call counts
       sandbox down
```

All stages complete well before the 08:40 pmset wake and the 08:45 digest window, so the deploy's Electron restart cannot collide with email crons.

### Components

1. **`.claude/skills/qa-fix-findings/SKILL.md`** — the fixer skill. Reads `qa/findings/ledger.json`, executes the classify → fix → gate → deliver loop. Invocable interactively (`/qa-fix-findings`) and headless. Supports `QA_FIX_DRY_RUN=1` (classify + write dispositions only, no code changes).
2. **`qa/nightly-deep-qa.sh` extension** — after the existing run-log verification block: a second `pick_model` + `claude -p "/qa-fix-findings"` invocation with its own exit-status + output-artifact check and `notify_failure` on every abort path. Sweep failure ⇒ fixer does not run.
3. **Ledger schema additions** — per-finding fields written by the fixer: `disposition` (`auto` | `needs-decision` | `needs-repro`), `fix_commit`, `fix_status` (`merged` | `pr-open` | `merged-awaiting-deploy`), `decision_options` (array of proposed choices for needs-decision items).
4. **`qa/deep-qa-config.json` additions** — `fixer: { enabled, maxFixesPerNight: 4, autoMergeSeverities: ["low"], dryRun }`.

### Classification (the judgment layer)

Every open finding gets exactly one disposition per run, written to the ledger:

- **`auto`** — root cause knowable from code + ledger notes; the fix does not change product behavior beyond what the finding describes. Examples from the current ledger: drawer `z-[55]` (fix precedent named in notes), EarningsView unfiltered `earningsTimeline` prop (root-caused by zone agent), What-if `<ScrollFade>` wrap (app convention), week-ahead `isPlausibleEarnings` guard (two sibling surfaces already apply it).
- **`needs-decision`** — fixing requires choosing between product alternatives. Examples: 52wk-range source (refresh bars vs reconcile to quotes vs as-of label), income table (add Fees column vs relabel Net). The fixer writes 2-3 concrete options with a recommendation into `decision_options` and never writes code for these.
- **`needs-repro`** — symptom not reproducible in this run's environment. Left untouched; no status flip. Non-repro closure is exclusively the sweep's job — the fixer never closes a finding it didn't fix.

Severity does not determine disposition: a HIGH can be `auto` (the drawer bug); a LOW can be `needs-decision`.

### Fix protocol (per finding, in disposition order: HIGH→LOW within `auto`)

1. Work happens in a **git worktree** off `main` (sibling directory, never the live checkout — parallel-session rule). One worktree for the night, one commit per finding.
2. TDD-first where the finding is testable (superpowers:test-driven-development); browser-symptom findings verify via agent-browser against a **dev server booted from the fix worktree** (port :3096, copy of the sandbox DB, env pinned to empty like `sandbox.sh` — the :3097 sandbox serves the *deployed* build and cannot verify new code).
3. 2-attempt rule (global working rule): a finding that resists two fix attempts gets a ledger note describing what was tried and is left for a human session. No third attempt.
4. Commit message cites the finding id + one-line root cause. No dollar values in commit messages (public repo).

### Merge gate

Auto-merge to main requires ALL of:
- Severity LOW, **or** the ledger note already prescribes the exact fix (the "fix precedent named" class);
- Full `npx vitest run` green + `tsc` clean (and Worker tests if `workers/` touched);
- Browser verification confirms the specific symptom is gone on the worktree dev server;
- The fix touches no migration, no email send path, and no data-write path (hard exclusions — those always go to PR).

Everything else: cherry-picked onto one branch `qa-auto-fixes-YYYY-MM-DD`, pushed, one PR per night. PR body lists finding IDs + generic one-line descriptions only — no dollar values, positions, or screenshots (findings artifacts are gitignored because the repo is public; the PR must honor the same rule). PRs are never auto-merged and never force-pushed.

### Anti-strand guard (first step every run)

Before classifying anything, the fixer:
- Lists unmerged `qa-auto-fixes-*` and `qa-deep-fixes-*` branches and open QA PRs;
- Skips re-fixing any finding whose fix already sits unmerged (the import-NaN lesson);
- Includes the stale list in the Pushover summary every night until merged.

This makes the existing "QA fix branches must land" memory executable.

### Ledger honesty contract

- `status: fixed` is written **only with a `fix_commit` hash** — the anti-bounce discipline, enforced by the tool that writes the status.
- Auto-merged but deploy failed ⇒ `fix_status: merged-awaiting-deploy`, so the next sweep's re-reproduction on the stale deployed build is not read as a regression.
- `needs-decision` items surface in the Pushover summary and are listed in a short `qa/findings/DECISIONS-PENDING.md` for session-start pickup.

### Deploy stage

Runs only when ≥1 fix auto-merged. `npm run electron:deploy` with `source ~/.zshrc` (APPLE_API_* live there, not `.env.local`). Failure: Pushover + `merged-awaiting-deploy` statuses; main stays merged (never roll back a correct merge over a packaging failure).

### Safety rails

- Per-night cap `maxFixesPerNight: 4` bounds cost and blast radius.
- Fixer never touches the real `data/vanguard.db`; dev-server verification uses a sandbox DB copy with the env allowlist pinned empty (no outbound email/push possible from verification).
- Every abort path Pushovers (`notify_failure` pattern) — silence is the historically proven failure mode.
- The launchd chain is armed only after ≥2 supervised interactive runs of `/qa-fix-findings` (first run in dry-run mode against the current 13 findings to audit its classification judgment).

## Error handling

| Failure | Behavior |
|---|---|
| Sweep fails / no run log | Fixer skipped entirely (existing notify_failure fires) |
| No callable model | notify_failure, exit — same as sweep |
| Fix attempt fails twice | Ledger note, finding left open, next finding attempted |
| Test suite red after a fix | Fix reverted in worktree, ledger note, counts as a failed attempt |
| Push/PR creation fails | Branch left local, Pushover names it (deliberate stranding is still visible stranding) |
| Deploy fails | merged-awaiting-deploy + Pushover; no rollback |
| Fixer crashes mid-run | Worktree left intact for inspection; per-finding ledger writes are checkpointed after each finding (sweep's checkpoint pattern), so completed work survives |

## Testing

- **Skill logic:** dry-run mode against the live ledger (13 findings) — user audits dispositions before any code path is trusted.
- **Supervised runs:** ≥2 interactive `/qa-fix-findings` sessions before arming the nightly chain.
- **Shell:** `bash -n` gate on the `nightly-deep-qa.sh` edit (bash-3.2 heredoc rule); the chain addition follows the existing pick_model/notify_failure idioms verbatim.
- **E2E watch:** first armed night — verify Pushover summary arrives, PR is sanitized, ledger statuses carry commits, and the following night's sweep closes a deployed fix with evidence.

## Out of scope

- Parallel fix agents (structurally blocked; revisit only if nightly volume outgrows the cap).
- Auto-merging MEDIUM/HIGH severities.
- The fixer making product decisions (permanently out — that is the `needs-decision` boundary).
- Fixing findings in `wontfix` status.
