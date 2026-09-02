# Live print v2 — design

**Date:** 2026-09-02 (rev 3, after Codex rounds 1 and 2)
**Status:** Codex round 3, then user review, then one `writing-plans` pass per slice (§10)
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
- The work ships as six independently deployable slices (§10); slices A and B are built first, in parallel.
- Today: Alerts and Nearby Levels leave the page. Significant Moves and Momentum Pulse move to Analysis. The Earnings Cockpit folds into the Earnings Hub rows as chips. The print-watch card becomes the armed Hub row's in-place expansion. Portfolio snapshot shrinks to one line. Week Ahead, Releases, IBKR today, and the chat button stay.

## 3. Goals and non-goals

**Goals.** (a) An armed event gets what a held name's event gets, automatically, from the moment it is armed, on the Mac and in the cloud fallback. (b) A release reaches the sheet by PDF, by pasted link, by a stored IR page, by the wire, or by EDGAR, whichever lands first, and identical bytes are counted once no matter how many roads deliver them. (c) Within seconds of the first parse the user sees a first-pass read against their own bogeys, on screen, inside Today, with every number computed deterministically and every quoted figure verified against stored text. (d) Paper and recap are one click each. (e) Today has one earnings surface.

**Non-goals (this session).** Push composer or push-gate changes. Unattended promotion (the v1 ruling that the user is the gate stands; the statistical corpus gate remains stage 2). Recap timing policy (ask (f)). Learned per-company line shapes (ask (d)); a manual extra-metrics field covers the immediate need. OCR for image-only PDFs (explicit refusal instead).

## 4. Design

### 4.1 Coverage: armed is an event fact; `armed` status is display-only

**Two questions, two answers.** Every consumer that evaluates a specific event asks `isEventArmed(db, eventId)`: a flag row exists for that event id (family-aware only through the event's own symbol). `SymbolStatus` gains `armed` purely for symbol-level display (Hub and cockpit chips) and for symbol-only tasks that have no event in hand (the transcript fetchers); it never widens an event decision, so an armed Q3 print cannot cover an unrelated Q4 row of the same issuer. Precedence for display: `held` > `watchlist` > `armed` > `neither`, and the resolver returns the reason set `{ held, watchlist, armed }`. Dates are ET-anchored via `todayET()`.

**Consumer matrix.** Every call site changes deliberately; none by blanket substitution. `coveredForEvent(db, symbol, eventId)` = `isCoveredStatus(heldOrWatchlist)` or `isEventArmed(eventId)`.

| Consumer | Today | v2 | Mirror |
|---|---|---|---|
| `lib/earnings/extract-newsletter-bogeys.ts:279` bogey scan | held/watchlist | coveredForEvent | Mac only |
| `lib/earnings/bogeys-reminder.ts:65` missing-bogeys reminder | held/watchlist | coveredForEvent | Mac only |
| `lib/calendar/verify-earnings-dates.ts:136` date verifier | held/watchlist | coveredForEvent (manual rows still skipped) | Mac only |
| `lib/calendar/wire-probe.ts:69` pre-release Finnhub probe | held/watchlist | coveredForEvent | Mac only |
| `lib/calendar/enrichment-runner.ts:849` enrichment priority | held/watchlist | coveredForEvent | Worker `enrich-actuals.ts` reads `armedEvents` |
| `lib/calendar/enrichment-runner.ts:504` push-at-print gate | held/watchlist/read-through | **unchanged** | Worker `calendar-enrich.ts` unchanged |
| `lib/calendar/cloud-reconcile.ts:237` push on cloud reconcile | same | **unchanged** | — |
| `lib/alerts/read-through-push.ts:34` read-through targets | held/watchlist | **unchanged** | — |
| Email sweep candidate filter (`findEmailCandidates`, located in plan A) | held/watchlist | coveredForEvent (preview, recap) | Worker `fallback-earnings.ts` two candidate filters read `armedEvents` by event id |
| `lib/earnings/wrap.ts:99` AMC wrap | held/watchlist | coveredForEvent | Worker wrap path reads `armedEvents` |
| `lib/earnings/debrief.ts:131` morning debrief | held/watchlist | coveredForEvent | Worker debrief path, if present |
| `lib/digest/todays-reporters.ts:65` digest reporters | held/watchlist | coveredForEvent | Worker `todays-reporters.ts` reads `armedEvents` |
| `lib/digest/call-transcripts.ts:251`, `lib/transcripts/same-day.ts:287` transcripts | held/watchlist | symbol `armed` counts (no event in hand) | Mac only |
| `lib/queries/earnings-cockpit.ts:140`, `app/dashboard/today/EarningsHub.tsx:100` chips | chip | chip shows `armed` when armed-only | — |

A repo guard test asserts every `getSymbolStatus` and `isEventArmed` consumer appears in an allowlist naming its decision (coveredForEvent, symbol-armed, unchanged, display).

**Snapshot v11 and the immediate delta.** `scripts/snapshot-state-to-r2.ts` bumps `schemaVersion` to 11 and adds `armedEvents: Array<{ eventId, symbol, eventDate, sourceKey }>` from the flags join. The nightly snapshot alone cannot carry a same-day arm, so arm, disarm, and date correction also write a KV delta `armed-events` (the existing marker mechanism in `lib/cron/earnings-marker-check.ts`): `{ writtenAt, entries: [{ eventId, symbol, eventDate, sourceKey, removed: boolean }] }`, full list each write, replacing the previous value. The Worker merges the delta over the snapshot when `writtenAt` is newer than the snapshot's `generatedAt`; tombstones (`removed: true`) win over snapshot entries. Snapshot bogeys gain `epsConsensusBasis` per row; the Worker renderer labels an unspecified basis and never uses it in an adjusted-EPS comparison. Snapshots ≤ v10 degrade to held-plus-watchlist (the v8 and v10 precedent); the delta is ignored when the snapshot is older than v11. The push gate in `calendar-enrich.ts` is not touched. Parity tests: for each mirrored site, an armed-only event passes on both sides with v11 plus delta and fails with v10; a tombstoned event fails on both.

**Correction survival: one merge function.** `earnings_worksheet_flags.event_id` cascades on delete, prints and flags are unique per event, and `correctEarningsEventDate` today repoints bogeys, emails, and skips with `UPDATE OR IGNORE` for colliding children. v2 adds `mergeEarningsEventState(db, donorEventId, targetEventId)`, called by `correctEarningsEventDate` and `reconcileEarningsDates` inside their transaction, with defined collision rules: flags, the target keeps its own row if it has one, otherwise the donor's moves; prepare steps merge per step with `done` winning over anything else; prints, when both events have one, the donor print's documents, roads, lines, reads, callouts, go requests, and IR-seen rows re-home to the target print by insert-or-merge on their natural keys (document by `sha256`, line by `metric_id` keeping the row with evidence or acceptance, read by fingerprint, callout by `(text_sha256, snippet)`, go request by id), then the donor print row is deleted; scan-ledger rows re-key with `ON CONFLICT DO NOTHING`. Tests cover empty target, armed target, target with its own print and evidence, and the reconcile path; the delta write (above) follows the merge.

**Prepare work table.** `armWorksheet` stays a pure mutation. Arming inserts five rows into `earnings_prepare_steps` (migration, slice A): `(event_id, step) PK, status: pending | claimed | done | failed, input_fingerprint, claim_token, claimed_at, attempts, last_error, updated_at`, steps `newsletter_rescan`, `consensus_row`, `intel`, `con_id`, `ir_baseline`. The worksheet route runs the pass once right after arm; the earnings sweep re-runs every `pending` step and every `failed` step under five attempts on each tick until the event; a `claimed` row older than five minutes is stale and taken over; `done` steps re-run only when their `input_fingerprint` changes (the consensus step fingerprints the vendor consensus values, the IR baseline step fingerprints the stored IR page URL). Steps:

1. `newsletter_rescan`: `extractBogeysForSymbol(db, symbol, eventId, { sinceDays: 14 })` walks articles from the last 14 days mentioning the symbol. Ledger `earnings_bogey_scans`: `(event_id, article_id, extractor_version) PK, status: claimed | hit | no_numbers | error, claim_token, model_id, attempts, scanned_at`. The ledger row is inserted as `claimed` before the model call and finalised after; a crash between leaves a stale claim that the next run takes over rather than re-billing blindly (at most one extra call per crash, bounded by `attempts`). `error` rows retry up to three attempts. The existing global `processed` marker is untouched.
2. `consensus_row`: when the event carries Finnhub consensus, upsert one bogey row keyed `(event_id, 'finnhub', 'Sell-side consensus (Finnhub)')` with `revenue_consensus_usd`, `eps_consensus`, and `eps_consensus_basis = 'vendor_unspecified'`. `compileContracts` uses the revenue value as the revenue expected value and never sets the adjusted-EPS expected value from a row whose basis is unspecified. Every surface that shows the EPS figure labels it.
3. `intel`: `refreshEarningsIntel(db, eventId)`.
4. `con_id`: `enrichSecurities(db, [securityId])` when `ib_con_id` is null and TWS is up; stays `pending` while TWS is down.
5. `ir_baseline`: when a stored IR page exists (4.2), record every currently matching link as baseline in `print_watch_ir_seen`.

The go action re-runs any step not `done`. The row shows the five outcomes.

### 4.2 Acquisition roads and document identity

**Identity.** Documents dedupe on content: `UNIQUE(print_id, sha256)`. Insert is atomic: `INSERT … ON CONFLICT(print_id, sha256) DO UPDATE SET last_seen_at = excluded.last_seen_at RETURNING id`, so a drop, a URL fetch, a go pass, and the lease owner's poll can race without a double row. Roads are provenance: `print_watch_document_roads` `(document_id, kind, source) PK, url, first_seen_at, last_seen_at, seen_count, gate_verdict, gate_reason`, upserted on every delivery. `kind` values: existing `dj-release`, `edgar-ex99`, `ir-page`, `user-drop`, plus `user-url`.

**Content-based eligibility.** The doc-to-event gate runs once per document on its content and stores the verdict on the document; a road may add a stricter road-level verdict (the IR road's period check) on its own road row. A document is parse-eligible when its content verdict is accepted, regardless of which road delivered it first; a stricter road rejection never blocks a later road. If a document's content verdict is rejected and a later road supplies additional evidence (the EDGAR exhibit's filing metadata), the gate re-evaluates and, on acceptance, requeues the parse. The reconciler counts documents, so identical bytes are one piece of evidence.

**Migration (slice B).** Rebuild `print_watch_documents` and `print_watch_lines` in the runner's foreign-keys-on transaction in this exact order: (1) create `print_watch_documents_new` with the new constraints and `text_sha256 TEXT NULL`; (2) copy rows, deduping same-hash rows per print into the lowest id, producing an explicit old-id → survivor-id map held in a temp table; (3) seed `print_watch_document_roads` from every old row (kind, source, url, first-seen); (4) create `print_watch_lines_new` referencing the new parent, with the `state` CHECK widened by `retired`; (5) copy lines remapping `source_doc_id` and rewriting every `candidates_json[].doc_id` through the map (JSON rewrite in the migration runner's TypeScript step, not SQL); (6) drop `print_watch_lines`; (7) drop `print_watch_documents`; (8) rename both `_new` tables; (9) recreate indexes; (10) `PRAGMA foreign_key_check` must return no rows. Before and after: assert the multiset of candidates per `(print_id, metric_id)` and the count of lines with evidence are unchanged, and that every surviving document's bytes exist on disk. Injected-failure tests at each phase assert full rollback. Rehearsed on a VACUUM copy of the live DB.

**PDF.** `ingestDocument` accepts a `%PDF-` buffer. Stored as `.pdf`. Before parsing: reject encrypted PDFs, PDFs over 10MB or 60 pages, and PDFs whose text layer is under 500 characters, each with its own message. Two representations:

- `pdfText`: `pdftotext -layout`. Resolution order: `settings.pdftotext_path`, `/opt/homebrew/bin/pdftotext`, `/usr/local/bin/pdftotext`, `PATH`. DI spawn seam, 30-second timeout with the child killed on timeout, output capped at the 2MB document ceiling, persisted beside the bytes as `<sha>.pdftext.txt` with `text_sha256` on the document row.
- `pdfNative`: the extraction prompt sent with the PDF as a Claude `document` block (the `lib/research-documents/extract.ts` path). `extractCandidates` gains `{ kind: "pdf", bytes }`; prompt and parser unchanged.

Both candidates carry `weak_pair = true` and `pair_note = 'pdf-weak'` (presentation metadata on the candidate), so a PDF alone renders "agreed (PDF), verify" and never green. **Pre-registered gate** (recorded in `DECISIONS.md` before measurement): a frozen holdout of at least 50 releases as PDFs with at least 500 hand-labelled lines from the gitignored fixtures tree, green precision ≥ 99% with zero catastrophic errors (v1 §2 definition); only a passing measurement flips the pair to independent. The doc-to-event gate runs on `pdfText`. Poppler missing → refused naming the tool and the setting.

**URL.** `POST /api/print-watch/drop` accepts `{ eventId, url }`. `hardenedFetchBytes` (new beside `hardenedFetchText`) uses an undici `Agent` whose `connect.lookup` returns only the pre-validated address, so the socket goes to the address that passed the checks (no re-resolution): `https` only, no credentials, port 443 only, A and AAAA resolved, every address globally routable (rejecting loopback, RFC1918, link-local, ULA, IPv4-mapped, multicast, cloud-metadata ranges); each redirect hop (max 3) repeats the full validation on the new host with a fresh pinned lookup; one `AbortController` with a 20-second total budget shared across hops; response bytes capped at 10MB while streaming; type by magic bytes (`%PDF-`, `<html`/`<!doctype`, else text only if the first 4KB contain no NUL and under 2% control bytes, otherwise refused as binary). The stored `url` strips query parameters whose name matches `token|sig|signature|key|auth|session|access` before persistence, and the row shows the sanitised form. A 403 from a wire syndicator is reported with the hint to paste the IR-site link or the EDGAR exhibit.

**Stored IR page.** `print_watch_sources`: `symbol TEXT PRIMARY KEY, ir_page_url, link_must_contain TEXT NULL, created_at, updated_at`; `link_must_contain` is a literal substring. Set from the "IR page" field on the armed Hub row. Adapter `lib/print-watch/ir-page-adapter.ts::pollIrPage(cfg, seen, fetchFn, { baseline })`: fetch through `hardenedFetchBytes`, collect anchors, keep those whose text or href contains the literal (when set) and matches the fixed default earnings-headline pattern (a code constant), resolve relative hrefs, return `{ link, title }`. The watcher follows new items whose host is the IR host or one of `businesswire.com`, `globenewswire.com`, `prnewswire.com`, `sec.gov`, and ingests as `ir-page`. Baseline is persisted at arm by the `ir_baseline` prepare step in `print_watch_ir_seen` `(print_id, link) PK, seen_at, baseline`; a late go never re-baselines. The NVDA RSS config keeps precedence.

### 4.3 The "print is live" action

**Durable request.** `POST /api/print-watch/go` `{ eventId, url?, filename?, contentBase64? }` → `requestGo(db, eventId, input)`: arm if not armed (and enqueue the prepare steps); stamp `print_watch_prints.forced_open_at` once; persist the input before acknowledging (a pasted file is written content-addressed under the print directory, a URL is sanitised and stored); insert `print_watch_go_requests` `(id, print_id, status: queued | claimed | done | failed, requested_at, input_kind: none | url | file, input_url, input_sha256, claim_token, claimed_at, attempts, result_json, finished_at)`; then POST the watcher's `/ensure` so the lease owner wakes within 2 seconds instead of its 10-second tick. If the requesting process is the lease owner it claims and runs the pass inline. A `claimed` request older than 60 seconds is stale and taken over; `attempts` caps at 3. The route returns `{ requestId, forcedOpenAt }` and the row polls the request until `done` or `failed`, showing the per-road `{ road, outcome, detail }` from `result_json`.

**Effective window, one definition.** `effectiveWindow(print)` in `lib/print-watch/window.ts`: `start = min(release − 10m, forced_open_at − 60m)`, `end = max(release + 45m, forced_open_at + 90m, window_extended_until)`, each term present only when its input is; an unresolved TAS row has no scheduled term. The v1 constants (`WINDOW_PRE_MS` 10 minutes, `WINDOW_POST_MS` 45 minutes) are the scheduled term, and `docs/reference/earnings-pipeline.md` is corrected to say T−10 (it says T−30 today). `desiredState`, `ensurePrintWatch`, `pollOnce`, the DJ query bounds, and the EDGAR window all call it; nothing else computes a window. "Extend 30 min" writes `window_extended_until = max(now, current end) + 30m`; repeated presses stack; a repeat go never extends. Timestamps are ISO UTC strings parsed with `Date.parse`.

**Scheduler.** A process-global `AcquisitionScheduler` (v1 §4.2 "global scheduler", unbuilt) owns all outbound polling: per-host token buckets (SEC ≤ 2 requests per second across CIKs, TWS request spacing as today), per-host concurrency caps, a parallel fan-out of the roads within one pass (`Promise.allSettled` over cancellable adapters that take an `AbortSignal`), per-print pass coalescing (a pass requested while one runs is queued exactly once), and an explicit wake for go requests. The existing per-print write queue keeps serialising parses and sheet writes; the scheduler serialises acquisition. Adapter timeouts cancel the underlying request, not only the promise.

### 4.4 The first-pass read

**Deterministic facts first.** `buildReadFacts(db, printId)` (pure, `lib/print-watch/read-facts.ts`) produces the scoreboard from validated rows only: per sheet line with a value, `{ metric_id, label, state, actual, actual_high, expected_consensus, expected_whisper, expected_source, delta_pct, verdict }`, with `delta_pct` and `verdict` (beat, inline within ±0.5%, miss, n/a) computed in code; the adjusted-EPS delta is null when the only consensus has an unspecified basis. No model output overwrites a fact.

**Callouts, verified.** The model may propose `{ label, value_text, snippet, doc_id }` for figures the bogey guidance text names but the sheet has no line for. `verifyCallout` requires: the snippet occurs verbatim in that document's stored text (`text_sha256` recorded); the numeric value parses from within the snippet with the same unit; and the label is associated with the snippet, meaning the label's content words appear within 240 characters of the snippet in the stored text or the label matches a term in the guidance bogey text. `vs_bogey_text` is computed in code from the guidance bogey numbers, never taken from the model. A verified callout renders with a single-source label and the same accept control as a sheet line. `print_watch_callouts`: `id, print_id, label, value, unit, snippet, doc_id, text_sha256, verifier_version, state: proposed | accepted | revoked | superseded, accepted_at, revoked_at, superseded_by_doc_id`; a newer document version supersedes callouts derived from the older one, exactly as lines are handled today.

**Prose.** The model receives the facts, verified-eligible snippets, bogey guidance text, the user's event notes, last quarter's actuals and reaction, and the implied move, and returns prose only: `read` (6 to 10 lines), `call_watch` (exactly 3), `caveats`. `generateObject` with `additionalProperties: false` on every object node; arrays guarded with `Array.isArray`; prose sanitised at storage and render. Document text reaches the model only inside a delimited data block labelled as quoted evidence; prose lines containing instruction-like directives are dropped at storage.

**Identity and concurrency.** The fingerprint is the SHA-256 of the canonical JSON of the fully assembled prompt DTO, which embeds `PROMPT_VERSION`, `SCHEMA_VERSION`, and the resolved model id, so any input change changes it and nothing outside the prompt does. `print_watch_reads`: `id, print_id, fingerprint, nonce, status: generating | done | failed | superseded, claim_token, claimed_at, heartbeat_at, attempts, model_id, facts_json, prose_json, generated_at`, `UNIQUE(print_id, fingerprint, nonce)`. Nonce allocation is atomic (`INSERT … SELECT COALESCE(MAX(nonce), −1) + 1 … WHERE fingerprint = ?`); a `generating` row with a heartbeat older than three minutes is stale and taken over; when a newer fingerprint starts while an older one is generating, the older is marked `superseded` on completion and never rendered. Scheduling happens from a post-commit hook after the parse transaction, outside the write chain, debounced five seconds per print. Failure marks the row `failed` with retry. A page refresh reads the newest `done` row; regenerate allocates the next nonce.

**Data-flow contract (privacy).** To Anthropic, on the Mac, per read: the facts, verified-eligible snippets, bogey rows (source label, numbers, guidance text), the user's event notes, intel and history values. This is the same class of content the preview and recap composers already send, plus document snippets; it is a new transmission and is stated as such. To R2 (snapshot v11) and KV (delta): `armedEvents` and `epsConsensusBasis` only; never reads, callouts, notes, or document text. Local only: reads, callouts, document bytes and text. Rendering: reads, callouts, and curated bogeys inside `<PrivateText>`; logs carry ids only. Tests assert the exact payload of `buildFirstPassPrompt`, the snapshot builder, and the delta writer against these lists. The recap composer receives only direction-safe facts (verdict words), never the prose or the notes.

**Model.** New feature key `printWatchFirstPass: "anthropic/$frontier"` in `lib/ai/models.ts`; extraction stays on the workhorse tier. Never a model id in code.

### 4.5 Outputs are buttons

- **Print sheet** → `POST /api/print-watch/print-sheet { printId }` → `composePostPrintSheetHtml` (scoreboard, accepted callouts, read, bogeys by source, notes) → existing `renderHtmlToPdf` → `printPdfViaLp`, existing fallback and one-sheet ladder. Disabled with the reason when no line has a value.
- **Promote** → existing accept route, unchanged.
- **Send recap now** → `POST /api/print-watch/send-recap { printId }`. Refuses with domain copy unless the headline pair is accepted and promoted. Otherwise it calls the canonical `EarningsSendService.send(db, candidate, { mode: "nudge" })`. The service owns the claim (moved out of the sender internals so there is one owner), and every caller uses it: the sweep loop, the nudge, and the manual `/api/earnings/email` route. Nudge mode never refires: a completed audit row for the phase returns `already_sent`. Marker writes are awaited, not fire-and-forget. A crash after the provider accepted but before the audit row commits leaves a `delivery_unknown` audit state (new value on `earnings_emails`), which blocks automatic resend and surfaces for manual reconciliation. The service returns `{ sent | in_progress | already_sent | delivery_unknown | refused: reason }` and the row renders it verbatim.

### 4.6 Today layout

- `app/dashboard/today/page.tsx`: remove the Alerts block and `NearbyLevelsCard`; remove `EarningsCockpit` and `PrintWatchPanel` as blocks; snapshot to one line.
- `SignificantMovesCard` and `MomentumPulse` move to the top of the Analysis `diagnostics` view.
- **Hub controller.** `EarningsHub` renders server rows plus a client controller `EarningsHubLive` owning every poll the cockpit and print panel own today: print-watch status (hot 2s, cool 30s), the 60-second `/ensure`, the cockpit's intel refresh, and the mutation-event re-fetch. Each in-flight request carries a generation counter; responses from an older generation are dropped; requests abort on unmount and when the tab is hidden, and resume on visibility. `buildCockpitPayload` is widened to the Hub's week. The email tri-state helpers move with the chips.
- **Expansion.** An armed row renders a full-width sibling element below the desktop grid row or the mobile card: `LivePrintRow` with the moved `PrintCard`/`LineRow`, the IR-page field, the prepare status, the go button and paste box, the road outcomes, the read, the callouts, and the buttons. Auto-expansion is transition-based (into `window_open`, `acquired`, forced, or a new go request); `parsed` does not auto-expand on load; a manual toggle overrides and is remembered per print in `localStorage`. Polling follows the print state, not the expansion. Callout accept is keyboard-operable.
- Mobile: same controller; paper printing stays Mac-side. Chat rail open at 1280 must not reflow the expansion.

### 4.7 Extra metric lines

`earnings_bogeys.extra_metrics_json`: `[{ id: uuid (full, immutable), label, definition, unit: usd | per_share | pct | count, kind: point | range, period: Q | NQ_guide | FY_guide, basis: gaap | non_gaap | na, consensus?, whisper? }]`. `compileContracts` emits one line per `id` (`x_<uuid>_<period>`). Same `id` across bogey rows must agree on unit, kind, period, and basis, or the modal reports a conflict and neither compiles; numbers merge first-non-null. When a semantic field changes on an `id` that already has evidence, the existing line is marked `retired` (evidence preserved, never reinterpreted) and a new line is compiled. `recompileContracts(db, printId)` is explicit and transactional.

## 5. Data changes, per slice (numbers assigned at plan time in landing order)

- **Slice A**: `earnings_prepare_steps`, `earnings_bogey_scans`; `earnings_bogeys` rebuild widening `source` with `'finnhub'` and adding `eps_consensus_basis`, `extra_metrics_json` (carried early so the table is rebuilt once; the column stays unused until slice F); snapshot v11; KV `armed-events` delta.
- **Slice B**: the documents and lines rebuild (§4.2), `print_watch_document_roads`, `print_watch_sources`, `print_watch_ir_seen`.
- **Slice C**: `print_watch_go_requests`; `print_watch_prints.forced_open_at`, `window_extended_until`.
- **Slice D**: `print_watch_reads`, `print_watch_callouts`.
- **Slice E**: `earnings_emails` delivery state `delivery_unknown`.
- **Slice F**: none.

Every migration is additive to prior slices and rehearsed on a VACUUM copy with before/after assertions; the two rebuilds (A: bogeys; B: documents and lines) follow the FK-safe order in §4.2.

## 6. Routes (thin, human-auth through the proxy, envelope `{success, data|error}`)

`POST /api/print-watch/drop` (adds `url`); `POST /api/print-watch/go`; `GET /api/print-watch/go?requestId=`; `POST /api/print-watch/read`; `POST /api/print-watch/callouts/accept`; `POST /api/print-watch/print-sheet`; `POST /api/print-watch/send-recap`; `POST /api/print-watch/extend`; `PUT /api/print-watch/sources`; `POST /api/earnings/worksheet` (arm enqueues the prepare steps and returns their state). `GET /api/print-watch/status` adds `roads`, `read`, `callouts`, `prepare`, `forcedOpenAt`, `windowExtendedUntil`, and open go requests; it stays a pure read.

## 7. Failure modes, stated

- Poppler missing, encrypted, image-only, or oversize PDF → refused with a specific message; HTML and URL roads unaffected.
- IR page changes shape → "IR: 0 matching links"; other roads still run.
- Pasted URL blocked by the SSRF contract, 403, or binary → the road outcome names the reason and suggests the IR-site or EDGAR link.
- TWS down at go → wire road `skipped: TWS offline`; the forced window keeps EDGAR and IR polling; the `con_id` step stays pending.
- Model call fails for the read → row `failed` with retry; greening unaffected.
- Another process holds the lease → the go request is claimed by the owner within 2 seconds of the ensure wake; a stale claim is taken over at 60 seconds.
- A date correction while armed → the merge function moves flags, steps, print, and evidence to the surviving row and writes the delta.
- Provider accepted the recap but the audit write failed → `delivery_unknown`, no automatic resend.

## 8. Testing

TDD per module, in-memory SQLite, DI seams (spawn for poppler, fetch and lookup for URL and IR page, model for the read, `lp`, clock, KV):

- Coverage: one test per matrix row; event-scoped armed does not cover a sibling event; ET anchoring; the allowlist guard; v11 plus delta on both sides; tombstones; v10 degrade; push gate ignores armed.
- Merge function: empty target, armed target, target with its own print and evidence, reconcile path, delta written after merge.
- Prepare: step claims, stale takeover, attempts cap, fingerprint-driven re-run, scan ledger claim before model call, crash between call and finalise bounded to one extra call, consensus basis labels, runs with TWS down, IR baseline step.
- Identity: same bytes via drop, URL, EDGAR → one document, three road rows, counted once; content-based eligibility with a stricter road first; atomic upsert under a simulated race; migration dedupe with candidate-JSON rewrite and multiset assertion; injected failure per phase with rollback; `foreign_key_check` clean.
- PDF: synthetic fixture with a known text layer; both readings; never greens; refusals; persisted text and hash; pre-registered gate recorded.
- URL: every SSRF rule including redirect to a private address and a mixed public/private resolution; pinned lookup used; abort closes the socket; binary rejection; query-token scrubbing.
- IR page: literal filter, default pattern, relative links, allowlist, persisted baseline across restart, late go does not re-baseline.
- Go: input persisted before ack; window lookback catches a press 25 minutes early; repeat press does not move the stamp; extend stacks; second-process claim; stale takeover; scheduler fan-out, coalescing, host buckets, cancellation on timeout.
- Read: facts in code; callout verifier (snippet, value, label association); computed `vs_bogey_text`; fingerprint from the prompt DTO; race → one model call; stale heartbeat takeover; supersession; nonce allocation; injection-like prose dropped; payload builders match the data-flow contract.
- Send service: one claim owner across sweep, nudge, and manual route; nudge non-refiring; awaited markers; `delivery_unknown` on a simulated crash; concurrent sweep and nudge send once.
- Today: removed blocks; chips for the full week; generation-ordered responses; abort on hidden tab; transition-based expansion; toggle persistence; two hot prints; correction during expansion; keyboard callout acceptance; desktop 1280 with rail open and mobile widths; Analysis diagnostics renders the moved cards.
- Rollout: mixed v10/v11 snapshot behaviour in the Worker.

End-to-end per slice on the `:3095` sandbox recipe with the 2026-09-02 SNOW documents in the gitignored fixtures tree; screenshots and logs checked for private text before commit; then `verify:changed`, the full suite, `next build`, and the deploys the slice needs (Electron; Worker for slice A).

## 9. Rulings on Codex round-1 open questions

1. Precedence stays `held` > `watchlist` > `armed`; the resolver exposes the reason set; event decisions use `isEventArmed`.
2. The first go stamps once; extension is an explicit control; a repeat press never extends.
3. Callouts: mechanical verification plus single-source label plus per-callout accept.
4. IR page: fixed minimal wire-host allowlist plus the IR host; user input is a literal substring.

## 10. Slices, order, and process

| Slice | Contents | Depends on | Deploys |
|---|---|---|---|
| A | §4.1 in full: matrix, event-armed, snapshot v11 + delta, merge function, prepare steps, consensus row with basis | — | Electron + Worker |
| B | §4.2 in full: identity migration, roads, content eligibility, PDF, URL, IR page, weak-pair gate registration | — | Electron |
| C | §4.3: go request, effective window, extend, scheduler | B | Electron |
| D | §4.4: facts, callouts, read, generation lease, data-flow tests | B | Electron |
| E | §4.5: post-print sheet, send service with nudge and `delivery_unknown` | D (sheet) | Electron |
| F | §4.6 and §4.7: Today layout, Hub controller, extra metric lines | B, C, D for the expansion; the removals may land first | Electron |

A and B are built first, in parallel, each in its own sibling worktree with its own `writing-plans` pass, subagent-driven implementation, Codex review of the plan (one round each; they are single-subsystem plans), a whole-branch review, E2E on the sandbox, and its own merge and deploy. C through F follow in dependency order. Each slice's plan enumerates the exact call sites, migration SQL, and tests from this design; this document is not re-opened for them unless a slice discovers a design conflict, in which case the conflict is recorded here and in `DECISIONS.md`.
