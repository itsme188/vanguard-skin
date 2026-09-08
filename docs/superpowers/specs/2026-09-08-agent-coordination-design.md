# Claude/Codex coordination helpers — design (2026-09-08)

Owner: Claude (worktree `../vanguard-skin-coord`, branch `claude/coordination-2026-09-08`). Reviewer: Codex.
Scope source: the user's 2026-09-08 task (six priorities). Non-goals: no new service, no daemon, no orchestration framework, no change to the session-end authorization policy, no production-data change, no deploy performed by this work.

## 0. Findings this design responds to (verified 2026-09-08)

1. The installed Claude Code (2.1.263) binary contains no `CLAUDE_FILE_PATHS`; the docs list no file-path variable. Both PostToolUse hooks in `.claude/settings.json` read it and have been silent no-ops. Hook input is stdin JSON (`tool_input.file_path`); `CLAUDE_PROJECT_DIR` exists.
2. The Stop hook runs the FULL suite at every stop through `| tail -3`, so its exit code is tail's; failures never reach Claude. Codex's parallel note asks Claude not to duplicate the full suite in Stop and to use its runner's `status` mode instead.
3. Codex docs: Codex loads at most one instruction file per directory, `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`. Because this repo has an `AGENTS.md`, `CLAUDE.md` is NOT auto-loaded by Codex; the AGENTS.md sentence claiming otherwise is wrong.
4. No lock protects landing/deploying. On 2026-09-06 two agents deployed within 90 minutes of each other; the same day two concurrent browser smokes contended (blank browser session; serial rerun passed).
5. Live coordination state is spread across `docs/CODEX-CLAUDE-COORDINATION.md` (a 100-line append log), two handoff files, `/private/tmp/*.md` notes and memory. There is no place that answers "who owns what right now, on which port, at which commit".
6. macOS has no `flock`; `mkdir` is atomic on the local filesystem; `python3` 3.9 and `jq` are present; `shellcheck` is not.

## 1. Shared location

All coordination state lives in ONE directory shared by every worktree of the repo:

    PD_COORD_DIR = ${PD_COORD_DIR:-$(git rev-parse --git-common-dir)/portfolio-desk-coord}

`git rev-parse --git-common-dir` resolves to `/Users/Yitzi/code/vanguard-skin/.git` from the main checkout, from `../vanguard-skin-qa-fix`, from `/private/tmp/portfolio-desk-*` and from `.claude/worktrees/*` alike, so there is exactly one register with no per-branch copies and nothing to commit. `PD_COORD_DIR` overrides it (tests use a temp dir). The bundle gate already excludes `.git/**` from the Electron package.

Layout:

    portfolio-desk-coord/
      tasks/<task-id>.json          one file per task, written atomically (temp + rename)
      tasks/archive/<task-id>.json  explicit archive only
      locks/<lock-name>/owner.json  mkdir-atomic lock directories
      history.log                   append-only audit line per mutation
      deploys.log                   one line per deploy wrapper run
      sandboxes/<task-id>/          DB copy, session.env, server.pid, server.log
      evidence/<task-id>/<stamp>/   smoke evidence (screenshots + summary.md)
      logs/                         hook + wrapper logs

## 2. Task register (`scripts/coord/coord.py`, entry `scripts/coord/coord.sh`)

Python 3 stdlib only (`/usr/bin/python3`); no npm startup cost so hooks and shell wrappers can call it in well under a second.

Task record (JSON):

    id, owner (claude|codex|user|nightly-qa|<free text>), branch, worktree, owned_paths[],
    port, browser_session, status (planned|active|blocked|review|landed|abandoned),
    last_checkpoint {at, note}, tested_commit, evidence, next_action,
    handoff (path to the Markdown handoff that holds reasoning), pid (optional owner process),
    created_at, updated_at, heartbeat_at

Commands (all print human text; `--json` prints the record):

    coord.sh task register --id ID --owner O --branch B --worktree PATH [--paths a,b] [--port N] [--browser-session S] [--handoff PATH] [--pid N]
    coord.sh task checkpoint ID --note TEXT [--tested-commit SHA] [--evidence PATH] [--next TEXT] [--status S]
    coord.sh task heartbeat ID
    coord.sh task show ID [--json]
    coord.sh task list [--all] [--stale-after 6h] [--json]
    coord.sh task release ID --by WHO --reason TEXT      # sets status=abandoned, keeps the file, logs prior owner
    coord.sh task archive ID                              # moves the file to tasks/archive/; refuses while status is active
    coord.sh status                                       # tasks + locks in one screen

Staleness is DETECTED, never acted on: `list` marks `STALE` when `status` is active/blocked and `heartbeat_at` (falling back to `updated_at`) is older than `--stale-after`; `WORKTREE-MISSING` when the worktree path no longer exists; `OWNER-GONE` when `pid` is recorded and not alive. Nothing is deleted; `release` and `archive` are explicit and logged. Markdown handoffs remain the place for reasoning and decisions; the register holds state only.

Atomicity: every write serializes the record to `tasks/<id>.json.tmp-<pid>` and `os.replace`s it. Two agents updating DIFFERENT tasks never touch the same file; updating the SAME task is last-writer-wins by design (one owner per task).

## 3. Named locks (same CLI)

    coord.sh lock acquire NAME --task ID [--owner O] [--ttl 90m] [--note TEXT] [--wait 300]
    coord.sh lock release NAME --task ID [--force --reason TEXT]
    coord.sh lock status [NAME] [--json]
    coord.sh lock run NAME --task ID [--ttl 90m] [--wait N] -- CMD ARGS...

- `acquire` = `os.mkdir(locks/NAME)` then write `owner.json` {name, owner, task, pid, host, acquired_at, ttl_seconds, note}. The mkdir is the atomic step; a second acquirer fails with exit 75 and the holder's record on stderr (and stdout as JSON with `--json`).
- Stale = TTL expired AND (no pid recorded OR pid not alive). `acquire --break-stale` may break ONLY a stale lock and logs the broken record to `history.log`. A live lock is never broken by the tool; the operator must `release --force`, which is also logged with `--reason`.
- `release` succeeds only for the same task id (or `--force`). `run` acquires, executes the command via `subprocess`, releases in a `finally`, and exits with the child's exit code (signals map to 128+n).
- Same-task re-acquire is idempotent by default (a wrapper may re-enter its own lock). `--exclusive` disables that: the smoke and deploy wrappers use it so two concurrent RUNS of one task still serialize — the live proof on 2026-09-08 showed two same-task smokes sharing one browser session (the exact 09-06 failure shape) until this flag existed.
- Conventional names: `integration` (merge/push into main, any branch switch of the main checkout), `deploy` (Electron build + install), `browser` (agent-browser daemon; every smoke run), `app-3099` (anything that restarts or exercises the installed app), `tws` (anything that opens client id 1), `sandbox:<worktree-basename>` (Turbopack is single-writer per directory).
- Session-end policy is unchanged. Authorization to integrate/deploy does not override a lock held by another task; the wrapper reports the holder as the blocker, exactly as the checklist already requires for "another agent is landing or deploying".

## 4. Deploy wrapper (`scripts/coord/deploy.sh`, `npm run deploy`)

Wraps the EXISTING chain (`npm run electron:pack` → `node scripts/verify-bundle.js` → `npm run electron:install`); adds no new build step.

Preflight (each failure is a distinct message + non-zero exit; `--dry-run` stops here):
1. Repo root == `PD_MAIN_CHECKOUT` (default `/Users/Yitzi/code/vanguard-skin`) and branch == `main`.
2. Working tree clean (`git status --porcelain` empty). No stash/reset/checkout is ever performed.
3. Intended commit: `git fetch origin main` then HEAD == `origin/main`, or `--commit SHA` == HEAD. `--allow-unpushed` downgrades the pushed check to a warning (the user must say so).
4. Clean build input: `workers/cron/.wrangler` absent (tracer leak), `dist/` will be removed by `electron:build` (nothing to do), `.next/standalone` from a previous build is acceptable because `next build` rewrites it; `node_modules/.bin/next` present.
5. TODO reconciled: same rule as `.claude/hooks/check-todo-reconciled.sh` (commits since the last `docs/plans/TODO.md` commit).
6. Toolchain: `/opt/homebrew/opt/node@24/bin/node` present; `APPLE_API_KEY*` present or a WARN "notarization will be skipped".
7. Locks: refuse if `integration` is held by another task; acquire `deploy` (TTL 45 m) for the run.

Run: `set -o pipefail`; each step logs to `$PD_COORD_DIR/logs/deploy-<stamp>.log` through `tee`; the step's own exit status (`PIPESTATUS[0]`) is preserved and the wrapper exits with it on the first failure.

Post-verify (any failure exits non-zero and says which check):
- built BUILD_ID (`dist/mac-arm64/Vanguard Dashboard.app/Contents/Resources/standalone/.next/BUILD_ID`) == installed BUILD_ID (`/Applications/Vanguard Dashboard.app/Contents/Resources/standalone/.next/BUILD_ID`);
- `codesign --verify --deep --strict` on the installed app;
- `http://127.0.0.1:3099/login` answers 200 containing `Portfolio Desk` within 120 s.

Record: append `stamp commit built_id installed_id result` to `deploys.log`; `task checkpoint <task> --tested-commit HEAD --evidence <log>` when `--task` is given.

Test seams (env, documented in the script header): `PD_MAIN_CHECKOUT`, `PD_DEPLOY_CHAIN` (a script that replaces the three npm steps), `PD_INSTALLED_APP` (path of the installed `.app`), `PD_BUILT_APP` (path of the built `.app`), `PD_DEPLOY_HEALTH_URL`, `PD_SKIP_FETCH=1`. Tests build a temp git repo with a fake TODO/main and fake `.app` dirs, and assert: dirty tree refused; unpushed HEAD refused; `integration` held by another task refused; a fake chain exiting 7 makes the wrapper exit 7 with the `deploy` lock released; BUILD_ID mismatch fails post-verify; `--dry-run` runs no chain.

## 5. Task-scoped sandbox (`scripts/coord/sandbox.sh`)

    sandbox.sh up   --task ID [--worktree PATH] [--port N] [--db-source PATH]
    sandbox.sh down --task ID
    sandbox.sh status [--task ID]

- Refuses to start a second dev server for the same worktree directory: takes `sandbox:<worktree-basename>` and holds it for the sandbox lifetime (released by `down`).
- Data isolation: `sqlite3 "$DB_SOURCE" "VACUUM INTO '$PD_COORD_DIR/sandboxes/ID/vanguard.db'"` (default source = the live DB, read-only point-in-time copy — the recipe the nightly QA already uses); the server only ever sees the copy via `DATABASE_PATH`. A `--db-source` that is not a `.db` file is refused.
- Session: `scripts/mint-qa-session.ts --db <copy>` → `sandboxes/ID/session.env` (`VGS_SESSION=`, `VGS_CSRF=`), minted into the COPY only.
- Port: `--port`, else the task's registered port, else the first free port in 3090–3096 (3097 nightly QA, 3099 app, 3000 the user's dev server are never chosen). The chosen port is written back to the task record.
- Secret-free by construction: `nohup env -i HOME USER TMPDIR PATH=<node24> DATABASE_PATH APP_EXTRA_HOSTS=localhost:P,127.0.0.1:P APP_EXTRA_ORIGINS=http://localhost:P,http://127.0.0.1:P ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real npm run dev -- -p P` from the worktree; pid + log in `sandboxes/ID/`. Readiness: `/login` 200 within 120 s. `up` prints `BASE_URL=`, `SESSION_ENV=`, `PID=`.
- `down` kills the recorded pid only (after `ps -p` confirms it is a node process started from that worktree), removes nothing else, releases the lock.

## 6. Smoke wrapper (`scripts/coord/smoke.sh`) + additive `verify-smoke.sh` hooks

    smoke.sh --task ID [--base-url URL] [--session-env PATH] [--evidence DIR] [--wait 600]

- Serializes the one resource that cannot be isolated: acquires `browser` (waits up to `--wait` seconds, then fails with the holder printed). Two concurrent `smoke.sh` runs therefore execute one after the other.
- Resolves defaults from the task's sandbox when present (`sandboxes/ID/{server.url,session.env,vanguard.db}`), exports `VERIFY_SMOKE_BASE_URL`, `VERIFY_SMOKE_SESSION=smoke-ID`, `VERIFY_SMOKE_EVIDENCE_DIR=$PD_COORD_DIR/evidence/ID/<stamp>`, `VERIFY_SMOKE_SESSION_ENV`, `DATABASE_PATH`, then runs `scripts/verify-smoke.sh` (override `PD_SMOKE_SCRIPT` for tests) and preserves its exit code; on completion records `task checkpoint ID --evidence <dir>`.
- `scripts/verify-smoke.sh` gains four ADDITIVE, default-preserving env hooks: `VERIFY_SMOKE_BASE_URL` (skips port detection; the identity check on `/login` still runs before any credential use), `VERIFY_SMOKE_SESSION` (default `verify-smoke-$$`), `VERIFY_SMOKE_EVIDENCE_DIR` (default `qa/verify-evidence/<stamp>`), `VERIFY_SMOKE_SESSION_ENV` (when set, authenticate by setting the `vgs_session`/`vgs_csrf` cookies on `/login` instead of typing a password, so a sandbox never needs the user's password; `VERIFY_SMOKE_PASSWORD` remains the default path). Existing callers (`npm run verify:smoke`) behave exactly as before.

## 7. Claude hooks (`.claude/settings.json`, `.claude/hooks/`)

- `PreToolUse Bash` → `"$CLAUDE_PROJECT_DIR"/.claude/hooks/check-todo-reconciled.sh`, matcher widened to `*electron:deploy*|*electron:pack*|*coord/deploy*|*npm run deploy*`.
- `PreToolUse Edit|Write` → `block-db-edits.sh` unchanged (already stdin-based).
- `PostToolUse Edit|Write` → `post-edit-check.sh`: reads `tool_input.file_path` from stdin; READ-ONLY checks on that file only: `eslint` report (no `--fix` — the previous hook edited files behind Claude's back), the `security_type` case guard (NO per-edit `tsc` — Codex reply 2026-09-08: a full-project type-check per edit is slow and, filtered to one file, hides consumer regressions; type-check once at completion); exit 2 with a ≤20-line stderr only when the edited file has a finding. Skips non-TS/JS files and paths outside the project.
- `Stop` → `stop-verify.sh`: reads stdin; if `stop_hook_active` is true, exits 0 (blocks at most once per stop cycle, never loops); if `scripts/verify.sh` exists runs `bash scripts/verify.sh status --base main`, else `npm run verify:changed` (with `set -o pipefail`); full output to `$PD_COORD_DIR/logs/stop-verify-<stamp>.log`; exit 2 with the last 15 lines on stderr on a real failure, and exit 2 with a "run verification" request when the runner reports no current evidence (exit 4) — Codex parity: missing evidence must request verification once, never quietly pass; exit 3 (manual selection) is advice via `systemMessage`. Never runs the full suite.
- `permissions.allow` gains the wrapper forms (`Bash(npm run deploy*)`, `Bash(bash scripts/coord/deploy.sh*)`, node@24-prefixed variants); the `autoMode.allow` hint names the wrapper. `sandbox.excludedCommands` in the USER settings needs `npm run deploy` — outside the repo; if the classifier refuses the edit, the snippet goes in the handoff.
- `tests/coord/claude-hooks.test.ts` (source-pin + behavior): settings.json contains no `CLAUDE_FILE_PATHS`; every hook command points at an existing executable under `.claude/hooks/`; no hook command ends in `| tail`/`| head`; `post-edit-check.sh` with a crafted stdin for a temp `.ts` file containing `security_type = 'Stock'` exits 2 and names the file; `stop-verify.sh` with `{"stop_hook_active":true}` exits 0 without running anything (`PD_STOP_VERIFY_CMD=false` seam proves it was not invoked); with a failing fake command it exits 2.

## 8. Documentation (one authoritative workflow, thin adapters)

- NEW `docs/reference/coordination.md`: the daily routine, register/lock/sandbox/smoke/deploy commands, the integration-base definition (`main` in the main checkout; deploy requires HEAD == origin/main), the Codex runner interface as agreed, the hook contracts, and "what to do when a lock is held / a task is stale".
- `docs/CODEX-CLAUDE-COORDINATION.md` becomes a short live board: current ownership table (pointer to `coord.sh status`), the three protocol rules, and a "messages" section for cross-agent notes. The 2026-09-04→09-06 log moves verbatim to `docs/plans/archive/coordination-log-2026-09-04-to-09-06.md` (every decision preserved, nothing rewritten).
- `AGENTS.md`: correct the claim — Codex loads only this file at the repo root; `CLAUDE.md` is not auto-loaded while `AGENTS.md` exists; read it with a tool. Recommend (not do) the structural fix: move the CSV contract to `docs/canonical-csv-guide.md` and delete `AGENTS.md` so the fallback loads `CLAUDE.md` for both agents (CLAUDE.md is 39.8 KB, under the 64 KiB cap already configured).
- `CLAUDE.md` Workflow Rules: three lines pointing at `docs/reference/coordination.md`, the register, the locks and the deploy wrapper; Testing: one line on the Stop hook behavior. `.claude/session-end.md` step 1 (integrate under the `integration` lock) and step 7 (deploy via `npm run deploy`); `.claude/session-start.md` step 1 adds `coord.sh status`. The Codex adapters under `.agents/skills/` need no change (they point at the shared files).
- `docs/DECISIONS.md` one dated entry; `docs/plans/TODO.md` closes nothing and adds the follow-ups (AGENTS.md structural fix, user-settings snippet, Codex runner adoption in the Stop hook once landed, sibling `.claude/worktrees/*` stale dirs).

## 9. Tests and proof (temporary resources only)

- Vitest: `tests/coord/coord-cli.test.ts` (register CRUD, atomic write leaves no temp file, staleness flags, lock acquire/contention exit 75, TTL+dead-pid stale break, `run` exit-code propagation, forced release logged), `tests/coord/deploy-wrapper.test.ts`, `tests/coord/smoke-wrapper.test.ts` (fake smoke script; two concurrent runs serialize; exit code preserved; evidence dir created), `tests/coord/claude-hooks.test.ts`. All under a temp `PD_COORD_DIR`.
- Live proof (recorded in the handoff): (a) lock contention — two real `coord.sh lock acquire integration` from two shells, second refused, then `--wait` succeeds after release; (b) interrupted-task recovery — register a task with a throwaway pid, kill it, `task list` shows `OWNER-GONE`, checkpoint carries the resume pointer, second agent `release --by ... --reason`, history shows both; (c) resource isolation — one real sandbox from this worktree on a free port with its own DB copy and minted session; a second `sandbox.sh up` for the same worktree refused; `smoke.sh` runs against it under the `browser` lock while a second `smoke.sh` waits; `deploy.sh --dry-run` on the main checkout reports its preflight (expected to FAIL on the dirty `docs/HANDOFF.md`, proving the tree check) — no deploy.

## 10. Task breakdown (single owner per file)

T1 coord CLI + tests (Sonnet) · T2 deploy wrapper + tests (Opus) · T3 sandbox + smoke wrappers + verify-smoke hooks + tests (Opus) · T4 Claude hooks + settings + tests (Sonnet) · T5 docs (Claude/Fable). T2–T4 code against the CLI contract in §2–3 and run after T1 lands; T4 is independent and runs in parallel with T1.

## 11. Review fold (Codex read-only round 1, 2026-09-08 — verdict REVISE, 25 findings)

Accepted and folded into the sections above / the implementation briefs:
- Locks (F1–F6, F8): the deploy wrapper acquires `integration` then `deploy` (then `app-3099`) BEFORE preflight and holds them through post-verify; every acquisition carries a random token, `lock run` releases only its own token; the default recorded holder pid is the invoking process (parent), `lock run` records itself, `pid_start` from `ps -o lstart=` defeats PID reuse; a lock dir with missing/malformed `owner.json` is "initializing" for 60 s then stale-eligible; `release --force` refuses while the holder pid is alive (`--force-live --reason` overrides, logged); `lock run` forwards SIGINT/SIGTERM, waits, releases, exits 128+n; concurrent stale-breakers race safely; the coord dir is resolved absolute once and created mode 0700.
- Register (F9 partial): mutations on an archived task fail instead of recreating it.
- Deploy (F10–F14): pushed check AND `--commit` are independent requirements; the wrapper pre-quits the app, waits for the :3099 listener to disappear, and after install requires a NEW listener pid whose executable lives under `/Applications/Vanguard Dashboard.app` plus the BUILD_ID, codesign and `/login` checks; it never writes `tested_commit` (deploy evidence is recorded as a checkpoint note + log path, separate from test evidence); every step's status is captured immediately from `PIPESTATUS[0]` into a variable and survives the cleanup trap; the node@24 PATH is exported, not merely checked; every test seam is honoured only when `PD_DEPLOY_TEST_MODE=1`.
- Sandbox (F15–F19): dotenv keys found in the worktree's `.env*` files are pinned to empty strings in the child environment (the `qa/sandbox.sh` technique) so `env -i` cannot be bypassed by Next's dotenv loading; `TWS_HOST=192.0.2.1` (unroutable TEST-NET) blocks any TWS client-id-1 connection from a sandbox; task ids are validated (`^[A-Za-z0-9._-]{1,64}$`), source/destination are canonicalised, symlinks and aliasing refused, destination never under a `data/` directory, source opened `mode=ro`, the SQL path quoted programmatically; reserved ports (3000, 3097, 3099) are refused for every input form; after boot the wrapper verifies the LISTENER pid on the port descends from the process it started (and a unique per-boot marker path in its command line) before declaring ready; `down` kills the listener and the npm parent, waits for both, and only then releases the lock; a failed boot performs the same cleanup.
- Smoke (F20, F7 partial): `smoke.sh` runs only against a sandbox manifest (`sandboxes/ID/manifest.json`: base_url, db, pid, port) written by `sandbox.sh up`, or with an explicit `--live` (then it takes `app-3099`, uses the password path, and refuses non-loopback hosts); `verify-smoke.sh` under a wrapper-provided session closes only its own session and skips the shared `close --all` cleanup (`VERIFY_SMOKE_NO_GLOBAL_CLEANUP=1`) — the very behaviour behind the 09-06 blank-session contention.
- Hooks (F22–F24): settings matcher stays `Bash`, the command glob check lives in the script; Stop-hook advice is delivered as `{"systemMessage": …}` JSON on stdout (plain stderr at exit 0 never reaches Claude); a last-status file lets the once-per-cycle guard still surface an unresolved failure; `tsc --incremental false` so the hook never writes tsbuildinfo; edited-file-only results are labelled partial and a tsc tooling crash is surfaced.
- Privacy (F21): coord dir mode 0700, evidence and logs only under it (inside `.git/`, never tracked); docs state that smoke summaries and register rows are never pasted into public files. The verbatim archive was checked: it is the same text already published in git history.
- Tests (F25 subset): missing owner metadata, concurrent stale-breakers, signal forwarding, integration-held refusal, old listener still alive → deploy fails, dotenv pinning, symlinked/aliased DB destination refused, smoke without manifest refused unless `--live`, exit-code preservation at each deploy stage.

Codex reply (12:32 ET) folded after round 1: all six interface requests accepted by Codex (final `verify: result=… run=… base=…` line, `status` exits 4 for stale/missing, read-only, TODO gate widened, `--base main`); Claude side drops the per-edit `tsc` (completion-time typecheck instead) and makes runner exit 4 block once (parity with Codex's Stop hook).

Rejected or deferred (recorded, with reasons):
- F7 full adoption by the nightly QA scripts (`qa/run-qa.sh`, `qa/sandbox.sh`, `qa/lib/agent-browser-cleanup.sh`) and by interactive browser use: outside this task's scope and files; the nightly chain runs at 2 AM when no interactive session is expected. Filed in TODO.
- F9 revision-checked task updates: the policy is one owner per task; the failure mode requires two agents writing the same task, which the protocol forbids. Deferred.
- F4 process-tree supervision beyond pid + start time: a daemon would be needed; the user asked for no service. TTL bounds the damage.
- F11 proving the running server's commit from inside the app: the app exposes no build-id endpoint and adding one is production code outside this task; the listener-pid + executable-path + BUILD_ID-on-disk combination is the accepted proxy. Filed in TODO as a small follow-up (a `/api/health` build stamp).
- F23 "unverified vs passed" in the fallback (`npm run verify:changed` exits 0 for unmapped changes): a limitation of today's runner; Codex's `verify.sh status` resolves it and the hook switches automatically when that file lands.
