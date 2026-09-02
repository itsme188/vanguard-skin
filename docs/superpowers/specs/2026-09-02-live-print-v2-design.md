# Live print v2 — design

**Date:** 2026-09-02
**Status:** draft for Codex review, then user review, then `writing-plans`
**Supersedes nothing.** Extends `docs/superpowers/specs/2026-08-20-live-print-watch-design.md` (v1). v1 rulings stand unless restated here.

## 1. Why now

Two live runs of print-watch v1 are on record. The first (2026-08-26/27, three prints) captured every release at the wire minute. The second (2026-09-02, one print) missed the release on both automatic lanes and was recovered by a manual drop from a Claude Code session, twenty-five minutes after the wire. The user ran the trade entirely outside the app. The post-mortem found:

1. The name was a same-day manual add, not held and not watchlisted. Every automatic earnings behaviour keys on `getSymbolStatus` returning `held` or `watchlist`, so the newsletter bogey scan never looked at it, the push gate would never have fired, and the security row had no IBKR contract id, which turned the Dow Jones wire lane off. (Contract-id backfill landed 2026-09-02, `f691229`.)
2. The EDGAR lane parsed the SEC feed's acceptance time as UTC. That feed reports fresh filings as Eastern wall-clock with a bogus `Z` and normalises them to true UTC later. (Fixed 2026-09-02, `6628dd4`; the filing header is now authoritative.)
3. The drop zone accepts HTML and text only. The user has asked for PDF since the first live run (TODO 2026-08-27, ask (a), top priority; deferred 2026-08-28 to "next feature session", which did not happen).
4. Nothing happens on screen, on paper, or by email at the moment the sheet fills. The only instant surface is a panel the user must already be watching; the push rides a 10-minute Finnhub poll and the recap rides a 15-minute sweep tick.
5. The sheet had no line for the metric the name is actually traded on (product-revenue guidance), because contract lines derive only from structured bogey fields.

## 2. Decisions taken in the 2026-09-02 session (user rulings)

- Arming a worksheet means "I care about this print". It is the coverage signal.
- PDF drop ships. URL drop ships and is the preferred manual road. Both roads: a stored per-company IR page the watcher scans, and a paste box for the exact link or file when the user has it.
- A user-triggered "print is live" action acquires from every road at once and starts processing.
- The first output is the on-screen first-pass read. Paper and email are buttons pressed afterwards, never automatic.
- Push notifications are unchanged this session.
- Today: Alerts and Nearby Levels leave the page. Significant Moves and Momentum Pulse move to Analysis. The Earnings Cockpit folds into the Earnings Hub rows as chips. The print-watch card becomes the armed Hub row's in-place expansion. Portfolio snapshot shrinks to one line. Week Ahead, Releases, IBKR today, and the chat button stay.

## 3. Goals and non-goals

**Goals.** (a) An armed name gets everything a held name gets, automatically, from the moment it is armed. (b) A release reaches the sheet by PDF, by pasted link, by a stored IR page, by the wire, or by EDGAR, whichever lands first. (c) Within seconds of the first parse the user sees a first-pass read against their own bogeys, on screen, inside Today. (d) Paper and recap are one click each. (e) Today has one earnings surface.

**Non-goals (this session).** Push composer changes. Unattended promotion (the v1 ruling that the user is the gate stands; the statistical corpus gate remains stage 2). Recap timing policy (ask (f)). Learned per-company line shapes (ask (d)); a manual extra-metrics field covers the immediate need. Worker-side mirrors: everything here is Mac-only, so no parity pins change.

## 4. Design

### 4.1 Coverage: `armed` is a status

`SymbolStatus` (`lib/queries/briefing-symbols.ts`) gains a fourth value `armed`: the symbol has an earnings event on or after today with an `earnings_worksheet_flags` row (family-aware like the other two). Precedence stays `held` > `watchlist` > `armed` > `neither`. A single predicate `isCoveredStatus(s)` returns true for the first three. Every gate that today spells `status === "held" || status === "watchlist"` switches to the predicate: the newsletter bogey scan, the print push gate, the date verifier's candidate filter, the email sweep's candidate filter, the enrichment runner's push branch, the preview composer, and the Hub status chip (which renders "armed" as its own chip). Call sites are enumerated in the plan from `grep getSymbolStatus` (17 today); each becomes a one-line change plus a test that an armed-only symbol passes.

**Prepare pass on arm.** `armWorksheet` stays a pure mutation. The worksheet route, after a successful arm, schedules `prepareArmedEvent(db, eventId)` (new, `lib/earnings/prepare-armed-event.ts`), which runs in the background and is idempotent:

1. Newsletter rescan: `extractBogeysForSymbol(db, symbol, eventId, { sinceDays: 14 })`, a per-symbol variant of the existing extractor that walks articles from the last 14 days mentioning the symbol (`isSymbolMentioned`), skipping any article that already produced a bogey row for this event. Same prompt, same parser, same upsert.
2. Sell-side consensus row: when the event carries `consensus_value` (Finnhub) or `consensus_estimate`, upsert one bogey row with `source = 'finnhub'`, `source_label = 'Sell-side consensus (Finnhub)'`, EPS and revenue consensus only, never a whisper. Migration 088 extends the `earnings_bogeys.source` CHECK constraint with `'finnhub'`. The Hub's bogey column and the print sheet label it as consensus, never as buyside. Re-run refreshes the row in place when the consensus changes.
3. Intel: `refreshEarningsIntel(db, eventId)` (existing) so the straddle and implied move exist.
4. Contract id: `enrichSecurities(db, [securityId])` when `ib_con_id` is null and TWS is up (the watcher also does this; running it here makes the wire show "armed" immediately).

The same function runs again from the "print is live" action for anything still missing. Outcomes are written to a `prepare_json` column on `earnings_worksheet_flags` (migration 088) so the row can show what it has: bogeys from N sources, consensus row present, intel present, wire armed.

### 4.2 Acquisition roads

All roads end in `ingestDocument(db, printId, kind, source, url, buf)` and the existing gate, parse, and reconcile. New document kinds: `user-pdf`, `user-url`, `ir-page`.

**PDF.** `ingestDocument` accepts a `%PDF-` buffer (the current refusal is removed). Stored as `.pdf` under the print's directory. Two representations feed the extractor, so two readings of one PDF can green under the existing reconciler rule:

- `pdfText`: `pdftotext -layout` output (poppler, present at `/opt/homebrew/bin/pdftotext` on the desk Mac). Resolution order: `settings.pdftotext_path`, then `/opt/homebrew/bin/pdftotext`, `/usr/local/bin/pdftotext`, then `PATH`. Invoked through a DI spawn seam like `print-pdf.ts`, 30-second timeout, output capped at the existing 2MB document ceiling.
- `pdfNative`: the same extraction prompt sent with the PDF as a Claude `document` block (`media_type: application/pdf`), the path `lib/research-documents/extract.ts` already uses. `extractCandidates` gains an input variant `{ kind: "pdf", bytes }` beside the current text form; the prompt and the output parser are unchanged.

The doc-to-event gate runs on the `pdfText` output. When poppler is missing the drop is refused with a plain message naming the missing tool and the setting; it does not fall through to a single-representation parse, because a PDF that can never green would sit at "verify" forever and the user would not know why.

**URL.** `POST /api/print-watch/drop` accepts `{ eventId, url }` as an alternative to `{ filename, contentBase64 }`. The lib fetches through the hardened fetcher with the URL's own host as the redirect boundary (a new `hardenedFetchBytes` beside `hardenedFetchText`, same caps, content-type `text/html`, `application/xhtml+xml`, `application/pdf`, or `text/plain`). Guards: `https` only; the host must not resolve to loopback, RFC1918, link-local, or the app's own hosts (the fetch runs on the server, so a pasted URL is an SSRF surface); 10MB cap. The response bytes go through the same sniff as a file drop (HTML, text, or PDF). Outcome copy names the road: "fetched 613KB HTML from ir.example.com, parsing". A 403 from a wire syndicator (BusinessWire returned 403 to a plain fetch on 2026-09-02) is reported as such with the hint to paste the IR-site link or the EDGAR exhibit instead.

**Stored IR page.** New table `print_watch_sources` (migration 088): `symbol TEXT PRIMARY KEY, ir_page_url TEXT NOT NULL, link_pattern TEXT NULL, created_at, updated_at`. Set from an "IR page" field on the armed Hub row, remembered for every later quarter. A new adapter `lib/print-watch/ir-page-adapter.ts`, `pollIrPage(cfg, seenLinks, fetchFn, { baseline })`, fetches the page through the hardened fetcher, collects anchors (`href` plus text), keeps those whose text or href matches `link_pattern` or the default earnings-headline pattern (`(reports|announces|delivers|posts)\b.*\b(first|second|third|fourth)[- ]quarter|\bq[1-4]\b.*(fy|fiscal)?\s*20\d\d|quarterly (financial )?results`, case-insensitive), resolves relative hrefs, and returns `{ link, title }` items. The watcher follows each new item with `hardenedFetchBytes` (same-host, or a wire host in a short allowlist: businesswire.com, globenewswire.com, prnewswire.com) and ingests as `ir-page`. Baseline pass at arm marks every current match seen, so last quarter's release cannot green; the doc-to-event period gate is the second guard. Polled in-window on the RSS lane's cadence; the existing NVDA RSS config is unchanged and takes precedence when both exist. Coverage note: "IR: ir.example.com armed" / "IR: no page on file".

### 4.3 The "print is live" action

`POST /api/print-watch/go` with `{ eventId, url?, filename?, contentBase64? }` → `goLive(db, eventId, input)` in `lib/print-watch/go.ts`:

1. If the event is not armed, arm it (the button lives on the row; pressing it is the strongest possible "I care") and run the prepare pass.
2. Force the window open: `print_watch_prints.forced_open_at` (migration 088) is stamped; the watcher's window predicate becomes "inside the scheduled window OR within 90 minutes of `forced_open_at`". A print with no resolved release time (TAS) gets a window this way for the first time.
3. Run one immediate acquisition pass across every road (`pollPrintOnce(printId)`, a watcher seam that the loop and this route share): DJ wire when TWS is up, EDGAR, IR page when on file, RSS when configured. Then ingest the pasted input, if any. Each road reports `{ road, outcome, detail }` and the response carries the list, so the row can show "wire: TWS offline, skipped · EDGAR: 0 filings · IR page: 1 new link, parsing".
4. The loop continues at the hot cadence. Pressing again re-runs step 3. The lease rule is unchanged: if another process owns the watcher the pass is queued to it and the response says so.

### 4.4 The first-pass read

**Trigger.** After any parse completes (end of `drainQueue`) or any accept/unaccept, the watcher calls `maybeGenerateFirstPass(db, printId)` on the print's own write queue, debounced 5 seconds. It runs when at least one line carries a value and the input fingerprint changed. Single-source is enough; the read is labelled accordingly.

**Inputs.** Sheet lines (metric, value, state, source doc); every bogey row for the event (source label, consensus, whisper, segments, guidance text, notes); the extra-metric lines (4.7); the user's own event notes (`earnings_call_notes` and worksheet notes); the release text (the `pdfText` or raw-text representation of the newest accepted-through-gate document, capped at 60k characters, tables first); last quarter's actuals and reaction from `earnings_report_history`; implied move and straddle from `earnings_intel`.

**Output** (JSON via `generateObject` with `additionalProperties: false` on every object node, arrays guarded with `Array.isArray`, prose sanitised at storage and render):

- `scoreboard[]`: `{ metric_id, label, actual, actual_high, bogey_consensus, bogey_whisper, bogey_source, delta_pct, verdict: beat | inline | miss | na, note }`, one per sheet line with a value.
- `callouts[]`: `{ label, value_text, snippet, doc_id, vs_bogey_text }` for numbers the bogey guidance text names but the sheet has no line for, each with the verbatim snippet it came from.
- `read`: 6 to 10 short lines on beat quality, guide against bogeys, margin, and anything odd.
- `call_watch`: exactly 3 lines.
- `caveats`: what is unverified or single-source.

**Storage.** New table `print_watch_reads` (migration 088): `id, print_id, fingerprint, model_id, output_json, generated_at`, one row per fingerprint, newest wins. Fingerprint = SHA-256 over line values and states, accepted document ids, bogey rows' `updated_at`, notes hash, extra-metrics JSON. A page refresh reads the stored row; nothing re-bills. A "Regenerate" button forces a new row.

**Model.** New feature key `printWatchFirstPass: "anthropic/$frontier"` in `lib/ai/models.ts` (one call per print, a few per week). Extraction stays on the workhorse tier. Never a model id in code.

**Rendering.** Under the sheet inside the expanded row: scoreboard table, callouts with their snippets in a quote style, the read, the three call-watch lines, caveats. Header chip "First pass — unverified until you accept", turning to "First pass — N of M lines accepted" as lines are accepted. Notes-derived text renders inside `<PrivateText>`; bogeys and actuals are public market data and render plain. The read never promotes anything.

### 4.5 Outputs are buttons

Rendered under the read, each one click, each with honest no-op copy:

- **Print sheet** → `POST /api/print-watch/print-sheet { printId }` → `composePostPrintSheetHtml` (new template in `lib/earnings/print-sheet.ts`: scoreboard, callouts, read, bogeys by source, notes) → the existing `renderHtmlToPdf` → `printPdfViaLp`, with the existing monospace fallback and the one-sheet ladder. Disabled with the reason when no line has a value.
- **Promote** → existing accept route behaviour, unchanged.
- **Send recap now** → `POST /api/print-watch/send-recap { printId }` → refuses (409, domain copy) unless the headline pair is accepted and promoted; otherwise calls `runEarningsEmailSweep({ nudgeEventId })`, a scoped immediate run of the single sweep that respects the claim mutex and the Mac-first markers. The recap composer gains the stored first-pass read as an input section. Copy after success: "Recap queued, sending now" and the emails chip updates on the next poll.

### 4.6 Today layout

- `app/dashboard/today/page.tsx`: remove the Alerts block and `NearbyLevelsCard` (both remain on `/dashboard/alerts`, the bell, and the security page); remove `EarningsCockpit` and `PrintWatchPanel` as standalone blocks; snapshot to a single line.
- `SignificantMovesCard` and `MomentumPulse` move to the Analysis tab, top of the `diagnostics` view, unchanged internally.
- `EarningsHub`: each row gains the cockpit's stage chips (preview, act, recap, implied move) from `lib/queries/earnings-cockpit.ts`, fetched alongside the hub rows; the cockpit's own poll goes away. An armed row gains the IR-page field, the prepare status, and the "Print is live" button. When its print is hot (window open, forced, acquired, or parsed) the row expands in place into `LivePrintRow` (the current `PrintCard` and `LineRow`, moved out of `PrintWatchPanel.tsx`, plus the paste box, the road outcomes, the read, and the buttons); a toggle expands or collapses it by hand. The 60-second `/ensure` keep-alive and the hot/cool polling move with it.
- Mobile: the same row renders as the existing `MobileCard` plus the expansion; the read and buttons are full-width. Paper printing stays Mac-side.

### 4.7 Extra metric lines

`earnings_bogeys.extra_metrics_json` (migration 088): `[{ label, definition, unit: usd | per_share | pct | count, kind: point | range, period: Q | NQ_guide | FY_guide, consensus?, whisper? }]`. `compileContracts` emits one `x_<slug>_<period>` line per entry, merged across bogey rows first-non-null like segments. `BogeysEditModal` gets a repeatable "Extra metric" group (label, definition, unit, period, consensus, whisper). This is how a billings line or a product-revenue guidance line exists before learned shapes.

## 5. Data changes (one migration, 088)

- `print_watch_sources` (new): `symbol PK, ir_page_url, link_pattern NULL, created_at, updated_at`.
- `print_watch_reads` (new): `id PK, print_id FK, fingerprint, model_id, output_json, generated_at`, index on `(print_id, generated_at)`.
- `print_watch_prints.forced_open_at TEXT NULL`.
- `print_watch_documents.kind`: new values `user-pdf`, `user-url`, `ir-page` (extend the CHECK constraint if the column carries one; otherwise only the TypeScript union changes).
- `earnings_bogeys.source` CHECK extended with `'finnhub'`; `earnings_bogeys.extra_metrics_json TEXT NULL`.
- `earnings_worksheet_flags.prepare_json TEXT NULL`.

## 6. Routes (thin, human-auth through the proxy, envelope `{success, data|error}`)

- `POST /api/print-watch/drop` — adds `url`. `POST /api/print-watch/go` — new. `POST /api/print-watch/read` — regenerate. `POST /api/print-watch/print-sheet`. `POST /api/print-watch/send-recap`. `PUT /api/print-watch/sources` — set or clear a symbol's IR page. `POST /api/earnings/worksheet` — arm now schedules the prepare pass and returns its initial status.
- `GET /api/print-watch/status` — adds `roads`, `read`, `prepare`, and `forced_open_at` to each print entry. Stays a pure read.

## 7. Failure modes, stated

- Poppler missing → PDF drops refused with the tool name and the setting; HTML and URL roads unaffected.
- IR page changes shape → "IR page: 0 matching links" on the row; the wire, EDGAR, and paste roads still run.
- Pasted URL 403 or off-type → the road outcome names the status and suggests the IR-site or EDGAR link.
- TWS down at go → wire road reports skipped; the forced window keeps EDGAR and IR polling.
- Model call fails for the read → the row shows "First pass unavailable, retry" and the sheet is untouched; the read is never on the critical path of acquisition or greening.
- Another process holds the watcher lease → go returns `queued`, as drops do today.

## 8. Testing

TDD per module, in-memory SQLite, DI seams (spawn for poppler, fetch for URL and IR page, model for the read, `lp` for paper):

- Coverage: an armed-only symbol classifies `armed`; each converted gate admits it; a disarmed symbol falls back to `neither`.
- Prepare pass: idempotent on re-run; consensus row labelled and never a whisper; rescan skips articles already attached; runs with TWS down (skips only the conId step).
- PDF: a committed synthetic PDF fixture with a known text layer (built by a tiny in-repo writer, no binary blob of real filings); `pdfText` and `pdfNative` both produce candidates and the pair greens; poppler-missing refusal copy; oversize refusal.
- URL: SSRF guard cases (http, loopback, RFC1918, own host); redirect boundary; content-type sniff to PDF and HTML; 403 copy.
- IR page: fixture listing pages (relative links, wire-host links, a prior-quarter link excluded by baseline); default pattern hits and misses.
- Go: forced window opens a TAS print; every road called once; pasted input ingested after the pass; queued when lease-blocked.
- Read: fingerprint stable across refresh, changes on accept; schema guards; no model call without a valued line; stored row rendered.
- Buttons: print-sheet composes and falls back; send-recap refuses before promote, nudges after; the sweep nudge respects the claim mutex.
- Today: page renders without the removed blocks; hub row carries cockpit chips; armed row expands when hot; Analysis diagnostics renders the two moved cards.
- Repo guard: a static test that no gate spells `"held" || "watchlist"` outside `isCoveredStatus`.

End-to-end on the `:3095` sandbox recipe with the 2026-09-02 SNOW documents: PDF drop, URL drop, IR-page scan against a fixture page, go with TWS down, the read appearing, print-sheet to a mocked `lp`, promote, send-recap nudge. Then `verify:changed`, the full suite, `next build`, Electron redeploy.

## 9. Open questions for Codex

1. Should `armed` outrank `watchlist` anywhere (the preview composer's "why this name" framing), or is the precedence above enough?
2. Is a 90-minute forced window the right ceiling, and should pressing go inside an already-open window extend it?
3. The read runs on single-source lines. Is the "unverified" chip enough, or should callouts require the snippet to appear in two documents before rendering?
4. The IR-page adapter's wire-host allowlist: keep it minimal, or allow any https host the IR page links to, given the doc-to-event gate?
