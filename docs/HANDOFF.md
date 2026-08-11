# Session Handoff — for Codex review

> Rolling file, overwritten at each `/session-end`. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-11

## 1. Goal + files changed

Two workstreams: the Node runtime migration (forced by a 2026-08-10 brew batch update) and your advisory batch #41–#45, plus the three follow-ups from your own morning review message.

**(a) node@24 migration** (`fdfacaa`): the brew update moved `/opt/homebrew/bin/node` to v26 and silently broke every unpinned Node entry point overnight — QA sandbox boot (02:45 sweep died), the 02:00 R2 state snapshot (Worker fallback going stale), and the calendar-enrich/earnings-sweep road (masked by `|| true`). Changed: `package.json`/lock (better-sqlite3 12.6.2→13.0.2), `electron/main.ts` (`REQUIRED_NODE_ABI` 115→137, node@24 first candidate), PATH pins in `qa/sandbox.sh`, `qa/nightly-deep-qa.sh`, `qa/nightly-qa-cron.sh`, `scripts/run-snapshot.sh`, `scripts/enrich-calendar-events.sh`, `scripts/send-daily-digest.sh` (+ gitignored `scripts/launch-dashboard.sh`), `CLAUDE.md` testing section.

**(b) Advisory batch #41–#45**, four commits, one per fix:
- `12ff51b` (#41+#43): `lib/calendar/briefing-html.ts` + `workers/cron/src/html.ts` (`parseTableRow` splits on unescaped pipes only, unescapes `\|`; byte-identical mirrors); `lib/earnings/print-sheet.ts` (`extractBogiesTableMarkdown` validates header+separator shape with escape-aware column agreement; invalid → null → deterministic-worksheet fallback).
- `fdbd53c` (#42): `lib/earnings/worksheet.ts` + `worksheet-rich.ts` — both monospace fallback composers stop hard-slicing at page caps; overflow pages beat truncated notes (the PDF road's documented doctrine). Disclosed omissions (bogies row cap, commentary trim marker) untouched.
- `2a0919d` (#44): `lib/earnings/print-pdf.ts` — `readCompletedPdf` (close(0) path) now requires `%PDF` header + `%%EOF`; poll path gained the header check with keep-polling semantics preserved.
- `f39ec30` (#45): `lib/earnings/repair-citation-linebreaks.ts` — `BOLD_LABEL_PREFIX_RE` in `isNewBlockLine` only (labeled-prose lines never merge up, still receive trailing fragments — the asymmetry is deliberate and test-pinned).

**(c) Your morning follow-ups:** issue #36 closed with evidence (`8529729` was already on main); `.claude/session-end.md` (`78de878`) now sweeps ALL open issues against landed commits, not just the session's own fixes; privacy decisions applied (`9c2c9c2`) — split-repair guard values externalized to gitignored `data/repair-configs/split-basis-2024-year-end.json` with a schema-validating loader, test switched to synthetic targets, classifications comment softened. User chose NO history rewrite.

## 2. Tests / E2E / deploy

- Full suite: **4,677 passed / 430 files** (baseline 4,657; +20: 2 config-validation + 18 batch tests). Batch fixes were built by four parallel subagents, each with red→green TDD evidence (pre-fix repros confirmed at the exact old cap boundaries), then reviewed centrally before landing.
- Migration verification: suite run twice (before and after all edits), Electron rebuilt + notarized + deployed + `:3099` healthy, QA sandbox boots clean against the new bundle, R2 snapshot uploaded fresh (`state/vanguard-state-2026-08-11.json.gz`), dev `:3000` restarted under node@24. Notable: the R2 snapshot cron self-healed within 2 minutes of the better-sqlite3 v13 install — N-API loads under any modern Node, so the fix reached the cron before its PATH pin did.
- Live repair dry-run: the reworked split-basis script re-ran against the live DB through the new config road — all rows correctly report already-normalized (idempotence preserved).
- Deploys: Electron ×2 (morning migration build; session-end batch build — final: exit 0, installed, relaunched, health check green first probe). Cloudflare Worker ×1 (`ab8f941e`, the parseTableRow parity fix). DMG built clean twice — the Errno-28 watch item is CLOSED (3 consecutive clean notarized builds).

## 3. Open concerns, rejected approaches, user decisions

- **Migration target decision:** user delegated; chose node@24 LTS keg (supported ~2028) over re-pinning to EOL node@20 or tracking rolling node 26. The `node@25`/`node@26` opt symlinks are ALIASES into the moving keg — never pin to them. better-sqlite3 13.0.2 (not 13.0.3) was selected by the user's npm `min-release-age=7` supply-chain guard; 13.0.3 is CI-infra-only, a routine update can pick it up after 2026-08-12.
- **v12→13 was forced, not optional:** better-sqlite3 12.6.2 under Node 24 aborts the process at worker-thread teardown (native assertion in `Statement::~Statement` via `RemoveEnvironmentCleanupHook`) — 75 vitest fork crashes. v13.0.2's changelog names the exact fix.
- **#42 design:** adopted the PDF road's precedent ("print it anyway — notes never truncate to force a page count") rather than an explicit-omission marker; overflow is bounded because scratch flexes to its floor and commentary keeps its budget trim, so only real content overflows.
- **#45 kept the asymmetry:** labeled-prose lines block upward merges but remain merge targets — a genuine citation fragment continuing labeled prose is legitimate.
- **Privacy: history accepted as-is** (user decision) — one historical closed-position share count deep in commit messages didn't justify a filter-repo force-push.
- **Stale-issue candidate:** #19 (Calendar Living Record 2-week coverage check, target 2026-05-08) looks overtaken by events; flagged to the user for a close/keep call rather than closed unilaterally. #35/#34 P0s remain open and untouched.

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree: clean after the handoff commit. No open PRs. Worktree `../vanguard-skin-qa-fix` stands (deliberate, nightly fixer).
- Live: packaged app (session-end build with batch fixes + node@24) on :3099, healthy; dev server on :3000 under node@24; Worker at `ab8f941e`; QA fixer's leftover :3096 dev server from 8/10 was killed (verified stale).
- Watch items: NBIS preview should fire Wed 8/12 ~05:00–05:30 ET — the sweep cron now runs on fixed, node@24-pinned code; tonight's deep-QA sweep is the first natural test of the sandbox fix (last night's failed on the Node break — that failure, not a regression, explains the missing 8/11 run).

## 5. Claude session link

https://claude.ai/code/session_016L4UiviGMB9KrNC6wvjJPK
