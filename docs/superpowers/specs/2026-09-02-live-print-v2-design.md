# Live print v2 — design

**Date:** 2026-09-02 (rev 2, after Codex round 1)
**Status:** Codex round 2, then user review, then `writing-plans`
**Extends** `docs/superpowers/specs/2026-08-20-live-print-watch-design.md` (v1). v1 rulings stand unless restated here; where the shipped v1 code fell short of the v1 spec (document identity, IR adapter), this spec closes the gap rather than adding a second mechanism.

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
- Cloud parity: armed coverage reaches the Worker fallback now, through a snapshot version bump and the affected mirrors (Codex round 1, finding 3).
- PDF pair: the poppler-text and Claude-native readings of one PDF are a weak pair until a frozen PDF holdout passes the v1 green-precision gate. Until then PDF-only lines render in verify styling, never green (finding 4).
- Finnhub EPS consensus is shown in the bogey column labelled "vendor, basis unspecified" and never fills the adjusted-EPS expected value; Finnhub revenue consensus is the revenue bogey (finding 15).
- Callouts render single-source after mechanical verification, with a per-callout accept control; two independent documents are not required (finding 20.3, user overruled the stricter rule because wire copy and EDGAR exhibit are the same bytes).
- Today: Alerts and Nearby Levels leave the page. Significant Moves and Momentum Pulse move to Analysis. The Earnings Cockpit folds into the Earnings Hub rows as chips. The print-watch card becomes the armed Hub row's in-place expansion. Portfolio snapshot shrinks to one line. Week Ahead, Releases, IBKR today, and the chat button stay.

## 3. Goals and non-goals

**Goals.** (a) An armed name gets what a held name gets, automatically, from the moment it is armed, on the Mac and in the cloud fallback. (b) A release reaches the sheet by PDF, by pasted link, by a stored IR page, by the wire, or by EDGAR, whichever lands first, and identical bytes are counted once no matter how many roads deliver them. (c) Within seconds of the first parse the user sees a first-pass read against their own bogeys, on screen, inside Today, with every number computed deterministically and every quoted figure verified against stored text. (d) Paper and recap are one click each. (e) Today has one earnings surface.

**Non-goals (this session).** Push composer or push-gate changes. Unattended promotion (the v1 ruling that the user is the gate stands; the statistical corpus gate remains stage 2). Recap timing policy (ask (f)). Learned per-company line shapes (ask (d)); a manual extra-metrics field covers the immediate need. OCR for image-only PDFs (explicit refusal instead, see 4.2).

## 4. Design

### 4.1 Coverage: `armed` is an event-scoped status

**Definition.** `SymbolStatus` (`lib/queries/briefing-symbols.ts`) gains `armed`: the symbol (family-aware, like the other two) has at least one `calendar_events` earnings row with `event_date >= todayET()` and `superseded = 0` that carries an `earnings_worksheet_flags` row. Precedence: `held` > `watchlist` > `armed` > `neither`. The resolver also returns the reason set (`{ held, watchlist, armed }` booleans) so a caller can distinguish "armed and held" from "armed only" without re-querying. `todayET()` anchors the date; never `new Date().toISOString()`.

**Event-scoped consumers.** Where a consumer evaluates a specific event, it asks `isEventArmed(db, eventId)` (flag row exists for that event id) rather than the symbol status, so an armed Q3 print never widens coverage for an unrelated Q4 row of the same symbol.

**Consumer matrix.** Every call site changes deliberately, none by blanket substitution. `isCoveredStatus(s)` = held or watchlist or armed.

| Consumer | Today | v2 | Mirror |
|---|---|---|---|
| `lib/earnings/extract-newsletter-bogeys.ts:279` bogey scan filter | held/watchlist | covered | Mac only |
| `lib/earnings/bogeys-reminder.ts:65` missing-bogeys reminder | held/watchlist | covered | Mac only |
| `lib/calendar/verify-earnings-dates.ts:136` date verifier | held/watchlist | covered (manual rows still skipped by design) | Mac only |
| `lib/calendar/wire-probe.ts:69` pre-release Finnhub probe | held/watchlist | covered | Mac only |
| `lib/calendar/enrichment-runner.ts:849` enrichment candidate priority | held/watchlist | covered | Worker `enrich-actuals.ts` reads `armedSymbols` |
| `lib/calendar/enrichment-runner.ts:504` push-at-print gate | held/watchlist/read-through | **unchanged** | Worker `calendar-enrich.ts` unchanged |
| `lib/calendar/cloud-reconcile.ts:237` push on cloud reconcile | same as above | **unchanged** | — |
| `lib/alerts/read-through-push.ts:34` read-through target status | held/watchlist | **unchanged** (targets must be owned) | — |
| Email sweep candidate filter (`findEmailCandidates`, located in plan) | held/watchlist | covered (preview, recap) | Worker `fallback-earnings.ts` lines ~299 and ~589 read `armedSymbols` |
| `lib/earnings/wrap.ts:99` AMC wrap | held/watchlist | covered | Worker wrap path reads `armedSymbols` |
| `lib/earnings/debrief.ts:131` morning debrief | held/watchlist | covered | Worker debrief path, if present, reads `armedSymbols` |
| `lib/digest/todays-reporters.ts:65` digest reporters block | held/watchlist | covered | Worker `todays-reporters.ts` reads `armedSymbols` |
| `lib/digest/call-transcripts.ts:251`, `lib/transcripts/same-day.ts:287` transcripts | held/watchlist | covered | Mac only |
| `lib/queries/earnings-cockpit.ts:140`, `app/dashboard/today/EarningsHub.tsx:100` display | chip | chip shows `armed` when armed-only | — |

A repo guard test asserts every `getSymbolStatus` consumer appears in an allowlist that names its decision (covered, unchanged, display), so a new consumer must declare which it is.

**Snapshot v11 and Worker mirrors.** `scripts/snapshot-state-to-r2.ts` bumps `schemaVersion` to 11 and adds `armedSymbols: Array<{ symbol, eventDate }>` from the flags join (family expansion happens on read, as for the other sets). `workers/cron/src/state.ts` types it optional; each mirror in the matrix folds `armedSymbols` into its covered set exactly where it folds `watchlistSymbols` today, and a snapshot ≤ v10 degrades to held-plus-watchlist, the v8 and v10 precedent. The push gate in `calendar-enrich.ts` is not touched. Parity tests: for each mirrored site, an armed-only symbol passes on both sides with a v11 snapshot and fails on both with a v10 one.

**Correction survival.** `earnings_worksheet_flags.event_id` cascades on delete, and `correctEarningsEventDate` repoints bogeys, emails, and skips but not flags. v2: the correction and `reconcileEarningsDates` repoint the flag row, its prepare state (4.1 below), and the print's `event_id` to the surviving row inside the same transaction, with a test that arms, corrects the date, and asserts the new row is armed, prepared, and attached to the same print.

**Prepare pass on arm.** `armWorksheet` stays a pure mutation. Arming enqueues `prepareArmedEvent(db, eventId)` (`lib/earnings/prepare-armed-event.ts`) as durable work: a `prepare_state_json` column on `earnings_worksheet_flags` (migration 088) holds per-step status `{ step: pending | done | failed, at, note }` for the four steps below. The worksheet route runs the pass once immediately after arm; the earnings sweep re-runs any `pending` or `failed` step on every tick until the event, so a process exit cannot lose it. Steps are individually idempotent:

1. Newsletter rescan: `extractBogeysForSymbol(db, symbol, eventId, { sinceDays: 14 })` walks articles from the last 14 days mentioning the symbol. A new table `earnings_bogey_scans` (migration 088) is the ledger: `(event_id, article_id, extractor_version) PK, outcome: hit | no_numbers | error, model_id, scanned_at`. An article is billed at most once per event per extractor version; re-arm and repeat go re-scan nothing already ledgered. The existing global `processed` marker is untouched.
2. Sell-side consensus row: when the event carries Finnhub consensus, upsert one bogey row keyed `(event_id, 'finnhub', 'Sell-side consensus (Finnhub)')` with `revenue_consensus_usd` and a new `eps_consensus_basis = 'vendor_unspecified'` (migration 088) beside `eps_consensus`; `compileContracts` sets the revenue expected value from it and never the adjusted-EPS expected value when the basis is unspecified. The Hub bogey column, the sheet, and the paper sheet label the EPS figure "vendor, basis unspecified". The row refreshes in place when the consensus changes.
3. Intel: `refreshEarningsIntel(db, eventId)`.
4. Contract id: `enrichSecurities(db, [securityId])` when `ib_con_id` is null and TWS is up; step stays `pending` while TWS is down.

The go action (4.3) re-runs the same function for anything not `done`. The row shows the four outcomes.

### 4.2 Acquisition roads and document identity

**Identity (closes v1 §4.3).** Documents dedupe on content: `UNIQUE(print_id, sha256)` replaces `UNIQUE(print_id, kind, sha256)`. Acquisition roads become provenance rows in a new table `print_watch_document_roads` (migration 088): `(document_id, kind, source, url, seen_at)`, one per delivery. The reconciler's independence test counts documents, so identical bytes from the wire, EDGAR, a pasted URL, and a file drop are one document and one piece of evidence. `kind` values: existing `dj-release`, `edgar-ex99`, `ir-page`, `user-drop`, plus `user-url`.

**PDF.** `ingestDocument` accepts a `%PDF-` buffer (the current refusal goes). Stored as `.pdf`. Before parsing: reject encrypted PDFs, PDFs over 10MB or 60 pages, and PDFs whose text layer is under 500 characters, each with its own message (image-only releases are refused, not OCR'd, this session). Two representations:

- `pdfText`: `pdftotext -layout` (poppler). Resolution order: `settings.pdftotext_path`, `/opt/homebrew/bin/pdftotext`, `/usr/local/bin/pdftotext`, `PATH`. DI spawn seam like `print-pdf.ts`, 30-second timeout, abort on timeout, output capped at the 2MB document ceiling. The text is persisted beside the bytes as `<sha>.pdftext.txt` and its hash recorded on the document row (`text_sha256`, migration 088) so the read (4.4) and the callout verifier work from stored text, never a re-run.
- `pdfNative`: the extraction prompt sent with the PDF as a Claude `document` block, the path `lib/research-documents/extract.ts` already uses. `extractCandidates` gains an input variant `{ kind: "pdf", bytes }`; prompt and parser unchanged.

Both candidates carry `weak_pair = true` (the reconciler's existing flag), so a PDF alone reaches `agreed (PDF), verify` styling and never green. A frozen holdout (ten real releases as PDFs, hand-labelled, stored under the gitignored fixtures tree) and a measurement script are plan tasks; the flag flips to independent only when that holdout meets the v1 gate, recorded in `DECISIONS.md`. The doc-to-event gate runs on `pdfText`. Poppler missing → the drop is refused naming the tool and the setting.

**URL.** `POST /api/print-watch/drop` accepts `{ eventId, url }`. `hardenedFetchBytes` (new beside `hardenedFetchText`) enforces: `https` only; no credentials in the URL; port 443 only; the host resolves (A and AAAA) only to globally routable addresses, rejecting loopback, RFC1918, link-local, ULA, IPv4-mapped, multicast, and cloud-metadata ranges; the resolved address is pinned for the request and every redirect hop re-validates host and address against the same rules (redirects capped at 3); `AbortSignal` with a 20-second total budget; response bytes capped at 10MB with a streaming cap; type decided by magic bytes (`%PDF-`, `<html`/`<!doctype`, else text) with the header as a hint only. Outcome copy names the road and the byte count. A 403 from a wire syndicator (BusinessWire returned 403 on 2026-09-02) is reported with the hint to paste the IR-site link or the EDGAR exhibit.

**Stored IR page.** `print_watch_sources` (migration 088): `symbol TEXT PRIMARY KEY, ir_page_url, link_must_contain TEXT NULL, created_at, updated_at`. `link_must_contain` is a literal substring, not a regex. Set from the "IR page" field on the armed Hub row, remembered for later quarters. Adapter `lib/print-watch/ir-page-adapter.ts::pollIrPage(cfg, seen, fetchFn, { baseline })`: fetch through `hardenedFetchBytes`, collect anchors, keep those whose text or href contains the literal (when set) and matches the fixed default earnings-headline pattern (a constant in code, not user input), resolve relative hrefs, return `{ link, title }`. The watcher follows new items whose host is the IR host or one of a fixed allowlist (businesswire.com, globenewswire.com, prnewswire.com, sec.gov) and ingests as `ir-page`. **Baseline at arm, persisted:** the prepare pass records every currently matching link in `print_watch_ir_seen` (migration 088: `(print_id, link) PK, seen_at, baseline INTEGER`), so a restart cannot forget the baseline and a late go never re-baselines. The doc-to-event period gate is the second guard. Polled in-window at the RSS lane's cadence; the NVDA RSS config keeps precedence.

### 4.3 The "print is live" action

**Durable request.** `POST /api/print-watch/go` `{ eventId, url?, filename?, contentBase64? }` → `requestGo(db, eventId, input)`: arm if not armed (and run the prepare pass), stamp `print_watch_prints.forced_open_at` once (a second press does not move it), insert a row in `print_watch_go_requests` (migration 088: `id, print_id, requested_at, input_ref NULL, consumed_at NULL, result_json NULL`), and, if a pasted input is present, ingest it immediately in the requesting process (the drop path, which already handles lease-blocked parsing). The lease owner consumes open go requests on its next tick, at most 2 seconds away in the hot state, runs one acquisition pass, and writes `result_json` = per-road `{ road, outcome, detail }`. The route returns `{ requestId, forcedOpenAt, ingest }` and the row polls the request result, so the response is never a guess about work another process will do.

**Effective window, one definition.** `effectiveWindow(print)` in `lib/print-watch/window.ts` returns `[start, end]` = `[min(scheduledStart, forcedOpenAt − 60m), max(scheduledEnd, forcedOpenAt + 90m)]`, where the scheduled bounds are the v1 `[release − 30m, release + 45m]` or absent for an unresolved TAS row. `desiredState`, `ensurePrintWatch`, `pollOnce`, the DJ query bounds, and the EDGAR window all call it; nothing else computes a window. The 60-minute lookback before a forced open covers a press that landed before the user pressed the button. Extending the window is an explicit "Extend 30 min" control that writes `window_extended_until` (migration 088); pressing go again never extends.

**One acquisition queue.** Source polling is serialised per print through an acquisition queue distinct from the existing parse-and-write queue: the loop's tick and a go pass both enqueue `acquireOnce(printId, reason)`, so a manual pass can never overlap a scheduled poll against TWS or the SEC. The global rate governor from v1 §4.2 is unchanged.

### 4.4 The first-pass read

**Deterministic facts first.** `buildReadFacts(db, printId)` (pure, `lib/print-watch/read-facts.ts`) produces the scoreboard from validated rows only: for each sheet line with a value, `{ metric_id, label, state, actual, actual_high, expected_consensus, expected_whisper, expected_source, delta_pct, verdict }`, where `delta_pct` and `verdict` (beat, inline within ±0.5%, miss, n/a) are computed in code from the line value and the bogey expected values, and the adjusted-EPS delta is `null` when the only consensus has an unspecified basis. No model output ever overwrites a fact.

**Callouts, verified.** The model may propose callouts for figures the bogey guidance text names but the sheet has no line for. Each proposal is `{ label, value_text, snippet, doc_id, vs_bogey_text }`. `verifyCallout` re-parses: the snippet must occur verbatim in that document's stored text (`pdftext` or the raw-text representation), and the numeric value must parse from within the snippet with the same unit; anything else is dropped before storage. A verified callout renders with a single-source label and the same accept control as a sheet line; accepted callouts persist in `print_watch_callouts` (migration 088) and appear on the paper sheet.

**Prose.** The model receives the facts (scoreboard, verified-eligible snippets, bogey guidance text, the user's event notes, last quarter's actuals and reaction, implied move) and returns prose only: `read` (6 to 10 lines), `call_watch` (exactly 3), `caveats`. Schema via `generateObject` with `additionalProperties: false` on every object node; arrays guarded with `Array.isArray`; prose sanitised at storage and at render. Prompt-injection guard: document text reaches the model only inside a delimited data block with the instruction that it is quoted evidence, and any prose line that contains an instruction-like directive is dropped at storage (the existing sanitiser rule for model prose).

**Identity and concurrency.** The fingerprint is a SHA-256 over a canonical, versioned snapshot of every prompt input: `PROMPT_VERSION`, `SCHEMA_VERSION`, model id, sorted line tuples (metric, value, value_high, state), sorted accepted document hashes and their `text_sha256`, sorted bogey rows' `updated_at`, notes text hash, extra-metrics JSON, intel and history values. `print_watch_reads` (migration 088): `id, print_id, fingerprint, nonce, status: generating | done | failed, model_id, facts_json, prose_json, generated_at`, `UNIQUE(print_id, fingerprint, nonce)`. Generation is a database claim: insert `generating` (nonce 0 for automatic runs; a regenerate press uses nonce = previous + 1), and a second process that finds the row skips. Scheduling happens after the parse transaction commits, from a post-commit hook outside the write chain (never from inside `drainQueue`), debounced 5 seconds per print in the lease owner. Failure marks the row `failed`; the sheet is untouched; the row offers retry.

**Privacy.** The stored read, the callouts, and every curated bogey are portfolio-derived private text: rendered inside `<PrivateText>`, never logged beyond an id, never written to the R2 snapshot, never committed. User notes already flow to the model for previews and recaps (v1 §15 notes-are-sacred); nothing new leaves the Mac. The recap composer receives only the deterministic facts that are already direction-safe by the outbound rule (verdict words, no counts, no cost basis), never the prose or the notes.

**Model.** New feature key `printWatchFirstPass: "anthropic/$frontier"` in `lib/ai/models.ts`; extraction stays on the workhorse tier. Never a model id in code.

### 4.5 Outputs are buttons

- **Print sheet** → `POST /api/print-watch/print-sheet { printId }` → `composePostPrintSheetHtml` (new template in `lib/earnings/print-sheet.ts`: scoreboard, accepted callouts, read, bogeys by source, notes) → existing `renderHtmlToPdf` → `printPdfViaLp`, existing monospace fallback and one-sheet ladder. Disabled with the reason when no line has a value.
- **Promote** → existing accept route, unchanged.
- **Send recap now** → `POST /api/print-watch/send-recap { printId }`. Refuses with domain copy unless the headline pair is accepted and promoted. Otherwise it calls `sendEarningsCandidate(db, candidate, opts)`, a function extracted from the sweep's per-candidate body so the sweep loop and the nudge run the identical steps: cloud-sent check, claim, mute and skip rules, wrap-pending rule, send, mac-sent marker, claim clear in `finally`. The nudge does not run the sweep's global phases. It returns the exact outcome `{ sent | in_progress | already_sent | refused: reason }` and the row renders it verbatim. The single-send-path invariant holds because both callers share the extracted function.

### 4.6 Today layout

- `app/dashboard/today/page.tsx`: remove the Alerts block and `NearbyLevelsCard` (both remain on `/dashboard/alerts`, the bell, and the security page); remove `EarningsCockpit` and `PrintWatchPanel` as blocks; snapshot to one line.
- `SignificantMovesCard` and `MomentumPulse` move to the top of the Analysis `diagnostics` view, unchanged internally.
- **Hub controller.** `EarningsHub` becomes a server component that renders initial rows plus a client controller `EarningsHubLive` that owns every poll the cockpit and the print panel own today: print-watch status (hot 2s, cool 30s), the 60-second `/ensure` keep-alive, the cockpit's intel refresh on its existing cadence, and the mutation-event re-fetch. Rows carry stable `eventId` and `printId`. Cockpit chips (preview, act, recap, implied move) come from `buildCockpitPayload` computed for the Hub's full week, not only today and yesterday. The email tri-state helpers move with the chips.
- **Expansion.** An armed row renders a full-width sibling element below the ten-column grid row (desktop) or below the card (mobile): `LivePrintRow`, holding the moved `PrintCard`/`LineRow`, the IR-page field, the prepare status, the go button and paste box, the road outcomes, the read, and the buttons. Auto-expansion is transition-based: the row expands when its print state changes into `window_open`, `acquired`, or forced, and when a go request is created; a `parsed` print does not auto-expand on page load. A manual toggle overrides either way and is remembered per print in `localStorage`. Polling frequency follows the print state, not the expansion.
- Mobile: the same controller; the read and buttons are full-width; paper printing stays Mac-side. Chat rail open at 1280 must not reflow the expansion (E2E gate).

### 4.7 Extra metric lines

`earnings_bogeys.extra_metrics_json` (migration 088): `[{ id: uuid, label, definition, unit: usd | per_share | pct | count, kind: point | range, period: Q | NQ_guide | FY_guide, basis: gaap | non_gaap | na, consensus?, whisper? }]`. `compileContracts` emits one line per `id` (`x_<uuid8>_<period>`), so a label edit never re-keys a line. Merging across bogey rows: same `id` merges first-non-null; different `id`s with the same label but different unit, kind, period, or basis are a contract conflict and neither compiles until resolved in the modal (the modal shows the conflict). Recompile is explicit and transactional: `recompileContracts(db, printId)` adds new lines, keeps every line that has evidence or acceptance, and marks lines whose contract vanished `retired` (new state, migration 088) rather than deleting them. `BogeysEditModal` gets a repeatable "Extra metric" group.

## 5. Data changes (migration 088, one file)

- `print_watch_documents`: rebuild to `UNIQUE(print_id, sha256)`, add `text_sha256 TEXT NULL`, widen `kind` CHECK with `user-url`. Because `print_watch_lines.source_doc_id` references this table, the migration rebuilds parent then child inside the runner's transaction: create `print_watch_documents_new` with the new constraints, copy rows preserving ids (dedupe same-hash rows per print into the lowest id and record the dropped rows' roads in the new roads table), create `print_watch_lines_new` referencing the new parent, copy, drop old, rename, recreate indexes, then `PRAGMA foreign_key_check`. Rehearsed on a VACUUM copy of the live DB with a before/after row-count and evidence-hash assertion.
- New: `print_watch_document_roads`, `print_watch_sources`, `print_watch_ir_seen`, `print_watch_go_requests`, `print_watch_reads`, `print_watch_callouts`, `earnings_bogey_scans`.
- `print_watch_prints`: `forced_open_at TEXT NULL`, `window_extended_until TEXT NULL`.
- `print_watch_lines.state` CHECK gains `retired` (part of the same rebuild).
- `earnings_bogeys`: rebuild to widen `source` CHECK with `'finnhub'`, add `eps_consensus_basis TEXT NULL`, `extra_metrics_json TEXT NULL`; every post-043 column is carried (the rebuild copies by explicit column list generated from `PRAGMA table_info` at migration-authoring time and asserted in a test against the live schema).
- `earnings_worksheet_flags`: `prepare_state_json TEXT NULL`.
- Snapshot `schemaVersion` 11 with `armedSymbols`.

## 6. Routes (thin, human-auth through the proxy, envelope `{success, data|error}`)

`POST /api/print-watch/drop` (adds `url`); `POST /api/print-watch/go`; `GET /api/print-watch/go?requestId=`; `POST /api/print-watch/read` (regenerate); `POST /api/print-watch/callouts/accept`; `POST /api/print-watch/print-sheet`; `POST /api/print-watch/send-recap`; `POST /api/print-watch/extend`; `PUT /api/print-watch/sources`; `POST /api/earnings/worksheet` (arm schedules the prepare pass and returns its state). `GET /api/print-watch/status` adds `roads`, `read`, `callouts`, `prepare`, `forcedOpenAt`, `windowExtendedUntil`, and open go requests; it stays a pure read.

## 7. Failure modes, stated

- Poppler missing, encrypted PDF, image-only PDF, oversize PDF → refused with a specific message; HTML and URL roads unaffected.
- IR page changes shape → "IR: 0 matching links"; wire, EDGAR, and paste roads still run.
- Pasted URL blocked by the SSRF contract, 403, or wrong type → the road outcome names the reason and suggests the IR-site or EDGAR link.
- TWS down at go → wire road `skipped: TWS offline`; the forced window keeps EDGAR and IR polling; the conId step stays pending.
- Model call fails for the read → row marked `failed` with retry; the sheet and greening are unaffected.
- Another process holds the lease → the go request waits for the owner; the row shows "queued to the watcher"; a pasted input still parses when the owner drains it.
- A date correction while armed → flag, prepare state, and print follow the surviving row.

## 8. Testing

TDD per module, in-memory SQLite, DI seams (spawn for poppler, fetch and DNS resolution for URL and IR page, model for the read, `lp` for paper, clock for windows):

- Coverage matrix: one test per consumer row asserting the declared decision; `armed` is ET-anchored (a flag on yesterday's event at 23:30 ET does not count); armed for one event does not cover another event of the same symbol via the event-scoped check; the allowlist guard.
- Snapshot v11 and mirrors: v11 with an armed-only symbol passes each mirrored filter; v10 degrades to held-plus-watchlist; the push gate ignores `armedSymbols` on both sides.
- Correction survival: arm → correct date → new row armed, prepared, same print id; reconcile path likewise.
- Prepare: ledger prevents a second bill per article; steps retried by the sweep after a simulated process exit; consensus row basis and labels; runs with TWS down.
- Identity: the same bytes via drop, URL, and EDGAR produce one document with three road rows and count once in the reconciler; the migration dedupes existing duplicates and preserves line evidence; `foreign_key_check` clean on a populated copy; rollback leaves the old tables intact.
- PDF: synthetic PDF fixture with a known text layer (generated by a tiny in-repo writer, no real filings committed); both readings produce candidates; the pair never greens (weak pair); refusals for encrypted, image-only, oversize; persisted text and hash.
- URL: every SSRF rule (http, credentials, port, loopback, RFC1918, link-local, ULA, mapped, metadata, redirect to a private address, DNS returning both a public and a private record); abort on timeout closes the socket; magic-byte sniff beats a wrong header.
- IR page: literal filter, default pattern, relative links, wire-host allowlist, baseline persisted across a simulated restart, late go does not re-baseline.
- Go: forced window with lookback catches a release 25 minutes before the press; second press does not move the stamp; extend writes the column; request consumed by a second process holding the lease; acquisition queue serialises a go pass against a loop tick.
- Read: facts computed in code and stable; callout verifier drops a snippet not in stored text and a value not in the snippet; fingerprint stable across refresh and changed by accept; two processes race a generation and exactly one model call happens; regenerate creates nonce+1; failed row retryable; injection-like prose dropped.
- Buttons: print-sheet composes and falls back; send-recap refuses before promote, sends after, returns the exact outcome, respects the claim and the wrap-pending rule; a concurrent regular sweep and a nudge send once.
- Today: page renders without the removed blocks; Hub rows carry cockpit chips for the full week; transition-based expansion; manual toggle persistence; Analysis diagnostics renders the two moved cards; desktop 1280 with chat rail open, and mobile widths.
- Privacy gates: a static test that `print_watch_reads` and `print_watch_callouts` never appear in the snapshot script, logs redact to ids, and the recap input builder rejects prose fields.

End-to-end on the `:3095` sandbox recipe with the 2026-09-02 SNOW documents kept in the gitignored fixtures tree: PDF drop, URL drop, IR-page scan against a fixture page, go with TWS down, the read appearing, print-sheet to a mocked `lp`, promote, send-recap nudge, a second-process go request. Screenshots and logs from the rehearsal are checked for private text before anything is committed. Then `verify:changed`, the full suite, `next build`, Electron redeploy, Worker deploy for the mirrors.

## 9. Rulings on Codex round-1 open questions

1. Precedence stays `held` > `watchlist` > `armed`; the resolver exposes the reason set.
2. The first go stamps once; extension is an explicit control; a repeat press never extends.
3. Callouts: mechanical verification plus single-source label plus per-callout accept (user ruling, overrides the two-document rule).
4. IR page: fixed minimal wire-host allowlist plus the IR host; user input is a literal substring, never a pattern.
