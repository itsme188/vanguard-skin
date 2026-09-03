# Live print v2 — design

**Date:** 2026-09-02 (rev 4, after Codex rounds 1 to 3; no further design rounds by user ruling)
**Status:** user review, then one `writing-plans` pass per slice (§10), each plan with one Codex round
**Extends** `docs/superpowers/specs/2026-08-20-live-print-watch-design.md` (v1). v1 rulings stand unless restated here; where the shipped v1 code fell short of the v1 spec (document identity, IR adapter, global scheduler), this design closes the gap rather than adding a second mechanism.

## 1. Why now

Two live runs of print-watch v1 are on record. The first (2026-08-26/27, three prints) captured every release at the wire minute. The second (2026-09-02, one print) missed the release on both automatic lanes and was recovered by a manual drop from a Claude Code session, twenty-five minutes after the wire. The user ran the trade entirely outside the app. The post-mortem found:

1. The name was a same-day manual add, not held and not watchlisted. Every automatic earnings behaviour keys on `getSymbolStatus` returning `held` or `watchlist`, so the newsletter bogey scan never looked at it, and the security row had no IBKR contract id, which turned the Dow Jones wire lane off. (Contract-id backfill landed 2026-09-02, `f691229`.)
2. The EDGAR lane parsed the SEC feed's acceptance time as UTC; the feed reports fresh filings as Eastern wall-clock with a bogus `Z` and normalises them to true UTC later. (Fixed 2026-09-02, `6628dd4`; the filing header is now authoritative.)
3. The drop zone accepts HTML and text only. PDF has been the user's top ask since the first live run (TODO 2026-08-27, ask (a); deferred 2026-08-28 to a feature session that did not happen).
4. Nothing happens on screen, on paper, or by email at the moment the sheet fills. The only instant surface is a panel the user must already be watching; the push rides a 10-minute Finnhub poll and the recap rides a 15-minute sweep tick.
5. The sheet had no line for the metric the name is actually traded on (product-revenue guidance), because contract lines derive only from structured bogey fields.

## 2. Rulings (user, 2026-09-02 session)

- Arming a worksheet means "I care about this print". It is the coverage signal.
- PDF drop ships. URL drop ships and is the preferred manual road. Both a stored per-company IR page the watcher scans and a paste box for the exact link or file.
- A user-triggered "print is live" action acquires from every road at once and starts processing.
- The first output is the on-screen first-pass read. Paper and email are buttons pressed afterwards, never automatic.
- Push notifications are unchanged this session: the push-at-print gate keeps its held, watchlist, or live read-through rule on both the Mac and the Worker.
- Cloud parity: armed coverage reaches the Worker fallback now, through a snapshot version bump, an immediate delta on mutation, and the affected mirrors.
- PDF pair: the poppler-text and Claude-native readings of one PDF are a weak pair until a pre-registered PDF holdout passes the v1 green-precision gate. Until then PDF-only lines render in verify styling, never green.
- Finnhub EPS consensus is shown labelled "vendor, basis unspecified" and never fills the adjusted-EPS expected value; Finnhub revenue consensus is the revenue bogey.
- Callouts render single-source after mechanical verification, with a per-callout accept control; two independent documents are not required (wire copy and EDGAR exhibit are the same bytes).
- The work ships as six independently deployable slices (§10); slices A and B are built first, in parallel, and must not share a file.
- Design rounds end at three; residual mechanics are settled in each slice's plan review.
- Today: Alerts and Nearby Levels leave the page. Significant Moves and Momentum Pulse move to Analysis. The Earnings Cockpit folds into the Earnings Hub rows as chips. The print-watch card becomes the armed Hub row's in-place expansion. Portfolio snapshot shrinks to one line. Week Ahead, Releases, IBKR today, and the chat button stay.
- *(Plan-round rulings, 2026-09-02 late evening.)* Slice A stores the Finnhub EPS in its own column `earnings_bogeys.eps_consensus_vendor` and leaves `eps_consensus` NULL on the `'finnhub'` row; the `eps_consensus_basis` column in §4.1 step 2 / §5 088 is NOT added. Reason: `compileContracts` (a slice B/F file) fills the adjusted-EPS expected value from the first non-null `eps_consensus`, and A and B share no file — the ruling "Finnhub EPS never fills the adjusted-EPS bogey" holds by construction. Slice B keeps v1's independence rule: a Dow Jones stitched text and an EDGAR exhibit of one release remain two independent documents (content identity already collapses byte-identical deliveries); reconciler correlation groups are not added.

## 3. Goals and non-goals

**Goals.** (a) An armed event gets what a held name's event gets, automatically, from the moment it is armed, on the Mac and in the cloud fallback. (b) A release reaches the sheet by PDF, by pasted link, by a stored IR page, by the wire, or by EDGAR, whichever lands first, and identical bytes are counted once no matter how many roads deliver them. (c) Within seconds of the first parse the user sees a first-pass read against their own bogeys, on screen, inside Today, with every number computed deterministically and every quoted figure verified against stored text. (d) Paper and recap are one click each. (e) Today has one earnings surface.

**Non-goals (this session).** Push composer or push-gate changes. Unattended promotion (the v1 ruling that the user is the gate stands; the statistical corpus gate remains stage 2). Recap timing policy (ask (f)). Learned per-company line shapes (ask (d)); a manual extra-metrics field covers the immediate need. OCR for image-only PDFs (explicit refusal instead).

## 4. Design

### 4.1 Coverage (slice A): armed is an event fact; `armed` status is display-only

**Two questions, two answers.** Every consumer that evaluates a specific event asks `isEventArmed(db, eventId)`: a flag row exists for that event id. `SymbolStatus` gains `armed` purely for symbol-level display and for symbol-only tasks with no event in hand: the symbol has an unsuperseded earnings event with `event_date` in `[todayET(), todayET() + 14 days]` carrying a flag. Precedence for display: `held` > `watchlist` > `armed` > `neither`; the resolver returns the reason set `{ held, watchlist, armed }`. Every modified consumer derives its dates through `todayET()` and the ET helpers in `lib/calendar/date-utils.ts`; slice A also replaces the UTC `toISOString().slice(0, 10)` day math inside `findEmailCandidates` (`lib/calendar/enrichment-runner.ts`) with those helpers, after a test proves the offset shifts a candidate window after 20:00 ET.

**Consumer matrix, rebuilt from the call sites.** `coveredForEvent(db, symbol, eventId)` = held or watchlist (family-aware, as today) or `isEventArmed(eventId)`.

| Call site | Effect today | v2 | Mirror |
|---|---|---|---|
| `lib/calendar/enrichment-runner.ts:849` `findEmailCandidates` (preview, recap, reporter candidates) | selection: held/watchlist | selection: coveredForEvent | Worker `fallback-earnings.ts` candidate filters (two sites) read the effective event collection (below) |
| `lib/earnings/extract-newsletter-bogeys.ts:279` bogey scan | selection: held/watchlist | selection: coveredForEvent | Mac only |
| `lib/earnings/bogeys-reminder.ts:65` | selection | selection: coveredForEvent | Mac only |
| `lib/calendar/verify-earnings-dates.ts:136` | selection (manual rows skipped) | selection: coveredForEvent | Mac only |
| `lib/calendar/wire-probe.ts:69` | selection | selection: coveredForEvent | Mac only |
| `lib/earnings/wrap.ts:99` | selection | selection: coveredForEvent | Worker wrap path |
| `lib/earnings/debrief.ts:131` | selection | selection: coveredForEvent | Worker debrief path, if present |
| `lib/digest/todays-reporters.ts:65` | display only (chip; rows are not filtered by status) | display: `armed` chip | Worker `todays-reporters.ts` chip |
| `lib/calendar/enrichment-runner.ts:504`, `lib/calendar/cloud-reconcile.ts:237` push gates | held/watchlist/read-through | **unchanged** | Worker `calendar-enrich.ts` unchanged |
| `lib/alerts/read-through-push.ts:34` | target ownership | **unchanged** | — |
| `lib/digest/call-transcripts.ts:251`, `lib/transcripts/same-day.ts:287` | selection, symbol only | symbol `armed` counts (no event in hand) | Mac only |
| `lib/queries/earnings-cockpit.ts:140`, `app/dashboard/today/EarningsHub.tsx:100` | display | `armed` chip | — |

A repo guard test asserts every `getSymbolStatus` and `isEventArmed` consumer appears in an allowlist naming its effect (selection-covered, symbol-armed, unchanged, display).

**Cloud: effective event collection, outbox, generations.** A same-day manual add is absent from the nightly snapshot's `calendarEvents`, so an armed marker alone cannot make it eligible in the cloud. Slice A therefore:

- Adds a local table `cloud_outbox` `(id, kind, generation, payload_json, written_at, sent_at, send_error)`. The arm, disarm, manual-add, manual-edit, and date-correction mutations insert, inside their own transaction, one `armed-events` row with `generation = (SELECT COALESCE(MAX(generation), 0) + 1 FROM cloud_outbox WHERE kind = 'armed-events')` and a payload that is the **full current list** of armed events, each entry a complete minimal projection: `{ eventId, symbol, eventDate, eventTime, releaseTime, sourceKey, source, consensusValue, expectedImpact, securityId, epsConsensusBasis, removed }`, with `removed: true` entries retained for events disarmed since the last snapshot.
- A sender (the sweep tick, plus an immediate post-commit attempt) drains unsent rows in generation order and writes KV key `armed-events` = `{ generation, entries }` only after reading the current KV value and confirming its generation is lower; an out-of-order completion therefore never regresses the key. The row is marked `sent_at` on success; failures retry on the next tick.
- The snapshot builder reads everything inside one `BEGIN` read transaction and records `armedGeneration` = the outbox maximum at that read. Snapshot v11 carries `armedEvents` (same projection) and `epsConsensusBasis` per bogey row.
- The Worker gains one shared resolver `effectiveCalendarEvents(snapshot, delta)`: start from `snapshot.calendarEvents`; when `delta.generation > snapshot.armedGeneration`, apply entries by `eventId` (add or replace projection; `removed` deletes); every Worker consumer in the matrix reads from this resolver, never from the raw snapshot. Snapshots ≤ v10 ignore the delta and degrade to held-plus-watchlist. The push gate is not touched. Parity tests: an armed-only event added after the snapshot reaches the Worker's preview candidate set; a tombstone removes it; a stale delta (generation ≤ snapshot) is ignored; v10 degrades.

**Correction survival: merge registry (A) with per-slice handlers.** `earnings_worksheet_flags.event_id` cascades on delete, and `correctEarningsEventDate` today repoints bogeys, emails, and skips with `UPDATE OR IGNORE`. Slice A adds `mergeEarningsEventState(db, donorEventId, targetEventId)` in `lib/earnings/event-merge.ts`, called inside the transactions of `correctEarningsEventDate` and `reconcileEarningsDates`, with a registry: `registerEventMergeHandler(name, fn)`. A implements the handlers for the tables it owns; later slices register handlers for theirs when their modules load (B: prints, documents, roads, lines, IR-seen; C: go requests; D: reads, callouts). The merge matrix A specifies and tests:

| Table | Rule |
|---|---|
| `earnings_worksheet_flags` | target keeps its row if present; `printed_at` = the non-null value from either side (a donor print must not re-print); donor row deleted |
| `earnings_prepare_steps` | per step: if fingerprints equal, keep the more advanced status; if they differ, reset to `pending` with attempts 0 (the target's inputs are authoritative) |
| `earnings_bogey_scans` | terminal precedence `hit` > `no_numbers` > `error` > `claimed`; never `DO NOTHING` a donor `hit` away |
| `earnings_bogeys` | existing `UPDATE OR IGNORE` repoint kept, plus: on a `(source, source_label)` collision the row with the newer `uploaded_at` wins field-by-field where the other is null |
| `earnings_emails`, `earnings_email_skips` | existing repoint rules kept unchanged (delivery state is never merged; a sent phase on either side counts as sent for the target, so nothing refires) |
| `cloud_outbox` | a new `armed-events` row is written after the merge |

Handlers registered by later slices follow the same shape and carry their own tests; B's line rule is stated in §4.2.

**Prepare work table.** `armWorksheet` stays a pure mutation. Arming inserts the A-owned steps into `earnings_prepare_steps` `(event_id, step) PK, status: pending | claimed | done | failed, input_fingerprint, claim_token, claimed_at, attempts, last_error, updated_at`: `newsletter_rescan`, `consensus_row`, `intel`, `con_id`. Later slices register additional steps through `registerPrepareStep(name, { fingerprint, run })` (B registers `ir_baseline`). Rules: a run first claims with a fresh token (`UPDATE … SET status='claimed', claim_token=?, claimed_at=now WHERE status IN ('pending','failed') OR (status='claimed' AND claimed_at < now − 5min)`); finalisation is compare-and-set (`UPDATE … SET status=?, … WHERE event_id=? AND step=? AND claim_token=?`), so a timed-out worker can never overwrite its successor; when a step's current fingerprint differs from `input_fingerprint`, status and attempts reset atomically and the step re-runs; `failed` retries up to five attempts. The worksheet route runs the pass once after arm; the earnings sweep re-runs every runnable step each tick until the event. Fingerprints: `newsletter_rescan` = hash(eventId, symbol, sinceDays, extractor version); `consensus_row` = hash(consensus fields on the event); `intel` = hash(symbol, eventDate, releaseTime); `con_id` = hash(securityId, current `ib_con_id`).

Steps:

1. `newsletter_rescan`: a pure per-article path `extractBogeysFromArticleForEvent(db, article, event)` that shares the prompt and parser with the existing extractor but never touches `research_articles.bogeys_scanned_at`. Candidates are articles from the last 14 days whose text mentions the symbol (`isSymbolMentioned`). Ledger `earnings_bogey_scans` `(event_id, article_id, extractor_version) PK, status: claimed | hit | no_numbers | error, claim_token, model_id, attempts, scanned_at`: inserted `claimed` before the model call, finalised by compare-and-set after; a crash between leaves a stale claim taken over on the next run (at most one extra call per crash, bounded by attempts ≤ 3). Attribution is deterministic because the bogey `source_label` carries the issue date as the existing extractor already does ("<source> <M/D>"), so two issues of one newsletter are two rows and never overwrite each other.
2. `consensus_row`: when the event carries Finnhub consensus, upsert one bogey row keyed `(event_id, 'finnhub', 'Sell-side consensus (Finnhub)')` with `revenue_consensus_usd`, `eps_consensus`, `eps_consensus_basis = 'vendor_unspecified'`. `compileContracts` uses the revenue value as the revenue expected value and never sets the adjusted-EPS expected value from an unspecified-basis row. Every surface that shows the EPS figure labels it.
3. `intel`: `refreshEarningsIntel(db, eventId)`.
4. `con_id`: `enrichSecurities(db, [securityId])` when `ib_con_id` is null and TWS is up; stays `pending` while TWS is down.

### 4.2 Acquisition roads and document identity (slice B)

**Identity and eligibility.** Documents dedupe on content: `UNIQUE(print_id, sha256)`. The document row gains `last_seen_at, gate_verdict: accepted | rejected, gate_reason, gate_version, gate_fingerprint, parse_state: queued | claimed | parsed | failed, parse_claim_token, parse_claimed_at, text_sha256`. Roads are provenance: `print_watch_document_roads` `(document_id, kind, source) PK, url, first_seen_at, last_seen_at, seen_count, road_verdict: accepted | rejected, road_reason`. `kind` values: existing `dj-release`, `edgar-ex99`, `ir-page`, `user-drop`, plus `user-url`. One store function `recordDelivery(db, printId, kind, source, url, bytes)` runs in a single transaction: upsert the document (`INSERT … ON CONFLICT(print_id, sha256) DO UPDATE SET last_seen_at = excluded.last_seen_at RETURNING id, gate_verdict, parse_state`), upsert the road with its road verdict, evaluate or re-evaluate the content gate when `gate_fingerprint` (hash of gate version plus the event's identity fields) differs, and decide the requeue: a document is parse-eligible when its content verdict is accepted **and** at least one road verdict is accepted; the function returns `{ id, isNew, needsParse }`, and only `needsParse` moves `parse_state` to `queued`. A stricter road (the IR period check) rejecting bytes that another road later accepts therefore never blocks the parse, while an IR-only delivery that fails the period check stays rejected. Parse claims are compare-and-set like prepare steps.

**Migration mechanism.** The runner (`lib/db/migrate.ts`) executes `.sql` files through `db.exec` in one transaction and has no code phase. Slice B extends it minimally: a migration may be `NNN_name.ts` exporting `up(db: Database.Database): void`, discovered and ordered with the `.sql` files by number and run inside the same transaction; the runner change is unit-tested with a mixed sequence and a throwing `.ts` migration that must roll back. The documents rebuild is `089_print_watch_document_identity.ts`.

**Rebuild order** (foreign keys on, one transaction): (1) create `print_watch_documents_new`; (2) copy rows, deduping same-hash rows per print into the lowest id, building an old-id → survivor-id map in a temp table; (3) seed `print_watch_document_roads` from every old row; (4) create `print_watch_lines_new` referencing the new parent, with the `state` CHECK widened by `retired`; (5) copy lines remapping `source_doc_id`; for `candidates_json`, candidates whose `doc_id` maps to a survivor different from their own are **archived** to `print_watch_candidate_archive` `(line_id, candidate_json, archived_at)` and removed, so no line carries two candidates from one content hash; (6) drop `print_watch_lines`; (7) drop `print_watch_documents`; (8) rename both; (9) recreate indexes; (10) `PRAGMA foreign_key_check` must return no rows; (11) re-run the reconciler over every affected line, so a line that was `agreed` only because identical bytes arrived twice becomes the honest `single_source`, with the change logged per line. Invariant asserted before and after: every original candidate is either present with a remapped `doc_id` or archived; every surviving document's bytes exist on disk. Injected-failure tests at each phase assert rollback. Rehearsed on a VACUUM copy of the live DB, with the reconciled-state diff reviewed before the live run.

**PDF.** `ingestDocument` accepts a `%PDF-` buffer. Stored as `.pdf`. Before parsing: reject encrypted PDFs, PDFs over 10MB or 60 pages, and PDFs whose text layer is under 500 characters, each with its own message. Two representations:

- `pdfText`: `pdftotext -layout`. Resolution order: `settings.pdftotext_path`, `/opt/homebrew/bin/pdftotext`, `/usr/local/bin/pdftotext`, `PATH`. DI spawn seam, 30-second timeout with the child killed on timeout, output capped at the 2MB document ceiling, persisted beside the bytes as `<sha>.pdftext.txt` with `text_sha256` on the document row.
- `pdfNative`: the extraction prompt sent with the PDF as a Claude `document` block (the `lib/research-documents/extract.ts` path). `extractCandidates` gains `{ kind: "pdf", bytes }`; prompt and parser unchanged.

Both candidates carry `weak_pair = true` and `pair_note = 'pdf-weak'`, so a PDF alone renders "agreed (PDF), verify" and never green. **Pre-registered gate**, recorded in `DECISIONS.md` before measurement: a frozen holdout of at least 50 releases as PDFs with at least 500 hand-labelled lines from the gitignored fixtures tree, green precision ≥ 99% with zero catastrophic errors (v1 §2); only a passing measurement flips the pair. The doc-to-event gate runs on `pdfText`. Poppler missing → refused naming the tool and the setting.

**URL.** `POST /api/print-watch/drop` accepts `{ eventId, url }`. `hardenedFetchBytes` (new beside `hardenedFetchText`) builds a per-request undici `Agent` whose `connect.lookup` returns only the pre-validated address, and closes that agent in `finally`: `https` only, no credentials, port 443 only, A and AAAA resolved, every address globally routable (rejecting loopback, RFC1918, link-local, ULA, IPv4-mapped, multicast, cloud-metadata ranges); each redirect hop (max 3) repeats the full validation with a fresh pinned lookup; one `AbortController` with a 20-second budget shared across hops; response capped at 10MB while streaming; type by magic bytes (`%PDF-`, `<html`/`<!doctype`, else text only if the first 4KB contain no NUL and under 2% control bytes, otherwise refused as binary). `redactUrl(url)` (strips query parameters named `token|sig|signature|key|auth|session|access` and truncates to 200 characters) is the only way a URL is rendered into an error message, a road row, a log line, or the panel; the existing `hardenedFetchText` error strings switch to it; B's migration sanitises legacy stored URLs. A 403 from a wire syndicator is reported with the hint to paste the IR-site link or the EDGAR exhibit.

**Stored IR page.** `print_watch_sources` `symbol TEXT PRIMARY KEY, ir_page_url, link_must_contain TEXT NULL, created_at, updated_at`; `link_must_contain` is a literal substring. Set from the "IR page" field on the armed Hub row. Adapter `lib/print-watch/ir-page-adapter.ts::pollIrPage(cfg, seen, fetchFn, { baseline })`: fetch through `hardenedFetchBytes`, collect anchors, keep those whose text or href contains the literal (when set) and matches the fixed default earnings-headline pattern (a code constant), resolve relative hrefs, return `{ link, title }`. The watcher follows new items whose host is the IR host or one of `businesswire.com`, `globenewswire.com`, `prnewswire.com`, `sec.gov`, and ingests as `ir-page`. B registers the `ir_baseline` prepare step (fingerprint = hash(ir_page_url)) which records every currently matching link in `print_watch_ir_seen` `(print_id, link) PK, seen_at, baseline`; a late go never re-baselines. The NVDA RSS config keeps precedence.

**B's merge handler** (registered with A's registry): prints re-home to the target event; when both events have a print, documents merge by `sha256` (roads union, verdicts recomputed), IR-seen rows union, and lines merge by `metric_id` with a lossless rule: if both lines carry evidence, the target line keeps its row and the donor's candidates are appended with their provenance (doc ids already remapped), the reconciler re-runs, and two differing accepted values become a `conflict` with both acceptances preserved in the line's audit JSON rather than either being dropped; the donor print row is deleted last.

### 4.3 The "print is live" action (slice C)

**Durable request.** `POST /api/print-watch/go` `{ eventId, url?, filename?, contentBase64? }` → `requestGo(db, eventId, input)`: arm if not armed (and enqueue the prepare steps); stamp `print_watch_prints.forced_open_at` once; persist the input before acknowledging (a pasted file written content-addressed under the print directory, a URL sanitised and stored); insert `print_watch_go_requests` `(id, print_id, status: queued | claimed | done | failed, requested_at, input_kind: none | url | file, input_url, input_sha256, claim_token, claimed_at, attempts, result_json, finished_at)`; then POST the watcher's `/ensure` so the lease owner wakes within 2 seconds. Claims and finalisation are compare-and-set on `claim_token`; a `claimed` request older than 60 seconds is stale and taken over; `attempts` caps at 3. The route returns `{ requestId, forcedOpenAt }`; the row polls the request and shows the per-road `{ road, outcome, detail }` from `result_json`. C registers its merge handler (go requests re-home by id).

**Effective window, one definition.** `effectiveWindow(print)` in `lib/print-watch/window.ts`: `start = min(release − 10m, forced_open_at − 60m)`, `end = max(release + 45m, forced_open_at + 90m, window_extended_until)`, each term present only when its input is; an unresolved TAS row has no scheduled term. `WINDOW_PRE_MS` (10 minutes) and `WINDOW_POST_MS` (45 minutes) are the scheduled term (the reference doc was corrected 2026-09-02 to say T−10). `desiredState`, `ensurePrintWatch`, `pollOnce`, the DJ query bounds, and the EDGAR window all call it. "Extend 30 min" writes `window_extended_until = max(now, current end) + 30m`; presses stack; a repeat go never extends. ISO UTC strings, `Date.parse`.

**Scheduler.** A process-global `AcquisitionScheduler` (v1 §4.2, unbuilt) owns all outbound polling: per-host token buckets (SEC ≤ 2 requests per second across CIKs, TWS spacing as today), per-host concurrency caps, parallel fan-out of the roads within a pass (`Promise.allSettled` over adapters that take an `AbortSignal` and cancel the underlying request on timeout), per-print pass coalescing (a pass requested while one runs is queued once), and an explicit wake for go requests. The per-print write queue keeps serialising parses and sheet writes; the scheduler serialises acquisition.

### 4.4 The first-pass read (slice D)

**Deterministic facts first.** `buildReadFacts(db, printId)` (pure) produces the scoreboard from validated rows only: per sheet line with a value, `{ metric_id, label, state, actual, actual_high, expected_consensus, expected_whisper, expected_source, delta_pct, verdict }`, with `delta_pct` and `verdict` (beat, inline within ±0.5%, miss, n/a) computed in code; the adjusted-EPS delta is null when the only consensus has an unspecified basis. No model output overwrites a fact.

**Callouts, verified.** The model may propose `{ label, value_text, snippet, doc_id }` for figures the bogey guidance text names but the sheet has no line for. `verifyCallout` requires: the snippet occurs verbatim in that document's stored text (`text_sha256` recorded); the numeric value parses from within the snippet with the same unit; the label's content words appear within 240 characters of the snippet in the stored text or match a term in the guidance bogey text. `vs_bogey_text` is computed in code. A verified callout renders with a single-source label and the same accept control as a sheet line. `print_watch_callouts`: `id, print_id, label, value, unit, snippet, doc_id, text_sha256, verifier_version, state: proposed | accepted | revoked | superseded, accepted_at, revoked_at, superseded_by_doc_id`. D registers its merge handler (reads by `(fingerprint, nonce)`, callouts by `(text_sha256, snippet)`).

**Prose.** The model receives the facts, verified-eligible snippets, bogey guidance text, the user's event notes, last quarter's actuals and reaction, and the implied move, and returns prose only: `read` (6 to 10 lines), `call_watch` (exactly 3), `caveats`. `generateObject` with `additionalProperties: false` on every object node; arrays guarded with `Array.isArray`; prose sanitised at storage and render; document text inside a delimited data block labelled as quoted evidence; instruction-like prose lines dropped at storage.

**Identity and concurrency.** Fingerprint = SHA-256 of the canonical JSON of the fully assembled prompt DTO, which embeds `PROMPT_VERSION`, `SCHEMA_VERSION`, and the resolved model id. `print_watch_reads`: `id, print_id, fingerprint, nonce, status: generating | done | failed | superseded, claim_token, claimed_at, heartbeat_at, attempts, model_id, facts_json, prose_json, generated_at`, `UNIQUE(print_id, fingerprint, nonce)`. Nonce allocation is atomic; a `generating` row with a heartbeat older than three minutes is stale and taken over; finalisation is compare-and-set on the claim token; a newer fingerprint supersedes an older generating one on completion. Scheduling from a post-commit hook after the parse transaction, outside the write chain, debounced five seconds per print. A page refresh reads the newest `done` row; regenerate allocates the next nonce.

**Data-flow contract (privacy).** To Anthropic, on the Mac, per read: the facts, verified-eligible snippets, bogey rows (source label, numbers, guidance text), the user's event notes, intel and history values; the same class of content the preview and recap composers already send, plus document snippets, and stated here as a new transmission. To R2 and KV: the `armedEvents` projection and `epsConsensusBasis` only; never reads, callouts, notes, or document text. Local only: reads, callouts, document bytes and text. Rendering inside `<PrivateText>`; logs carry ids only. Tests assert the exact payloads of `buildFirstPassPrompt`, the snapshot builder, and the outbox writer. The recap composer receives only direction-safe facts (verdict words), never the prose or the notes.

**Model.** `printWatchFirstPass: "anthropic/$frontier"` in `lib/ai/models.ts`; extraction stays on the workhorse tier.

### 4.5 Outputs are buttons (slice E)

- **Print sheet** → `POST /api/print-watch/print-sheet { printId }` → `composePostPrintSheetHtml` (scoreboard, accepted callouts, read, bogeys by source, notes) → existing `renderHtmlToPdf` → `printPdfViaLp`, existing fallback and one-sheet ladder. Disabled with the reason when no line has a value.
- **Promote** → existing accept route, unchanged.
- **Send recap now** → `POST /api/print-watch/send-recap { printId }`. Refuses with domain copy unless the headline pair is accepted and promoted. Otherwise the canonical `EarningsSendService.send(db, candidate, { mode: "nudge" })`, which owns the claim (moved out of the sender internals) and is used by every caller: the sweep loop, the nudge, and the manual `/api/earnings/email` route. Delivery lifecycle: the audit row moves to `sending` **before** the provider call, to `sent` after the provider accepts and the row commits; the stale-claim reaper turns a `sending` row older than the send timeout into `delivery_unknown`, which blocks any automatic resend and surfaces for manual reconciliation (with the provider's message id when the response was received). Nudge mode never refires: a `sent` or `delivery_unknown` row returns that state. Marker writes are awaited. Returns `{ sent | in_progress | already_sent | delivery_unknown | refused: reason }`, rendered verbatim.

### 4.6 Today layout (slice F)

- `app/dashboard/today/page.tsx`: remove the Alerts block and `NearbyLevelsCard`; remove `EarningsCockpit` and `PrintWatchPanel` as blocks; snapshot to one line.
- `SignificantMovesCard` and `MomentumPulse` move to the top of the Analysis `diagnostics` view.
- **Hub controller.** `EarningsHub` renders server rows plus a client controller `EarningsHubLive` owning every poll the cockpit and print panel own today: print-watch status (hot 2s, cool 30s), the 60-second `/ensure`, the cockpit's intel refresh, the mutation-event re-fetch. In-flight requests carry a generation counter; older responses are dropped; requests abort on unmount and when the tab is hidden, resume on visibility. `buildCockpitPayload` is widened to the Hub's week. The email tri-state helpers move with the chips.
- **Expansion.** An armed row renders a full-width sibling below the desktop grid row or the mobile card: `LivePrintRow` with the moved `PrintCard`/`LineRow`, the IR-page field, the prepare status, the go button and paste box, the road outcomes, the read, the callouts, and the buttons. Auto-expansion is transition-based (into `window_open`, `acquired`, forced, or a new go request); `parsed` does not auto-expand on load; a manual toggle overrides, remembered per print in `localStorage`. Polling follows the print state. Callout accept is keyboard-operable.
- Mobile: same controller; paper printing stays Mac-side. Chat rail open at 1280 must not reflow the expansion.

### 4.7 Extra metric lines (slice F)

`earnings_bogeys.extra_metrics_json`: `[{ id: uuid (full, immutable), label, definition, unit: usd | per_share | pct | count, kind: point | range, period: Q | NQ_guide | FY_guide, basis: gaap | non_gaap | na, consensus?, whisper? }]`. `compileContracts` emits one line per `id` (`x_<uuid>_<period>`). Same `id` across bogey rows must agree on unit, kind, period, and basis, or the modal reports a conflict and neither compiles; numbers merge first-non-null. When a semantic field changes on an `id` with evidence, the existing line is marked `retired` (evidence preserved) and a new line is compiled. `recompileContracts(db, printId)` is explicit and transactional.

## 5. Data changes, per slice (numbers reserved now; landing order A, B, C, D, E; parallel branches keep their numbers)

- **088 (A)**: `earnings_prepare_steps`, `earnings_bogey_scans`, `cloud_outbox`; `earnings_bogeys` rebuild widening `source` with `'finnhub'` and adding `eps_consensus_basis`, `extra_metrics_json` (carried early so the table is rebuilt once; unused until F); snapshot v11.
- **089 (B, `.ts`)**: runner support for `.ts` migrations; the documents and lines rebuild; `print_watch_document_roads`, `print_watch_candidate_archive`, `print_watch_sources`, `print_watch_ir_seen`.
- **090 (C)**: `print_watch_go_requests`; `print_watch_prints.forced_open_at`, `window_extended_until`.
- **091 (D)**: `print_watch_reads`, `print_watch_callouts`.
- **092 (E)**: `earnings_emails` states `sending`, `delivery_unknown`.
- **F**: none.

Each migration is rehearsed on a VACUUM copy with before/after assertions; the bogeys rebuild (A) copies by an explicit column list generated from `PRAGMA table_info` at authoring time and asserted in a test against the live schema.

## 6. Routes (thin, human-auth through the proxy, envelope `{success, data|error}`)

`POST /api/print-watch/drop` (adds `url`, B); `POST /api/print-watch/go`, `GET /api/print-watch/go?requestId=`, `POST /api/print-watch/extend` (C); `POST /api/print-watch/read`, `POST /api/print-watch/callouts/accept` (D); `POST /api/print-watch/print-sheet`, `POST /api/print-watch/send-recap` (E); `PUT /api/print-watch/sources` (B); `POST /api/earnings/worksheet` (A: arm enqueues the prepare steps and returns their state). `GET /api/print-watch/status` gains fields per slice and stays a pure read.

## 7. Failure modes, stated

- Poppler missing, encrypted, image-only, or oversize PDF → refused with a specific message; other roads unaffected.
- IR page changes shape → "IR: 0 matching links"; other roads still run.
- Pasted URL blocked by the SSRF contract, 403, or binary → the road outcome names the reason (redacted URL) and suggests the IR-site or EDGAR link.
- TWS down at go → wire road `skipped: TWS offline`; the forced window keeps EDGAR and IR polling; `con_id` stays pending.
- Model call fails for the read → row `failed` with retry; greening unaffected.
- Another process holds the lease → the go request is claimed within 2 seconds of the ensure wake; stale claim taken over at 60 seconds.
- A date correction while armed → the merge registry moves flags, steps, print, and evidence to the surviving row and writes the outbox row.
- KV write fails → the outbox row stays unsent and retries; the Worker keeps the last generation it saw.
- Provider accepted a recap but the audit commit failed → `delivery_unknown`, no automatic resend.

## 8. Testing

TDD per module, in-memory SQLite, DI seams (spawn, fetch and lookup, model, `lp`, clock, KV):

- A: one test per matrix row; event-scoped armed does not cover a sibling event; symbol `armed` horizon; ET day math in `findEmailCandidates`; the allowlist guard; outbox generation monotonic under concurrent mutations; KV writer refuses to regress; snapshot `armedGeneration` from one read transaction; Worker resolver adds, replaces, tombstones, ignores stale deltas, degrades on v10; push gate ignores armed; merge matrix table by table; prepare claim CAS (a timed-out worker's finalisation is rejected); fingerprint-driven reset; scan ledger claim before call; per-article path never stamps the global marker; consensus basis labels.
- B: runner `.ts` migration support with rollback; rebuild phases with injected failures; candidate archive invariant; reconciler re-run turns a duplicate-only `agreed` into `single_source`; `recordDelivery` atomic under a race; content-plus-road eligibility with a stricter road first; PDF readings, weak pair, refusals, persisted text; every SSRF rule, pinned lookup, agent closed, abort closes the socket, binary rejection, `redactUrl` on every error path, legacy URL sanitisation; IR page literal filter, default pattern, allowlist, persisted baseline across restart, late go does not re-baseline; B's merge handler lossless line rule.
- C: input persisted before ack; window lookback; repeat press; extend stacks; second-process claim; stale takeover; scheduler fan-out, coalescing, buckets, cancellation.
- D: facts in code; verifier (snippet, value, label association); computed `vs_bogey_text`; fingerprint from the prompt DTO; race → one call; stale takeover; supersession; injection-like prose dropped; payload builders match the data-flow contract.
- E: one claim owner across sweep, nudge, manual route; `sending` before the provider call; `delivery_unknown` on a simulated crash; nudge non-refiring; awaited markers; concurrent sweep and nudge send once.
- F: removed blocks; chips for the full week; generation-ordered responses; abort on hidden tab; transition-based expansion; toggle persistence; two hot prints; correction during expansion; keyboard callout acceptance; desktop 1280 with rail open and mobile widths; Analysis diagnostics renders the moved cards; extra-metric conflicts and retirement.

End-to-end per slice on the `:3095` sandbox recipe with the 2026-09-02 SNOW documents in the gitignored fixtures tree; screenshots and logs checked for private text before commit; then `verify:changed`, the full suite, `next build`, and the deploys the slice needs (Electron; Worker for A).

## 9. Rulings on Codex open questions

1. Precedence stays `held` > `watchlist` > `armed`; the resolver exposes the reason set; event decisions use `isEventArmed`.
2. The first go stamps once; extension is an explicit control; a repeat press never extends.
3. Callouts: mechanical verification plus single-source label plus per-callout accept.
4. IR page: fixed minimal wire-host allowlist plus the IR host; user input is a literal substring.
5. Round 3: A and B are decoupled by the merge and prepare registries; the migration runner gains `.ts` support in B; duplicate candidates are archived and affected lines re-reconciled; the delta carries a full event projection under a generation watermark.

## 10. Slices, order, and process

| Slice | Contents | Depends on | Files it owns | Deploys |
|---|---|---|---|---|
| A | §4.1: matrix, event-armed, ET day math, outbox + KV delta + snapshot v11 + Worker resolver, merge registry with A's handlers, prepare table with A's steps, consensus row with basis | — | `lib/queries/briefing-symbols.ts`, `lib/earnings/{event-merge,prepare-armed-event,extract-newsletter-bogeys}.ts`, `lib/mutations/calendar.ts`, `lib/calendar/{enrichment-runner,verify-earnings-dates,wire-probe,reconcile-earnings-dates}.ts`, `lib/earnings/{wrap,debrief,bogeys-reminder}.ts`, `scripts/snapshot-state-to-r2.ts`, `workers/cron/src/*` (not `calendar-enrich.ts`'s push gate), migration 088 | Electron + Worker |
| B | §4.2: runner `.ts` support, identity rebuild, roads, eligibility, PDF, URL, IR page, B's merge handler and `ir_baseline` step | — | `lib/print-watch/*`, `lib/db/migrate.ts`, migration 089 | Electron |
| C | §4.3 | B | `lib/print-watch/{go,window,scheduler}.ts`, migration 090 | Electron |
| D | §4.4 | B | `lib/print-watch/{read-facts,read,callouts}.ts`, migration 091 | Electron |
| E | §4.5 | D (sheet) | `lib/earnings/print-sheet.ts`, `lib/digest/send-earnings-email.ts`, `lib/calendar/email-sweep.ts`, migration 092 | Electron |
| F | §4.6, §4.7 | B, C, D for the expansion; removals may land first | `app/dashboard/today/*`, `app/dashboard/analysis/*`, `lib/print-watch/contracts.ts` | Electron |

A and B share no file: A never edits `lib/print-watch/*`; B never edits the calendar, earnings, or Worker modules. Their contact points are two registries A creates (`registerEventMergeHandler`, `registerPrepareStep`) that B calls from its own modules; B's plan stubs the registry interfaces if A has not merged yet, and the integration test that exercises both lands with whichever merges second. Migration numbers are reserved above. Each slice: `writing-plans` → one Codex round on the plan → subagent-driven implementation in a sibling worktree → whole-branch review → sandbox E2E → merge → deploy. This document is not re-opened for a slice unless the slice finds a design conflict, which is then recorded here and in `DECISIONS.md`.
