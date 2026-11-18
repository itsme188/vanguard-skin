# Bogey Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it easy for the owner to get earnings bogeys onto an armed print: see which previews were not read, read one with a click, drop or paste a preview in any form, type figures the way people write them, and choose which newsletters the scan reads.

**Architecture:** Five owner-approved fixes (2026-11-18) built on the existing bogey pipeline. The scan gate's rules move from code constants to a `settings` row (no schema change). The upload extractor learns the sheet's existing lines and accepts pasted text. A new read-only "read" route fills the edit box for the owner to check before saving. A new "not read" list on armed Hub rows runs the existing per-article extractor on demand. A new lenient figure reader replaces the strict per-field grammar on the client only.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, better-sqlite3, Vitest, `@anthropic-ai/sdk` through the project's AI gateway.

**Spec:** the owner-approved five-point plan in this session (no separate spec file): (1) "not read" list with a one-click read on armed Hub rows; (2) upload matches the sheet's existing lines; (3) per-newsletter on/off switch for the bogey scan; (4) drop a file or paste text anywhere and it gets filed, including a fallback on the Import tab for a PDF or image that is not a statement; (5) hand entry accepts normal wording, and a paste box reads free text into the fields for checking before save.

## Global Constraints

- The repo is PUBLIC: tests and docs use synthetic tickers (ACME, BETA) and invented figures; never a real portfolio figure.
- No schema change and no migration. Scan rules live in the `settings` key `bogey_scan_sources`.
- Never hardcode a model id: AI calls go through `resolveFeatureModel(...)` / the existing `earningsBogeysExtraction` feature, as `lib/earnings/extract-bogeys.ts` does today.
- Mutating UI handlers read responses through `readMutationResult` / `networkFailureMessage` (`lib/ui/mutation-result.ts`); no bare `res.ok` gate, no empty `catch {}`.
- A question to the owner goes through `useConfirmPrompt`; never `confirm()` / `alert()`.
- Envelope for new routes: `{ success: true, data }` / `{ success: false, error }`. Route = parse + call a `lib/` function.
- New routes need no proxy change: `classifyRoute` (`lib/auth/route-policy.ts`) defaults every route to "human".
- Nothing new runs on a timer and nothing calls AI on page load: every new AI call is one owner click.
- The read route writes nothing. Figures reach the database only through the existing Save (`POST /api/earnings/bogeys`, source `manual`) or the existing upload route.
- A range ("3.3-3.4B", "3.3 to 3.4B") is never turned into one number. The reader says it is a range and asks for one number.
- Node: prefix every command with `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH`.

## Amendments after Codex review round 1 (binding; they override the task text below)

Codex verdict REVISE, 17 findings. Each is folded here, or declined with the reason.

- **A1 (findings 7, 8). Settings rules.** `getBogeyScanRules` validates strictly: a JSON object whose keys are positive-integer strings and whose values are `"all"` or `"previews"`; anything else (wrong shape, bad mode, non-integer key) falls back to the name defaults and logs one `console.warn`. The first `setBogeyScanMode` writes the whole resolved map, so defaults become id-keyed from then on; before that, a rename can drop a default (documented, accepted). New sources default to off. A changed rule is prospective: nothing is re-read immediately. The existing automatic readers (global scan, armed rescan, armed deep read) follow the switch on their next run, so turning a source on can lead an armed print's deep read to run again on its next pass. That is accepted and documented in DECISIONS. Replace the Global Constraint "Nothing new runs on a timer… every new AI call is one owner click" with: "No new automatic AI path. Every AI call this plan adds is one owner click; existing automatic readers follow the switch." Tests to add in Task A: `wrong_shape_falls_back` (`["x"]`, `{"8":"sometimes"}`, `{"abc":"all"}`), `first_save_materialises_defaults`.
- **A2 (findings 9, 10). Line identity in Task B.** Add `alignToExistingLines(extracted: ExtraMetricSpec[], existing: ExtraMetricSpec[]): ExtraMetricSpec[]` to `lib/earnings/watch-metrics.ts` (Task B owns this addition). It replaces an extracted spec's id with an existing line's id when the normalised label key (`identityTokens(label).join(" ")`), period, unit and basis are all equal. It never matches on label alone, and when two existing lines match it leaves the extracted id unchanged. Add `existingWatchSpecsForEvent(db, eventId): ExtraMetricSpec[]` beside `existingWatchLinesForEvent`. The upload route and the read route both align. The upload route KEEPS its overwrite behaviour (no `mergeWatchMetricsJson`, no `preserveExisting`): a re-upload under the same label is how the owner corrects a sheet. Tests: `manual_uuid_line_reused` (an existing line with a random v4 id and the same label gets that id), `ambiguous_match_left_alone`, `reupload_overwrites` (replacing the old `reupload_keeps_prior_metrics`).
- **A3 (finding 12). Segments and round trips.** `readBogeysForEvent` turns each `segment_breakdown` entry into a watch metric: label `"<segment> revenue"`, unit usd, period Q, basis na, with that entry's consensus and whisper, id from `watchMetricId`, then aligned. Task F's desk-text formatter must round-trip: `readDeskFigure(formatDeskFigure(x, kind), kind).value === x` for every value it writes. Use the shortest exact text (`3.35B`, `850M`, `3350001234`) and fall back to the plain integer when no scaled form is exact. Test `format_round_trips`. A trailing `+` stays accepted and reads as the number itself; the parsed result carries `approximate: true` and the edit box shows "read “108.5B+” as 108.5B". The same applies to `~`, `c.` and the other approximators.
- **A4 (finding 13).** `readDeskFigure` for pct also accepts `±6%`, `+/-6%` and `+6`. Expected move keeps today's absolute-value rule. Tests: those three forms, `"1,2,3"` → 123 (the existing comma behaviour), `"1e3"` refused, `"9".repeat(400)` refused as not finite.
- **A5 (finding 14). Outages.** `BogeysExtractionError` keeps the SDK error as `cause`. Both new routes map `accountFailureOf(err ?? err.cause)` to HTTP 503 with `aiUnavailableReason(kind)` as the message (`lib/earnings/ai-unavailable.ts`). Test it with a real-shaped `@anthropic-ai/sdk` error (`new Anthropic.APIError(...)`, status 400, credit-balance message) passed through the mocked extractor.
- **A6 (findings 1–4, 6). Task D redesign.**
  - *Listed* means: the article mentions the ticker family in `raw_text`, falls inside the deep read's window for the event, and has NO `earnings_bogey_scans` row for this event with status `hit` or `no_numbers` (any extractor version). The gate is no longer an exclusion, so a gated article whose scan failed or never ran is listed too. Each row shows its state: "not read" (no row), "read failed" (status `error`), "reading" (a `claimed` row under 5 minutes old; no button). Name-only mentions are not listed: the per-article reader needs the ticker. The deep read covers them for enabled sources (documented).
  - *Reading* follows the rescan step's ledger protocol (`newsletter-rescan.ts`). First, re-check eligibility on the server: the event exists, is not superseded, and the article is listed by `listUnreadPreviews` for it; otherwise 409 "This article is not waiting to be read for this print." Then claim with a fresh `claim_token` (a fresh `claimed` row from someone else → 409 "Already reading"), call the extractor, and finalise with a compare-and-set on the token: `hit` / `no_numbers` only for a complete read; `error` with `attempts + 1` when `imagesIncomplete` is true (the text figures are kept, the message says some images could not be read, and the row stays listed as "read failed"). A thrown model error books `error` and an attempt, except an account outage, which books nothing and releases the claim. `called: false` books nothing and answers 409.
  - *Live sheet.* After a successful read, call `recompileLivePrint(db, eventId)` (the function `saveBogeyWithRecompile` uses, `lib/mutations/earnings-bogeys.ts`) and return its report; the UI shows its conflict sentence when there is one.
  - Tests to add: `double_click_second_gets_409_no_second_ai_call`, `post_floor_article_refused`, `superseded_event_refused`, `images_incomplete_books_error_and_stays_listed`, `outage_books_nothing`, `recompile_called_after_hit`.
- **A7 (findings 5, 11). Task E.** The bogey button appears only for (a) an image, labelled "Images can't be imported as statements", or (b) a PDF whose statement error is the classifier's "doesn't look like a Vanguard brokerage statement" message (match the exported message prefix from `lib/import/error-classify.ts`; export a constant there if none exists). An outage or parser failure keeps the plain error with no bogey button. The statement error text stays visible beside the button. The label follows the Hub button's convention, `"<file name without extension> <weekOf>"`, so a same-week re-upload of the same file corrects its row rather than adding one. The outcome line lists the matched prints (existing `describeUploadOutcome`). Declined: holding an Import-tab upload for review before it is filed. The Hub upload button files directly today and the owner asked for less work; the outcome line names every print it filed to, and a wrong row is deleted from the edit box.
- **A8 (finding 15). Scope wording.** "Anywhere" means three entry points: the edit box (one print: file, screenshot or pasted text), the Hub upload button (a multi-company page for the week, unchanged), and the Import tab fallback. There is no general paste box for multi-company text; documented as not built.
- **A9 (finding 16). Privacy.** Sandbox screenshots, pasted real text and any model output from real articles stay in the session scratchpad or gitignored `docs/private/`. Committed tests use ACME/BETA and invented figures. Before landing, scan the branch diff for 7+ digit or comma-grouped numbers and real tickers in test files. The new routes log no article text or model output (counts and ids only).
- **A10 (finding 17). Verification.**
  - Use `npm run build`, not bare `npx next build`.
  - The AI-backed routes are proven by route tests with a mocked extractor plus database assertions (rows written, ledger states, recompile called), not by source-pin tests.
  - The sandbox click-through covers everything that does not need the AI: the source switch round-trip, the not-read list rendering with its states, lenient typing accepted and refused in the edit box, the Import fallback button appearing for a PNG and not for an outage, and phone width.
  - One live AI check after deploy: `POST /api/earnings/bogeys/read` with synthetic pasted text against an armed print. This route writes nothing; it shows the real model path end to end.
  - The one-click read is not exercised live by the agent: it writes to the live database, so the owner's first click is the live check, recorded as a TODO live watch.

## Review Focus

1. **A source renamed or deleted after the owner set its switch.** Rules are keyed by source id, so a rename keeps its rule; a deleted id is ignored. Test in Task A.
2. **Settings row missing or unreadable JSON.** Falls back to today's defaults (every TMT Breakout spelling = all posts, FundaAI = previews only); never "scan nothing" and never "scan everything". Test in Task A.
3. **Pasted text that names no figure for this company, or names another company.** The read route returns empty values and a sentence saying nothing was found; the edit box is left as it was. Test in Task B.
4. **Reading into an edit box that already holds figures.** Typed values are never overwritten: the read fills empty fields only and lists the fields it left alone. Watch lines with the same id fill a blank consensus or whisper only. Test in Task F.
5. **A one-click read on an article whose AI call fails (account outage).** No ledger row is written, the article stays on the list, and the message says the AI service is unavailable (via `accountFailureOf`). Test in Task D.

---

### Task A: Scan rules from settings, and the per-source switch

**Files:**
- Modify: `lib/earnings/bogey-scan-eligibility.ts`
- Modify: `lib/earnings/extract-newsletter-bogeys.ts` (the `getUnscannedArticles` query, ~line 400)
- Modify: `lib/earnings/prepare-steps/newsletter-rescan.ts` (~line 137)
- Modify: `lib/earnings/deep-read-bogeys.ts` (~line 248; also export `mentionOffsets`, no behaviour change)
- Create: `app/api/research/bogey-scan-sources/route.ts`
- Modify: `app/dashboard/components/ManageSourcesModal.tsx`
- Test: `tests/earnings/bogey-scan-eligibility.test.ts` (rewrite), `tests/api/research-bogey-scan-sources.test.ts`

**Interfaces:**
- Produces (in `lib/earnings/bogey-scan-eligibility.ts`):
  - `type BogeyScanMode = "off" | "all" | "previews"`
  - `BOGEY_SCAN_SETTINGS_KEY = "bogey_scan_sources"`; stored value: JSON object `{ "<source id>": "all" | "previews" }` (absent id = off).
  - `getBogeyScanRules(db): Map<number, "all" | "previews">`: reads the key; when missing or unreadable, derives the defaults from `research_sources` names (`tmt breakout`, `tmt breakouts` → all; `fundaai` → previews), compared with `lower(trim(name))`.
  - `setBogeyScanMode(db, sourceId: number, mode: BogeyScanMode): void`: writes the full map (starting from `getBogeyScanRules`), dropping "off" entries; throws on an unknown source id.
  - `bogeyScanSourceSql(db): string`: predicate over `rs` (source) and `a` (article): `(rs.id IN (<all ids>) OR (rs.id IN (<preview ids>) AND substr(replace(lower(COALESCE(a.subject,'')),' ',''),1,8) = 'preview|'))`. Ids are integers formatted with `Number.isInteger` checks; an empty list emits `0` in place of the `IN` clause.
  - `isBogeyScanArticle(rules, sourceId: number, subject: string | null | undefined): boolean`: the JS twin.
  - Remove `BOGEY_SCAN_SOURCE_SQL` and the name constants' role as the gate (keep the default-name lists as `DEFAULT_ALL_SOURCE_NAMES`, `DEFAULT_PREVIEW_SOURCE_NAMES`).
  - `export function mentionOffsets(...)` in `deep-read-bogeys.ts` (Task D uses it).
- Route: `GET /api/research/bogey-scan-sources` → `{ success, data: { sources: Array<{ id, name, is_active, mode: BogeyScanMode }> } }`; `PUT` body `{ sourceId: number, mode: BogeyScanMode }` → `{ success, data: { sourceId, mode } }`; 400 on a bad body, 404 on an unknown id.

- [ ] **Step 1: Write the failing tests** in `tests/earnings/bogey-scan-eligibility.test.ts` against a migrated in-memory db (use the project's migrate helper, not a hand-built table): `defaults_when_unset` (TMT spellings all, FundaAI previews, Vital Knowledge off); `defaults_when_json_unreadable` (key holds `"{oops"`); `rename_keeps_rule` (set FundaAI → all, rename the row, still all); `deleted_id_ignored`; `sql_and_js_agree` over every source × subjects `["Preview|ACME 3Q", "Preview | ACME", "Weekly|x", "Re: Preview|ACME", null]` with an exact count of passing rows; `empty_rules_pass_nothing`. In `tests/api/research-bogey-scan-sources.test.ts`: GET lists every source with its mode; PUT then GET round-trips; PUT `{mode:"sometimes"}` → 400; unknown id → 404.
- [ ] **Step 2: Run them** (`npx vitest run tests/earnings/bogey-scan-eligibility.test.ts tests/api/research-bogey-scan-sources.test.ts`); expected FAIL (missing exports / route).
- [ ] **Step 3: Implement** the functions above, switch the three query sites to `bogeyScanSourceSql(db)` (each already has `db` in scope), and add the route.
- [ ] **Step 4: Add the switch to `ManageSourcesModal`**: one native `<select>` per source row labelled "Bogey scan" with options "Off", "All posts", "Previews only (titled “Preview | …”)", loaded from GET and saved on change through PUT with `readMutationResult`; on failure revert the select and show the message inline. No caret icons.
- [ ] **Step 5: Run** the two test files plus `tests/earnings/deep-read-bogeys.test.ts tests/earnings/newsletter-rescan.test.ts tests/earnings/extract-newsletter-bogeys.test.ts`; expected PASS.
- [ ] **Step 6: Update docs**: `docs/DECISIONS.md` new entry "2026-11-18 — Bogey intake" (rules now in settings; defaults unchanged), the gate line in `CLAUDE.md` Conventions, and the "Which sources" bullet in `docs/reference/earnings-pipeline.md`.
- [ ] **Step 7: Commit** with explicit paths.

### Task B: Extractor sees existing lines and reads pasted text; the read route

**Files:**
- Modify: `lib/earnings/extract-bogeys.ts`
- Modify: `app/api/earnings/bogeys/upload/route.ts`
- Create: `app/api/earnings/bogeys/read/route.ts`
- Create: `lib/earnings/read-bogeys-for-event.ts`
- Test: `tests/earnings/extract-bogeys-context.test.ts`, `tests/api/earnings-bogeys-read.test.ts`, `tests/api/earnings-bogeys-upload-existing-lines.test.ts`

**Interfaces:**
- Consumes: `existingWatchLinesForEvent(db, eventId)` and `mergeWatchMetricsJson` (`lib/earnings/watch-metrics.ts`), `parseWatchMetrics`.
- Produces:
  - `type BogeysInput = { kind: "file"; bytes: Uint8Array; mediaType: BogeysUploadMediaType } | { kind: "text"; text: string }`
  - `interface ExtractContext { onlySymbol?: string; existingLinesBySymbol?: Record<string, string[]> }`
  - `extractBogeys(input: BogeysInput, context?: ExtractContext): Promise<ExtractBogeysResult>`. `extractBogeysFromUpload(bytes, mediaType)` stays as a wrapper. A text input is sent as a text block before the prompt; `MAX_PASTE_CHARS = 20_000` (longer text → `BogeysExtractionError` "Pasted text is too long…").
  - `buildExtractionPrompt(context?: ExtractContext): string`: `EXTRACTION_PROMPT` plus, when given, a block naming the one company to read ("Only extract for ACME; ignore every other ticker") and the existing lines per symbol with the instruction already in `WATCH_METRICS_INSTRUCTIONS` ("reuse its label exactly").
  - `readBogeysForEvent(db, eventId: number, input: BogeysInput, deps?: { extract?: typeof extractBogeys }): Promise<ReadBogeysResult>` where
    `ReadBogeysResult = { found: boolean; values: { eps_consensus, eps_whisper, revenue_consensus_usd, revenue_whisper_usd, expected_move_pct: number | null; guidance_notes, notes: string | null }; extraMetrics: ExtraMetricSpec[]; suggestedLabel: string; modelId: string | null; message: string }`. It picks the extracted entry whose symbol is in `issuerSiblings(event.symbol)`; none → `found: false`, message "No figures for ACME were found in this text." Writes nothing.
  - `POST /api/earnings/bogeys/read`: multipart `eventId` + either `file` (same media types and 32 MB cap as upload) or `text`; → `{ success: true, data: ReadBogeysResult }`. Unknown event → 404; neither or both inputs → 400; `BogeysExtractionError` → its status; account outage → 503 with `accountFailureOf`'s sentence.
- Upload route change: build `existingLinesBySymbol` from the events in its match window (one `existingWatchLinesForEvent` per event, keyed by the event symbol) and pass it as context; store watch metrics through `mergeWatchMetricsJson(stored, extracted)` with `preserveExisting: true`, exactly as the newsletter path does (`extract-newsletter-bogeys.ts` ~720-731).

- [ ] **Step 1: Failing tests**, with `extract` mocked (no SDK call): `prompt_names_only_symbol_and_existing_lines` (built prompt contains `ACME` and `"Net new ARR" [usd, Q, na]`); `text_input_sends_text_block`; `paste_too_long_refused`; read route: `returns_values_for_event_symbol`, `other_company_only_returns_found_false`, `no_input_400`, `both_inputs_400`, `unknown_event_404`, `writes_nothing` (row counts of `earnings_bogeys` and `earnings_bogey_scans` unchanged); upload: `existing_line_label_reused_gives_one_line` (stored row's metric id equals the existing line's id when the mocked extractor returns the existing label) and `reupload_keeps_prior_metrics` (preserveExisting).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run, expect PASS**, plus `tests/api/earnings-bogeys-upload*.test.ts` and `tests/earnings/extract-bogeys*.test.ts`.
- [ ] **Step 5: Commit.**

### Task C: Lenient figure reader

**Files:**
- Create: `lib/earnings/desk-figure.ts` (pure, import-free: the edit box imports it on the client)
- Test: `tests/earnings/desk-figure.test.ts`

**Interfaces:**
- Produces: `type DeskFigureKind = "usd" | "per_share" | "pct" | "count"`; `readDeskFigure(raw: string, kind: DeskFigureKind): { value: number | null; error: string | null }`. Blank → `{ value: null, error: null }`.

Accepted (case-insensitive, spaces anywhere between tokens): leading `~ ≈ c. ca. circa approx approx. about around`; trailing `+`; `$`, `US$`, `USD` before or after (usd, per_share); thousands commas; leading `.5`; parentheses = negative; scale words for usd and count: `k thousand` = 1e3, `m mm mn mil mln million(s)` = 1e6, `b bn bln billion(s)` = 1e9, `t tn trillion(s)` = 1e12; pct suffix `% pct percent`. Refused with a sentence naming what was read: a range (`3.3-3.4B`, `3.3–3.4B`, `3.3 to 3.4B`, `28-29%`) → `That looks like a range (3.3B to 3.4B). Enter one number.`; a scale word on per_share or pct; `bps`; any other text → `Couldn't read “<raw>” as <hint>.` with hints `a dollar figure like 3.35B or $3,350M`, `a per-share figure like 1.07`, `a percent like 28 or 28%`, `a number like 1200`.

- [ ] **Step 1: Failing table test** `reads_desk_wording` covering: `"~$3.35B"`→3.35e9; `"3.35bn"`, `"$3.35 billion"`, `"3,350M"`, `"3350 mm"` → 3.35e9; `"US$ 850m"`→8.5e8; `"$108.5B+"`→1.085e11; `"(0.12)"`→-0.12 (per_share); `"$1.07"`→1.07; `"c. 28%"`, `"28 pct"`, `"~28"` → 28 (pct); `".5"`→0.5; `"1.2k"`→1200 (count). `refuses_ranges` for the four range forms; `refuses_scale_on_per_share` (`"1.07B"`); `refuses_bps`; `refuses_words` (`"strong"`); `blank_is_null`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS. Step 5: Commit.**

### Task D: "Not read" list and one-click read on armed Hub rows

**Depends on:** Task A (`bogeyScanSourceSql`, `getBogeyScanRules`, `isBogeyScanArticle`, exported `mentionOffsets`).

**Files:**
- Create: `lib/earnings/unread-previews.ts`
- Create: `app/api/earnings/bogeys/unread/route.ts` (GET)
- Create: `app/api/earnings/bogeys/read-article/route.ts` (POST)
- Create: `app/dashboard/today/UnreadPreviews.tsx` (client)
- Modify: `app/dashboard/today/EarningsHub.tsx` (render after `LivePrintSlot` at the desktop and mobile sites, ~423 and ~449, only when `e.worksheetArmed`)
- Test: `tests/earnings/unread-previews.test.ts`, `tests/api/earnings-bogeys-read-article.test.ts`, `tests/dashboard/unread-previews-mount.test.ts` (source-pin: mounted on both sites, armed only)

**Interfaces:**
- `listUnreadPreviews(db, eventId: number, nowMs?: number): UnreadPreview[] | null` with `UnreadPreview = { articleId: number; sourceName: string; subject: string; receivedAt: string }`. Window: the deep read's (`DEEP_READ_WINDOW_DAYS` before the slot floor, cut off at the floor and at `nowMs`). An article is listed when its `raw_text` mentions the ticker family (`isSymbolMentioned`, the same test `extractBogeysFromArticleForEvent` uses, so the button always reaches the model), it does NOT pass the scan gate, and it has no `earnings_bogey_scans` row for this event. Newest first, at most 10. `null` for an unknown event.
- `readArticleForEvent(db, eventId, articleId, deps?): Promise<{ bogeysStored: number; status: "hit" | "no_numbers" }>`: loads the article as `ArticleInput`, calls `extractBogeysFromArticleForEvent`, then inserts one `earnings_bogey_scans` row (`extractor_version` = `newsletterExtractorVersionForArticle(article)`, `status`, `model_id`, `scanned_at = datetime('now')`, `attempts = 1`) with `INSERT OR REPLACE`. On a thrown model error it writes nothing and rethrows.
- `GET /api/earnings/bogeys/unread?eventId=` → `{ success, data: { articles: UnreadPreview[] } }`. `POST /api/earnings/bogeys/read-article` `{ eventId, articleId }` → `{ success, data: { bogeysStored, status } }`; account outage → 503 with `accountFailureOf`'s sentence; other model failure → 502 "The AI read failed; try again."
- UI: `UnreadPreviews({ eventId })` fetches on mount (no AI call), renders nothing when the list is empty, otherwise a one-line "N preview(s) not read for bogeys" toggle that expands to rows of source, subject (truncated), date, and a "Read for bogeys" button; while running the button says "Reading…"; afterwards the row says "Added figures" or "No figures found" and the page refreshes (`router.refresh()`).

- [ ] **Step 1: Failing tests**: `lists_ungated_mentioning_article`, `skips_gated_source`, `skips_already_ledgered`, `skips_after_floor`, `skips_name_only_mention`, `newest_first_cap_10`; read-article: `books_hit_and_drops_from_list`, `books_no_numbers`, `model_failure_writes_nothing_and_502`, `account_outage_503` (mock `extractBogeysFromArticleForEvent` throwing an error whose `cause` classifies as an account failure).
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS. Step 5: Commit.**

### Task E: Import tab hands a non-statement file to the bogey reader

**Files:**
- Modify: `app/dashboard/components/ImportFlow.tsx`
- Create: `lib/ui/current-monday.ts` (pure: `currentMondayET(now?: Date): string`, Eastern calendar)
- Test: `tests/ui/current-monday.test.ts`, `tests/dashboard/import-bogey-fallback.test.ts` (source-pin)

**Interfaces:**
- Consumes: the existing `POST /api/earnings/bogeys/upload` (`file`, `weekOf`, `sourceLabel`) and its `UploadResponse` / `describeUploadOutcome` from `app/dashboard/today/BogeysUploadButton.tsx` (export them if not exported; do not change their behaviour).
- Behaviour: the drop zone and file input also accept PNG/JPEG/WebP/GIF. An image never goes to `/api/import`; it is listed with "Not a statement" and a **Read it as earnings bogeys** button. A PDF whose preview result failed shows the same button beside its error. The button posts the file to the upload route with `weekOf = currentMondayET()` and `sourceLabel` = file name without extension plus the date, then shows `describeUploadOutcome`'s text in place.

- [ ] **Step 1: Failing tests**: `current_monday_on_sunday_evening_eastern` (2026-11-22 23:30 ET → 2026-11-16), `current_monday_on_monday` ; source-pin: accept list includes `.png`, images are excluded from the `/api/import` FormData, the button posts to `/api/earnings/bogeys/upload`.
- [ ] **Step 2–5: FAIL, implement, PASS, commit.**

### Task F: Edit box: read from a file or pasted text, and lenient typing

**Depends on:** Task B (read route, `ReadBogeysResult`) and Task C (`readDeskFigure`).

**Files:**
- Modify: `app/dashboard/today/BogeysEditModal.tsx`
- Create: `app/dashboard/today/bogey-read-fill.ts` (pure helpers)
- Test: `tests/dashboard/bogey-read-fill.test.ts`, `tests/dashboard/bogeys-edit-modal-lenient.test.ts`

**Interfaces:**
- `fillFormFromRead(form: FormState, rows: ExtraRow[], read: ReadBogeysResult): { form: FormState; rows: ExtraRow[]; filled: string[]; keptYours: string[] }`: fills empty form fields only (numbers formatted back to desk text: usd as `3.35B` / `850M`, per-share as `1.07`, pct as `28`); sets `source_label` to `read.suggestedLabel` when blank; appends watch lines whose id is new; for an id already present fills a blank consensus or whisper only. `filled` and `keptYours` are field names for the message.
- `parseManualBogeyForm` switches its readers to `readDeskFigure` (EPS fields `per_share`, revenue fields `usd`, expected move `pct`, which must be above zero and is stored as an absolute value as today). The error text is `readDeskFigure`'s sentence prefixed with the field name.
- Extra rows: before `extraRowsToJson`, each consensus/whisper is read with `readDeskFigure` for its row's unit and sent as a number; a refusal goes to `extraErrors` as "Metric N consensus: <sentence>".
- UI: at the top of the "Add manual bogeys" form, a panel "Read from a file or pasted text": a textarea (placeholder "Paste the preview text here…"), a file chooser and drag-and-drop area (same accept list as the upload button), and a **Read** button that posts to `/api/earnings/bogeys/read`. While reading: "Reading…". After: "Filled: … · Kept your: … — check and Save." or the route's message when nothing was found. Nothing is saved until the existing Save.

- [ ] **Step 1: Failing tests**: `fills_empty_fields_only`, `keeps_typed_values_and_reports_them`, `reuses_existing_line_id_fills_blank_whisper`, `appends_new_line`, `sets_label_when_blank`; lenient: `parseManualBogeyForm` accepts `"~$3.35B"` and `"c. 6%"`, refuses `"3.3-3.4B"` with the range sentence; extra row `"9.59bn"` on a usd row serialises to the number.
- [ ] **Step 2–5: FAIL, implement, PASS, commit.**

## Execution order

- Wave 1 (parallel, disjoint files): A, B, C, E.
- Wave 2 (parallel, disjoint files): D (after A), F (after B and C).
- Then: `bash scripts/verify.sh full --base main`, `npx tsc --noEmit -p .`, `npx next build`, and a sandbox click-through (`npm run sandbox` + `npm run smoke`): Manage Sources switch, an armed row's not-read list, the edit box read with pasted text, the Import tab fallback with a PNG.
