# Live Print v2 — Slice B Implementation Plan (acquisition roads + document identity)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A release reaches the sheet by PDF, by pasted link, by a stored per-company IR page, by the wire, or by EDGAR — whichever lands first — and identical bytes are counted once no matter how many roads deliver them; the migration runner learns code (`.ts`) migrations so the documents table can be rebuilt with candidate remapping inside one transaction.

**Architecture:** Documents dedupe on content (`UNIQUE(print_id, sha256)`); roads are provenance rows in a sidecar table; one transactional `recordDelivery` computes a content verdict (the doc-to-event gate) and a per-road verdict and decides parse eligibility (content accepted AND at least one road accepted). Parse claims are compare-and-set on the document row. Three new roads: PDF (poppler `pdftotext` reading + Claude-native `document` block reading, a weak pair until a pre-registered holdout passes), pasted URL (a pinned-DNS SSRF-hardened `node:https` fetch), and a stored IR page adapter with a persisted baseline. The migration runner gains a static registry of code migrations so `089_print_watch_document_identity.ts` can remap candidates, archive duplicates, and re-run the reconciler. Slice B's only contact with slice A is two registrations (a merge handler and the `ir_baseline` prepare step) made through a local shim.

**Tech Stack:** TypeScript / Next.js 16 App Router (thin routes over `lib/`), better-sqlite3 (DI `db` param, `.immediate()` transactions), `node:https` + `node:dns` (pinned fetch), `node:child_process` (poppler `pdftotext`), @anthropic-ai/sdk `document` blocks via the repo model registry, Vitest (in-memory SQLite, temp dirs for bytes).

**Spec:** `docs/superpowers/specs/2026-09-02-live-print-v2-design.md` — §4.2 (this slice), §5 item 089, §6 routes, §7 failure modes, §8 B-line tests, §10 slices. v1 spec `docs/superpowers/specs/2026-08-20-live-print-watch-design.md` §2 (the green-precision gate) stands. The cross-slice registry contract is quoted verbatim in Task 13 (slice A's plan carries the identical text).

**Worktree:** sibling `../vanguard-skin-print-v2-b` on branch `print-v2-slice-b` (never nested inside the repo). Slice A builds in parallel in its own sibling worktree; the two share no file (see Global Constraints).

## Plan-level mechanics and deviations (recorded before the Codex round)

Each is a residual mechanic the spec delegated to the plan (§2 "Design rounds end at three") or a deviation forced by a code fact found while mapping the slice. None re-opens a user ruling.

- **M1 — `.ts` migrations are discovered through a STATIC registry**, `lib/db/code-migrations.ts` (`CODE_MIGRATIONS: Record<string, CodeMigration>` keyed by filename), not by `readdirSync`. Reason: the packaged app copies only `*.sql` into the standalone tree (`electron-builder.yml` extraResources filter `"*.sql"`) and has no TypeScript loader, so a runtime `import()` of a `.ts` file fails in production; a static import compiles the migration into the server bundle. The runner unions on-disk `.sql` names with registry keys, sorts by numeric prefix, and applies each inside the same per-migration `db.transaction`. A guard test asserts every `NNN_*.ts` file under `lib/db/migrations/` is a registry key and vice versa. Packaging finding: `electron-builder.yml`'s `*.sql` filter and `scripts/verify-bundle.js` (which has no migration check) need NO change; the raw `.ts` file need not ship. Verified after `next build` by grepping the standalone chunks for the migration's filename string (Task 15).
- **M2 — `hardenedFetchBytes` uses `node:https` `request()`**, not undici. Reason: `undici` is not a dependency and Node does not expose it (`require("undici")` → `MODULE_NOT_FOUND`). The `lookup` option returns the pre-validated address (honouring `options.all` because Node ≥20's `autoSelectFamily` path asks for an array), `servername` = the hostname (SNI and certificate validation intact), `agent: false`, manual redirects, `req.destroy()` on abort, streamed cap. The spec's "agent closed" assertion becomes "the request is destroyed on abort". REVISED after Codex #8/#9/#10: every DNS lookup is raced against the shared 20-second deadline; a redirect or error response is DESTROYED, never resumed; callers may pass `allowHost(hostname)` and it is applied at every hop (the IR lane passes `isAllowedIrLinkHost`); the classifier covers every IANA special-purpose form that embeds an IPv4 address (`::/96` IPv4-compatible, `::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16` 6to4 — each applies the v4 rules to the embedded address) plus `64:ff9b:1::/48`, `100::/64`, `2001::/32` Teredo, `2001:10::/28` ORCHID, `2001:db8::/32`, ULA, link-local, site-local, multicast.
- **M3 — Registry shim.** `lib/print-watch/registry-shim.ts` exports `registerEventMergeHandler`, `registerPrepareStep`, `stableHash` with slice A's exact signatures over an in-memory collecting registry; `lib/print-watch/register.ts` is the ONLY B file that names the registries. B never edits `lib/earnings/*`, `lib/calendar/*`, `lib/mutations/*`, `lib/queries/*`, `workers/*`. The post-merge integration task (Task 16, run by whichever slice merges second) swaps the import to `@/lib/earnings/event-merge` / `@/lib/earnings/prepare-armed-event`, deletes the shim, and lands the cross-slice test. REVISED after Codex #4: registration must not depend on module load order. During the shim phase `registerPrintWatch()` runs at watcher load (every current caller of the registries also imports the watcher). Task 16 adds an A-owned composition module, `lib/earnings/registry-bootstrap.ts`, exporting `bootstrapEarningsRegistries()`, which A's `mergeEarningsEventState`, `enqueuePrepareSteps`, and `runPrepareSteps` call first — plus a cold-process test (`vi.resetModules()`, import only the registry module) that proves B's handlers are present without any manual registration. **Cross-slice requirement for slice A's plan: those three entry points must call the bootstrap.**
- **M4 — `recordDelivery` takes a seventh argument.** Spec §4.2 names `recordDelivery(db, printId, kind, source, url, bytes)`; the content gate needs the document TEXT and the event's identity, and the byte write is not transactional so it must precede the call. Signature: `recordDelivery(db, printId, kind, source, url, bytes, input: DeliveryInput)` with `DeliveryInput = { bytesPath, text, gateCtx }` (the normalised-text hash is computed inside, M13). The six positional arguments are unchanged.
- **M5 — `print_watch_ir_seen` is keyed by `event_id`, not `print_id`.** Reason: print rows exist only for events within ±1 day (`ensurePrintWatch` walks `getArmedWorksheetEvents(db, [yesterday, today, tomorrow])` and marks any other active print `disarmed` in its stale pass), so a print row cannot be created at arm time without breaking the v1 reconciler, and the baseline must be recorded at arm time. The merge handler unions the rows onto the target event. REVISED after Codex #5/#6: the baseline is atomic and versioned — `print_watch_ir_baseline (event_id PK, source_fingerprint, link_count, completed_at)` is written in ONE transaction together with the links, and `hasIrBaseline(db, eventId, fingerprint)` is true only for the CURRENT IR URL's fingerprint (a changed URL is a new baseline). The watcher NEVER baselines; only the `ir_baseline` prepare step does, before the window. In-window with no baseline (prepare failed, late arm) the lane polls with `baseline: false` and lets the strict `ir-page` period gate filter old posts — so a late arm fetches tonight's release instead of marking it old.
- **M6 — `print_watch_candidate_archive` is keyed by `(print_id, metric_id)`.** Reason: `print_watch_lines` has no `id` column — its primary key is `(print_id, metric_id)` — and giving it one would change every upsert in the store for no gain.
- **M7 — Missing bytes and malformed candidates are recorded, never silently kept as evidence and never silently dropped.** REVISED after Codex #12. A surviving document whose bytes are missing on disk is marked `gate_verdict = 'rejected'`, `gate_reason = 'bytes missing on disk'`; its candidates are archived durably (reason `bytes-missing`) and every affected non-accepted line is re-reconciled, so no green rests on evidence that cannot be re-read. The report lists the paths and the rehearsal/live script (Task 7) FAILS on any, so the human sees it before the live run; the migration does not throw on it (a startup-blocking migration must not depend on filesystem state outside the DB, and by M18 it never runs implicitly at startup anyway). Malformed `candidates_json` is copied VERBATIM (never rewritten as `[]`) and its raw value archived with reason `unparseable-json`; the count invariant counts parseable candidates on both sides.
- **M8 — Legacy rejected rows.** v1 overwrote `source` with `rejected:<reason>` at insert, losing the road's own label. The rebuild moves the reason to `gate_reason`, sets `source = 'legacy-rejected'`, `gate_version = 1`, `gate_fingerprint = NULL` (so the next delivery of the same bytes re-evaluates under the current gate). Within a same-hash group the content verdict is `accepted` if ANY member was accepted (a rejected IR copy beside an accepted EDGAR copy was a road rejection, not a content one).
- **M9 — PDF pair fields.** `TaggedCandidate.representation` widens with `"pdfText" | "pdfNative"` and gains an optional `pair_note?: "pdf-weak"`; both PDF readings carry `weak_pair: true`. `reconcile.ts`'s `independent()` is UNCHANGED: same `doc_id` + `weak_pair` on both → not independent → `single_source`. The spec's "agreed (PDF), verify" wording is a display rule for slice F (which owns `app/dashboard/today/*`), derived from `pair_note` on the candidates; B ships the state and the note.
- **M10 — `print_watch_lines.audit_json`** (nullable TEXT) is added by the 089 rebuild so the merge handler can preserve two differing acceptances (spec §4.2 "B's merge handler") without dropping either.
- **M11 — `IngestOutcome` gains `"refused"`** (nothing stored) for input-level refusals: PDF refusals (encrypted, oversize, over 60 pages, image-only, poppler missing) and binary bodies. A gate rejection stays `"rejected"` (row stored). The drop route maps `refused` to HTTP 400 with the reason, as v1 did for PDFs.
- **M12 — `GET /api/print-watch/status`** keeps `documents: Record<docId, kind>` unchanged and adds `documentRoads: Record<docId, Array<{ kind, source, verdict }>>`.
- **M13 — `reconcile.ts` is not edited; identity is content OR normalised text.** REVISED after Codex #16. Two roads delivering identical bytes yield ONE `doc_id` (Task 9 proves it). In addition, EVERY document gets `text_sha256` = sha256 of its gate text normalised (whitespace collapsed, lower-cased), and `recordDelivery` treats a delivery whose normalised text matches an existing document of the same print as the SAME document (road added, no new `doc_id`, no second parse). This closes the resaved-PDF and HTML-versus-text-wrapper cases without touching the reconciler. RESIDUAL, for the user: a DJ stitched text and an EDGAR exhibit of one release remain two documents and can green together — that is v1's measured pair and the §2 ruling ("wire copy and EDGAR exhibit are the same bytes") that callouts need no second document; B does not re-open it.
- **M14 — Page count and encryption are decided from `pdftotext` itself** (a form feed per page in its output; a non-zero exit mentioning "password" for an encrypted file), with a cheap `/Encrypt` pre-check on the raw bytes. Reason: PDF ≥1.5 object streams hide `/Type /Page` from a byte scan. Both child streams are capped (stdout 2MB, stderr 64KB) and the child is killed on either cap; bytes written before a refusal are deleted (no row references them).
- **M15 — Parse attempts are durable (Codex #7).** `print_watch_documents.parse_attempts` and `parse_last_error`: the claim increments attempts, finalisation records the error; `failed` after 5. An explicit re-delivery of the same bytes through a USER road (`user-drop`, `user-url`) re-queues a `failed` document with attempts reset — user-driven and bounded per delivery; automated roads never re-deliver (seen-sets). `IngestOutcome` gains `parse_failed`: `finishIngest` reports the document's durable state after the drain (`parsed` only when the row says `parsed`), never the drain's return value.
- **M16 — Evidence retraction (Codex #2).** When a document's content verdict flips accepted → rejected — fingerprint re-evaluation in `recordDelivery`, merge-time re-evaluation, or missing bytes in the rebuild — its candidates are archived (reason `gate-rejected`) and every affected non-accepted line is re-reconciled from its stored contract/expected, in the same transaction (`retractDocumentEvidence`, Task 8).
- **M17 — IR links: fixed-host policy on every hop; seen only after a durable outcome (Codex #10).** The IR lane fetches with `allowHost = isAllowedIrLinkHost`, so a redirect off the IR host or the wire hosts is refused; the road stores the redacted FINAL URL. A link is marked seen (memory + DB) only when the ingest outcome is durable (`parsed`, `duplicate`, `rejected`, `queued`, `parse_failed`); `refused` and thrown fetches stay unmarked and retry next poll, bounded by a per-link in-memory refusal counter (3) after which the link is marked seen with the reason in the lane's source note.
- **M18 — Live cutover runbook (Codex #13/#14).** 089 never runs implicitly on the live DB at first request: quit every writer (Electron app, dev servers), verify with `lsof`, take a timestamped `VACUUM INTO` backup and `PRAGMA integrity_check` it, run the migration explicitly with `scripts/migrate-089-document-identity.ts --live` (the same transaction and invariant gates as `--rehearse`; a failed invariant rolls back), read the report, start the app (the runner sees 089 recorded and skips it). Restore = quit, copy the backup back. The live-DB refusal in `--rehearse` compares real paths AND `(dev, ino)`. Before the deploy, a fresh standalone process (`node .next/standalone/server.js` with `DATABASE_PATH` on a disposable copy) must apply 089 — proving the bundled code migration runs, not just that its name appears in a chunk.
- **M19 — `redactUrl` key families and road identity (Codex #11, adopted in part).** The stripped parameter names are the token / secret / password / credential / signature / api-key / session / access / auth FAMILIES (regex in Task 2), not seven exact names. A `user-url` road's identity (`source`) is `user-url:<first 16 hex of sha256(full URL)>` so two long URLs that redact or truncate alike never collapse into one road; the redacted URL is display only. REJECTED: protected storage for retrieval credentials — the design never stores a secret; a link that needs one is refused with the reason.

## Codex round 1 (2026-09-02, read-only) — REVISE, 18 findings

Adopted in full: #1 (merge order: lines before document deletion), #2 (M16), #3 (lossless merge: full identity on re-home, re-reconcile moved lines, audit union, immutable byte paths — Task 13), #4 (M3 bootstrap), #5 and #6 (M5), #7 (M15), #8 and #9 (M2), #10 (M17), #12 (M7), #13 and #14 (M18), #15 (drop route parses a discriminated union up front — Task 11), #17 (file-backed two-connection tests, restart + duplicate-delivery test, DNS-timeout and hostile-redirect fixtures, late-arm/no-baseline test, standalone smoke — Tasks 4/8/9/12/15), #18 (M14). Adopted in part: #11 (M19), #16 (M13 — normalised-text identity yes; reconciler correlation groups no, per the §2 ruling; surfaced to the user). Codex cited the drop route at `app/api/earnings/[eventId]/print-watch/drop/route.ts`; the file is `app/api/print-watch/drop/route.ts` — the finding (#15) stands regardless.

## Global Constraints

- Never hardcode a model id — resolve via the repo registry exactly as `lib/print-watch/extract.ts` does (`resolveTier("workhorse", [])`, fallback `SONNET_MODEL`).
- Every DB function takes `db: Database.Database` first (DI for tests). Route envelope `{success:true,data}` / `{success:false,error}`; routes thin (logic in `lib/print-watch/*`). `lib/auth/route-policy.ts` gets NO new entries — every `/api/print-watch/*` route is `human` by default (session cookie + CSRF + trusted `Origin` on unsafe methods). **GET routes must be read-only** — `tests/api/no-state-changing-get.test.ts` statically scans every GET body.
- Runtime file storage anchors at `resolveDbDir()` (`lib/db/db-path.ts`): `<resolveDbDir()>/print-watch/<printId>/<sha256>.<ext>` with `ext ∈ {html, txt, pdf}`, written temp-file + atomic rename; a PDF's extracted text is persisted beside it as `<sha256>.pdftext.txt`.
- Timestamps compare with `datetime()` on BOTH sides; user-facing dates ET-anchored (`todayET()`); ISO UTC strings and `Date.parse` for instants.
- Anthropic tool schemas: `additionalProperties:false` on EVERY object node. Extraction prompts NEVER contain expected/bogey values; expected values travel in a parallel structure that never reaches a prompt.
- Press-release figures on the panel are public market data; the BOGEY column derives from the user's curated bogeys and is private. B has no UI, but the status payload keeps the two apart exactly as v1 does.
- No new npm dependencies (`undici` is not available — `node:https`, `node:dns`, `node:child_process` only). Node via `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Outbound fetch hardening everywhere: SEC User-Agent `PortfolioDesk contact@myportfoliodesk.com`; per-host minimum spacing via the watcher's spacer (SEC 300ms, others 200ms); `redirect:"manual"` / manual hops with revalidation; `content-length` precheck + streamed cap. The URL road: `https:` only, port 443 only, no credentials, A and AAAA resolved and every address globally routable, max 3 hops each fully revalidated with a fresh pinned lookup, one `AbortController` with a 20-second budget shared across hops, 10MB streamed cap, type by magic bytes.
- `redactUrl(url)` (strips query parameters named `token|sig|signature|key|auth|session|access`, drops credentials and fragment, truncates to 200 characters) is the ONLY way a URL is rendered into an error message, a road row, a log line, or the status payload.
- Snippets/model prose render only through React text nodes (never `dangerouslySetInnerHTML`); error strings surfaced to the UI are message-only (no URLs with tokens, no document bytes).
- **Slice ownership (spec §10).** B edits ONLY: `lib/print-watch/*`, `lib/db/migrate.ts`, `lib/db/code-migrations.ts`, `lib/db/migrations/089_print_watch_document_identity.ts`, `app/api/print-watch/*`, `scripts/migrate-089-document-identity.ts`, `tests/**`, `docs/DECISIONS.md` (append), `docs/reference/earnings-pipeline.md` (§Print-watch only). NEVER `lib/earnings/*`, `lib/calendar/*`, `lib/mutations/*`, `lib/queries/*`, `workers/*`, `app/dashboard/*`, `lib/ai/*`.
- Migration number 089 is reserved for B; A's 088 is a `.sql`. Never renumber; never share a number.
- Tests: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <paths>`. Commits: write the message to a temp file and commit BY PATHSPEC — `git commit <paths> -F <tempfile>` — never a bare `git commit`, never `git stash` / `git checkout` / `git clean` (parallel agents share the worktree).
- Never edit `qa/nightly-deep-qa.sh`; never run git branch/worktree cleanup while `electron:deploy` is building.

## File Structure

```
lib/db/code-migrations.ts                              # static registry of .ts migrations (Task 1)
lib/db/migrate.ts                                      # union .sql + registry, numeric order (Task 1)
lib/print-watch/hardened-fetch.ts                      # + redactUrl; error strings redacted (Task 2)
lib/print-watch/ssrf.ts                                # validatePublicUrl, isGloballyRoutable, pinned lookup (Task 3)
lib/print-watch/url-fetch.ts                           # hardenedFetchBytes (node:https, pinned), classifyBytes (Task 4)
lib/print-watch/gate.ts                                # validateDocForEvent moved here + GATE_VERSION, fingerprint, content/road verdicts (Task 5)
lib/db/migrations/089_print_watch_document_identity.ts # sidecar tables + documents/lines rebuild + reconciler re-run (Task 6)
scripts/migrate-089-document-identity.ts                      # VACUUM-copy rehearsal with invariant report (Task 7)
lib/print-watch/types.ts                               # DocumentRow/roads/sources/ir-seen rows, user-url, pdf reps, pair_note, retired (Task 8)
lib/print-watch/store.ts                               # insertDocument removed; parse-claim CAS, roads, sources, ir-seen reads/writes (Task 8)
lib/print-watch/delivery.ts                            # recordDelivery — the single transactional delivery entry (Task 8)
lib/print-watch/watcher.ts                             # ingestDocument → recordDelivery; CAS parse queue; refused outcome; coverage copy (Task 9)
app/api/print-watch/status/route.ts                    # + documentRoads (Task 9)
lib/print-watch/pdf.ts                                 # isPdf, checks, pdftotext resolution + DI spawn runner (Task 10)
lib/print-watch/extract.ts                             # + extractCandidatesFromPdf (document block) (Task 10)
app/api/print-watch/drop/route.ts                      # PDF accepted; { eventId, url } road (Tasks 10, 11)
lib/print-watch/roads.ts                               # deliverFromUrl (Task 11)
lib/print-watch/ir-page-adapter.ts                     # pollIrPage, link extraction, host allowlist (Task 12)
app/api/print-watch/sources/route.ts                   # PUT stored IR page (Task 12)
lib/print-watch/ir-baseline-step.ts                    # the ir_baseline prepare step (Task 12)
lib/print-watch/registry-shim.ts                       # A's registry signatures, in-memory (Task 13)
lib/print-watch/register.ts                            # the ONLY file naming the registries (Task 13)
lib/print-watch/merge-handler.ts                       # B's event-merge handler (Task 13)
docs/DECISIONS.md                                      # PDF-pair gate pre-registration (Task 10, step 1)
docs/reference/earnings-pipeline.md                    # §Print-watch v2 roads + identity (Task 14)
tests/db/migrate-code-migrations.test.ts               # Task 1
tests/db/code-migrations-registry.test.ts              # Task 1
tests/db/migration-089-document-identity.test.ts       # Task 6
tests/print-watch/{redact-url,ssrf,url-fetch,gate,delivery,pdf,roads,ir-page-adapter,ir-baseline-step,registry-shim,merge-handler}.test.ts
tests/print-watch/{watcher,extract,store,replay}.test.ts   # extended
tests/api/print-watch-routes.test.ts                   # extended (PDF, URL, sources)
```

---

### Task 1: Migration runner — code (`.ts`) migrations through a static registry

**Files:**
- Create: `lib/db/code-migrations.ts`
- Modify: `lib/db/migrate.ts` (whole file — it is 41 lines)
- Test: `tests/db/migrate-code-migrations.test.ts`, `tests/db/code-migrations-registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 6 registers into `CODE_MIGRATIONS`; Task 7 and every migration test call `runMigrations` with options):

```ts
// lib/db/code-migrations.ts
import type Database from "better-sqlite3";
export type CodeMigration = (db: Database.Database) => void;
/** Keyed by the migration FILENAME (`NNN_name.ts`) — the key is what schema_migrations records. */
export const CODE_MIGRATIONS: Record<string, CodeMigration>;

// lib/db/migrate.ts
export interface RunMigrationsOptions {
  migrationsDir?: string;                              // default lib/db/migrations
  codeMigrations?: Record<string, CodeMigration>;      // default CODE_MIGRATIONS
}
export function migrationOrder(sqlFiles: string[], codeNames: string[]): string[];
export function runMigrations(db: Database.Database, opts?: RunMigrationsOptions): void;
```

- [ ] **Step 1: Write the failing runner tests**

`tests/db/migrate-code-migrations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations, migrationOrder } from "@/lib/db/migrate";

function tmpMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-ts-"));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

function appliedNames(db: Database.Database): string[] {
  return (db.prepare("SELECT filename FROM schema_migrations ORDER BY id").all() as { filename: string }[]).map(
    (r) => r.filename,
  );
}

describe("runMigrations — code (.ts) migrations", () => {
  it("orders .sql and .ts migrations together by numeric prefix, name as tie-break", () => {
    expect(migrationOrder(["003_c.sql", "001_a.sql"], ["002_b.ts"])).toEqual(["001_a.sql", "002_b.ts", "003_c.sql"]);
    expect(migrationOrder(["010_x.sql"], ["009_y.ts", "011_z.ts"])).toEqual(["009_y.ts", "010_x.sql", "011_z.ts"]);
  });

  it("runs a mixed sequence in order, inside one transaction each, and records every filename", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({
      "001_a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);",
      "003_c.sql": "INSERT INTO b (v) VALUES ('from-003');",
    });
    runMigrations(db, {
      migrationsDir: dir,
      codeMigrations: {
        "002_b.ts": (d) => {
          d.exec("CREATE TABLE b (v TEXT); INSERT INTO b (v) VALUES ('from-002')");
        },
      },
    });
    expect(appliedNames(db)).toEqual(["001_a.sql", "002_b.ts", "003_c.sql"]);
    const rows = (db.prepare("SELECT v FROM b ORDER BY rowid").all() as { v: string }[]).map((r) => r.v);
    expect(rows).toEqual(["from-002", "from-003"]);
  });

  it("rolls back a throwing .ts migration completely and leaves earlier ones applied", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({ "001_a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);" });
    expect(() =>
      runMigrations(db, {
        migrationsDir: dir,
        codeMigrations: {
          "002_boom.ts": (d) => {
            d.exec("CREATE TABLE half (id INTEGER)");
            throw new Error("boom");
          },
        },
      }),
    ).toThrow("boom");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toContain("a");
    expect(tables).not.toContain("half");
    expect(appliedNames(db)).toEqual(["001_a.sql"]);
  });

  it("is idempotent for .ts migrations — a second run applies nothing", () => {
    const db = new Database(":memory:");
    const dir = tmpMigrationsDir({ "001_a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);" });
    const calls: number[] = [];
    const opts = {
      migrationsDir: dir,
      codeMigrations: { "002_b.ts": () => { calls.push(1); } },
    };
    runMigrations(db, opts);
    runMigrations(db, opts);
    expect(calls).toHaveLength(1);
    expect(appliedNames(db)).toEqual(["001_a.sql", "002_b.ts"]);
  });

  it("still applies the real migration set with the default registry", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(appliedNames(db).length).toBeGreaterThanOrEqual(87);
  });
});
```

`tests/db/code-migrations-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CODE_MIGRATIONS } from "@/lib/db/code-migrations";

const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "db", "migrations");

describe("code-migrations registry (M1 guard)", () => {
  it("registers every NNN_*.ts file under lib/db/migrations, and nothing that is not on disk", () => {
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".ts")).sort();
    expect(Object.keys(CODE_MIGRATIONS).sort()).toEqual(onDisk);
  });

  it("uses the NNN_name.ts convention and never shares a number with a .sql migration", () => {
    const sqlNumbers = new Set(
      fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, 3)),
    );
    for (const name of Object.keys(CODE_MIGRATIONS)) {
      expect(name).toMatch(/^\d{3}_[a-z0-9_]+\.ts$/);
      expect(sqlNumbers.has(name.slice(0, 3))).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/migrate-code-migrations.test.ts tests/db/code-migrations-registry.test.ts`
Expected: FAIL — `migrationOrder` is not exported; `@/lib/db/code-migrations` cannot be resolved.

- [ ] **Step 3: Create the registry and rewrite the runner**

`lib/db/code-migrations.ts`:

```ts
// Static registry of CODE migrations (`NNN_name.ts`, exporting `up(db)`).
//
// Why a registry and not readdirSync (plan M1): the packaged app copies only
// `*.sql` into the standalone tree (electron-builder.yml extraResources
// filter) and has no TypeScript loader, so a runtime import() of a .ts file
// would fail in production. A static import here compiles each migration
// into the server bundle. tests/db/code-migrations-registry.test.ts asserts
// this map and the files on disk agree.
import type Database from "better-sqlite3";

export type CodeMigration = (db: Database.Database) => void;

export const CODE_MIGRATIONS: Record<string, CodeMigration> = {};
```

`lib/db/migrate.ts` (entire file):

```ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_MIGRATIONS, type CodeMigration } from "./code-migrations";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export interface RunMigrationsOptions {
  /** Directory of `.sql` migrations (tests point this at a temp dir). */
  migrationsDir?: string;
  /** Code migrations keyed by filename (tests inject their own). */
  codeMigrations?: Record<string, CodeMigration>;
}

function migrationNumber(name: string): number {
  const n = Number.parseInt(name.slice(0, 3), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** `.sql` files on disk and registry keys, ordered by numeric prefix then name. */
export function migrationOrder(sqlFiles: string[], codeNames: string[]): string[] {
  return [...sqlFiles, ...codeNames].sort(
    (a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b),
  );
}

export function runMigrations(db: Database.Database, opts: RunMigrationsOptions = {}): void {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const codeMigrations = opts.codeMigrations ?? CODE_MIGRATIONS;

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT filename FROM schema_migrations").all() as { filename: string }[]).map(
      (r) => r.filename,
    ),
  );

  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  for (const file of migrationOrder(sqlFiles, Object.keys(codeMigrations))) {
    if (applied.has(file)) continue;
    const run: CodeMigration = file.endsWith(".ts")
      ? codeMigrations[file]
      : ((sql: string) => (d: Database.Database) => d.exec(sql))(
          fs.readFileSync(path.join(migrationsDir, file), "utf-8"),
        );
    // Synchronous on purpose: a code migration must be `(db) => void` so the
    // whole step — the change AND its bookkeeping row — sits in ONE transaction.
    db.transaction(() => {
      run(db);
      db.prepare("INSERT INTO schema_migrations (filename) VALUES (?)").run(file);
    })();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/`
Expected: PASS (the new files plus every existing `tests/db/*` migration test).

- [ ] **Step 5: Record the packaging finding (M1) and commit**

Run: `grep -n "migrations" electron-builder.yml scripts/verify-bundle.js` — expected: only the `lib/db/migrations` → `standalone/lib/db/migrations` copy with filter `"*.sql"`; no hit in `verify-bundle.js`. No edit to either file. Note the finding in the commit message.

```bash
cat > /tmp/msg-b1.txt <<'EOF'
feat(db): code (.ts) migrations through a static registry

runMigrations now unions on-disk .sql names with CODE_MIGRATIONS keys,
orders by numeric prefix, and runs each in its own transaction (a
throwing .ts migration rolls back and is not recorded). Registry, not
readdirSync: the packaged app ships only *.sql and has no TS loader.
electron-builder.yml and verify-bundle.js need no change.
EOF
git commit lib/db/migrate.ts lib/db/code-migrations.ts tests/db/migrate-code-migrations.test.ts tests/db/code-migrations-registry.test.ts -F /tmp/msg-b1.txt
```

---

### Task 2: `redactUrl` — the only way a URL reaches a message

**Files:**
- Modify: `lib/print-watch/hardened-fetch.ts` (add `redactUrl`; switch every `${url}` / `${currentUrl}` in its error strings)
- Test: `tests/print-watch/redact-url.test.ts`; extend `tests/print-watch/edgar-adapter.test.ts` (`EDGAR outbound hardening` describe)

**Interfaces:**
- Produces:

```ts
// lib/print-watch/hardened-fetch.ts
export const REDACTED_QUERY_KEYS: RegExp;   // /^(token|sig|signature|key|auth|session|access)$/i
export function redactUrl(raw: string): string;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/redact-url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactUrl } from "@/lib/print-watch/hardened-fetch";

describe("redactUrl", () => {
  it("strips the named secret-bearing query parameters and keeps the rest", () => {
    expect(redactUrl("https://ir.example.com/release?id=42&token=SECRET&sig=S&signature=X&key=K&auth=A&session=Z&access=Q")).toBe(
      "https://ir.example.com/release?id=42",
    );
  });
  it("matches parameter names case-insensitively", () => {
    expect(redactUrl("https://x.example/a?Token=1&ID=2")).toBe("https://x.example/a?ID=2");
  });
  it("strips the whole secret-bearing families, not just seven exact names (M19)", () => {
    expect(
      redactUrl("https://x.example/a?api_key=1&apikey=2&X-Amz-Signature=3&X-Amz-Credential=4&client_secret=5&password=6&access_token=7&sessionid=8&page=2&keyword=q"),
    ).toBe("https://x.example/a?page=2&keyword=q");
  });
  it("drops embedded credentials and the fragment", () => {
    expect(redactUrl("https://user:pw@x.example/a#frag")).toBe("https://x.example/a");
  });
  it("truncates to 200 characters", () => {
    const long = `https://x.example/${"a".repeat(400)}`;
    expect(redactUrl(long)).toHaveLength(200);
    expect(redactUrl(long).endsWith("…")).toBe(true);
  });
  it("still redacts something that does not parse as a URL", () => {
    expect(redactUrl("not a url ?token=abc")).toBe("not a url ");
  });
});
```

Add to `tests/print-watch/edgar-adapter.test.ts` inside `describe("EDGAR outbound hardening")`:

```ts
  it("never echoes a secret-bearing query parameter in a hardened-fetch error", async () => {
    const { fetchFn } = makeMockFetch(buildRoutes());
    await expect(
      pollEdgar(CIK, WINDOW_START, WINDOW_END, new Set(), async (url, init) =>
        fetchFn("https://evil.example/x?token=SECRET-VALUE", init),
      ),
    ).rejects.not.toThrow(/SECRET-VALUE/);
  });
```

(`pollEdgar` fetches through `hardenedFetchText`, which refuses the off-host URL; the assertion is that the refusal message does not carry the token. If the describe's `makeMockFetch` shape differs when you open the file, keep the assertion and adapt the fetch stub: the point is an off-host URL with `?token=SECRET-VALUE` surfacing in an error.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/redact-url.test.ts tests/print-watch/edgar-adapter.test.ts`
Expected: FAIL — `redactUrl` is not exported; the hardening test sees `SECRET-VALUE` in the message.

- [ ] **Step 3: Implement `redactUrl` and switch the error strings**

Add to `lib/print-watch/hardened-fetch.ts` after the `CONTENT_TYPE_MARKUP` constant:

```ts
/** Query parameter NAME FAMILIES that must never reach a message, a row, or a
 *  log (plan M19): token/secret/password/credential/signature/api-key/session/
 *  access/auth in any spelling (`api_key`, `X-Amz-Signature`, `client_secret`…). */
export const REDACTED_QUERY_KEYS =
  /(token|secret|passw|pwd|credential|signature|^sig$|^key$|api[-_]?key|^auth|session|^access|x-amz-)/i;

const REDACTED_URL_MAX = 200;

/**
 * The ONLY way a URL is rendered into an error message, a road row, a log
 * line, or the status payload (spec §4.2 "URL"). Drops credentials and the
 * fragment, deletes the secret-bearing query parameters, truncates to 200
 * characters. Unparsable input is cut at the first `?`/`#` and truncated.
 */
export function redactUrl(raw: string): string {
  let out: string;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (REDACTED_QUERY_KEYS.test(key)) url.searchParams.delete(key);
    }
    out = url.toString();
    if (out.endsWith("?")) out = out.slice(0, -1);
  } catch {
    out = raw.replace(/[?#].*$/, "");
  }
  return out.length > REDACTED_URL_MAX ? `${out.slice(0, REDACTED_URL_MAX - 1)}…` : out;
}
```

Then in `hardenedFetchText` replace every interpolation of `url` and `currentUrl` inside `new Error(...)` strings with `redactUrl(url)` / `redactUrl(currentUrl)` (nine sites: off-host refusal, exceeded hops, no Location, cross-host redirect (both URLs), HTTP status, content-type, content-length, and both `readCapped` throws — pass `redactUrl(currentUrl)` into `readCapped`'s `url` argument so its two messages are covered too).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/`
Expected: PASS (all print-watch suites — the message text changes only where a URL appears).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b2.txt <<'EOF'
feat(print-watch): redactUrl, and hardened-fetch errors never carry a raw URL

Strips token|sig|signature|key|auth|session|access, credentials, and the
fragment; truncates to 200 chars. Every hardenedFetchText error string
now goes through it (spec 4.2 URL).
EOF
git commit lib/print-watch/hardened-fetch.ts tests/print-watch/redact-url.test.ts tests/print-watch/edgar-adapter.test.ts -F /tmp/msg-b2.txt
```

---

### Task 3: SSRF contract — public-URL validation and pinned resolution

**Files:**
- Create: `lib/print-watch/ssrf.ts`
- Test: `tests/print-watch/ssrf.test.ts`

**Interfaces:**
- Produces (Task 4 and Task 12 consume):

```ts
// lib/print-watch/ssrf.ts
export type SsrfVerdict = { ok: true; hostname: string } | { ok: false; reason: string };
export function validatePublicUrl(raw: string): SsrfVerdict;
export function isGloballyRoutable(ip: string): boolean;
export interface ResolvedAddress { address: string; family: 4 | 6 }
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;
export const systemLookup: LookupFn;
export async function resolvePinnedAddress(hostname: string, lookup?: LookupFn): Promise<ResolvedAddress>;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/ssrf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validatePublicUrl, isGloballyRoutable, resolvePinnedAddress } from "@/lib/print-watch/ssrf";

describe("validatePublicUrl", () => {
  it("accepts a plain https URL on the default port", () => {
    expect(validatePublicUrl("https://ir.example.com/news/q2")).toEqual({ ok: true, hostname: "ir.example.com" });
  });
  it.each([
    ["http://ir.example.com/x", /https/],
    ["ftp://ir.example.com/x", /https/],
    ["https://user:pw@ir.example.com/x", /credentials/],
    ["https://ir.example.com:8443/x", /port 443/],
    ["https://localhost/x", /local/],
    ["https://foo.localhost/x", /local/],
    ["https://127.0.0.1/x", /routable/],
    ["https://[::1]/x", /routable/],
    ["https://169.254.169.254/latest/meta-data", /routable/],
    ["not a url", /valid URL/],
  ])("refuses %s", (url, reason) => {
    const v = validatePublicUrl(url);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(reason);
  });
  it("accepts an explicit :443", () => {
    expect(validatePublicUrl("https://ir.example.com:443/x").ok).toBe(true);
  });
});

describe("isGloballyRoutable — IPv4 blocked ranges", () => {
  it.each([
    "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254",
    "127.0.0.1", "127.255.255.255", "169.254.1.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "192.168.255.255", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1",
    "255.255.255.255",
  ])("blocks %s", (ip) => {
    expect(isGloballyRoutable(ip)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "192.0.3.1", "198.20.0.1", "223.255.255.254"])(
    "allows %s",
    (ip) => {
      expect(isGloballyRoutable(ip)).toBe(true);
    },
  );
});

describe("isGloballyRoutable — IPv6 blocked ranges", () => {
  it.each([
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
    "2001:db8::1",
    // Codex #9 — the forms that embed or tunnel an otherwise-forbidden IPv4 address
    "::7f00:1", "::10.0.0.1",            // IPv4-compatible (::/96) → v4 rules
    "64:ff9b:1::1", "64:ff9b:1:ffff::1", // local-use NAT64 64:ff9b:1::/48
    "100::1", "100::ffff:ffff:ffff:ffff", // discard-only 100::/64
    "2002:7f00:1::1", "2002:0a00:1::1", "2002:c0a8:101::1", // 6to4 of 127.0.0.1, 10.0.0.1, 192.168.1.1
    "2001::1", "2001:0:abcd::1",         // Teredo 2001::/32
    "2001:10::1", "2001:1f::1",          // ORCHID 2001:10::/28
  ])("blocks %s", (ip) => {
    expect(isGloballyRoutable(ip)).toBe(false);
  });
  it.each(["2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "::8.8.8.8", "2002:808:808::1", "2001:20::1"])("allows %s", (ip) => {
    expect(isGloballyRoutable(ip)).toBe(true);
  });
  it("treats garbage as not routable", () => {
    expect(isGloballyRoutable("nope")).toBe(false);
    expect(isGloballyRoutable("1:2:3:4:5:6:7:8:9")).toBe(false);
  });
});

describe("resolvePinnedAddress", () => {
  it("returns the first address when every resolved address is routable", async () => {
    const lookup = async () => [
      { address: "2606:4700::1111", family: 6 as const },
      { address: "104.16.0.1", family: 4 as const },
    ];
    await expect(resolvePinnedAddress("ir.example.com", lookup)).resolves.toEqual({
      address: "2606:4700::1111",
      family: 6,
    });
  });
  it("refuses when ANY resolved address is not routable (A and AAAA both checked)", async () => {
    const lookup = async () => [
      { address: "104.16.0.1", family: 4 as const },
      { address: "fd00::1", family: 6 as const },
    ];
    await expect(resolvePinnedAddress("ir.example.com", lookup)).rejects.toThrow(/non-routable/);
  });
  it("refuses an empty answer", async () => {
    await expect(resolvePinnedAddress("ir.example.com", async () => [])).rejects.toThrow(/no address/);
  });
  it("never calls lookup for a literal IP and validates it directly", async () => {
    let called = false;
    const lookup = async () => {
      called = true;
      return [];
    };
    await expect(resolvePinnedAddress("8.8.8.8", lookup)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expect(resolvePinnedAddress("10.0.0.1", lookup)).rejects.toThrow(/non-routable/);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ssrf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/print-watch/ssrf.ts`**

```ts
// The SSRF contract for the pasted-URL road (spec §4.2 "URL"). Pure except
// `systemLookup`. Every rule is a named test in tests/print-watch/ssrf.test.ts.
import net from "node:net";
import dns from "node:dns";

export type SsrfVerdict = { ok: true; hostname: string } | { ok: false; reason: string };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

export function validatePublicUrl(raw: string): SsrfVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https:// links are accepted" };
  if (url.username || url.password) return { ok: false, reason: "links with embedded credentials are refused" };
  if (url.port && url.port !== "443") return { ok: false, reason: "only port 443 is accepted" };
  const hostname = stripBrackets(url.hostname);
  if (!hostname) return { ok: false, reason: "not a valid URL" };
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "local hostnames are refused" };
  }
  if (net.isIP(hostname) !== 0 && !isGloballyRoutable(hostname)) {
    return { ok: false, reason: "address is not globally routable" };
  }
  return { ok: true, hostname };
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** [base, prefix bits] — spec §4.2: loopback, RFC1918, link-local (incl. the
 *  cloud-metadata address), CGNAT, benchmarking, documentation, multicast,
 *  reserved, broadcast, and "this network". */
const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function inV4Block(ip: number, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

/** Eight 16-bit words, or null when the text is not an IPv6 address. Handles
 *  `::` compression and an embedded dotted-quad tail (`::ffff:1.2.3.4`). */
function expandIpv6(ip: string): number[] | null {
  let s = ip;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (net.isIP(tail[1]) !== 4) return null;
    const n = ipv4ToInt(tail[1]);
    s = `${s.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const parts = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
  return parts.map((p) => Number.parseInt(p, 16));
}

export function isGloballyRoutable(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return !IPV4_BLOCKED.some((block) => inV4Block(n, block));
  }
  if (family !== 6) return false;
  const w = expandIpv6(ip);
  if (!w) return false;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeroPrefix = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (w.every((x) => x === 0)) return false;                        // ::
  if (zeroPrefix(7) && w[7] === 1) return false;                    // ::1
  if (zeroPrefix(5) && w[5] === 0xffff) return isGloballyRoutable(embeddedV4(w[6], w[7]));   // ::ffff:0:0/96 mapped
  if (zeroPrefix(6)) return isGloballyRoutable(embeddedV4(w[6], w[7]));                     // ::/96 IPv4-compatible
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return false;                         // 64:ff9b:1::/48 local NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    return isGloballyRoutable(embeddedV4(w[6], w[7]));                                      // 64:ff9b::/96 NAT64
  }
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return false;               // 100::/64 discard
  if (w[0] === 0x2002) return isGloballyRoutable(embeddedV4(w[1], w[2]));                    // 2002::/16 6to4
  if (w[0] === 0x2001 && w[1] === 0) return false;                                          // 2001::/32 Teredo
  if (w[0] === 0x2001 && (w[1] & 0xfff0) === 0x0010) return false;                         // 2001:10::/28 ORCHID
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false;                                     // 2001:db8::/32 documentation
  if ((w[0] & 0xfe00) === 0xfc00) return false;                                             // fc00::/7 ULA
  if ((w[0] & 0xffc0) === 0xfe80) return false;                                             // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return false;                                             // fec0::/10 site-local
  if ((w[0] & 0xff00) === 0xff00) return false;                                             // ff00::/8 multicast
  return true;
}

export const systemLookup: LookupFn = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((r) => ({
    address: r.address,
    family: r.family as 4 | 6,
  }));

/** Resolve A and AAAA; EVERY address must be globally routable. Returns the
 *  first, which the caller pins into the socket's `lookup`. */
export async function resolvePinnedAddress(
  hostname: string,
  lookup: LookupFn = systemLookup,
): Promise<ResolvedAddress> {
  const literal = net.isIP(hostname);
  const results: ResolvedAddress[] =
    literal !== 0 ? [{ address: hostname, family: literal as 4 | 6 }] : await lookup(hostname);
  if (results.length === 0) throw new Error(`${hostname}: no address`);
  for (const r of results) {
    if (!isGloballyRoutable(r.address)) throw new Error(`${hostname}: resolves to a non-routable address`);
  }
  return results[0];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ssrf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b3.txt <<'EOF'
feat(print-watch): SSRF contract for the pasted-URL road

validatePublicUrl (https, port 443, no credentials, no local names),
isGloballyRoutable (every blocked IPv4/IPv6 range as a named test, mapped
and NAT64 forms apply the v4 rules), resolvePinnedAddress (A and AAAA,
all must be routable). Spec 4.2 URL.
EOF
git commit lib/print-watch/ssrf.ts tests/print-watch/ssrf.test.ts -F /tmp/msg-b3.txt
```

---

### Task 4: `hardenedFetchBytes` — pinned `node:https` fetch with a shared abort budget

**Files:**
- Create: `lib/print-watch/url-fetch.ts`
- Test: `tests/print-watch/url-fetch.test.ts`

**Interfaces:**
- Consumes: `validatePublicUrl`, `resolvePinnedAddress`, `LookupFn` (Task 3); `redactUrl` (Task 2).
- Produces (Tasks 9, 11, 12 consume):

```ts
// lib/print-watch/url-fetch.ts
export const URL_FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const URL_FETCH_TIMEOUT_MS = 20_000;
export const URL_FETCH_MAX_REDIRECTS = 3;
export type BytesKind = "pdf" | "html" | "text";
export function classifyBytes(buf: Buffer): BytesKind | "binary";
export class UrlFetchRefused extends Error { readonly status: number | null }
export interface FetchedBytes { bytes: Buffer; finalUrl: string; status: number; contentType: string | null }
export type RequestLike = typeof import("node:https").request;
export interface HardenedFetchBytesOptions {
  label: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  lookup?: LookupFn;
  request?: RequestLike;
  /** Applied to the initial host AND every redirect hop (the IR lane passes its allowlist). */
  allowHost?: (hostname: string) => boolean;
}
export async function hardenedFetchBytes(rawUrl: string, opts: HardenedFetchBytesOptions): Promise<FetchedBytes>;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/url-fetch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { hardenedFetchBytes, classifyBytes, UrlFetchRefused } from "@/lib/print-watch/url-fetch";

/** A scripted https.request: one entry per URL; `chunks` streams the body. */
interface Scripted {
  status: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  hang?: boolean;
}

function fakeRequest(script: Record<string, Scripted>) {
  const calls: Array<{ host: string; path: string; opts: Record<string, unknown> }> = [];
  const destroyed: string[] = [];
  const request = ((opts: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
    const url = `https://${String(opts.host)}${String(opts.path)}`;
    calls.push({ host: String(opts.host), path: String(opts.path), opts });
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(err?: Error): void };
    req.end = () => {
      const entry = script[url];
      if (!entry) {
        setImmediate(() => req.emit("error", new Error(`unscripted ${url}`)));
        return;
      }
      if (entry.hang) return;
      const res = Readable.from(entry.chunks ?? [Buffer.alloc(0)]) as unknown as IncomingMessage;
      Object.assign(res, { statusCode: entry.status, headers: entry.headers ?? {} });
      const origDestroy = res.destroy.bind(res);
      res.destroy = ((err?: Error) => {
        destroyed.push(url);
        return origDestroy(err);
      }) as typeof res.destroy;
      setImmediate(() => cb(res));
    };
    req.destroy = () => {
      destroyed.push(`req:${url}`);
    };
    const signal = opts.signal as AbortSignal | undefined;
    signal?.addEventListener("abort", () => req.destroy());
    return req;
  }) as unknown as typeof import("node:https").request;
  return { request, calls, destroyed };
}

const PUBLIC = async () => [{ address: "104.16.0.1", family: 4 as const }];
const PRIVATE = async () => [{ address: "10.0.0.1", family: 4 as const }];

describe("hardenedFetchBytes", () => {
  it("fetches through the pinned lookup with SNI intact and returns the bytes", async () => {
    const { request, calls } = fakeRequest({
      "https://ir.example.com/release.pdf": { status: 200, headers: { "content-type": "application/pdf" }, chunks: [Buffer.from("%PDF-1.7 hello")] },
    });
    const out = await hardenedFetchBytes("https://ir.example.com/release.pdf", { label: "t", lookup: PUBLIC, request });
    expect(out.bytes.toString()).toBe("%PDF-1.7 hello");
    expect(out.finalUrl).toBe("https://ir.example.com/release.pdf");
    expect(out.contentType).toBe("application/pdf");
    expect(calls[0].opts.servername).toBe("ir.example.com");
    expect(calls[0].opts.port).toBe(443);
    expect(calls[0].opts.agent).toBe(false);
    const lookup = calls[0].opts.lookup as (h: string, o: Record<string, unknown>, cb: (...a: unknown[]) => void) => void;
    await new Promise<void>((resolve) =>
      lookup("ir.example.com", {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe("104.16.0.1");
        expect(family).toBe(4);
        resolve();
      }),
    );
    await new Promise<void>((resolve) =>
      lookup("ir.example.com", { all: true }, (err, addresses) => {
        expect(err).toBeNull();
        expect(addresses).toEqual([{ address: "104.16.0.1", family: 4 }]);
        resolve();
      }),
    );
  });

  it("refuses http, credentials, and a non-443 port before any lookup or request", async () => {
    const lookup = vi.fn(PUBLIC);
    const { request, calls } = fakeRequest({});
    for (const url of ["http://ir.example.com/x", "https://u:p@ir.example.com/x", "https://ir.example.com:8443/x"]) {
      await expect(hardenedFetchBytes(url, { label: "t", lookup, request })).rejects.toBeInstanceOf(UrlFetchRefused);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses a hostname that resolves to a private address and never opens a socket", async () => {
    const { request, calls } = fakeRequest({});
    await expect(hardenedFetchBytes("https://ir.example.com/x", { label: "t", lookup: PRIVATE, request })).rejects.toThrow(/non-routable/);
    expect(calls).toHaveLength(0);
  });

  it("follows up to 3 redirect hops, revalidating and re-pinning each, then refuses the 4th", async () => {
    const lookup = vi.fn(PUBLIC);
    const { request, calls } = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "/2" } },
      "https://a.example/2": { status: 301, headers: { location: "https://b.example/3" } },
      "https://b.example/3": { status: 307, headers: { location: "/4" } },
      "https://b.example/4": { status: 200, chunks: [Buffer.from("<html>ok</html>")] },
    });
    const out = await hardenedFetchBytes("https://a.example/1", { label: "t", lookup, request });
    expect(out.finalUrl).toBe("https://b.example/4");
    expect(calls.map((c) => c.host)).toEqual(["a.example", "a.example", "b.example", "b.example"]);
    expect(lookup).toHaveBeenCalledTimes(4);

    const four = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "/2" } },
      "https://a.example/2": { status: 302, headers: { location: "/3" } },
      "https://a.example/3": { status: 302, headers: { location: "/4" } },
      "https://a.example/4": { status: 302, headers: { location: "/5" } },
      "https://a.example/5": { status: 200, chunks: [Buffer.from("x")] },
    });
    await expect(hardenedFetchBytes("https://a.example/1", { label: "t", lookup: PUBLIC, request: four.request })).rejects.toThrow(/3 redirect hops/);
  });

  it("refuses a redirect hop that leaves https or lands on a private address", async () => {
    const { request } = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "http://a.example/2" } },
    });
    await expect(hardenedFetchBytes("https://a.example/1", { label: "t", lookup: PUBLIC, request })).rejects.toThrow(/https/);

    const lookup = vi.fn(async (host: string) => (host === "internal.example" ? PRIVATE() : PUBLIC()));
    const hop = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "https://internal.example/2" } },
    });
    await expect(hardenedFetchBytes("https://a.example/1", { label: "t", lookup, request: hop.request })).rejects.toThrow(/non-routable/);
  });

  it("refuses on the content-length precheck and on the streamed cap, destroying the response", async () => {
    const declared = fakeRequest({
      "https://a.example/big": { status: 200, headers: { "content-length": String(11 * 1024 * 1024) }, chunks: [Buffer.alloc(10)] },
    });
    await expect(hardenedFetchBytes("https://a.example/big", { label: "t", lookup: PUBLIC, request: declared.request })).rejects.toThrow(/content-length/);
    expect(declared.destroyed).toContain("https://a.example/big");

    const streamed = fakeRequest({
      "https://a.example/lying": { status: 200, chunks: [Buffer.alloc(600), Buffer.alloc(600)] },
    });
    await expect(hardenedFetchBytes("https://a.example/lying", { label: "t", lookup: PUBLIC, request: streamed.request, maxBytes: 1000 })).rejects.toThrow(/exceeded/);
    expect(streamed.destroyed).toContain("https://a.example/lying");
  });

  it("aborts a hung request when the shared 20s budget elapses (here: 30ms) and closes the socket", async () => {
    const { request, destroyed } = fakeRequest({ "https://a.example/hang": { status: 200, hang: true } });
    await expect(hardenedFetchBytes("https://a.example/hang", { label: "t", lookup: PUBLIC, request, timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(destroyed).toContain("req:https://a.example/hang");
  });

  it("races the DNS lookup against the shared budget and never opens a socket after it lapses (Codex #8)", async () => {
    const { request, calls } = fakeRequest({});
    const never = () => new Promise<never>(() => {});
    await expect(hardenedFetchBytes("https://slow.example/x", { label: "t", lookup: never, request, timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(calls).toHaveLength(0);
  });

  it("applies allowHost at every hop and destroys the redirect response instead of reading it", async () => {
    const { request, destroyed } = fakeRequest({
      "https://ir.acme.example/1": { status: 302, headers: { location: "https://mirror.example/2" }, chunks: [Buffer.alloc(100)] },
      "https://mirror.example/2": { status: 200, chunks: [Buffer.from("x")] },
    });
    await expect(
      hardenedFetchBytes("https://ir.acme.example/1", { label: "t", lookup: PUBLIC, request, allowHost: (h) => h === "ir.acme.example" }),
    ).rejects.toThrow(/host not allowed/);
    expect(destroyed).toContain("https://ir.acme.example/1");
  });

  it("reports a 403 with the IR-site / EDGAR hint and never a raw token in any error", async () => {
    const { request } = fakeRequest({ "https://wire.example/story?token=SECRET": { status: 403 } });
    const err = await hardenedFetchBytes("https://wire.example/story?token=SECRET", { label: "t", lookup: PUBLIC, request }).catch((e) => e as UrlFetchRefused);
    expect(err).toBeInstanceOf(UrlFetchRefused);
    expect((err as UrlFetchRefused).status).toBe(403);
    expect((err as Error).message).toMatch(/IR-site link or the EDGAR exhibit/);
    expect((err as Error).message).not.toMatch(/SECRET/);
  });
});

describe("classifyBytes", () => {
  it("recognises PDF, HTML (doctype or tag, BOM tolerated), and text", () => {
    expect(classifyBytes(Buffer.from("%PDF-1.4\n"))).toBe("pdf");
    expect(classifyBytes(Buffer.from("  <!DOCTYPE html><p>x"))).toBe("html");
    expect(classifyBytes(Buffer.from("﻿<html><body>", "utf8"))).toBe("html");
    expect(classifyBytes(Buffer.from("ACME reports Q2 results\nRevenue $1.0B\n"))).toBe("text");
  });
  it("refuses binary: a NUL byte, or 2% or more control bytes in the first 4KB", () => {
    expect(classifyBytes(Buffer.from([0x41, 0x00, 0x42]))).toBe("binary");
    const controls = Buffer.alloc(100, 0x41);
    for (let i = 0; i < 2; i++) controls[i] = 0x01;
    expect(classifyBytes(controls)).toBe("binary");
    const ok = Buffer.alloc(100, 0x41);
    ok[0] = 0x01;
    expect(classifyBytes(ok)).toBe("text");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/url-fetch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/print-watch/url-fetch.ts`**

```ts
// The pasted-URL road's fetch (spec §4.2 "URL", plan M2). `node:https` with
// the socket's `lookup` pinned to the address the SSRF contract already
// validated, so a DNS answer cannot change between validation and connect.
// One AbortController budgets every hop; `req.destroy()` closes the socket.
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { validatePublicUrl, resolvePinnedAddress, type LookupFn, type ResolvedAddress } from "./ssrf";
import { redactUrl } from "./hardened-fetch";

export const URL_FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const URL_FETCH_TIMEOUT_MS = 20_000;
export const URL_FETCH_MAX_REDIRECTS = 3;
const USER_AGENT = "PortfolioDesk contact@myportfoliodesk.com";

export type BytesKind = "pdf" | "html" | "text";
export type RequestLike = typeof https.request;

export class UrlFetchRefused extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "UrlFetchRefused";
  }
}

export interface FetchedBytes {
  bytes: Buffer;
  finalUrl: string;
  status: number;
  contentType: string | null;
}

export interface HardenedFetchBytesOptions {
  label: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  lookup?: LookupFn;
  request?: RequestLike;
  /** Applied to the initial host AND every redirect hop (the IR lane passes its allowlist). */
  allowHost?: (hostname: string) => boolean;
}

const HINT_403 = "wire syndicators often block direct fetches — paste the company's IR-site link or the EDGAR exhibit instead";

/** Node's socket `lookup` callback takes an array when `options.all` is set
 *  (the autoSelectFamily path on Node ≥ 20) and a single address otherwise. */
function pinnedLookup(pinned: ResolvedAddress) {
  return (
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ): void => {
    if (typeof options === "function") {
      (options as (...a: unknown[]) => void)(null, pinned.address, pinned.family);
      return;
    }
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function readCappedStream(
  res: IncomingMessage,
  capBytes: number,
  signal: AbortSignal,
  label: string,
  shownUrl: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onAbort = () => {
      res.destroy();
      reject(new UrlFetchRefused(`${label}: timed out reading ${shownUrl}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > capBytes) {
        signal.removeEventListener("abort", onAbort);
        res.destroy();
        reject(new UrlFetchRefused(`${label}: streamed body exceeded ${capBytes}-byte cap (${shownUrl})`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

export async function hardenedFetchBytes(
  rawUrl: string,
  opts: HardenedFetchBytesOptions,
): Promise<FetchedBytes> {
  const { label } = opts;
  const maxBytes = opts.maxBytes ?? URL_FETCH_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
  const lookup = opts.lookup ?? undefined;
  const request = opts.request ?? https.request;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const shownStart = redactUrl(rawUrl);

  try {
    let current = rawUrl;
    for (let hop = 0; ; hop += 1) {
      const verdict = validatePublicUrl(current);
      if (!verdict.ok) throw new UrlFetchRefused(`${label}: ${verdict.reason} (${redactUrl(current)})`);
      if (opts.allowHost && !opts.allowHost(verdict.hostname)) {
        throw new UrlFetchRefused(`${label}: host not allowed for this road (${redactUrl(current)})`);
      }
      // The lookup is raced against the shared deadline (Codex #8): a stalled
      // resolver must not outlive the 20-second contract any more than a socket.
      const timedOut = new Promise<never>((_, reject) => {
        const fail = () => reject(new UrlFetchRefused(`${label}: timed out after ${timeoutMs}ms (${shownStart})`));
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      const pinned = await Promise.race([resolvePinnedAddress(verdict.hostname, lookup), timedOut]).catch((err: Error) => {
        if (err instanceof UrlFetchRefused) throw err;
        throw new UrlFetchRefused(`${label}: ${err.message.replace(verdict.hostname, redactUrl(current))}`);
      });

      const u = new URL(current);
      const shown = redactUrl(current);
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            protocol: "https:",
            host: verdict.hostname,
            servername: verdict.hostname,
            port: 443,
            path: `${u.pathname}${u.search}`,
            method: "GET",
            agent: false,
            headers: { "User-Agent": USER_AGENT, ...(opts.headers ?? {}) },
            lookup: pinnedLookup(pinned) as unknown as https.RequestOptions["lookup"],
            signal: controller.signal,
          },
          resolve,
        );
        req.on("error", (err: Error) =>
          reject(
            controller.signal.aborted
              ? new UrlFetchRefused(`${label}: timed out after ${timeoutMs}ms (${shownStart})`)
              : new UrlFetchRefused(`${label}: ${err.message} (${shown})`),
          ),
        );
        req.end();
      });

      const status = res.statusCode ?? 0;
      // Every non-final response is DESTROYED, never resumed (Codex #8): a
      // redirect body must not be read to completion on the caller's budget.
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.destroy();
        if (hop >= URL_FETCH_MAX_REDIRECTS) {
          throw new UrlFetchRefused(`${label}: exceeded ${URL_FETCH_MAX_REDIRECTS} redirect hops (${shownStart})`);
        }
        if (!location) throw new UrlFetchRefused(`${label}: redirect ${status} with no Location (${shown})`);
        current = new URL(location, current).toString();
        continue;
      }
      if (status === 403) {
        res.destroy();
        throw new UrlFetchRefused(`${label}: HTTP 403 for ${shown} — ${HINT_403}`, 403);
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        throw new UrlFetchRefused(`${label}: HTTP ${status} for ${shown}`, status);
      }
      const declared = res.headers["content-length"];
      if (declared && Number(declared) > maxBytes) {
        res.destroy();
        throw new UrlFetchRefused(`${label}: content-length ${declared} exceeds ${maxBytes}-byte cap (${shown})`);
      }
      const bytes = await readCappedStream(res, maxBytes, controller.signal, label, shown);
      const contentTypeHeader = res.headers["content-type"];
      return {
        bytes,
        finalUrl: current,
        status,
        contentType: Array.isArray(contentTypeHeader) ? contentTypeHeader[0] ?? null : contentTypeHeader ?? null,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Type by magic bytes (spec §4.2): `%PDF-`; `<html` / `<!doctype`; else text
 *  only if the first 4KB has no NUL and under 2% control bytes; else binary. */
export function classifyBytes(buf: Buffer): BytesKind | "binary" {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  let head = buf.subarray(0, 4096);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) head = head.subarray(3);
  const lower = head.toString("latin1").trimStart().toLowerCase();
  if (lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.includes("<html")) return "html";
  if (head.length === 0) return "binary";
  let control = 0;
  for (const b of head) {
    if (b === 0) return "binary";
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control += 1;
  }
  return control / head.length < 0.02 ? "text" : "binary";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/url-fetch.test.ts`
Expected: PASS. If the hung-request test flakes on timing, raise the test's `timeoutMs` to 60 — the assertion is on the message and the `req:` destroy record, not the duration.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b4.txt <<'EOF'
feat(print-watch): hardenedFetchBytes — pinned node:https fetch for pasted URLs

Per-hop SSRF revalidation with a fresh pinned lookup (max 3 hops), one
AbortController budget shared across hops, content-length precheck plus
streamed 10MB cap, 403 hint copy, every message through redactUrl, and
classifyBytes (pdf / html / text / binary) by magic bytes. No undici:
node:https request with lookup + servername + agent:false (plan M2).
EOF
git commit lib/print-watch/url-fetch.ts tests/print-watch/url-fetch.test.ts -F /tmp/msg-b4.txt
```

---

### Task 5: Gate module — `validateDocForEvent` moves out of the watcher; version + fingerprint + content/road verdicts

**Files:**
- Create: `lib/print-watch/gate.ts`
- Modify: `lib/print-watch/watcher.ts` (delete lines 213–229 `DocGateContext`/`DocGateVerdict` and lines 542–632 — the block from `const QUARTER_WORD_RE` through the end of `validateDocForEvent` — and re-export them from `./gate`)
- Test: `tests/print-watch/gate.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 8's `recordDelivery` and Task 13's merge handler consume):

```ts
// lib/print-watch/gate.ts
export interface DocGateContext { symbol: string; issuerName: string | null; eventDate: string; kind?: PrintWatchDocKind }
export type DocGateVerdict = { ok: true } | { ok: false; reason: string };
export const GATE_VERSION = 2;
export function validateDocForEvent(text: string, ctx: DocGateContext): DocGateVerdict;   // moved verbatim
export function gateFingerprint(ctx: Pick<DocGateContext, "symbol" | "issuerName" | "eventDate">): string;
/** The document-level verdict: the gate with NO road in hand (loose branch available). */
export function contentVerdict(text: string, ctx: DocGateContext): DocGateVerdict;
/** The road-level verdict: `ir-page` runs the strict expected-quarter check; every other road accepts. */
export function roadVerdict(kind: PrintWatchDocKind, text: string, ctx: DocGateContext): DocGateVerdict;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GATE_VERSION, gateFingerprint, contentVerdict, roadVerdict, validateDocForEvent } from "@/lib/print-watch/gate";
import { validateDocForEvent as reExported } from "@/lib/print-watch/watcher";

const CTX = { symbol: "ACME", issuerName: "Acme Corp", eventDate: "2026-08-26" };
// Last quarter's fiscal labels: passes the loose (fiscal-year) branch, fails the strict ir-page branch.
const LAST_QUARTER = "ACME reports first quarter fiscal 2027 results. Revenue was $1.0 billion.";
const THIS_QUARTER = "ACME reports Q2 2026 results. Revenue was $1.0 billion.";

describe("gate module", () => {
  it("re-exports validateDocForEvent from the watcher unchanged", () => {
    expect(reExported).toBe(validateDocForEvent);
  });

  it("fingerprint is stable for equal identity and changes with symbol, issuer, date, or version", () => {
    const a = gateFingerprint(CTX);
    expect(gateFingerprint({ ...CTX })).toBe(a);
    expect(gateFingerprint({ ...CTX, symbol: "acme" })).toBe(a); // case-insensitive symbol
    expect(gateFingerprint({ ...CTX, issuerName: null })).not.toBe(a);
    expect(gateFingerprint({ ...CTX, eventDate: "2026-11-18" })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(GATE_VERSION).toBe(2);
  });

  it("contentVerdict uses the loose branch regardless of the road", () => {
    expect(contentVerdict(LAST_QUARTER, { ...CTX, kind: "ir-page" }).ok).toBe(true);
    expect(contentVerdict("Some other company. Q2 2026.", CTX).ok).toBe(false);
  });

  it("roadVerdict is strict for ir-page and permissive for every other road", () => {
    expect(roadVerdict("ir-page", LAST_QUARTER, CTX).ok).toBe(false);
    expect(roadVerdict("ir-page", THIS_QUARTER, CTX).ok).toBe(true);
    for (const kind of ["dj-release", "edgar-ex99", "user-drop", "user-url"] as const) {
      expect(roadVerdict(kind, LAST_QUARTER, CTX)).toEqual({ ok: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/gate.test.ts`
Expected: FAIL — module not found. (`"user-url"` is not yet in `PrintWatchDocKind`; Task 8 widens it. Until then the `for` loop's `as const` array will not type-check — add `"user-url"` to `PrintWatchDocKind` in `lib/print-watch/types.ts` in THIS task, it is a one-word type change with no runtime effect.)

- [ ] **Step 3: Create `lib/print-watch/gate.ts` and re-export from the watcher**

Move the following, verbatim and in this order, from `lib/print-watch/watcher.ts` into `lib/print-watch/gate.ts`: `DocGateContext`, `DocGateVerdict`, `QUARTER_WORD_RE`, `FISCAL_YEAR_RE`, `ORDINALS`, `issuerNeedle`, `candidateQuarters`, `validateDocForEvent` (with their doc comments). Add at the top of `gate.ts`:

```ts
// The document-to-event gate (v1 spec §4.4), moved out of the watcher so the
// delivery store (Task 8) and the merge handler (Task 13) can evaluate it
// without importing the watcher. Pure: no db, no I/O.
import crypto from "node:crypto";
import type { PrintWatchDocKind } from "./types";

/** Bump when the gate's rules change: a stored `gate_fingerprint` built under
 *  an older version differs and the next delivery re-evaluates the verdict. */
export const GATE_VERSION = 2;
```

and at the bottom:

```ts
export function gateFingerprint(
  ctx: Pick<DocGateContext, "symbol" | "issuerName" | "eventDate">,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([GATE_VERSION, ctx.symbol.toUpperCase(), ctx.issuerName ?? null, ctx.eventDate]))
    .digest("hex");
}

export function contentVerdict(text: string, ctx: DocGateContext): DocGateVerdict {
  return validateDocForEvent(text, { symbol: ctx.symbol, issuerName: ctx.issuerName, eventDate: ctx.eventDate });
}

export function roadVerdict(kind: PrintWatchDocKind, text: string, ctx: DocGateContext): DocGateVerdict {
  if (kind !== "ir-page") return { ok: true };
  return validateDocForEvent(text, { symbol: ctx.symbol, issuerName: ctx.issuerName, eventDate: ctx.eventDate, kind });
}
```

In `watcher.ts`, replace the deleted block with:

```ts
import { validateDocForEvent, type DocGateContext, type DocGateVerdict } from "./gate";
export { validateDocForEvent };
export type { DocGateContext, DocGateVerdict };
```

(`gateContextFor` stays in the watcher for now; Task 9 drops its `kind` parameter.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/`
Expected: PASS — including every existing `validateDocForEvent` and `ingestDocument — gate` test in `watcher.test.ts`, which now exercise the re-export.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b5.txt <<'EOF'
refactor(print-watch): gate module — validateDocForEvent moves out of the watcher

Adds GATE_VERSION, gateFingerprint (symbol/issuer/date/version), and the
content vs road verdict split the v2 delivery store needs (ir-page is the
one stricter road). Watcher re-exports; behaviour unchanged.
EOF
git commit lib/print-watch/gate.ts lib/print-watch/watcher.ts lib/print-watch/types.ts tests/print-watch/gate.test.ts -F /tmp/msg-b5.txt
```

---

### Task 6: Migration 089 — sidecar tables and the documents/lines rebuild (`.ts`)

**Files:**
- Create: `lib/db/migrations/089_print_watch_document_identity.ts`
- Modify: `lib/db/code-migrations.ts` (register)
- Test: `tests/db/migration-089-document-identity.test.ts`

**Interfaces:**
- Consumes: `reconcile` (`lib/print-watch/reconcile.ts`, unchanged), `redactUrl` (Task 2), `runMigrations` options (Task 1). Imports inside the migration are RELATIVE (`../../print-watch/reconcile`) — never the `@/` alias — so the file is loadable from the rehearsal script (Task 7) under `tsx` from any cwd.
- Produces:

```ts
// lib/db/migrations/089_print_watch_document_identity.ts
export interface RebuildHooks { afterPhase?: (phase: number) => void; log?: (line: string) => void; existsSync?: (p: string) => boolean }
export interface RebuildReport {
  documents: { before: number; after: number; merged: number };
  roads: number;
  candidates: { before: number; kept: number; archived: number };
  linesRechecked: number;
  linesChanged: Array<{ printId: number; metricId: string; from: string; to: string }>;
  missingBytes: string[];
  urlsSanitised: number;
  /** Lines whose candidates_json could not be parsed: copied verbatim, raw value archived (M7). */
  unparseableLines: number;
}
export function rebuildDocumentIdentity(db: Database.Database, hooks?: RebuildHooks): RebuildReport;
export function up(db: Database.Database): void;   // = rebuildDocumentIdentity(db, {}) — the registry entry
```

**Final schema after 089** (the plan's single source for Task 8's row types):

```sql
CREATE TABLE print_watch_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  kind TEXT NOT NULL CHECK (kind IN ('dj-release','edgar-ex99','ir-page','user-drop','user-url')),  -- the FIRST road
  source TEXT NOT NULL,                                                                              -- the FIRST road's label
  url TEXT,                                                                                          -- the FIRST road's (redacted) url
  sha256 TEXT NOT NULL,
  bytes_path TEXT NOT NULL,
  parsed_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  gate_verdict TEXT NOT NULL DEFAULT 'rejected' CHECK (gate_verdict IN ('accepted','rejected')),
  gate_reason TEXT,
  gate_version INTEGER NOT NULL DEFAULT 0,
  gate_fingerprint TEXT,
  parse_state TEXT NOT NULL DEFAULT 'queued' CHECK (parse_state IN ('queued','claimed','parsed','failed')),
  parse_claim_token TEXT,
  parse_claimed_at TEXT,
  parse_attempts INTEGER NOT NULL DEFAULT 0,     -- durable attempt count (M15)
  parse_last_error TEXT,
  text_sha256 TEXT,                              -- normalised-text identity (M13)
  UNIQUE(print_id, sha256)
);
CREATE INDEX idx_pw_documents_print ON print_watch_documents(print_id);
CREATE INDEX idx_pw_documents_parse ON print_watch_documents(print_id, parse_state);
CREATE INDEX idx_pw_documents_text ON print_watch_documents(print_id, text_sha256);

CREATE TABLE print_watch_document_roads (
  document_id INTEGER NOT NULL REFERENCES print_watch_documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('dj-release','edgar-ex99','ir-page','user-drop','user-url')),
  source TEXT NOT NULL,
  url TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_count INTEGER NOT NULL DEFAULT 1,
  road_verdict TEXT NOT NULL CHECK (road_verdict IN ('accepted','rejected')),
  road_reason TEXT,
  PRIMARY KEY (document_id, kind, source)
);

CREATE TABLE print_watch_lines (
  print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
  metric_id TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  expected_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','flash','single_source','agreed','conflict','blank','accepted','retired')),
  value REAL, value_high REAL, snippet TEXT,
  source_doc_id INTEGER REFERENCES print_watch_documents(id),
  candidates_json TEXT NOT NULL DEFAULT '[]',
  audit_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (print_id, metric_id)
);

CREATE TABLE print_watch_candidate_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id INTEGER NOT NULL,
  metric_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE print_watch_sources (
  symbol TEXT PRIMARY KEY,
  ir_page_url TEXT NOT NULL,
  link_must_contain TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE print_watch_ir_seen (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  link TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  baseline INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, link)
);

-- The baseline completion marker (M5): written in the SAME transaction as the
-- baseline's links; keyed by the IR URL's fingerprint so a changed URL is a new baseline.
CREATE TABLE print_watch_ir_baseline (
  event_id INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  link_count INTEGER NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 1: Write the failing tests**

`tests/db/migration-089-document-identity.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { up, rebuildDocumentIdentity } from "@/lib/db/migrations/089_print_watch_document_identity";
import type { TaggedCandidate } from "@/lib/print-watch/types";

const NAME = "089_print_watch_document_identity.ts";

/** A DB at the 088 schema (every .sql, no code migration). */
function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, { codeMigrations: {} });
  return db;
}

function apply089(db: Database.Database): void {
  runMigrations(db, { codeMigrations: { [NAME]: up } });
}

function seedPrint(db: Database.Database, sourceKey = "finnhub:ACME:2026-08-26"): number {
  const eventId = Number(
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
       VALUES ('finnhub','earnings','2026-08-26','ACME earnings',?, 'ACME')`,
    ).run(sourceKey).lastInsertRowid,
  );
  return Number(
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, release_time_et, state)
       VALUES (?, 'ACME', '2026-08-26', '16:05', 'parsed')`,
    ).run(eventId).lastInsertRowid,
  );
}

function seedLegacyDoc(
  db: Database.Database,
  printId: number,
  kind: string,
  source: string,
  url: string | null,
  sha: string,
  bytesPath: string,
  parsed: boolean,
): number {
  return Number(
    db.prepare(
      `INSERT INTO print_watch_documents (print_id, kind, source, url, sha256, bytes_path, parsed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(printId, kind, source, url, sha, bytesPath, parsed ? "2026-08-26 20:10:00" : null).lastInsertRowid,
  );
}

function cand(metric: string, value: number, docId: number, rep: "repA" | "repB" | "flash"): TaggedCandidate {
  return {
    metric_id: metric, value, value_high: null, raw_text: String(value), snippet: `${metric} ${value}`,
    location_hint: null, not_disclosed: false, doc_id: docId, representation: rep, weak_pair: false,
  };
}

function seedLine(
  db: Database.Database, printId: number, metric: string, state: string, value: number | null,
  sourceDocId: number | null, candidates: TaggedCandidate[],
): void {
  db.prepare(
    `INSERT INTO print_watch_lines (print_id, metric_id, contract_json, expected_json, state, value, source_doc_id, candidates_json)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    printId, metric,
    JSON.stringify({ metric_id: metric, label: metric, definition: "t", basis: "gaap", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null }),
    state, value, sourceDocId, JSON.stringify(candidates),
  );
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m089-"));
});

describe("migration 089 — fresh database shape", () => {
  it("creates the sidecar tables, widens kind and state, and dedupes on (print_id, sha256)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["print_watch_document_roads", "print_watch_candidate_archive", "print_watch_sources", "print_watch_ir_seen", "print_watch_ir_baseline"]) {
      expect(names).toContain(t);
    }
    const docCols = (db.prepare("PRAGMA table_info(print_watch_documents)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["last_seen_at", "gate_verdict", "gate_reason", "gate_version", "gate_fingerprint", "parse_state", "parse_claim_token", "parse_claimed_at", "parse_attempts", "parse_last_error", "text_sha256"]) {
      expect(docCols).toContain(c);
    }
    expect((db.prepare("PRAGMA table_info(print_watch_lines)").all() as { name: string }[]).map((c) => c.name)).toContain("audit_json");
    const printId = seedPrint(db);
    db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict) VALUES (?, 'user-url', 'u', 'sha-1', '/x', 'accepted')`).run(printId);
    expect(() =>
      db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict) VALUES (?, 'edgar-ex99', 'e', 'sha-1', '/y', 'accepted')`).run(printId),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(`UPDATE print_watch_lines SET state = 'retired' WHERE 1 = 0`).run(),
    ).not.toThrow();
    expect((db.prepare("SELECT filename FROM schema_migrations WHERE filename = ?").get(NAME) as { filename: string }).filename).toBe(NAME);
  });
});

describe("migration 089 — rebuild of legacy rows", () => {
  it("merges same-hash documents into the lowest id, seeds one road per old row, remaps and archives candidates, and re-reconciles", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "release.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026 results");
    // Same bytes twice under two kinds (v1 UNIQUE was (print, kind, sha)), plus a distinct EDGAR doc.
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj:1", null, "sha-same", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "user-drop:acme.txt", "https://x.example/f?token=T", "sha-same", bytes, true);
    const d3 = seedLegacyDoc(db, printId, "edgar-ex99", "rejected:issuer not named (ACME)", "https://www.sec.gov/x", "sha-other", bytes, false);
    // Plain-text docs: one candidate each → the duplicate pair had greened `agreed`.
    seedLine(db, printId, "revenue_q", "agreed", 1000, d1, [cand("revenue_q", 1000, d1, "repB"), cand("revenue_q", 1000, d2, "repB")]);
    // A flash-only line keeps its sentinel doc_id 0.
    seedLine(db, printId, "eps_adj_q", "flash", 1.1, null, [cand("eps_adj_q", 1.1, 0, "flash")]);
    // An accepted line stays locked even though its candidates are pruned.
    seedLine(db, printId, "eps_gaap_q", "accepted", 0.5, d2, [cand("eps_gaap_q", 0.5, d1, "repB"), cand("eps_gaap_q", 0.5, d2, "repB")]);

    apply089(db);

    const docs = db.prepare("SELECT * FROM print_watch_documents ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(docs.map((d) => d.id)).toEqual([d1, d3]);
    expect(docs[0]).toMatchObject({ kind: "dj-release", gate_verdict: "accepted", parse_state: "parsed", gate_version: 1, gate_fingerprint: null });
    expect(docs[1]).toMatchObject({ source: "legacy-rejected", gate_verdict: "rejected", gate_reason: "issuer not named (ACME)", parse_state: "queued" });

    const roads = db.prepare("SELECT document_id, kind, source, url, road_verdict FROM print_watch_document_roads ORDER BY document_id, kind").all() as Array<Record<string, unknown>>;
    expect(roads).toEqual([
      { document_id: d1, kind: "dj-release", source: "dj:1", url: null, road_verdict: "accepted" },
      { document_id: d1, kind: "user-drop", source: "user-drop:acme.txt", url: "https://x.example/f", road_verdict: "accepted" },
      { document_id: d3, kind: "edgar-ex99", source: "legacy-rejected", url: "https://www.sec.gov/x", road_verdict: "rejected" },
    ]);

    const line = db.prepare("SELECT state, value, source_doc_id, candidates_json FROM print_watch_lines WHERE metric_id = 'revenue_q'").get() as { state: string; value: number; source_doc_id: number; candidates_json: string };
    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1000);
    expect(line.source_doc_id).toBe(d1);
    expect((JSON.parse(line.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([d1]);

    const archive = db.prepare("SELECT print_id, metric_id, candidate_json, reason FROM print_watch_candidate_archive ORDER BY id").all() as Array<{ print_id: number; metric_id: string; candidate_json: string; reason: string }>;
    expect(archive.map((a) => a.metric_id)).toEqual(["eps_gaap_q", "revenue_q"]);
    expect(archive.every((a) => (JSON.parse(a.candidate_json) as TaggedCandidate).doc_id === d2)).toBe(true);
    expect(archive[0].reason).toBe(`duplicate-of:${d1}`);

    const flash = db.prepare("SELECT state, candidates_json FROM print_watch_lines WHERE metric_id = 'eps_adj_q'").get() as { state: string; candidates_json: string };
    expect(flash.state).toBe("flash");
    expect((JSON.parse(flash.candidates_json) as TaggedCandidate[])[0].doc_id).toBe(0);

    const accepted = db.prepare("SELECT state, value, source_doc_id FROM print_watch_lines WHERE metric_id = 'eps_gaap_q'").get() as { state: string; value: number; source_doc_id: number };
    expect(accepted).toEqual({ state: "accepted", value: 0.5, source_doc_id: d1 });

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_new'").get() as { n: number }).n).toBe(0);
  });

  it("holds the candidate invariant: every original candidate is kept (remapped) or archived", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "s", bytes, true);
    const d3 = seedLegacyDoc(db, printId, "edgar-ex99", "e", null, "t", bytes, true);
    seedLine(db, printId, "m1", "agreed", 1, d1, [cand("m1", 1, d1, "repB"), cand("m1", 1, d2, "repB"), cand("m1", 1, d3, "repB")]);
    seedLine(db, printId, "m2", "single_source", 2, d2, [cand("m2", 2, d2, "repB")]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.candidates).toEqual({ before: 4, kept: 3, archived: 1 });
    expect(report.documents).toEqual({ before: 3, after: 2, merged: 1 });
    expect(report.roads).toBe(3);
    // m1 keeps d1 and d3 (independent pair across docs → still agreed); m2's only candidate is remapped d2→d1.
    const m1 = db.prepare("SELECT state FROM print_watch_lines WHERE metric_id='m1'").get() as { state: string };
    expect(m1.state).toBe("agreed");
    const m2 = db.prepare("SELECT source_doc_id, candidates_json FROM print_watch_lines WHERE metric_id='m2'").get() as { source_doc_id: number; candidates_json: string };
    expect(m2.source_doc_id).toBe(d1);
    expect((JSON.parse(m2.candidates_json) as TaggedCandidate[])[0].doc_id).toBe(d1);
    expect(report.linesChanged).toEqual([]);
  });

  it("a surviving document whose bytes are missing is rejected durably, its candidates archived, its lines re-reconciled (M7)", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const gone = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", path.join(tmp, "gone.txt"), true);
    seedLine(db, printId, "revenue_q", "single_source", 1000, gone, [cand("revenue_q", 1000, gone, "repB")]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.missingBytes).toEqual([path.join(tmp, "gone.txt")]);
    expect(db.prepare("SELECT gate_verdict, gate_reason FROM print_watch_documents WHERE id = ?").get(gone)).toEqual({ gate_verdict: "rejected", gate_reason: "bytes missing on disk" });
    const line = db.prepare("SELECT state, value, candidates_json FROM print_watch_lines WHERE metric_id = 'revenue_q'").get() as { state: string; value: number | null; candidates_json: string };
    expect(line).toEqual({ state: "pending", value: null, candidates_json: "[]" });
    expect((db.prepare("SELECT reason FROM print_watch_candidate_archive").all() as { reason: string }[]).map((a) => a.reason)).toEqual(["bytes-missing"]);
    expect(report.linesChanged).toEqual([{ printId, metricId: "revenue_q", from: "single_source", to: "pending" }]);
    expect(report.candidates).toEqual({ before: 1, kept: 0, archived: 1 });
  });

  it("copies malformed candidates_json verbatim and archives the raw value instead of rewriting it as [] (M7)", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", bytes, true);
    db.prepare(`INSERT INTO print_watch_lines (print_id, metric_id, contract_json, state, source_doc_id, candidates_json) VALUES (?, 'm', '{}', 'pending', ?, '{not json')`).run(printId, d1);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.unparseableLines).toBe(1);
    expect((db.prepare("SELECT candidates_json FROM print_watch_lines WHERE metric_id = 'm'").get() as { candidates_json: string }).candidates_json).toBe("{not json");
    expect(db.prepare("SELECT reason, candidate_json FROM print_watch_candidate_archive").get()).toEqual({ reason: "unparseable-json", candidate_json: "{not json" });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])("rolls back cleanly when phase %i throws", (phase) => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "s", bytes, true);
    seedLine(db, printId, "m1", "agreed", 1, d1, [cand("m1", 1, d1, "repB"), cand("m1", 1, d2, "repB")]);
    const before = {
      docs: db.prepare("SELECT * FROM print_watch_documents ORDER BY id").all(),
      lines: db.prepare("SELECT * FROM print_watch_lines ORDER BY metric_id").all(),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    };
    expect(() =>
      runMigrations(db, {
        codeMigrations: {
          [NAME]: (d) => rebuildDocumentIdentity(d, { log: () => {}, afterPhase: (p) => { if (p === phase) throw new Error(`boom@${phase}`); } }),
        },
      }),
    ).toThrow(`boom@${phase}`);
    expect(db.prepare("SELECT * FROM print_watch_documents ORDER BY id").all()).toEqual(before.docs);
    expect(db.prepare("SELECT * FROM print_watch_lines ORDER BY metric_id").all()).toEqual(before.lines);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(before.tables);
    expect(db.prepare("SELECT filename FROM schema_migrations WHERE filename = ?").get(NAME)).toBeUndefined();
  });

  it("sanitises legacy stored URLs on documents and roads", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    seedLegacyDoc(db, printId, "ir-page", "ir-rss:x", "https://ir.example/x?sig=S&id=1", "s", bytes, true);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.urlsSanitised).toBe(2); // the document row and its road row
    expect((db.prepare("SELECT url FROM print_watch_documents").get() as { url: string }).url).toBe("https://ir.example/x?id=1");
    expect((db.prepare("SELECT url FROM print_watch_document_roads").get() as { url: string }).url).toBe("https://ir.example/x?id=1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/migration-089-document-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration**

`lib/db/migrations/089_print_watch_document_identity.ts`:

```ts
// 089 (slice B, spec §4.2 "Identity and eligibility" + "Rebuild order"):
// documents dedupe on CONTENT (print_id, sha256); roads become provenance
// rows; lines gain `retired` and `audit_json`; candidates from a merged
// duplicate are archived (never silently dropped) and every affected line
// is re-reconciled so a duplicate-only `agreed` becomes an honest
// `single_source`. A CODE migration because phases (5) and (11) need JSON
// and the reconciler. Runs inside the runner's transaction; every phase is
// a rollback point (tests inject a throw after each).
//
// RELATIVE imports on purpose: the rehearsal script loads this file under
// tsx, where the `@/` alias does not resolve for dynamic imports.
import type Database from "better-sqlite3";
import fs from "node:fs";
import { reconcile } from "../../print-watch/reconcile";
import { redactUrl } from "../../print-watch/hardened-fetch";
import type { ExpectedValue, LineContract, PrintWatchLine, TaggedCandidate } from "../../print-watch/types";

export interface RebuildHooks {
  afterPhase?: (phase: number) => void;
  log?: (line: string) => void;
  existsSync?: (p: string) => boolean;
}

export interface RebuildReport {
  documents: { before: number; after: number; merged: number };
  roads: number;
  candidates: { before: number; kept: number; archived: number };
  linesRechecked: number;
  linesChanged: Array<{ printId: number; metricId: string; from: string; to: string }>;
  missingBytes: string[];
  urlsSanitised: number;
  /** Lines whose candidates_json could not be parsed: copied verbatim, raw value archived (M7). */
  unparseableLines: number;
}

const KINDS = "('dj-release','edgar-ex99','ir-page','user-drop','user-url')";
const REJECTED_PREFIX = "rejected:";
const FLASH_DOC_ID = 0;

interface OldDocRow {
  id: number; print_id: number; kind: string; source: string; url: string | null; sha256: string;
  bytes_path: string; parsed_at: string | null; first_seen_at: string;
}
interface OldLineRow {
  print_id: number; metric_id: string; contract_json: string; expected_json: string | null; state: string;
  value: number | null; value_high: number | null; snippet: string | null; source_doc_id: number | null;
  candidates_json: string; updated_at: string;
}

function countCandidates(db: Database.Database, table: string): number {
  let n = 0;
  for (const row of db.prepare(`SELECT candidates_json FROM ${table}`).all() as { candidates_json: string }[]) {
    try {
      const parsed: unknown = JSON.parse(row.candidates_json);
      if (Array.isArray(parsed)) n += parsed.length;
    } catch {
      // unreadable JSON contributes nothing, before and after alike
    }
  }
  return n;
}

export function rebuildDocumentIdentity(db: Database.Database, hooks: RebuildHooks = {}): RebuildReport {
  const log = hooks.log ?? ((line: string) => console.log(`[089] ${line}`));
  const after = (phase: number) => hooks.afterPhase?.(phase);
  const existsSync = hooks.existsSync ?? fs.existsSync;
  const report: RebuildReport = {
    documents: { before: 0, after: 0, merged: 0 },
    roads: 0,
    candidates: { before: 0, kept: 0, archived: 0 },
    linesRechecked: 0,
    linesChanged: [],
    missingBytes: [],
    urlsSanitised: 0,
    unparseableLines: 0,
  };

  // (0) sidecar tables that reference nothing being rebuilt
  db.exec(`
    CREATE TABLE print_watch_candidate_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      print_id INTEGER NOT NULL,
      metric_id TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE print_watch_sources (
      symbol TEXT PRIMARY KEY,
      ir_page_url TEXT NOT NULL,
      link_must_contain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE print_watch_ir_seen (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      link TEXT NOT NULL,
      seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      baseline INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, link)
    );
    CREATE TABLE print_watch_ir_baseline (
      event_id INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
      source_fingerprint TEXT NOT NULL,
      link_count INTEGER NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  report.candidates.before = countCandidates(db, "print_watch_lines");
  const oldDocs = db.prepare(`SELECT * FROM print_watch_documents ORDER BY id`).all() as OldDocRow[];
  report.documents.before = oldDocs.length;

  // (1) the new parent
  db.exec(`
    CREATE TABLE print_watch_documents_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
      kind TEXT NOT NULL CHECK (kind IN ${KINDS}),
      source TEXT NOT NULL,
      url TEXT,
      sha256 TEXT NOT NULL,
      bytes_path TEXT NOT NULL,
      parsed_at TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      gate_verdict TEXT NOT NULL DEFAULT 'rejected' CHECK (gate_verdict IN ('accepted','rejected')),
      gate_reason TEXT,
      gate_version INTEGER NOT NULL DEFAULT 0,
      gate_fingerprint TEXT,
      parse_state TEXT NOT NULL DEFAULT 'queued' CHECK (parse_state IN ('queued','claimed','parsed','failed')),
      parse_claim_token TEXT,
      parse_claimed_at TEXT,
      parse_attempts INTEGER NOT NULL DEFAULT 0,
      parse_last_error TEXT,
      text_sha256 TEXT,
      UNIQUE(print_id, sha256)
    );
  `);
  after(1);

  // (2) copy, deduping same-hash rows per print into the lowest id; keep an old→survivor map
  const remap = new Map<number, number>();
  /** Survivors whose bytes are gone: rejected durably in (10a), candidates archived in (5) (M7). */
  const missingDocIds = new Set<number>();
  const groups = new Map<string, OldDocRow[]>();
  for (const d of oldDocs) {
    const key = `${d.print_id}|${d.sha256}`;
    const g = groups.get(key);
    if (g) g.push(d);
    else groups.set(key, [d]);
  }
  const insertDoc = db.prepare(`
    INSERT INTO print_watch_documents_new
      (id, print_id, kind, source, url, sha256, bytes_path, parsed_at, first_seen_at, last_seen_at,
       gate_verdict, gate_reason, gate_version, gate_fingerprint, parse_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`);
  for (const members of groups.values()) {
    const survivor = members[0]; // ORDER BY id → lowest id first
    const rejectedReasons = members
      .filter((m) => m.source.startsWith(REJECTED_PREFIX))
      .map((m) => m.source.slice(REJECTED_PREFIX.length));
    const anyAccepted = rejectedReasons.length < members.length;
    const parsedAt = members.map((m) => m.parsed_at).find((p) => p !== null) ?? null;
    const survivorRejected = survivor.source.startsWith(REJECTED_PREFIX);
    insertDoc.run(
      survivor.id, survivor.print_id, survivor.kind,
      survivorRejected ? "legacy-rejected" : survivor.source,
      survivor.url, survivor.sha256, survivor.bytes_path, parsedAt, survivor.first_seen_at,
      members.map((m) => m.first_seen_at).sort().at(-1) ?? survivor.first_seen_at,
      anyAccepted ? "accepted" : "rejected",
      anyAccepted ? null : rejectedReasons[0] ?? null,
      parsedAt ? "parsed" : "queued",
    );
    for (const m of members) remap.set(m.id, survivor.id);
    if (members.length > 1) report.documents.merged += members.length - 1;
    if (!existsSync(survivor.bytes_path)) {
      report.missingBytes.push(survivor.bytes_path);
      missingDocIds.add(survivor.id);
      log(`WARNING document ${survivor.id} bytes missing on disk: ${survivor.bytes_path} — rejected, evidence archived`);
    }
  }
  report.documents.after = groups.size;
  after(2);

  // (3) roads — one per old row, on the survivor (FK text says _new; the rename in (8) rewrites it)
  db.exec(`
    CREATE TABLE print_watch_document_roads (
      document_id INTEGER NOT NULL REFERENCES print_watch_documents_new(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ${KINDS}),
      source TEXT NOT NULL,
      url TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      seen_count INTEGER NOT NULL DEFAULT 1,
      road_verdict TEXT NOT NULL CHECK (road_verdict IN ('accepted','rejected')),
      road_reason TEXT,
      PRIMARY KEY (document_id, kind, source)
    );
  `);
  const insertRoad = db.prepare(`
    INSERT OR IGNORE INTO print_watch_document_roads
      (document_id, kind, source, url, first_seen_at, last_seen_at, seen_count, road_verdict, road_reason)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  for (const d of oldDocs) {
    const rejected = d.source.startsWith(REJECTED_PREFIX);
    const r = insertRoad.run(
      remap.get(d.id)!, d.kind, rejected ? "legacy-rejected" : d.source, d.url, d.first_seen_at, d.first_seen_at,
      rejected ? "rejected" : "accepted", rejected ? d.source.slice(REJECTED_PREFIX.length) : null,
    );
    report.roads += r.changes;
  }
  after(3);

  // (4) the new lines table
  db.exec(`
    CREATE TABLE print_watch_lines_new (
      print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
      metric_id TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      expected_json TEXT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','flash','single_source','agreed','conflict','blank','accepted','retired')),
      value REAL, value_high REAL, snippet TEXT,
      source_doc_id INTEGER REFERENCES print_watch_documents_new(id),
      candidates_json TEXT NOT NULL DEFAULT '[]',
      audit_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (print_id, metric_id)
    );
  `);
  after(4);

  // (5) copy lines, remapping source_doc_id and candidates; archive duplicates' candidates
  const oldLines = db.prepare(`SELECT * FROM print_watch_lines ORDER BY print_id, metric_id`).all() as OldLineRow[];
  const insertLine = db.prepare(`
    INSERT INTO print_watch_lines_new
      (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, audit_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
  const archive = db.prepare(`
    INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, ?, ?, ?)`);
  const affected: Array<{ printId: number; metricId: string }> = [];
  for (const line of oldLines) {
    const sourceDocId =
      line.source_doc_id !== null && remap.has(line.source_doc_id) ? remap.get(line.source_doc_id)! : line.source_doc_id;
    let parsed: unknown;
    let malformed = false;
    try {
      parsed = JSON.parse(line.candidates_json);
    } catch {
      malformed = true;
    }
    if (malformed || !Array.isArray(parsed)) {
      // M7: an unreadable value is NEVER rewritten as [] — copy it verbatim and
      // archive the raw text durably, so a human can recover it later.
      archive.run(line.print_id, line.metric_id, line.candidates_json, "unparseable-json");
      report.unparseableLines += 1;
      insertLine.run(
        line.print_id, line.metric_id, line.contract_json, line.expected_json, line.state, line.value, line.value_high,
        line.snippet, sourceDocId, line.candidates_json, line.updated_at,
      );
      log(`line print=${line.print_id} metric=${line.metric_id}: candidates_json unparseable — copied verbatim, raw value archived`);
      continue;
    }
    const kept: TaggedCandidate[] = [];
    let touched = false;
    for (const c of parsed as TaggedCandidate[]) {
      if (c.doc_id === FLASH_DOC_ID || !remap.has(c.doc_id)) {
        kept.push(c);
        continue;
      }
      const survivor = remap.get(c.doc_id)!;
      if (missingDocIds.has(survivor)) {
        // Evidence that can no longer be re-read is retracted, not kept (M7/M16).
        archive.run(line.print_id, line.metric_id, JSON.stringify(c), "bytes-missing");
        report.candidates.archived += 1;
        touched = true;
        continue;
      }
      if (survivor === c.doc_id) {
        kept.push(c);
        continue;
      }
      archive.run(line.print_id, line.metric_id, JSON.stringify(c), `duplicate-of:${survivor}`);
      report.candidates.archived += 1;
      touched = true;
    }
    report.candidates.kept += kept.length;
    if (sourceDocId !== line.source_doc_id) touched = true;
    insertLine.run(
      line.print_id, line.metric_id, line.contract_json, line.expected_json, line.state, line.value, line.value_high,
      line.snippet, sourceDocId, JSON.stringify(kept), line.updated_at,
    );
    if (touched) affected.push({ printId: line.print_id, metricId: line.metric_id });
  }
  after(5);

  // (6)–(8) swap
  db.exec(`DROP TABLE print_watch_lines`);
  after(6);
  db.exec(`DROP TABLE print_watch_documents`);
  after(7);
  db.exec(`ALTER TABLE print_watch_documents_new RENAME TO print_watch_documents`);
  db.exec(`ALTER TABLE print_watch_lines_new RENAME TO print_watch_lines`);
  after(8);

  // (9) indexes
  db.exec(`
    CREATE INDEX idx_pw_documents_print ON print_watch_documents(print_id);
    CREATE INDEX idx_pw_documents_parse ON print_watch_documents(print_id, parse_state);
    CREATE INDEX idx_pw_documents_text ON print_watch_documents(print_id, text_sha256);
  `);
  after(9);

  // (10a) documents with no bytes on disk are rejected durably (M7): their
  // candidates were archived in (5); the row stays as the record of what was lost.
  const rejectMissing = db.prepare(
    `UPDATE print_watch_documents SET gate_verdict = 'rejected', gate_reason = 'bytes missing on disk', gate_fingerprint = NULL WHERE id = ?`,
  );
  for (const id of missingDocIds) rejectMissing.run(id);

  // (10) referential integrity must be clean before any line is re-read
  const fkProblems = db.prepare(`PRAGMA foreign_key_check`).all();
  if (fkProblems.length > 0) {
    throw new Error(`089: foreign_key_check reported ${fkProblems.length} problem(s): ${JSON.stringify(fkProblems.slice(0, 5))}`);
  }
  after(10);

  // (11) re-run the reconciler over every affected, non-accepted line
  const readLine = db.prepare(`SELECT * FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`);
  const writeLine = db.prepare(`
    UPDATE print_watch_lines SET state = ?, value = ?, value_high = ?, snippet = ?, source_doc_id = ?, updated_at = datetime('now')
     WHERE print_id = ? AND metric_id = ?`);
  for (const { printId, metricId } of affected) {
    const row = readLine.get(printId, metricId) as OldLineRow & { audit_json: string | null };
    report.linesRechecked += 1;
    if (row.state === "accepted") continue; // rule 6: an acceptance is never recomputed here
    const contract = JSON.parse(row.contract_json) as LineContract;
    const expected: Record<string, ExpectedValue> = {};
    if (row.expected_json) expected[metricId] = JSON.parse(row.expected_json) as ExpectedValue;
    const candidates = JSON.parse(row.candidates_json) as TaggedCandidate[];
    const [next] = reconcile([contract], expected, candidates, []) as PrintWatchLine[];
    const nextSource = next.source_doc_id === FLASH_DOC_ID ? null : next.source_doc_id;
    if (next.state !== row.state || next.value !== row.value || nextSource !== row.source_doc_id) {
      writeLine.run(next.state, next.value, next.value_high, next.snippet, nextSource, printId, metricId);
      report.linesChanged.push({ printId, metricId, from: row.state, to: next.state });
      log(`line print=${printId} metric=${metricId}: ${row.state} → ${next.state}`);
    }
  }
  after(11);

  // legacy URL sanitisation (spec §4.2 "URL": B's migration sanitises stored URLs)
  for (const table of ["print_watch_documents", "print_watch_document_roads"]) {
    const rows = db.prepare(`SELECT rowid AS rid, url FROM ${table} WHERE url IS NOT NULL`).all() as { rid: number; url: string }[];
    const update = db.prepare(`UPDATE ${table} SET url = ? WHERE rowid = ?`);
    for (const r of rows) {
      const clean = redactUrl(r.url);
      if (clean !== r.url) {
        update.run(clean, r.rid);
        report.urlsSanitised += 1;
      }
    }
  }

  // invariant AFTER
  const afterCount = countCandidates(db, "print_watch_lines") + report.candidates.archived;
  if (afterCount !== report.candidates.before) {
    throw new Error(`089: candidate invariant broken — before=${report.candidates.before} kept+archived=${afterCount}`);
  }
  log(
    `documents ${report.documents.before}→${report.documents.after} (merged ${report.documents.merged}), roads ${report.roads}, ` +
      `candidates kept ${report.candidates.kept} archived ${report.candidates.archived}, lines rechecked ${report.linesRechecked} changed ${report.linesChanged.length}, ` +
      `urls sanitised ${report.urlsSanitised}, missing bytes ${report.missingBytes.length}`,
  );
  return report;
}

export function up(db: Database.Database): void {
  rebuildDocumentIdentity(db, {});
}
```

Register it in `lib/db/code-migrations.ts`:

```ts
import { up as up089 } from "./migrations/089_print_watch_document_identity";

export const CODE_MIGRATIONS: Record<string, CodeMigration> = {
  "089_print_watch_document_identity.ts": up089,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/`
Expected: PASS. Two gotchas if a phase test fails: (a) `ALTER TABLE … RENAME` rewrites the FK text in `print_watch_document_roads` and `print_watch_lines_new` only with `PRAGMA legacy_alter_table = OFF` (the default — do not set it); (b) `PRAGMA foreign_keys` cannot change inside a transaction, so the rebuild never touches it — the test DB has it ON, matching production (`lib/db.ts`).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b6.txt <<'EOF'
feat(db): migration 089 — print-watch document identity rebuild (.ts)

Content identity (print_id, sha256), roads as provenance, lines gain
`retired` + audit_json, candidate archive keyed (print_id, metric_id),
sources + ir_seen tables. Eleven rollback-tested phases; duplicates'
candidates archived (never dropped) and affected lines re-reconciled;
foreign_key_check gate; legacy URLs redacted. Missing bytes are reported,
not thrown (plan M7).
EOF
git commit lib/db/migrations/089_print_watch_document_identity.ts lib/db/code-migrations.ts tests/db/migration-089-document-identity.test.ts -F /tmp/msg-b6.txt
```

---

### Task 7: The explicit 089 runner — `--rehearse` on a VACUUM copy, `--live` with the cutover gates

**Files:**
- Create: `scripts/migrate-089-document-identity.ts`

**Interfaces:**
- Consumes: `rebuildDocumentIdentity` (Task 6), `runMigrations` (Task 1), `resolveDbPath` (`lib/db/db-path.ts`).
- Produces: the cutover runbook's tool (Task 15, M18). No library surface. Precedent: `scripts/recompute-tax-lots-v2.ts` (`--apply` rehearsal under `REPAIR_DB_PATH`, `--live` for the real run).

- [ ] **Step 1: Write the script**

```ts
/**
 * migrate-089-document-identity.ts — run the 089 document-identity rebuild
 * EXPLICITLY, with the invariant gates the migration itself only reports
 * (plan M7/M18): every surviving document's bytes exist on disk, kept +
 * archived candidates equal the original count, and foreign_key_check is
 * clean. A failed gate ROLLS BACK (the rebuild and the gates share one
 * transaction) and exits 2. Missing bytes can be accepted explicitly with
 * --allow-missing-bytes (the migration has already rejected those documents
 * durably and archived their evidence; the flag is recorded in the report).
 *
 * Two modes, run FROM THE REPO ROOT (tsx `@/` alias trap):
 *
 *   --rehearse   REPAIR_DB_PATH must point at a VACUUM copy; refuses the live
 *                database by real path AND (dev, ino) — a symlink or hardlink
 *                to the live file is still the live file.
 *   --live       operates on the live database (resolveDbPath()). Refuses unless
 *                no other process holds the file (lsof) and a backup made in the
 *                last 10 minutes exists at data/backups/pre-089-*.db. Records 089
 *                in schema_migrations, so the app skips it at the next start.
 *
 *   sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/rehearse-089.db'"
 *   REPAIR_DB_PATH=data/backups/rehearse-089.db \
 *     PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse
 *
 * Exit 0 = clean; exit 1 = refused; exit 2 = an invariant failed (rolled back).
 */
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { resolveDbPath } from "../lib/db/db-path";
import { runMigrations } from "../lib/db/migrate";
import { rebuildDocumentIdentity } from "../lib/db/migrations/089_print_watch_document_identity";

const NAME = "089_print_watch_document_identity.ts";
const BACKUP_MAX_AGE_MS = 10 * 60_000;

/** Real-path AND (dev, ino) identity — a symlink or hardlink to the live file is the live file. */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(fs.realpathSync(a));
    const sb = fs.statSync(fs.realpathSync(b));
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function otherHolders(file: string): string[] {
  try {
    return execFileSync("lsof", ["-t", file], { encoding: "utf8" })
      .split("\n")
      .filter((p) => p && Number(p) !== process.pid);
  } catch {
    return []; // lsof exits 1 when nobody holds the file
  }
}

function freshBackupExists(): boolean {
  const dir = path.join(process.cwd(), "data", "backups");
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir)
    .some((f) => f.startsWith("pre-089-") && f.endsWith(".db") && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < BACKUP_MAX_AGE_MS);
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--live") ? "live" : argv.includes("--rehearse") ? "rehearse" : null;
  const allowMissing = argv.includes("--allow-missing-bytes");
  if (!mode) {
    console.error("usage: migrate-089-document-identity.ts --rehearse (REPAIR_DB_PATH=<copy>) | --live [--allow-missing-bytes]");
    process.exit(1);
  }
  const live = resolveDbPath({ ...process.env, REPAIR_DB_PATH: undefined });
  let target: string;
  if (mode === "rehearse") {
    target = process.env.REPAIR_DB_PATH ?? "";
    if (!target) {
      console.error("--rehearse: REPAIR_DB_PATH is required (a VACUUM copy, never the live DB)");
      process.exit(1);
    }
    if (!fs.existsSync(target)) {
      console.error(`--rehearse: no such file ${target}`);
      process.exit(1);
    }
    if (sameFile(target, live)) {
      console.error(`--rehearse: REPAIR_DB_PATH is the LIVE database (${live}); refusing`);
      process.exit(1);
    }
  } else {
    target = live;
    const holders = otherHolders(target);
    if (holders.length > 0) {
      console.error(`--live: ${holders.length} other process(es) hold ${target} (pids ${holders.join(", ")}); quit them first`);
      process.exit(1);
    }
    if (!freshBackupExists()) {
      console.error("--live: no data/backups/pre-089-*.db newer than 10 minutes; take one first (VACUUM INTO, then PRAGMA integrity_check)");
      process.exit(1);
    }
  }

  const db = new Database(target);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (db.prepare(`SELECT 1 FROM schema_migrations WHERE filename = ?`).get(NAME)) {
    console.error(`${NAME} is already applied on ${target}`);
    process.exit(1);
  }
  // Every migration BEFORE 089 (A's 088 included when present); the registry is
  // passed empty so no later code migration can ride along.
  runMigrations(db, { codeMigrations: {} });

  const lines: string[] = [];
  let report;
  try {
    report = db.transaction(() => {
      const r = rebuildDocumentIdentity(db, { log: (l) => lines.push(l) });
      const problems: string[] = [];
      if (r.missingBytes.length > 0 && !allowMissing) {
        problems.push(`${r.missingBytes.length} surviving document(s) have no bytes on disk (re-run with --allow-missing-bytes to accept the durable rejection)`);
      }
      if (r.candidates.kept + r.candidates.archived !== r.candidates.before) problems.push("kept + archived != original candidates");
      const fk = db.prepare(`PRAGMA foreign_key_check`).all();
      if (fk.length > 0) problems.push(`foreign_key_check reported ${fk.length} row(s)`);
      if (problems.length > 0) throw new Error(`INVARIANT FAILED: ${problems.join("; ")}`);
      db.prepare(`INSERT INTO schema_migrations (filename) VALUES (?)`).run(NAME);
      return r;
    })();
  } catch (err) {
    console.log(JSON.stringify({ mode, target, allowMissing, rolledBack: true }, null, 2));
    for (const l of lines) console.log(`  ${l}`);
    console.error(err instanceof Error ? err.message : String(err));
    db.close();
    process.exit(2);
  }
  console.log(JSON.stringify({ mode, target, allowMissing, ...report }, null, 2));
  for (const l of lines) console.log(`  ${l}`);
  db.close();
  process.exit(0);
}

main();
```

- [ ] **Step 2: Verify the refusals and a dry run on a throwaway copy**

Run (from the repo root, with the packaged app NOT holding a write lock — reads are fine under WAL):

```bash
N=/opt/homebrew/opt/node@24/bin
PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts; echo "exit=$?"
# Expected: usage line, exit=1
PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse; echo "exit=$?"
# Expected: "REPAIR_DB_PATH is required", exit=1
REPAIR_DB_PATH=data/vanguard.db PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse; echo "exit=$?"
# Expected: "is the LIVE database", exit=1
ln -s "$PWD/data/vanguard.db" /tmp/live-link.db; REPAIR_DB_PATH=/tmp/live-link.db PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse; echo "exit=$?"; rm /tmp/live-link.db
# Expected: "is the LIVE database" (symlink caught by (dev, ino)), exit=1
PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts --live; echo "exit=$?"
# Expected while the app is running: "other process(es) hold", exit=1 — never quit the app for this check
mkdir -p data/backups && sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/rehearse-089.db'"
REPAIR_DB_PATH=data/backups/rehearse-089.db PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse; echo "exit=$?"
# Expected: the JSON report + per-line reconcile changes, exit=0 (exit=2 names the failed invariant and the copy is unchanged)
```

Read the `linesChanged` list against the live SNOW/CRWD/NVDA sheets before Task 15's live run: every `agreed → single_source` must be a duplicate-only agreement (same bytes via two roads). Record the report (numbers are not private — counts of documents and lines) in the PR description.

- [ ] **Step 3: Commit**

```bash
cat > /tmp/msg-b7.txt <<'EOF'
chore(scripts): migrate-089-document-identity — --rehearse on a VACUUM copy, --live with cutover gates

One transaction for the rebuild and its gates (bytes-on-disk unless
explicitly allowed, candidate conservation, foreign_key_check); a failed
gate rolls back. --rehearse refuses the live DB by real path and (dev,
ino); --live refuses while any other process holds the file or without a
fresh pre-089 backup (plan M7/M18).
EOF
git commit scripts/migrate-089-document-identity.ts -F /tmp/msg-b7.txt
```

---

### Task 8: Store v2 — row types, `recordDelivery`, parse-claim CAS, roads, sources, IR-seen

**Files:**
- Modify: `lib/print-watch/types.ts`
- Modify: `lib/print-watch/store.ts` (remove `insertDocument`, `markDocumentParsed`, `listUnparsedDocuments`; add the functions below; `upsertLines` preserves `audit_json`; `getSheet` returns it)
- Create: `lib/print-watch/delivery.ts`
- Test: `tests/print-watch/delivery.test.ts`; update `tests/print-watch/store.test.ts` (replace the three `insertDocument` tests at lines ~131–160 with the store tests below); update the `insertDocument` call sites in `tests/api/print-watch-routes.test.ts:173-190` and `tests/print-watch/replay.test.ts:583` to `recordDelivery` (Task 9 finishes the watcher side; these two files must compile at the end of THIS task, so convert them here with the `seedDelivery` helper below)

**Interfaces:**
- Consumes: `contentVerdict`, `roadVerdict`, `gateFingerprint`, `GATE_VERSION`, `DocGateContext`, `DocGateVerdict` (Task 5).
- Produces:

```ts
// lib/print-watch/types.ts (changed/added)
export type PrintWatchDocKind = "dj-release" | "edgar-ex99" | "ir-page" | "user-drop" | "user-url";
export type LineStateKind = "pending" | "flash" | "single_source" | "agreed" | "conflict" | "blank" | "accepted" | "retired";
export type CandidateRepresentation = "repA" | "repB" | "flash" | "pdfText" | "pdfNative";
export interface TaggedCandidate extends ParseCandidate {
  doc_id: number;
  representation: CandidateRepresentation;
  weak_pair: boolean;
  /** Present on both readings of a PDF until the pre-registered holdout passes (spec §4.2 "PDF"). */
  pair_note?: "pdf-weak";
}
export interface PrintWatchLine { /* unchanged fields */ audit_json?: string | null }
export type GateVerdictKind = "accepted" | "rejected";
export type ParseState = "queued" | "claimed" | "parsed" | "failed";
export interface DocumentRow {
  id: number; print_id: number; kind: PrintWatchDocKind; source: string; url: string | null; sha256: string;
  bytes_path: string; parsed_at: string | null; first_seen_at: string; last_seen_at: string;
  gate_verdict: GateVerdictKind; gate_reason: string | null; gate_version: number; gate_fingerprint: string | null;
  parse_state: ParseState; parse_claim_token: string | null; parse_claimed_at: string | null;
  parse_attempts: number; parse_last_error: string | null; text_sha256: string | null;
}
export interface IrBaselineRow { event_id: number; source_fingerprint: string; link_count: number; completed_at: string }
export interface DocumentRoadRow {
  document_id: number; kind: PrintWatchDocKind; source: string; url: string | null;
  first_seen_at: string; last_seen_at: string; seen_count: number; road_verdict: GateVerdictKind; road_reason: string | null;
}
export interface PrintWatchSourceRow { symbol: string; ir_page_url: string; link_must_contain: string | null; created_at: string; updated_at: string }

// lib/print-watch/store.ts (added)
export const PARSE_CLAIM_STALE_MS = 5 * 60_000;
export function listParseQueue(db: Database.Database, printId: number): DocumentRow[];       // eligible + queued, ORDER BY id
export function hasParsableDocuments(db: Database.Database, printId: number): boolean;      // any eligible doc not yet parsed/failed
export function claimDocumentParse(db: Database.Database, docId: number, token: string, nowMs: number): boolean;   // increments parse_attempts (M15)
export function finalizeDocumentParse(db: Database.Database, docId: number, token: string, state: "parsed" | "queued" | "failed", error?: string | null): boolean;
export function getDocument(db: Database.Database, docId: number): DocumentRow | null;
export function listDocumentRoads(db: Database.Database, printId: number): DocumentRoadRow[];
export function anyRoadAccepted(db: Database.Database, docId: number): boolean;
export function upsertPrintWatchSource(db: Database.Database, input: { symbol: string; irPageUrl: string; linkMustContain: string | null }): PrintWatchSourceRow;
export function getPrintWatchSource(db: Database.Database, symbol: string): PrintWatchSourceRow | null;
export function deletePrintWatchSource(db: Database.Database, symbol: string): boolean;
export function listIrSeenLinks(db: Database.Database, eventId: number): Array<{ link: string; baseline: boolean }>;
export function recordIrSeenLinks(db: Database.Database, eventId: number, links: string[], baseline: boolean): number;
/** ONE transaction: the baseline's links plus the completion marker keyed by the IR URL's fingerprint (M5). */
export function recordIrBaseline(db: Database.Database, eventId: number, sourceFingerprint: string, links: string[]): number;
export function getIrBaseline(db: Database.Database, eventId: number): IrBaselineRow | null;
/** True only when a COMPLETED baseline exists for THIS fingerprint — a changed IR URL is a new baseline. */
export function hasIrBaseline(db: Database.Database, eventId: number, sourceFingerprint: string): boolean;

// lib/print-watch/delivery.ts
export interface DeliveryInput { bytesPath: string; text: string; gateCtx: DocGateContext }   // text = what the gate reads (utf8, or the poppler text for a PDF)
export interface DeliveryResult {
  id: number; isNew: boolean; needsParse: boolean; eligible: boolean;
  contentVerdict: DocGateVerdict; roadVerdict: DocGateVerdict; parseState: ParseState;
  /** "bytes" = same sha256 existed; "text" = only the normalised text matched (M13); "new" otherwise. */
  matchedBy: "new" | "bytes" | "text";
}
export function sha256Hex(buf: Buffer | string): string;
/** sha256 of the text with whitespace collapsed, trimmed, lower-cased — the M13 identity. */
export function textIdentityHash(text: string): string;
/** Archive every candidate from `docId` (reason recorded) and re-reconcile affected non-accepted lines (M16). */
export function retractDocumentEvidence(db: Database.Database, docId: number, reason: string): { archived: number; linesChanged: number };
export function recordDelivery(db: Database.Database, printId: number, kind: PrintWatchDocKind, source: string, url: string | null, bytes: Buffer, input: DeliveryInput): DeliveryResult;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/delivery.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { recordDelivery, sha256Hex, textIdentityHash } from "@/lib/print-watch/delivery";
import { upsertPrint, upsertLines, getSheet, listDocuments, listDocumentRoads, listParseQueue, claimDocumentParse, finalizeDocumentParse, getDocument } from "@/lib/print-watch/store";
import { GATE_VERSION, gateFingerprint } from "@/lib/print-watch/gate";
import type { LineContract } from "@/lib/print-watch/types";

function contractFor(metric: string): LineContract {
  return { metric_id: metric, label: metric, definition: "t", basis: "gaap", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null };
}

const CTX = { symbol: "ACME", issuerName: "Acme Corp", eventDate: "2026-08-26" };
const THIS_Q = "ACME reports Q2 2026 results. Revenue $1.0 billion.";
const LAST_Q = "ACME reports first quarter fiscal 2027 results. Revenue $0.9 billion.";
const OTHER = "Globex reports Q2 2026 results.";

let db: Database.Database;
let printId: number;

function seedEvent(db: Database.Database): number {
  return Number(
    db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-26','ACME','k','ACME')`).run().lastInsertRowid,
  );
}

function deliver(kind: "dj-release" | "edgar-ex99" | "ir-page" | "user-drop" | "user-url", text: string, source = `${kind}:x`) {
  const bytes = Buffer.from(text, "utf8");
  return recordDelivery(db, printId, kind, source, null, bytes, { bytesPath: `/tmp/${sha256Hex(bytes)}.txt`, text, gateCtx: CTX });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  printId = upsertPrint(db, seedEvent(db), "ACME", "2026-08-26", "16:05");
});

describe("recordDelivery", () => {
  it("stores a new accepted document, one road, gate metadata, and asks for a parse", () => {
    const r = deliver("edgar-ex99", THIS_Q);
    expect(r).toMatchObject({ isNew: true, needsParse: true, eligible: true, parseState: "queued" });
    const [doc] = listDocuments(db, printId);
    expect(doc).toMatchObject({ id: r.id, kind: "edgar-ex99", gate_verdict: "accepted", gate_reason: null, gate_version: GATE_VERSION, gate_fingerprint: gateFingerprint(CTX), sha256: sha256Hex(Buffer.from(THIS_Q)) });
    expect(listDocumentRoads(db, printId)).toEqual([expect.objectContaining({ document_id: r.id, kind: "edgar-ex99", source: "edgar-ex99:x", seen_count: 1, road_verdict: "accepted" })]);
  });

  it("identical bytes through two roads yield ONE document with two roads and no second parse request", () => {
    const first = deliver("edgar-ex99", THIS_Q);
    const second = deliver("user-drop", THIS_Q, "user-drop:release.txt");
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ isNew: false, needsParse: false, eligible: true });
    expect(listDocuments(db, printId)).toHaveLength(1);
    expect(listDocumentRoads(db, printId).map((r) => r.kind).sort()).toEqual(["edgar-ex99", "user-drop"]);
    const third = deliver("user-drop", THIS_Q, "user-drop:release.txt");
    expect(third.needsParse).toBe(false);
    expect(listDocumentRoads(db, printId).find((r) => r.kind === "user-drop")?.seen_count).toBe(2);
  });

  it("content-plus-road eligibility: a stricter road first never blocks a later accepting road, and IR-only stays rejected", () => {
    const ir = deliver("ir-page", LAST_Q);
    expect(ir.contentVerdict.ok).toBe(true);   // loose branch accepts the fiscal labels
    expect(ir.roadVerdict.ok).toBe(false);     // strict ir-page period check refuses them
    expect(ir).toMatchObject({ eligible: false, needsParse: false });
    expect(listParseQueue(db, printId)).toEqual([]);

    const drop = deliver("user-drop", LAST_Q);
    expect(drop.id).toBe(ir.id);
    expect(drop).toMatchObject({ isNew: false, eligible: true, needsParse: true });
    expect(listParseQueue(db, printId).map((d) => d.id)).toEqual([ir.id]);
    const roads = listDocumentRoads(db, printId);
    expect(roads.find((r) => r.kind === "ir-page")?.road_verdict).toBe("rejected");
    expect(roads.find((r) => r.kind === "user-drop")?.road_verdict).toBe("accepted");
  });

  it("a content rejection is stored with its reason and is never eligible whatever the road", () => {
    const r = deliver("user-drop", OTHER);
    expect(r).toMatchObject({ eligible: false, needsParse: false });
    expect(r.contentVerdict).toEqual({ ok: false, reason: expect.stringMatching(/issuer not named/) });
    expect(getDocument(db, r.id)).toMatchObject({ gate_verdict: "rejected", gate_reason: expect.stringMatching(/issuer/) });
  });

  it("re-evaluates the content gate when the fingerprint changes (issuer name learned later)", () => {
    const bytes = Buffer.from("Acme Corp reports Q2 2026 results.");
    const text = bytes.toString();
    const before = recordDelivery(db, printId, "user-drop", "u", null, bytes, { bytesPath: "/tmp/a", text, gateCtx: { symbol: "ZZZ", issuerName: null, eventDate: "2026-08-26" } });
    expect(before.eligible).toBe(false);
    const after = recordDelivery(db, printId, "user-drop", "u", null, bytes, { bytesPath: "/tmp/a", text, gateCtx: { symbol: "ZZZ", issuerName: "Acme Corp", eventDate: "2026-08-26" } });
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ eligible: true, needsParse: true });
    expect(getDocument(db, after.id)?.gate_fingerprint).toBe(gateFingerprint({ symbol: "ZZZ", issuerName: "Acme Corp", eventDate: "2026-08-26" }));
  });

  it("is atomic: a road insert failure rolls back the document insert", () => {
    const bytes = Buffer.from(THIS_Q);
    expect(() =>
      recordDelivery(db, printId, "not-a-kind" as never, "x", null, bytes, { bytesPath: "/tmp/x", text: THIS_Q, gateCtx: CTX }),
    ).toThrow();
    expect(listDocuments(db, printId)).toEqual([]);
    expect(listDocumentRoads(db, printId)).toEqual([]);
  });

  it("treats different bytes with the same normalised text as the SAME document (M13: resaved PDF / text wrapper)", () => {
    const a = recordDelivery(db, printId, "edgar-ex99", "e", null, Buffer.from(`<html><body>${THIS_Q}</body></html>`), { bytesPath: "/tmp/a", text: THIS_Q, gateCtx: CTX });
    const b = recordDelivery(db, printId, "user-drop", "u", null, Buffer.from(`  ${THIS_Q.toUpperCase()}\n\n`), { bytesPath: "/tmp/b", text: `  ${THIS_Q.toUpperCase()}\n\n`, gateCtx: CTX });
    expect(b).toMatchObject({ id: a.id, isNew: false, matchedBy: "text", needsParse: false });
    expect(listDocuments(db, printId)).toHaveLength(1);
    expect(listDocumentRoads(db, printId).map((r) => r.kind).sort()).toEqual(["edgar-ex99", "user-drop"]);
    expect(getDocument(db, a.id)?.text_sha256).toBe(textIdentityHash(THIS_Q));
  });

  it("retracts evidence when a re-evaluation flips the content verdict to rejected (M16)", () => {
    const bytes = Buffer.from("Acme Corp reports Q2 2026 results. Revenue $1.0 billion.");
    const text = bytes.toString();
    const first = recordDelivery(db, printId, "user-drop", "u", null, bytes, { bytesPath: "/tmp/a", text, gateCtx: { symbol: "ZZZ", issuerName: "Acme Corp", eventDate: "2026-08-26" } });
    expect(first.eligible).toBe(true);
    upsertLines(db, printId, [
      { metric_id: "revenue_q", contract: contractFor("revenue_q"), expected: null, state: "single_source", value: 1e9, value_high: null, snippet: "s", source_doc_id: first.id,
        candidates_json: JSON.stringify([{ metric_id: "revenue_q", value: 1e9, value_high: null, raw_text: "1.0", snippet: "s", location_hint: null, not_disclosed: false, doc_id: first.id, representation: "repB", weak_pair: false }]) },
    ]);
    // The issuer name is corrected: this document no longer names the issuer → rejected.
    const second = recordDelivery(db, printId, "user-drop", "u", null, bytes, { bytesPath: "/tmp/a", text, gateCtx: { symbol: "ZZZ", issuerName: "Globex Inc", eventDate: "2026-08-26" } });
    expect(second).toMatchObject({ id: first.id, eligible: false });
    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    expect(line).toMatchObject({ state: "pending", value: null, source_doc_id: null, candidates_json: "[]" });
    expect(db.prepare("SELECT reason FROM print_watch_candidate_archive").all()).toEqual([{ reason: "gate-rejected" }]);
  });

  it("an explicit user re-delivery re-queues a document that exhausted its attempts (M15); an automated road does not", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    for (let i = 1; i <= 5; i++) {
      claimDocumentParse(db, id, `t${i}`, i * 60_000);
      finalizeDocumentParse(db, id, `t${i}`, i === 5 ? "failed" : "queued", "model 529");
    }
    expect(getDocument(db, id)).toMatchObject({ parse_state: "failed", parse_attempts: 5, parse_last_error: "model 529" });
    expect(deliver("edgar-ex99", THIS_Q)).toMatchObject({ id, needsParse: false, parseState: "failed" });
    const again = deliver("user-drop", THIS_Q, "user-drop:again.txt");
    expect(again).toMatchObject({ id, needsParse: true, parseState: "queued" });
    expect(getDocument(db, id)).toMatchObject({ parse_attempts: 0, parse_last_error: null });
  });
});

describe("recordDelivery across two connections (file-backed)", () => {
  it("two processes delivering the same bytes see one document, two roads, and one parse claim", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pw-2conn-")), "t.db");
    const a = new Database(file);
    a.pragma("journal_mode = WAL");
    a.pragma("foreign_keys = ON");
    runMigrations(a);
    const b = new Database(file);
    b.pragma("foreign_keys = ON");
    const eventId = seedEvent(a);
    const pid = upsertPrint(a, eventId, "ACME", "2026-08-26", "16:05");
    const bytes = Buffer.from(THIS_Q);
    const ra = recordDelivery(a, pid, "edgar-ex99", "e", null, bytes, { bytesPath: "/tmp/x", text: THIS_Q, gateCtx: CTX });
    const rb = recordDelivery(b, pid, "user-drop", "u", null, bytes, { bytesPath: "/tmp/x", text: THIS_Q, gateCtx: CTX });
    expect(rb).toMatchObject({ id: ra.id, isNew: false, matchedBy: "bytes" });
    expect(listDocuments(b, pid)).toHaveLength(1);
    expect(listDocumentRoads(a, pid)).toHaveLength(2);
    expect(claimDocumentParse(a, ra.id, "proc-a", 1_000)).toBe(true);
    expect(claimDocumentParse(b, ra.id, "proc-b", 2_000)).toBe(false);
    expect(finalizeDocumentParse(b, ra.id, "proc-b", "parsed")).toBe(false);
    expect(finalizeDocumentParse(a, ra.id, "proc-a", "parsed")).toBe(true);
    a.close();
    b.close();
  });
});

describe("parse claims (compare-and-set)", () => {
  it("claims a queued document once, refuses a second claim, and takes over a stale claim", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    const t0 = Date.parse("2026-08-26T20:10:00Z");
    expect(claimDocumentParse(db, id, "tok-1", t0)).toBe(true);
    expect(claimDocumentParse(db, id, "tok-2", t0 + 1000)).toBe(false);
    expect(getDocument(db, id)).toMatchObject({ parse_state: "claimed", parse_claim_token: "tok-1" });
    expect(claimDocumentParse(db, id, "tok-3", t0 + 6 * 60_000)).toBe(true); // > PARSE_CLAIM_STALE_MS
    expect(getDocument(db, id)?.parse_claim_token).toBe("tok-3");
  });

  it("finalises only with the live token; a timed-out worker's finalisation is a no-op", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    const t0 = Date.parse("2026-08-26T20:10:00Z");
    claimDocumentParse(db, id, "tok-1", t0);
    claimDocumentParse(db, id, "tok-2", t0 + 6 * 60_000);
    expect(finalizeDocumentParse(db, id, "tok-1", "parsed")).toBe(false);
    expect(getDocument(db, id)?.parse_state).toBe("claimed");
    expect(finalizeDocumentParse(db, id, "tok-2", "parsed")).toBe(true);
    expect(getDocument(db, id)).toMatchObject({ parse_state: "parsed", parse_claim_token: null, parsed_at: expect.any(String) });
    expect(listParseQueue(db, printId)).toEqual([]);
  });

  it("finalising back to queued keeps the document in the queue; failed removes it", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    claimDocumentParse(db, id, "t", 1);
    finalizeDocumentParse(db, id, "t", "queued");
    expect(listParseQueue(db, printId).map((d) => d.id)).toEqual([id]);
    claimDocumentParse(db, id, "t2", 2);
    finalizeDocumentParse(db, id, "t2", "failed");
    expect(listParseQueue(db, printId)).toEqual([]);
  });
});
```

Replacement store tests (in `tests/print-watch/store.test.ts`, replacing the `insertDocument` / `listUnparsedDocuments` / `markDocumentParsed` tests):

```ts
  it("upsertPrintWatchSource / getPrintWatchSource / deletePrintWatchSource round-trip, keyed by upper-cased symbol", () => {
    const row = upsertPrintWatchSource(db, { symbol: "acme", irPageUrl: "https://ir.acme.example/news", linkMustContain: "Results" });
    expect(row).toMatchObject({ symbol: "ACME", ir_page_url: "https://ir.acme.example/news", link_must_contain: "Results" });
    expect(getPrintWatchSource(db, "ACME")?.ir_page_url).toBe("https://ir.acme.example/news");
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: "https://ir.acme.example/press", linkMustContain: null });
    expect(getPrintWatchSource(db, "acme")).toMatchObject({ ir_page_url: "https://ir.acme.example/press", link_must_contain: null });
    expect(deletePrintWatchSource(db, "ACME")).toBe(true);
    expect(getPrintWatchSource(db, "ACME")).toBeNull();
  });

  it("IR baseline is atomic and versioned by the source fingerprint; later links persist per event (M5)", () => {
    const eventId = insertCalendarEvent(db, "k-ir");
    expect(hasIrBaseline(db, eventId, "fp-1")).toBe(false);
    expect(recordIrBaseline(db, eventId, "fp-1", ["https://ir.x/a", "https://ir.x/b"])).toBe(2);
    expect(hasIrBaseline(db, eventId, "fp-1")).toBe(true);
    expect(hasIrBaseline(db, eventId, "fp-2")).toBe(false); // a changed IR URL is a new baseline
    expect(getIrBaseline(db, eventId)).toMatchObject({ source_fingerprint: "fp-1", link_count: 2 });
    expect(recordIrSeenLinks(db, eventId, ["https://ir.x/a", "https://ir.x/c"], false)).toBe(1);
    expect(listIrSeenLinks(db, eventId)).toEqual([
      { link: "https://ir.x/a", baseline: true },
      { link: "https://ir.x/b", baseline: true },
      { link: "https://ir.x/c", baseline: false },
    ]);
    // An empty page is still a completed baseline.
    const empty = insertCalendarEvent(db, "k-ir-empty");
    expect(recordIrBaseline(db, empty, "fp-1", [])).toBe(0);
    expect(hasIrBaseline(db, empty, "fp-1")).toBe(true);
  });

  it("a baseline whose link insert fails leaves NO marker (one transaction)", () => {
    const eventId = insertCalendarEvent(db, "k-ir-atomic");
    expect(() => recordIrBaseline(db, eventId, "fp-1", ["https://ir.x/a", null as unknown as string])).toThrow();
    expect(getIrBaseline(db, eventId)).toBeNull();
    expect(listIrSeenLinks(db, eventId)).toEqual([]);
  });

  it("upsertLines preserves audit_json unless the caller supplies one", () => {
    const eventId = insertCalendarEvent(db, "k-audit");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", "16:05");
    upsertLines(db, printId, [makeLine("m", 1, { audit_json: JSON.stringify({ acceptances: [1] }) })]);
    upsertLines(db, printId, [makeLine("m", 2)]);
    expect(getSheet(db, printId)[0].audit_json).toBe(JSON.stringify({ acceptances: [1] }));
    upsertLines(db, printId, [makeLine("m", 3, { audit_json: null })]);
    expect(getSheet(db, printId)[0].audit_json).toBe(JSON.stringify({ acceptances: [1] })); // null = "not supplied"
  });
```

`seedDelivery` helper for the route and replay tests (add to each file; it replaces their `insertDocument` calls, which seeded accepted documents):

```ts
import { recordDelivery } from "@/lib/print-watch/delivery";
function seedDelivery(db: Database.Database, printId: number, kind: PrintWatchDocKind, source: string, url: string | null, text: string, bytesPath: string) {
  return recordDelivery(db, printId, kind, source, url, Buffer.from(text, "utf8"), {
    bytesPath, text, gateCtx: { symbol: "ACME", issuerName: null, eventDate: "2026-08-26" },
  });
}
```

(In `tests/api/print-watch-routes.test.ts:173-190` the two seeded docs carried different shas; give them different `text` bodies that both name the route test's symbol and a `Q2 2026` token so they are accepted. In `tests/print-watch/replay.test.ts:583` the "restart-after-insert drill" inserted an unparsed document by hand; use `seedDelivery` with the fixture's own text and assert on `listParseQueue` instead of `listUnparsedDocuments` at lines 571/593/598.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/delivery.test.ts tests/print-watch/store.test.ts`
Expected: FAIL — `@/lib/print-watch/delivery` not found; the new store exports missing.

- [ ] **Step 3: Update `types.ts`, the store, and create `delivery.ts`**

`lib/print-watch/types.ts` — apply the type changes listed under Interfaces (widen `PrintWatchDocKind`, `LineStateKind`, add `CandidateRepresentation`, `pair_note`, `audit_json?`, `GateVerdictKind`, `ParseState`, the new `DocumentRow` fields, `DocumentRoadRow`, `PrintWatchSourceRow`).

`lib/print-watch/store.ts` — delete `insertDocument`, `markDocumentParsed`, `listUnparsedDocuments`; change `upsertLines`'s INSERT to include `audit_json` with `@audit_json` and the conflict clause line `audit_json = COALESCE(excluded.audit_json, print_watch_lines.audit_json)` (bind `audit_json: line.audit_json ?? null`); add `audit_json` to `getSheet`'s row type and output; add:

```ts
export const PARSE_CLAIM_STALE_MS = 5 * 60_000;

const ELIGIBLE_SQL = `d.gate_verdict = 'accepted'
       AND EXISTS (SELECT 1 FROM print_watch_document_roads r WHERE r.document_id = d.id AND r.road_verdict = 'accepted')`;

/** Documents this print may parse right now: content accepted, ≥1 road accepted, state queued. */
export function listParseQueue(db: Database.Database, printId: number): DocumentRow[] {
  return db
    .prepare(`SELECT d.* FROM print_watch_documents d WHERE d.print_id = ? AND d.parse_state = 'queued' AND ${ELIGIBLE_SQL} ORDER BY d.id`)
    .all(printId) as DocumentRow[];
}

/** Anything eligible that is not yet parsed or failed (queued OR claimed) — the "still work to do" question. */
export function hasParsableDocuments(db: Database.Database, printId: number): boolean {
  const row = db
    .prepare(`SELECT 1 AS one FROM print_watch_documents d WHERE d.print_id = ? AND d.parse_state IN ('queued','claimed') AND ${ELIGIBLE_SQL} LIMIT 1`)
    .get(printId);
  return row !== undefined;
}

/** The claim IS the attempt (M15): parse_attempts increments here, durably, so a
 *  restart never resets the budget and a second process sees the same count. */
export function claimDocumentParse(db: Database.Database, docId: number, token: string, nowMs: number): boolean {
  const nowIso = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - PARSE_CLAIM_STALE_MS).toISOString();
  const r = db
    .prepare(
      `UPDATE print_watch_documents
          SET parse_state = 'claimed', parse_claim_token = ?, parse_claimed_at = ?,
              parse_attempts = parse_attempts + 1
        WHERE id = ?
          AND (parse_state = 'queued'
               OR (parse_state = 'claimed' AND datetime(parse_claimed_at) < datetime(?)))`,
    )
    .run(token, nowIso, docId, staleBefore);
  return r.changes > 0;
}

export function finalizeDocumentParse(
  db: Database.Database,
  docId: number,
  token: string,
  state: "parsed" | "queued" | "failed",
  error: string | null = null,
): boolean {
  const r = db
    .prepare(
      `UPDATE print_watch_documents
          SET parse_state = ?, parse_claim_token = NULL, parse_claimed_at = NULL,
              parse_last_error = ?,
              parsed_at = CASE WHEN ? = 'parsed' THEN datetime('now') ELSE parsed_at END
        WHERE id = ? AND parse_claim_token = ?`,
    )
    .run(state, state === "parsed" ? null : error, state, docId, token);
  return r.changes > 0;
}

export function getDocument(db: Database.Database, docId: number): DocumentRow | null {
  return (db.prepare(`SELECT * FROM print_watch_documents WHERE id = ?`).get(docId) as DocumentRow | undefined) ?? null;
}

export function listDocumentRoads(db: Database.Database, printId: number): DocumentRoadRow[] {
  return db
    .prepare(
      `SELECT r.* FROM print_watch_document_roads r JOIN print_watch_documents d ON d.id = r.document_id
        WHERE d.print_id = ? ORDER BY r.document_id, r.kind, r.source`,
    )
    .all(printId) as DocumentRoadRow[];
}

export function anyRoadAccepted(db: Database.Database, docId: number): boolean {
  return (
    db.prepare(`SELECT 1 AS one FROM print_watch_document_roads WHERE document_id = ? AND road_verdict = 'accepted' LIMIT 1`).get(docId) !==
    undefined
  );
}

export function upsertPrintWatchSource(
  db: Database.Database,
  input: { symbol: string; irPageUrl: string; linkMustContain: string | null },
): PrintWatchSourceRow {
  const symbol = input.symbol.trim().toUpperCase();
  db.prepare(
    `INSERT INTO print_watch_sources (symbol, ir_page_url, link_must_contain) VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET ir_page_url = excluded.ir_page_url, link_must_contain = excluded.link_must_contain, updated_at = datetime('now')`,
  ).run(symbol, input.irPageUrl, input.linkMustContain);
  return getPrintWatchSource(db, symbol)!;
}

export function getPrintWatchSource(db: Database.Database, symbol: string): PrintWatchSourceRow | null {
  return (
    (db.prepare(`SELECT * FROM print_watch_sources WHERE symbol = ?`).get(symbol.trim().toUpperCase()) as PrintWatchSourceRow | undefined) ?? null
  );
}

export function deletePrintWatchSource(db: Database.Database, symbol: string): boolean {
  return db.prepare(`DELETE FROM print_watch_sources WHERE symbol = ?`).run(symbol.trim().toUpperCase()).changes > 0;
}

export function listIrSeenLinks(db: Database.Database, eventId: number): Array<{ link: string; baseline: boolean }> {
  return (db.prepare(`SELECT link, baseline FROM print_watch_ir_seen WHERE event_id = ? ORDER BY link`).all(eventId) as { link: string; baseline: number }[]).map(
    (r) => ({ link: r.link, baseline: r.baseline === 1 }),
  );
}

export function recordIrSeenLinks(db: Database.Database, eventId: number, links: string[], baseline: boolean): number {
  const stmt = db.prepare(`INSERT OR IGNORE INTO print_watch_ir_seen (event_id, link, baseline) VALUES (?, ?, ?)`);
  let n = 0;
  for (const link of links) n += stmt.run(eventId, link, baseline ? 1 : 0).changes;
  return n;
}

/** ONE transaction for the links AND the completion marker (M5): a crash between
 *  them leaves no marker, so the baseline is re-taken rather than trusted half-done. */
export function recordIrBaseline(db: Database.Database, eventId: number, sourceFingerprint: string, links: string[]): number {
  return db.transaction((): number => {
    const inserted = recordIrSeenLinks(db, eventId, links, true);
    db.prepare(
      `INSERT INTO print_watch_ir_baseline (event_id, source_fingerprint, link_count, completed_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(event_id) DO UPDATE SET source_fingerprint = excluded.source_fingerprint, link_count = excluded.link_count, completed_at = datetime('now')`,
    ).run(eventId, sourceFingerprint, links.length);
    return inserted;
  }).immediate();
}

export function getIrBaseline(db: Database.Database, eventId: number): IrBaselineRow | null {
  return (db.prepare(`SELECT * FROM print_watch_ir_baseline WHERE event_id = ?`).get(eventId) as IrBaselineRow | undefined) ?? null;
}

export function hasIrBaseline(db: Database.Database, eventId: number, sourceFingerprint: string): boolean {
  return (
    db.prepare(`SELECT 1 AS one FROM print_watch_ir_baseline WHERE event_id = ? AND source_fingerprint = ? LIMIT 1`).get(eventId, sourceFingerprint) !==
    undefined
  );
}
```

`lib/print-watch/delivery.ts`:

```ts
// The ONE delivery entry (spec §4.2 "Identity and eligibility"). Every road —
// wire, EDGAR, IR page, drop, pasted URL — records its bytes here, in one
// immediate transaction: upsert the document by content, upsert the road with
// its own verdict, (re-)evaluate the content gate when the identity fingerprint
// changed, and decide whether a parse is now owed. The byte write and any text
// extraction happen BEFORE this call (they are not transactional); the caller
// passes what it wrote (plan M4).
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { GATE_VERSION, gateFingerprint, contentVerdict, roadVerdict, type DocGateContext, type DocGateVerdict } from "./gate";
import { reconcile } from "./reconcile";
import { anyRoadAccepted } from "./store";
import type { ExpectedValue, LineContract, ParseState, PrintWatchDocKind, PrintWatchLine, TaggedCandidate } from "./types";

export interface DeliveryInput {
  bytesPath: string;
  /** The text the gate reads: utf8 for HTML/text, the poppler text for a PDF. */
  text: string;
  gateCtx: DocGateContext;
}

export interface DeliveryResult {
  id: number;
  isNew: boolean;
  needsParse: boolean;
  eligible: boolean;
  contentVerdict: DocGateVerdict;
  roadVerdict: DocGateVerdict;
  parseState: ParseState;
  /** "bytes" = same sha256 existed; "text" = only the normalised text matched (M13); "new" otherwise. */
  matchedBy: "new" | "bytes" | "text";
}

export function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Normalised-text identity (M13): whitespace collapsed, trimmed, lower-cased —
 *  a resaved PDF or a text wrapper of one release is the SAME document. */
export function textIdentityHash(text: string): string {
  return sha256Hex(text.replace(/\s+/g, " ").trim().toLowerCase());
}

/** Roads a person drives. Only these may re-queue a document that exhausted its attempts (M15). */
const USER_ROADS: ReadonlySet<PrintWatchDocKind> = new Set<PrintWatchDocKind>(["user-drop", "user-url"]);

interface ExistingRow {
  id: number;
  gate_verdict: "accepted" | "rejected";
  gate_reason: string | null;
  gate_fingerprint: string | null;
  parse_state: ParseState;
}

interface LineRow {
  metric_id: string;
  contract_json: string;
  expected_json: string | null;
  state: string;
  value: number | null;
  value_high: number | null;
  source_doc_id: number | null;
  candidates_json: string;
}

/**
 * Evidence retraction (M16): archive every candidate that came from `docId` and
 * re-reconcile each affected NON-accepted line from its stored contract/expected.
 * An accepted line only loses the retracted candidates from its audit trail
 * (rule 6). Synchronous; runs inside the caller's transaction.
 */
export function retractDocumentEvidence(
  db: Database.Database,
  docId: number,
  reason: string,
): { archived: number; linesChanged: number } {
  const owner = db.prepare(`SELECT print_id FROM print_watch_documents WHERE id = ?`).get(docId) as { print_id: number } | undefined;
  if (!owner) return { archived: 0, linesChanged: 0 };
  const printId = owner.print_id;
  const lines = db
    .prepare(`SELECT metric_id, contract_json, expected_json, state, value, value_high, source_doc_id, candidates_json FROM print_watch_lines WHERE print_id = ?`)
    .all(printId) as LineRow[];
  const archive = db.prepare(`INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, ?, ?, ?)`);
  const writeLine = db.prepare(
    `UPDATE print_watch_lines SET state = ?, value = ?, value_high = ?, snippet = ?, source_doc_id = ?, candidates_json = ?, updated_at = datetime('now')
      WHERE print_id = ? AND metric_id = ?`,
  );
  const writeAudit = db.prepare(`UPDATE print_watch_lines SET candidates_json = ?, updated_at = datetime('now') WHERE print_id = ? AND metric_id = ?`);
  let archived = 0;
  let linesChanged = 0;
  for (const line of lines) {
    let candidates: TaggedCandidate[];
    try {
      const parsed: unknown = JSON.parse(line.candidates_json);
      candidates = Array.isArray(parsed) ? (parsed as TaggedCandidate[]) : [];
    } catch {
      continue; // unreadable JSON is left exactly as it is (M7)
    }
    const kept = candidates.filter((c) => c.doc_id !== docId);
    if (kept.length === candidates.length) continue;
    for (const c of candidates) {
      if (c.doc_id !== docId) continue;
      archive.run(printId, line.metric_id, JSON.stringify(c), reason);
      archived += 1;
    }
    if (line.state === "accepted") {
      writeAudit.run(JSON.stringify(kept), printId, line.metric_id);
      continue;
    }
    const contract = JSON.parse(line.contract_json) as LineContract;
    const expected: Record<string, ExpectedValue> = {};
    if (line.expected_json) expected[line.metric_id] = JSON.parse(line.expected_json) as ExpectedValue;
    const [next] = reconcile([contract], expected, kept, []) as PrintWatchLine[];
    const nextSource = next.source_doc_id === 0 ? null : next.source_doc_id;
    writeLine.run(next.state, next.value, next.value_high, next.snippet, nextSource, JSON.stringify(kept), printId, line.metric_id);
    if (next.state !== line.state || next.value !== line.value || nextSource !== line.source_doc_id) linesChanged += 1;
  }
  return { archived, linesChanged };
}

export function recordDelivery(
  db: Database.Database,
  printId: number,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  bytes: Buffer,
  input: DeliveryInput,
): DeliveryResult {
  const sha = sha256Hex(bytes);
  const textSha = textIdentityHash(input.text);
  const fingerprint = gateFingerprint(input.gateCtx);
  const selectExisting = `SELECT id, gate_verdict, gate_reason, gate_fingerprint, parse_state FROM print_watch_documents`;

  const txn = db.transaction((): DeliveryResult => {
    const bySha = db.prepare(`${selectExisting} WHERE print_id = ? AND sha256 = ?`).get(printId, sha) as ExistingRow | undefined;
    const byText = bySha
      ? undefined
      : (db.prepare(`${selectExisting} WHERE print_id = ? AND text_sha256 = ? ORDER BY id LIMIT 1`).get(printId, textSha) as ExistingRow | undefined);
    const existing = bySha ?? byText;
    const matchedBy: DeliveryResult["matchedBy"] = bySha ? "bytes" : byText ? "text" : "new";

    let id: number;
    let isNew: boolean;
    let content: DocGateVerdict;
    let eligibleBefore = false;

    if (!existing) {
      content = contentVerdict(input.text, input.gateCtx);
      const r = db
        .prepare(
          `INSERT INTO print_watch_documents
             (print_id, kind, source, url, sha256, bytes_path, gate_verdict, gate_reason, gate_version, gate_fingerprint, parse_state, text_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(printId, kind, source, url, sha, input.bytesPath, content.ok ? "accepted" : "rejected", content.ok ? null : content.reason, GATE_VERSION, fingerprint, textSha);
      id = Number(r.lastInsertRowid);
      isNew = true;
    } else {
      id = existing.id;
      isNew = false;
      eligibleBefore = existing.gate_verdict === "accepted" && anyRoadAccepted(db, id);
      db.prepare(`UPDATE print_watch_documents SET last_seen_at = datetime('now'), text_sha256 = COALESCE(text_sha256, ?) WHERE id = ?`).run(textSha, id);
      if (existing.gate_fingerprint !== fingerprint) {
        content = contentVerdict(input.text, input.gateCtx);
        db.prepare(`UPDATE print_watch_documents SET gate_verdict = ?, gate_reason = ?, gate_version = ?, gate_fingerprint = ? WHERE id = ?`).run(
          content.ok ? "accepted" : "rejected", content.ok ? null : content.reason, GATE_VERSION, fingerprint, id,
        );
        // M16: evidence from a document the gate no longer accepts is retracted, not left green.
        if (existing.gate_verdict === "accepted" && !content.ok) retractDocumentEvidence(db, id, "gate-rejected");
      } else {
        content = existing.gate_verdict === "accepted" ? { ok: true } : { ok: false, reason: existing.gate_reason ?? "rejected" };
      }
      // M15: a person re-delivering the same bytes gets a fresh attempt budget; an automated road never does.
      if (existing.parse_state === "failed" && USER_ROADS.has(kind)) {
        db.prepare(`UPDATE print_watch_documents SET parse_state = 'queued', parse_attempts = 0, parse_last_error = NULL WHERE id = ?`).run(id);
      }
    }

    const road = roadVerdict(kind, input.text, input.gateCtx);
    db.prepare(
      `INSERT INTO print_watch_document_roads (document_id, kind, source, url, road_verdict, road_reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id, kind, source) DO UPDATE SET
         last_seen_at = datetime('now'),
         seen_count = print_watch_document_roads.seen_count + 1,
         url = COALESCE(excluded.url, print_watch_document_roads.url),
         road_verdict = excluded.road_verdict,
         road_reason = excluded.road_reason`,
    ).run(id, kind, source, url, road.ok ? "accepted" : "rejected", road.ok ? null : road.reason);

    const eligible = content.ok && anyRoadAccepted(db, id);
    // M16, second trigger: the last accepting road was withdrawn (a road verdict re-evaluated to rejected).
    if (existing && eligibleBefore && !eligible && content.ok) retractDocumentEvidence(db, id, "road-rejected");

    const parseState = (db.prepare(`SELECT parse_state FROM print_watch_documents WHERE id = ?`).get(id) as { parse_state: ParseState }).parse_state;
    const requeued = existing?.parse_state === "failed" && parseState === "queued";
    const needsParse = eligible && parseState === "queued" && (isNew || !eligibleBefore || requeued);
    return { id, isNew, needsParse, eligible, contentVerdict: content, roadVerdict: road, parseState, matchedBy };
  });

  return txn.immediate();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/delivery.test.ts tests/print-watch/store.test.ts`
Expected: PASS. (`tests/print-watch/watcher.test.ts`, `replay.test.ts`, and `tests/api/print-watch-routes.test.ts` will not compile until Task 9 rewires the watcher — that is expected at this checkpoint; do NOT run the full print-watch directory yet.)

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b8.txt <<'EOF'
feat(print-watch): store v2 — recordDelivery, parse-claim CAS, roads, sources, IR-seen

One immediate transaction records a delivery by content identity, upserts
its road with a per-road verdict, re-evaluates the content gate on a
fingerprint change, and decides parse eligibility (content accepted AND a
road accepted). Parse claims are compare-and-set with a 5-minute stale
takeover. insertDocument/markDocumentParsed/listUnparsedDocuments retire.
EOF
git commit lib/print-watch/types.ts lib/print-watch/store.ts lib/print-watch/delivery.ts tests/print-watch/delivery.test.ts tests/print-watch/store.test.ts tests/api/print-watch-routes.test.ts tests/print-watch/replay.test.ts -F /tmp/msg-b8.txt
```

---

### Task 9: Watcher on the new store — `ingestDocument` → `recordDelivery`, CAS parse queue, `refused`, status roads

**Files:**
- Modify: `lib/print-watch/watcher.ts` (`ingestDocument` 1316–1352, `gateContextFor` 664–676, `drainQueue` 1405–1445, `drainStrandedPrints` 1447–1465, `processDocument` 1525–1560, `refreshCoverage` 706–729, `parseEligible` 1397–1403, imports 78–100)
- Modify: `app/api/print-watch/status/route.ts` (+ `documentRoads`)
- Test: extend `tests/print-watch/watcher.test.ts` (`pipeline` describe) and `tests/api/print-watch-routes.test.ts`

**Interfaces:**
- Consumes: `recordDelivery`, `sha256Hex` (Task 8); `listParseQueue`, `hasParsableDocuments`, `claimDocumentParse`, `finalizeDocumentParse`, `listDocumentRoads` (Task 8); `classifyBytes` (Task 4); `contentVerdict`/`roadVerdict` via `recordDelivery` (Task 5).
- Produces:

```ts
// lib/print-watch/watcher.ts
export type IngestOutcome = "parsed" | "rejected" | "duplicate" | "queued" | "refused" | "parse_failed";
export interface IngestResult { docId: number; isNew: boolean; outcome: IngestOutcome; rejectReason?: string }
// ingestDocument signature unchanged: (db, printId, kind, source, url, buf) => Promise<IngestResult>
// `refused` ⇒ docId 0, isNew false, nothing stored (plan M11).
// `parse_failed` ⇒ the document is stored and eligible but its parse attempt failed; rejectReason = parse_last_error (M15).
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/print-watch/watcher.test.ts` inside `describe("pipeline")`:

```ts
  it("identical bytes through two roads are ONE document with two roads, ONE extraction, and single_source (M13)", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => [candidate("revenue_q", 1000)];
    const text = "ACME reports Q2 2026 results. Revenue $1,000 million.";
    const a = await ingestDocument(db, printId, "edgar-ex99", "edgar:0001:ex99-1", "https://www.sec.gov/x", Buffer.from(text));
    const b = await ingestDocument(db, printId, "user-drop", "user-drop:release.txt", null, Buffer.from(text));
    expect(a.outcome).toBe("parsed");
    expect(b).toMatchObject({ docId: a.docId, isNew: false, outcome: "duplicate" });
    expect(listDocuments(db, printId)).toHaveLength(1);
    expect(listDocumentRoads(db, printId).map((r) => r.kind).sort()).toEqual(["edgar-ex99", "user-drop"]);
    expect(fake.extractCalls).toHaveLength(1);
    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    expect(line.state).toBe("single_source");
    expect((JSON.parse(line.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([a.docId]);
  });

  it("a stricter road first (ir-page, last quarter's labels) is rejected; the same bytes by drop become eligible and parse", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => [candidate("revenue_q", 900)];
    const text = "ACME reports first quarter fiscal 2027 results. Revenue $900 million.";
    const ir = await ingestDocument(db, printId, "ir-page", "ir-page:old", "https://ir.acme.example/old", Buffer.from(text));
    expect(ir.outcome).toBe("rejected");
    expect(ir.rejectReason).toMatch(/IR page/i);
    expect(fake.extractCalls).toHaveLength(0);
    const drop = await ingestDocument(db, printId, "user-drop", "user-drop:same.txt", null, Buffer.from(text));
    expect(drop).toMatchObject({ docId: ir.docId, outcome: "parsed" });
    expect(fake.extractCalls).toHaveLength(1);
  });

  it("refuses binary bytes without storing a document", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    const r = await ingestDocument(db, printId, "user-drop", "user-drop:x.bin", null, Buffer.from([0x41, 0x00, 0x42]));
    expect(r).toMatchObject({ docId: 0, isNew: false, outcome: "refused" });
    expect(r.rejectReason).toMatch(/binary/);
    expect(listDocuments(db, printId)).toEqual([]);
  });

  it("parses through a CAS claim: a stale claim from a dead worker is taken over on the next drain", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => [candidate("revenue_q", 1)];
    const text = "ACME reports Q2 2026 results.";
    const bytes = Buffer.from(text);
    const delivered = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath: path.join(tmpRoot, "dead.txt"), text, gateCtx: { symbol: "ACME", issuerName: null, eventDate: EVENT_DATE },
    });
    fs.writeFileSync(path.join(tmpRoot, "dead.txt"), bytes);
    // A worker claimed it six minutes ago and never finalised.
    claimDocumentParse(db, delivered.id, "dead-token", fake.nowMs - 6 * 60_000);
    ensurePrintWatch(db); // drains stranded work
    await waitUntil(() => getDocument(db, delivered.id)?.parse_state === "parsed");
    expect(fake.extractCalls).toHaveLength(1);
  });

  it("a failed extraction reports parse_failed with the durable error, returns the document to the queue, and counts ONE attempt (M15)", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => { throw new Error("model 529"); };
    const r = await ingestDocument(db, printId, "user-drop", "u", null, Buffer.from("ACME reports Q2 2026 results."));
    expect(r.outcome).toBe("parse_failed"); // the durable state after the drain, never the drain's return value
    expect(r.rejectReason).toMatch(/model 529/);
    expect(getDocument(db, r.docId)).toMatchObject({ parse_state: "queued", parse_attempts: 1, parse_last_error: expect.stringMatching(/model 529/) });
    expect(getWatchStatus(db)[0].sources.pipeline).toMatch(/model 529/);
    expect(fake.extractCalls).toHaveLength(1);
  });

  it("the attempt budget survives a restart and a fifth failure is terminal until a person re-delivers (M15)", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.extract = async () => { throw new Error("model 529"); };
    const r = await ingestDocument(db, printId, "user-drop", "u", null, Buffer.from("ACME reports Q2 2026 results."));
    db.prepare(`UPDATE print_watch_documents SET parse_attempts = 4 WHERE id = ?`).run(r.docId);
    _setTestSeams(null); // "restart": every in-memory attempt record is gone
    installSeams();
    fake.extract = async () => { throw new Error("model 529"); };
    fake.nowMs += 60_000;
    ensurePrintWatch(db);
    await waitUntil(() => getDocument(db, r.docId)?.parse_state === "failed");
    expect(getDocument(db, r.docId)?.parse_attempts).toBe(5);
    fake.extract = async () => [candidate("revenue_q", 1)];
    const again = await ingestDocument(db, printId, "user-drop", "u2", null, Buffer.from("ACME reports Q2 2026 results."));
    expect(again).toMatchObject({ docId: r.docId, outcome: "parsed" });
  });
```

(The file's `fake` state already has `nowMs`-style clock control via `_setTestSeams({ now })` in `installSeams()`; if it does not expose `fake.nowMs`, add `nowMs: number` to `FakeSeamState` and wire `now: () => fake.nowMs`. `waitUntil` exists in `replay.test.ts`; copy it: `async function waitUntil(pred: () => boolean, ms = 2000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } }`.)

Add to `tests/api/print-watch-routes.test.ts` (status describe):

```ts
  it("GET /status carries documentRoads per document alongside the kind map", async () => {
    const { GET } = await import("@/app/api/print-watch/status/route");
    const res = await GET();
    const body = (await res.json()) as { data: { prints: Array<{ documents: Record<string, string>; documentRoads: Record<string, Array<{ kind: string; source: string; verdict: string }>> }> } };
    const print = body.data.prints[0];
    for (const docId of Object.keys(print.documents)) {
      expect(print.documentRoads[docId]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: print.documents[docId], verdict: "accepted" })]));
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/watcher.test.ts tests/api/print-watch-routes.test.ts`
Expected: FAIL to compile — the watcher still imports `insertDocument` / `markDocumentParsed` / `listUnparsedDocuments`.

- [ ] **Step 3: Rewire the watcher**

Imports (`watcher.ts:78-100`): drop `insertDocument`, `markDocumentParsed`, `listUnparsedDocuments`; add `listParseQueue`, `hasParsableDocuments`, `claimDocumentParse`, `finalizeDocumentParse` from `./store`; `recordDelivery` from `./delivery`; `classifyBytes` from `./url-fetch`; `randomUUID` from `node:crypto`.

`gateContextFor` loses its `kind` parameter:

```ts
function gateContextFor(db: Database.Database, print: PrintRow): DocGateContext {
  const rt = runtimes.get(print.id);
  return { symbol: print.symbol, issuerName: rt ? rt.issuerName : readIssuerName(db, print.symbol), eventDate: print.event_date };
}
```

`ingestDocument` body (replace 1324–1352):

```ts
  const print = readPrintRow(db, printId);
  if (!print) throw new Error(`print-watch: print ${printId} not found`);

  const shape = classifyBytes(buf);
  if (shape === "binary") {
    return { docId: 0, isNew: false, outcome: "refused", rejectReason: "binary content — print-watch reads HTML, plain text, or PDF" };
  }
  if (shape === "pdf") return ingestPdf(db, print, kind, source, url, buf); // Task 10

  const sha = sha256(buf);
  const ext = shape === "html" ? "html" : "txt";
  const text = buf.toString("utf8");
  const bytesPath = await writeBytes(printId, sha, ext, buf);
  return finishIngest(db, print, kind, source, url, buf, { bytesPath, text, gateCtx: gateContextFor(db, print) });
}

/** The shared tail of every ingest: record the delivery, then parse if owed. */
async function finishIngest(
  db: Database.Database,
  print: PrintRow,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  buf: Buffer,
  input: DeliveryInput,
): Promise<IngestResult> {
  const delivery = recordDelivery(db, print.id, kind, source, url, buf, input);
  const status = statusFor(print.id);
  if (!delivery.contentVerdict.ok) {
    status.sources.gate = `doc ${delivery.id} rejected: ${delivery.contentVerdict.reason}`;
    return { docId: delivery.id, isNew: delivery.isNew, outcome: "rejected", rejectReason: delivery.contentVerdict.reason };
  }
  if (!delivery.eligible) {
    const reason = delivery.roadVerdict.ok ? "no accepting road yet" : delivery.roadVerdict.reason;
    status.sources.gate = `doc ${delivery.id} road ${kind} rejected: ${reason}`;
    return { docId: delivery.id, isNew: delivery.isNew, outcome: "rejected", rejectReason: reason };
  }
  if (!delivery.needsParse) return { docId: delivery.id, isNew: delivery.isNew, outcome: "duplicate" };

  advanceState(db, print.id, "acquired");
  const drain = await runQueue(db, print.id);
  if (drain === "lease_blocked") return { docId: delivery.id, isNew: delivery.isNew, outcome: "queued" };
  // M15: report the DURABLE state of this document after the drain — never the
  // drain's return value, which only says the pass ran.
  const after = getDocument(db, delivery.id);
  if (after?.parse_state === "parsed") return { docId: delivery.id, isNew: delivery.isNew, outcome: "parsed" };
  if (after?.parse_state === "claimed") return { docId: delivery.id, isNew: delivery.isNew, outcome: "queued" };
  return {
    docId: delivery.id,
    isNew: delivery.isNew,
    outcome: "parse_failed",
    rejectReason: after?.parse_last_error ?? "the parse did not complete",
  };
}
```

(`getDocument` is imported from `./store`.)

(`ingestPdf` is written in Task 10; for THIS task's commit make it `async function ingestPdf(): Promise<IngestResult> { return { docId: 0, isNew: false, outcome: "refused", rejectReason: "PDF drops land in Task 10" }; }` — a one-line placeholder that Task 10 replaces the same day; the existing `print-watch-routes.test.ts` PDF-rejection test still passes on the `refused` → 400 mapping.)

`parseEligible` keeps the in-memory spacing/attempt budget (unchanged). `drainQueue` (replace 1405–1445):

```ts
async function drainQueue(db: Database.Database, printId: number): Promise<DrainOutcome> {
  const attemptedThisPass = new Set<number>();
  for (;;) {
    const nowMs = seams.now();
    const pending = listParseQueue(db, printId).filter((doc) => !attemptedThisPass.has(doc.id) && parseEligible(doc, nowMs));
    // A claim older than PARSE_CLAIM_STALE_MS belongs to a dead worker — offer it too.
    const stale = db
      .prepare(
        `SELECT d.* FROM print_watch_documents d
          WHERE d.print_id = ? AND d.parse_state = 'claimed'
            AND datetime(d.parse_claimed_at) < datetime(?)
            AND d.gate_verdict = 'accepted'
            AND EXISTS (SELECT 1 FROM print_watch_document_roads r WHERE r.document_id = d.id AND r.road_verdict = 'accepted')
          ORDER BY d.id`,
      )
      .all(printId, new Date(nowMs - PARSE_CLAIM_STALE_MS).toISOString()) as DocumentRow[];
    const candidates = [...pending, ...stale.filter((d) => !attemptedThisPass.has(d.id))];
    if (candidates.length === 0) return "drained";

    const doc = candidates[0];
    attemptedThisPass.add(doc.id);

    if (!claimLease(db)) {
      statusFor(printId).sources.pipeline = "lease lost — parsing deferred to the owner";
      return "lease_blocked";
    }
    const token = randomUUID();
    if (!claimDocumentParse(db, doc.id, token, nowMs)) continue; // another worker got there first

    // The claim incremented parse_attempts durably (M15); the in-memory map now
    // only carries the retry SPACING (last attempt time) for this process.
    const attempts = doc.parse_attempts + 1;
    parseAttempts.set(doc.id, { attempts, lastAtMs: nowMs });
    try {
      const written = await processDocument(db, printId, doc);
      finalizeDocumentParse(db, doc.id, token, written ? "parsed" : "queued", written ? null : "sheet write refused — lease lost");
    } catch (err) {
      const message = errText(err);
      statusFor(printId).sources.pipeline = `doc ${doc.id}: ${message}`;
      finalizeDocumentParse(db, doc.id, token, attempts >= MAX_PARSE_ATTEMPTS ? "failed" : "queued", message);
    }
  }
}
```

`parseEligible` reads the budget from the ROW and only the spacing from memory:

```ts
function parseEligible(doc: DocumentRow, nowMs: number): boolean {
  if (doc.parse_attempts >= MAX_PARSE_ATTEMPTS) return false;
  const record = parseAttempts.get(doc.id);
  if (!record) return true;
  return nowMs - record.lastAtMs >= PARSE_RETRY_SPACING_MS;
}
```

(`PARSE_CLAIM_STALE_MS` is imported from `./store`. The stale-claim query lives here rather than in the store because it is the ONE place a takeover is decided; `listParseQueue` stays the honest "queued" read. The `REJECTED_PREFIX` constant and its `source.startsWith` checks are deleted — the verdict lives in `gate_verdict` now.)

`processDocument` returns `boolean` (the `writeLines` result) and no longer calls `markDocumentParsed`:

```ts
async function processDocument(db: Database.Database, printId: number, doc: DocumentRow): Promise<boolean> {
  const print = readPrintRow(db, printId);
  if (!print) return false;
  const { contracts } = compileContracts(db, print.event_id, print.symbol);
  const fresh: TaggedCandidate[] = [];
  if (doc.bytes_path.endsWith(".pdf")) {
    fresh.push(...(await pdfCandidates(db, doc, contracts))); // Task 10
  } else {
    const raw = await fsp.readFile(doc.bytes_path, "utf8");
    if (doc.bytes_path.endsWith(".html")) {
      const repA = await seams.extractCandidates(contracts, htmlToTablesRepresentation(raw));
      fresh.push(...tag(repA, doc.id, "repA", false));
      const repB = await seams.extractCandidates(contracts, htmlToRawText(raw));
      fresh.push(...tag(repB, doc.id, "repB", false));
    } else {
      const only = await seams.extractCandidates(contracts, raw);
      fresh.push(...tag(only, doc.id, "repB", false));
    }
  }
  const existing = collectCandidates(db, printId).filter((c) => c.doc_id !== doc.id);
  const written = writeLines(db, printId, print.event_id, print.symbol, [...existing, ...fresh]);
  if (written) advanceState(db, printId, "parsed");
  return written;
}
```

(For this task, `pdfCandidates` is `async function pdfCandidates(): Promise<TaggedCandidate[]> { return []; }` — Task 10 replaces it.) `tag` gains an optional fifth parameter `pairNote?: "pdf-weak"` written as `pair_note` only when present.

`drainStrandedPrints`: replace the `listUnparsedDocuments(...).some(...)` read with `hasParsableDocuments(db, printId)`.

`refreshCoverage`: both `"drop: HTML/text"` strings become `"drop: HTML/text/PDF, or a pasted link"`.

`app/api/print-watch/status/route.ts`: add

```ts
      documentRoads: Object.fromEntries(
        listDocuments(db, row.printId).map((doc) => [
          doc.id,
          listDocumentRoads(db, row.printId)
            .filter((r) => r.document_id === doc.id)
            .map((r) => ({ kind: r.kind, source: r.source, verdict: r.road_verdict })),
        ]),
      ) as Record<number, Array<{ kind: string; source: string; verdict: string }>>,
```

(`listDocumentRoads` is a read; the GET stays mutation-free for the static scan. Call it once per print and index in memory rather than per document if the reviewer prefers — either shape passes the scan.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ tests/api/print-watch-routes.test.ts tests/api/print-watch-accept.test.ts tests/api/no-state-changing-get.test.ts`
Expected: PASS — every existing watcher/replay/route test plus the five new pipeline tests and the roads test. The existing `re-ingesting identical bytes is a no-op (no second parse)` test now passes through `recordDelivery`'s `needsParse: false`.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b9.txt <<'EOF'
feat(print-watch): watcher on content identity — recordDelivery, CAS parse queue, refused

ingestDocument classifies bytes, writes them, records the delivery, and
parses only when a parse is owed; drainQueue claims each document by
token (stale claims taken over after 5 min) and finalises by CAS; binary
bodies are refused without a row; status carries per-document roads.
Two roads delivering the same bytes now yield one document and an honest
single_source (M13 test).
EOF
git commit lib/print-watch/watcher.ts app/api/print-watch/status/route.ts tests/print-watch/watcher.test.ts tests/api/print-watch-routes.test.ts -F /tmp/msg-b9.txt
```

---

### Task 10: PDF road — pre-registered gate, poppler text reading, Claude-native reading, weak pair

**Files:**
- Modify: `docs/DECISIONS.md` (append — step 1, BEFORE any code)
- Create: `lib/print-watch/pdf.ts`
- Modify: `lib/print-watch/extract.ts` (+ `extractCandidatesFromPdf`, shared `callExtraction`)
- Modify: `lib/print-watch/watcher.ts` (`WatcherSeams` + defaults; real `ingestPdf` and `pdfCandidates`)
- Modify: `app/api/print-watch/drop/route.ts` (remove the PDF refusal; `refused` → 400)
- Test: `tests/print-watch/pdf.test.ts`; extend `tests/print-watch/extract.test.ts`, `tests/print-watch/watcher.test.ts`, `tests/api/print-watch-routes.test.ts`

**Interfaces:**
- Consumes: `recordDelivery`/`finishIngest` (Tasks 8–9), `sha256Hex` (Task 8).
- Produces:

```ts
// lib/print-watch/pdf.ts
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_PAGES = 60;
export const PDF_MIN_TEXT_CHARS = 500;
export const PDFTOTEXT_TIMEOUT_MS = 30_000;
export const PDFTOTEXT_SETTING_KEY = "pdftotext_path";
export const PDFTOTEXT_CANDIDATES = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"];
export type PdfCheck = { ok: true } | { ok: false; reason: string };
export function isPdf(buf: Buffer): boolean;
export function checkPdfBytes(buf: Buffer): PdfCheck;                       // size cap; /Encrypt pre-check
export function checkPdfText(text: string): PdfCheck;                       // pages (form feeds) ≤ 60; ≥ 500 chars
export function resolvePdftotextPath(db: Database.Database, env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean): string | null;
export class PdfToolMissingError extends Error {}
export class PdfEncryptedError extends Error {}
export interface PdftotextSeams { spawn?: typeof import("node:child_process").spawn; timeoutMs?: number; maxBytes?: number }
export function runPdftotext(binary: string, pdfPath: string, seams?: PdftotextSeams): Promise<string>;
export function textPathFor(bytesPath: string): string;                     // <dir>/<sha>.pdftext.txt beside <sha>.pdf

// lib/print-watch/extract.ts (added)
export async function extractCandidatesFromPdf(contracts: LineContract[], pdfBytes: Buffer, opts?: { model?: string; anthropic?: AnthropicLike }): Promise<ParseCandidate[]>;

// lib/print-watch/watcher.ts — WatcherSeams gains
  pdfToText: (db: Database.Database, pdfPath: string) => Promise<string>;
  extractCandidatesFromPdf: (contracts: LineContract[], bytes: Buffer) => Promise<ParseCandidate[]>;
```

- [ ] **Step 1: Pre-register the PDF-pair gate in `docs/DECISIONS.md` (before any measurement)**

Append at the bottom of `docs/DECISIONS.md`:

```markdown
- **PDF reading pair is WEAK until a pre-registered holdout passes (2026-09-02, live print v2 slice B)** — A PDF release is read two ways (poppler `pdftotext -layout` text, and the PDF itself as a Claude `document` block). Unlike the HTML pair (repA/repB, pilot-measured 98.5–100% on the bake-off), nothing has measured whether these two readings fail independently, so both candidates carry `weak_pair = true` / `pair_note = "pdf-weak"` and a PDF alone renders as verify-only, never green. The gate is registered HERE, before measurement, and only a passing measurement flips the pair: a FROZEN holdout of at least 50 earnings releases as PDFs with at least 500 hand-labelled lines, drawn from the gitignored `tests/fixtures/real/` tree and listed in a manifest committed to that tree before any parse is run; green precision ≥ 99% among cells the pair would have greened, with ZERO catastrophic errors (v1 spec §2: wrong period, basis, sign, unit/scale, superseded version, or failed issuer/period validation). A measurement that fails is recorded here as well, with the error classes, and the pair stays weak.
```

Commit this alone (it is a decision record, not code):

```bash
cat > /tmp/msg-b10a.txt <<'EOF'
docs(decisions): pre-register the PDF-pair green-precision gate (live print v2 slice B)
EOF
git commit docs/DECISIONS.md -F /tmp/msg-b10a.txt
```

- [ ] **Step 2: Write the failing tests**

`tests/print-watch/pdf.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runMigrations } from "@/lib/db/migrate";
import {
  isPdf, checkPdfBytes, checkPdfText, resolvePdftotextPath, runPdftotext, textPathFor,
  PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_MIN_TEXT_CHARS, PDFTOTEXT_SETTING_KEY, PDFTOTEXT_STDERR_CAP, PdfEncryptedError,
} from "@/lib/print-watch/pdf";

function fakeSpawn(script: { stdout?: string; stderr?: string; code?: number; hang?: boolean }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const killed: number[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed.push(1); setImmediate(() => child.emit("close", null)); };
    if (!script.hang) {
      setImmediate(() => {
        if (script.stdout) child.stdout.write(script.stdout);
        if (script.stderr) child.stderr.write(script.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", script.code ?? 0);
      });
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls, killed };
}

describe("pdf.ts — byte and text checks", () => {
  it("isPdf sniffs the %PDF- signature", () => {
    expect(isPdf(Buffer.from("%PDF-1.7\n"))).toBe(true);
    expect(isPdf(Buffer.from("<html>"))).toBe(false);
  });
  it("refuses oversize and encrypted PDFs with their own messages", () => {
    expect(checkPdfBytes(Buffer.alloc(PDF_MAX_BYTES + 1, 0x20))).toEqual({ ok: false, reason: expect.stringMatching(/10MB/) });
    expect(checkPdfBytes(Buffer.from("%PDF-1.7 trailer << /Encrypt 5 0 R >>"))).toEqual({ ok: false, reason: expect.stringMatching(/encrypted/i) });
    expect(checkPdfBytes(Buffer.from("%PDF-1.7 hello"))).toEqual({ ok: true });
  });
  it("refuses an image-only text layer and more than 60 pages", () => {
    expect(checkPdfText("a".repeat(PDF_MIN_TEXT_CHARS - 1))).toEqual({ ok: false, reason: expect.stringMatching(/image-only|text layer/i) });
    expect(checkPdfText("a".repeat(PDF_MIN_TEXT_CHARS) + "\f".repeat(PDF_MAX_PAGES + 1))).toEqual({ ok: false, reason: expect.stringMatching(/60 pages/) });
    expect(checkPdfText("a".repeat(PDF_MIN_TEXT_CHARS) + "\f".repeat(3))).toEqual({ ok: true });
  });
  it("textPathFor places the text beside the bytes", () => {
    expect(textPathFor("/data/print-watch/7/abc.pdf")).toBe("/data/print-watch/7/abc.pdftext.txt");
  });
});

describe("resolvePdftotextPath", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  it("prefers settings.pdftotext_path, then the Homebrew and /usr/local paths, then PATH, else null", () => {
    const exists = (p: string) => p === "/opt/homebrew/bin/pdftotext" || p === "/custom/pdftotext" || p === "/pathdir/pdftotext";
    expect(resolvePdftotextPath(db, { PATH: "/pathdir" }, exists)).toBe("/opt/homebrew/bin/pdftotext");
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(PDFTOTEXT_SETTING_KEY, "/custom/pdftotext");
    expect(resolvePdftotextPath(db, { PATH: "/pathdir" }, exists)).toBe("/custom/pdftotext");
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(PDFTOTEXT_SETTING_KEY);
    expect(resolvePdftotextPath(db, { PATH: "/pathdir" }, (p) => p === "/pathdir/pdftotext")).toBe("/pathdir/pdftotext");
    expect(resolvePdftotextPath(db, { PATH: "/nowhere" }, () => false)).toBeNull();
  });
});

describe("runPdftotext", () => {
  it("invokes `pdftotext -layout -enc UTF-8 <file> -` and returns stdout", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "ACME Q2 2026\f" });
    await expect(runPdftotext("/opt/homebrew/bin/pdftotext", "/x/a.pdf", { spawn })).resolves.toBe("ACME Q2 2026\f");
    expect(calls[0]).toEqual({ cmd: "/opt/homebrew/bin/pdftotext", args: ["-layout", "-enc", "UTF-8", "/x/a.pdf", "-"] });
  });
  it("classifies a password error as PdfEncryptedError and any other non-zero exit as a plain error", async () => {
    const enc = fakeSpawn({ stderr: "Command Line Error: Incorrect password", code: 1 });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: enc.spawn })).rejects.toBeInstanceOf(PdfEncryptedError);
    const other = fakeSpawn({ stderr: "Syntax Error: Couldn't find trailer dictionary", code: 1 });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: other.spawn })).rejects.toThrow(/exited 1/);
  });
  it("kills the child on timeout and caps BOTH streams (stdout at maxBytes, stderr at 64KB)", async () => {
    const hung = fakeSpawn({ hang: true });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: hung.spawn, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(hung.killed).toHaveLength(1);
    const big = fakeSpawn({ stdout: "x".repeat(2000) });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: big.spawn, maxBytes: 1000 })).rejects.toThrow(/cap/);
    expect(big.killed).toHaveLength(1);
    const noisy = fakeSpawn({ stderr: "e".repeat(PDFTOTEXT_STDERR_CAP + 1), code: 0 });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: noisy.spawn })).rejects.toThrow(/stderr exceeded/);
    expect(noisy.killed).toHaveLength(1);
  });
});
```

Add to `tests/print-watch/extract.test.ts`:

```ts
  it("extractCandidatesFromPdf sends the PDF as a document block ahead of the contract text, same tool + system prompt", async () => {
    const create = vi.fn(async (params: { messages: Array<{ content: unknown }>; tools: unknown[]; system: string }) => ({
      content: [{ type: "tool_use", name: "report_candidates", input: { candidates: [{ metric_id: "revenue_q", value: 1, value_high: null, raw_text: "1", snippet: "s", location_hint: null, not_disclosed: false }] } }],
      stop_reason: "tool_use",
    }));
    const out = await extractCandidatesFromPdf(contracts, Buffer.from("%PDF-1.7 fake"), { anthropic: mockClient(create) });
    expect(out).toHaveLength(1);
    const content = create.mock.calls[0][0].messages[0].content as Array<{ type: string; source?: { media_type: string; data: string }; text?: string }>;
    expect(content[0].type).toBe("document");
    expect(content[0].source?.media_type).toBe("application/pdf");
    expect(content[0].source?.data).toBe(Buffer.from("%PDF-1.7 fake").toString("base64"));
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("=== CONTRACT LINES");
    expect(content[1].text).not.toMatch(/expected|bogey|consensus/i);
  });
```

(Use the file's existing `contracts` fixture and `mockClient` helper; the tool name constant is whatever `TOOL_NAME` is in `extract.ts` — read it and match.)

Add to `tests/print-watch/watcher.test.ts` (`pipeline` describe):

```ts
  it("a PDF drop is read twice (pdfText + pdfNative) as a weak pair, persists its text, and reaches single_source", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.pdfText = async () => `ACME reports Q2 2026 results. Revenue $1,000 million.${" ".repeat(500)}\f`;
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.extractPdf = async () => [candidate("revenue_q", 1000)];
    const pdf = Buffer.from("%PDF-1.7\n%fake\n");
    const r = await ingestDocument(db, printId, "user-drop", "user-drop:release.pdf", null, pdf);
    expect(r.outcome).toBe("parsed");
    const [doc] = listDocuments(db, printId);
    expect(doc.bytes_path.endsWith(".pdf")).toBe(true);
    expect(fs.existsSync(textPathFor(doc.bytes_path))).toBe(true);
    expect(doc.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.extractCalls).toHaveLength(1);
    expect(fake.extractPdfCalls).toHaveLength(1);
    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    expect(line.state).toBe("single_source");
    const cands = JSON.parse(line.candidates_json) as TaggedCandidate[];
    expect(cands.map((c) => c.representation).sort()).toEqual(["pdfNative", "pdfText"]);
    expect(cands.every((c) => c.weak_pair && c.pair_note === "pdf-weak")).toBe(true);
  });

  it("refuses a PDF when poppler is missing, naming the tool and the setting, storing nothing", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.pdfText = async () => { throw new PdfToolMissingError("pdftotext not found — install poppler (brew install poppler) or set settings.pdftotext_path"); };
    const r = await ingestDocument(db, printId, "user-drop", "u.pdf", null, Buffer.from("%PDF-1.7\n"));
    expect(r).toMatchObject({ docId: 0, outcome: "refused" });
    expect(r.rejectReason).toMatch(/pdftotext/);
    expect(r.rejectReason).toMatch(/pdftotext_path/);
    expect(listDocuments(db, printId)).toEqual([]);
    const dir = path.join(tmpRoot, String(printId));
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]); // no orphan bytes (M14)
  });

  it("refuses an image-only PDF (thin text layer) and an encrypted one", async () => {
    const { eventId } = seedArmedEvent();
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    fake.pdfText = async () => "ACME\f";
    expect((await ingestDocument(db, printId, "user-drop", "u.pdf", null, Buffer.from("%PDF-1.7\n"))).rejectReason).toMatch(/image-only|text layer/i);
    fake.pdfText = async () => { throw new PdfEncryptedError("encrypted PDF"); };
    expect((await ingestDocument(db, printId, "user-drop", "u.pdf", null, Buffer.from("%PDF-1.7\n"))).rejectReason).toMatch(/encrypted/i);
    expect(listDocuments(db, printId)).toEqual([]);
  });
```

(Extend `FakeSeamState` with `pdfText`, `extractPdf`, `extractPdfCalls` and wire them in `installSeams()` to the two new seams.)

Add to `tests/api/print-watch-routes.test.ts`: replace the v1 "PDF is refused with the ⌘S hint" test with one that drops a `%PDF-` body with the pdfToText seam returning a valid text layer and asserts HTTP 200 + `outcome: "parsed"`; and one where the seam throws `PdfToolMissingError` → HTTP 400 with `error` naming `pdftotext`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/pdf.test.ts tests/print-watch/extract.test.ts tests/print-watch/watcher.test.ts tests/api/print-watch-routes.test.ts`
Expected: FAIL — `@/lib/print-watch/pdf` not found; `extractCandidatesFromPdf` not exported.

- [ ] **Step 4: Implement**

`lib/print-watch/pdf.ts`:

```ts
// PDF road (spec §4.2 "PDF"). Reading one: poppler `pdftotext -layout`
// through a DI spawn seam (function-boundary seam, same shape as
// lib/earnings/worksheet.ts's `seams.printPdf ?? printPdfViaLp`). Reading
// two lives in extract.ts (Claude `document` block). Page count and
// encryption come from pdftotext itself (plan M14).
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { MAX_RESPONSE_BYTES } from "./hardened-fetch";

export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_PAGES = 60;
export const PDF_MIN_TEXT_CHARS = 500;
export const PDFTOTEXT_TIMEOUT_MS = 30_000;
/** Both child streams are bounded (M14): stdout at the 2MB document cap, stderr here. */
export const PDFTOTEXT_STDERR_CAP = 64 * 1024;
export const PDFTOTEXT_SETTING_KEY = "pdftotext_path";
export const PDFTOTEXT_CANDIDATES = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"];

export type PdfCheck = { ok: true } | { ok: false; reason: string };

export class PdfToolMissingError extends Error {
  constructor(message: string) { super(message); this.name = "PdfToolMissingError"; }
}
export class PdfEncryptedError extends Error {
  constructor(message: string) { super(message); this.name = "PdfEncryptedError"; }
}

export function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

export function checkPdfBytes(buf: Buffer): PdfCheck {
  if (buf.length > PDF_MAX_BYTES) return { ok: false, reason: "PDF is larger than 10MB — print-watch accepts releases up to 10MB" };
  if (/\/Encrypt\b/.test(buf.toString("latin1"))) return { ok: false, reason: "encrypted PDF — remove the password and drop it again" };
  return { ok: true };
}

export function checkPdfText(text: string): PdfCheck {
  const pages = (text.match(/\f/g) ?? []).length;
  if (pages > PDF_MAX_PAGES) return { ok: false, reason: `PDF has ${pages} pages — print-watch reads releases up to ${PDF_MAX_PAGES} pages` };
  if (text.replace(/\s+/g, "").length < PDF_MIN_TEXT_CHARS) {
    return { ok: false, reason: "image-only PDF (no usable text layer) — print-watch does not OCR; drop the HTML release or paste its link" };
  }
  return { ok: true };
}

export function textPathFor(bytesPath: string): string {
  return bytesPath.replace(/\.pdf$/, ".pdftext.txt");
}

export function resolvePdftotextPath(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(PDFTOTEXT_SETTING_KEY) as { value: string } | undefined;
  if (row?.value && exists(row.value)) return row.value;
  for (const candidate of PDFTOTEXT_CANDIDATES) if (exists(candidate)) return candidate;
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, "pdftotext");
    if (exists(p)) return p;
  }
  return null;
}

export interface PdftotextSeams {
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  maxBytes?: number;
}

export function runPdftotext(binary: string, pdfPath: string, seams: PdftotextSeams = {}): Promise<string> {
  const spawn = seams.spawn ?? nodeSpawn;
  const timeoutMs = seams.timeoutMs ?? PDFTOTEXT_TIMEOUT_MS;
  const maxBytes = seams.maxBytes ?? MAX_RESPONSE_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-layout", "-enc", "UTF-8", pdfPath, "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(`pdftotext timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        child.kill();
        settle(() => reject(new Error(`pdftotext output exceeded the ${maxBytes}-byte cap`)));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > PDFTOTEXT_STDERR_CAP) {
        child.kill();
        settle(() => reject(new Error(`pdftotext stderr exceeded the ${PDFTOTEXT_STDERR_CAP}-byte cap`)));
      }
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
        else if (/password/i.test(stderr)) reject(new PdfEncryptedError("encrypted PDF — remove the password and drop it again"));
        else reject(new Error(`pdftotext exited ${code}: ${stderr.trim().slice(0, 200)}`));
      });
    });
  });
}
```

`lib/print-watch/extract.ts`: pull the two-attempt loop out of `extractCandidates` into `async function callExtraction(client: AnthropicLike, modelId: string, content: string | Anthropic.ContentBlockParam[]): Promise<ParseCandidate[]>` (body identical to the loop, with `messages: [{ role: "user", content }]`); `extractCandidates` becomes `return callExtraction(client, modelId, buildUserMessage(contracts, representationText));`. Add:

```ts
function buildPdfUserMessage(contracts: LineContract[]): string {
  return [
    "=== CONTRACT LINES (extract exactly these, one candidate each) ===",
    JSON.stringify(contracts, null, 2),
    "",
    "=== DOCUMENT ===",
    "(the document is the attached PDF)",
    "=== END OF DOCUMENT ===",
  ].join("\n");
}

/** Reading two of a PDF: the bytes themselves as a Claude `document` block
 *  (the lib/research-documents/extract.ts path), same tool and prompt. */
export async function extractCandidatesFromPdf(
  contracts: LineContract[],
  pdfBytes: Buffer,
  opts: { model?: string; anthropic?: AnthropicLike } = {},
): Promise<ParseCandidate[]> {
  const modelId = resolveExtractionModelId(opts.model);
  const client = opts.anthropic ?? defaultClient();
  return callExtraction(client, modelId, [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") } },
    { type: "text", text: buildPdfUserMessage(contracts) },
  ]);
}
```

`lib/print-watch/watcher.ts`: `WatcherSeams` gains `pdfToText` and `extractCandidatesFromPdf`; defaults:

```ts
  pdfToText: async (db, pdfPath) => {
    const binary = resolvePdftotextPath(db);
    if (!binary) {
      throw new PdfToolMissingError(
        `pdftotext not found — install poppler (brew install poppler) or set settings.${PDFTOTEXT_SETTING_KEY}`,
      );
    }
    return runPdftotext(binary, pdfPath);
  },
  extractCandidatesFromPdf: (contracts, bytes) => extractCandidatesFromPdf(contracts, bytes),
```

Real `ingestPdf`:

```ts
async function ingestPdf(
  db: Database.Database,
  print: PrintRow,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  buf: Buffer,
): Promise<IngestResult> {
  const bytesCheck = checkPdfBytes(buf);
  if (!bytesCheck.ok) return { docId: 0, isNew: false, outcome: "refused", rejectReason: bytesCheck.reason };
  const sha = sha256(buf);
  const bytesPath = await writeBytes(print.id, sha, "pdf", buf);
  // A refusal after the bytes are on disk removes them (M14): no row references
  // them, and a later delivery of the same bytes rewrites them content-addressed.
  const refused = async (reason: string): Promise<IngestResult> => {
    await fsp.rm(bytesPath, { force: true });
    await fsp.rm(textPathFor(bytesPath), { force: true });
    return { docId: 0, isNew: false, outcome: "refused", rejectReason: reason };
  };
  let text: string;
  try {
    text = await seams.pdfToText(db, bytesPath);
  } catch (err) {
    if (err instanceof PdfToolMissingError || err instanceof PdfEncryptedError) return refused(err.message);
    return refused(`could not read the PDF's text layer: ${errText(err)}`);
  }
  const textCheck = checkPdfText(text);
  if (!textCheck.ok) return refused(textCheck.reason);
  const textPath = textPathFor(bytesPath);
  await fsp.writeFile(`${textPath}.tmp-${process.pid}`, text, "utf8");
  await fsp.rename(`${textPath}.tmp-${process.pid}`, textPath);
  return finishIngest(db, print, kind, source, url, buf, { bytesPath, text, gateCtx: gateContextFor(db, print) });
}
```

Real `pdfCandidates`:

```ts
async function pdfCandidates(db: Database.Database, doc: DocumentRow, contracts: LineContract[]): Promise<TaggedCandidate[]> {
  void db;
  const text = await fsp.readFile(textPathFor(doc.bytes_path), "utf8");
  const pdfText = await seams.extractCandidates(contracts, text);
  const bytes = await fsp.readFile(doc.bytes_path);
  const pdfNative = await seams.extractCandidatesFromPdf(contracts, bytes);
  return [...tag(pdfText, doc.id, "pdfText", true, "pdf-weak"), ...tag(pdfNative, doc.id, "pdfNative", true, "pdf-weak")];
}
```

`app/api/print-watch/drop/route.ts`: delete `PDF_REJECT_MESSAGE` and the `isPdf` early return; after `ingestDocument`, `if (outcome === "refused") return NextResponse.json({ success: false, error: rejectReason ?? "refused" }, { status: 400 });`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ tests/api/print-watch-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Smoke the real poppler once (no test — a manual check)**

Run from the repo root: `printf '%%PDF-1.4\n' > /tmp/not-really.pdf && /opt/homebrew/bin/pdftotext -layout -enc UTF-8 /tmp/not-really.pdf - ; echo "exit=$?"` — expected a non-zero exit with a "Couldn't find trailer" style message, proving the binary path and flags. Then with any real earnings-release PDF from the gitignored fixtures tree (never commit it): expected form feeds separating pages in the output.

- [ ] **Step 7: Commit**

```bash
cat > /tmp/msg-b10.txt <<'EOF'
feat(print-watch): PDF road — poppler text + Claude document block as a weak pair

checkPdfBytes/checkPdfText refusals (10MB, encrypted, >60 pages, image-
only), pdftotext resolution (settings.pdftotext_path → Homebrew → /usr/
local → PATH) with a DI spawn seam, 30s kill, 2MB cap; the text persists
beside the bytes with text_sha256. Both readings carry weak_pair +
pair_note "pdf-weak" (gate pre-registered in DECISIONS.md). The drop
route now accepts PDFs; refusals are 400 with the reason.
EOF
git commit lib/print-watch/pdf.ts lib/print-watch/extract.ts lib/print-watch/watcher.ts app/api/print-watch/drop/route.ts tests/print-watch/pdf.test.ts tests/print-watch/extract.test.ts tests/print-watch/watcher.test.ts tests/api/print-watch-routes.test.ts -F /tmp/msg-b10.txt
```

---

### Task 11: Pasted-URL road — `deliverFromUrl` and `{ eventId, url }` on the drop route

**Files:**
- Create: `lib/print-watch/roads.ts`
- Modify: `app/api/print-watch/drop/route.ts`
- Test: `tests/print-watch/roads.test.ts`; extend `tests/api/print-watch-routes.test.ts`

**Interfaces:**
- Consumes: `hardenedFetchBytes`, `UrlFetchRefused`, `classifyBytes` (Task 4); `validatePublicUrl` (Task 3); `ingestDocument` (Task 9); `redactUrl` (Task 2).
- Produces (Task 12's watcher IR path reuses `RoadOutcome`; slice C's go action will call `deliverFromUrl`):

```ts
// lib/print-watch/roads.ts
export interface RoadOutcome {
  road: PrintWatchDocKind;
  outcome: IngestOutcome | "fetch_failed";
  detail: string;            // human copy; URLs already redacted
  docId: number | null;
  isNew: boolean;
}
export interface UrlRoadSeams { fetchBytes?: typeof hardenedFetchBytes; ingest?: typeof ingestDocument }
export async function deliverFromUrl(db: Database.Database, printId: number, rawUrl: string, seams?: UrlRoadSeams): Promise<RoadOutcome>;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/roads.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, listDocuments, listDocumentRoads } from "@/lib/print-watch/store";
import { _setTestSeams } from "@/lib/print-watch/watcher";
import { deliverFromUrl } from "@/lib/print-watch/roads";
import { UrlFetchRefused } from "@/lib/print-watch/url-fetch";

let db: Database.Database;
let printId: number;
let tmpRoot: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const eventId = Number(
    db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-26','ACME','k','ACME')`).run().lastInsertRowid,
  );
  printId = upsertPrint(db, eventId, "ACME", "2026-08-26", "16:05");
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roads-"));
  _setTestSeams({ storageRoot: () => tmpRoot, extractCandidates: async () => [] });
});
afterEach(() => {
  _setTestSeams(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("deliverFromUrl", () => {
  it("refuses a non-public URL before fetching", async () => {
    const fetchBytes = vi.fn();
    const out = await deliverFromUrl(db, printId, "http://ir.example/x", { fetchBytes });
    expect(out).toMatchObject({ road: "user-url", outcome: "refused", docId: null });
    expect(out.detail).toMatch(/https/);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("fetches, ingests as user-url with a redacted source/url, and reports the ingest outcome", async () => {
    const fetchBytes = vi.fn(async () => ({
      bytes: Buffer.from("ACME reports Q2 2026 results. Revenue $1.0 billion."), finalUrl: "https://ir.example/x?token=S&id=9", status: 200, contentType: "text/plain",
    }));
    const out = await deliverFromUrl(db, printId, "https://ir.example/x?token=S&id=9", { fetchBytes });
    expect(out).toMatchObject({ road: "user-url", outcome: "parsed", isNew: true });
    const [doc] = listDocuments(db, printId);
    expect(doc.kind).toBe("user-url");
    expect(doc.url).toBe("https://ir.example/x?id=9");
    expect(doc.source).toMatch(/^user-url:[0-9a-f]{16}$/); // M19: identity by hash of the full URL
    expect(listDocumentRoads(db, printId)[0].url).toBe("https://ir.example/x?id=9");
    expect(JSON.stringify(out)).not.toContain("token=S");
    expect(JSON.stringify(listDocumentRoads(db, printId))).not.toContain("token=S");
  });

  it("reports a fetch refusal (403 with the hint) as fetch_failed without a document", async () => {
    const fetchBytes = vi.fn(async () => { throw new UrlFetchRefused("t: HTTP 403 for https://wire.example/s — wire syndicators often block direct fetches — paste the company's IR-site link or the EDGAR exhibit instead", 403); });
    const out = await deliverFromUrl(db, printId, "https://wire.example/s", { fetchBytes });
    expect(out).toMatchObject({ road: "user-url", outcome: "fetch_failed", docId: null });
    expect(out.detail).toMatch(/IR-site link or the EDGAR exhibit/);
    expect(listDocuments(db, printId)).toEqual([]);
  });

  it("reports a binary body as refused", async () => {
    const fetchBytes = vi.fn(async () => ({ bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), finalUrl: "https://ir.example/z.zip", status: 200, contentType: "application/zip" }));
    const out = await deliverFromUrl(db, printId, "https://ir.example/z.zip", { fetchBytes });
    expect(out).toMatchObject({ outcome: "refused", docId: null });
    expect(out.detail).toMatch(/binary/);
  });
});
```

Add to `tests/api/print-watch-routes.test.ts` (drop describe):

```ts
  it("POST /drop with { eventId, url } takes the URL road and returns the road outcome", async () => {
    urlFetchMock.mockResolvedValueOnce({ bytes: Buffer.from(`${SYMBOL} reports Q2 2026 results.`), finalUrl: "https://ir.example/r", status: 200, contentType: "text/plain" });
    const { POST } = await import("@/app/api/print-watch/drop/route");
    const res = await POST(new NextRequest("http://localhost/api/print-watch/drop", { method: "POST", body: JSON.stringify({ eventId, url: "https://ir.example/r" }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { road: string; outcome: string; docId: number } };
    expect(body.data).toMatchObject({ road: "user-url", outcome: "parsed" });
  });

  it("POST /drop refuses a body carrying BOTH url and contentBase64, and a non-https url, with 400", async () => {
    const { POST } = await import("@/app/api/print-watch/drop/route");
    const both = await POST(new NextRequest("http://localhost/api/print-watch/drop", { method: "POST", body: JSON.stringify({ eventId, url: "https://ir.example/r", filename: "a.txt", contentBase64: "QQ==" }) }));
    expect(both.status).toBe(400);
    const http = await POST(new NextRequest("http://localhost/api/print-watch/drop", { method: "POST", body: JSON.stringify({ eventId, url: "http://ir.example/r" }) }));
    expect(http.status).toBe(400);
    expect(((await http.json()) as { error: string }).error).toMatch(/https/);
  });
```

with, at the top of the file, `const urlFetchMock = vi.hoisted(() => vi.fn());` and `vi.mock("@/lib/print-watch/url-fetch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/print-watch/url-fetch")>()), hardenedFetchBytes: urlFetchMock }));` (`SYMBOL` and `eventId` are the file's existing fixtures).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/roads.test.ts tests/api/print-watch-routes.test.ts`
Expected: FAIL — `@/lib/print-watch/roads` not found; the route ignores `url`.

- [ ] **Step 3: Implement**

`lib/print-watch/roads.ts`:

```ts
// Manual roads that start from a URL (spec §4.2 "URL"; slice C's go action
// reuses this for its pasted link). One place turns a link into a delivery
// and a human-readable outcome; every URL in the outcome is redacted.
import type Database from "better-sqlite3";
import { hardenedFetchBytes, classifyBytes, UrlFetchRefused } from "./url-fetch";
import { validatePublicUrl } from "./ssrf";
import { redactUrl } from "./hardened-fetch";
import { sha256Hex } from "./delivery";
import { ingestDocument, type IngestOutcome } from "./watcher";
import type { PrintWatchDocKind } from "./types";

export interface RoadOutcome {
  road: PrintWatchDocKind;
  outcome: IngestOutcome | "fetch_failed";
  detail: string;
  docId: number | null;
  isNew: boolean;
}

export interface UrlRoadSeams {
  fetchBytes?: typeof hardenedFetchBytes;
  ingest?: typeof ingestDocument;
}

const OUTCOME_COPY: Record<IngestOutcome, string> = {
  parsed: "fetched and parsed — the sheet has been updated",
  rejected: "fetched, but the document was refused by the issuer/period gate",
  duplicate: "fetched — this release was already in hand",
  queued: "fetched — parsing is waiting on the process that owns the watcher",
  refused: "fetched, but the body was refused",
  parse_failed: "fetched and stored, but the parse attempt failed — it will be retried",
};

export async function deliverFromUrl(
  db: Database.Database,
  printId: number,
  rawUrl: string,
  seams: UrlRoadSeams = {},
): Promise<RoadOutcome> {
  const fetchBytes = seams.fetchBytes ?? hardenedFetchBytes;
  const ingest = seams.ingest ?? ingestDocument;
  const road: PrintWatchDocKind = "user-url";

  const verdict = validatePublicUrl(rawUrl);
  if (!verdict.ok) return { road, outcome: "refused", detail: `${verdict.reason} (${redactUrl(rawUrl)})`, docId: null, isNew: false };

  let fetched;
  try {
    fetched = await fetchBytes(rawUrl, { label: "pasted link" });
  } catch (err) {
    const detail = err instanceof UrlFetchRefused ? err.message : `pasted link: ${redactUrl(rawUrl)} could not be fetched`;
    return { road, outcome: "fetch_failed", detail, docId: null, isNew: false };
  }

  const shown = redactUrl(fetched.finalUrl);
  if (classifyBytes(fetched.bytes) === "binary") {
    return { road, outcome: "refused", detail: `binary content at ${shown} — print-watch reads HTML, plain text, or PDF`, docId: null, isNew: false };
  }
  // Road identity is a hash of the FULL final URL (M19): two long links that redact
  // or truncate alike stay two roads; the redacted form is for display only.
  const roadSource = `user-url:${sha256Hex(fetched.finalUrl).slice(0, 16)}`;
  const result = await ingest(db, printId, road, roadSource, shown, fetched.bytes);
  const detail = result.rejectReason ? `${OUTCOME_COPY[result.outcome]}: ${result.rejectReason}` : OUTCOME_COPY[result.outcome];
  return { road, outcome: result.outcome, detail, docId: result.outcome === "refused" ? null : result.docId, isNew: result.isNew };
}
```

`app/api/print-watch/drop/route.ts`: the current handler validates `filename` and `contentBase64` immediately after `eventId` (lines 42–68), so a URL-only body would 400 before any branch (Codex #15). Replace that whole validation block with a discriminated-union parse performed UP FRONT, then branch on it:

```ts
type DropRequest =
  | { kind: "url"; eventId: number; url: string }
  | { kind: "file"; eventId: number; filename: string; contentBase64: string };

interface DropBody { eventId?: unknown; filename?: unknown; contentBase64?: unknown; url?: unknown }

/** Exactly one of `url` or `filename + contentBase64`; everything else is a 400 with a reason. */
function parseDropBody(body: DropBody): DropRequest | { error: string } {
  const { eventId, filename, contentBase64, url } = body;
  if (typeof eventId !== "number" || !Number.isFinite(eventId)) return { error: "Body field 'eventId' must be a number." };
  const hasUrl = typeof url === "string" && url.trim().length > 0;
  const hasFile = (typeof filename === "string" && filename.trim().length > 0) || (typeof contentBase64 === "string" && contentBase64.length > 0);
  if (hasUrl && hasFile) return { error: "Send either 'url' or a file ('filename' + 'contentBase64'), not both." };
  if (hasUrl) return { kind: "url", eventId, url: (url as string).trim() };
  if (typeof filename !== "string" || filename.trim().length === 0) return { error: "Body field 'filename' is required for a file drop (or send 'url')." };
  if (typeof contentBase64 !== "string" || contentBase64.length === 0) return { error: "Body field 'contentBase64' is required for a file drop (or send 'url')." };
  if (contentBase64.length > MAX_BASE64_LENGTH) return { error: "That file is too large to drop — print-watch accepts releases up to ~10MB." };
  return { kind: "file", eventId, filename: filename.trim(), contentBase64 };
}

export async function POST(request: NextRequest) {
  try {
    const parsed = parseDropBody((await request.json().catch(() => ({}))) as DropBody);
    if ("error" in parsed) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });

    const print = getPrintByEventId(db, parsed.eventId);
    if (!print) {
      return NextResponse.json(
        { success: false, error: `No print-watch entry for event ${parsed.eventId} — arm the event before dropping a document or pasting a link.` },
        { status: 404 },
      );
    }

    if (parsed.kind === "url") {
      const out = await deliverFromUrl(db, print.id, parsed.url);
      if (out.outcome === "refused" || out.outcome === "fetch_failed") {
        return NextResponse.json({ success: false, error: out.detail }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: out });
    }

    const buf = Buffer.from(parsed.contentBase64, "base64");
    const { docId, isNew, outcome, rejectReason } = await ingestDocument(db, print.id, "user-drop", `user-drop:${parsed.filename}`, null, buf);
    if (outcome === "refused") return NextResponse.json({ success: false, error: rejectReason ?? "refused" }, { status: 400 });
    return NextResponse.json({ success: true, data: { road: "user-drop", docId, isNew, outcome, rejectReason: rejectReason ?? null } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
```

Route tests to add alongside the two above: an empty body → 400 naming `eventId`; `{ eventId }` alone → 400 naming `filename`/`url`; `{ eventId, url: 42 }` → treated as no url → 400 naming `filename`/`url`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/roads.test.ts tests/api/print-watch-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b11.txt <<'EOF'
feat(print-watch): pasted-URL road — deliverFromUrl and { eventId, url } on /drop

Validates through the SSRF contract, fetches through hardenedFetchBytes,
classifies by magic bytes, ingests as user-url with redacted provenance,
and reports a road outcome (403 carries the IR-site/EDGAR hint).
EOF
git commit lib/print-watch/roads.ts app/api/print-watch/drop/route.ts tests/print-watch/roads.test.ts tests/api/print-watch-routes.test.ts -F /tmp/msg-b11.txt
```

---

### Task 12: Stored IR page — adapter, persisted baseline, watcher lane, `ir_baseline` step, `PUT /sources`

**Files:**
- Create: `lib/print-watch/ir-page-adapter.ts`, `lib/print-watch/ir-baseline-step.ts`, `app/api/print-watch/sources/route.ts`
- Modify: `lib/print-watch/watcher.ts` (`pollIrSource` 1215–1250, runtime creation in `ensurePrintWatch` ~803–825, `refreshCoverage`, `WatcherSeams` + `fetchBytes` seam)
- Test: `tests/print-watch/ir-page-adapter.test.ts`, `tests/print-watch/ir-baseline-step.test.ts`; extend `tests/print-watch/watcher.test.ts`, `tests/api/print-watch-routes.test.ts`

**Interfaces:**
- Consumes: `hardenedFetchBytes` with `allowHost` (Task 4); `validatePublicUrl` (Task 3); `upsertPrintWatchSource`, `getPrintWatchSource`, `deletePrintWatchSource`, `listIrSeenLinks`, `recordIrSeenLinks`, `recordIrBaseline`, `getIrBaseline`, `hasIrBaseline(db, eventId, fingerprint)` (Task 8); `PrepareStepDefinition`, `PrepareStepOutcome`, `stableHash` (Task 13's shim — this task imports the TYPES from `./registry-shim`, which Task 13 creates; do Task 13's Step 3 shim file FIRST if executing out of order, or create the shim here and let Task 13 add the merge handler).
- Produces:

```ts
// lib/print-watch/ir-page-adapter.ts
export interface IrPageConfig { symbol: string; irPageUrl: string; linkMustContain: string | null }
export const IR_PAGE_HEADLINE_RE: RegExp;
export const IR_PAGE_WIRE_HOSTS = ["businesswire.com", "globenewswire.com", "prnewswire.com", "sec.gov"] as const;
export interface IrPageLink { link: string; title: string }
export function extractIrPageLinks(html: string, baseUrl: string, cfg: IrPageConfig): IrPageLink[];
export function isAllowedIrLinkHost(link: string, irHost: string): boolean;
export async function pollIrPage(cfg: IrPageConfig, seen: Set<string>, fetchBytes: typeof hardenedFetchBytes, opts: { baseline: boolean }): Promise<IrPageLink[]>;

// lib/print-watch/ir-baseline-step.ts
export const IR_BASELINE_STEP_NAME = "ir_baseline";
export function buildIrBaselineStep(seams?: { fetchBytes?: typeof hardenedFetchBytes }): PrepareStepDefinition;
export const IR_BASELINE_STEP: PrepareStepDefinition;   // = buildIrBaselineStep()

// lib/print-watch/watcher.ts — WatcherSeams gains
  fetchBytes: typeof hardenedFetchBytes;
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/ir-page-adapter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { extractIrPageLinks, isAllowedIrLinkHost, pollIrPage, IR_PAGE_HEADLINE_RE } from "@/lib/print-watch/ir-page-adapter";

const CFG = { symbol: "ACME", irPageUrl: "https://ir.acme.example/news", linkMustContain: null };
const PAGE = `
<html><body>
<a href="/news/acme-reports-second-quarter-fiscal-2026-results">Acme Reports Second Quarter Fiscal 2026 Results</a>
<a href="https://www.businesswire.com/news/home/2026/acme-q2">Acme Announces Q2 2026 Earnings</a>
<a href="/news/acme-to-host-conference-call">Acme to Host Second Quarter Conference Call</a>
<a href="https://evil.example/acme-q2-results">Acme Q2 2026 Results (mirror)</a>
<a href="/news/acme-names-new-cfo">Acme Names New CFO</a>
</body></html>`;

describe("extractIrPageLinks", () => {
  it("keeps anchors matching the default earnings-headline pattern, resolves relative hrefs, dedupes", () => {
    const links = extractIrPageLinks(PAGE + PAGE, "https://ir.acme.example/news", CFG);
    expect(links).toEqual([
      { link: "https://ir.acme.example/news/acme-reports-second-quarter-fiscal-2026-results", title: "Acme Reports Second Quarter Fiscal 2026 Results" },
      { link: "https://www.businesswire.com/news/home/2026/acme-q2", title: "Acme Announces Q2 2026 Earnings" },
      { link: "https://evil.example/acme-q2-results", title: "Acme Q2 2026 Results (mirror)" },
    ]);
  });
  it("applies link_must_contain as a literal substring on text OR href", () => {
    expect(extractIrPageLinks(PAGE, "https://ir.acme.example/news", { ...CFG, linkMustContain: "Fiscal 2026" })).toHaveLength(1);
    expect(extractIrPageLinks(PAGE, "https://ir.acme.example/news", { ...CFG, linkMustContain: "businesswire" })).toHaveLength(1);
    expect(extractIrPageLinks(PAGE, "https://ir.acme.example/news", { ...CFG, linkMustContain: ".*" })).toHaveLength(0); // literal, not a regex
  });
  it("the default pattern needs a period word AND results/earnings", () => {
    expect(IR_PAGE_HEADLINE_RE.test("Acme Reports Fourth Quarter and Full Year 2025 Results")).toBe(true);
    expect(IR_PAGE_HEADLINE_RE.test("Acme Announces FY2026 Earnings")).toBe(true);
    expect(IR_PAGE_HEADLINE_RE.test("Acme Names New CFO")).toBe(false);
    expect(IR_PAGE_HEADLINE_RE.test("Acme to Host Second Quarter Conference Call")).toBe(false);
  });
});

describe("isAllowedIrLinkHost", () => {
  it("allows the IR host and the fixed wire hosts (any subdomain), nothing else", () => {
    expect(isAllowedIrLinkHost("https://ir.acme.example/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.businesswire.com/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.globenewswire.com/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.prnewswire.com/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://www.sec.gov/x", "ir.acme.example")).toBe(true);
    expect(isAllowedIrLinkHost("https://evil.example/x", "ir.acme.example")).toBe(false);
    expect(isAllowedIrLinkHost("https://businesswire.com.evil.example/x", "ir.acme.example")).toBe(false);
  });
});

describe("pollIrPage", () => {
  const fetchBytes = vi.fn(async () => ({ bytes: Buffer.from(PAGE), finalUrl: CFG.irPageUrl, status: 200, contentType: "text/html" }));
  it("baseline: marks every allowed matching link seen and returns nothing", async () => {
    const seen = new Set<string>();
    const out = await pollIrPage(CFG, seen, fetchBytes, { baseline: true });
    expect(out).toEqual([]);
    expect([...seen].sort()).toEqual([
      "https://ir.acme.example/news/acme-reports-second-quarter-fiscal-2026-results",
      "https://www.businesswire.com/news/home/2026/acme-q2",
    ]);
  });
  it("after the baseline: returns only new allowed links, UNMARKED (caller-owns-seen)", async () => {
    const seen = new Set(["https://www.businesswire.com/news/home/2026/acme-q2"]);
    const out = await pollIrPage(CFG, seen, fetchBytes, { baseline: false });
    expect(out.map((l) => l.link)).toEqual(["https://ir.acme.example/news/acme-reports-second-quarter-fiscal-2026-results"]);
    expect(seen.has(out[0].link)).toBe(false);
  });
});
```

`tests/print-watch/ir-baseline-step.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrintWatchSource, listIrSeenLinks, hasIrBaseline, getIrBaseline } from "@/lib/print-watch/store";
import { buildIrBaselineStep } from "@/lib/print-watch/ir-baseline-step";
import { stableHash } from "@/lib/print-watch/registry-shim";

let db: Database.Database;
let eventId: number;
const URL1 = "https://ir.acme.example/news";
const URL2 = "https://ir.acme.example/press-releases";
const PAGE = `<a href="/news/acme-q2-2026-results">Acme Reports Q2 2026 Results</a>`;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
});

describe("ir_baseline prepare step", () => {
  it("fingerprint is the hash of the configured IR page URL (null when none)", () => {
    const step = buildIrBaselineStep();
    expect(step.fingerprint(db, eventId)).toBe(stableHash([null]));
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    expect(step.fingerprint(db, eventId)).toBe(stableHash([URL1]));
  });

  it("is done-with-note when no IR page is configured, and records ONE atomic baseline (links + marker) when one is", async () => {
    const fetchBytes = vi.fn(async () => ({ bytes: Buffer.from(PAGE), finalUrl: URL1, status: 200, contentType: "text/html" }));
    const step = buildIrBaselineStep({ fetchBytes });
    await expect(step.run(db, eventId, { now: () => 0 })).resolves.toEqual({ status: "done", note: "no IR page configured" });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    await expect(step.run(db, eventId, { now: () => 0 })).resolves.toEqual({ status: "done", note: "1 link(s) baselined" });
    expect(listIrSeenLinks(db, eventId)).toEqual([{ link: "https://ir.acme.example/news/acme-q2-2026-results", baseline: true }]);
    expect(hasIrBaseline(db, eventId, stableHash([URL1]))).toBe(true);
    expect(getIrBaseline(db, eventId)).toMatchObject({ source_fingerprint: stableHash([URL1]), link_count: 1 });
    await expect(step.run(db, eventId, { now: () => 0 })).resolves.toEqual({ status: "done", note: "baseline already recorded" });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("a changed IR URL is a NEW baseline (the old marker no longer short-circuits)", async () => {
    const fetchBytes = vi.fn(async () => ({ bytes: Buffer.from(PAGE), finalUrl: URL2, status: 200, contentType: "text/html" }));
    const step = buildIrBaselineStep({ fetchBytes });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    await step.run(db, eventId, { now: () => 0 });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL2, linkMustContain: null });
    expect(hasIrBaseline(db, eventId, stableHash([URL2]))).toBe(false);
    await expect(step.run(db, eventId, { now: () => 0 })).resolves.toEqual({ status: "done", note: "1 link(s) baselined" });
    expect(getIrBaseline(db, eventId)?.source_fingerprint).toBe(stableHash([URL2]));
    expect(fetchBytes).toHaveBeenCalledTimes(2);
  });

  it("passes the IR-host allowlist into every fetch (a redirect off the IR/wire hosts is refused)", async () => {
    const fetchBytes = vi.fn(async (_url: string, opts: { allowHost?: (h: string) => boolean }) => {
      expect(opts.allowHost?.("ir.acme.example")).toBe(true);
      expect(opts.allowHost?.("www.businesswire.com")).toBe(true);
      expect(opts.allowHost?.("evil.example")).toBe(false);
      return { bytes: Buffer.from(PAGE), finalUrl: URL1, status: 200, contentType: "text/html" };
    });
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    await buildIrBaselineStep({ fetchBytes }).run(db, eventId, { now: () => 0 });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("a fetch failure is a failed attempt, not a baseline", async () => {
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: URL1, linkMustContain: null });
    const step = buildIrBaselineStep({ fetchBytes: vi.fn(async () => { throw new Error("t: HTTP 503 for https://ir.acme.example/news"); }) });
    await expect(step.run(db, eventId, { now: () => 0 })).resolves.toMatchObject({ status: "failed", error: expect.stringMatching(/503/) });
    expect(hasIrBaseline(db, eventId, stableHash([URL1]))).toBe(false);
    expect(getIrBaseline(db, eventId)).toBeNull();
  });
});
```

Add to `tests/print-watch/watcher.test.ts` (new describe `"IR page lane"`):

```ts
describe("IR page lane", () => {
  const IR_URL = "https://ir.acme.example/news";
  const FP = stableHash([IR_URL]);
  const OLD_LINK = "https://ir.acme.example/news/acme-q1-fy2026-results";
  const NEW_LINK = "https://ir.acme.example/news/acme-q2-2026-results";
  const PAGE_BEFORE = `<a href="/news/acme-q1-fy2026-results">ACME Reports First Quarter Fiscal 2026 Results</a>`;
  const PAGE_AFTER = `${PAGE_BEFORE}<a href="/news/acme-q2-2026-results">ACME Reports Q2 2026 Results</a>`;
  const RELEASE = `<html><body>ACME reports Q2 2026 results. Revenue $1,000 million.</body></html>`;
  const OLD_RELEASE = `<html><body>ACME reports first quarter fiscal 2026 results. Revenue $900 million.</body></html>`;
  const pageServer = (page: () => string) => async (url: string, opts: { allowHost?: (h: string) => boolean }) => {
    expect(opts.allowHost?.("evil.example")).toBe(false); // M17: every IR fetch carries the allowlist
    const body = url === IR_URL ? page() : url === OLD_LINK ? OLD_RELEASE : RELEASE;
    return { bytes: Buffer.from(body), finalUrl: url, status: 200, contentType: "text/html" };
  };

  it("with a step-recorded baseline, ingests only a link that appears afterwards and marks it seen after the durable outcome", async () => {
    const { eventId } = seedArmedEvent();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]); // what the ir_baseline step wrote at arm time
    let page = PAGE_BEFORE;
    fake.fetchBytes = pageServer(() => page);
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.nowMs = INSIDE_WINDOW_MS;
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    await waitUntil(() => /ok — 0 new/.test(getWatchStatus(db)[0].sources.ir ?? ""));
    expect(listDocuments(db, printId)).toEqual([]);
    page = PAGE_AFTER;
    await waitUntil(() => listDocuments(db, printId).length === 1, 5000);
    const [doc] = listDocuments(db, printId);
    expect(doc.kind).toBe("ir-page");
    expect(doc.url).toBe(NEW_LINK);
    expect(listIrSeenLinks(db, eventId).find((l) => l.link === NEW_LINK)).toEqual({ link: NEW_LINK, baseline: false });
    expect(getWatchStatus(db)[0].coverage).toContain("IR: ir.acme.example");
  });

  it("the watcher NEVER baselines: armed late with no baseline, tonight's release is fetched and the period gate drops last quarter's (M5/#6)", async () => {
    const { eventId } = seedArmedEvent();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    fake.fetchBytes = pageServer(() => PAGE_AFTER); // both links already on the page when the window opens
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.nowMs = INSIDE_WINDOW_MS;
    ensurePrintWatch(db);
    const printId = printIdFor(eventId);
    await waitUntil(() => listDocuments(db, printId).length === 2, 5000);
    const docs = listDocuments(db, printId);
    expect(docs.find((d) => d.url === NEW_LINK)).toMatchObject({ gate_verdict: "accepted" });
    const old = docs.find((d) => d.url === OLD_LINK)!;
    expect(listDocumentRoads(db, printId).find((r) => r.document_id === old.id)?.road_verdict).toBe("rejected"); // strict ir-page period check
    expect(getIrBaseline(db, eventId)).toBeNull(); // no baseline was ever written by the watcher
    expect(getWatchStatus(db)[0].sources.ir).toMatch(/no baseline/);
    expect(fake.extractCalls).toHaveLength(1); // only tonight's release parsed
  });

  it("a persisted baseline survives a restart and is never re-taken", async () => {
    const { eventId } = seedArmedEvent();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]);
    let polls = 0;
    fake.fetchBytes = async (url: string, opts: { allowHost?: (h: string) => boolean }) => {
      if (url === IR_URL) polls += 1;
      return pageServer(() => PAGE_AFTER)(url, opts);
    };
    fake.extract = async () => [candidate("revenue_q", 1000)];
    fake.nowMs = INSIDE_WINDOW_MS;
    ensurePrintWatch(db); // fresh process: runtime seeded from print_watch_ir_seen
    const printId = printIdFor(eventId);
    await waitUntil(() => listDocuments(db, printId).length === 1, 5000);
    expect(polls).toBeGreaterThanOrEqual(1);
    expect(getIrBaseline(db, eventId)).toMatchObject({ source_fingerprint: FP, link_count: 1 });
    expect(listIrSeenLinks(db, eventId).filter((l) => l.baseline)).toHaveLength(1);
  });

  it("a refused link is retried, and marked seen only after the third refusal (M17)", async () => {
    const { eventId } = seedArmedEvent();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: IR_URL, linkMustContain: null });
    recordIrBaseline(db, eventId, FP, [OLD_LINK]);
    let fetches = 0;
    fake.fetchBytes = async (url: string, opts: { allowHost?: (h: string) => boolean }) => {
      if (url === NEW_LINK) {
        fetches += 1;
        return { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), finalUrl: url, status: 200, contentType: "application/zip" }; // binary → refused
      }
      return pageServer(() => PAGE_AFTER)(url, opts);
    };
    fake.nowMs = INSIDE_WINDOW_MS;
    ensurePrintWatch(db);
    await waitUntil(() => listIrSeenLinks(db, eventId).some((l) => l.link === NEW_LINK), 8000);
    expect(fetches).toBe(3);
    expect(listDocuments(db, printIdFor(eventId))).toEqual([]);
    expect(getWatchStatus(db)[0].sources.ir).toMatch(/refused \(3\/3\)/);
  });

  it("the NVDA RSS config keeps precedence over a stored IR page", async () => {
    const { eventId } = seedArmedEvent({ symbol: "NVDA" });
    upsertPrintWatchSource(db, { symbol: "NVDA", irPageUrl: "https://nvidianews.nvidia.com/news", linkMustContain: null });
    fake.nowMs = INSIDE_WINDOW_MS;
    ensurePrintWatch(db);
    await waitUntil(() => fake.irCalls.length >= 1);
    expect(getWatchStatus(db).find((r) => r.eventId === eventId)?.coverage).toContain("RSS: NVDA IR feed");
  });

  it("follows only IR-host and wire-host links (an off-allowlist match is left alone)", async () => {
    const { eventId } = seedArmedEvent();
    upsertPrintWatchSource(db, { symbol: "ACME", irPageUrl: "https://ir.acme.example/news", linkMustContain: null });
    recordIrSeenLinks(db, eventId, [], true);
    db.prepare(`INSERT OR IGNORE INTO print_watch_ir_seen (event_id, link, baseline) VALUES (?, 'https://ir.acme.example/marker', 1)`).run(eventId);
    const fetched: string[] = [];
    fake.fetchBytes = async (url: string) => {
      fetched.push(url);
      return { bytes: Buffer.from(url.endsWith("/news") ? `<a href="https://evil.example/acme-q2-2026-results">ACME Q2 2026 Results</a>` : RELEASE), finalUrl: url, status: 200, contentType: "text/html" };
    };
    fake.nowMs = INSIDE_WINDOW_MS;
    ensurePrintWatch(db);
    await waitUntil(() => fetched.length >= 2, 3000).catch(() => {});
    expect(fetched.filter((u) => u.startsWith("https://evil.example"))).toEqual([]);
  });
});
```

(`seedArmedEvent` must accept `{ symbol }` if it does not already; `fake.fetchBytes` wires to the new `fetchBytes` seam and receives the options object so the allowlist assertion works; `fake.irCalls` is the existing RSS spy; `stableHash` is imported from `@/lib/print-watch/registry-shim`, `recordIrBaseline`/`getIrBaseline` from the store. The refusal test needs the loop's cadence sleep to be short — the file's `installSeams()` already overrides `sleep`; use a 10ms cadence there.)

Add to `tests/api/print-watch-routes.test.ts`:

```ts
describe("PUT /api/print-watch/sources", () => {
  it("upserts a stored IR page after validating the URL, and clears it on an empty url", async () => {
    const { PUT } = await import("@/app/api/print-watch/sources/route");
    const ok = await PUT(new NextRequest("http://localhost/api/print-watch/sources", { method: "PUT", body: JSON.stringify({ symbol: "acme", irPageUrl: "https://ir.acme.example/news", linkMustContain: "Results" }) }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { symbol: string; ir_page_url: string } }).data).toMatchObject({ symbol: "ACME", ir_page_url: "https://ir.acme.example/news" });
    const bad = await PUT(new NextRequest("http://localhost/api/print-watch/sources", { method: "PUT", body: JSON.stringify({ symbol: "ACME", irPageUrl: "http://ir.acme.example/news" }) }));
    expect(bad.status).toBe(400);
    const cleared = await PUT(new NextRequest("http://localhost/api/print-watch/sources", { method: "PUT", body: JSON.stringify({ symbol: "ACME", irPageUrl: "" }) }));
    expect(((await cleared.json()) as { data: { cleared: boolean } }).data.cleared).toBe(true);
    expect(getPrintWatchSource(hoisted.db, "ACME")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ir-page-adapter.test.ts tests/print-watch/ir-baseline-step.test.ts tests/print-watch/watcher.test.ts tests/api/print-watch-routes.test.ts`
Expected: FAIL — modules not found; the watcher reports `no IR feed for this symbol`.

- [ ] **Step 3: Implement**

`lib/print-watch/ir-page-adapter.ts`:

```ts
// Stored per-company IR page (spec §4.2 "Stored IR page"). The adapter READS
// the page and returns candidate links; the watcher fetches and ingests them
// and marks them seen (caller-owns-seen, as every v1 adapter). The headline
// pattern is a code constant; the user's filter is a literal substring.
import type { hardenedFetchBytes } from "./url-fetch";
import { decodeEntities } from "./representations";

export interface IrPageConfig {
  symbol: string;
  irPageUrl: string;
  linkMustContain: string | null;
}

/** A period word AND results/earnings, in either order. */
export const IR_PAGE_HEADLINE_RE =
  /(?=[\s\S]*\b(quarter|fiscal|full[- ]year|q[1-4]|fy\s?\d{2,4})\b)(?=[\s\S]*\b(results|earnings)\b)/i;

export const IR_PAGE_WIRE_HOSTS = ["businesswire.com", "globenewswire.com", "prnewswire.com", "sec.gov"] as const;

export interface IrPageLink {
  link: string;
  title: string;
}

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

export function extractIrPageLinks(html: string, baseUrl: string, cfg: IrPageConfig): IrPageLink[] {
  const out: IrPageLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = m[1].trim();
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!title) continue;
    if (cfg.linkMustContain && !title.includes(cfg.linkMustContain) && !href.includes(cfg.linkMustContain)) continue;
    if (!IR_PAGE_HEADLINE_RE.test(title)) continue;
    let link: string;
    try {
      link = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(link)) continue;
    seen.add(link);
    out.push({ link, title });
  }
  return out;
}

export function isAllowedIrLinkHost(link: string, irHost: string): boolean {
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === irHost.toLowerCase()) return true;
  return IR_PAGE_WIRE_HOSTS.some((wire) => host === wire || host.endsWith(`.${wire}`));
}

export async function pollIrPage(
  cfg: IrPageConfig,
  seen: Set<string>,
  fetchBytes: typeof hardenedFetchBytes,
  opts: { baseline: boolean },
): Promise<IrPageLink[]> {
  const page = await fetchBytes(cfg.irPageUrl, { label: "IR page" });
  const irHost = new URL(cfg.irPageUrl).hostname;
  const results: IrPageLink[] = [];
  for (const item of extractIrPageLinks(page.bytes.toString("utf8"), page.finalUrl, cfg)) {
    if (!isAllowedIrLinkHost(item.link, irHost)) continue;
    if (seen.has(item.link)) continue;
    if (opts.baseline) {
      seen.add(item.link);
      continue;
    }
    results.push(item);
  }
  return results;
}
```

`lib/print-watch/ir-baseline-step.ts`:

```ts
// The `ir_baseline` prepare step (spec §4.2): at arm time, record every link
// the stored IR page currently matches, so the window poll treats only
// LATER links as tonight's print. Keyed by event (plan M5). A late go never
// re-baselines: a recorded baseline is final for the event.
import type Database from "better-sqlite3";
import { hardenedFetchBytes } from "./url-fetch";
import { pollIrPage } from "./ir-page-adapter";
import { getPrintWatchSource, hasIrBaseline, recordIrSeenLinks } from "./store";
import { stableHash, type PrepareStepDefinition } from "./registry-shim";

export const IR_BASELINE_STEP_NAME = "ir_baseline";

function symbolOf(db: Database.Database, eventId: number): string | null {
  const row = db.prepare(`SELECT symbol FROM calendar_events WHERE id = ?`).get(eventId) as { symbol: string | null } | undefined;
  return row?.symbol ?? null;
}

export function buildIrBaselineStep(seams: { fetchBytes?: typeof hardenedFetchBytes } = {}): PrepareStepDefinition {
  const fetchBytes = seams.fetchBytes ?? hardenedFetchBytes;
  return {
    fingerprint: (db, eventId) => {
      const symbol = symbolOf(db, eventId);
      const source = symbol ? getPrintWatchSource(db, symbol) : null;
      return stableHash([source?.ir_page_url ?? null]);
    },
    run: async (db, eventId) => {
      const symbol = symbolOf(db, eventId);
      const source = symbol ? getPrintWatchSource(db, symbol) : null;
      if (!source) return { status: "done", note: "no IR page configured" };
      const fingerprint = stableHash([source.ir_page_url]);
      if (hasIrBaseline(db, eventId, fingerprint)) return { status: "done", note: "baseline already recorded" };
      const irHost = new URL(source.ir_page_url).hostname;
      const allowHost = (h: string) => isAllowedIrLinkHost(`https://${h}/`, irHost);
      const seen = new Set<string>();
      try {
        await pollIrPage(
          { symbol: source.symbol, irPageUrl: source.ir_page_url, linkMustContain: source.link_must_contain },
          seen,
          (url, opts) => fetchBytes(url, { ...opts, allowHost }),
          { baseline: true },
        );
      } catch (err) {
        return { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      // ONE transaction: the links and the completion marker (M5). An empty page is a complete baseline too.
      const n = recordIrBaseline(db, eventId, fingerprint, [...seen]);
      return { status: "done", note: `${n} link(s) baselined` };
    },
  };
}
```

(Imports: `recordIrBaseline`, `hasIrBaseline`, `getPrintWatchSource` from `./store`; `pollIrPage`, `isAllowedIrLinkHost` from `./ir-page-adapter`.)

```ts

export const IR_BASELINE_STEP: PrepareStepDefinition = buildIrBaselineStep();
```

`lib/print-watch/watcher.ts`:
- `WatcherSeams` gains `fetchBytes: typeof hardenedFetchBytes` (default `hardenedFetchBytes`).
- `PrintRuntime` gains `irRefusals: Map<string, number>` (init `new Map()`). The RSS lane keeps `irBaselineDone` (v1 behaviour, unchanged); the page lane does not use it.
- Runtime creation in `ensurePrintWatch`: `seenIrLinks: new Set(listIrSeenLinks(db, dto.eventId).map((l) => l.link))`.
- `pollIrSource` becomes:

```ts
/** A refused or thrown link retries on later polls; after this many refusals it is
 *  marked seen with the reason in the lane's note (M17). */
const IR_REFUSAL_LIMIT = 3;

async function pollIrSource(db: Database.Database, rt: PrintRuntime): Promise<void> {
  const status = statusFor(rt.printId);
  const rss = irConfigFor(rt.dto.symbol);
  if (rss) return pollIrRssSource(db, rt, rss); // the v1 body, renamed, unchanged (NVDA precedence)
  const source = getPrintWatchSource(db, rt.dto.symbol);
  if (!source) {
    status.sources.ir = "no IR page configured";
    return;
  }
  const cfg = { symbol: source.symbol, irPageUrl: source.ir_page_url, linkMustContain: source.link_must_contain };
  const irHost = new URL(cfg.irPageUrl).hostname;
  // M17: the fixed-host policy applies to the page AND to every hop of every link.
  const allowHost = (h: string) => isAllowedIrLinkHost(`https://${h}/`, irHost);
  const fetchBytes: typeof hardenedFetchBytes = (url, opts) => seams.fetchBytes(url, { ...opts, allowHost });
  try {
    await spaceHost(irHost);
    // The watcher NEVER baselines (M5): only the ir_baseline step does, before the
    // window. With no baseline every matching link is a candidate and the strict
    // ir-page period gate decides — so a late arm still fetches tonight's release.
    const baselined = hasIrBaseline(db, rt.dto.eventId, stableHash([cfg.irPageUrl]));
    const items = await withSourceTimeout("IR page poll", () => pollIrPage(cfg, rt.seenIrLinks, fetchBytes, { baseline: false }));
    let durable = 0;
    for (const item of items) {
      await spaceHost(new URL(item.link).hostname);
      let result: IngestResult;
      try {
        const fetched = await withSourceTimeout("IR link fetch", () => fetchBytes(item.link, { label: "IR page link" }));
        rt.burst = true;
        // The road records the redacted FINAL url (a hop may have moved it within the allowlist).
        result = await ingestDocument(db, rt.printId, "ir-page", `ir-page:${item.title.slice(0, 120)}`, redactUrl(fetched.finalUrl), fetched.bytes);
      } catch (err) {
        noteIrRefusal(db, rt, item.link, errText(err));
        continue;
      }
      if (result.outcome === "refused") {
        noteIrRefusal(db, rt, item.link, result.rejectReason ?? "refused");
        continue;
      }
      // Durable outcome: parsed / duplicate / rejected / queued / parse_failed all mean a row exists.
      rt.seenIrLinks.add(item.link);
      recordIrSeenLinks(db, rt.dto.eventId, [item.link], false);
      durable += 1;
    }
    status.sources.ir = `${baselined ? "ok" : "no baseline (armed late) — period gate filtering"} — ${durable} new link(s)`;
  } catch (err) {
    status.sources.ir = errText(err);
  }
}

function noteIrRefusal(db: Database.Database, rt: PrintRuntime, link: string, reason: string): void {
  const n = (rt.irRefusals.get(link) ?? 0) + 1;
  rt.irRefusals.set(link, n);
  statusFor(rt.printId).sources.ir = `link refused (${n}/${IR_REFUSAL_LIMIT}): ${reason}`;
  if (n >= IR_REFUSAL_LIMIT) {
    rt.seenIrLinks.add(link);
    recordIrSeenLinks(db, rt.dto.eventId, [link], false);
  }
}
```

(Imports: `hasIrBaseline`, `getPrintWatchSource`, `listIrSeenLinks`, `recordIrSeenLinks` from `./store`; `pollIrPage`, `isAllowedIrLinkHost` from `./ir-page-adapter`; `stableHash` from `./registry-shim` — Task 13 creates it; if Task 12 is executed first, create `registry-shim.ts` from Task 13's Step 3 as part of this task.) `refreshCoverage`: replace the `RSS: NVDA only` fallback with `getPrintWatchSource(db, rt.dto.symbol) ? \`IR: ${new URL(source.ir_page_url).hostname}\` : "IR: none configured"` (pass `db` into `refreshCoverage`, or cache the source on the runtime at creation as `rt.irSource`).

`app/api/print-watch/sources/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validatePublicUrl } from "@/lib/print-watch/ssrf";
import { upsertPrintWatchSource, deletePrintWatchSource } from "@/lib/print-watch/store";

export const dynamic = "force-dynamic";

/** PUT /api/print-watch/sources — { symbol, irPageUrl, linkMustContain? }.
 *  An empty irPageUrl clears the stored page. Human route (proxy default). */
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { symbol?: unknown; irPageUrl?: unknown; linkMustContain?: unknown };
    if (typeof body.symbol !== "string" || !body.symbol.trim()) {
      return NextResponse.json({ success: false, error: "Body field 'symbol' is required." }, { status: 400 });
    }
    if (typeof body.irPageUrl !== "string") {
      return NextResponse.json({ success: false, error: "Body field 'irPageUrl' is required (empty string clears it)." }, { status: 400 });
    }
    const symbol = body.symbol.trim().toUpperCase();
    if (body.irPageUrl.trim() === "") {
      return NextResponse.json({ success: true, data: { symbol, cleared: deletePrintWatchSource(db, symbol) } });
    }
    const verdict = validatePublicUrl(body.irPageUrl.trim());
    if (!verdict.ok) return NextResponse.json({ success: false, error: `IR page: ${verdict.reason}` }, { status: 400 });
    const linkMustContain = typeof body.linkMustContain === "string" && body.linkMustContain.trim() ? body.linkMustContain.trim() : null;
    const row = upsertPrintWatchSource(db, { symbol, irPageUrl: body.irPageUrl.trim(), linkMustContain });
    return NextResponse.json({ success: true, data: row });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ tests/api/print-watch-routes.test.ts tests/api/no-state-changing-get.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b12.txt <<'EOF'
feat(print-watch): stored IR page road — adapter, persisted baseline, ir_baseline step, PUT /sources

pollIrPage keeps anchors matching the fixed earnings-headline pattern
(plus the user's literal filter), follows only IR-host and wire-host
links, and hands back unmarked links (caller-owns-seen). The baseline
persists per event in print_watch_ir_seen (plan M5) so it survives a
restart and a late go never re-baselines. NVDA RSS keeps precedence.
EOF
git commit lib/print-watch/ir-page-adapter.ts lib/print-watch/ir-baseline-step.ts app/api/print-watch/sources/route.ts lib/print-watch/watcher.ts tests/print-watch/ir-page-adapter.test.ts tests/print-watch/ir-baseline-step.test.ts tests/print-watch/watcher.test.ts tests/api/print-watch-routes.test.ts -F /tmp/msg-b12.txt
```

---

### Task 13: Registry shim, `register.ts`, and B's event-merge handler

**Files:**
- Create: `lib/print-watch/registry-shim.ts`, `lib/print-watch/register.ts`, `lib/print-watch/merge-handler.ts`
- Modify: `lib/print-watch/watcher.ts` (call `registerPrintWatch()` at module load, after the seams block)
- Test: `tests/print-watch/registry-shim.test.ts`, `tests/print-watch/merge-handler.test.ts`

**Interfaces:**
- Consumes: store functions (Task 8), `contentVerdict`/`roadVerdict`/`gateFingerprint` (Task 5), `reconcile` (unchanged), `textPathFor` (Task 10), `IR_BASELINE_STEP` (Task 12).
- Produces — the shim reproduces slice A's contract VERBATIM (A's plan carries the identical block; `lib/earnings/event-merge.ts` and `lib/earnings/prepare-armed-event.ts` are created by A):

```ts
// ── slice A's contract, quoted verbatim ──────────────────────────────────────
// lib/earnings/event-merge.ts (created by slice A)
import type Database from "better-sqlite3";

export interface EventMergeContext {
  db: Database.Database;
  donorEventId: number;
  targetEventId: number;
}

export interface EventMergeTableResult {
  table: string;
  moved: number;
  merged: number;
  deleted: number;
  notes: string[];
}

/** SYNCHRONOUS. Runs INSIDE the caller's db.transaction (correctEarningsEventDate /
 *  reconcileEarningsDates). SQL only — no awaits, no network, no model calls. */
export type EventMergeHandler = (ctx: EventMergeContext) => EventMergeTableResult[];

/** Throws on a duplicate name. Handlers run in registration order, after A's built-in rules. */
export function registerEventMergeHandler(name: string, handler: EventMergeHandler): void;
export function listEventMergeHandlers(): string[];
export function __resetEventMergeHandlersForTests(): void;

// lib/earnings/prepare-armed-event.ts (created by slice A)
export type PrepareStepStatus = "pending" | "claimed" | "done" | "failed";

export type PrepareStepOutcome =
  | { status: "done"; note?: string }
  /** Precondition not met (e.g. TWS down). NOT an attempt: attempts is not incremented. */
  | { status: "pending"; reason: string }
  /** Counts as an attempt; retried on later ticks up to 5 attempts. */
  | { status: "failed"; error: string };

export interface PrepareStepContext {
  now: () => number;
}

export interface PrepareStepDefinition {
  /** Pure, synchronous. Hash of the step's inputs; a change resets the row to pending. */
  fingerprint: (db: Database.Database, eventId: number) => string;
  run: (db: Database.Database, eventId: number, ctx: PrepareStepContext) => Promise<PrepareStepOutcome>;
}

/** Throws on a duplicate name. */
export function registerPrepareStep(name: string, def: PrepareStepDefinition): void;
export function listPrepareSteps(): string[];
export function __resetPrepareStepsForTests(): void;

/** sha256 hex of JSON.stringify(parts). Used by every step's fingerprint. */
export function stableHash(parts: unknown[]): string;
// ── end of slice A's contract ─────────────────────────────────────────────────

// lib/print-watch/registry-shim.ts — the SAME exported names and signatures as above, in-memory, plus:
export function __shimRegistrations(): { mergeHandlers: string[]; prepareSteps: string[] };
export function __resetShimForTests(): void;

// lib/print-watch/register.ts
export function registerPrintWatch(): void;          // idempotent per process
export function __resetRegisterForTests(): void;

// lib/print-watch/merge-handler.ts
export const PRINT_WATCH_MERGE_HANDLER_NAME = "print-watch";
export function mergePrintWatchState(ctx: EventMergeContext): EventMergeTableResult[];
```

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/registry-shim.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerEventMergeHandler, registerPrepareStep, listEventMergeHandlers, listPrepareSteps, stableHash,
  __shimRegistrations, __resetShimForTests,
} from "@/lib/print-watch/registry-shim";
import { registerPrintWatch, __resetRegisterForTests } from "@/lib/print-watch/register";

beforeEach(() => {
  __resetShimForTests();
  __resetRegisterForTests();
});

describe("registry shim (slice A's contract, in-memory)", () => {
  it("registers by name, lists in order, and throws on a duplicate", () => {
    registerEventMergeHandler("a", () => []);
    registerEventMergeHandler("b", () => []);
    expect(listEventMergeHandlers()).toEqual(["a", "b"]);
    expect(() => registerEventMergeHandler("a", () => [])).toThrow(/duplicate/);
    registerPrepareStep("s", { fingerprint: () => "f", run: async () => ({ status: "done" }) });
    expect(listPrepareSteps()).toEqual(["s"]);
    expect(() => registerPrepareStep("s", { fingerprint: () => "f", run: async () => ({ status: "done" }) })).toThrow(/duplicate/);
  });
  it("stableHash is sha256 hex of the JSON of the parts", () => {
    expect(stableHash(["https://x", null])).toMatch(/^[0-9a-f]{64}$/);
    expect(stableHash(["a"])).not.toBe(stableHash(["b"]));
    expect(stableHash([1, "x"])).toBe(stableHash([1, "x"]));
  });
  it("registerPrintWatch registers exactly the print-watch merge handler and the ir_baseline step, once", () => {
    registerPrintWatch();
    registerPrintWatch();
    expect(__shimRegistrations()).toEqual({ mergeHandlers: ["print-watch"], prepareSteps: ["ir_baseline"] });
  });
});
```

`tests/print-watch/merge-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines, getSheet, getPrintByEventId, listDocuments, listDocumentRoads, listIrSeenLinks, recordIrSeenLinks, markLineAccepted } from "@/lib/print-watch/store";
import { recordDelivery } from "@/lib/print-watch/delivery";
import { mergePrintWatchState } from "@/lib/print-watch/merge-handler";
import type { PrintWatchLine, TaggedCandidate, LineContract } from "@/lib/print-watch/types";

let db: Database.Database;
let tmp: string;

function event(db: Database.Database, date: string, key: string): number {
  return Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings',?, 'ACME', ?, 'ACME')`).run(date, key).lastInsertRowid);
}
function contract(metric: string): LineContract {
  return { metric_id: metric, label: metric, definition: "t", basis: "gaap", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null };
}
function cand(metric: string, value: number, docId: number): TaggedCandidate {
  return { metric_id: metric, value, value_high: null, raw_text: String(value), snippet: `${metric} ${value}`, location_hint: null, not_disclosed: false, doc_id: docId, representation: "repB", weak_pair: false };
}
function line(metric: string, state: PrintWatchLine["state"], value: number | null, docId: number | null, cands: TaggedCandidate[]): PrintWatchLine {
  return { metric_id: metric, contract: contract(metric), expected: null, state, value, value_high: null, snippet: value === null ? null : `${metric} ${value}`, source_doc_id: docId, candidates_json: JSON.stringify(cands) };
}
function deliver(printId: number, kind: "edgar-ex99" | "user-drop" | "ir-page", text: string, eventDate: string) {
  const bytes = Buffer.from(text);
  const p = path.join(tmp, `${printId}-${kind}.txt`);
  fs.writeFileSync(p, bytes);
  return recordDelivery(db, printId, kind, `${kind}:x`, null, bytes, { bytesPath: p, text, gateCtx: { symbol: "ACME", issuerName: null, eventDate } });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("mergePrintWatchState", () => {
  it("re-homes the donor print when the target has none, and unions IR-seen rows", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const printId = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    recordIrSeenLinks(db, donor, ["https://ir.x/a"], true);
    const out = db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))();
    expect(getPrintByEventId(db, target)?.id).toBe(printId);
    expect(getPrintByEventId(db, donor)).toBeNull();
    expect(listIrSeenLinks(db, target)).toEqual([{ link: "https://ir.x/a", baseline: true }]);
    expect(out.find((r) => r.table === "print_watch_prints")).toMatchObject({ moved: 1 });
  });

  it("merges two prints: same-hash documents collapse with roads unioned, distinct ones move, lines merge losslessly, donor print deleted LAST", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const same = "ACME reports Q3 2026 results. Revenue $1,000 million.";
    const tDoc = deliver(tp, "edgar-ex99", same, "2026-08-27");
    const dDoc = deliver(dp, "user-drop", same, "2026-08-26");
    const dOnly = deliver(dp, "ir-page", "ACME reports Q3 2026 results. EPS $1.00.", "2026-08-26");
    upsertLines(db, tp, [line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)])]);
    upsertLines(db, dp, [
      line("revenue_q", "single_source", 1000, dDoc.id, [cand("revenue_q", 1000, dDoc.id)]),
      line("eps_gaap_q", "single_source", 1, dOnly.id, [cand("eps_gaap_q", 1, dOnly.id)]),
    ]);
    const out = db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))();

    expect(getPrintByEventId(db, donor)).toBeNull();
    const docs = listDocuments(db, tp);
    expect(docs.map((d) => d.id).sort()).toEqual([tDoc.id, dOnly.id].sort());
    expect(listDocumentRoads(db, tp).filter((r) => r.document_id === tDoc.id).map((r) => r.kind).sort()).toEqual(["edgar-ex99", "user-drop"]);
    const sheet = getSheet(db, tp);
    const rev = sheet.find((l) => l.metric_id === "revenue_q")!;
    expect(rev.state).toBe("single_source"); // the donor's candidate came from the SAME bytes → archived, not doubled
    expect((JSON.parse(rev.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([tDoc.id]);
    const eps = sheet.find((l) => l.metric_id === "eps_gaap_q")!;
    expect(eps).toMatchObject({ state: "single_source", value: 1, source_doc_id: dOnly.id });
    expect((db.prepare("SELECT COUNT(*) AS n FROM print_watch_candidate_archive").get() as { n: number }).n).toBe(1);
    expect(out.map((r) => r.table)).toEqual(expect.arrayContaining(["print_watch_documents", "print_watch_lines", "print_watch_prints"]));
  });

  it("two differing acceptances become a conflict with BOTH preserved in audit_json; a single-side acceptance carries over", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const tDoc = deliver(tp, "edgar-ex99", "ACME reports Q3 2026 results. Revenue $1,000 million.", "2026-08-27");
    const dDoc = deliver(dp, "user-drop", "ACME reports Q3 2026 results. Revenue $1,100 million.", "2026-08-26");
    upsertLines(db, tp, [line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)]), line("eps_gaap_q", "pending", null, null, [])]);
    upsertLines(db, dp, [line("revenue_q", "single_source", 1100, dDoc.id, [cand("revenue_q", 1100, dDoc.id)]), line("eps_gaap_q", "single_source", 2, dDoc.id, [cand("eps_gaap_q", 2, dDoc.id)])]);
    markLineAccepted(db, tp, "revenue_q");
    markLineAccepted(db, dp, "revenue_q");
    markLineAccepted(db, dp, "eps_gaap_q");
    db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))();
    const sheet = getSheet(db, tp);
    const rev = sheet.find((l) => l.metric_id === "revenue_q")!;
    expect(rev.state).toBe("conflict");
    const audit = JSON.parse(rev.audit_json ?? "{}") as { acceptances: Array<{ event_id: number; value: number }> };
    expect(audit.acceptances.map((a) => a.value).sort()).toEqual([1000, 1100]);
    const eps = sheet.find((l) => l.metric_id === "eps_gaap_q")!;
    expect(eps).toMatchObject({ state: "accepted", value: 2 });
  });

  it("is a no-op with an empty result when neither event has a print", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    expect(db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))()).toEqual([]);
  });

  it("re-home carries the target's symbol, date, and release time (Codex #3)", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, release_time) VALUES ('finnhub','earnings','2026-08-27','ACME','t','ACME','16:30')`).run().lastInsertRowid);
    upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))();
    expect(getPrintByEventId(db, target)).toMatchObject({ symbol: "ACME", event_date: "2026-08-27", release_time_et: "16:30" });
  });

  it("a moved line whose candidates were archived is re-reconciled, and existing audit trails union (Codex #3)", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const same = "ACME reports Q3 2026 results. Revenue $1,000 million.";
    const tDoc = deliver(tp, "edgar-ex99", same, "2026-08-27");
    const dDoc = deliver(dp, "user-drop", same, "2026-08-26");
    // Only the donor has an eps line, and its only evidence comes from the duplicate document.
    upsertLines(db, dp, [line("eps_gaap_q", "single_source", 1, dDoc.id, [cand("eps_gaap_q", 1, dDoc.id)])]);
    upsertLines(db, tp, [{ ...line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)]), audit_json: JSON.stringify({ acceptances: [{ event_id: 1, value: 999 }] }) }]);
    upsertLines(db, dp, [{ ...line("revenue_q", "single_source", 1000, dDoc.id, [cand("revenue_q", 1000, dDoc.id)]), audit_json: JSON.stringify({ acceptances: [{ event_id: 2, value: 998 }] }) }]);
    expect(() => db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))()).not.toThrow(); // foreign keys ON: twins deleted AFTER remap (Codex #1)
    const sheet = getSheet(db, tp);
    const eps = sheet.find((l) => l.metric_id === "eps_gaap_q")!;
    expect(eps).toMatchObject({ state: "single_source", value: 1, source_doc_id: tDoc.id }); // remapped, not orphaned
    expect((JSON.parse(eps.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([tDoc.id]);
    const rev = sheet.find((l) => l.metric_id === "revenue_q")!;
    expect((JSON.parse(rev.audit_json!) as { acceptances: Array<{ value: number }> }).acceptances.map((a) => a.value).sort()).toEqual([998, 999]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/registry-shim.test.ts tests/print-watch/merge-handler.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`lib/print-watch/registry-shim.ts`:

```ts
// Slice A's registry contract, reproduced locally so slice B never touches
// lib/earnings/* while the two slices build in parallel (plan M3). The
// post-merge integration task (Task 16) swaps every import of this module
// to the real registries and deletes it. Signatures are the contract,
// verbatim — do not "improve" them here.
import crypto from "node:crypto";
import type Database from "better-sqlite3";

export interface EventMergeContext {
  db: Database.Database;
  donorEventId: number;
  targetEventId: number;
}
export interface EventMergeTableResult {
  table: string;
  moved: number;
  merged: number;
  deleted: number;
  notes: string[];
}
export type EventMergeHandler = (ctx: EventMergeContext) => EventMergeTableResult[];

export type PrepareStepStatus = "pending" | "claimed" | "done" | "failed";
export type PrepareStepOutcome =
  | { status: "done"; note?: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; error: string };
export interface PrepareStepContext {
  now: () => number;
}
export interface PrepareStepDefinition {
  fingerprint: (db: Database.Database, eventId: number) => string;
  run: (db: Database.Database, eventId: number, ctx: PrepareStepContext) => Promise<PrepareStepOutcome>;
}

const mergeHandlers = new Map<string, EventMergeHandler>();
const prepareSteps = new Map<string, PrepareStepDefinition>();

export function registerEventMergeHandler(name: string, handler: EventMergeHandler): void {
  if (mergeHandlers.has(name)) throw new Error(`duplicate event-merge handler: ${name}`);
  mergeHandlers.set(name, handler);
}
export function listEventMergeHandlers(): string[] {
  return [...mergeHandlers.keys()];
}
export function __resetEventMergeHandlersForTests(): void {
  mergeHandlers.clear();
}

export function registerPrepareStep(name: string, def: PrepareStepDefinition): void {
  if (prepareSteps.has(name)) throw new Error(`duplicate prepare step: ${name}`);
  prepareSteps.set(name, def);
}
export function listPrepareSteps(): string[] {
  return [...prepareSteps.keys()];
}
export function __resetPrepareStepsForTests(): void {
  prepareSteps.clear();
}

export function stableHash(parts: unknown[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function __shimRegistrations(): { mergeHandlers: string[]; prepareSteps: string[] } {
  return { mergeHandlers: listEventMergeHandlers(), prepareSteps: listPrepareSteps() };
}
export function __resetShimForTests(): void {
  __resetEventMergeHandlersForTests();
  __resetPrepareStepsForTests();
}
```

`lib/print-watch/register.ts`:

```ts
// The ONLY slice-B file that names the registries (plan M3). Task 16 swaps
// the import below to "@/lib/earnings/event-merge" and
// "@/lib/earnings/prepare-armed-event" and deletes the shim.
import { registerEventMergeHandler, registerPrepareStep } from "./registry-shim";
import { mergePrintWatchState, PRINT_WATCH_MERGE_HANDLER_NAME } from "./merge-handler";
import { IR_BASELINE_STEP, IR_BASELINE_STEP_NAME } from "./ir-baseline-step";

let registered = false;

export function registerPrintWatch(): void {
  if (registered) return;
  registered = true;
  registerEventMergeHandler(PRINT_WATCH_MERGE_HANDLER_NAME, mergePrintWatchState);
  registerPrepareStep(IR_BASELINE_STEP_NAME, IR_BASELINE_STEP);
}

export function __resetRegisterForTests(): void {
  registered = false;
}
```

`lib/print-watch/merge-handler.ts`:

```ts
// B's event-merge handler (spec §4.2 "B's merge handler"): runs INSIDE slice
// A's mergeEarningsEventState, inside the calendar transaction, BEFORE the
// donor calendar_events row is deleted. SQL only, synchronous. Order matters
// with foreign keys ON (Codex #1): map documents → remap and merge lines →
// only then delete duplicate documents → move the rest → delete the donor print.
import fs from "node:fs";
import type { EventMergeContext, EventMergeTableResult } from "./registry-shim";
import { reconcile } from "./reconcile";
import { contentVerdict, roadVerdict, gateFingerprint, GATE_VERSION } from "./gate";
import { textPathFor } from "./pdf";
import { retractDocumentEvidence } from "./delivery";
import type { DocumentRow, DocumentRoadRow, ExpectedValue, LineContract, PrintWatchLine, TaggedCandidate } from "./types";

export const PRINT_WATCH_MERGE_HANDLER_NAME = "print-watch";

interface PrintRowLite { id: number; event_id: number; symbol: string; event_date: string }
interface LineRow {
  print_id: number; metric_id: string; contract_json: string; expected_json: string | null; state: string;
  value: number | null; value_high: number | null; snippet: string | null; source_doc_id: number | null;
  candidates_json: string; audit_json: string | null;
}

function result(table: string, partial: Partial<EventMergeTableResult> = {}): EventMergeTableResult {
  return { table, moved: 0, merged: 0, deleted: 0, notes: [], ...partial };
}

function readText(doc: DocumentRow): string | null {
  const p = doc.bytes_path.endsWith(".pdf") ? textPathFor(doc.bytes_path) : doc.bytes_path;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Recompute a document's content verdict and every road verdict for the TARGET event's identity. */
function reevaluate(db: EventMergeContext["db"], doc: DocumentRow, target: PrintRowLite, issuerName: string | null, notes: string[]): void {
  const text = readText(doc);
  const ctx = { symbol: target.symbol, issuerName, eventDate: target.event_date };
  if (text === null) {
    db.prepare(`UPDATE print_watch_documents SET gate_fingerprint = NULL WHERE id = ?`).run(doc.id);
    notes.push(`doc ${doc.id}: text unreadable, verdict re-evaluation deferred to next delivery`);
    return;
  }
  const content = contentVerdict(text, ctx);
  db.prepare(`UPDATE print_watch_documents SET gate_verdict = ?, gate_reason = ?, gate_version = ?, gate_fingerprint = ? WHERE id = ?`).run(
    content.ok ? "accepted" : "rejected", content.ok ? null : content.reason, GATE_VERSION, gateFingerprint(ctx), doc.id,
  );
  const roads = db.prepare(`SELECT * FROM print_watch_document_roads WHERE document_id = ?`).all(doc.id) as DocumentRoadRow[];
  for (const r of roads) {
    const v = roadVerdict(r.kind, text, ctx);
    db.prepare(`UPDATE print_watch_document_roads SET road_verdict = ?, road_reason = ? WHERE document_id = ? AND kind = ? AND source = ?`).run(
      v.ok ? "accepted" : "rejected", v.ok ? null : v.reason, r.document_id, r.kind, r.source,
    );
  }
}

export function mergePrintWatchState(ctx: EventMergeContext): EventMergeTableResult[] {
  const { db, donorEventId, targetEventId } = ctx;
  const out: EventMergeTableResult[] = [];

  // IR-seen rows are event-keyed (plan M5): union first, they cascade with the donor event.
  const irMoved = db.prepare(
    `INSERT OR IGNORE INTO print_watch_ir_seen (event_id, link, seen_at, baseline)
       SELECT ?, link, seen_at, baseline FROM print_watch_ir_seen WHERE event_id = ?`,
  ).run(targetEventId, donorEventId).changes;
  const irDeleted = db.prepare(`DELETE FROM print_watch_ir_seen WHERE event_id = ?`).run(donorEventId).changes;
  if (irMoved || irDeleted) out.push(result("print_watch_ir_seen", { moved: irMoved, deleted: irDeleted }));

  const donor = db.prepare(`SELECT id, event_id, symbol, event_date FROM print_watch_prints WHERE event_id = ?`).get(donorEventId) as PrintRowLite | undefined;
  const target = db.prepare(`SELECT id, event_id, symbol, event_date FROM print_watch_prints WHERE event_id = ?`).get(targetEventId) as PrintRowLite | undefined;
  if (!donor) return out;

  const targetEvent = db.prepare(`SELECT symbol, event_date, release_time FROM calendar_events WHERE id = ?`).get(targetEventId) as
    | { symbol: string; event_date: string; release_time: string | null }
    | undefined;

  if (!target) {
    // Re-home carries the TARGET's whole identity (Codex #3), not just the event id.
    const releaseTimeEt = targetEvent?.release_time && /^\d{2}:\d{2}$/.test(targetEvent.release_time) ? targetEvent.release_time : null;
    db.prepare(
      `UPDATE print_watch_prints SET event_id = ?, symbol = ?, event_date = ?, release_time_et = COALESCE(?, release_time_et), updated_at = datetime('now') WHERE id = ?`,
    ).run(targetEventId, targetEvent?.symbol ?? donor.symbol, targetEvent?.event_date ?? donor.event_date, releaseTimeEt, donor.id);
    // Byte paths are content-addressed and absolute; the directory names the print that
    // FIRST delivered the bytes and is never rewritten — the row is the authority.
    out.push(result("print_watch_prints", { moved: 1, notes: ["re-homed with the target event's symbol, date, and release time"] }));
    return out;
  }

  const targetLite: PrintRowLite = { ...target, symbol: targetEvent?.symbol ?? target.symbol, event_date: targetEvent?.event_date ?? target.event_date };
  const issuerName = (db.prepare(`SELECT name FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1`).get(targetLite.symbol) as { name: string | null } | undefined)?.name ?? null;

  // ── phase 1: decide the document map WITHOUT deleting anything (Codex #1: lines
  //    still reference donor documents through a non-deferrable FK) ──
  const docs = result("print_watch_documents");
  const docMap = new Map<number, number>(); // donor doc id → surviving doc id
  const twinsToDelete: DocumentRow[] = [];
  const donorDocs = db.prepare(`SELECT * FROM print_watch_documents WHERE print_id = ? ORDER BY id`).all(donor.id) as DocumentRow[];
  for (const d of donorDocs) {
    const twin = db.prepare(`SELECT * FROM print_watch_documents WHERE print_id = ? AND (sha256 = ? OR (text_sha256 IS NOT NULL AND text_sha256 = ?)) ORDER BY id LIMIT 1`).get(target.id, d.sha256, d.text_sha256) as DocumentRow | undefined;
    if (twin) {
      const roads = db.prepare(`SELECT * FROM print_watch_document_roads WHERE document_id = ?`).all(d.id) as DocumentRoadRow[];
      for (const r of roads) {
        db.prepare(
          `INSERT INTO print_watch_document_roads (document_id, kind, source, url, first_seen_at, last_seen_at, seen_count, road_verdict, road_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(document_id, kind, source) DO UPDATE SET
             seen_count = print_watch_document_roads.seen_count + excluded.seen_count,
             first_seen_at = MIN(print_watch_document_roads.first_seen_at, excluded.first_seen_at),
             last_seen_at = MAX(print_watch_document_roads.last_seen_at, excluded.last_seen_at)`,
        ).run(twin.id, r.kind, r.source, r.url, r.first_seen_at, r.last_seen_at, r.seen_count, r.road_verdict, r.road_reason);
      }
      db.prepare(`UPDATE print_watch_documents SET parsed_at = COALESCE(parsed_at, ?), parse_state = CASE WHEN parse_state = 'parsed' OR ? = 'parsed' THEN 'parsed' ELSE parse_state END WHERE id = ?`).run(d.parsed_at, d.parse_state, twin.id);
      docMap.set(d.id, twin.id);
      twinsToDelete.push(d);
      docs.merged += 1;
    } else {
      docMap.set(d.id, d.id);
      docs.moved += 1;
    }
  }

  // ── phase 2: lines — move or merge by metric_id, losslessly, with every doc id remapped ──
  const lines = result("print_watch_lines");
  const donorLines = db.prepare(`SELECT * FROM print_watch_lines WHERE print_id = ?`).all(donor.id) as LineRow[];
  const parseCands = (json: string): TaggedCandidate[] | null => {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? (parsed as TaggedCandidate[]) : null;
    } catch {
      return null;
    }
  };
  const remapCandidates = (cands: TaggedCandidate[], metric: string): TaggedCandidate[] => {
    const kept: TaggedCandidate[] = [];
    for (const c of cands) {
      const survivor = docMap.get(c.doc_id);
      if (c.doc_id === 0 || survivor === undefined || survivor === c.doc_id) {
        kept.push(c);
        continue;
      }
      db.prepare(`INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, ?, ?, ?)`).run(
        target.id, metric, JSON.stringify(c), `merged-duplicate-of:${survivor}`,
      );
    }
    return kept;
  };
  const unionAudit = (a: string | null, b: string | null, extra: unknown[] = []): string | null => {
    const read = (s: string | null): unknown[] => {
      if (!s) return [];
      try {
        const parsed = JSON.parse(s) as { acceptances?: unknown[] };
        return Array.isArray(parsed.acceptances) ? parsed.acceptances : [];
      } catch {
        return [{ unparseable: s }];
      }
    };
    const acceptances = [...read(a), ...read(b), ...extra];
    return acceptances.length === 0 ? null : JSON.stringify({ acceptances });
  };
  const reconcileLine = (metric: string, contractJson: string, expectedJson: string | null, cands: TaggedCandidate[], audit: string | null) => {
    const contract = JSON.parse(contractJson) as LineContract;
    const expected: Record<string, ExpectedValue> = {};
    if (expectedJson) expected[metric] = JSON.parse(expectedJson) as ExpectedValue;
    const [next] = reconcile([contract], expected, cands, []) as PrintWatchLine[];
    db.prepare(
      `UPDATE print_watch_lines SET state = ?, value = ?, value_high = ?, snippet = ?, source_doc_id = ?, candidates_json = ?, audit_json = ?, updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    ).run(next.state, next.value, next.value_high, next.snippet, next.source_doc_id === 0 ? null : next.source_doc_id, JSON.stringify(cands), audit, target.id, metric);
  };

  for (const dl of donorLines) {
    const donorRaw = parseCands(dl.candidates_json);
    const donorCands = donorRaw === null ? [] : remapCandidates(donorRaw, dl.metric_id);
    if (donorRaw === null) {
      db.prepare(`INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, ?, ?, ?)`).run(target.id, dl.metric_id, dl.candidates_json, "unparseable-json");
      lines.notes.push(`${dl.metric_id}: donor candidates_json unparseable — raw value archived`);
    }
    const donorSource = dl.source_doc_id !== null ? docMap.get(dl.source_doc_id) ?? dl.source_doc_id : null;
    const tl = db.prepare(`SELECT * FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`).get(target.id, dl.metric_id) as LineRow | undefined;

    if (!tl) {
      db.prepare(
        `INSERT INTO print_watch_lines (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, audit_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(target.id, dl.metric_id, dl.contract_json, dl.expected_json, dl.state, dl.value, dl.value_high, dl.snippet, donorSource, JSON.stringify(donorCands), dl.audit_json);
      // A moved line whose candidates were archived (or whose source was remapped) is
      // re-reconciled so its state never rests on evidence it no longer carries (Codex #3).
      if (dl.state !== "accepted" && (donorCands.length !== (donorRaw?.length ?? 0) || donorSource !== dl.source_doc_id)) {
        reconcileLine(dl.metric_id, dl.contract_json, dl.expected_json, donorCands, dl.audit_json);
      }
      lines.moved += 1;
      continue;
    }

    const targetCands = parseCands(tl.candidates_json) ?? [];
    const merged = [...targetCands, ...donorCands];
    const tAccepted = tl.state === "accepted";
    const dAccepted = dl.state === "accepted";
    if (tAccepted && dAccepted && (tl.value !== dl.value || tl.value_high !== dl.value_high)) {
      const audit = unionAudit(tl.audit_json, dl.audit_json, [
        { event_id: targetEventId, value: tl.value, value_high: tl.value_high, snippet: tl.snippet, source_doc_id: tl.source_doc_id },
        { event_id: donorEventId, value: dl.value, value_high: dl.value_high, snippet: dl.snippet, source_doc_id: donorSource },
      ]);
      db.prepare(`UPDATE print_watch_lines SET state = 'conflict', value = NULL, value_high = NULL, snippet = NULL, source_doc_id = NULL, candidates_json = ?, audit_json = ?, updated_at = datetime('now') WHERE print_id = ? AND metric_id = ?`)
        .run(JSON.stringify(merged), audit, target.id, tl.metric_id);
      lines.notes.push(`${tl.metric_id}: two differing acceptances → conflict, both kept in audit_json`);
    } else if (tAccepted) {
      db.prepare(`UPDATE print_watch_lines SET candidates_json = ?, audit_json = ?, updated_at = datetime('now') WHERE print_id = ? AND metric_id = ?`)
        .run(JSON.stringify(merged), unionAudit(tl.audit_json, dl.audit_json), target.id, tl.metric_id);
    } else if (dAccepted) {
      db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = ?, value_high = ?, snippet = ?, source_doc_id = ?, candidates_json = ?, audit_json = ?, updated_at = datetime('now') WHERE print_id = ? AND metric_id = ?`)
        .run(dl.value, dl.value_high, dl.snippet, donorSource, JSON.stringify(merged), unionAudit(tl.audit_json, dl.audit_json), target.id, tl.metric_id);
    } else {
      reconcileLine(tl.metric_id, tl.contract_json, tl.expected_json, merged, unionAudit(tl.audit_json, dl.audit_json));
    }
    lines.merged += 1;
  }
  db.prepare(`DELETE FROM print_watch_lines WHERE print_id = ?`).run(donor.id);
  out.push(lines);

  // ── phase 3: documents — now nothing references the twins; delete them, move the rest,
  //    and recompute every surviving verdict for the TARGET's identity ──
  for (const d of twinsToDelete) db.prepare(`DELETE FROM print_watch_documents WHERE id = ?`).run(d.id); // roads cascade (already copied)
  for (const d of donorDocs) {
    if (twinsToDelete.includes(d)) {
      const twin = db.prepare(`SELECT * FROM print_watch_documents WHERE id = ?`).get(docMap.get(d.id)!) as DocumentRow;
      const before = twin.gate_verdict;
      reevaluate(db, twin, targetLite, issuerName, docs.notes);
      const after = (db.prepare(`SELECT gate_verdict FROM print_watch_documents WHERE id = ?`).get(twin.id) as { gate_verdict: string }).gate_verdict;
      if (before === "accepted" && after === "rejected") retractDocumentEvidence(db, twin.id, "gate-rejected");
    } else {
      db.prepare(`UPDATE print_watch_documents SET print_id = ? WHERE id = ?`).run(target.id, d.id);
      const before = d.gate_verdict;
      reevaluate(db, { ...d, print_id: target.id }, targetLite, issuerName, docs.notes);
      const after = (db.prepare(`SELECT gate_verdict FROM print_watch_documents WHERE id = ?`).get(d.id) as { gate_verdict: string }).gate_verdict;
      if (before === "accepted" && after === "rejected") retractDocumentEvidence(db, d.id, "gate-rejected");
    }
  }
  out.push(docs);

  // ── the IR baseline marker unions too (M5) ──
  db.prepare(
    `INSERT OR IGNORE INTO print_watch_ir_baseline (event_id, source_fingerprint, link_count, completed_at)
       SELECT ?, source_fingerprint, link_count, completed_at FROM print_watch_ir_baseline WHERE event_id = ?`,
  ).run(targetEventId, donorEventId);
  db.prepare(`DELETE FROM print_watch_ir_baseline WHERE event_id = ?`).run(donorEventId);

  // ── the donor print row goes LAST ──
  db.prepare(`DELETE FROM print_watch_prints WHERE id = ?`).run(donor.id);
  out.push(result("print_watch_prints", { deleted: 1 }));
  return out;
}
```

(`retractDocumentEvidence` is imported from `./delivery` — M16's second call site.)

```ts
```

`lib/print-watch/watcher.ts`: after the seams block add `import { registerPrintWatch } from "./register";` and `registerPrintWatch();` at module scope (the watcher is imported by the sweep and every print-watch route, so the registrations exist wherever slice A's runner could look for them).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/`
Expected: PASS. Watch for one import-cycle trap: `register.ts` → `merge-handler.ts` → `pdf.ts`/`gate.ts` must not import `watcher.ts`; if a cycle surfaces at load, call `registerPrintWatch()` from the first line of `ensurePrintWatch`'s body and from `app/api/print-watch/ensure/route.ts` instead of at module scope.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b13.txt <<'EOF'
feat(print-watch): registry shim, registration, and the event-merge handler

registry-shim reproduces slice A's registerEventMergeHandler /
registerPrepareStep / stableHash contract in memory; register.ts is the
only file naming them. mergePrintWatchState re-homes or merges prints:
same-hash documents collapse with roads unioned and verdicts recomputed
for the target event, distinct ones move, lines merge losslessly (two
differing acceptances → conflict with both in audit_json), IR-seen rows
union, donor print deleted last.
EOF
git commit lib/print-watch/registry-shim.ts lib/print-watch/register.ts lib/print-watch/merge-handler.ts lib/print-watch/watcher.ts tests/print-watch/registry-shim.test.ts tests/print-watch/merge-handler.test.ts -F /tmp/msg-b13.txt
```

---

### Task 14: Reference doc — §Print-watch gains the v2 roads and identity model

**Files:**
- Modify: `docs/reference/earnings-pipeline.md` (§Print-watch, lines ~589–612: the `**Trigger flow.**`, `**Storage.**`, and `**Known v1 limits.**` paragraphs)

- [ ] **Step 1: Edit the three paragraphs**

Replace the drop-zone sentence in `**Trigger flow.**` with: "The drop zone (`POST /api/print-watch/drop`) is always armed and takes HTML, plain text, or PDF as a file, or a pasted `https` link (`{ eventId, url }` — validated by the SSRF contract in `lib/print-watch/ssrf.ts`, fetched by `hardenedFetchBytes` with a pinned lookup); a stored per-company IR page (`PUT /api/print-watch/sources`, `print_watch_sources`) is polled in-window with a baseline recorded at arm time in `print_watch_ir_seen` (event-keyed) by the `ir_baseline` prepare step. The NVDA RSS config keeps precedence over a stored page."

Replace `**Storage.**` with: "**Storage (v2, migration 089).** Documents dedupe on CONTENT — `UNIQUE(print_id, sha256)` — and roads are provenance rows in `print_watch_document_roads` (`kind` ∈ dj-release / edgar-ex99 / ir-page / user-drop / user-url). One transactional entry, `recordDelivery` (`lib/print-watch/delivery.ts`), computes the content verdict (the doc-to-event gate, `lib/print-watch/gate.ts`) and a per-road verdict (only `ir-page` is stricter); a document parses when the content is accepted AND at least one road is. Parse claims are compare-and-set on the row (`parse_claim_token`, 5-minute stale takeover). Bytes live under `resolveDbDir()/print-watch/<printId>/<sha256>.<html|txt|pdf>`; a PDF's poppler text sits beside it as `<sha256>.pdftext.txt` with `text_sha256` on the row. Candidates from a merged duplicate are archived in `print_watch_candidate_archive`, never dropped. Evidence survives calendar-event correction through the print-watch merge handler registered with slice A's event-merge registry."

Replace `**Known v1 limits.**` with: "**Known limits.** The PDF pair (poppler text + Claude `document` reading) is WEAK until the pre-registered holdout passes (`docs/DECISIONS.md`, 2026-09-02) — a PDF alone never greens. No OCR (image-only PDFs are refused). 8-K/A amendments not auto-ingested; corrections surface as conflicts/"superseded — re-verify", never silent flips; coverage ladder resets on server restart until the first poll; short-lived scripts that call `ensurePrintWatch` must `process.exit()`."

- [ ] **Step 2: Commit**

```bash
cat > /tmp/msg-b14.txt <<'EOF'
docs(reference): earnings-pipeline §Print-watch — v2 roads, content identity, PDF pair status
EOF
git commit docs/reference/earnings-pipeline.md -F /tmp/msg-b14.txt
```

---

### Task 15: Verification — suites, build, rehearsal on a copy, sandbox E2E, deploy

**Files:** none new. This task produces evidence, not code.

- [ ] **Step 1: The verification loop**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:changed
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build
grep -rl "089_print_watch_document_identity.ts" .next/standalone/.next/server/chunks | head -3
```

Expected: `verify:changed` green; full suite green (report the count — the baseline is 7,296 on main at `775c0ea`); `next build` clean; the grep returns at least one chunk (M1's packaging finding: the code migration is compiled into the server bundle).

- [ ] **Step 2: Rehearse 089 on a VACUUM copy of the live DB, then prove the bundled migration runs in a fresh standalone process (M18)**

```bash
N=/opt/homebrew/opt/node@24/bin
mkdir -p data/backups && sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/rehearse-089-$(date +%Y%m%d-%H%M).db'"
REPAIR_DB_PATH=data/backups/rehearse-089-<stamp>.db PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse; echo "exit=$?"
```

Expected: exit 0; read `linesChanged` — every `agreed → single_source` must be a same-bytes (or same-normalised-text) duplicate (check the two docs' roads). Any other change is a design conflict: stop and record it in the spec + DECISIONS.md before the live run.

Standalone smoke (a fresh process running the BUILT server, not `tsx`, against a disposable copy that still lacks 089):

```bash
sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/standalone-089.db'"
cd .next/standalone && DATABASE_PATH="$PWD/../../data/backups/standalone-089.db" PORT=3094 HOSTNAME=127.0.0.1 nohup env -i PATH=$N:/usr/bin:/bin DATABASE_PATH="$PWD/../../data/backups/standalone-089.db" PORT=3094 HOSTNAME=127.0.0.1 node server.js > /tmp/standalone-089.log 2>&1 & echo $! > /tmp/standalone-089.pid; cd ../..
sleep 5; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3094/login      # first request triggers the lazy migrations
sqlite3 data/backups/standalone-089.db "SELECT filename FROM schema_migrations WHERE filename LIKE '089%'"
kill "$(cat /tmp/standalone-089.pid)"
```

Expected: `200`, then `089_print_watch_document_identity.ts` — the code migration compiled into the bundle really executes. (Secretless copy: the sandbox recipe's invalid-non-empty key rule applies; never point this at the live DB.)

- [ ] **Step 3: Sandbox E2E on `:3095` (the worktree recipe)**

Follow the worktree E2E sandbox recipe (VACUUM copy + `mint-qa-session` + `DATABASE_PATH` + `APP_EXTRA_HOSTS`, `nohup env -i`, one `agent-browser`). With the 2026-09-02 SNOW documents from the gitignored fixtures tree:

1. Arm a synthetic event for today; `POST /api/print-watch/drop` with the SNOW EX-99.1 **as HTML** → `parsed`; drop the SAME bytes again as a `.txt` copy of the file → `duplicate`, one document, two roads in `GET /status`'s `documentRoads`.
2. Drop the SNOW release **as PDF** (print the IR page to PDF locally; never commit it) → `parsed`; the sheet's PDF-only lines show `single_source` with `pair_note: "pdf-weak"` on both candidates; `<sha>.pdftext.txt` exists beside `<sha>.pdf`.
3. `POST /drop` with `{ eventId, url: "https://www.sec.gov/Archives/edgar/data/.../ex99-1.htm" }` (the SNOW exhibit) → `parsed` or `duplicate` (same bytes as step 1 → `duplicate` with a third road `user-url`).
4. `POST /drop` with `{ eventId, url: "http://..." }` → 400 naming https; with a URL whose host resolves privately (e.g. `https://localhost/x`) → 400.
5. `PUT /sources` with the SNOW IR newsroom URL; confirm `GET /status` coverage carries `IR: <host>`; trigger `POST /ensure` and watch the server log for `baseline — N existing link(s) ignored`.
6. Encrypted or image-only PDF (make one with Preview → Export → encrypt) → 400 with the specific reason.

Screenshots and logs checked for private text before commit (release figures are public; the bogey column is not).

- [ ] **Step 4: Whole-branch review, merge, then the LIVE CUTOVER (M18) — 089 never runs implicitly**

Per the repo's finishing protocol: whole-branch review (`superpowers:requesting-code-review`), merge `print-v2-slice-b` to `main`, reconcile `docs/plans/TODO.md` (the deploy hook requires it). Then, in this order, with the user present:

```bash
N=/opt/homebrew/opt/node@24/bin
# 1. Quiesce every writer: quit the Vanguard Dashboard app (menu bar → Quit), stop any dev server, then prove it.
lsof data/vanguard.db; echo "expect no output"
# 2. Backup + verify.
STAMP=$(date +%Y%m%d-%H%M); sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/pre-089-$STAMP.db'"
sqlite3 "data/backups/pre-089-$STAMP.db" "PRAGMA integrity_check"      # expect: ok
# 3. Run 089 explicitly (same transaction + gates as the rehearsal; a failed gate rolls back, exit 2).
PATH=$N:$PATH npx tsx scripts/migrate-089-document-identity.ts --live; echo "exit=$?"
# 4. Read the report (documents merged, candidates archived, linesChanged) — every change must match the rehearsal's.
sqlite3 data/vanguard.db "SELECT filename FROM schema_migrations WHERE filename LIKE '089%'"
```

Only then build and install the app with the project's Electron deploy script (`npm run` target `electron:deploy`); at launch the runner sees 089 recorded and skips it — confirm in `~/Library/Logs/Vanguard Dashboard/server.log` that no migration ran and `/login` is 200. **Restore drill (documented, rehearsed once on a copy before the live run):** quit the app, `cp data/backups/pre-089-<stamp>.db data/vanguard.db`, remove `data/vanguard.db-wal`/`-shm` if present, relaunch the previous build. No git branch/worktree cleanup while the deploy builds.

---

### Task 16: Post-merge integration — swap the shim for slice A's registries and wire the composition root (run by whichever slice merges SECOND)

**Files:**
- Modify: `lib/print-watch/register.ts` (import path), `lib/print-watch/ir-baseline-step.ts` (import path), `lib/print-watch/merge-handler.ts` (type import path), `lib/print-watch/watcher.ts` (the module-scope `registerPrintWatch()` call goes; the bootstrap owns registration)
- Modify (A-owned, allowed only in THIS post-merge task): `lib/earnings/registry-bootstrap.ts` — A's composition root gains `import { registerPrintWatch } from "@/lib/print-watch/register"` and calls it inside `bootstrapEarningsRegistries()` (idempotent). A's plan already has `mergeEarningsEventState`, `enqueuePrepareSteps`, and `runPrepareSteps` call the bootstrap lazily.
- Delete: `lib/print-watch/registry-shim.ts`, `tests/print-watch/registry-shim.test.ts`
- Test: `tests/print-watch/cross-slice-registration.test.ts`

**Interfaces:**
- Consumes: `registerEventMergeHandler`, `listEventMergeHandlers`, `__resetEventMergeHandlersForTests`, `mergeEarningsEventState` from `@/lib/earnings/event-merge`; `registerPrepareStep`, `listPrepareSteps`, `__resetPrepareStepsForTests`, `stableHash`, `enqueuePrepareSteps`, `getPrepareStepRows`, `runPrepareSteps` from `@/lib/earnings/prepare-armed-event`; `bootstrapEarningsRegistries` from `@/lib/earnings/registry-bootstrap` (all created by slice A).

- [ ] **Step 1: Write the failing cross-slice test**

`tests/print-watch/cross-slice-registration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { listEventMergeHandlers, mergeEarningsEventState, __resetEventMergeHandlersForTests } from "@/lib/earnings/event-merge";
import { listPrepareSteps, enqueuePrepareSteps, getPrepareStepRows, __resetPrepareStepsForTests } from "@/lib/earnings/prepare-armed-event";
import { registerPrintWatch, __resetRegisterForTests } from "@/lib/print-watch/register";
import { upsertPrint, getPrintByEventId } from "@/lib/print-watch/store";

let db: Database.Database;
beforeEach(() => {
  __resetEventMergeHandlersForTests();
  __resetPrepareStepsForTests();
  __resetRegisterForTests();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("print-watch × slice A registries", () => {
  it("registers the merge handler and the ir_baseline step with the REAL registries", () => {
    registerPrintWatch();
    expect(listEventMergeHandlers()).toContain("print-watch");
    expect(listPrepareSteps()).toContain("ir_baseline");
  });

  it("COLD PROCESS (Codex #4): a process that never imported the watcher still runs B's handlers through A's bootstrap", async () => {
    vi.resetModules(); // fresh module registry — nothing has registered anything
    const merge = await import("@/lib/earnings/event-merge");
    const prepare = await import("@/lib/earnings/prepare-armed-event");
    const store = await import("@/lib/print-watch/store");
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    (await import("@/lib/db/migrate")).runMigrations(fresh);
    const donor = Number(fresh.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-26','ACME','d','ACME')`).run().lastInsertRowid);
    const target = Number(fresh.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-27','ACME','t','ACME')`).run().lastInsertRowid);
    const printId = store.upsertPrint(fresh, donor, "ACME", "2026-08-26", "16:05");
    fresh.transaction(() => merge.mergeEarningsEventState(fresh, donor, target))();
    expect(store.getPrintByEventId(fresh, target)?.id).toBe(printId);
    prepare.enqueuePrepareSteps(fresh, target);
    expect(prepare.getPrepareStepRows(fresh, target).map((r) => r.step)).toContain("ir_baseline");
  });
  it("a calendar merge re-homes the print through A's mergeEarningsEventState", () => {
    registerPrintWatch();
    const donor = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-26','ACME','d','ACME')`).run().lastInsertRowid);
    const target = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-27','ACME','t','ACME')`).run().lastInsertRowid);
    const printId = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(getPrintByEventId(db, target)?.id).toBe(printId);
    expect(report.handlers.map((h) => h.name)).toContain("print-watch");
  });
  it("arming enqueues the ir_baseline step alongside A's steps", () => {
    registerPrintWatch();
    const eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
    enqueuePrepareSteps(db, eventId);
    expect(getPrepareStepRows(db, eventId).map((r) => r.step)).toContain("ir_baseline");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `@/lib/earnings/event-merge` resolves (A has merged) but `registerPrintWatch` still registers into the shim: the first assertion fails.

- [ ] **Step 3: Swap the imports, wire the bootstrap, delete the shim**

In `register.ts`: `import { registerEventMergeHandler } from "@/lib/earnings/event-merge"; import { registerPrepareStep } from "@/lib/earnings/prepare-armed-event";`. In `ir-baseline-step.ts`: `import { stableHash, type PrepareStepDefinition } from "@/lib/earnings/prepare-armed-event";`. In `merge-handler.ts`: `import type { EventMergeContext, EventMergeTableResult } from "@/lib/earnings/event-merge";`. In `watcher.ts`: delete the module-scope `registerPrintWatch()` call (and its import). In A's `lib/earnings/registry-bootstrap.ts`: add `import { registerPrintWatch } from "@/lib/print-watch/register";` and call `registerPrintWatch()` inside `bootstrapEarningsRegistries()` after A's own registrations (the function is idempotent on both sides). Import direction is A → B here on purpose: `register.ts` imports only the registry modules' `register*` functions, and those modules do not import the bootstrap at module scope, so there is no evaluation cycle. Delete `lib/print-watch/registry-shim.ts` and `tests/print-watch/registry-shim.test.ts`; move that file's "registers exactly … once" assertion into the cross-slice test using `listEventMergeHandlers()` / `listPrepareSteps()`.

- [ ] **Step 4: Run the suite** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ tests/earnings/` — expected PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-b16.txt <<'EOF'
feat(print-watch): register with slice A's real registries; retire the shim

Cross-slice test: the merge handler runs inside mergeEarningsEventState
and ir_baseline is enqueued by arm. Whichever slice merged second lands
this (plan M3).
EOF
git rm --quiet lib/print-watch/registry-shim.ts tests/print-watch/registry-shim.test.ts
git commit lib/print-watch/register.ts lib/print-watch/ir-baseline-step.ts lib/print-watch/merge-handler.ts lib/print-watch/watcher.ts lib/earnings/registry-bootstrap.ts tests/print-watch/cross-slice-registration.test.ts lib/print-watch/registry-shim.ts tests/print-watch/registry-shim.test.ts -F /tmp/msg-b16.txt
```

---

## Self-review (run after writing; findings fixed inline)

**Spec coverage (§4.2, every sentence):** identity `UNIQUE(print_id, sha256)` + document columns → Tasks 6/8; roads table + `kind` values incl. `user-url` → Tasks 6/8; `recordDelivery` one transaction, upsert doc with `last_seen_at`, upsert road with verdict, re-evaluate gate on fingerprint change, eligibility = content AND ≥1 road, `{ id, isNew, needsParse }`, stricter road never blocks, IR-only stays rejected → Task 8 (+ Task 9 test); parse claims CAS → Tasks 8/9; migration mechanism `.ts` with `up(db)`, ordered with `.sql`, same transaction, mixed-sequence + rollback test → Task 1; rebuild order (1)–(11), archive, `foreign_key_check`, reconciler re-run with per-line log, invariants, injected-failure tests, VACUUM rehearsal with reconciled-state diff → Tasks 6/7/15; PDF acceptance, `.pdf`, encrypted/10MB/60-page/500-char refusals, `pdfText` via `pdftotext -layout` with the resolution order, DI spawn, 30s kill, 2MB cap, persisted `<sha>.pdftext.txt` + `text_sha256`, `pdfNative` document block, `weak_pair`/`pair_note`, pre-registered gate in DECISIONS.md, gate on `pdfText`, poppler-missing message → Task 10; URL: `{ eventId, url }`, `hardenedFetchBytes` with pinned lookup (M2), https/no credentials/443/A+AAAA/routability/3 hops revalidated/20s shared budget/10MB cap/magic bytes/`redactUrl` everywhere/legacy URL sanitisation/403 hint → Tasks 2/3/4/6/11; stored IR page table, literal filter, adapter `pollIrPage(cfg, seen, fetchFn, { baseline })` returning `{ link, title }`, wire-host allowlist, `ir_baseline` step with fingerprint = hash(url), `print_watch_ir_seen` (event-keyed, M5), late go never re-baselines, NVDA RSS precedence → Task 12; B's merge handler (prints re-home; documents by sha with roads union + verdicts recomputed; IR-seen union; lossless lines with conflict + audit; donor deleted last) → Task 13. §5 (089 contents) → Task 6. §6 (`drop` adds `url`; `PUT /sources`; status pure read) → Tasks 11/12/9. §7 failure modes (poppler/encrypted/image-only/oversize; IR shape change → the `ok — 0 new link(s)` note; SSRF/403/binary reasons) → Tasks 10/12/11. §8 B-line: every listed test maps to a task above (runner rollback T1; phases with injected failures T6; archive invariant T6; duplicate-only agreed → single_source T6; `recordDelivery` atomic T8; content-plus-road with stricter road first T8/T9; PDF readings/weak pair/refusals/persisted text T10; every SSRF rule, pinned lookup, abort closes the socket, binary rejection, `redactUrl` on every error path, legacy sanitisation T3/T4/T2/T6; IR literal filter, default pattern, allowlist, persisted baseline across restart, late go T12; lossless line rule T13). **Gap found and fixed:** "agent closed" in §8 has no undici agent under M2 — the equivalent assertion is `req.destroy()` on abort (Task 4 test); recorded under M2.

**Placeholder scan:** the only deliberate stubs are the two one-line functions in Task 9 (`ingestPdf`, `pdfCandidates`) that Task 10 replaces the same day; both are named as such. No "TBD", no "add validation", no "similar to Task N" without the code repeated.

**Post-Codex consistency pass (round 1 folded in):** `DeliveryInput` is `{ bytesPath, text, gateCtx }` everywhere (the `textSha256` field is gone — `recordDelivery` computes `text_sha256` itself, Tasks 8/9/10/13 and every test helper); `DeliveryResult` gained `matchedBy`; `IngestOutcome` includes `parse_failed` in Tasks 9/11/12 (`OUTCOME_COPY` covers it); `hasIrBaseline(db, eventId, fingerprint)` / `recordIrBaseline` / `getIrBaseline` are the only baseline API in Tasks 8/12/13 (the `#baseline-empty` marker link is gone); `finalizeDocumentParse` takes the error as its fifth argument in Tasks 8/9; `parseEligible` reads `doc.parse_attempts`; `hardenedFetchBytes` accepts `allowHost` in Tasks 4/12; the merge handler's phase order (map → lines → delete twins → move → re-evaluate → baseline union → donor print) matches its test; `retractDocumentEvidence` is called from `recordDelivery` (two triggers) and from the merge handler; the runner script is `scripts/migrate-089-document-identity.ts` in Tasks 7/15 and the File Structure.

**Type consistency:** `recordDelivery(db, printId, kind, source, url, bytes, input)` and `DeliveryResult` fields (`id, isNew, needsParse, eligible, contentVerdict, roadVerdict, parseState, matchedBy`) are used identically in Tasks 8, 9, 11, 13; `finishIngest`'s `DeliveryInput` import is from `./delivery`; `IngestOutcome` includes `refused` in Tasks 9/11; `PrepareStepDefinition`/`stableHash` come from `./registry-shim` in Tasks 12/13 and from `@/lib/earnings/prepare-armed-event` after Task 16; `textPathFor` is defined in Task 10 and used in Tasks 10/13; `hasIrBaseline`/`recordIrSeenLinks`/`listIrSeenLinks` signatures match across Tasks 8/12/13; `listParseQueue`/`hasParsableDocuments`/`claimDocumentParse`/`finalizeDocumentParse` match across Tasks 8/9. `tag(candidates, docId, representation, weakPair, pairNote?)` — fifth parameter introduced in Task 9 and used in Task 10.
