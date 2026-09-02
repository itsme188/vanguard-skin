# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-02 evening — the user redirected the session-start menu to "an earnings print session". A print was landing as the session opened.

## 1. Goal + exact files changed

**Live incident (SNOW, after-close print, same-day manual add).** The print-watch window was open with zero documents 25 minutes after the wire while EDGAR already showed the 8-K accepted at 16:08 ET. Two independent lane failures, both root-caused and fixed test-first the same evening, pushed as `6628dd4`, `f691229`, `775c0ea`:

- `lib/print-watch/edgar-adapter.ts` + `tests/print-watch/edgar-adapter.test.ts` — the SEC submissions JSON reports a FRESH filing's `acceptanceDateTime` as Eastern wall-clock with a bogus `Z` and normalises it to true UTC at a later rebuild (Dell's 9/1 filing already read `20:10Z` against a `16:10` ET header; Entergy nine minutes after acceptance read Eastern-as-Z). `Date.parse` put the filing four hours early, outside the window. `pollEdgar` now prefilters on both readings without fetching and decides on the filing's own `-index-headers.html` `<ACCEPTANCE-DATETIME>` (always Eastern), which it already fetched for the exhibit list. A first fix that parsed Eastern-only was rejected mid-session after the Dell/Zscaler evidence.
- `lib/print-watch/watcher.ts`, `lib/queries/earnings-worksheet-flags.ts`, tests — `enrichSecurities` only walks HELD securities, so an unheld armed name had `ib_con_id NULL` and the panel read "DJ: no conId — wire off". The DJ lane now backfills the conId once per print through `enrichSecurities(db, [securityId])` when TWS is up (TWS down is not an attempt), and the coverage note states which of four outcomes happened.
- `docs/reference/earnings-pipeline.md` — second-live-run note; the print-watch window was also corrected to T−10 (the doc said T−30; the code and v1 spec say T−10).

**Recovery that night:** EX-99.1 fetched from EDGAR and posted to `POST /api/print-watch/drop` with a minted qa session (cookie + `x-csrf-token` + a trusted `Origin` header, which the verifier requires on every POST); parsed in 35 s; all four greened lines matched the release. Nothing was accepted or promoted on the user's behalf.

**Design work:** `docs/superpowers/specs/2026-09-02-live-print-v2-design.md`, rev 4 at `7e38653`, after a brainstorm and three read-only Codex rounds (20 + 21 + 10 findings, all folded in; rounds closed at three by user ruling). Six deployable slices (A armed-as-covered + cloud parity + merge registry + prepare steps; B document identity + PDF/URL/IR-page roads; C go action + window + scheduler; D deterministic facts + verified callouts + first-pass read; E paper sheet + canonical send service; F Today layout + Hub controller + extra metrics). User rulings in §2. `docs/plans/TODO.md` reconciled (`f060214`, `69b58b4`).

## 2. Tests / E2E / deploy result

- `verify:changed` 118 files / 1,118 tests green; full suite 615 files / 7,296 tests green before the fix commits.
- The Codex round-1 EDGAR fix went red-first (13 of 23 failing for the right reason) then green; the redesign added 5 cases (fresh form, normalised form, header overrules a lucky reading, no-fetch prefilter, header missing) → 28/28. The conId fix added 5 watcher cases + 4 query cases (red-first) → 945 across print-watch and queries.
- Electron redeploy launched 19:29 ET after the TODO reconciliation hook was satisfied; result recorded in §4 below.

## 3. Open concerns / rejected approaches / decisions

- **Rejected:** Eastern-only parse of the EDGAR JSON (would miss any filing already normalised to UTC); requiring two independent documents for callouts (wire copy and EDGAR exhibit are the same bytes); a single implementation plan (Codex round 3: A and B were not independent as drawn, and the migration runner is SQL-only).
- **Decided:** armed = covered, event-scoped, mirrored to the cloud via an outbox + KV delta + snapshot v11; PDF pair weak until a pre-registered ≥50-document holdout passes the v1 gate; Finnhub EPS consensus never fills the adjusted-EPS bogey; A and B built first in parallel worktrees with no shared file, joined by two registries A creates.
- **Open, for Codex:** the round-3 mechanics were folded into rev 4 without a fourth round; each slice plan gets its own single Codex round, where residual mechanics belong.
- **Calendar:** DELL's 9/3 row is a stale Finnhub date (the company reported 9/1 AMC; the position was closed 8/19; the verifier skips unheld names by design). Left as-is; TODO item. `findEmailCandidates` derives "today" via UTC — TODO item, slice A fixes it.

## 4. Uncommitted changes / live-process state (post-deploy)

- Main pushed through `69b58b4`. Working tree clean except this file.
- Electron redeploy DONE 19:43 ET: signed + notarized, `verify-bundle: OK (no leaks, runtime pieces present)`, installed to /Applications, relaunched (server PID 31682), `/login` 200, TWS re-synced 10 positions on launch, print-watch lease re-acquired by the new process. The ZS print (event 1487, print 9588) is armed for 9/3 with a 16:05 ET release and the window opening at 15:35; the wire lane shows armed; the fixed EDGAR lane runs on the new bundle.
- The `qa`-labelled session minted for the drop and status calls was revoked (0 qa rows remain).
- Nightly chain: 02:00 smoke, 02:45 deep QA + fixer, unchanged; the fixer's own worktree `../vanguard-skin-qa-fix` remains.

## 5. Claude session link

https://claude.ai/code/session_012V5fASeDqLCdv2v57kQZEv
