# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-18/19 — R4 donation backfill COMPLETE (all donations linked/stamped/lotted) + union-basis capacity gate fix; app-launch runaway found (OPEN, deploy deferred)

## 1. Goal + exact files changed

Goal: execute the [R4] USER-RUN residuals end-to-end (DAF import → FMV repair → match confirmation → lot assignment), fixing whatever data/code gaps surfaced.

- `lib/mutations/donation-links.ts` — union-basis capacity gate in `assignDonationLots` (commit `a21f115`): accept if EITHER current `quantity_remaining` OR as-of-donation-date availability (via `getOpenLotsForDonation`, shared not forked) covers the request. Closes the drawer-suggests/gate-rejects mismatch when post-donation sells consumed lots in a pre-assignment replay. Original basis + the 2026-08-17 no-other-donations-subtraction ruling preserved; replay clamp stays authoritative.
- `tests/mutations/donation-links.test.ts` — 2 new tests pinning both bases (45 total in file).
- `scripts/` (commit `f22fe13`, all dry-run-by-default + backup-before-write, applied live then kept for provenance): `repair-confirmed-donation-leg-amounts.ts`, `repair-ambiguous-donation-links.ts`, `repair-goog-presplit-basis.ts`, `repair-smh-presplit-basis.ts`, `assign-donation-lots-by-method.ts` (+ `tests/scripts/assign-donation-lots-by-method.test.ts`), `finish-donations.ts`, `reassign-clamped-donations.ts`.
- `docs/plans/TODO.md` — close-out block + 3 new open items (`1420be4`).

## 2. Tests / E2E / deploy result

- Full pinned suite at HEAD: **5,576 passed + 9 todo, 0 failed** (503 files; +10 over baseline). `npm run verify:changed`: 795 tests across 100 files, green.
- Live DB verification after the final apply: every stock donation has an out-link, a stamped FMV leg, and lot assignments summing exactly to donated quantity; tax-lot replay is warning-free. Per-security share arithmetic reconciles against the broker's own activity report (UBER/SMH/CIEN/APP/CEG all land on exact expected residuals).
- **Step-7 deploy: DELIBERATELY SKIPPED** (user instruction) — see the runaway in §3; a new build cannot help while every launch wedges.

## 3. Open concerns / rejected approaches / user decisions

- **OPEN, top priority: app-launch runaway.** The packaged app's `next-server` pegs a core within minutes of EVERY launch, goes HTTP-unresponsive, and holds the SQLite write lock (repair scripts SQLITE_BUSY; UI spinners hang while imports actually commit). `sample` profiles show ~100% main-thread time in libuv stream-read → JS promise-reaction handling with 4-5 concurrent Gmail IMAP connections — newsletter ingestion is the suspect, not valuation compute. A wedged orphan survived Cmd+Q once and squatted :3099 (EADDRINUSE on relaunch; killed by PID). App left CLOSED; Worker fallback covers outbound email. TODO.md entry has full evidence.
- User decisions: lot assignment derived from stated disposal methods (FIFO before 2025, Vanguard MinTax after — Vanguard's published bucket order, verified against public docs; MinTax applies its sale order to gifts, faithfully anti-optimal); UBER acquisition backfilled from the SPV sponsor's tax-estimate document (carryover basis, tacked holding period, FIFO-transfer assumption documented in the row's notes); rebuild deferred.
- Rejected approach: replacing the capacity gate's basis outright — would have flipped a deliberately-recorded design ruling (sanctioned cross-donation over-commitment test). Union relaxation chosen instead; nothing previously legal became illegal.
- Data findings for reviewers: canonical transcriptions systematically DROPPED statement "Stock split" lines (SMH + GOOG repaired product-preserving this session; AAPL/AMZN/SHOP/NFLX still-held and still wrong — filed); at least one BUY row carries a sign-flipped positive amount, and because source keys embed amount cents, a corrected duplicate can import alongside (filed, with an import-validation-warning fix shape); a batch lot-assigner must re-read drawer state between same-security writes (first version raced itself; replay clamp caught it — `reassign-clamped-donations.ts` is the corrective pattern).

## 4. Uncommitted changes / live-process state (post-session)

- Working tree clean after this handoff commit; `main` pushed through it. Open PR: **#53 (qa-auto-fixes-2026-08-18)** — the first post-repair fixer night's output, NOT yet reviewed; next session should review + land it. Fixer worktree `vanguard-skin-qa-fix` still checked out (fixer-owned).
- Live: **Vanguard Dashboard app is CLOSED on purpose** (runaway above); Cloudflare Worker is covering scheduled email sends as designed. The 2026-08-17 notarized build remains the installed binary; no rebuild this session.

## 5. Claude session link

https://claude.ai/code/session_013VdxaaHnQN1dFDzZqTfGz4
