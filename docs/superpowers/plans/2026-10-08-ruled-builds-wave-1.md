# Ruled Builds, Wave 1 (small and safe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the eight smallest owner rulings of 2026-10-08, none of which changes a stored figure, a database schema or the Cloudflare Worker.

**Architecture:** Eight tasks with disjoint file sets, so they run as parallel sub-agents in one sibling worktree. Each task is test-first. No task touches the Worker, a migration, the import pipeline or the chat wiring.

**Tech Stack:** Next.js 16, TypeScript 5, better-sqlite3 (in-memory SQLite in tests), Vitest.

**Spec:** `docs/DECISIONS.md`, the three entries dated 2026-10-08 (the sprint questions, the direction findings, and "Design choices found while mapping the ruled builds to code"). The to-do entry "Ruled builds, 2026-10-08" in `docs/plans/TODO.md` lists every build; this plan covers items (a), (b), (c), (e), (r5), (r18), the scoring half of (o), and the repair-script message.

## Global Constraints

- Run every command from the worktree root with `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH` in front.
- Builders never run git. The controller commits by pathspec, one git command at a time.
- Each builder edits only the files its task lists. A needed change outside the list is reported, not made.
- Tests use in-memory SQLite (`new Database(":memory:")` plus `runMigrations(db)`). No test fixture carries a real figure: tickers are synthetic or public, amounts are invented.
- All dates are `YYYY-MM-DD`. A user-facing "today" is `todayET()`, never `new Date().toISOString().slice(0, 10)`.
- Portfolio-derived dollars render through `<Money>` (`lib/privacy/components.tsx`).
- The glyphs in Task 5 (check mark, almost-equal sign, middle dot) appear in this plan as raw characters because the editing tools turn `\uNNNN` escapes into raw bytes. `lib/queries/reconciliation.ts` writes them as escapes today (`"✓"`, `" · "`). Either form compiles to the same string; leave the existing escapes on lines you do not otherwise change, and run `file <path>` on any file you edit to confirm it is still UTF-8 text.
- Not in this wave, by ruling or by file ownership: anything under `workers/cron/`, any migration, `app/api/chat/route.ts`, `ChatInterface.tsx`, `lib/import/**`, and these components owned by wave 2: `DigestEmailViewer.tsx`, `AnalysisView.tsx`, `EarningsEmailViewer.tsx`, the nav components.
- After all tasks: `npm run verify:changed`, then `bash scripts/verify.sh full --base main`, then `npx tsc --noEmit`. Report the test count.

## Review Focus

1. **A reconciliation statement value of zero or less.** The form refuses it, but an old row could hold one. The band must not divide by zero or return `NaN`; it falls back to the flat-dollar reading. Pinned in Task 5.
2. **Confirming a date for a symbol that has no row yet on that date.** The typed-time rule reads an existing row; with none, the first insert must behave exactly as before. Pinned in Task 4.
3. **A typed clock time whose slot differs from the slot picked.** A row typed as 07:30 confirmed as "amc" is a deliberate change and must move to the after-close time. Pinned in Task 4.
4. **The digest sender called with `since_date` but no date.** Today that falls through to the Eastern-yesterday fallback; the extraction must keep it. Pinned in Task 6.
5. **A recap that does have a reaction snapshot.** The prompt change is for the no-snapshot branch only; with a snapshot the prompt must still print it. Pinned in Task 7.

---

### Task 1: Week view says "Entered by you"

**Files:**
- Modify: `app/dashboard/today/WeekAheadView.tsx:339`
- Test (create): `tests/dashboard/week-ahead-hand-entered-wording.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `WeekAheadView.tsx` is a server component and `HAND_ENTERED_LABEL` lives in a `"use client"` file, so the wording is a literal here, pinned equal to the chip's constant by the test.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("hand-entered earnings row wording", () => {
  const weekView = read("app/dashboard/today/WeekAheadView.tsx");
  const chip = read("app/dashboard/today/EarningsDateChip.tsx");

  it("the Hub chip's label is the ruled wording", () => {
    expect(chip).toContain('export const HAND_ENTERED_LABEL = "Entered by you";');
  });

  it("the week view uses the same wording and drops the old one", () => {
    expect(weekView).toContain("Entered by you");
    expect(weekView).not.toContain("added by hand");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/dashboard/week-ahead-hand-entered-wording.test.ts`
Expected: FAIL on "the week view uses the same wording".

- [ ] **Step 3: Change the wording**

In `app/dashboard/today/WeekAheadView.tsx`, inside `RemoveRow`, replace the line `      added by hand` with:

```tsx
      Entered by you
```

- [ ] **Step 4: Run the test and its neighbour**

Run: `npx vitest run tests/dashboard/week-ahead-hand-entered-wording.test.ts tests/dashboard/week-ahead-cards-a12-b47.test.ts`
Expected: PASS.

- [ ] **Step 5: Hand back** the two paths for the controller to commit: `fix(today): a hand-entered earnings row reads "Entered by you" on the week view`.

---

### Task 2: `finish-donations.ts` needs the acknowledgement

**Files:**
- Modify: `scripts/assign-donation-lots-by-method.ts:52` and `:298-306`
- Modify: `scripts/finish-donations.ts:25-32` and `:98`
- Test (create): `tests/scripts/donation-scripts-acknowledgement.test.ts`

**Why the database path changes too (Codex review):** the script hard-codes the live database, so an apply could never be rehearsed on a copy. It now honours `REPAIR_DB_PATH`, like the assignment script.

**Interfaces:**
- Produces: `export function resolveDbPath(env?: NodeJS.ProcessEnv): string` from `scripts/finish-donations.ts`: `env.REPAIR_DB_PATH` when set, else `<cwd>/data/vanguard.db`.
- Produces: `export const ACK_FLAG = "--acknowledge-repair"` and `export function assertWriteAcknowledged(argv: string[], apply: boolean): void` from `scripts/assign-donation-lots-by-method.ts`. It throws when `apply` is true and `argv` lacks the flag; it returns silently otherwise.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { ACK_FLAG, assertWriteAcknowledged } from "../../scripts/assign-donation-lots-by-method";
import { resolveDbPath } from "../../scripts/finish-donations";

describe("donation scripts need an acknowledgement to write", () => {
  it("a dry run needs no flag", () => {
    expect(() => assertWriteAcknowledged(["node", "script"], false)).not.toThrow();
  });

  it("an apply without the flag is refused", () => {
    expect(() => assertWriteAcknowledged(["node", "script", "--apply"], true)).toThrow(
      /--acknowledge-repair/,
    );
  });

  it("an apply with the flag passes", () => {
    expect(() => assertWriteAcknowledged(["node", "script", "--apply", ACK_FLAG], true)).not.toThrow();
  });

  it("finish-donations checks the acknowledgement before it opens the database", () => {
    const src = readFileSync(join(process.cwd(), "scripts/finish-donations.ts"), "utf8");
    const check = src.indexOf("assertWriteAcknowledged(process.argv, apply)");
    const open = src.indexOf("new Database(");
    const undo = src.indexOf("undoImport(db");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(open);
    expect(check).toBeLessThan(undo);
  });

  it("finish-donations opens the rehearsal copy when REPAIR_DB_PATH is set", () => {
    expect(resolveDbPath({ REPAIR_DB_PATH: "/tmp/rehearsal.db" })).toBe("/tmp/rehearsal.db");
    expect(resolveDbPath({})).toBe(path.join(process.cwd(), "data", "vanguard.db"));
    const src = readFileSync(join(process.cwd(), "scripts/finish-donations.ts"), "utf8");
    expect(src).toContain("new Database(resolveDbPath(),");
  });

  it("finish-donations runs only when executed directly", () => {
    const src = readFileSync(join(process.cwd(), "scripts/finish-donations.ts"), "utf8");
    expect(src).toMatch(/if \(isDirectRun\) main\(\);/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/scripts/donation-scripts-acknowledgement.test.ts`
Expected: FAIL, `assertWriteAcknowledged` is not exported. (Importing `finish-donations` also runs its `main()` until Step 4 adds the direct-run guard; that is part of the failure.)

- [ ] **Step 3: Export the guard from the assignment script**

In `scripts/assign-donation-lots-by-method.ts`, change line 52 to:

```ts
export const ACK_FLAG = "--acknowledge-repair";

/** Refuses a write that was not acknowledged. Dry-run (apply = false) always passes. */
export function assertWriteAcknowledged(argv: string[], apply: boolean): void {
  if (apply && !argv.includes(ACK_FLAG)) {
    throw new Error(
      `Refusing to write without ${ACK_FLAG}. Dry-run is the default; rehearse on a REPAIR_DB_PATH copy first.`,
    );
  }
}
```

and in its `main()` replace the three-line `if (apply && !process.argv.includes(ACK_FLAG)) { throw … }` block with:

```ts
  assertWriteAcknowledged(process.argv, apply);
```

- [ ] **Step 4: Use the guard in `finish-donations.ts`**

Change the import on line 25 to:

```ts
import { assertWriteAcknowledged, runAssignment } from "./assign-donation-lots-by-method";
```

Replace the `const DB_PATH = …` line with:

```ts
/** REPAIR_DB_PATH points the script at a rehearsal copy; the live database is the default. */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
}
```

Change the first lines of `main()` to:

```ts
function main() {
  const apply = process.argv.includes("--apply");
  assertWriteAcknowledged(process.argv, apply);
  const db = new Database(resolveDbPath(), { timeout: 60000 });
```

Leave the two hard-coded constants on lines 28 and 76 (a batch filename and one symbol-and-date check) exactly as they are: whether this finished one-off script should be generalised or removed is an open owner question, not part of this task.

Replace the last line `main();` with:

```ts
const isDirectRun = process.argv[1]?.includes("finish-donations");
if (isDirectRun) main();
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/scripts/donation-scripts-acknowledgement.test.ts tests/scripts/assign-donation-lots-by-method.test.ts`
Expected: PASS.

- [ ] **Step 6: Hand back** the three paths: `fix(scripts): finish-donations refuses to write without the acknowledgement and honours REPAIR_DB_PATH`.

---

### Task 3: The pair-repair script reports the outbox truthfully

**Files:**
- Modify: `scripts/repair-manual-feed-earnings-pairs.ts:227-234`
- Test (modify): `tests/scripts/repair-manual-feed-earnings-pairs.test.ts` (append one case)

**Interfaces:**
- Consumes: `writeArmedEventsOutboxRow(db, { today }): { generation: number; written: boolean }` from `lib/earnings/cloud-outbox.ts` (it must run inside a transaction and returns `written: false` when the projection is unchanged).

- [ ] **Step 1: Append the failing test**

Add this import beside the existing ones:

```ts
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
```

Add inside the `describe("repair-manual-feed-earnings-pairs", …)` block:

```ts
  it("reports no outbox row when the armed projection did not change", () => {
    seed({ source: "manual", symbol: "ZZQ", date: OLD });
    seed({ source: "nasdaq", symbol: "ZZQ", date: OLD });
    // Settle the baseline first, so the repair's own call is the no-op case.
    db.transaction(() => writeArmedEventsOutboxRow(db, { today: TODAY }))();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get() as { n: number }).n;

    const result = runManualFeedPairRepair(db, { apply: true, acknowledgeRepair: true, today: TODAY });

    const after = (db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get() as { n: number }).n;
    expect(result.hidden).toBe(1);
    expect(after).toBe(before);
    expect(result.outboxWritten).toBe(false);
    expect(formatPlan(result).join("\n")).not.toContain("outbox row was written");
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/scripts/repair-manual-feed-earnings-pairs.test.ts`
Expected: the new case FAILS on `expect(result.outboxWritten).toBe(false)`.

- [ ] **Step 3: Read the writer's answer**

Replace lines 227-234 with:

```ts
    let outboxWritten = false;
    // Hiding a feed row can change the armed projection's superseded ids even
    // when the fold moved nothing; the writer is a no-op when the projection
    // is unchanged, so ask whenever a row was hidden and report what it did.
    if (anyMerged || hidden > 0) {
      outboxWritten = writeArmedEventsOutboxRow(db, { today }).written;
    }
```

- [ ] **Step 4: Run the file**

Run: `npx vitest run tests/scripts/repair-manual-feed-earnings-pairs.test.ts`
Expected: PASS, every case.

- [ ] **Step 5: Hand back** both paths: `fix(scripts): the earnings pair repair says an outbox row was written only when one was`.

---

### Task 4: Confirming a date keeps a typed clock time

**Files:**
- Modify: `lib/mutations/confirm-earnings-date.ts:24-27` and `:64-106`
- Test (modify): `tests/mutations/confirm-earnings-date.test.ts` (append cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `confirmEarningsDate(db, input)` keeps its shape.

**Rule (owner, 2026-10-08):** confirming with the same slot keeps a clock time the user typed on that row. Picking the other slot is deliberate and moves the time to that slot's default. A slot is stored upper-case. An absent `confirmedTime` still stores a null `event_time`.

- [ ] **Step 1: Append the failing tests**

```ts
  function seedManual(date: string, eventTime: string | null, releaseTime: string | null): void {
    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol, source_key, week_of)
       VALUES ('manual', 'earnings', ?, ?, ?, 'NVDA earnings', 'NVDA', ?, '2026-06-08')`,
    ).run(date, eventTime, releaseTime, `manual:NVDA:${date}:earnings`);
  }
  const manualRow = () =>
    db
      .prepare("SELECT event_time, release_time FROM calendar_events WHERE source='manual' AND symbol='NVDA'")
      .get() as { event_time: string | null; release_time: string | null };

  it("confirming with the same slot keeps a typed clock time", () => {
    seedManual("2026-06-12", "16:05", "16:05");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "16:05", release_time: "16:05" });
  });

  it("picking the other slot moves a typed time to that slot's default", () => {
    seedManual("2026-06-12", "07:30", "07:30");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "AMC", release_time: "16:15" });
  });

  it("un-hiding a hidden hand-entered row keeps its typed time on a same-slot confirm", () => {
    seedManual("2026-06-12", "16:05", "16:05");
    db.prepare("UPDATE calendar_events SET superseded = 1 WHERE source = 'manual'").run();
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    const row = db
      .prepare("SELECT superseded, event_time, release_time FROM calendar_events WHERE source='manual' AND symbol='NVDA'")
      .get() as { superseded: number; event_time: string | null; release_time: string | null };
    expect(row).toEqual({ superseded: 0, event_time: "16:05", release_time: "16:05" });
  });

  it("stores a picked slot upper-case on a first insert", () => {
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "bmo", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "BMO", release_time: "08:00" });
  });

  it("an absent time still stores no slot", () => {
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", today: "2026-06-08" });
    expect(manualRow().event_time).toBeNull();
    expect(manualRow().release_time).toBe("16:15");
  });
```

- [ ] **Step 2: Run and confirm the failures**

Run: `npx vitest run tests/mutations/confirm-earnings-date.test.ts`
Expected: the first four new cases FAIL (typed time overwritten; `event_time` stored as `amc` / `bmo`). The last passes already.

- [ ] **Step 3: Add the slot helper**

Directly under `toCascadeEventTime` add:

```ts
/** The slot a stored clock time falls in: before noon is BMO, otherwise AMC. */
function slotOfClock(time: string | null | undefined): "BMO" | "AMC" | null {
  const m = time ? /^(\d{2}):\d{2}/.exec(time) : null;
  if (!m) return null;
  return Number(m[1]) < 12 ? "BMO" : "AMC";
}
```

- [ ] **Step 4: Keep the typed time inside the transaction**

Replace the `before` read (the `SELECT COALESCE(superseded, 0) AS superseded …` statement and its type) with one that also reads the two time columns:

```ts
    const before = db
      .prepare(
        `SELECT COALESCE(superseded, 0) AS superseded, event_time, release_time
           FROM calendar_events
          WHERE source_key = ?`,
      )
      .get(sourceKey) as
      | { superseded: number; event_time: string | null; release_time: string | null }
      | undefined;

    // A clock time the user typed on this row survives a confirm that picks the
    // same slot. Picking the other slot is a deliberate change of time.
    const typedClock =
      before && /^\d{2}:\d{2}$/.test(before.event_time ?? "") ? before.event_time : null;
    const pickedSlot = cascadeEventTime === "BMO" || cascadeEventTime === "AMC" ? cascadeEventTime : null;
    const keepTyped = typedClock !== null && pickedSlot !== null && slotOfClock(typedClock) === pickedSlot;
    const eventTimeToStore = keepTyped
      ? typedClock
      : input.confirmedTime == null
        ? null
        : cascadeEventTime;
    const releaseTimeToStore = keepTyped ? (before?.release_time ?? typedClock) : releaseTime;
```

In the `.run(…)` call of the INSERT, replace `input.confirmedTime ?? null,` with `eventTimeToStore,` and the next argument `releaseTime,` with `releaseTimeToStore,`.

- [ ] **Step 5: Run the mutation tests and its callers' tests**

Run: `npx vitest run tests/mutations/confirm-earnings-date.test.ts tests/api/earnings-confirm-date-route.test.ts tests/calendar/reconcile-manual-rows-a14.test.ts tests/calendar/manual-earnings-delete-restores-twin.test.ts`
Expected: PASS. The existing case "re-confirming updates the same manual row in place" must still read `08:00`.

- [ ] **Step 6: Hand back** both paths: `fix(calendar): confirming an earnings date keeps a typed time and stores the slot upper-case`.

---

### Task 5: Reconciliation difference bands scale with the account

**Files:**
- Create: `lib/compute/reconciliation-tolerance.ts`
- Modify: `lib/queries/reconciliation.ts:257-299`
- Modify: `app/dashboard/components/ReconciliationTable.tsx:280` and `:299-305`
- Test (create): `tests/compute/reconciliation-tolerance.test.ts`
- Test (modify): `tests/queries/reconciliation-checkpoints.test.ts:230-247`

**Interfaces:**
- Produces: from `lib/compute/reconciliation-tolerance.ts`
  - `RECON_MATCH_TOLERANCE = 0.01`, `RECON_FLOOR_DOLLARS = 100`, `RECON_NEUTRAL_PCT = 0.001`, `RECON_RED_PCT = 0.005`
  - `type ReconciliationBand = "match" | "within" | "close" | "off"`
  - `reconciliationBand(difference: number | null, statementValue: number): ReconciliationBand | null`
- Changes: `checkpointDifferenceBand(difference, statementValue)` in `lib/queries/reconciliation.ts` gains the second parameter.

**Bands (owner, 2026-10-08):** match = under one cent. within (neutral) = under 0.1% of the statement value. close (amber) = 0.1% to 0.5%, or over 0.5% but not over $100. off (red) = over both $100 and 0.5%.

- [ ] **Step 1: Write the failing helper test**

```ts
import { describe, it, expect } from "vitest";
import { reconciliationBand } from "@/lib/compute/reconciliation-tolerance";

describe("reconciliationBand", () => {
  it("has no band without a difference", () => {
    expect(reconciliationBand(null, 50_000)).toBeNull();
  });

  it("under one cent is a match, either sign", () => {
    expect(reconciliationBand(0, 50_000)).toBe("match");
    expect(reconciliationBand(-0.004, 50_000)).toBe("match");
  });

  it("a small share of a large statement is within tolerance, even above the flat floor", () => {
    // 160 on 2,000,000 is 0.008%.
    expect(reconciliationBand(160, 2_000_000)).toBe("within");
    expect(reconciliationBand(-160, 2_000_000)).toBe("within");
  });

  it("between a tenth and half a percent is close", () => {
    // 300 on 100,000 is 0.3%.
    expect(reconciliationBand(300, 100_000)).toBe("close");
  });

  it("over half a percent but not over the floor is close, not off", () => {
    // 50 on 2,000 is 2.5%, but only 50 dollars.
    expect(reconciliationBand(50, 2_000)).toBe("close");
  });

  it("over both the floor and half a percent is off", () => {
    // 600 on 100,000 is 0.6%.
    expect(reconciliationBand(600, 100_000)).toBe("off");
    expect(reconciliationBand(-600, 100_000)).toBe("off");
  });

  it("a statement value of zero or less falls back to the flat-dollar reading", () => {
    expect(reconciliationBand(50, 0)).toBe("close");
    expect(reconciliationBand(150, 0)).toBe("off");
    expect(reconciliationBand(150, Number.NaN)).toBe("off");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/compute/reconciliation-tolerance.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the helper**

Create `lib/compute/reconciliation-tolerance.ts`:

```ts
/**
 * How far a statement value may sit from the computed value before the
 * reconciliation chip alarms. Owner ruling 2026-10-08: the tolerance scales
 * with the account, with a flat-dollar floor so a small account's rounding
 * residue is never red.
 */
export const RECON_MATCH_TOLERANCE = 0.01;
export const RECON_FLOOR_DOLLARS = 100;
export const RECON_NEUTRAL_PCT = 0.001;
export const RECON_RED_PCT = 0.005;

export type ReconciliationBand = "match" | "within" | "close" | "off";

export function reconciliationBand(
  difference: number | null,
  statementValue: number,
): ReconciliationBand | null {
  if (difference === null) return null;
  const abs = Math.abs(difference);
  if (abs < RECON_MATCH_TOLERANCE) return "match";
  // No usable statement value: every difference counts as a large share, so
  // only the flat floor decides between close and off.
  const share =
    Number.isFinite(statementValue) && statementValue > 0 ? abs / statementValue : Infinity;
  if (share < RECON_NEUTRAL_PCT) return "within";
  if (abs > RECON_FLOOR_DOLLARS && share > RECON_RED_PCT) return "off";
  return "close";
}
```

- [ ] **Step 4: Run the helper test**

Run: `npx vitest run tests/compute/reconciliation-tolerance.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the existing band test first**

In `tests/queries/reconciliation-checkpoints.test.ts`, replace the whole `describe("checkpointDifferenceBand", …)` block with:

```ts
describe("checkpointDifferenceBand", () => {
  it("has no band without a computed difference", () => {
    expect(checkpointDifferenceBand(null, 100_000)).toBeNull();
  });

  it("bands by share of the statement value and says what each glyph means", () => {
    expect(checkpointDifferenceBand(0, 100_000)).toMatchObject({ band: "match", glyph: "✓" });
    expect(checkpointDifferenceBand(-0.004, 100_000)).toMatchObject({ band: "match" });
    expect(checkpointDifferenceBand(50, 100_000)).toMatchObject({ band: "within", glyph: "≈" });
    expect(checkpointDifferenceBand(-300, 100_000)).toMatchObject({ band: "close", glyph: "~" });
    expect(checkpointDifferenceBand(600, 100_000)).toMatchObject({ band: "off", glyph: "!" });
    for (const d of [0, 50, 300, 600]) {
      expect(checkpointDifferenceBand(d, 100_000)?.label.length).toBeGreaterThan(10);
    }
    expect(checkpointDifferenceBand(600, 100_000)?.label).toContain("$100");
    expect(checkpointDifferenceBand(600, 100_000)?.label).toContain("0.5%");
  });
});
```

Run: `npx vitest run tests/queries/reconciliation-checkpoints.test.ts`
Expected: this block FAILS (the function takes one argument and has no `within` band).

- [ ] **Step 6: Rewire `lib/queries/reconciliation.ts`**

Add to the imports at the top of the file:

```ts
import {
  RECON_FLOOR_DOLLARS,
  RECON_MATCH_TOLERANCE,
  RECON_NEUTRAL_PCT,
  RECON_RED_PCT,
  reconciliationBand,
  type ReconciliationBand,
} from "@/lib/compute/reconciliation-tolerance";
```

Replace lines 257-299 (from the `/** Statement vs computed …` comment through the `CHECKPOINT_DIFFERENCE_LEGEND` export) with:

```ts
/** Kept for importers; the bands themselves live in lib/compute/reconciliation-tolerance.ts. */
export const CHECKPOINT_MATCH_TOLERANCE = RECON_MATCH_TOLERANCE;
export const CHECKPOINT_CLOSE_TOLERANCE = RECON_FLOOR_DOLLARS;

export interface CheckpointDifferenceBand {
  band: ReconciliationBand;
  glyph: string;
  label: string;
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

const DIFFERENCE_BANDS: Record<ReconciliationBand, CheckpointDifferenceBand> = {
  match: {
    band: "match",
    glyph: "✓",
    label: "Matches the computed value to the cent",
  },
  within: {
    band: "within",
    glyph: "≈",
    label: `Within tolerance: under ${pct(RECON_NEUTRAL_PCT)} of the statement value`,
  },
  close: {
    band: "close",
    glyph: "~",
    label: `Close: ${pct(RECON_NEUTRAL_PCT)} to ${pct(RECON_RED_PCT)} of the statement value, or under $${RECON_FLOOR_DOLLARS}`,
  },
  off: {
    band: "off",
    glyph: "!",
    label: `Off: more than $${RECON_FLOOR_DOLLARS} and more than ${pct(RECON_RED_PCT)} of the statement value`,
  },
};

/** The Difference chip's band, glyph and plain-words meaning (null = no computed value). */
export function checkpointDifferenceBand(
  difference: number | null,
  statementValue: number,
): CheckpointDifferenceBand | null {
  const band = reconciliationBand(difference, statementValue);
  return band === null ? null : DIFFERENCE_BANDS[band];
}

/** One line under the table explaining the Difference glyphs. */
export const CHECKPOINT_DIFFERENCE_LEGEND = (["match", "within", "close", "off"] as const)
  .map((b) => `${DIFFERENCE_BANDS[b].glyph} ${DIFFERENCE_BANDS[b].label}`)
  .join(" · ");
```

- [ ] **Step 7: Update the table**

In `app/dashboard/components/ReconciliationTable.tsx` change line 280 to:

```tsx
                const band = checkpointDifferenceBand(cp.difference, cp.statement_value);
```

and replace the three-way class expression (the `band.band === "match" ? … : "bg-down/20 text-down"` block) with:

```tsx
                            band.band === "match"
                              ? "bg-up/20 text-up"
                              : band.band === "within"
                                ? "bg-panel text-ink-dim"
                                : band.band === "close"
                                  ? "bg-gold/20 text-gold-ink"
                                  : "bg-down/20 text-down"
```

- [ ] **Step 8: Run every test that reads this code**

Run: `npx vitest run tests/compute/reconciliation-tolerance.test.ts tests/queries/reconciliation-checkpoints.test.ts tests/dashboard/reconciliation-table-checkpoint-guards.test.ts tests/dashboard/reconciliation-table-scrollfade.test.ts tests/api/reconciliation-checkpoint-route.test.ts tests/repo/no-bare-amber-400-text.test.ts`
Expected: PASS. Then `npx tsc --noEmit`: clean.

- [ ] **Step 9: Hand back** the five paths: `fix(accounts): the reconciliation difference chip scales with the account, with a flat floor`.

---

### Task 6: One window rule for the digest sender and its preview

**Files:**
- Create: `lib/digest/digest-window.ts`
- Modify: `lib/digest/send-digest.ts:86-97` and `:121-123`
- Modify: `app/api/digest/preview/route.ts:13-20`
- Modify: `lib/digest/daily-digest.ts:123` and `:273`, `lib/digest/group-by-company.ts:292` (add `export` to three constants)
- Test (create): `tests/digest/digest-window.test.ts`
- Test (modify): `tests/digest/et-today-sweep.test.ts` (append two cases to `describe("sendDigestEmail window boundaries", …)`)

**Interfaces:**
- Produces: from `lib/digest/digest-window.ts`
  - `resolveDigestSince(db: Database.Database, opts: { mode?: string; sinceDate?: string | null }): string | null` — the sender's rule, unchanged: `today` gives `todayET()`; `since_last` gives the last-sent marker or Eastern yesterday; `since_date` with a date gives that date; anything else gives `null`.
  - `defaultDigestSince(): string` — Eastern yesterday, the sender's fallback for `null`.
- Produces: exported `DIGEST_ARTICLE_CAP`, `ADAPTIVE_ARTICLE_CAP` (`lib/digest/daily-digest.ts`) and `BY_COMPANY_ARTICLE_CAP` (`lib/digest/group-by-company.ts`), values unchanged, for wave 2's preview caption.
- **No behaviour change for the sender.** One preview change, stated on purpose: with no `?since` and no last-sent marker the preview's fallback moves from the last 24 hours in UTC to Eastern yesterday, which is what the sender uses.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The digest window rule, shared by the sender and the preview.
 * Clock frozen at 2026-03-10T01:30:00Z = 21:30 ET on 2026-03-09: the UTC day
 * has rolled over, the Eastern day has not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { resolveDigestSince, defaultDigestSince } from "@/lib/digest/digest-window";
import { setLastDigestSentAt } from "@/lib/digest/daily-digest";

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T01:30:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});
afterEach(() => vi.useRealTimers());

describe("resolveDigestSince", () => {
  it("mode 'today' is the Eastern day", () => {
    expect(resolveDigestSince(db, { mode: "today" })).toBe("2026-03-09");
  });

  it("mode 'since_last' with no marker is the Eastern yesterday", () => {
    expect(resolveDigestSince(db, { mode: "since_last" })).toBe("2026-03-08");
  });

  it("mode 'since_last' returns the stored marker when there is one", () => {
    setLastDigestSentAt(db, "2026-03-05");
    expect(resolveDigestSince(db, { mode: "since_last" })).toBe("2026-03-05");
  });

  it("mode 'since_date' returns the date it was given", () => {
    expect(resolveDigestSince(db, { mode: "since_date", sinceDate: "2026-02-01" })).toBe("2026-02-01");
  });

  it("mode 'since_date' with no date, and no mode at all, give null", () => {
    expect(resolveDigestSince(db, { mode: "since_date" })).toBeNull();
    expect(resolveDigestSince(db, { mode: "since_date", sinceDate: null })).toBeNull();
    expect(resolveDigestSince(db, {})).toBeNull();
  });

  it("the fallback for null is the Eastern yesterday", () => {
    expect(defaultDigestSince()).toBe("2026-03-08");
  });
});

describe("the sender and the preview read the one rule", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the sender calls resolveDigestSince before its slow fetch", () => {
    const src = read("lib/digest/send-digest.ts");
    const rule = src.indexOf("resolveDigestSince(db,");
    const fetch = src.indexOf("await syncPortfolio(db)");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(fetch);
  });

  it("the preview route uses the rule and no UTC date slice", () => {
    const src = read("app/api/digest/preview/route.ts");
    expect(src).toContain("resolveDigestSince(db,");
    expect(src).not.toContain("toISOString().slice(0, 10)");
  });
});
```

Also append these two cases inside `describe("sendDigestEmail window boundaries", …)` in `tests/digest/et-today-sweep.test.ts`. They use that file's existing mocks and its `adaptiveSince.calls` spy, and they pin the sender's fallback through the real function, not only the helper. They pass before the change and must still pass after it:

```ts
  it("mode 'since_date' with no date falls back to the ET yesterday", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");
    await sendDigestEmail(db, { mode: "since_date" });
    expect(adaptiveSince.calls).toEqual(["2026-03-08"]);
  });

  it("no mode at all falls back to the ET yesterday", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");
    await sendDigestEmail(db, {});
    expect(adaptiveSince.calls).toEqual(["2026-03-08"]);
  });
```

- [ ] **Step 2: Run both files; confirm the new file fails and the sender cases pass**

Run: `npx vitest run tests/digest/digest-window.test.ts tests/digest/et-today-sweep.test.ts`
Expected: `digest-window.test.ts` FAILS, module not found. `et-today-sweep.test.ts` PASSES, the two new cases included (they record today's behaviour). If either new sender case fails here, stop and report: the sender's fallback is not what this plan assumes.

- [ ] **Step 3: Write the shared rule**

Create `lib/digest/digest-window.ts`:

```ts
import type Database from "better-sqlite3";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getLastDigestSentAt } from "@/lib/digest/daily-digest";

/**
 * Where a digest's article window opens. The sender captures this BEFORE its
 * slow fetch (a concurrent send would otherwise move the marker under it), and
 * the preview reads the same rule so the two never disagree.
 *
 * ET-anchored: a UTC slice reads tomorrow from 20:00 ET, which emptied an
 * evening "today" digest and skipped a day on the 24h fallback.
 */
export function resolveDigestSince(
  db: Database.Database,
  opts: { mode?: string; sinceDate?: string | null },
): string | null {
  if (opts.mode === "today") return todayET();
  if (opts.mode === "since_last") {
    return getLastDigestSentAt(db) || defaultDigestSince();
  }
  if (opts.mode === "since_date" && opts.sinceDate) return opts.sinceDate;
  return null; // legacy path: the caller applies defaultDigestSince()
}

/** The window for a caller that named no mode: the Eastern yesterday. */
export function defaultDigestSince(): string {
  return addDays(todayET(), -1);
}
```

- [ ] **Step 4: Use it in the sender**

In `lib/digest/send-digest.ts` add the import:

```ts
import { resolveDigestSince, defaultDigestSince } from "@/lib/digest/digest-window";
```

Replace the `const sinceSnapshot = (() => { … })();` block (lines 86-97) with:

```ts
  const sinceSnapshot = resolveDigestSince(db, { mode: opts.mode, sinceDate: opts.sinceDate });
```

Keep the comment block above it (lines 79-85) as it is. Replace the fallback expression on line 123, `addDays(todayET(), -1)`, with `defaultDigestSince()`. If `todayET`, `addDays` or `getLastDigestSentAt` are then unused in this file, remove them from its imports; if any is still used elsewhere in the file, leave it.

- [ ] **Step 5: Use it in the preview route**

In `app/api/digest/preview/route.ts` add:

```ts
import { resolveDigestSince, defaultDigestSince } from "@/lib/digest/digest-window";
```

and replace `resolveSince` with:

```ts
// The sender's own window rule, so the preview shows what a send would cover.
function resolveSince(request: NextRequest): string {
  const sinceParam = new URL(request.url).searchParams.get("since");
  if (sinceParam) return sinceParam;
  return resolveDigestSince(db, { mode: "since_last" }) ?? defaultDigestSince();
}
```

Remove `getLastDigestSentAt` from this file's imports if nothing else in it uses the name.

- [ ] **Step 6: Export the three caps**

Add `export` in front of `const DIGEST_ARTICLE_CAP = 30` and `const ADAPTIVE_ARTICLE_CAP = 40` in `lib/digest/daily-digest.ts`, and in front of `const BY_COMPANY_ARTICLE_CAP = 30` in `lib/digest/group-by-company.ts`. Change nothing else on those lines.

- [ ] **Step 7: Run the sender's and the preview's tests**

Run: `npx vitest run tests/digest/digest-window.test.ts tests/digest/et-today-sweep.test.ts tests/digest/send-digest-race.test.ts tests/api/digest-preview-synthesis-fallback.test.ts tests/api/cron-marker-advance.test.ts tests/api/no-state-changing-get.test.ts tests/digest/daily-digest.test.ts tests/digest/group-by-company.test.ts tests/digest/adaptive-layout.test.ts`
Expected: PASS. Then `npx tsc --noEmit`: clean.

- [ ] **Step 8: Hand back** the six paths: `refactor(digest): the sender and the preview read one window rule; caps exported`.

---

### Task 7: The recap prompt does not go looking for a reaction

**Files:**
- Modify: `lib/digest/send-earnings-email.ts:2057`, `:2114`, `:2124` (inside `renderRecapPrompt` only)
- Test (modify): `tests/digest/earnings-prompt-prose-rules.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: `renderRecapPrompt(ctx: EarningsRecapContext): string` and the test file's existing `makeRecapContext()` helper, whose `reactionSnapshotMarkdown` is `null`.
- Produces: no signature change. There is no Worker mirror: the cloud recap makes no AI call.

**Rule (owner, 2026-10-08):** with no reaction snapshot the recap says the reaction is not captured yet and does not search for one. `web_search` stays enabled for guidance, call commentary and sell-side notes.

- [ ] **Step 1: Append the failing tests**

```ts
describe("recap prompt — no reaction is captured yet", () => {
  it("tells the model the reaction is not captured and not to search for it", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).toContain("Reaction snapshot not yet captured.");
    expect(prompt).toMatch(/Do NOT use web_search to find a price or a move/);
    expect(prompt).not.toContain("If you can determine after-hours / immediate reaction from web_search");
  });

  it("the reaction section and the position section do not ask for a price it does not have", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).toMatch(/## The reaction\\?`\*\* — when no reaction snapshot is given above, write one line/);
    expect(prompt).not.toContain("at the reaction-snapshot price");
  });

  it("still allows web_search for guidance and sell-side notes", () => {
    const prompt = renderRecapPrompt(makeRecapContext());
    expect(prompt).toMatch(/Use web_search aggressively/);
    expect(prompt).toMatch(/web_search for analyst notes/);
  });

  it("with a snapshot, the prompt prints it and keeps the reaction section", () => {
    const prompt = renderRecapPrompt({
      ...makeRecapContext(),
      reactionSnapshotMarkdown: "AAPL +1.2% vs SPY +0.1%",
    });
    expect(prompt).toContain("## Market reaction (T+2h, captured automatically)");
    expect(prompt).toContain("AAPL +1.2% vs SPY +0.1%");
    expect(prompt).not.toContain("Reaction snapshot not yet captured.");
  });
});
```

- [ ] **Step 2: Run and confirm the failures**

Run: `npx vitest run tests/digest/earnings-prompt-prose-rules.test.ts`
Expected: the first two new cases FAIL; the last two pass.

- [ ] **Step 3: Reword the no-snapshot branch (line 2057)**

Replace the else branch of `reactionBlock` with:

```ts
    : `\n## Market reaction\nReaction snapshot not yet captured. Say so in one line. Do NOT use web_search to find a price or a move, and do not quote an after-hours price from any source: a later price would post-date this email.\n`;
```

- [ ] **Step 4: Reword the reaction section (line 2114)**

Replace the text of item 2 with:

```
2. **\`## The reaction\`** — when no reaction snapshot is given above, write one line: "Reaction not yet captured." and nothing else in this section. When a snapshot is given: stock move vs. SPY/QQQ/sector from that snapshot only; if a transcript or call quotes are available via web_search, lead with the one or two quotes that explain the move, and if not, note "transcript not yet posted — recap will update if a follow-up runs."
```

- [ ] **Step 5: Reword the position section (line 2124)**

In item 5, replace `what does the print mean for each disclosed direction at the reaction-snapshot price?` with:

```
what does the print mean for each disclosed direction (at the reaction-snapshot price when one is given above; otherwise on the reported figures alone)?
```

- [ ] **Step 6: Run the prompt tests**

Run: `npx vitest run tests/digest/earnings-prompt-prose-rules.test.ts tests/digest/recap-prompt-implausible-actuals.test.ts tests/digest/earnings-prompt-no-dollar-leak.test.ts tests/digest/earnings-intel-render.test.ts`
Then the Worker's parity count, which reads this file: `(cd workers/cron && npx vitest run test/plausibility-parity.test.ts)`
Expected: PASS.

- [ ] **Step 7: Hand back** both paths: `fix(earnings): a recap with no reaction snapshot says so and does not search for one`.

---

### Task 8: Pin the international-exposure scenario scores

**Files:**
- Test (modify): `tests/compute/scenario-recipes.test.ts` (append one `describe`)
- Modify: `lib/compute/scenario-recipes.ts:78-83` (comment only)

**Interfaces:**
- Consumes: the exported `FACTOR_SHOCK_SENSITIVITIES` from `lib/compute/scenario-recipes.ts`.
- Produces: nothing new. This task is the safety the owner ruled for: the stored label `International` and the label `High` score the same, `Very High` scores above both, and a test fails if anyone moves either. The relabel patch stays held (`docs/DECISIONS.md`, 2026-10-08, "the relabel stays held").

- [ ] **Step 1: Append the pinning test**

```ts
describe("international_exposure scenario scores are pinned (owner ruling 2026-10-08)", () => {
  const scores = FACTOR_SHOCK_SENSITIVITIES.international_exposure;

  it("the stored label 'International' scores exactly as 'High' does", () => {
    expect(scores.International).toBe(1.0);
    expect(scores.International).toBe(scores.High);
  });

  it("'Very High' stays a separate, higher tier", () => {
    expect(scores["Very High"]).toBe(1.3);
    expect(scores["Very High"]).toBeGreaterThan(scores.International);
  });

  it("no label is silently unmapped: every scored label is a finite number", () => {
    for (const [label, value] of Object.entries(scores)) {
      expect(Number.isFinite(value), label).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/compute/scenario-recipes.test.ts`
Expected: PASS. This is a characterization test: it records today's scores so a later relabel cannot move a scenario figure unnoticed. Confirm it has teeth: temporarily change `International: 1.00` to `International: 1.30` in `lib/compute/scenario-recipes.ts`, re-run, see the first case FAIL, then restore `1.00` and re-run to PASS.

- [ ] **Step 3: Record the ruling in the comment**

Append two lines to the comment above `International: 1.00,` (after the line ending `2026-09-03 QA finding.`):

```ts
    // Owner ruling 2026-10-08: this score is pinned equal to High. Relabelling
    // new classifications to "Very High" is HELD, because that would move
    // scenario figures; tests/compute/scenario-recipes.test.ts guards it.
```

- [ ] **Step 4: Run the file once more**

Run: `npx vitest run tests/compute/scenario-recipes.test.ts`
Expected: PASS.

- [ ] **Step 5: Hand back** both paths: `test(scenarios): the international-exposure scores are pinned; the relabel stays held`.

---

## After the eight tasks (controller)

- [ ] Commit each task by pathspec with the message it handed back, one git command at a time.
- [ ] `npm run verify:changed`, then `bash scripts/verify.sh full --base main`, then `npx tsc --noEmit`. Record the test count.
- [ ] One read-only review by an agent that runs the code, with these what-ifs: a `0`-dollar statement value in Task 5; a confirm on a symbol with a hidden manual row in Task 4; `sendDigestEmail` called with no options in Task 6.
- [ ] Browser check on a sandbox copy (`npm run sandbox`, `npm run smoke`): the Accounts reconciliation table shows the four chip styles and the new legend; the week view row reads "Entered by you"; the digest Preview still opens.
- [ ] Update `docs/reference/earnings-pipeline.md` only if a sentence there is now wrong; update the to-do entry "Ruled builds, 2026-10-08" to mark (a), (b), (c), (e), (r5), (r18) and the scoring half of (o) as built.
- [ ] In the to-do and the pull request description, say plainly that the digest Preview's AI call on a click (q12) is NOT built in this wave; only the shared window rule and the exported caps are.
- [ ] Open a pull request. Nothing merges or deploys without the owner.

## Not in this wave (wave 2 and wave 3 get their own plans)

- **Wave 1 leftovers that need component reads, moved to wave 2:** the digest Preview's AI call on a click and its caps caption (`DigestEmailViewer.tsx`); each Diagnostics card naming its basis and the geography catch-all labels (`AnalysisView.tsx` and three card components); Analysis scope remembered for the session (nav components); the email viewer's "actual changed after send" stamp; the checkpoint "Computed" fallback to the nearest prior valuation (it needs either a stored source date or a read-time lookup).
- **Wave 2, Analysis and calendar logic:** the duplicate check prefers a real slot and the hand-entered tie-break (one function); a feed row stored hidden at write; the display-only time estimate; the armed row's read-only record; macro theme input ranking with the direction check and excerpt; the flow-aware curve check; deep in-the-money calls as core; Significant Moves scope and the completed-session rule; fixed periods ending at the last statement; the Holdings score by value; scoped Plaid purges; the opened-today rule; chat movers one row per side; chat total from the strip's function; the empty-enrichment cloud path and repair.
- **Wave 3, Mac and Worker together, and migrations:** level currency in emails and pushes with the Worker level-scan guard (one snapshot version bump); the recap scoreboard with the kept vendor actual (migration); macro basis check and FRED reference month (migration, both sides).
- **Held for a written design:** a live-closed option or short as pending a statement.
- **Owner question raised by the Codex review:** `scripts/finish-donations.ts` is a finished one-off that names one import batch file and one symbol-and-date check in committed code. Generalise it (constants to a gitignored config), delete it, or leave it.
