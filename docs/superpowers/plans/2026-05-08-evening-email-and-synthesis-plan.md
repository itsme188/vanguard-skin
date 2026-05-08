# Evening Email + Cross-Source Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Mon-Thu 7pm / Fri 5:30pm evening email that wraps the day's post-morning-digest newsletter flow with cross-source synthesis and a 2× beta Vanguard anomaly flag; apply cross-source synthesis to the morning digest as well; harden deliverability; expose per-email recipients UI.

**Architecture:** Single shared composer (`synthesize.ts`) used by both morning and evening digests, with adaptive layout (synthesis ≥5 articles, per-source <5). Mac launchd primary path + Cloudflare Worker fallback mirroring the existing morning digest pattern. Shared `last_digest_sent_at` marker provides dedup across both digests. Anomaly block fed by a nightly-refreshed beta cache (`security_betas` table); Worker fallback reads cached betas from extended R2 snapshot (schemaVersion 3) and fetches live prices via Yahoo.

**Tech Stack:** Next.js 16 + TypeScript 5, better-sqlite3 (in-memory for tests), Cloudflare Workers + KV + R2, Resend SMTP (Mac) + REST (Worker), AI SDK v6 with Cloudflare AI Gateway routing, Vitest, launchd.

**Spec:** [`docs/superpowers/specs/2026-05-08-evening-email-and-synthesis-design.md`](../specs/2026-05-08-evening-email-and-synthesis-design.md)

---

## Phase 1 — Beta Cache + Anomaly Block (Day 1)

End-state: nightly beta cache populates on the next 2am snapshot; `lib/digest/anomalies.ts` callable in isolation; no user-visible change.

See full Phase 1 task breakdown in the original draft. Tasks:

- **Task 1.1**: Migration 048 — `security_betas` table (test-driven, full SQL provided in spec §11.1)
- **Task 1.2**: Beta cache read query `getCachedBeta` + `getCachedBetasForSymbols` in `lib/queries/security-betas.ts`
- **Task 1.3**: Beta cache write mutation `upsertBeta` + `deleteBetasForSecurity` in `lib/mutations/security-betas.ts`
- **Task 1.4**: Nightly beta-refresh script `scripts/refresh-vanguard-betas.ts`, chained into existing 2am snapshot plist
- **Task 1.5**: Anomaly block `lib/digest/anomalies.ts` (algorithm in spec §7.1, render format in spec §7.3)

Each task follows TDD: failing test first, run-to-fail, minimal implementation, run-to-pass, commit.

## Phase 2 — Cross-Source Synthesis (Day 2)

End-state: morning digest renders synthesis layout when ≥5 articles; per-source preserved in `<DigestEmailViewer>` toggle and as <5 articles fallback.

- **Task 2.1**: New feature key `dailyDigestSynthesis` in `lib/ai/feature-keys.ts` + `FEATURE_MODELS` entry pointing to `anthropic/${SONNET_MODEL}`
- **Task 2.2**: Promote `stripModelPreamble` from `lib/digest/send-earnings-email.ts` to `lib/ai/strip-preamble.ts` shared helper
- **Task 2.3**: Synthesis composer `lib/digest/synthesize.ts` (prompt structure in spec §6.2, defense in §6.3)
- **Task 2.4**: Adaptive layout `generateDigestSinceAdaptive` in `lib/digest/daily-digest.ts` with synthesis-fallback observability counter (spec §15)
- **Task 2.5**: Switch morning digest in `lib/digest/send-digest.ts:116-118` to use `generateDigestSinceAdaptive`

## Phase 3 — Deliverability Hardening (Day 3)

End-state: outbound emails carry `List-Unsubscribe` + `List-Unsubscribe-Post` + `Message-ID` + `Reply-To` headers. DNS audited. Reply-To routing verified.

- **Task 3.1**: DNS audit (read-only) — `dig` checks for DKIM/SPF/DMARC/MX. Document in `docs/email-deliverability-audit-2026-05-08.md`
- **Task 3.2**: Cloudflare Email Routing rule for `replies@myportfoliodesk.com` → user's primary inbox; verify with test reply. **Fallback if Cloudflare routing setup is out-of-scope this session** (per spec §9.5 option 2): default `Reply-To` to the user's personal email instead. The `lib/email.ts` change in Task 3.3 already supports a `REPLY_TO_ADDRESS` env-var override — set it to the personal address as a safe fallback while routing is being arranged. Don't ship the `replies@` address in headers without a working route — recipients hitting a black hole is worse than a slightly-leaked personal email
- **Task 3.3**: Add `List-Unsubscribe`, `List-Unsubscribe-Post`, `Reply-To`, `Message-ID` headers to `lib/email.ts::sendEmail` (Mac side)
- **Task 3.4**: Mirror in `workers/cron/src/resend.ts` (Worker side)
- **Task 3.5**: `wrangler deploy` + force-fire fallback to verify headers present in actual sent email; monitor 48h

## Phase 4 — Evening Email Mac Primary Path (Day 4)

End-state: Mon-Thu 7pm + Fri 5:30pm evening email fires from Mac. No Worker fallback yet.

- **Task 4.1**: Composer `lib/digest/send-evening.ts` mirroring `send-digest.ts` shape (race-guard, skipMarkerUpdate, EveningSendError class). Calls `generateDigestSinceAdaptive(db, sinceSnapshot, { includeAnomalies: true })`
- **Task 4.2**: Cron-authenticated route `app/api/cron/evening/route.ts`, plus extending `lib/cron/marker-check.ts` and `lib/cron/running-marker.ts` to accept `"evening"` type
- **Task 4.3**: launchd wrapper `scripts/send-evening-email.sh` mirroring `scripts/send-daily-digest.sh` (retry × 3, 120s backoff)
- **Task 4.4**: launchd plist `~/Library/LaunchAgents/com.vanguard-skin.evening-email.plist` with 5 StartCalendarInterval entries (Mon-Thu 19:00, Fri 17:30); commit a copy to `docs/launchd/`
- **Task 4.5**: Manual smoke (`curl POST /api/cron/evening`) + observe one full Mon-Thu cycle via `tail ~/Library/Logs/vanguard-evening-email.log`

## Phase 5 — Worker Fallback + R2 Snapshot Schema v3 (Day 5)

End-state: evening email fires reliably even when Mac is off.

- **Task 5.1**: Bump R2 snapshot to schemaVersion 3 in `scripts/snapshot-state-to-r2.ts` (add `vanguardHoldings`, `securityBetas`, expanded `settings` per spec §8.1). Run snapshot manually + verify in R2
- **Task 5.2**: Widen Worker `JobType` union in `workers/cron/src/dedup.ts` to include `"evening"`. Update `primary.ts`, `index.ts` callsites
- **Task 5.3**: Worker fallback `workers/cron/src/fallback-evening.ts` mirroring `fallback-digest.ts` shape — reads schemaVersion 3 snapshot, fetches articles via Gmail REST, computes anomaly block from cached betas + Yahoo `last 2 closes`, synthesizes via AI Gateway, sends via Resend REST. Graceful v2 degrade (no anomaly block)
- **Task 5.4**: Add 4 cron triggers to `workers/cron/wrangler.toml`: `0 23 * * MON-THU` (summer), `0 0 * * TUE-FRI` (winter day-shift), `30 21 * * FRI` (summer), `30 22 * * FRI` (winter). Add expected-hour vars
- **Task 5.5**: Update Worker dispatcher in `workers/cron/src/index.ts::scheduled`/`parseJobFromClock` for evening dispatch; add `getCurrentETMinute` helper to `dst.ts` for Friday's 30-minute slot. Note: `dst.ts` currently only exposes hour-level helpers (`getCurrentETHour`, `getCurrentETDayOfWeek`) — `getCurrentETMinute` is a NEW helper, not a rename. Mirror the existing pattern: `parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", minute: "2-digit" }).format(new Date()), 10)`
- **Task 5.6**: `wrangler deploy` + `/internal/trigger?type=evening&fallbackOnly=true&dryRun=true` smoke; then live; then end-to-end test that Mac primary + Worker fallback don't double-send (mac-sent marker takes precedence)

## Phase 6 — Recipients UI (Day 6)

End-state: Settings UI lets user override per-email recipients; Worker reads from snapshot.

- **Task 6.1**: `lib/queries/email-recipients.ts::getRecipientsFor(db, "briefing"|"digest"|"evening")` — parses comma-separated settings value, returns null when absent. Wire into `send-evening.ts`, `send-digest.ts`, `send-briefing.ts` with env-var fallback
- **Task 6.2**: Settings UI section in `app/dashboard/components/SettingsModal.tsx` — three text fields (Sunday Briefing, Morning Digest, Evening Email). New `app/api/settings/email-recipients/route.ts` GET/PATCH
- **Task 6.3**: Mirror snapshot-recipients-read pattern in `fallback-digest.ts` and `fallback-briefing.ts` (already wired in `fallback-evening.ts` from Phase 5)
- **Task 6.4**: End-to-end integration test `tests/integration/evening-email-end-to-end.test.ts` — alerts + anomaly + synthesis sections render, no $/share leaks (privacy compliance). **Sequencing flexibility**: this test asserts components from Phases 1, 2, and 4. An implementer with appetite for confidence-as-they-go can move this test up to end of Phase 4 (after `send-evening.ts` lands) — both placements are valid. Phase 6 placement keeps this plan's structural neatness; end-of-Phase-4 placement gives faster feedback before Worker work starts

---

## Final verification checklist

- [ ] `npx vitest run` — full test suite green (target: 1520+ tests, original baseline + new)
- [ ] `cd workers/cron && npx vitest run` — Worker tests green
- [ ] `cd workers/cron && npx wrangler deploy` — successful deploy with 9 cron triggers
- [ ] `launchctl list | grep vanguard-skin` — shows `com.vanguard-skin.evening-email`
- [ ] One Mon-Thu evening cycle observed (look at `~/Library/Logs/vanguard-evening-email.log`)
- [ ] One Fri 5:30pm cycle observed
- [ ] Worker fallback verified by stopping the dev server before a scheduled cycle (or via `/internal/trigger?type=evening&fallbackOnly=true`)
- [ ] Inbox check: no $ amounts, no share counts in any rendered email body
- [ ] Settings UI saves per-email recipients and the cron path respects them
- [ ] Cloudflare AI Gateway dashboard shows `feature=dailyDigestSynthesis` calls with reasonable cost/latency/error rates

---

## Detailed task breakdowns

The full TDD step-by-step (failing test code, expected output, implementation code, exact commit messages) for every task above is preserved in the spec's referenced file paths and in the linked CLAUDE.md sections. Implementer should:

1. Read the spec section that corresponds to each task (e.g., Task 4.1 → spec §5.2 race-condition guards; Task 5.3 → spec §8.3 fallback flow pseudocode).
2. Read the existing-pattern files listed in spec §17 References before writing the new code (especially `send-digest.ts` for race guards, `send-earnings-email.ts` for AI prompt discipline, `fallback-digest.ts` for Worker fallback shape).
3. Follow TDD strictly: write failing test → run-to-fail → minimal implementation → run-to-pass → commit.
4. After each phase, run the full test suite (`npx vitest run`). Target: zero regressions.
5. Each phase ends in a shippable state — pause is safe.

If the implementer wants the verbose TDD-step-by-step for any task, expand it from the structured task list above using the spec references; the structure has been kept compact here to honor the writing-plans skill's preference for actionable per-task sketches over multi-thousand-line scripts. The spec is the source of truth for algorithms, prompt text, and edge cases; this plan is the source of truth for sequencing, file paths, and commit boundaries.

---

## References

- Spec: `docs/superpowers/specs/2026-05-08-evening-email-and-synthesis-design.md`
- CLAUDE.md sections: "Earnings emails", "Workers Cron hybrid (Phase 4)", "Calendar Living Record", "AI model routing"
- Existing patterns to mirror:
  - `lib/digest/send-digest.ts` (race-condition guards, marker dance)
  - `lib/digest/send-earnings-email.ts` (`stripModelPreamble`, web_search disabling, prompt discipline)
  - `workers/cron/src/index.ts::runJob` (primary-then-fallback marker dance)
  - `workers/cron/src/fallback-digest.ts` (R2 snapshot reading + Gmail REST + synthesis via AI Gateway)
  - `app/dashboard/components/SettingsModal.tsx` (existing earnings settings section as UI precedent)
