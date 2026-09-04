# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-04 16:30 ET → 17:05 ET. Focus: land the live-print-v2 merge chain (slices B, C, D) and the 089 cutover, then rebuild. The chain landed and the app is rebuilt and healthy — but the 089 cutover did NOT happen through its runner: the slice B merge armed the migration and the next test run applied it to the live database unattended. That incident, the seatbelt that closes it, and a second still-open door are the substance of this handoff.

## 1. Goal + exact files changed

Merge `print-v2-slice-b`, `-c` and `-d` to `main` in the pinned order, run the 089 cutover between B and C, rebuild.

Merges (no application code authored by this session beyond the three fixes below):

- **`ff37c881`** — merge slice B (34 commits, 52 files, +9522/−471). Clean, zero conflicts.
- **`51fa458e`** — merge slice C (25 commits). Clean.
- **merge slice D**, rebased onto C first (29 commits, one dropped as already upstream). **Three conflicts**, all resolved by keeping both sides:
  - `app/dashboard/today/PrintWatchPanel.tsx` — `PrintStatusEntry` now carries C's `forcedOpenAt`/`windowExtendedUntil`/`effectiveWindow`/`goRequest` AND D's `read`/`activeRead`/`callouts`. C's hunk also opened the `GoRequestSummary` interface, so the brace structure needed care, not just concatenation.
  - `docs/DECISIONS.md` — C's bullet block and D's new `##` section both kept.
  - `lib/print-watch/register.ts` — **both** C's go handler and D's first-pass handler now register ahead of B's. `print_watch_go_requests.print_id`, `print_watch_reads.print_id` and `print_watch_callouts.print_id` all reference `print_watch_prints` with **no** `ON DELETE CASCADE`, so each slice must repoint its own rows before B's donor-print delete. C before D only matches slice order — I checked migration 090 and 091 and no foreign key runs between the go tables and the first-pass tables, so the two are genuinely independent.

Fixes authored this session:

- **`4da7daa3`** — `tests/setup/db-guard.ts` (new), `tests/repo/tests-never-touch-live-db.test.ts` (new), `vitest.config.ts`. The seatbelt; see §3.
- **`e5250c60`** — `tests/print-watch/go.test.ts`. R-C7's two assertions were a handler **census** (exact arrays), valid only while C was the sole slice ahead of B. Both now assert position, the way D's sibling test in `first-pass-merge.test.ts` already did.
- **`3bbcdf5e`** — `docs/plans/TODO.md` reconciliation.

## 2. Tests / build / deploy result

| Check | Result |
|---|---|
| Suite after B merge | **7,938 passed / 0 failed** (664 files) |
| Suite after C merge | **8,085 passed / 0 failed** (670 files) |
| Suite after D merge | 8,216 passed / **1 failed** — the stale R-C7 census assertion, fixed in `e5250c60` |
| Suite, final merged tree | **8,217 passed / 0 failed** (684 files), exit 0 |
| Suite, after both seatbelts | **8,219 passed / 0 failed** (685 files), exit 0 |
| `npx next build` | clean, exit 0 |
| `tsc --noEmit` | 20 errors in four test files — the documented pre-existing baseline; **zero** of those files appear in this session's commit range |
| `npm run verify:changed` | clean |
| **Deploy** | **`npm run electron:deploy` exit 0** — signed, **notarization successful**, `verify-bundle: OK (no leaks, runtime pieces present)`, installed and relaunched 16:59 ET |

**Post-deploy verification (real app, not tests):** migration chain now 088 → 089 → 090 → 091, `integrity_check` ok, `foreign_key_check` clean. Minted a QA session, loaded `/dashboard/today` (**200**, 230,853 bytes) and `GET /api/print-watch/status` — one payload carrying **all three slices' fields at once**: B's `documents` map (`{8: dj-release, 9: edgar-ex99}`), C's computed `effectiveWindow`, D's `read`/`activeRead`/`callouts`. Zero errors in the server log, which also proves `register.ts`'s registration cycle loads cleanly in the packaged runtime (a TDZ there was the live risk of that conflict). Slice D then ran for real: a first-pass read created 17:00:13 ET and `done` 24 seconds later, one attempt, model `claude-fable-5`. QA session revoked afterwards; verified 401.

## 3. Open concerns / rejected approaches / decisions

- **[INCIDENT] Migration 089 applied itself to the LIVE database from the test suite, at 16:33:59 ET.** `lib/db.ts` runs `runMigrations(db)` at MODULE LOAD against `resolveDbPath()`, which with no `DATABASE_PATH` is `<cwd>/data/vanguard.db`. Merging B put `089_print_watch_document_identity.ts` into the default `CODE_MIGRATIONS` registry, and the first full-suite run afterwards applied it 20 seconds in — bypassing `scripts/migrate-089-document-identity.ts` and every gate it exists to enforce (fresh verified backup, no other process holding the file, bytes-on-disk for every survivor, a human-read conservation report).
  - **Why three review rounds missed it:** every slice was verified in a **worktree**, where `data/vanguard.db` does not exist — the identical code path silently creates a throwaway DB and migrates that. All three slice worktrees hold one (976K–996K vs the real 161M). Verification in isolation, normally the safe choice, is precisely what hid this.
  - **Accepted rather than rolled back, by user ruling.** The end state is the one `--live` would have produced, and I verified it independently: the migration's own candidate-conservation invariant ran and passed (it throws otherwise, and the transaction committed), `integrity_check` ok, `foreign_key_check` clean, and all 9 surviving documents have their bytes on disk — so the one substantive skipped gate would have passed anyway. Genuinely lost: a pre-089 backup (none existed; the newest was 2026-08-23) and the human acknowledgement. Post-incident backup at `data/backups/post-089-incident-2026-09-04T20-36-10Z.db`.
  - Rejected: restoring from the 2026-08-23 backup, which would discard 12 days including the August statement import and the July unsettled-trade rescue.
- **[A SECOND DOOR, found and closed] `next build` also opened the live database and ran migrations.** Proved directly: `DATABASE_PATH=<empty dir>/vanguard.db npx next build` creates the file and applies migrations. This — not the app launch — is what applied **090 and 091 at 20:50:20 UTC**, inside `electron:deploy`'s build step, nine minutes before the new server started at 20:59:06. So a build on a dev machine mutates the production database, and between build and install the OLD binary runs against the NEW schema; that window was harmless today only because the app had already been quit. Found by chasing the timestamp gap, not by a test. Fixed in **`8736aac0`**: `npm run build` pins `DATABASE_PATH=":memory:"`, with `tests/repo/build-never-touches-live-db.test.ts` pinning it for any script that invokes `next build`.
  - **In-memory rather than a scratch FILE, and this is the interesting part.** Next collects page data with **seven parallel workers**, all of which open whatever `DATABASE_PATH` names. Pointed at a shared fresh file they race each other's migrations and the build dies with `SqliteError: table accounts already exists` — observed, exit 1, on the first attempt at this fix. **That race has always existed in `runMigrations`; it never fired because the live database already had every migration applied, so the call was a no-op.** Redirecting the build to a fresh shared file is what made a latent concurrency bug reachable. `:memory:` gives each worker its own database and removes the race instead of relocating it. If a future change ever needs a *file*-backed build database, that migration race has to be solved first.
  - Residual, documented in the test: a bare `npx next build` typed by hand still resolves to the live database. Use `npm run build`.
- **Seatbelt design, and why not an import ban.** `tests/setup/db-guard.ts` pins `DATABASE_PATH` at a per-worker-**process** scratch file before any test module loads, so parallel workers never race one file. An explicitly-set `DATABASE_PATH` is still honoured (the QA sandbox recipe uses one) unless it IS the live database — tested by realpath plus `(dev, ino)`, the same identity check the 089 runner uses, so a symlink or hardlink spelling cannot slip past. The guard test asserts where the database **resolves**, not which modules are imported, because the incident came through a **transitive** import: all four tests that name `@/lib/db` mock it, so an import ban would have caught nothing. Its third case loads the real unmocked singleton so the seal is exercised on every run. Verified: real singleton import lands on scratch with the live file's mtime unchanged; absolute, relative and symlink spellings of the live path all refused; every full-suite run since left the live DB untouched.
- **The cutover order still held its purpose.** C and D were merged only after 089 was on the database, so the `--live` runner's "refuses while a later migration is pending" rule was never violated in substance — just enforced by accident rather than by the runner.

## 4. Uncommitted changes / live-process state

`main` clean and pushed. The desktop app is the **2026-09-04 16:59 ET build**, running on 127.0.0.1:3099, database at migration 091. Note the installed binary predates `8736aac0` (the build seatbelt) and `e5250c60`/`63c1e13a` — all three are test/build/doc-only, so the running app is functionally current; the next rebuild will pick them up.

Four worktrees remain, all clean: `../vanguard-skin-print-v2-b`, `-c`, `-d` (now merged — safe to remove, and their SDD ledgers are already archived under `docs/private/`) and `../vanguard-skin-qa-fix` (the nightly fixer's — leave it alone). A safety tag `pre-rebase-slice-d` marks D's pre-rebase head. Nightly-QA PRs **#64** and **#65** are now **unblocked** (they were parked behind exactly this merge sequence) and are the natural next review; both predate the slice merges, so expect Today-panel conflicts. Nothing is armed for earnings until ORCL on 2026-09-07 16:15.

## 5. Claude session link

https://claude.ai/code/session_01SHUM6GCPDui3xocDhHhzTQ
