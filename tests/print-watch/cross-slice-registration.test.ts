/**
 * Slice B Task 16 (merged into Task 13 under controller ruling R-B1) — the
 * print-watch registrations land in slice A's REAL registries, and A's
 * composition root is what puts them there.
 *
 * There is no registry shim: slice A merged first, so `register.ts` imports
 * `@/lib/earnings/event-merge` and `@/lib/earnings/prepare-armed-event`
 * directly. The COLD PROCESS case is the one that matters — a process that
 * never imported the watcher (or anything else under lib/print-watch) must
 * still run B's merge handler and enqueue B's prepare step, because
 * `bootstrapEarningsRegistries()` is the single composition root both
 * registries call lazily.
 *
 * NOTE on the two `__reset*ForTests()` helpers: each of them also SUPPRESSES
 * the lazy bootstrap for this process, so the tests below that call
 * `registerPrintWatch()` by hand see B's registrations ALONE (A's four
 * prepare steps are not added under them). The cold-process test deliberately
 * skips them — it uses `vi.resetModules()` instead, so the fresh
 * registry-bootstrap module is unsuppressed and does the real thing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  listEventMergeHandlers,
  mergeEarningsEventState,
  __resetEventMergeHandlersForTests,
} from "@/lib/earnings/event-merge";
import {
  listPrepareSteps,
  enqueuePrepareSteps,
  getPrepareStepRows,
  __resetPrepareStepsForTests,
} from "@/lib/earnings/prepare-armed-event";
import { registerPrintWatch, __resetRegisterForTests } from "@/lib/print-watch/register";
import { __resetFirstPassRegisterForTests } from "@/lib/print-watch/first-pass-register";
import { upsertPrint, getPrintByEventId } from "@/lib/print-watch/store";

let db: Database.Database;
beforeEach(() => {
  __resetEventMergeHandlersForTests();
  __resetPrepareStepsForTests();
  __resetRegisterForTests();
  __resetFirstPassRegisterForTests();
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

  it("registers exactly the two print-watch handlers and the ir_baseline step, once (idempotent)", () => {
    registerPrintWatch();
    registerPrintWatch();
    // ORDER IS LOAD-BEARING. Both C's go handler and D's first-pass handler
    // repoint their own rows to the surviving print BEFORE B's handler deletes
    // the donor print row: `print_watch_go_requests.print_id`,
    // `print_watch_reads.print_id` and `print_watch_callouts.print_id` all
    // reference print_watch_prints with no cascade, so the reverse order fails
    // the merge with a FOREIGN KEY error (R-C7, plan M-D12). C before D only
    // matches slice order — no foreign key runs between the two.
    expect(listEventMergeHandlers()).toEqual([
      "print-watch-go",
      "print-watch-first-pass",
      "print-watch",
    ]);
    expect(listPrepareSteps()).toEqual(["ir_baseline"]);
  });

  it("COLD PROCESS (Codex #4): a process that never imported the watcher still runs B's handlers through A's bootstrap", async () => {
    vi.resetModules(); // fresh module registry — nothing has registered anything
    const merge = await import("@/lib/earnings/event-merge");
    const prepare = await import("@/lib/earnings/prepare-armed-event");
    const store = await import("@/lib/print-watch/store");
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    (await import("@/lib/db/migrate")).runMigrations(fresh);
    const donor = Number(
      fresh
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-26','ACME','d','ACME')`,
        )
        .run().lastInsertRowid,
    );
    const target = Number(
      fresh
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-27','ACME','t','ACME')`,
        )
        .run().lastInsertRowid,
    );
    const printId = store.upsertPrint(fresh, donor, "ACME", "2026-08-26", "16:05");
    fresh.transaction(() => merge.mergeEarningsEventState(fresh, donor, target))();
    expect(store.getPrintByEventId(fresh, target)?.id).toBe(printId);
    prepare.enqueuePrepareSteps(fresh, target);
    expect(prepare.getPrepareStepRows(fresh, target).map((r) => r.step)).toContain("ir_baseline");
    fresh.close();
  });

  it("a calendar merge re-homes the print through A's mergeEarningsEventState", () => {
    registerPrintWatch();
    const donor = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-26','ACME','d','ACME')`,
        )
        .run().lastInsertRowid,
    );
    const target = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-27','ACME','t','ACME')`,
        )
        .run().lastInsertRowid,
    );
    const printId = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();
    expect(getPrintByEventId(db, target)?.id).toBe(printId);
    expect(report.handlers.map((h) => h.name)).toContain("print-watch");
  });

  it("arming enqueues the ir_baseline step alongside A's steps", () => {
    registerPrintWatch();
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`,
        )
        .run().lastInsertRowid,
    );
    enqueuePrepareSteps(db, eventId);
    expect(getPrepareStepRows(db, eventId).map((r) => r.step)).toContain("ir_baseline");
  });
});
