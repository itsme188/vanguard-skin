# Earnings-Day Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only earnings-day command center on `/dashboard/today`: BMO/AMC lanes of today's (+ unfinished yesterday's) held/watchlist reporters with live 5-stage pipeline chips, countdown, family net exposure, and a structured post-call note that feeds the recap + next-quarter preview emails.

**Architecture:** Pure stage state machine (`lib/earnings/cockpit-stages.ts`) + one assembly query (`lib/queries/earnings-cockpit.ts::buildCockpitPayload`) behind `GET /api/earnings/cockpit`; a polling client block `<EarningsCockpit>` above EarningsHub; migration 064 `earnings_call_notes` + prompt wiring in the earnings composer. The cockpit NEVER advances pipeline state — it renders it and deep-links to existing tools (BogeysEditModal actuals form, EarningsEmailViewer).

**Tech Stack:** Next.js 16 App Router, TypeScript 5, better-sqlite3, Vitest (in-memory DB), Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-07-08-earnings-cockpit-design.md` (approved; spec-review gate waived by user).

## Global Constraints

- Every DB function takes `db: Database.Database` as first param (DI for `:memory:` tests).
- `earnings_emails.error` is a tri-state: `'in_progress'` = live claim, `'sent-by-cloud'` = cloud delivery, `NULL` = local send. The cockpit MUST surface in-flight claims — do not reuse `getEmailAudit`/`getSentPhasesForEvents` for send-state (they exclude `'in_progress'`).
- Symbol comparisons are never string-equal: `issuerSiblings()` + uppercase.
- `security_type` comparisons case-insensitive.
- Public market data (consensus, actuals, release times) renders with plain formatters; **net exposure is portfolio-derived → `<Money>`** from `@/lib/privacy/components`.
- No hover-only affordances: any tap target follows the `EarningsRowChips` pattern (`pointer-coarse` handling + `after:` hit-area extension); all new cockpit buttons are always-visible.
- Mutating buttons follow honest-feedback: check `res.ok` AND payload success, explain failures inline, never close a modal before the outcome is readable.
- New chips use `<Chip>` (`app/dashboard/components/Chip.tsx`), tones `up|down|gold|info|neutral|warn`.
- Finnhub-shape strings (`"EPS X.XX · Rev N"`) never render raw — `formatFinnhubFigureCompact`.
- Consensus precedence: `consensus_value ?? consensus_estimate`.
- Migration file: `lib/db/migrations/064_earnings_call_notes.sql` (063 is current latest).
- Run `npx vitest run <file>` for single files; full suite `npx vitest run` before final commit (must stay green, ~3213+ tests).
- Commit after every task (small commits; messages below).
- Do NOT modify sweep/enrichment/marker logic (`lib/calendar/email-sweep.ts`, `enrichment-runner.ts` behavior) — read-only consumers only.

---

### Task 1: Migration 064 + call-note queries & mutations

**Files:**
- Create: `lib/db/migrations/064_earnings_call_notes.sql`
- Create: `lib/queries/earnings-call-notes.ts`
- Create: `lib/mutations/earnings-call-notes.ts`
- Test: `tests/earnings/call-notes.test.ts`

**Interfaces:**
- Consumes: `issuerSiblings(symbol): readonly string[]` from `@/lib/securities/issuer-family`.
- Produces:
  - `EarningsCallNote` interface + `GUIDANCE_VALUES` const (queries file).
  - `getCallNoteForEvent(db, eventId: number): EarningsCallNote | null`
  - `getCallNotePresenceForEvents(db, eventIds: number[]): Set<number>`
  - `getLatestCallNoteForFamily(db, symbol: string, beforeDate?: string): EarningsCallNote | null`
  - `upsertCallNote(db, input: UpsertCallNoteInput): EarningsCallNote`

- [ ] **Step 1: Write the migration**

`lib/db/migrations/064_earnings_call_notes.sql`:

```sql
-- Structured post-call quick-capture notes, one per earnings event.
-- symbol denormalized for family-history reads; guidance is the queryable
-- signal for the future intelligence tier ("which names lowered guidance").
CREATE TABLE earnings_call_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE REFERENCES calendar_events(id) ON DELETE CASCADE,
  security_id INTEGER REFERENCES securities(id),
  symbol TEXT NOT NULL,
  guidance TEXT CHECK(guidance IN ('raised','inline','lowered','not_given') OR guidance IS NULL),
  tone TEXT,
  surprises TEXT,
  follow_ups TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_earnings_call_notes_symbol ON earnings_call_notes(symbol);
```

- [ ] **Step 2: Write the failing test**

`tests/earnings/call-notes.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCallNoteForEvent,
  getCallNotePresenceForEvents,
  getLatestCallNoteForFamily,
} from "@/lib/queries/earnings-call-notes";
import { upsertCallNote } from "@/lib/mutations/earnings-call-notes";

let db: Database.Database;

function seedEvent(symbol: string, eventDate: string): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
       VALUES ('finnhub', 'earnings', ?, ?, ?, ?)`
    )
    .run(eventDate, `${symbol} earnings`, symbol, `finnhub:${symbol}:${eventDate}`)
    .lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("earnings call notes", () => {
  it("upsert creates then updates in place (one note per event)", () => {
    const eventId = seedEvent("NVDA", "2026-07-08");
    const created = upsertCallNote(db, {
      eventId,
      symbol: "NVDA",
      guidance: "raised",
      tone: "confident",
    });
    expect(created.guidance).toBe("raised");

    const updated = upsertCallNote(db, {
      eventId,
      symbol: "NVDA",
      guidance: "lowered",
      surprises: "China guide pulled",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.guidance).toBe("lowered");
    expect(updated.surprises).toBe("China guide pulled");
    // tone not passed on the second save → cleared (full-replace semantics)
    expect(updated.tone).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS c FROM earnings_call_notes").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("rejects an invalid guidance value", () => {
    const eventId = seedEvent("NVDA", "2026-07-08");
    expect(() =>
      upsertCallNote(db, { eventId, symbol: "NVDA", guidance: "mooned" as never })
    ).toThrow(/guidance/i);
  });

  it("getCallNoteForEvent returns null when absent", () => {
    const eventId = seedEvent("NVDA", "2026-07-08");
    expect(getCallNoteForEvent(db, eventId)).toBeNull();
  });

  it("presence set covers only events with notes", () => {
    const a = seedEvent("NVDA", "2026-07-08");
    const b = seedEvent("JPM", "2026-07-08");
    upsertCallNote(db, { eventId: a, symbol: "NVDA" });
    const set = getCallNotePresenceForEvents(db, [a, b]);
    expect(set.has(a)).toBe(true);
    expect(set.has(b)).toBe(false);
  });

  it("family latest-lookup walks issuer siblings and respects beforeDate", () => {
    const q1 = seedEvent("GOOGL", "2026-04-20");
    const q2 = seedEvent("GOOGL", "2026-07-20");
    upsertCallNote(db, { eventId: q1, symbol: "GOOGL", guidance: "inline", tone: "steady" });
    upsertCallNote(db, { eventId: q2, symbol: "GOOGL", guidance: "raised" });

    // Query by the sibling class — GOOG should find GOOGL notes.
    const latest = getLatestCallNoteForFamily(db, "GOOG");
    expect(latest?.guidance).toBe("raised");

    // beforeDate excludes the same-quarter event → prior quarter's note.
    const prior = getLatestCallNoteForFamily(db, "GOOG", "2026-07-20");
    expect(prior?.guidance).toBe("inline");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/earnings/call-notes.test.ts`
Expected: FAIL — cannot resolve `@/lib/queries/earnings-call-notes`.

- [ ] **Step 4: Implement queries**

`lib/queries/earnings-call-notes.ts`:

```ts
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export const GUIDANCE_VALUES = ["raised", "inline", "lowered", "not_given"] as const;
export type CallNoteGuidance = (typeof GUIDANCE_VALUES)[number];

export interface EarningsCallNote {
  id: number;
  event_id: number;
  security_id: number | null;
  symbol: string;
  guidance: CallNoteGuidance | null;
  tone: string | null;
  surprises: string | null;
  follow_ups: string | null;
  created_at: string;
  updated_at: string;
}

export function getCallNoteForEvent(
  db: Database.Database,
  eventId: number
): EarningsCallNote | null {
  const row = db
    .prepare("SELECT * FROM earnings_call_notes WHERE event_id = ?")
    .get(eventId) as EarningsCallNote | undefined;
  return row ?? null;
}

/** Which of these events already have a call note (cockpit `hasCallNote`). */
export function getCallNotePresenceForEvents(
  db: Database.Database,
  eventIds: number[]
): Set<number> {
  if (eventIds.length === 0) return new Set();
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT event_id FROM earnings_call_notes WHERE event_id IN (${placeholders})`)
    .all(...eventIds) as Array<{ event_id: number }>;
  return new Set(rows.map((r) => r.event_id));
}

/**
 * Most recent call note for the issuer family, by the note's EVENT date
 * (join to calendar_events), optionally strictly before `beforeDate` —
 * the preview composer passes the upcoming event's date to get the PRIOR
 * quarter's note, never the current one.
 */
export function getLatestCallNoteForFamily(
  db: Database.Database,
  symbol: string,
  beforeDate?: string
): EarningsCallNote | null {
  const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
  if (family.length === 0) return null;
  const placeholders = family.map(() => "?").join(",");
  const params: (string | number)[] = [...family];
  let dateClause = "";
  if (beforeDate) {
    dateClause = "AND ce.event_date < ?";
    params.push(beforeDate);
  }
  const row = db
    .prepare(
      `SELECT n.* FROM earnings_call_notes n
       JOIN calendar_events ce ON ce.id = n.event_id
       WHERE UPPER(n.symbol) IN (${placeholders}) ${dateClause}
       ORDER BY ce.event_date DESC, n.updated_at DESC
       LIMIT 1`
    )
    .get(...params) as EarningsCallNote | undefined;
  return row ?? null;
}
```

- [ ] **Step 5: Implement mutation**

`lib/mutations/earnings-call-notes.ts`:

```ts
import type Database from "better-sqlite3";
import {
  GUIDANCE_VALUES,
  type CallNoteGuidance,
  type EarningsCallNote,
  getCallNoteForEvent,
} from "@/lib/queries/earnings-call-notes";

export interface UpsertCallNoteInput {
  eventId: number;
  securityId?: number | null;
  symbol: string;
  guidance?: CallNoteGuidance | null;
  tone?: string | null;
  surprises?: string | null;
  followUps?: string | null;
}

/**
 * One note per event (UNIQUE event_id). Full-replace semantics: the modal
 * always posts every field, so an omitted/null field clears the column —
 * "save what the form shows", no partial-merge surprises.
 */
export function upsertCallNote(
  db: Database.Database,
  input: UpsertCallNoteInput
): EarningsCallNote {
  if (input.guidance != null && !GUIDANCE_VALUES.includes(input.guidance)) {
    throw new Error(
      `Invalid guidance "${input.guidance}" — expected one of ${GUIDANCE_VALUES.join(", ")}`
    );
  }
  db.prepare(
    `INSERT INTO earnings_call_notes
       (event_id, security_id, symbol, guidance, tone, surprises, follow_ups)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       security_id = excluded.security_id,
       symbol = excluded.symbol,
       guidance = excluded.guidance,
       tone = excluded.tone,
       surprises = excluded.surprises,
       follow_ups = excluded.follow_ups,
       updated_at = datetime('now')`
  ).run(
    input.eventId,
    input.securityId ?? null,
    input.symbol,
    input.guidance ?? null,
    input.tone ?? null,
    input.surprises ?? null,
    input.followUps ?? null
  );
  const note = getCallNoteForEvent(db, input.eventId);
  if (!note) throw new Error("Call note upsert failed to persist");
  return note;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/earnings/call-notes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/db/migrations/064_earnings_call_notes.sql lib/queries/earnings-call-notes.ts lib/mutations/earnings-call-notes.ts tests/earnings/call-notes.test.ts
git commit -m "feat(earnings): migration 064 earnings_call_notes + queries/mutations"
```

---

### Task 2: Stage state machine (`deriveEventStages`)

**Files:**
- Create: `lib/earnings/cockpit-stages.ts`
- Test: `tests/earnings/cockpit-stages.test.ts`

**Interfaces:**
- Consumes: `composeReleaseInstant(eventDate: string, releaseTimeEt: string): Date | null` from `@/lib/calendar/reaction-snapshot`; `isPlausibleEarnings(consEps, actEps, consRev, actRev): boolean` from `@/lib/earnings/plausibility`; `parseFinnhubFigure(s): { eps: number|null; revenue: number|null }` from `@/lib/format/finnhub-figure`; `REACTION_READY_MS` (= 115 min) from `@/lib/calendar/enrichment-runner`.
- Produces (Tasks 4–7 rely on these EXACT names):

```ts
export type EmailSendState = "sent" | "sent-by-cloud" | "in-flight" | null;
export type PreviewStage = "sent" | "sent-by-cloud" | "in-flight" | "skipped" | "pending" | "missed";
export interface ReleasedStage { state: "upcoming" | "released" | "unknown"; releaseInstant: string | null; }
export type ActualStageState = "pending" | "captured" | "implausible" | "blocked";
export interface ReactionStage { state: "pending" | "captured"; source: string | null; readyAt: string | null; }
export type RecapStage = "sent" | "sent-by-cloud" | "in-flight" | "skipped" | "waiting" | "blocked";
export interface EventStages { preview: PreviewStage; released: ReleasedStage; actual: ActualStageState; reaction: ReactionStage; recap: RecapStage; }
export interface StageEventInputs {
  event_date: string;
  release_time: string | null;
  actual_value: string | null;
  consensus_estimate: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
}
export const COCKPIT_BLOCKED_MIN_AGE_MS: number; // 2h — mirrors email-sweep's BLOCKED_RECAP_MIN_AGE_MS
export function deriveEventStages(
  ev: StageEventInputs,
  emails: { preview: EmailSendState; recap: EmailSendState },
  skips: { preview: boolean; recap: boolean },
  muted: boolean,
  now: Date,
  todayEt: string,
): EventStages;
```

- [ ] **Step 1: Write the failing test**

`tests/earnings/cockpit-stages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  deriveEventStages,
  COCKPIT_BLOCKED_MIN_AGE_MS,
  type StageEventInputs,
} from "@/lib/earnings/cockpit-stages";
import { REACTION_READY_MS } from "@/lib/calendar/enrichment-runner";

// 2026-07-08 is EDT (UTC-4): 16:20 ET = 20:20 UTC.
const AMC_EVENT: StageEventInputs = {
  event_date: "2026-07-08",
  release_time: "16:20",
  actual_value: null,
  consensus_estimate: "EPS 0.94 · Rev 44100000000",
  consensus_value: null,
  reaction_snapshot: null,
};
const TODAY = "2026-07-08";
const NO_EMAILS = { preview: null, recap: null } as const;
const NO_SKIPS = { preview: false, recap: false } as const;

describe("deriveEventStages", () => {
  it("pre-release: preview pending, released upcoming with instant, actual/reaction pending, recap waiting", () => {
    const now = new Date("2026-07-08T14:00:00Z"); // 10:00 ET
    const s = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, now, TODAY);
    expect(s.preview).toBe("pending");
    expect(s.released.state).toBe("upcoming");
    expect(s.released.releaseInstant).toBe("2026-07-08T20:20:00.000Z");
    expect(s.actual).toBe("pending");
    expect(s.reaction.state).toBe("pending");
    expect(s.reaction.readyAt).toBe(new Date(Date.parse("2026-07-08T20:20:00Z") + REACTION_READY_MS).toISOString());
    expect(s.recap).toBe("waiting");
  });

  it("email tri-state maps: sent / sent-by-cloud / in-flight", () => {
    const now = new Date("2026-07-08T14:00:00Z");
    expect(deriveEventStages(AMC_EVENT, { preview: "sent", recap: null }, NO_SKIPS, false, now, TODAY).preview).toBe("sent");
    expect(deriveEventStages(AMC_EVENT, { preview: "sent-by-cloud", recap: null }, NO_SKIPS, false, now, TODAY).preview).toBe("sent-by-cloud");
    expect(deriveEventStages(AMC_EVENT, { preview: "in-flight", recap: null }, NO_SKIPS, false, now, TODAY).preview).toBe("in-flight");
  });

  it("skip and mute both render skipped (mute family-decided by caller)", () => {
    const now = new Date("2026-07-08T14:00:00Z");
    expect(deriveEventStages(AMC_EVENT, NO_EMAILS, { preview: true, recap: false }, false, now, TODAY).preview).toBe("skipped");
    const muted = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, true, now, TODAY);
    expect(muted.preview).toBe("skipped");
    expect(muted.recap).toBe("skipped");
  });

  it("post-release, no preview ever sent → missed", () => {
    const now = new Date("2026-07-08T21:00:00Z"); // 17:00 ET
    const s = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, now, TODAY);
    expect(s.preview).toBe("missed");
    expect(s.released.state).toBe("released");
  });

  it("blocked at exactly the 2h boundary, pending just before", () => {
    const release = Date.parse("2026-07-08T20:20:00Z");
    const justBefore = new Date(release + COCKPIT_BLOCKED_MIN_AGE_MS - 1000);
    const atBoundary = new Date(release + COCKPIT_BLOCKED_MIN_AGE_MS);
    expect(deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, justBefore, TODAY).actual).toBe("pending");
    const blocked = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, atBoundary, TODAY);
    expect(blocked.actual).toBe("blocked");
    expect(blocked.recap).toBe("blocked");
  });

  it("captured + plausible vs implausible actual", () => {
    const now = new Date("2026-07-08T21:00:00Z");
    const captured = deriveEventStages(
      { ...AMC_EVENT, actual_value: "EPS 0.99 · Rev 44500000000" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(captured.actual).toBe("captured");
    // 3x consensus EPS → implausible per isPlausibleEarnings ratio guard
    const implausible = deriveEventStages(
      { ...AMC_EVENT, actual_value: "EPS 2.82 · Rev 44500000000" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(implausible.actual).toBe("implausible");
  });

  it("reaction captured surfaces source; malformed JSON stays pending", () => {
    const now = new Date("2026-07-09T01:00:00Z");
    const captured = deriveEventStages(
      { ...AMC_EVENT, reaction_snapshot: JSON.stringify({ source: "tws" }) },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(captured.reaction).toEqual({ state: "captured", source: "tws", readyAt: null });
    const malformed = deriveEventStages(
      { ...AMC_EVENT, reaction_snapshot: "{not json" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(malformed.reaction.state).toBe("pending");
  });

  it("null release_time: unknown released state today; carryover (yesterday) counts as released + blocked when no actual", () => {
    const now = new Date("2026-07-08T14:00:00Z");
    const noTime = { ...AMC_EVENT, release_time: null };
    const today = deriveEventStages(noTime, NO_EMAILS, NO_SKIPS, false, now, TODAY);
    expect(today.released.state).toBe("unknown");
    expect(today.preview).toBe("pending");
    expect(today.actual).toBe("pending");

    const yesterday = deriveEventStages(
      { ...noTime, event_date: "2026-07-07" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(yesterday.released.state).toBe("released");
    expect(yesterday.preview).toBe("missed");
    expect(yesterday.actual).toBe("blocked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/earnings/cockpit-stages.test.ts`
Expected: FAIL — cannot resolve `@/lib/earnings/cockpit-stages`.

- [ ] **Step 3: Implement**

`lib/earnings/cockpit-stages.ts`:

```ts
/**
 * Pure stage state machine for the earnings-day cockpit. No DB access —
 * callers pass event fields + pre-fetched email/skip/mute state. The cockpit
 * is READ-ONLY over the pipeline: this derives display state, never advances it.
 */
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { isPlausibleEarnings } from "@/lib/earnings/plausibility";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { REACTION_READY_MS } from "@/lib/calendar/enrichment-runner";

/** Mirrors email-sweep's module-local BLOCKED_RECAP_MIN_AGE_MS (2h). */
export const COCKPIT_BLOCKED_MIN_AGE_MS = 2 * 60 * 60 * 1000;

export type EmailSendState = "sent" | "sent-by-cloud" | "in-flight" | null;
export type PreviewStage = "sent" | "sent-by-cloud" | "in-flight" | "skipped" | "pending" | "missed";
export interface ReleasedStage {
  state: "upcoming" | "released" | "unknown";
  releaseInstant: string | null;
}
export type ActualStageState = "pending" | "captured" | "implausible" | "blocked";
export interface ReactionStage {
  state: "pending" | "captured";
  source: string | null;
  readyAt: string | null;
}
export type RecapStage = "sent" | "sent-by-cloud" | "in-flight" | "skipped" | "waiting" | "blocked";

export interface EventStages {
  preview: PreviewStage;
  released: ReleasedStage;
  actual: ActualStageState;
  reaction: ReactionStage;
  recap: RecapStage;
}

export interface StageEventInputs {
  event_date: string;
  release_time: string | null;
  actual_value: string | null;
  consensus_estimate: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
}

export function deriveEventStages(
  ev: StageEventInputs,
  emails: { preview: EmailSendState; recap: EmailSendState },
  skips: { preview: boolean; recap: boolean },
  muted: boolean,
  now: Date,
  todayEt: string
): EventStages {
  const instant = ev.release_time
    ? composeReleaseInstant(ev.event_date, ev.release_time)
    : null;
  const isPastDay = ev.event_date < todayEt;

  // ── released ──
  let released: ReleasedStage;
  if (instant) {
    released = {
      state: now.getTime() >= instant.getTime() ? "released" : "upcoming",
      releaseInstant: instant.toISOString(),
    };
  } else if (isPastDay) {
    // Carryover row without a known time: the day is over, it has released.
    released = { state: "released", releaseInstant: null };
  } else {
    released = { state: "unknown", releaseInstant: null };
  }
  const hasReleased = released.state === "released";

  // ── preview ──
  let preview: PreviewStage;
  if (emails.preview) preview = emails.preview;
  else if (skips.preview || muted) preview = "skipped";
  else if (hasReleased) preview = "missed";
  else preview = "pending";

  // ── actual ──
  let actual: ActualStageState;
  if (ev.actual_value) {
    const cons = parseFinnhubFigure(ev.consensus_value ?? ev.consensus_estimate);
    const act = parseFinnhubFigure(ev.actual_value);
    actual = isPlausibleEarnings(cons.eps, act.eps, cons.revenue, act.revenue)
      ? "captured"
      : "implausible";
  } else if (
    hasReleased &&
    (isPastDay ||
      (instant && now.getTime() - instant.getTime() >= COCKPIT_BLOCKED_MIN_AGE_MS))
  ) {
    actual = "blocked";
  } else {
    actual = "pending";
  }

  // ── reaction ──
  let reaction: ReactionStage;
  if (ev.reaction_snapshot) {
    let source: string | null = null;
    try {
      const parsed = JSON.parse(ev.reaction_snapshot) as { source?: string };
      source = typeof parsed.source === "string" ? parsed.source : null;
      reaction = { state: "captured", source, readyAt: null };
    } catch {
      reaction = { state: "pending", source: null, readyAt: null };
    }
  } else {
    reaction = {
      state: "pending",
      source: null,
      readyAt: instant
        ? new Date(instant.getTime() + REACTION_READY_MS).toISOString()
        : null,
    };
  }

  // ── recap ──
  let recap: RecapStage;
  if (emails.recap) recap = emails.recap;
  else if (skips.recap || muted) recap = "skipped";
  else if (actual === "blocked") recap = "blocked";
  else recap = "waiting";

  return { preview, released, actual, reaction, recap };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/earnings/cockpit-stages.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/earnings/cockpit-stages.ts tests/earnings/cockpit-stages.test.ts
git commit -m "feat(earnings): cockpit stage state machine (pure, 5 stages, tri-state email reads)"
```

---

### Task 3: Email-state read + cockpit row set (`buildCockpitPayload`)

**Files:**
- Modify: `lib/queries/earnings-emails.ts` (add `getEmailStatesForEvents`)
- Create: `lib/queries/earnings-cockpit.ts`
- Test: `tests/queries/earnings-cockpit.test.ts`

**Interfaces:**
- Consumes: Task 2's `deriveEventStages` + types; Task 1's `getCallNotePresenceForEvents`; existing `getSymbolStatus`, `getSkippedPhasesForEvents`, `getSentPhasesForEvents`, `getEarningsSettings`, `issuerSiblings`, `getSecurityIdForSymbolWithSiblings` (from `@/lib/queries/briefing-symbols`), `todayET`, `addDays`, `formatFinnhubFigureCompact`, `composeReleaseInstant`. Task 4's `getNetExposureForSymbolFamilies` — **stub the import for now** (Step 3 note).
- Produces:

```ts
// lib/queries/earnings-emails.ts
export function getEmailStatesForEvents(
  db: Database.Database,
  eventIds: number[],
): Record<number, { preview: EmailSendState; recap: EmailSendState }>;

// lib/queries/earnings-cockpit.ts
export interface CockpitRow {
  eventId: number;
  symbol: string;
  securityId: number | null;
  title: string;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  symbolStatus: "held" | "watchlist";
  consensus: string;          // formatFinnhubFigureCompact output ("" when none)
  actual: string | null;      // compact-formatted, null when not captured
  stages: EventStages;
  netExposure: number;
  isTopExposure: boolean;
  hasCallNote: boolean;
  carryover: boolean;
}
export interface CockpitPayload {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: CockpitRow[]; amc: CockpitRow[]; unknown: CockpitRow[] };
  carryover: CockpitRow[];
  skippedRows: number;
}
export function buildCockpitPayload(db: Database.Database, now?: Date): CockpitPayload;
```

- [ ] **Step 1: Write the failing test**

`tests/queries/earnings-cockpit.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEmailStatesForEvents } from "@/lib/queries/earnings-emails";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { upsertCallNote } from "@/lib/mutations/earnings-call-notes";

// Exposure needs Greeks/prices plumbing — not under test here.
vi.mock("@/lib/compute/exposure", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/compute/exposure")>();
  return {
    ...mod,
    getNetExposureForSymbolFamilies: vi.fn((_db: unknown, symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, s === "NVDA" ? 16000 : s === "JPM" ? 9000 : 0]))
    ),
  };
});

let db: Database.Database;
// Wednesday 2026-07-08, 10:00 ET (EDT).
const NOW = new Date("2026-07-08T14:00:00Z");

function seedAccountAndHolding(symbol: string) {
  const acct = db
    .prepare("INSERT INTO accounts (name, account_type) VALUES (?, 'brokerage')")
    .run(`acct-${symbol}`).lastInsertRowid as number;
  const sec = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, source_key) VALUES (?, ?, 'Stock', ?)"
    )
    .run(symbol, symbol, `t:${symbol}`).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 100, '2026-07-01', ?)"
  ).run(acct, sec, `h:${symbol}`);
  return sec;
}

function seedEvent(opts: {
  symbol: string;
  eventDate: string;
  eventTime?: string | null;
  releaseTime?: string | null;
  source?: string;
  actual?: string | null;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol, source_key, actual_value)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.source ?? "finnhub",
      opts.eventDate,
      opts.eventTime ?? "AMC",
      opts.releaseTime ?? "16:20",
      `${opts.symbol} earnings`,
      opts.symbol,
      `${opts.source ?? "finnhub"}:${opts.symbol}:${opts.eventDate}:${opts.eventTime ?? "AMC"}`,
      opts.actual ?? null
    ).lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("getEmailStatesForEvents", () => {
  it("maps the error tri-state, INCLUDING in_progress claims", () => {
    const sec = seedAccountAndHolding("NVDA");
    void sec;
    const ev = seedEvent({ symbol: "NVDA", eventDate: "2026-07-08" });
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, 'preview', 'x@y.z', datetime('now'), NULL)"
    ).run(ev);
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, 'recap', 'x@y.z', datetime('now'), 'in_progress')"
    ).run(ev);
    const states = getEmailStatesForEvents(db, [ev]);
    expect(states[ev]).toEqual({ preview: "sent", recap: "in-flight" });
  });
});

describe("buildCockpitPayload", () => {
  it("includes today's held reporters, lanes by BMO/AMC, nextRelease from upcoming instants", () => {
    seedAccountAndHolding("NVDA");
    seedAccountAndHolding("JPM");
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", eventTime: "AMC", releaseTime: "16:20" });
    seedEvent({ symbol: "JPM", eventDate: "2026-07-08", eventTime: "BMO", releaseTime: "07:00" });

    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.amc.map((r) => r.symbol)).toEqual(["NVDA"]);
    expect(payload.lanes.bmo.map((r) => r.symbol)).toEqual(["JPM"]);
    // 10:00 ET: JPM (07:00) already out, NVDA (16:20) is next.
    expect(payload.nextRelease?.symbol).toBe("NVDA");
    const nvda = payload.lanes.amc[0];
    expect(nvda.netExposure).toBe(16000);
    expect(nvda.isTopExposure).toBe(true);
    expect(nvda.stages.released.state).toBe("upcoming");
  });

  it("excludes non-held/non-watchlist reporters and counts nothing for them", () => {
    seedAccountAndHolding("NVDA");
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08" });
    seedEvent({ symbol: "ZZZZ", eventDate: "2026-07-08" }); // not held, not watchlist
    const payload = buildCockpitPayload(db, NOW);
    const symbols = [
      ...payload.lanes.bmo, ...payload.lanes.amc, ...payload.lanes.unknown, ...payload.carryover,
    ].map((r) => r.symbol);
    expect(symbols).toEqual(["NVDA"]);
  });

  it("dedupes finnhub-over-manual for the same symbol+date", () => {
    seedAccountAndHolding("NVDA");
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", source: "manual" });
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", source: "finnhub" });
    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.amc).toHaveLength(1);
  });

  it("carryover: yesterday's row without a sent/skipped recap appears flagged; completed yesterday does not", () => {
    seedAccountAndHolding("NVDA");
    seedAccountAndHolding("JPM");
    const unfinished = seedEvent({ symbol: "NVDA", eventDate: "2026-07-07" });
    const finished = seedEvent({ symbol: "JPM", eventDate: "2026-07-07", actual: "EPS 4.70 · Rev 45000000000" });
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, 'recap', 'x@y.z', datetime('now'), NULL)"
    ).run(finished);

    const payload = buildCockpitPayload(db, NOW);
    expect(payload.carryover.map((r) => r.eventId)).toEqual([unfinished]);
    expect(payload.carryover[0].carryover).toBe(true);
    // Carryover with no actual reads blocked (overnight > 2h).
    expect(payload.carryover[0].stages.actual).toBe("blocked");
  });

  it("hasCallNote reflects the presence set", () => {
    seedAccountAndHolding("NVDA");
    const ev = seedEvent({ symbol: "NVDA", eventDate: "2026-07-08" });
    upsertCallNote(db, { eventId: ev, symbol: "NVDA" });
    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.amc[0].hasCallNote).toBe(true);
  });

  it("returns empty lanes + null nextRelease on a quiet day", () => {
    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.bmo).toEqual([]);
    expect(payload.lanes.amc).toEqual([]);
    expect(payload.lanes.unknown).toEqual([]);
    expect(payload.carryover).toEqual([]);
    expect(payload.nextRelease).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/earnings-cockpit.test.ts`
Expected: FAIL — `getEmailStatesForEvents` / `earnings-cockpit` module missing.

NOTE: the test seeds `accounts(name, account_type)` and `holdings` minimal columns — if the accounts schema requires different columns, check `tests/earnings/` or `tests/queries/` for an existing `seedAccount` helper and reuse its INSERT shape instead. Do not fight the schema; copy a working seed.

- [ ] **Step 3: Add `getEmailStatesForEvents` to `lib/queries/earnings-emails.ts`**

Append:

```ts
import type { EmailSendState } from "@/lib/earnings/cockpit-stages";

/**
 * Cockpit send-state per (event, phase) INCLUDING live 'in_progress' claims —
 * unlike getSentPhasesForEvents/getEmailAudit, which deliberately exclude them.
 * Mapping: NULL → 'sent' (local), 'sent-by-cloud' → itself, 'in_progress' →
 * 'in-flight'. Any other historical error string is treated as 'sent'
 * (failure claims are released/deleted by the sweep, so persistent rows sent).
 */
export function getEmailStatesForEvents(
  db: Database.Database,
  eventIds: number[]
): Record<number, { preview: EmailSendState; recap: EmailSendState }> {
  const result: Record<number, { preview: EmailSendState; recap: EmailSendState }> = {};
  if (eventIds.length === 0) return result;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_id, phase, error FROM earnings_emails WHERE event_id IN (${placeholders})`
    )
    .all(...eventIds) as Array<{ event_id: number; phase: "preview" | "recap"; error: string | null }>;
  for (const row of rows) {
    const state: EmailSendState =
      row.error === "in_progress" ? "in-flight"
      : row.error === "sent-by-cloud" ? "sent-by-cloud"
      : "sent";
    const entry = result[row.event_id] ?? { preview: null, recap: null };
    entry[row.phase] = state;
    result[row.event_id] = entry;
  }
  return result;
}
```

(The `import type` line merges with the file's existing imports; place it at the top with them.)

- [ ] **Step 4: Implement `lib/queries/earnings-cockpit.ts`**

```ts
/**
 * Row set + assembly for the earnings-day cockpit. Read-only over the
 * pipeline: renders sweep/enrichment state, never advances it.
 * Spec: docs/superpowers/specs/2026-07-08-earnings-cockpit-design.md
 */
import type Database from "better-sqlite3";
import {
  deriveEventStages,
  type EventStages,
} from "@/lib/earnings/cockpit-stages";
import { getEmailStatesForEvents } from "@/lib/queries/earnings-emails";
import { getSkippedPhasesForEvents } from "@/lib/queries/earnings-skips";
import { getSentPhasesForEvents } from "@/lib/queries/earnings-emails";
import {
  getSymbolStatus,
  getSecurityIdForSymbolWithSiblings,
} from "@/lib/queries/briefing-symbols";
import { getEarningsSettings } from "@/lib/queries/earnings-settings";
import { getCallNotePresenceForEvents } from "@/lib/queries/earnings-call-notes";
import { getNetExposureForSymbolFamilies } from "@/lib/compute/exposure";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";

export interface CockpitRow {
  eventId: number;
  symbol: string;
  securityId: number | null;
  title: string;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  symbolStatus: "held" | "watchlist";
  consensus: string;
  actual: string | null;
  stages: EventStages;
  netExposure: number;
  isTopExposure: boolean;
  hasCallNote: boolean;
  carryover: boolean;
}

export interface CockpitPayload {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: CockpitRow[]; amc: CockpitRow[]; unknown: CockpitRow[] };
  carryover: CockpitRow[];
  skippedRows: number;
}

interface RawEventRow {
  id: number;
  source: string;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
  title: string;
  symbol: string;
  security_id: number | null;
  consensus_estimate: string | null;
  consensus_value: string | null;
  actual_value: string | null;
  reaction_snapshot: string | null;
}

function laneFor(row: RawEventRow): "bmo" | "amc" | "unknown" {
  const t = row.event_time?.toUpperCase() ?? "";
  if (t.includes("BMO")) return "bmo";
  if (t.includes("AMC")) return "amc";
  if (row.release_time) return row.release_time < "12:00" ? "bmo" : "amc";
  return "unknown";
}

export function buildCockpitPayload(
  db: Database.Database,
  now: Date = new Date()
): CockpitPayload {
  const today = todayET(now);
  const yesterday = addDays(today, -1);

  // Finnhub-preferred dedup, same PARTITION as getEarningsForWeekDeduped.
  const raw = db
    .prepare(
      `WITH ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY UPPER(symbol), event_date, event_type
                  ORDER BY CASE WHEN source = 'finnhub' THEN 0 ELSE 1 END ASC,
                           datetime(created_at) DESC
                ) AS rn
           FROM calendar_events
          WHERE event_date IN (?, ?)
            AND event_type = 'earnings'
            AND COALESCE(superseded, 0) = 0
            AND symbol IS NOT NULL
       )
       SELECT id, source, event_date, event_time, release_time, title, symbol,
              security_id, consensus_estimate, consensus_value, actual_value,
              reaction_snapshot
         FROM ranked
        WHERE rn = 1
        ORDER BY event_date ASC, release_time ASC NULLS LAST, symbol ASC`
    )
    .all(today, yesterday) as RawEventRow[];

  if (raw.length === 0) {
    return {
      generatedAt: now.toISOString(),
      nextRelease: null,
      lanes: { bmo: [], amc: [], unknown: [] },
      carryover: [],
      skippedRows: 0,
    };
  }

  const eventIds = raw.map((r) => r.id);
  const statusMap = getSymbolStatus(db, raw.map((r) => r.symbol));
  const emailStates = getEmailStatesForEvents(db, eventIds);
  const sentPhases = getSentPhasesForEvents(db, eventIds);
  const skipMap = getSkippedPhasesForEvents(db, eventIds);
  const notePresence = getCallNotePresenceForEvents(db, eventIds);
  const settings = getEarningsSettings(db);
  const mutedSet = new Set(settings.mutedSymbols.map((s) => s.toUpperCase()));

  // Family-aware mute (mirrors the sweep + push-at-print gates).
  const isMuted = (symbol: string) =>
    issuerSiblings(symbol).some((s) => mutedSet.has(s.toUpperCase()));

  // Keep held + watchlist only.
  const kept = raw.filter((r) => {
    const st = statusMap[r.symbol.toUpperCase()] ?? statusMap[r.symbol] ?? "neither";
    return st === "held" || st === "watchlist";
  });

  const exposureMap = getNetExposureForSymbolFamilies(
    db,
    kept.map((r) => r.symbol)
  );

  let skippedRows = 0;
  const rows: CockpitRow[] = [];
  for (const r of kept) {
    try {
      const stages = deriveEventStages(
        r,
        emailStates[r.id] ?? { preview: null, recap: null },
        skipMap[r.id] ?? { preview: false, recap: false },
        isMuted(r.symbol),
        now,
        today
      );
      const isCarryover = r.event_date === yesterday;
      if (isCarryover) {
        // Only unfinished yesterday rows stay: recap neither sent nor skipped.
        const sent = sentPhases[r.id]?.recap ?? false;
        const skipped = skipMap[r.id]?.recap ?? false;
        if (sent || skipped || isMuted(r.symbol)) continue;
      }
      const status = statusMap[r.symbol.toUpperCase()] ?? statusMap[r.symbol];
      rows.push({
        eventId: r.id,
        symbol: r.symbol,
        securityId:
          r.security_id ?? getSecurityIdForSymbolWithSiblings(db, r.symbol),
        title: r.title,
        eventDate: r.event_date,
        eventTime: r.event_time,
        releaseTime: r.release_time,
        symbolStatus: status as "held" | "watchlist",
        consensus: formatFinnhubFigureCompact(r.consensus_value ?? r.consensus_estimate),
        actual: r.actual_value ? formatFinnhubFigureCompact(r.actual_value) : null,
        stages,
        netExposure: exposureMap[r.symbol] ?? 0,
        isTopExposure: false, // set per-lane below
        hasCallNote: notePresence.has(r.id),
        carryover: isCarryover,
      });
    } catch (err) {
      skippedRows += 1;
      console.warn(`[cockpit] Skipped event ${r.id} (${r.symbol}):`, err);
    }
  }

  const carryover = rows.filter((r) => r.carryover);
  const todayRows = rows.filter((r) => !r.carryover);
  const lanes = {
    bmo: todayRows.filter((r) => laneFor(rawById(raw, r.eventId)) === "bmo"),
    amc: todayRows.filter((r) => laneFor(rawById(raw, r.eventId)) === "amc"),
    unknown: todayRows.filter((r) => laneFor(rawById(raw, r.eventId)) === "unknown"),
  };

  // Weight marker: largest |netExposure| per lane (and for the carryover strip).
  for (const group of [lanes.bmo, lanes.amc, lanes.unknown, carryover]) {
    let top: CockpitRow | null = null;
    for (const row of group) {
      if (row.netExposure !== 0 && (!top || Math.abs(row.netExposure) > Math.abs(top.netExposure))) {
        top = row;
      }
    }
    if (top) top.isTopExposure = true;
  }

  // Countdown target: earliest not-yet-released instant among today's rows.
  let nextRelease: CockpitPayload["nextRelease"] = null;
  for (const row of todayRows) {
    const inst = row.stages.released;
    if (inst.state === "upcoming" && inst.releaseInstant) {
      if (!nextRelease || inst.releaseInstant < nextRelease.releaseInstant) {
        nextRelease = {
          eventId: row.eventId,
          symbol: row.symbol,
          releaseInstant: inst.releaseInstant,
        };
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    nextRelease,
    lanes,
    carryover,
    skippedRows,
  };
}

function rawById(raw: RawEventRow[], id: number): RawEventRow {
  const row = raw.find((r) => r.id === id);
  if (!row) throw new Error(`cockpit rawById: event ${id} missing`);
  return row;
}
```

NOTE: `getNetExposureForSymbolFamilies` does not exist until Task 4. To keep this task green, add the STUB export to `lib/compute/exposure.ts` now (Task 4 replaces its body with the real implementation and adds its own tests):

```ts
/** Cockpit per-family net exposure. Full implementation in Task 4. */
export function getNetExposureForSymbolFamilies(
  db: Database.Database,
  symbols: string[]
): Record<string, number> {
  void db;
  return Object.fromEntries(symbols.map((s) => [s, 0]));
}
```

(The test mocks this module, so the stub only needs to exist and typecheck.)

Also fix the duplicate-import wart: `getEmailStatesForEvents` and `getSentPhasesForEvents` come from the same module — write them as ONE import line:

```ts
import { getEmailStatesForEvents, getSentPhasesForEvents } from "@/lib/queries/earnings-emails";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/queries/earnings-cockpit.test.ts`
Expected: PASS (7 tests). If `getSymbolStatus` keys differ (uppercase vs raw), check its return shape — the map is keyed by the INPUT symbol string; adjust the two lookup sites accordingly (drop the `.toUpperCase()` fallback if unnecessary).

- [ ] **Step 6: Run neighbors to catch regressions**

Run: `npx vitest run tests/earnings tests/queries/earnings-cockpit.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/queries/earnings-emails.ts lib/queries/earnings-cockpit.ts lib/compute/exposure.ts tests/queries/earnings-cockpit.test.ts
git commit -m "feat(earnings): cockpit row set + email tri-state reads incl. in-flight claims"
```

---

### Task 4: Family net exposure (`getNetExposureForSymbolFamilies`)

**Files:**
- Modify: `lib/compute/exposure.ts` (replace Task 3's stub)
- Test: `tests/compute/exposure-families.test.ts`

**Interfaces:**
- Consumes: existing `getOptionExposureMap`, `exposureForHolding`, `adjustedMarketValueSQL`, `latestHoldingsPredicate` (defaults: per-(account,security), `quantity != 0` — shorts surface), `issuerSiblings`.
- Produces: `getNetExposureForSymbolFamilies(db, symbols: string[]): Record<string, number>` — keyed by the INPUT symbol; families rolled up (GOOG holdings count toward a GOOGL query); options attributed via `underlying_symbol`; FX-threaded; watchlist-only names → 0.

- [ ] **Step 1: Write the failing test**

`tests/compute/exposure-families.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getNetExposureForSymbolFamilies } from "@/lib/compute/exposure";

let db: Database.Database;
let acctId: number;

function seedSecurity(symbol: string, opts: Partial<{
  type: string; underlying: string | null; optionType: string | null;
  multiplier: number; currency: string;
}> = {}): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, multiplier, currency, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol, symbol, opts.type ?? "Stock", opts.underlying ?? null,
      opts.optionType ?? null, opts.multiplier ?? 1, opts.currency ?? "USD", `t:${symbol}`
    ).lastInsertRowid as number;
}

function seedHolding(secId: number, qty: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-07-01', ?)"
  ).run(acctId, secId, qty, `h:${secId}:${qty}`);
}

function seedPrice(secId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-07', ?, 'manual')"
  ).run(secId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  acctId = db
    .prepare("INSERT INTO accounts (name, account_type) VALUES ('t', 'brokerage')")
    .run().lastInsertRowid as number;
});

describe("getNetExposureForSymbolFamilies", () => {
  it("long stock counts at market value; short counts negative", () => {
    const long = seedSecurity("NVDA");
    seedHolding(long, 100);
    seedPrice(long, 128);
    const short = seedSecurity("TSLA");
    seedHolding(short, -50);
    seedPrice(short, 300);
    const result = getNetExposureForSymbolFamilies(db, ["NVDA", "TSLA"]);
    expect(result.NVDA ?? result["NVDA"]).toBeCloseTo(12800, 0);
    expect(result.TSLA).toBeCloseTo(-15000, 0);
  });

  it("dual-class family rolls up: GOOG holding answers a GOOGL query", () => {
    const goog = seedSecurity("GOOG");
    seedHolding(goog, 10);
    seedPrice(goog, 180);
    const result = getNetExposureForSymbolFamilies(db, ["GOOGL"]);
    expect(result.GOOGL).toBeCloseTo(1800, 0);
  });

  it("options attribute to the underlying via the ±elasticity fallback when Greeks unavailable", () => {
    const put = seedSecurity("NVDA  261218P00120000", {
      type: "Option", underlying: "NVDA", optionType: "PUT", multiplier: 100,
    });
    seedHolding(put, 2);
    seedPrice(put, 5); // MV = 2 × 5 × 100 = 1000 → put fallback = −2.5 × 1000
    const stock = seedSecurity("NVDA");
    seedHolding(stock, 100);
    seedPrice(stock, 128);
    const result = getNetExposureForSymbolFamilies(db, ["NVDA"]);
    expect(result.NVDA).toBeCloseTo(12800 - 2500, 0);
  });

  it("unheld symbol (watchlist-only) returns 0; empty input returns {}", () => {
    expect(getNetExposureForSymbolFamilies(db, ["AMD"])).toEqual({ AMD: 0 });
    expect(getNetExposureForSymbolFamilies(db, [])).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compute/exposure-families.test.ts`
Expected: FAIL — the Task 3 stub returns 0 for everything, so the first three tests fail.

- [ ] **Step 3: Replace the stub with the real implementation**

In `lib/compute/exposure.ts`, add `import { issuerSiblings } from "@/lib/securities/issuer-family";` to the imports and replace the stub body:

```ts
/**
 * Per-reporter family net exposure for the earnings cockpit: for each input
 * symbol, Σ over ALL accounts of (signed stock/fund MV + delta-adjusted
 * option exposure) where the security's symbol OR underlying_symbol is in
 * the issuer family. Shorts stay signed (quantity != 0 predicate). FX via
 * fx_rates. Unheld names → 0.
 */
export function getNetExposureForSymbolFamilies(
  db: Database.Database,
  symbols: string[]
): Record<string, number> {
  const result: Record<string, number> = {};
  if (symbols.length === 0) return result;

  // familyMember (upper) → input symbol. First input wins on overlap.
  const memberToInput = new Map<string, string>();
  for (const input of symbols) {
    result[input] = 0;
    for (const member of issuerSiblings(input)) {
      const key = member.toUpperCase();
      if (!memberToInput.has(key)) memberToInput.set(key, input);
    }
  }
  const members = [...memberToInput.keys()];
  const placeholders = members.map(() => "?").join(",");

  const rows = db
    .prepare(
      `WITH latest_holdings AS (
        SELECT h.* FROM holdings h
        WHERE ${latestHoldingsPredicate()}
      ),
      latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        s.id AS security_id,
        s.security_type,
        s.option_type,
        UPPER(COALESCE(s.underlying_symbol, s.symbol)) AS family_symbol,
        CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
          ELSE 0
        END AS mv
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
        AND (s.expiration_date IS NULL OR s.expiration_date >= date('now'))
        AND UPPER(COALESCE(s.underlying_symbol, s.symbol)) IN (${placeholders})`
    )
    .all(...members) as Array<{
      security_id: number;
      security_type: string | null;
      option_type: string | null;
      family_symbol: string;
      mv: number;
    }>;

  if (rows.length === 0) return result;

  const optionExposures = getOptionExposureMap(db);
  for (const row of rows) {
    const input = memberToInput.get(row.family_symbol);
    if (!input) continue;
    result[input] += exposureForHolding(row, optionExposures);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compute/exposure-families.test.ts`
Expected: PASS (4 tests). If the option-fallback test gets a Greeks-computed value instead of the ±2.5× fallback (because the in-memory DB happens to satisfy `computePortfolioGreeks`), it will differ from −2500 — in that case the test's expectation is wrong, not the code: assert `result.NVDA` is less than 12800 and greater than 0 instead, with a comment.

- [ ] **Step 5: Run the exposure + cockpit suites together**

Run: `npx vitest run tests/compute/exposure-families.test.ts tests/compute/exposure.test.ts tests/queries/earnings-cockpit.test.ts`
Expected: PASS — existing exposure tests untouched.

- [ ] **Step 6: Commit**

```bash
git add lib/compute/exposure.ts tests/compute/exposure-families.test.ts
git commit -m "feat(exposure): per-family net exposure for the earnings cockpit"
```

---

### Task 5: Cockpit + call-notes API routes

**Files:**
- Create: `app/api/earnings/cockpit/route.ts`
- Create: `app/api/earnings/call-notes/route.ts`
- Test: `tests/contracts/api-component-contracts.test.ts` (append two contract blocks)

**Interfaces:**
- Consumes: `buildCockpitPayload` (Task 3), `getCallNoteForEvent`/`upsertCallNote`/`GUIDANCE_VALUES` (Task 1).
- Produces: `GET /api/earnings/cockpit` → `{ success: true, data: CockpitPayload }`; `GET /api/earnings/call-notes?eventId=` → `{ success: true, data: EarningsCallNote | null }`; `POST /api/earnings/call-notes` body `{ eventId, guidance?, tone?, surprises?, followUps? }` → `{ success: true, data: EarningsCallNote }`. Errors: `{ success: false, error }` with 400/404/500.

- [ ] **Step 1: Check the db import style**

Open `app/api/earnings/bogeys/route.ts`, note its exact `db` import line (named vs default from `@/lib/db`), and use the identical line in both new routes.

- [ ] **Step 2: Write `app/api/earnings/cockpit/route.ts`**

```ts
import { db } from "@/lib/db"; // ← match bogeys route import style exactly
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ success: true, data: buildCockpitPayload(db) });
  } catch (err) {
    console.error("[cockpit] payload build failed:", err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to build cockpit" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Write `app/api/earnings/call-notes/route.ts`**

```ts
import { db } from "@/lib/db"; // ← match bogeys route import style exactly
import {
  getCallNoteForEvent,
  GUIDANCE_VALUES,
  type CallNoteGuidance,
} from "@/lib/queries/earnings-call-notes";
import { upsertCallNote } from "@/lib/mutations/earnings-call-notes";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { success: false, error: "Query param 'eventId' must be a positive integer." },
      { status: 400 }
    );
  }
  return Response.json({ success: true, data: getCallNoteForEvent(db, eventId) });
}

interface CallNoteBody {
  eventId?: unknown;
  guidance?: unknown;
  tone?: unknown;
  surprises?: unknown;
  followUps?: unknown;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as CallNoteBody;
  const eventId = body.eventId;
  if (typeof eventId !== "number" || !Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { success: false, error: "Body field 'eventId' must be a positive integer." },
      { status: 400 }
    );
  }
  const event = db
    .prepare("SELECT id, symbol, security_id FROM calendar_events WHERE id = ?")
    .get(eventId) as { id: number; symbol: string | null; security_id: number | null } | undefined;
  if (!event || !event.symbol) {
    return Response.json(
      { success: false, error: `No earnings event with id ${eventId}.` },
      { status: 404 }
    );
  }
  const guidance = body.guidance ?? null;
  if (guidance !== null && !GUIDANCE_VALUES.includes(guidance as CallNoteGuidance)) {
    return Response.json(
      { success: false, error: `'guidance' must be one of ${GUIDANCE_VALUES.join(", ")} or null.` },
      { status: 400 }
    );
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  try {
    const note = upsertCallNote(db, {
      eventId,
      securityId: event.security_id,
      symbol: event.symbol,
      guidance: guidance as CallNoteGuidance | null,
      tone: str(body.tone),
      surprises: str(body.surprises),
      followUps: str(body.followUps),
    });
    return Response.json({ success: true, data: note });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to save call note" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4: Append contract tests**

In `tests/contracts/api-component-contracts.test.ts`, append (reuse the file's existing `db` setup + seed helpers; adjust seed calls to the file's local helper names):

```ts
describe("EarningsCockpit contract", () => {
  it("buildCockpitPayload shape matches component destructuring", async () => {
    const { buildCockpitPayload } = await import("@/lib/queries/earnings-cockpit");
    const payload = buildCockpitPayload(db, new Date("2026-07-08T14:00:00Z"));
    // Component destructures: data.lanes.{bmo,amc,unknown}, data.carryover,
    // data.nextRelease, data.generatedAt, data.skippedRows
    expect(payload).toHaveProperty("lanes.bmo");
    expect(payload).toHaveProperty("lanes.amc");
    expect(payload).toHaveProperty("lanes.unknown");
    expect(payload).toHaveProperty("carryover");
    expect(payload).toHaveProperty("nextRelease");
    expect(payload).toHaveProperty("generatedAt");
    expect(payload).toHaveProperty("skippedRows");
  });
});

describe("CallNoteModal contract", () => {
  it("upsertCallNote returns the row shape the modal reads back", async () => {
    const { upsertCallNote } = await import("@/lib/mutations/earnings-call-notes");
    const eventId = db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual', 'earnings', '2026-07-08', 'X earnings', 'X', 'manual:X:contract')`
      )
      .run().lastInsertRowid as number;
    const note = upsertCallNote(db, { eventId, symbol: "X", guidance: "inline" });
    // Modal reads: guidance, tone, surprises, follow_ups
    expect(note).toHaveProperty("guidance", "inline");
    expect(note).toHaveProperty("tone");
    expect(note).toHaveProperty("surprises");
    expect(note).toHaveProperty("follow_ups");
    expect(note).toHaveProperty("event_id", eventId);
  });
});
```

- [ ] **Step 5: Run contract tests**

Run: `npx vitest run tests/contracts/api-component-contracts.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/api/earnings/cockpit/route.ts app/api/earnings/call-notes/route.ts tests/contracts/api-component-contracts.test.ts
git commit -m "feat(earnings): cockpit + call-notes API routes with contract tests"
```

---

### Task 6: Composer prompt wiring (call notes → recap + preview)

**Files:**
- Modify: `lib/digest/send-earnings-email.ts`
- Test: `tests/digest/earnings-call-note-blocks.test.ts`

**Interfaces:**
- Consumes: Task 1's `getCallNoteForEvent`, `getLatestCallNoteForFamily`, `EarningsCallNote`.
- Produces (exported for tests): `renderCallNoteBlock(note: EarningsCallNote | null): string`, `renderPriorCallNoteBlock(note: EarningsCallNote | null): string`. Context fields: `PreviewContext.priorCallNote: EarningsCallNote | null`, `RecapContext.callNote: EarningsCallNote | null`.

- [ ] **Step 1: Write the failing test**

`tests/digest/earnings-call-note-blocks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  renderCallNoteBlock,
  renderPriorCallNoteBlock,
} from "@/lib/digest/send-earnings-email";
import type { EarningsCallNote } from "@/lib/queries/earnings-call-notes";

const NOTE: EarningsCallNote = {
  id: 1,
  event_id: 10,
  security_id: null,
  symbol: "NVDA",
  guidance: "lowered",
  tone: "defensive on China questions",
  surprises: "Gross margin guide below every bogey",
  follow_ups: "Recheck hyperscaler capex commentary next week",
  created_at: "2026-07-08 21:30:00",
  updated_at: "2026-07-08 21:30:00",
};

describe("call note prompt blocks", () => {
  it("recap block states guidance explicitly and includes every filled field", () => {
    const block = renderCallNoteBlock(NOTE);
    expect(block).toContain("## Your call notes");
    expect(block).toContain("guidance: **LOWERED**");
    expect(block).toContain("defensive on China questions");
    expect(block).toContain("Gross margin guide below every bogey");
    expect(block).toContain("Recheck hyperscaler capex commentary");
  });

  it("returns empty string for null note or all-empty note", () => {
    expect(renderCallNoteBlock(null)).toBe("");
    expect(
      renderCallNoteBlock({ ...NOTE, guidance: null, tone: null, surprises: null, follow_ups: null })
    ).toBe("");
  });

  it("preview block uses the prior-quarter framing", () => {
    const block = renderPriorCallNoteBlock(NOTE);
    expect(block).toContain("## Last quarter's call, in your words");
    expect(block).toContain("**LOWERED**");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest/earnings-call-note-blocks.test.ts`
Expected: FAIL — `renderCallNoteBlock` not exported.

- [ ] **Step 3: Implement in `lib/digest/send-earnings-email.ts`**

(a) Imports (top of file, merge with existing):

```ts
import {
  getCallNoteForEvent,
  getLatestCallNoteForFamily,
  type EarningsCallNote,
} from "@/lib/queries/earnings-call-notes";
```

(b) Add fields to the context interfaces (locate `interface PreviewContext` ~line 418 and `interface RecapContext` ~line 466):

```ts
// in PreviewContext:
  priorCallNote: EarningsCallNote | null;
// RecapContext extends PreviewContext — add:
  callNote: EarningsCallNote | null;
```

(c) Populate in the builders. In `buildPreviewContext`, next to the `getNotesForFamily(db, family, 90)` call, add:

```ts
    priorCallNote: getLatestCallNoteForFamily(db, symbol, event.event_date),
```

In `buildRecapContext`, add:

```ts
    callNote: getCallNoteForEvent(db, event.id),
```

(If `buildRecapContext` delegates to `buildPreviewContext` and spreads, add `priorCallNote` there once and `callNote` in the recap-specific object.)

(d) Add the two renderers near `renderUserNotesBlock` (~line 1395) and EXPORT them:

```ts
const GUIDANCE_LABELS: Record<string, string> = {
  raised: "RAISED",
  inline: "IN LINE",
  lowered: "LOWERED",
  not_given: "NOT GIVEN",
};

function callNoteLines(note: EarningsCallNote): string[] {
  const lines: string[] = [];
  const label = note.guidance ? GUIDANCE_LABELS[note.guidance] : null;
  if (label) lines.push(`- You marked guidance: **${label}**`);
  if (note.tone) lines.push(`- Management tone: ${note.tone}`);
  if (note.surprises) lines.push(`- Surprises: ${note.surprises}`);
  if (note.follow_ups) lines.push(`- Follow-ups: ${note.follow_ups}`);
  return lines;
}

/** Recap: the user's own structured capture from during/after the call. */
export function renderCallNoteBlock(note: EarningsCallNote | null): string {
  if (!note) return "";
  const lines = callNoteLines(note);
  if (lines.length === 0) return "";
  return `\n## Your call notes (captured during/after the call)\n${lines.join("\n")}\n`;
}

/** Preview: prior quarter's capture — continuity with the user's own read. */
export function renderPriorCallNoteBlock(note: EarningsCallNote | null): string {
  if (!note) return "";
  const lines = callNoteLines(note);
  if (lines.length === 0) return "";
  return `\n## Last quarter's call, in your words\n${lines.join("\n")}\n`;
}
```

(e) Slot into the prompt assemblies — user notes stay FIRST, call notes come IMMEDIATELY after. In `renderPreviewPrompt` (~line 1082), where the template interpolates `${userNotesBlock}`, change:

```ts
${userNotesBlock}
${renderPriorCallNoteBlock(ctx.priorCallNote)}
${bogeysBlock}
```

In `renderRecapPrompt` (~line 1147), change the corresponding spot:

```ts
${userNotesBlock}
${renderCallNoteBlock(ctx.callNote)}
${bogeysBlock}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/digest/earnings-call-note-blocks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole digest suite (composer is heavily pinned)**

Run: `npx vitest run tests/digest`
Expected: PASS — if an existing prompt-snapshot test pins the exact assembly, update its expectation to include the (empty-string) call-note slot; an absent note renders `""` so most snapshots should be unchanged.

- [ ] **Step 6: Commit**

```bash
git add lib/digest/send-earnings-email.ts tests/digest/earnings-call-note-blocks.test.ts
git commit -m "feat(earnings): call notes feed recap + next-quarter preview prompts"
```

---

### Task 7: `<CallNoteModal>` component

**Files:**
- Create: `app/dashboard/today/CallNoteModal.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/earnings/call-notes` (Task 5).
- Produces: `export function CallNoteModal({ eventId, symbol, open, onClose, onSaved }: { eventId: number; symbol: string; open: boolean; onClose: () => void; onSaved: () => void }): JSX.Element | null` — Task 8 mounts it.

- [ ] **Step 1: Implement the modal**

`app/dashboard/today/CallNoteModal.tsx` — follow `BogeysEditModal.tsx` for the overlay/portal idiom (check how it renders the backdrop and closes; copy that shell). Full component:

```tsx
"use client";

import { useEffect, useState } from "react";

const GUIDANCE_OPTIONS = [
  { value: "raised", label: "Raised" },
  { value: "inline", label: "In line" },
  { value: "lowered", label: "Lowered" },
  { value: "not_given", label: "Not given" },
] as const;

type Guidance = (typeof GUIDANCE_OPTIONS)[number]["value"];

interface Props {
  eventId: number;
  symbol: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function CallNoteModal({ eventId, symbol, open, onClose, onSaved }: Props) {
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [tone, setTone] = useState("");
  const [surprises, setSurprises] = useState("");
  const [followUps, setFollowUps] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    fetch(`/api/earnings/call-notes?eventId=${eventId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data) {
          setGuidance(json.data.guidance ?? null);
          setTone(json.data.tone ?? "");
          setSurprises(json.data.surprises ?? "");
          setFollowUps(json.data.follow_ups ?? "");
        } else if (json.success) {
          setGuidance(null); setTone(""); setSurprises(""); setFollowUps("");
        }
      })
      .catch(() => setError("Couldn't load the existing note — saving will overwrite."))
      .finally(() => setLoading(false));
  }, [open, eventId]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/earnings/call-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, guidance, tone, surprises, followUps }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.error ?? `Save failed (HTTP ${res.status}).`);
        return; // honest feedback: modal stays open, error visible
      }
      onSaved();
      onClose();
    } catch {
      setError("Save failed — network error. Your text is still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl bg-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ink">
          {symbol} — call notes
        </h3>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          Feeds tonight&apos;s recap email and next quarter&apos;s preview.
        </p>

        <div className="mt-3">
          <span className="text-[11px] uppercase tracking-wide text-ink-faint">Guidance</span>
          <div className="mt-1 flex gap-1">
            {GUIDANCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setGuidance(guidance === opt.value ? null : opt.value)}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  guidance === opt.value
                    ? "bg-gold/20 text-gold"
                    : "bg-raised text-ink-dim hover:text-ink"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {(
          [
            ["Management tone", tone, setTone, "Confident? Defensive? What stood out on the call."],
            ["Surprises", surprises, setSurprises, "Anything the bogeys didn't prepare you for."],
            ["Follow-ups", followUps, setFollowUps, "What to check before next quarter."],
          ] as const
        ).map(([label, value, setter, placeholder]) => (
          <label key={label} className="mt-3 block">
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</span>
            <textarea
              value={value}
              onChange={(e) => setter(e.target.value)}
              placeholder={placeholder}
              rows={2}
              className="mt-1 w-full rounded-lg border border-edge bg-canvas p-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </label>
        ))}

        {error && <p className="mt-2 text-[12px] text-down">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-dim hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="rounded-lg bg-gold px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (If the repo's modals use `createPortal` into `document.body`, match that idiom from `BogeysEditModal` instead of the plain fixed div.)

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/today/CallNoteModal.tsx
git commit -m "feat(earnings): structured post-call capture modal"
```

---

### Task 8: `<EarningsCockpit>` component + mount

**Files:**
- Create: `app/dashboard/today/EarningsCockpit.tsx`
- Modify: `app/dashboard/today/page.tsx` (mount above `<EarningsHub />`)

**Interfaces:**
- Consumes: `GET /api/earnings/cockpit` (Task 5), `CallNoteModal` (Task 7), existing `EarningsEmailViewer`, `BogeysEditModal`, `Chip`, `Money`.
- Produces: `export function EarningsCockpit(): JSX.Element | null`.

- [ ] **Step 1: Implement the component**

`app/dashboard/today/EarningsCockpit.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Chip, type ChipTone } from "@/app/dashboard/components/Chip";
import { Money } from "@/lib/privacy/components";
import { EarningsEmailViewer } from "@/app/dashboard/components/EarningsEmailViewer";
import { BogeysEditModal } from "./BogeysEditModal";
import { CallNoteModal } from "./CallNoteModal";

const POLL_MS = 60_000;

// Mirrors CockpitPayload / CockpitRow from lib/queries/earnings-cockpit.ts.
interface Stages {
  preview: string;
  released: { state: string; releaseInstant: string | null };
  actual: string;
  reaction: { state: string; source: string | null; readyAt: string | null };
  recap: string;
}
interface Row {
  eventId: number;
  symbol: string;
  securityId: number | null;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  symbolStatus: "held" | "watchlist";
  consensus: string;
  actual: string | null;
  stages: Stages;
  netExposure: number;
  isTopExposure: boolean;
  hasCallNote: boolean;
  carryover: boolean;
}
interface Payload {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: Row[]; amc: Row[]; unknown: Row[] };
  carryover: Row[];
  skippedRows: number;
}

const SEND_TONES: Record<string, ChipTone> = {
  sent: "up",
  "sent-by-cloud": "info",
  "in-flight": "warn",
  skipped: "neutral",
  pending: "neutral",
  waiting: "neutral",
  missed: "down",
  blocked: "down",
};
const SEND_GLYPHS: Record<string, string> = {
  sent: "✓",
  "sent-by-cloud": "☁",
  "in-flight": "…",
  skipped: "–",
  pending: "",
  waiting: "",
  missed: "✗",
  blocked: "✗",
};

function chipFor(label: string, state: string): { tone: ChipTone; text: string } {
  const glyph = SEND_GLYPHS[state] ?? "";
  return { tone: SEND_TONES[state] ?? "neutral", text: glyph ? `${label} ${glyph}` : label };
}

function fmtCountdown(msLeft: number): string {
  if (msLeft <= 0) return "now";
  const totalMin = Math.floor(msLeft / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const s = Math.floor((msLeft % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function EarningsCockpit() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [stale, setStale] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/earnings/cockpit");
      const json = await res.json();
      if (res.ok && json.success) {
        setPayload(json.data);
        setStale(false);
      } else {
        setStale(true);
      }
    } catch {
      setStale(true); // keep last good payload; never blank a rendered cockpit
    } finally {
      loadedOnce.current = true;
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // 1s countdown tick — only while something is upcoming.
  const hasUpcoming = !!payload?.nextRelease;
  useEffect(() => {
    if (!hasUpcoming) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasUpcoming]);

  if (!payload) return null;
  const { lanes, carryover, nextRelease } = payload;
  const total = lanes.bmo.length + lanes.amc.length + lanes.unknown.length + carryover.length;
  if (total === 0) return null;

  return (
    <section className="rounded-xl bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-widest text-ink-dim">
          Earnings day
          <span className="ml-2 text-ink-faint">
            {total} reporter{total === 1 ? "" : "s"}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          {nextRelease && (
            <span className="font-mono text-[12px] text-gold">
              {nextRelease.symbol} in {fmtCountdown(Date.parse(nextRelease.releaseInstant) - nowMs)}
            </span>
          )}
          {stale && <span className="text-[11px] italic text-ink-faint">stale, retrying…</span>}
        </div>
      </div>

      {carryover.length > 0 && (
        <Lane label="yesterday — unfinished" rows={carryover} tint />
      )}
      {lanes.bmo.length > 0 && <Lane label="before the open" rows={lanes.bmo} />}
      {lanes.amc.length > 0 && <Lane label="after the close" rows={lanes.amc} />}
      {lanes.unknown.length > 0 && <Lane label="time unknown" rows={lanes.unknown} />}
    </section>
  );

  function Lane({ label, rows, tint }: { label: string; rows: Row[]; tint?: boolean }) {
    return (
      <div className={`mt-3 rounded-lg ${tint ? "bg-amber-500/10 p-2" : ""}`}>
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{label}</div>
        <ul className="mt-1 space-y-2">
          {rows.map((row) => (
            <CockpitRowView key={row.eventId} row={row} onChanged={load} />
          ))}
        </ul>
      </div>
    );
  }
}

function CockpitRowView({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const [viewerPhase, setViewerPhase] = useState<"preview" | "recap" | null>(null);
  const [actualsOpen, setActualsOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const preview = chipFor("pre", row.stages.preview);
  const actual = chipFor("act", row.stages.actual);
  const reaction =
    row.stages.reaction.state === "captured"
      ? { tone: "up" as ChipTone, text: `rxn ✓${row.stages.reaction.source ? ` ${row.stages.reaction.source}` : ""}` }
      : { tone: "neutral" as ChipTone, text: "rxn" };
  const recap = chipFor("rec", row.stages.recap);
  const released = row.stages.released;
  const releasedChip =
    released.state === "released"
      ? { tone: "gold" as ChipTone, text: "released" }
      : released.state === "upcoming"
        ? { tone: "neutral" as ChipTone, text: row.releaseTime ?? row.eventTime ?? "—" }
        : { tone: "neutral" as ChipTone, text: row.eventTime ?? "time?" };

  const previewClickable = row.stages.preview === "sent" || row.stages.preview === "sent-by-cloud";
  const recapClickable = row.stages.recap === "sent" || row.stages.recap === "sent-by-cloud";
  const blocked = row.stages.actual === "blocked";
  const showNote = released.state === "released";

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {row.isTopExposure && (
          <span className="text-gold" title="Largest exposure in this lane">◆</span>
        )}
        {row.securityId ? (
          <Link
            href={`/dashboard/security/${row.securityId}`}
            className="font-mono text-[13px] font-semibold text-gold hover:underline"
          >
            {row.symbol}
          </Link>
        ) : (
          <span className="font-mono text-[13px] font-semibold text-ink">{row.symbol}</span>
        )}
        <Chip tone={row.symbolStatus === "held" ? "up" : "info"} size="xs" uppercase>
          {row.symbolStatus === "held" ? "held" : "watch"}
        </Chip>
        {row.netExposure !== 0 && (
          <span className="text-[12px] text-ink-dim">
            <Money value={row.netExposure} signed />
          </span>
        )}
      </span>

      <span className="text-[12px] text-ink-faint">
        {row.consensus && <>cons {row.consensus}</>}
        {row.actual && <> → <span className="text-ink">{row.actual}</span></>}
      </span>

      <span className="ml-auto flex flex-wrap items-center gap-1">
        <Chip tone={releasedChip.tone} size="xs">{releasedChip.text}</Chip>
        <ChipButton
          chip={preview}
          onClick={previewClickable ? () => setViewerPhase("preview") : undefined}
        />
        <ChipButton chip={actual} onClick={blocked ? () => setActualsOpen(true) : undefined} />
        <Chip tone={reaction.tone} size="xs">{reaction.text}</Chip>
        <ChipButton
          chip={recap}
          onClick={recapClickable ? () => setViewerPhase("recap") : undefined}
        />
        {showNote && (
          <button
            type="button"
            onClick={() => setNoteOpen(true)}
            className="relative inline-flex items-center rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-dim hover:text-ink active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
          >
            {row.hasCallNote ? "✎ note" : "+ note"}
          </button>
        )}
      </span>

      {viewerPhase && (
        <EarningsEmailViewer
          eventId={row.eventId}
          phase={viewerPhase}
          open={true}
          onClose={() => setViewerPhase(null)}
        />
      )}
      <BogeysEditModal
        eventId={row.eventId}
        symbol={row.symbol}
        open={actualsOpen}
        onClose={() => {
          setActualsOpen(false);
          onChanged();
        }}
      />
      <CallNoteModal
        eventId={row.eventId}
        symbol={row.symbol}
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        onSaved={onChanged}
      />
    </li>
  );
}

function ChipButton({
  chip,
  onClick,
}: {
  chip: { tone: ChipTone; text: string };
  onClick?: () => void;
}) {
  if (!onClick) return <Chip tone={chip.tone} size="xs">{chip.text}</Chip>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
    >
      <Chip tone={chip.tone} size="xs" className="cursor-pointer">
        {chip.text}
      </Chip>
    </button>
  );
}
```

NOTE: `Chip` may not accept `className` pass-through for cursor — it does (`className` prop exists). `BogeysEditModal` opens with the actuals-override form always visible inline; no extra prop needed.

- [ ] **Step 2: Mount in `app/dashboard/today/page.tsx`**

Import at the top with the other today components:

```tsx
import { EarningsCockpit } from "./EarningsCockpit";
```

Insert directly ABOVE the existing `<EarningsHub />` mount (find the comment `{/* ── Week-ahead Earnings Hub … ── */}`):

```tsx
      {/* ── Earnings-day cockpit (auto-appears on report days) ── */}
      <EarningsCockpit />

      {/* ── Week-ahead Earnings Hub (full width — primary attention magnet) ── */}
      <EarningsHub />
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npx next build 2>&1 | tail -20`
Expected: clean compile, build succeeds. (`EarningsEmailViewer` import path: `@/app/dashboard/components/EarningsEmailViewer` — verify against the actual file location and adjust if it lives elsewhere.)

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/today/EarningsCockpit.tsx app/dashboard/today/page.tsx
git commit -m "feat(earnings): earnings-day cockpit block on Today"
```

---

### Task 9: Full suite, E2E against a staged sandbox, docs, close-out

**Files:**
- Modify: `CLAUDE.md` (one convention entry), `docs/plans/TODO.md` (close the cockpit item)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: ALL PASS (3213 pre-existing + ~27 new). Fix any breakage before proceeding.

- [ ] **Step 2: Stage an isolated E2E sandbox**

Never touch `data/vanguard.db`. Build a staged demo DB + server on :3096:

```bash
rm -f data/demo-cockpit.db
npx tsx scripts/seed-demo.ts    # creates data/demo.db
cp data/demo.db data/demo-cockpit.db
sqlite3 data/demo-cockpit.db "
  -- Today's reporters at every pipeline stage (dates relative to now):
  INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, symbol, source_key, consensus_estimate)
  VALUES ('finnhub','earnings', date('now'), 'AMC', '16:20', 'NVDA earnings', 'NVDA', 'e2e:nvda', 'EPS 0.94 · Rev 44100000000');
  INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, symbol, source_key, consensus_estimate, actual_value, reaction_snapshot, enriched_at)
  VALUES ('finnhub','earnings', date('now'), 'BMO', '07:00', 'JPM earnings', 'JPM', 'e2e:jpm', 'EPS 4.62 · Rev 44800000000', 'EPS 4.71 · Rev 45200000000', '{\"source\":\"yahoo\"}', datetime('now'));
  INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
  SELECT id, 'preview', 'e2e@x.z', datetime('now','-3 hours'), NULL FROM calendar_events WHERE source_key='e2e:jpm';
  -- Carryover: yesterday, released, no actual → blocked strip:
  INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, symbol, source_key, consensus_estimate)
  VALUES ('finnhub','earnings', date('now','-1 day'), 'AMC', '16:05', 'AAPL earnings', 'AAPL', 'e2e:aapl', 'EPS 2.35 · Rev 96000000000');
"
DATABASE_PATH="$PWD/data/demo-cockpit.db" ANTHROPIC_API_KEY= FINNHUB_API_KEY= RESEND_API_KEY= PUSHOVER_APP_TOKEN= PUSHOVER_USER_KEY= GMAIL_ADDRESS= GMAIL_APP_PASSWORD= GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET= GOOGLE_REFRESH_TOKEN= WORKER_MARKER_URL= CRON_SHARED_SECRET= IBKR_ACCOUNT_CODE= \
  npx next dev -p 3096 &
```

(NVDA/JPM/AAPL are held in the demo seed, so `getSymbolStatus` keeps all three.)

- [ ] **Step 3: E2E via agent-browser**

Dispatch an agent-browser agent against `http://localhost:3096/dashboard/today` to verify, with screenshots:
1. Cockpit section appears above the Earnings Hub with 3 reporters (carryover strip "yesterday — unfinished" with AAPL, BMO lane with JPM, AMC lane with NVDA).
2. JPM row: `pre ✓` (up tone), `released`, `act ✓`, `rxn ✓ yahoo`; NVDA row: countdown in the header pointing at NVDA, release chip shows `16:20`.
3. AAPL carryover row: `act ✗` blocked chip is a tappable button → opens the Bogeys/actuals modal; entering EPS+Rev in "Reported actuals" and saving flips the row on the next poll (or after reopening).
4. JPM (released) shows the `+ note` button → CallNoteModal opens; pick "Lowered", type text in all three boxes, Save → button reads "✎ note" after refetch.
5. Mobile viewport (390×844): lanes stack, chips wrap, all buttons tappable, no horizontal scroll.
6. No console errors.

- [ ] **Step 4: Tear down sandbox**

```bash
PID=$(lsof -ti TCP:3096 -sTCP:LISTEN); [ -n "$PID" ] && kill $PID
rm -f data/demo-cockpit.db
```

- [ ] **Step 5: Document**

Add to `CLAUDE.md` (in the Architecture bullet list, after the Earnings digest entry) a concise entry:

```markdown
- **Earnings-day cockpit (2026-07-08)** — `<EarningsCockpit>` on `/dashboard/today` (above EarningsHub): BMO/AMC lanes of today's + unfinished-yesterday held/watchlist reporters, live 5-stage chips (preview → released → actual → reaction → recap), countdown, per-family delta-adjusted net exposure (`getNetExposureForSymbolFamilies`), 60s visibility-gated polling of `GET /api/earnings/cockpit`. **Read-only over the pipeline** — stage state derives in pure `lib/earnings/cockpit-stages.ts::deriveEventStages` (2h blocked rule mirrors email-sweep; reaction-ready label mirrors REACTION_READY_MS; email tri-state read via `getEmailStatesForEvents`, the ONLY earnings_emails reader that surfaces `'in_progress'` claims — never reuse getSentPhasesForEvents when in-flight must show). Structured post-call capture: migration 064 `earnings_call_notes` (one per event, guidance enum raised/inline/lowered/not_given), `<CallNoteModal>`, feeds the recap prompt (`renderCallNoteBlock`, right after user notes) and next quarter's preview (`renderPriorCallNoteBlock` via family-aware `getLatestCallNoteForFamily`). Spec: `docs/superpowers/specs/2026-07-08-earnings-cockpit-design.md`.
```

In `docs/plans/TODO.md`, update the "Earnings week-2 batch" entry: mark the cockpit + post-call quick-capture pieces ✅ SHIPPED 2026-07-08 (leaving the intelligence-tier tail open).

- [ ] **Step 6: Final commit**

```bash
git add CLAUDE.md docs/plans/TODO.md
git commit -m "docs: earnings cockpit conventions entry + TODO close-out"
```

- [ ] **Step 7: Report**

Report: test counts (before/after), E2E results with screenshots, and the "Where to see this" user-facing summary (route: `/dashboard/today` on a day with reporters).
