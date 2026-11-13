**Waiting on:** USER: (1) decide who raises the two small AI output caps in another task's files (`lib/research/verify-mentions.ts`, `lib/gmail/process.ts`; registered to `pm-stop-summarizing`, PR #133), the likely cause of repeated verify-mentions parse failures in the live log; (2) answer the data question on eleven reinvestment rows still counted twice in income (two data groups, TODO (o13)). Decision records: `small-ai-output-caps-owner`, `income-unpaired-reinvestments`. CLAUDE: nothing outstanding. CODEX: nothing requested.

# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

## 1. Goal and files changed

**Session:** 2026-11-11 to 2026-11-13. **Goal:** map, cheapen, improve and debug the in-app Portfolio Assistant chat; then build the owner's rulings on chat privacy, the latest model of each class, a per-chat model picker, and a pinned desktop controls row.

**Landed:** PR #178 (branch `claude/portfolio-assistant-review-7148e7`), fast-forwarded onto `main` under the integration lock; `main` at `5db9fea0` plus this handoff commit. Detail: `docs/DECISIONS.md` 2026-11-11, 2026-11-12, 2026-11-13; plan `docs/superpowers/plans/2026-11-11-portfolio-assistant-plan.md` (review log); working reference `lib/chat/CLAUDE.md`.

**Files changed** (`git diff --stat 0eaf8703..5db9fea0`: 237 files, about 31,400 lines added, 1,900 removed), by area:
- `lib/chat/` (25 files): `tools.ts`, `system-prompt.ts`, `scope.ts`, `history.ts`, `usage-log.ts`, `ibkr-context.ts`, `conversation-title.ts`, `model-choice.ts` and `model-resolve.ts` (new), `composite/` (six composite tools), `CLAUDE.md`.
- `lib/queries/` (12): `income-sql.ts` (one income rule, 3-day pairing, maximum matching, importer sign conventions, work budget), `income.ts`, `chat-tools.ts`, `portfolio-summary.ts`, `market-snapshot.ts`, `transaction-amount-currency.ts` (new), `transactions.ts`, `security-detail.ts`, `wash-sale-replacements.ts` (new), `integrity-checks.ts`, `chat.ts`.
- `lib/ai/` (4: `model-tiers.ts`, `models.ts`, `model-catalog.ts`, `model-families.ts`), `lib/claude-request-options.ts`, `workers/cron/src/model-tiers.ts` (mirror) and its test; output-cap call sites in `lib/print-watch/`, `lib/calendar/`, `lib/earnings/`, `lib/securities/`, `lib/alerts/`, `lib/compute/`, `lib/apis/`, `lib/etf/`, `lib/trade-review/`, `lib/chart/`.
- `lib/db/migrations/103_chat_conversation_model_family.sql` (one nullable column) and `lib/mutations/chat.ts`.
- `app/api/chat/route.ts`, `app/api/chat/conversations/` routes, `app/dashboard/components/ChatInterface.tsx`, `IncomeYieldSection.tsx`.
- `scripts/chat-eval/` (17 files: golden set, scorer, runner, fixture builder v3, probe, rescore), `scripts/preprocess-to-canonical.ts`, `scripts/spike-bakeoff-parse.ts`.
- Tests: about 150 files under `tests/chat`, `tests/queries`, `tests/dashboard`, `tests/api`, `tests/ai`, `tests/scripts`, `tests/repo` and others.
- Docs: `CLAUDE.md`, `docs/DECISIONS.md`, `docs/plans/TODO.md`, `docs/reference/api-patterns.md`, `docs/reference/architecture-detail.md`, the plan.

## 2. Tests, checks and deploy

- Full suite on the merged commit: 1,702 files, 20,867 tests passed. Typecheck clean. Production build passed. Worker suite: 55 files passed. Re-run at the handoff commit: see the commit that follows or the register.
- Six live runs on the SYNTHETIC evaluation database only, under owner-approved caps (about 3.60 of 6.50 dollars on day one; 3.52 of 5.00 on days two and three). The model-request probe accepted every request shape the app sends on the 5.5 models, the chat on Haiku included; one real chat message per model class went through the UI.
- Independent reviews: per task, whole-branch, and a final pre-merge review (no blockers; two should-fix items fixed, `eb5b8190`, `62130659`).
- **Deploys (2026-11-12 evening Eastern, 2026-11-13 UTC):**
  - The Cloudflare Worker `vanguard-skin-cron` was deployed from `a7fa7b10` with the owner's explicit go-ahead.
  - The Mac app was deployed through `npm run deploy` at `5db9fea0`: notarization successful, bundle gate ok, installed BUILD_ID matches, codesign verified, the new listener on :3099 answers `/login`.
  - Migration 103 is applied on the live database (schema check only).

## 3. Open concerns, rejected approaches, decisions

1. **NEW, act on it first: verify-mentions parse failures.** The installed app's server log holds `[verify-mentions] Haiku verification failed: No object generated: could not parse the response` 232 times in the current log file; it predates this deploy. `lib/research/verify-mentions.ts` asks for a 1,024-token cap on the cheap tier. The branch's model sweep flagged exactly that caller, and `lib/gmail/process.ts` (2,048), as too small now that the current Haiku thinks by default. Both were left alone because their files are registered to `pm-stop-summarizing` (PR #133). This is the likely cause, not proven. Decision record `small-ai-output-caps-owner`; TODO top item.
2. **Eleven reinvestment rows still counted twice in income**, in two data groups: a foreign security whose reinvestment is below its dividend with no withholding row, and a cash fund with dividend rows missing. Needs the broker statements. Decision record `income-unpaired-reinvestments`; TODO (o13).
3. **Chat model tier: decided.** The default stays the workhorse tier (Sonnet 5.5), with a per-chat Haiku / Sonnet / Opus choice. A full 20-question evaluation on the final fixture and a golden run on Haiku have not been done (TODO (o10), (o18)).
4. **Liqn factor data:** a two-week trial through the owner's existing connector before any build; public data calls only (TODO (o15)).
5. **The chat has no failover to the other provider and no excluded-id retry** (TODO (F3), (o19)).
6. **Smaller open items:** the chat layout points left alone (o14); a Plaid short with no cost basis (o22); the chat income tool does not surface `pairingApproximate` (o21); the Mac app and Worker deploy together (o23).
7. **Rejected or corrected approaches a reviewer should know:**
   - The raw same-sign income rule was wrong for two importers (the Vanguard PDF and export parsers store a purchase negative); it was replaced by reading each leg through its importer's convention (`562b3c57`).
   - Greedy day-by-day pairing double counted in a rare pattern; it was replaced by maximum matching (`88b70207`), then bounded by a work budget (`eb5b8190`).
   - A check on real data cannot see shapes the data lacks: the sign-rule defect was invisible there because no real row came from those importers.
   - The regex scorer was wrong in both directions (false failures and missed errors); an independent reader is needed beside it for any evaluation run.
   - Chat privacy now means data leaving the app; the scope limits reads, not what the owner sees (owner ruling 2026-11-12, superseding the 2026-11-07 title rule and plan rulings P3, P8, P9, OPEN-7).

## 4. Uncommitted changes and live-process state (after the deploy)

- The installed app runs on :3099 at `5db9fea0`.
- No dev or test server left by this session (ports 3090 and 3095 free).
- This session's worktree `.claude/worktrees/portfolio-assistant-review-7148e7` and branch `claude/portfolio-assistant-review-7148e7` still exist; merged, safe to remove.
- Other sessions' worktrees untouched (`vanguard-skin-menu`, `-perf`, `-qa-fix`, `-todo-reconcile`); their open PRs #175, #176, #177, #179 untouched.
- No uncommitted changes from this session.

## 5. Agent identity and session link

Claude: Fable 5.2 as conductor, Opus 5.5 workers for all code, review and docs; run in the Claude desktop app's Code tab. No `claude.ai/code` session URL is available in this environment.
