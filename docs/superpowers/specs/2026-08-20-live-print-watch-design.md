# Live Print-Watch — Design Spec

**Date:** 2026-08-20
**Status:** Draft v1.1 — architecture direction user-approved in session; Codex design review round 1 (REVISE, 23 findings) folded in below; two spikes outstanding (timestamp harness 2026-08-26, extraction bake-off). A revised schema + acceptance-test appendix is due after the spikes, before implementation (Codex finding 23 — agreed).
**Origin:** TODO item "(d) Post-print sequence: more automatic, less manual" — reframed in-session from "reduce manual touchpoints" to "make Portfolio Desk the print-time surface." Joint capability assessment: Claude (live probes against the user's own TWS account, DB, and EDGAR) × Codex (adversarial memo, session `01a020c3-84c3-7f73-b44b-c1e78c802d12`; design review `codex exec` 2026-08-20).

## 1. Problem

When an armed name prints, the user watches TWS wire headlines, opens the company's IR page or the wire, and hand-fills a printed line-by-line bogey sheet. That takes 3–4 minutes of matching press-release lines to bogey rows, under time pressure, with money on the line. Portfolio Desk currently plays no role at print time: its Finnhub road starts at T+5m on a 15-minute tick with 10-minute retry pacing and headline EPS/Rev only, and on four measured real prints first saw actuals 25–80 minutes after the wire.

**Goal:** within seconds-to-a-minute of the wire, the app shows the user's bogey sheet filling in on a live screen next to TWS, with per-line source provenance — turning 3–4 minutes of matching into a glance-and-verify loop.

## 2. Reliability contract (the SLO) — user-approved 2026-08-20

Not "99% autonomous." The approved contract:

- **≥99% precision among GREEN cells.** A cell renders green only when independently derived parses agree on value, sign, unit, basis (GAAP/non-GAAP), period, and source location — never on model self-confidence — AND the document passed the document-to-event validation gate (§4.4).
- **Explicit abstention.** Anything short of full agreement renders as a conflict (both candidates shown) or blank (`not_disclosed` is a first-class answer). Abstention is success, not failure.
- **Fast human verify.** Keyboard-first loop over the filled sheet (§4.5). Target: whole sheet verified well inside the current 3–4 minutes.
- **Catastrophic errors** (a green cell exhibiting one is an SLO breach, weighted far above a miss): wrong quarter/period column, wrong basis, wrong sign, wrong unit/scale, value from a superseded release version, value from a document that fails issuer/period validation.
- **Statistical go-live gate** (Codex 19): the GREEN claim is substantiated only by the bake-off — a frozen, labeled gold corpus (grown from a ~12-doc pilot toward 50–100 docs / 500–1,000 hand-verified lines, held-out split), per-error-class metrics (wrong value / basis / period / unit, unmatched, false-match scored separately), a minimum GREEN sample size before the precision estimate counts, and **zero catastrophic errors on the holdout as a release criterion**. Until the gate passes, everything renders as provisional/conflict — nothing greens.
- Rationale (Codex memo): 15 lines at 99% each ≈ 86% all-correct sheets. Only agreement-plus-abstention makes 99% honest.

## 3. Evidence base (measured 2026-08-20, user's own account and names)

| Finding | Evidence |
|---|---|
| DJ-N (entitled via IBKR) carries the **verbatim press release at the wire minute**, body fetchable via `reqNewsArticle`, multi-part (`-2-`, `-3-`…) | HD 8/18 06:00:00 ET (11,410-char body pulled); XMTR (small cap) 8/04 07:05:00 in 5 parts; CRWD 6/03 16:05:00 in 7 parts |
| DJ flash bullets are a **second, independent same-minute source** | HD: ~20 bullets at 06:00 (EPS, adj EPS, sales, comps, full guidance ladder); NVDA 5/20: flashes at 16:20:00 matched DB-stored actuals exactly |
| DJ verbatim-release coverage is **per-company** | NVDA posts via its own newsroom — flashes + stories only on DJ. Hence per-symbol recon, not blanket assumption |
| **EDGAR 8-K acceptance: 2–15 min after wire** on 6 measured prints | CRWD +2m, U +3m, AKAM +7m, HD +10m, XMTR +10m, NET +15m. Submissions API updates sub-second after dissemination; the wire→filing gap is the variable (rule allows days; measured fast, keep measuring) |
| **Corrections happen live** | RBRK 6/04: `* Correct: … FY27 Rev` flash one minute after an erroneous line; wire-side typo (`ARR $1,854B` for $1.854B) in the same burst |
| Flash trickle vs release completeness | CRWD guidance flashes spread 16:05→16:14; the 16:05 verbatim release had everything at once |
| Entitlements (probe) | BRFG, BRFUPDN, DJ-N, DJ-RT, DJ-RTA, DJ-RTE, DJ-RTG, DJNL. TWS `reqHistoricalNews` walks BACKWARD from its first datetime param |

Codex memo verdicts adopted: web search is not sub-minute and never in the critical path; runtime computer-use never in the critical path; free wire RSS is trigger-grade until measured; licensed full-text feeds unnecessary — the DJ entitlement already is one; trigger ≠ source (only the exact release document is ever a factual source); a second-vendor parser is an eval candidate only if the bake-off shows decorrelated errors.

## 4. Architecture

Mac-only, in-process (the always-on Electron server; the 15-minute launchd tick cannot drive this). No Worker mirror by design: if the Mac is closed the user is not at the desk, and the existing pipeline remains the slow path. Everything below is additive; the existing Finnhub enrichment road is untouched and becomes the checksum/reconciliation layer.

### 4.1 Arming and preflight recon

- Arming the existing worksheet (`armWorksheet`) also arms the print-watch — same gesture, no new manual step. (A separate watch-only toggle can come later.)
- On arm (and refreshed daily until the event), a **preflight recon** runs per symbol and renders a coverage card on the armed row: CIK mapping (SEC `company_tickers.json`); prior-quarter replay through `reqHistoricalNews` (verbatim release? flash burst?); EDGAR prior-quarter check (8-K + EX-99.1 present, measured acceptance lag); IR adapter status for names DJ doesn't carry verbatim.
- Coverage verdicts: **`automatic-qualified`** (named sources), **`manual-ready`** (drop zone primary; flashes/EDGAR assist), **`unsupported`**. Declared before the night.
- **Qualification is measurable and expiring** (Codex 22): `automatic-qualified` requires a successful prior-quarter replay of the NAMED sources within the last 2 quarters AND a passing recon re-check within 48h of the event; any recon failure or source drift automatically degrades the verdict to `manual-ready` (never silently stays qualified). The degradation renders on the card.

### 4.2 Armed window: detection + acquisition

From T−10m to T+45m past the resolved release time, per armed symbol, in parallel, each source isolated (one failure never kills the others; errors are logged as data):

1. **DJ-TWS adapter** (primary where qualified): `reqHistoricalNews` poll every ~10s on a dedicated client ID (not 0/1/2). New "Press Release:" item → fetch all parts via `reqNewsArticle`, stitch, hash. Flash bullets stream into their own provisional lane.
2. **EDGAR adapter** (always on): per-CIK submissions poll every 10s (declared User-Agent). New 8-K/6-K → filing index → EX-99.* download + hash. Authoritative version-of-record.
3. **IR adapter** (recon-qualified names only): plain HTTP feed/listing poll (no browser), against the host allowlist fixed at recon time (§4.8).
4. **Drop zone** (always armed): drag the release PDF/HTML onto the app → extraction starts immediately. The guaranteed road; the only road for `unsupported` names.
5. **Finnhub checksum** (existing road, unchanged): when its headline EPS/Rev arrives, compare against green/accepted cells — disagreement alerts, never overwrites.

Any source's first hit triggers a burst poll of the others. **Global scheduler** (Codex 14): one rate-limit/concurrency governor owns all outbound polling (SEC ≤2 req/s budget across CIKs, TWS request-id allocation from a reserved range, per-host backoff with 429/`Retry-After` respect, bounded concurrent downloads). Adapters request slots; they never self-schedule raw loops.

### 4.3 Document store: identity and versions

- **Stable print identity** (Codex 11): documents attach to a `print_id` (symbol + fiscal period), not directly to `calendar_events.id` — `correctEarningsEventDate` can DELETE and re-home event rows, and acquired evidence must survive that. The `print_id` row carries a repairable pointer to the current event id; no `ON DELETE CASCADE` from calendar_events to evidence.
- Every acquired document: raw bytes on disk (§4.8 storage policy), SHA-256, source, URL, first-seen wall clock + monotonic ms, declared kind (dj-release | dj-flash | edgar-ex99 | ir-page | user-drop), version_seq.
- **Multi-part completeness** (Codex 10): DJ parts persist individually; the assembled release is marked complete only when the part set is quiescent (no new part for 90s) or matches an expected-part count — version comparison and correction alarms operate on completed assemblies only, so trickling parts never masquerade as corrections.
- A completed assembly or re-fetch that hashes differently creates a new **version**; supersession is recorded as a chain (v1 ← v2), both retained and labeled.
- **Correction after green/accept/promote** (Codex 5): a new version invalidates every cell derived from the superseded version — green reverts to conflict-pending-reparse, accepted cells flip to `superseded — re-verify`, and promotion of affected values is blocked until re-verified. If values were already promoted, the sheet shows a prominent "promoted actuals may be stale" alarm and offers a one-click clear-and-reverify (never a silent overwrite).
- **Idempotence** (Codex 9): deterministic keys throughout — document (print_id, source, sha256), version (assembly hash), parse run (document_version, parser_id), candidate (parse_run, metric_id). All writes are transactional upserts on those keys; repeated drops, poll races, and parse retries are no-ops. Accepted records are immutable (supersession chains, never UPDATE-in-place).

### 4.4 Extraction pipeline (the 99% machinery)

- **Typed line contracts.** Each bogey line becomes a contract: `metric_id`, aliases, segment, basis, period (Qn/FY/guidance horizon; range-vs-midpoint), currency, unit/scale, value kind. Compiled from `earnings_bogeys` at arm time; user-visible and editable on the preflight card (basis ambiguity resolved BEFORE the night).
- **Document-to-event validation gate** (Codex 8): before any candidate can green, the document itself must validate — issuer identity (CIK/name match), fiscal period stated in the document matches the contract period, document kind is a results release (not a supplement-only or unrelated PR), and version is current. A document failing the gate parses into conflict-lane only.
- **Deterministic first.** HTML: table extraction preserving headers, spans, footnotes, section headings. PDF: text-with-coordinates + table extraction; OCR only when native text is absent.
- **Independent parses** (Codex 6): two constrained parses over different representations (parser A: normalized tables/text; parser B: rendered pages). "Independent" is defined operationally: a parser pair qualifies for GREEN only after the bake-off demonstrates decorrelated errors on the holdout (per-class agreement-when-wrong below threshold). If two same-model representations prove correlated, a second vendor or a third representation is added and re-measured — GREEN is gated on the measured pair, not the aspiration.
- Each candidate returns: normalized value, raw display value, basis, period, currency/unit, exact source snippet, location (page/table/row/col or selector), matched `metric_id`, or explicit `not_disclosed`.
- **Mechanical reconciliation**: agreement on value + sign + unit + basis + period + location-consistency → GREEN. Disagreement → conflict with both candidates. The model never adjudicates its own conflict.
- **Validators downgrade only** (Codex 7): arithmetic/historical checks (segments vs consolidated, growth vs prior-year column, margin ratio, EPS×shares, range/midpoint, magnitude vs prior quarters) can flag or downgrade a candidate, and never synthesize, repair, or promote a value. A legitimate recast that trips a validator becomes a flagged conflict for the human — never an auto-rejection of the parsed number.
- **Flash lane**: DJ bullets parse into the same contract space, rendered as visually and textually distinct provisional values, superseded by release-parse results; `* Correct:` retracts its line.

### 4.5 Live sheet UI

- A print-watch surface on Today (per armed event): status ladder (watching → wire hit → release acquired vN → parsing → filled), then the sheet filling live. SSE from the in-process watcher.
- **Cell state is three independent axes** (Codex 2): extraction state (green-agreed | conflict | flash-provisional | superseded), disclosure state (value | not_disclosed | unknown), review state (unreviewed | accepted | edited | rejected). Accepting never destroys extraction evidence — the audit trail is append-only.
- **Full verify workflow** (Codex 21): keyboard-accessible accept / edit (with typed-value entry) / reject per line; conflict resolution picks a candidate or types a value; blanks can be hand-filled; undo restores the prior review state from the audit trail. Every state renders with a text label + icon, never color alone.
- **Promotion** (Codex 3, 4 — resolves former open question): accepted lines write to the normalized accepted-lines store with explicit **`print_watch` provenance** (never masquerading as `manual`), stamped with the source document version. The legacy `calendar_events.actual_value` "EPS X · Rev N" string is DERIVED from compatible headline metrics only, atomically, in the same transaction — it opens the recap window exactly as today, and never merges with stale Finnhub values (the derive overwrites whole, or not at all). Nothing auto-promotes (user decision: green + verify).

### 4.6 Watcher lifecycle (Codex 13)

A durable state machine, persisted per armed print: `scheduled → recon_ok → window_open → acquired → parsed → verified → promoted | expired | disarmed`. Exactly one watcher owns a print (in-process registry keyed by print_id). On Electron/server boot: recover from persisted state — re-open windows whose T+45m hasn't passed (late-start catch-up polls immediately), mark missed windows `expired` (the slow pipeline still covers them). Sleep/wake and TWS reconnects re-enter through the same recovery path. Disarm cancels cleanly. SSE clients reconnect statelessly (state is replayed from the store, not the stream).

### 4.7 Trust boundary (Codex 18)

Every new route is classified in the `proxy.ts` policy before it exists: the SSE stream and sheet reads are **human** routes (session + CSRF per the #35 boundary; SSE subscription authorized per event id); drop-zone upload, arm, accept/edit/reject, and promotion are **human** mutations via `apiFetch` (CSRF double-submit); nothing here is a service route (the watcher is in-process, not HTTP). No new unauthenticated paths.

### 4.8 Storage, privacy, licensing (Codex 15, 16)

- All acquired bytes, parse artifacts, and JSONL logs live under a fixed **gitignored** application-data directory (`data/print-watch/`); nothing under version control ever contains release bytes, snippets, armed-symbol lists, or the user's bogeys. Committed test fixtures are anonymized/synthetic; real-release fixtures for the bake-off live in `tests/fixtures/real/` (already gitignored).
- Logs are sanitized: symbols and event ids yes (local-only app), snippets and values only in the local data dir, never in committed files or error strings that could reach third-party services.
- DJ-entitled content and user-dropped documents are processed by the Claude API for extraction (same processor already used for statement PDFs); retained copies are minimal (the release itself + parse evidence), local-only, with a retention control (default: keep; user-deletable per print). This is personal-use processing of content the user is licensed to view; no redistribution surface exists.
- **Ingestion hardening** (Codex 17): IR fetches only against the recon-fixed host allowlist with redirect revalidation; downloads capped (bytes, page count); MIME/magic-byte checked; HTML sanitized before any parse artifact renders; snippets escaped at render (they are untrusted document text); adversarial fixtures in the test suite.

### 4.9 What this deliberately does not touch

Existing enrichment/recap/preview machinery, Worker mirrors, wire-probe road, `earnings_bogeys` ingestion. No licensed-feed contracts, no web search, no computer-use in the critical path.

## 5. Schema (revised sketch — final constrained migration in the post-spike appendix)

Evidence-preserving, append-only where it matters (Codex 1, 2, 12):

- `print_watch_prints` (print_id PK, symbol, fiscal_period, current_event_id repairable-FK, state §4.6, armed_at, coverage_verdict, coverage_json).
- `print_watch_documents` (id, print_id FK, source CHECK, url, sha256, bytes_path, version_seq, supersedes_id, complete_at, first_seen_at, monotonic_ms; UNIQUE(print_id, source, sha256)).
- `print_watch_parse_runs` (id, document_id FK, parser_id, representation, model_id, started_at, finished_at, status; UNIQUE(document_id, parser_id)) — append-only.
- `print_watch_candidates` (id, parse_run_id FK, metric_id, value_normalized, value_raw, basis, period, currency, unit, snippet, location_json, not_disclosed flag; UNIQUE(parse_run_id, metric_id)).
- `print_watch_lines` (print_id, metric_id, contract_json, extraction_state CHECK, disclosure_state CHECK, review_state CHECK, green_candidate_ids, accepted_value…, accepted_document_version, review_history_json append-only, PRIMARY KEY(print_id, metric_id)).
- Accepted-lines normalized store doubles as the promotion source (§4.5); indexes on (print_id), (current_event_id), (state). Migration ships with populated-DB upgrade + FK + rollback tests (Codex 12).

## 6. Spike program

| Spike | Status | Output |
|---|---|---|
| TWS entitlement + article-body probe | **DONE 2026-08-20** | §3 evidence |
| EDGAR latency on real prints | **DONE (n=6)** | §3 evidence; harness grows n |
| Recon replay NVDA/CRWD/RBRK | **DONE** | CRWD `DJ-release`, NVDA `flash+EDGAR`, RBRK `flash` (+PR likely) |
| Timestamp harness (`scripts/spike-print-timestamp-harness.ts`) | Built 2026-08-20; **runs 8/26 NVDA+CRWD, 8/27 RBRK** | First-seen times + hashes across DJ/EDGAR/IR/Finnhub; validated via `--replay` on CRWD 6/03 |
| Extraction bake-off — **PILOT DONE 2026-08-20** | 15 events / 195 gold lines / 496 candidates (Sonnet tier, ~$0.09 · ~14s per parse call) | **Gold: 195/195 exact agreement between two independent vendor labelers** (Claude + Codex, documents-only, all 16 not_disclosed probes included). **Parser results: zero wrong numbers greened; zero catastrophic-class errors anywhere** (no false-match — every probe held — no cross-line, no unit slips). Same-document pair (tables vs raw text): 99.4% coverage, 98.5% green precision — the only 3 wrong greens were agreed-not_disclosed on NVDA segment lines whose values live in ex99-2, which the parsers were never given (input gap, not model error → amendment 1 below). Cross-document pair: 100% precision, 86.7% coverage (wire-release completeness, e.g. MELI's zero-figure pointer release). The single value disagreement (AMZN TTM FCF, prose-rounded −7.6B vs table −7,604M) correctly went yellow. Caveats: one season, curated contracts, model-labeled gold (two-vendor-agreed); the full frozen corpus + statistical gate still precede stage-2 shipping. |
| Correction + multi-document drill | queued | Replay initial→amended; release+supplement arriving separately |
| Failure drill + full rehearsal night | queued | TWS down, sleep/wake mid-window, partial PDF, stale CDN, two simultaneous prints; then one non-critical print end-to-end with DB + screenshot evidence |

## 7. Build order (after spikes confirm; each stage lands with its tests)

1. Schema + document store + global scheduler + DJ/EDGAR/drop-zone adapters behind the armed window (adapter replay tests from harness recordings).
2. Contract compile + deterministic extraction + dual parse + reconcile (bake-off-tuned; GREEN disabled until the §2 gate passes).
3. Live sheet SSE surface + verify loop + promotion (trust-boundary classification first).
4. Preflight recon card + coverage verdicts + qualification expiry.
5. Flash lane + correction alarms + supersession handling.
6. IR adapters for names recon proves need them (NVDA first).

## 8. Open questions (deliberately unresolved until spike data)

- NVDA newsroom: stable no-browser feed or flash+EDGAR only (harness answers 8/26).
- Flash-lane default visibility (decide after the rehearsal night, seeing it live).
- Second-vendor parser: only if the bake-off shows same-model representations correlate on errors.
- GREEN go-live threshold numbers (min sample size, confidence bound) — set with the bake-off corpus design, before stage 2 ships.

Resolved since v1: promotion provenance = explicit `print_watch` (§4.5); correction-after-promotion = invalidate + block + re-verify (§4.3); accepted line-items destination = normalized store + derived legacy string (§4.5).

## 9. Pilot-driven amendments (2026-08-20, from the bake-off + labeling flags)

1. **Feed ALL EX-99.\* exhibits to extraction, not just -1.** The pilot's only wrong greens were input gaps: NVDA's segment figures live in ex99-2 (CFO commentary). Corollary: representation diversity does NOT protect against acquisition gaps — both representations share any missing input, and the correlated-error metric registered exactly that (100% correlation on those 3, all input-driven). Multi-DOCUMENT coverage, not just multi-representation, is what the green rule leans on.
2. **Table provenance joins value equality in the GREEN test.** Two flagged real cases (AMZN segments both rounding to "$42.2 billion" across different-scale tables; APP) show two parses can agree numerically while reading different disclosures. Candidates already carry location; the reconciler must require compatible locations, not value match alone.
3. **Flash lane can never green a cell — now proven, not asserted.** NET's live flash printed a plausible-magnitude WRONG guidance number (operating-income guide mislabeled as revenue guide); no magnitude validator can catch it. RBRK's flash carried a 1,000× scale error (validator-catchable) and a no-op `* Correct:` (annotate, never downgrade — decided).
4. **Vendor-basis EPS conflicts need a promotion policy** (user decision pending): the DB's Finnhub-normalized EPS differs from filed GAAP diluted EPS on 8/15 pilot events (AAPL: 1.91 vendor ex-tariff-refund vs 2.02 filed — promotion flips the recap's beat/miss read; AMZN: 1.88 vendor vs 5.75 filed). The accepted-lines store records the filed figure with basis; what the legacy string + recaps should read is a product decision to bring to the user with examples.
5. **Guidance supersession exists WITHIN one document** (OSCR: prior + updated ranges side-by-side in the same table) — contracts for guidance lines must name which (updated) and the parser prompt must say so.
