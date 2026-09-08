# Claude / Codex coordination — the daily workflow

Authoritative shared workflow for two agents working on one Mac. Agent-specific adapters (`.claude/session-*.md`, `.agents/skills/session-*/SKILL.md`) point here; they add environment detail, never a different policy. Design and review fold: `docs/superpowers/specs/2026-09-08-agent-coordination-design.md`.

## Daily routine

| When | Command | Why |
|---|---|---|
| Session start | `npm run coord -- status` | who owns what, which port, which lock; STALE / OWNER-GONE rows are your first read |
| Start a task | `git worktree add ../vanguard-skin-<topic> -b <agent>/<topic>-<date> main` then `npm run coord -- task register --id <id> --owner <claude\|codex> --branch <b> --worktree <path> --paths <a,b> --port <n> --browser-session smoke-<id>` | declare ownership before the first edit |
| Every milestone | `npm run coord -- task checkpoint <id> --note "…" [--tested-commit <sha>] [--evidence <path>] [--next "…"]` | the other agent can resume without the user relaying history |
| Verify | `npm run verify:changed` today; `bash scripts/verify.sh changed --base main` once Codex's runner lands; full suite before landing | evidence, not confidence |
| Browser check | `npm run sandbox -- up --task <id>` → `npm run smoke -- --task <id>` → `npm run sandbox -- down --task <id>` | isolated data, own port, own browser session, serialized on the `browser` lock |
| Land (only under session-end authorization) | `npm run coord -- lock run integration --task <id> -- git -C /Users/Yitzi/code/vanguard-skin merge --ff-only <branch>` then push | exclusive integration |
| Deploy (only under session-end authorization) | `npm run deploy -- --task <id> [--commit <sha>]` | locked, preflighted, exit codes preserved, installed build verified |
| Close | `task checkpoint <id> --status landed`, write the Markdown handoff | state in the register, reasoning in the handoff |

Integration base: local `main` in `/Users/Yitzi/code/vanguard-skin` (the only checkout that lands and deploys). Deployment requires HEAD == `origin/main` (pushed) and a clean tree.

## Shared location

`PD_COORD_DIR` defaults to `$(git rev-parse --git-common-dir)/portfolio-desk-coord` — one directory shared by every worktree of the repo (main, `../vanguard-skin-*`, `/private/tmp/portfolio-desk-*`), never tracked, never bundled (the bundle gate excludes `.git/**`), mode 0700. Override only in tests. Layout: `tasks/` (one JSON per task), `tasks/archive/`, `locks/<name>/owner.json`, `history.log`, `deploys.log`, `sandboxes/<task>/`, `evidence/<task>/<stamp>/`, `logs/`.

## Task register (`scripts/coord/coord.sh task …`)

Fields: id, owner, branch, worktree, owned_paths, port, browser_session, status (planned|active|blocked|review|landed|abandoned), last_checkpoint, tested_commit, evidence, next_action, handoff, pid, timestamps. Commands: `register`, `checkpoint`, `heartbeat`, `show`, `list [--all] [--stale-after 6h]`, `release ID --by WHO --reason …`, `archive ID`, plus `status`.

Staleness is detected, never acted on: `STALE` (active/blocked with no heartbeat for 6 h), `WORKTREE-MISSING`, `OWNER-GONE` (recorded pid dead). To take over an abandoned task: read its last checkpoint and handoff, `task release <id> --by <you> --reason "…"`, register your own task, and say so on the board. Nothing deletes another agent's record; `archive` is explicit and refuses active tasks.

## Locks (`scripts/coord/coord.sh lock …`)

`mkdir`-atomic directories with an `owner.json` (owner, task, pid + process start time, TTL, token). `acquire NAME --task ID [--ttl 90m] [--wait N]`, `release NAME --task ID`, `status`, `run NAME --task ID -- CMD…` (acquire, run, release, propagate the exit code, forward SIGINT/SIGTERM). Contention exits 75 and names the holder. A same-task re-acquire is idempotent unless `--exclusive` is passed (the smoke and deploy wrappers pass it, so two runs of one task still serialize).

Names: `integration` (merge/push/branch switch in the main checkout), `deploy`, `app-3099` (anything that restarts or exercises the installed app), `browser` (the agent-browser daemon; every smoke), `tws` (client id 1), `sandbox:<worktree-basename>` (Turbopack is single-writer per directory).

Stale = TTL expired AND the recorded pid is dead (or missing metadata older than 60 s). Only `acquire --break-stale` breaks a stale lock, and it is logged. A LIVE lock is never broken by the tool: `release --force` refuses while the holder is alive; `--force-live --reason` is the operator override, also logged. Session-end authorization does not override a lock; report the holder as the blocker.

## Sandbox + smoke

`npm run sandbox -- up --task <id> [--worktree <path>] [--port <n>] [--db-source <path>]`: VACUUM copy of the live DB (read-only source) into `sandboxes/<id>/`, minted `qa` session into the COPY, `npm run dev` from the worktree on a free port in 3090–3096 (3000/3097/3099 are refused), `env -i` plus every `.env*` key pinned empty, `TWS_HOST=192.0.2.1` so no TWS connection can succeed, `APP_EXTRA_HOSTS/ORIGINS` for the port, listener pid verified before "ready", manifest written. `down` kills only its own processes and releases the lock. `status` lists sandboxes.

`npm run smoke -- --task <id>`: takes the `browser` lock (waits, then fails naming the holder), runs `scripts/verify-smoke.sh` against the task's sandbox manifest with `VERIFY_SMOKE_BASE_URL`, `VERIFY_SMOKE_SESSION=smoke-<id>`, `VERIFY_SMOKE_EVIDENCE_DIR=evidence/<id>/<stamp>`, `VERIFY_SMOKE_SESSION_ENV` (cookie login, no password), `VERIFY_SMOKE_NO_GLOBAL_CLEANUP=1` (closes only its own browser session), and records the evidence path as a checkpoint. `--live` targets the installed app on :3099 instead (takes `app-3099`, password path). Smoke summaries and register rows are never pasted into public files (they can carry counts).

## Deploy wrapper (`npm run deploy`)

Wraps the existing chain (`electron:pack` → `scripts/verify-bundle.js` → `electron:install`). Locks `integration`, `deploy`, `app-3099` first; preflight: main checkout on `main`, clean tree, HEAD == `origin/main` (and == `--commit` when given), no `workers/cron/.wrangler`, TODO reconciled, node@24 exported, notarization vars (warn if absent). Each step's exit status is captured immediately and returned unchanged; logs in `logs/deploy-<stamp>.log`. Post-verify: the old :3099 listener is gone, the new listener's executable is under `/Applications/Vanguard Dashboard.app`, built BUILD_ID == installed BUILD_ID, `codesign --verify --deep --strict`, `/login` 200 with the brand. `--dry-run` runs preflight only. Deploy evidence is recorded separately from test evidence (never as `tested_commit`).

## Hooks (Claude Code) and the shared runner

Hook input is stdin JSON (`tool_input.file_path`, `tool_input.command`, `stop_hook_active`); there is no `CLAUDE_FILE_PATHS` variable. `post-edit-check.sh` runs read-only, edited-file-only checks (eslint report, tsc filtered to the file, security_type case guard) and warns through exit 2. `stop-verify.sh` never runs the full suite: it calls `bash scripts/verify.sh status --base main` when Codex's runner exists (else `npm run verify:changed`), blocks once with the failure tail on a real failure, and delivers advice (`manual selection`, `no evidence`) as a `systemMessage`. Runner results: 0 passed / no-relevant-changes, 3 manual-selection-required, 4 stale-or-missing, anything else = real failure. "Unverified" is not "passed": the full suite still runs once before landing.

## Instruction files

Claude loads `CLAUDE.md`. Codex loads at most ONE file per directory: `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`; because the repo has an `AGENTS.md`, Codex does not auto-load `CLAUDE.md` and must read it explicitly (the AGENTS.md header says so). `.claude/session-end.md` and `.claude/session-start.md` are the authoritative checklists; the `.agents/skills/*` files are thin adapters.
