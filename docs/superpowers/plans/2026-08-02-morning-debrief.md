# Recap Retarget: Morning Debrief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Individual recaps keep firing fast on quiet days; the same-evening EOD wrap email (which landed ~4h late at 20:00 ET and restated prints the user watched live) is replaced by a **7:45 ET morning debrief** — one email covering yesterday's still-unsent prints with the content you can't get from watching live: transcript desk notes, guidance, reaction vs implied move, call notes.

**Architecture:** The sweep's wrap-*suppression* stays byte-identical (a ≥3-name same-slot cluster still suppresses individual recaps with `wrap-pending`) but `runWrapPass` is no longer called — suppressed names now roll into the next-morning debrief instead. New module `lib/earnings/debrief.ts` (candidates + compose, pure/DI) + `lib/earnings/debrief-send.ts` (claim choreography adapted from `wrap-send.ts`, per-member `earnings_emails` recap audit rows so nothing double-sends). Wired as a gated pass inside the existing 15-min earnings-sweep tick (07:45–08:20 ET window, once per ET day) — no new launchd plumbing.

**User decision (2026-08-02):** approved retargeting the recap + a second morning email "that would go out first at 7:45" (before the 8:45 digest).

**Tech Stack:** better-sqlite3; AI via `generateTextForFeature` (tier-aware wrapper, new key `earningsDebrief` → `$workhorse`) + `stripModelPreamble` (`lib/ai/strip-preamble`); email via `sendEmail` (`lib/email.ts`, `fromLocalPart: "earnings"`) + `briefingToHtml`; Vitest with `runMigrations(db)` on `:memory:` and mocked `generateTextForFeature` (per the ai-test-mocking memory).

## Global Constraints

- Every DB function takes `db: Database.Database` first (DI, `:memory:` tests).
- ET-anchor all "today/yesterday": `todayET(now)` / `addDays(todayET(now), -1)` from `lib/calendar/date-utils`.
- `earnings_emails.error` tri-state: `'in_progress'` = live claim, `'sent-by-cloud'` = Worker sent, NULL = completed. Every reader here must handle all three.
- Symbol comparisons family-aware via `issuerSiblings` — never string-equal.
- Held/watchlist status via `getSymbolStatus` (any-exposure semantics); mute list + master toggle via `getEarningsSettings`/`shouldSendEarningsEmail`.
- No dollar values / share counts in outbound email content (presence-only convention).
- Deterministic blocks rendered in code; AI writes prose only; AI output through `stripModelPreamble`.
- Worker (`workers/cron/src/fallback-earnings.ts`) is deliberately UNTOUCHED in this plan: its legacy wrap-at-deadline fallback still covers a Mac asleep all evening AND all morning. Do not edit Worker files; the parity tests that pin `SLOT_DEADLINES_ET` etc. must stay green, so `lib/earnings/wrap.ts` and `wrap-send.ts` are NOT deleted (wrap-send simply loses its caller; keep it for the Worker-parity constants and possible rollback — add a header note).
- Commits via temp file + `git commit -F`. Full `npx vitest run` at the end.

## File Structure

- `lib/earnings/debrief.ts` — NEW: `findDebriefCandidates`, `renderDebriefSections` (deterministic per-name blocks), `buildDebriefPrompt` (pure).
- `lib/earnings/debrief-send.ts` — NEW: `runMorningDebrief` (gate + claims + AI + send + audit).
- `lib/calendar/email-sweep.ts` — remove the `runWrapPass` invocation (suppression block stays); call `runMorningDebrief` in its place.
- `lib/earnings/wrap-send.ts` — header note: retired from the sweep 2026-08-02, kept for Worker-parity constants + rollback.
- `lib/ai/feature-keys.ts` + `lib/ai/models.ts` — `earningsDebrief` key.
- Tests: `tests/earnings/debrief.test.ts` (new), `tests/earnings/debrief-send.test.ts` (new), existing sweep/wrap tests updated.
- `CLAUDE.md` + `docs/conventions-detail.md` — update the wrap/#17 bullets.

---

### Task 1: `findDebriefCandidates`

**Files:**
- Create: `lib/earnings/debrief.ts`
- Test: `tests/earnings/debrief.test.ts`

**Interfaces:**
- Consumes: `getSymbolStatus`, `getEarningsSettings` + `shouldSendEarningsEmail`, `issuerSiblings`, `todayET`/`addDays`, `composeReleaseInstant` (`lib/calendar/reaction-snapshot`).
- Produces:

```ts
export interface DebriefCandidate {
  eventId: number; symbol: string; event_date: string;
  event_time: string | null; release_time: string | null;
}
export interface DebriefRosterEntry { symbol: string; sentAt: string; }
export interface DebriefCandidates {
  unsent: DebriefCandidate[];          // full sections in the email
  alreadyRecapped: DebriefRosterEntry[]; // one roster line
}
export function findDebriefCandidates(
  db: Database.Database,
  opts?: { now?: Date },
): DebriefCandidates;
```

- [ ] **Step 1: Write failing tests.** Setup: `:memory:` + `runMigrations(db)`; seed accounts/securities/holdings so chosen symbols read as held (copy the holdings-seed helper shape from `tests/calendar/verify-earnings-dates.test.ts` if Plan A landed first, else from `tests/queries/` fixtures); seed calendar_events + earnings_emails.

```ts
it("selects held earnings from yesterday+today with actuals and no recap audit row", ...);
it("excludes: no actuals; recap already sent (error NULL); sent-by-cloud; recap skip row; muted symbol; master toggle off; not held/watchlist; superseded", ...);
it("a live in_progress recap claim excludes the event (another process is sending it)", ...);
it("released under 60 minutes ago is excluded (release_time known); unknown release_time is included", ...);
it("family dedupe: GOOG + GOOGL rows on the same date yield one candidate", ...);
it("alreadyRecapped lists yesterday's completed recaps (NULL error and sent-by-cloud both count)", ...);
```

Implementation query (JS date math, SQL filter):

```ts
const today = todayET(opts?.now);
const yesterday = addDays(today, -1);
const rows = db.prepare(
  `SELECT ce.id AS eventId, ce.symbol, ce.event_date, ce.event_time, ce.release_time
     FROM calendar_events ce
     LEFT JOIN earnings_emails ee ON ee.event_id = ce.id AND ee.phase = 'recap'
     LEFT JOIN earnings_email_skips es ON es.event_id = ce.id AND es.phase = 'recap'
    WHERE ce.event_type = 'earnings'
      AND COALESCE(ce.superseded, 0) = 0
      AND ce.symbol IS NOT NULL
      AND ce.actual_value IS NOT NULL
      AND ce.event_date IN (?, ?)
      AND ee.id IS NULL
      AND es.id IS NULL`,
).all(yesterday, today) as DebriefCandidate[];
// then: held|watchlist filter (getSymbolStatus), mute/toggle filter,
// release ≥60min filter via composeReleaseInstant (null release_time → keep),
// family dedupe keeping lowest eventId.
```

`alreadyRecapped`:

```ts
const roster = db.prepare(
  `SELECT ce.symbol, ee.sent_at AS sentAt
     FROM earnings_emails ee JOIN calendar_events ce ON ce.id = ee.event_id
    WHERE ee.phase = 'recap'
      AND (ee.error IS NULL OR ee.error = 'sent-by-cloud')
      AND ce.event_date IN (?, ?)
    ORDER BY ee.sent_at`,
).all(yesterday, today) as DebriefRosterEntry[];
```

- [ ] **Step 2–4: Fail → implement → pass** (`npx vitest run tests/earnings/debrief.test.ts`).
- [ ] **Step 5: Commit** — `feat(earnings): morning-debrief candidate selection`

---

### Task 2: deterministic sections + prompt

**Files:**
- Modify: `lib/earnings/debrief.ts`
- Test: `tests/earnings/debrief.test.ts` (extend)

**Interfaces:**
- Consumes: `renderHeadlineTable(event, symbol, "recap", intelView)` + `loadIntelView(db, eventId, symbol)` (both exported from `lib/digest/send-earnings-email`), `getLatestCallNoteForFamily(db, symbol, event_date)` (`lib/queries/earnings-call-notes` — check exact export name in that file and use it), transcripts table read (inline query below), `formatReactionSnapshot` (exported from send-earnings-email).
- Produces:

```ts
export interface DebriefSection { symbol: string; markdown: string; }
export function renderDebriefSections(db: Database.Database, unsent: DebriefCandidate[]): DebriefSection[];
export function buildDebriefPrompt(sections: DebriefSection[], todayStr: string): string;
export function assembleDebriefMarkdown(aiMarkdown: string, sections: DebriefSection[], roster: DebriefRosterEntry[], dateStr: string): string;
```

- [ ] **Step 1: Write failing tests**

```ts
it("renders per-name section: heading, scoreboard table, desk-note guidance excerpt when a fresh transcript summary exists", ...);
it("desk-note excerpt: uses the **Guidance** labelled span (≤900 chars) plus a Tone: line when present; extractive-only summaries get a 600-char teaser; no transcript → section omits the block silently", ...);
it("includes the user's call note (guidance/tone/surprises) when one exists for the family", ...);
it("assembleDebriefMarkdown: AI synthesis first, then sections, then a roster line 'Recapped individually overnight: X · Y'; roster omitted when empty", ...);
it("buildDebriefPrompt embeds every section and instructs markdown-only output starting with #", ...);
```

Transcript lookup per candidate (family-aware, freshest first, summary required):

```ts
const tx = db.prepare(
  `SELECT summary, source, fetched_at FROM earnings_transcripts
    WHERE UPPER(ticker) IN (${famPlaceholders})
      AND summary IS NOT NULL AND summary != ''
      AND datetime(fetched_at) >= datetime(?, '-5 days')
    ORDER BY datetime(fetched_at) DESC LIMIT 1`,
).get(...family, `${candidate.event_date} 00:00:00`) as { summary: string; source: string } | undefined;
```

Guidance excerpt helper (local, mirrors the digest's compact-notice rules — the raw `guidance` COLUMN is never rendered, per the #12 convention):

```ts
function deskNoteExcerpt(summary: string): string {
  const m = summary.match(/\*\*Guidance\*\*[:\s]*([\s\S]*?)(?=\n\s*\*\*[A-Z]|$)/);
  const guidance = m?.[1]?.trim();
  const tone = summary.match(/\*\*Tone\*\*[:\s]*([^\n]+)/)?.[1]?.trim();
  if (guidance) {
    let out = `**Guidance:** ${guidance.slice(0, 900)}`;
    if (tone) out += `\n\n**Tone:** ${tone}`;
    return out;
  }
  return summary.slice(0, 600); // extractive-only teaser
}
```

Per-name section markdown shape:

```
### {SYM} — {event_date} {BMO|AMC}

{renderHeadlineTable(event, sym, "recap", loadIntelView(db, id, sym))}

{deskNoteExcerpt block, when transcript found — prefixed "**From the call** (desk note):"}

{call-note block, when present: "**Your call note:** guidance {raised|...}; tone: ...; surprises: ..."}
```

Prompt (exact):

```ts
export function buildDebriefPrompt(sections: DebriefSection[], todayStr: string): string {
  return `You are writing the morning earnings debrief for ${todayStr}. The reader manages their own portfolio, watched yesterday's prints live, and already knows the headline numbers — do NOT restate beats/misses. Your job is what happened AFTER the print and what it means for today: the call (guidance, tone, surprises), the read-across between these names, and what to watch at today's open.

Write GitHub markdown. The first character of your reply must be '#'. Open with '# What changed overnight' — 3 to 6 tight bullets across all names. Then one '## {SYMBOL}' section per name, 2-4 sentences each, focused on call content and today's setup. No preamble, no closing commentary, no invented numbers — if a figure is not in the data below, do not state one.

Data:
${sections.map((s) => s.markdown).join("\n\n---\n\n")}`;
}
```

`assembleDebriefMarkdown`: `# Earnings Debrief — {dateStr}` header handled by the email title instead; output = `${aiMarkdown}\n\n---\n\n## The scoreboards\n\n${sections.map(s => s.markdown).join("\n\n")}` + (roster.length ? `\n\n*Recapped individually overnight: ${roster.map(r => r.symbol).join(" · ")}*` : "").

- [ ] **Step 2–4: Fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(earnings): debrief sections + prompt + assembly`

---

### Task 3: `runMorningDebrief` — gate, claims, send, audit

**Files:**
- Create: `lib/earnings/debrief-send.ts`
- Test: `tests/earnings/debrief-send.test.ts`

**Interfaces:**
- Consumes: Task 1+2 exports; `claimEarningsEmailSlot` / `releaseEarningsEmailClaim` (exported from `lib/digest/send-earnings-email` — claim BEFORE compose, token-conditional release, exactly like `wrap-send.ts`; read `wrap-send.ts::runSlotWrap` first and mirror its claim choreography including refire-drop and conflict-abort); `generateTextForFeature("earningsDebrief", ...)`; `stripModelPreamble`; `sendEmail`; `briefingToHtml`; settings idiom for the once-per-day key.
- Produces:

```ts
export interface DebriefResult {
  sent: boolean;
  covered: string[];               // symbols with full sections
  skippedReason?: "outside-window" | "already-ran-today" | "no-candidates" | "claims-conflict";
}
export async function runMorningDebrief(
  db: Database.Database,
  opts?: { now?: Date; force?: boolean; recipient?: string;
           generate?: (prompt: string) => Promise<string> },   // DI for tests
): Promise<DebriefResult>;
```

- [ ] **Step 1: Write failing tests** (mock `generate`, mock `sendEmail` via vi.mock on `@/lib/email`):

```ts
it("outside 07:45–08:20 ET → skippedReason outside-window (no writes)", ...);
it("force:true bypasses the window but not the once-per-day key", ...);
it("second run same ET day → already-ran-today (settings key last_debrief_date stamped on first run, BEFORE compose)", ...);
it("no unsent candidates → stamps the day key, sends nothing, sent:false no-candidates", ...);
it("happy path: claims every member, sends ONE email titled 'Earnings Debrief — {date}', writes a completed recap audit row per member with the debrief markdown, result.covered lists symbols", ...);
it("a member already claimed by another process is dropped from this debrief (not aborted) and NOT audited", ...);
it("compose/send failure releases the fresh claims (members return to candidacy next morning) and the day key stays stamped", ...);
it("AI output goes through stripModelPreamble", ...);
```

Key mechanics (implement exactly):
- Window check: ET minutes-of-day via `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false })`; window `465 <= min < 500` (07:45–08:20). `force` skips only this check.
- Day key: settings key `last_debrief_date`, value `todayET(now)`; stamp before compose (one attempt per day; the 15-min tick would otherwise retry into the digest window).
- Claim each unsent member with `claimEarningsEmailSlot(db, eventId, "recap", recipient)`; `claimed:false` → drop that member; zero members left after claims → release nothing, return `claims-conflict`.
- Compose: `renderDebriefSections` → `buildDebriefPrompt` → `generate` (default: `generateTextForFeature("earningsDebrief", { prompt, maxOutputTokens: 4096 })` — read `lib/ai/generate.ts` for the exact call signature and copy an existing call site) → `stripModelPreamble` → `assembleDebriefMarkdown` → `briefingToHtml(markdown, title)`.
- Send: `sendEmail({ to: recipient, subject: "☕ Earnings Debrief — {Mon D}", html, fromLocalPart: "earnings" })`; recipient = `opts.recipient || process.env.BRIEFING_EMAIL_TO`; missing → release claims, return without throwing (log).
- Audit per member on success (mirror `wrap-send.ts::recordWrapAudit`'s upsert converting the claim row): store the full debrief markdown as `ai_output_md` on each member row (the in-app viewer then shows the debrief for each name).
- Whole body in try/catch: failure → `releaseEarningsEmailClaim` per fresh claim token, log, return `{ sent: false, covered: [] }`. Never throw to the sweep.

- [ ] **Step 2–4: Fail → implement → pass.**
- [ ] **Step 5: Register `earningsDebrief`** in `lib/ai/feature-keys.ts` + `FEATURE_MODELS` (`"anthropic/$workhorse"`); run `npx vitest run tests/ai`.
- [ ] **Step 6: Commit** — `feat(earnings): morning debrief sender with wrap-style claim choreography`

---

### Task 4: rewire the sweep — retire the evening wrap

**Files:**
- Modify: `lib/calendar/email-sweep.ts` (remove `runWrapPass` call block; call `runMorningDebrief` there instead; keep the wrap-suppression block UNCHANGED), `lib/earnings/wrap-send.ts` (header note only)
- Test: existing sweep tests (find with `grep -rln "runWrapPass\|wrapsSent" tests/`) updated; `tests/earnings/debrief-send.test.ts` already covers the pass itself.

**Interfaces:**
- `SweepSummary.wrapsSent` is REPLACED by `debrief: { sent: boolean; covered: string[] } | null` (null when the pass didn't run). Update the route/scripts that read `wrapsSent` (grep for it — `app/api/cron/earnings-sweep/route.ts`, `scripts/sweep-earnings-emails.ts` log lines).

- [ ] **Step 1: Update the failing sweep tests first**: wrap-suppression test stays (suppression is unchanged — assert `wrap-pending` skips still happen for today's ≥3 clusters); the "wrap email fires at deadline" assertions move to: "sweep invokes runMorningDebrief (mock it) and reports its result"; add "a wrap-suppressed member from yesterday appears in this morning's debrief candidates" as an integration test in `tests/earnings/debrief.test.ts`.
- [ ] **Step 2: Implement the rewire**: in `runEarningsEmailSweep`, replace the `runWrapPass` try/catch block with:

```ts
let debrief: { sent: boolean; covered: string[] } | null = null;
try {
  const r = await runMorningDebrief(db, { now: opts.now });
  debrief = { sent: r.sent, covered: r.covered };
} catch (err) {
  console.warn("[earnings-sweep] morning debrief pass failed:", err);
}
```

Add to `wrap-send.ts` header: `RETIRED from the sweep 2026-08-02 — the EOD wrap was replaced by the 7:45 ET morning debrief (lib/earnings/debrief-send.ts). Kept: the Worker fallback mirrors these deadline constants (parity-pinned) and covers a Mac asleep overnight; delete only together with the Worker path.`

- [ ] **Step 3: Run the full earnings + calendar test dirs** — `npx vitest run tests/earnings tests/calendar tests/digest`.
- [ ] **Step 4: Commit** — `feat(earnings): sweep retires EOD wrap, wires morning debrief pass`

---

### Task 5: docs + full suite + live dry-run

**Files:**
- Modify: `CLAUDE.md` (rewrite the "#17 EOD earnings wrap" sentence inside the email-sweep bullet), `docs/conventions-detail.md` (dated provenance: user verdict 2026-08-02 — previews useful, evening recaps/wraps not; 16-recap audit numbers).

- [ ] **Step 1:** CLAUDE.md — replace the wrap sentence with:

```
**Morning debrief supersedes the EOD wrap (2026-08-02)**: wrap-SUPPRESSION is unchanged (today's ≥3-name same-slot recap cluster still skips individual sends as `wrap-pending`) but `runWrapPass` is retired from the sweep — suppressed names roll into the 7:45 ET morning debrief (`lib/earnings/debrief-send.ts::runMorningDebrief`, gated 07:45–08:20 ET + once-per-day settings key `last_debrief_date`, invoked from the sweep tick): ONE email (subject "☕ Earnings Debrief"), AI synthesis (feature key `earningsDebrief`, no-restating-headlines prompt) over per-name scoreboards + transcript desk-note guidance excerpts + user call notes, per-member completed recap audit rows (same dedup surface as before), roster line for names already recapped individually. Quiet-day individual recaps unchanged. Worker's legacy wrap-at-deadline fallback deliberately kept (Mac-asleep coverage) — `wrap-send.ts` retired-not-deleted for its parity-pinned constants.
```

- [ ] **Step 2: Full suite** `npx vitest run` → report count + pass/fail.
- [ ] **Step 3: Live dry-run (manual):** `npx tsx -e` invoke `findDebriefCandidates(db)` against the real DB and print the result — with Friday's prints now >1 day old the expected result is empty or tiny; sanity only, no send. Then `runMorningDebrief(db, { force: true })` MUST NOT be run against the real DB in this task (it would email) — leave live verification for the next real earnings morning; note this in the summary.
- [ ] **Step 4: Commit** — `docs: morning-debrief conventions + wrap retirement provenance`

## Self-Review Notes

- Spec coverage: 7:45 send before 8:45 digest ✓ (window 07:45–08:20); "goes out first" ✓; call-content focus ✓ (prompt bans headline restatement; desk-note excerpts in data); fast individual recaps preserved ✓ (sweep candidate path untouched); heavy-night spam prevented ✓ (suppression intact); no double-sends ✓ (per-member recap audit rows + claims); Saturday-after-Friday-AMC works ✓ (no market-day gate — candidates drive).
- Known gaps accepted & documented: Worker still wraps at legacy deadlines when Mac is asleep (interim fallback); 8:45 digest's call-transcripts block may partially overlap the debrief on some mornings (both read the same desk notes — revisit after user feedback); a today-dated BMO ≥3 cluster debriefs tomorrow morning (stale-ish; revisit if it ever actually occurs).
- Type consistency: `DebriefCandidate`/`DebriefCandidates`/`DebriefSection`/`DebriefResult` names match across Tasks 1–4; settings key `last_debrief_date` used identically in Tasks 3 and 5 docs.
