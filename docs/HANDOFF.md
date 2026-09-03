# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-03 afternoon (11:36 → ~16:00 ET, kept open through the ZS 16:05 ET live print). Focus: live print v2 **slice B** built subagent-driven in a sibling worktree, plus three session-start quick items; the ZS print watched in-session on the DEPLOYED (slice A) app.

## 1. Goal + exact files changed

**Branch `print-v2-slice-b` (sibling worktree `../vanguard-skin-print-v2-b`, 34 commits over `main` `18c3188`, PUSHED UNMERGED — final HEAD in §4).** Plan: `docs/superpowers/plans/2026-09-02-live-print-v2-slice-b.md`; spec §4.2. New: `lib/db/code-migrations.ts` (static registry of `.ts` migrations), `lib/db/migrations/089_print_watch_document_identity.ts` (content-identity rebuild + five sidecar tables), `scripts/migrate-089-document-identity.ts` (`--rehearse` / `--live` runner with hardened gates), `lib/print-watch/{ssrf,url-fetch,gate,delivery,pdf,roads,ir-page-adapter,ir-baseline-step,register,merge-handler,candidate-fate}.ts`, `app/api/print-watch/sources/route.ts`, tests under `tests/db/`, `tests/print-watch/`, `tests/api/`. Modified: `lib/db/migrate.ts`, `lib/print-watch/{hardened-fetch,types,store,watcher,extract}.ts`, `app/api/print-watch/{drop,status}/route.ts`, `lib/earnings/registry-bootstrap.ts` (the one slice-A file the plan's integration task permits: enables `registerPrintWatch()`), `app/dashboard/today/PrintWatchPanel.tsx` (two outcome branches + the `ir` ladder rung only), `docs/DECISIONS.md` (PDF-pair pre-registered gate; slice B deviations), `docs/reference/earnings-pipeline.md` §Print-watch (v2 roads, identity, 089 cutover order), `tests/earnings/registry-bootstrap.test.ts` (four steps → five).

**On `main` this session:** `4809db6` `qa/nightly-qa-cron.sh` — the 2 AM smoke runs once per night (archived report = per-day marker; it had run twice nightly since 2026-06-01 because the 10-minute ET gate admits two 5-minute launchd ticks) and its dead `claude -p` auto-fix block is removed (dead since 2026-05-30 — `~/.local/bin` never on that PATH; had it run it would have switched the MAIN checkout to a `qa-fixes` branch at 2 AM; the 02:45 deep-QA chain owns auto-fix). `ce36267` `docs/plans/TODO.md` reconciled. This handoff.

Live-data actions (no code): the orphan RBRK `earnings_worksheet_flags` row on superseded event 1510 deleted (cloud_outbox generation unchanged — the expected no-op); ten QA-ledger rows flipped `branch-unpushed` → `merged` for PR #62's commits (ledger is gitignored; backup beside it).

## 2. Tests / E2E / deploy result

- Branch, per task: 13 task-scoped reviews (opus for transactions/migration/watcher, sonnet for pure modules) + 8 fix rounds; controller verification at every wave HEAD. Whole-branch review (session model): no Critical, 6 Important → ONE fix wave (7 commits) → scoped re-review: all 20 findings addressed; one new Important — a literal NUL byte typed as the slot separator in the new `lib/print-watch/candidate-fate.ts` made git treat the file as binary (invisible in diffs) — fixed as a one-byte commit by the controller after the re-reviewer ruled no semantic re-review was needed.
- Final HEAD: `npx vitest run` 663 files / **7,932 passed** / 3 fixture-gated skips / 0 failed (worktree has no `.env.local`; a dummy `ANTHROPIC_API_KEY` satisfies the three key-presence tests); scoped `tsc --noEmit` clean; `npx next build` clean with the 089 code migration present in the standalone server chunks.
- Migration: `--rehearse` on a fresh `VACUUM INTO` copy of the live DB → exit 0; documents 7 → 7 (0 merged), 79 candidates kept / 0 archived, no line changes, no missing bytes, no unreadable contracts. **Cold-start proof:** the BUILT standalone server (`node .next/standalone/server.js`, `env -i`, dummy `CRON_SHARED_SECRET`/`ELECTRON_SERVICE_CRED` — the trust-boundary instrumentation fails closed on blanks) on a copy lacking 089 applied it at first open (3 → 8 `print_watch_%` tables, `schema_migrations` row recorded).
- Sandbox E2E (worktree dev server on :3095, VACUUM copy, real Anthropic key only, no outbound mail/push, TWS never contacted): 8/8 — HTML re-drop → duplicate with a second road; PDF drop → new document, both readings weak, no new green; binary drop → 400 with the reason shown; local / http / secret-bearing URLs handled with no secret in any body; `PUT /sources` valid / SSRF / clear; GET read-only; console clean.
- **Deploy: NONE.** Not merged, no Electron rebuild, Worker untouched. The live app is the 10:41 ET build (slice A). Deliberate — see §3.

## 3. Open concerns / rejected approaches / decisions

- **089 cutover order is a hard gate (whole-branch review Important 3, verified by the cold-start proof):** `lib/db.ts` runs `runMigrations` at module load, so the packaged app applies 089 implicitly on its first launch after a rebuild — without the runner's backup / holder / missing-bytes gates. Next session: merge → quit the desktop app → `lsof` clean → `VACUUM INTO data/backups/pre-089-<stamp>.db` + `PRAGMA integrity_check` → `--rehearse` on a copy → `--live` → THEN rebuild/relaunch. Never in the other order. Recorded in `earnings-pipeline.md` and DECISIONS.md.
- **R-B7 → R-B7b (ruling revised by the whole-branch review):** the remapped-candidate fate in 089 and the merge handler is keyed on (survivor document, REPRESENTATION), not document alone. `reconcile.ts::independent` treats two representations of one document as v1's legitimate repA/repB pair; the doc-only rule would have silently downgraded those pairs to `single_source` on every future date-correction merge. One shared pure helper (`lib/print-watch/candidate-fate.ts`) now serves both.
- **R-B1 — no registry shim.** Slice A was already on `main`, so B imports the real registries and enables the bootstrap call itself; plan Task 16 folded into Task 13. The slice-A DECISIONS sentence about a shim is superseded by B's entry.
- **R-B15 — `/Encrypt` is advisory; poppler decides encryption.** The raw-byte pre-check refused owner-password-only PDFs that `pdftotext` reads fine.
- Other rulings (R-B3 route tests in a new file, R-B10/R-B16 minimal Today-panel edits, R-B11/R-B14 task splits so no file ever had two writers, R-B12 v1 HTML-sniff parity, R-B17 bootstrap test count) are in the SDD ledger (copied to `docs/private/2026-09-03-live-print-v2-slice-b-sdd/`).
- **Rejected:** a lane-wide IR refusal budget (one 403'd anchor would retire the whole road on print night — per-link stands); building the shim "because the plan says so"; enabling the smoke's dormant auto-fix by fixing its PATH (it would branch-switch the shared checkout).
- **Process incident:** an implementer ran `git reset --soft` "to probe pathspec-commit behaviour" and un-committed a sibling's commit (recovered before any loss). The worktree rules now enumerate the ONLY allowed git commands.
- **Known flake, now named:** `tests/print-watch/watcher.test.ts › IR page lane › "with a step-recorded baseline…"` fails ~1 in 3–4 block runs at both the fix-wave base and HEAD (`waitUntil: the condition never became true`); the fix belongs in the shared `waitUntil`/`flushIo` test helper. Filed in TODO.
- **Deferred minors** from the whole-branch review are filed as one TODO item (watcher.ts extraction, drop-route response-shape normalisation, archive-reason alignment, SIGKILL escalation, …).
- **ZS live print (16:05 ET, deployed slice A app):** result appended in §6 below when the watch closes.

## 4. Uncommitted changes / live-process state

- `main` clean; pushed through this handoff. Branch `print-v2-slice-b` pushed to origin at HEAD `702baaf` (unmerged; no PR opened — merge is a next-session decision after the ZS review). Worktrees: `../vanguard-skin-print-v2-b` (slice B, keep until merged), `../vanguard-skin-qa-fix` (the nightly fixer's parked worktree, leave alone).
- No dev servers running (the :3095 E2E sandbox was stopped by PID). No stray Chrome/Playwright. Electron app on :3099 = the 10:41 ET build; Worker unchanged; KV `armed-events` generation 1.
- SDD ledger/briefs/reports: `../vanguard-skin-print-v2-b/.superpowers/sdd/2026-09-02-live-print-v2-slice-b/` (git-ignored scratch) — copied to `docs/private/2026-09-03-live-print-v2-slice-b-sdd/` before the worktree is removed.

## 5. Claude session link

https://claude.ai/code/session_01GvaNmmYtnpzjprfCjuTWcL

## 6. ZS live watch (appended after the print)

_pending — the session stays open through the 16:05 ET print; this section is filled in and committed when the watch closes._
