/**
 * Live print v2 slice A, Ruling R1/R2 — cold-process proof that the lazy
 * bootstrap actually registers the concrete prepare steps.
 *
 * Only `@/lib/earnings/prepare-armed-event` is imported (via a dynamic
 * import after `vi.resetModules()`, so this file's own module graph is
 * untouched by any other test's `__resetPrepareStepsForTests()` /
 * `__isBootstrapSuppressedForTests(true)` call). Nothing under
 * `lib/earnings/prepare-steps/**` is imported directly — the whole point is
 * that `enqueuePrepareSteps` reaches the four concrete steps ONLY through
 * `bootstrapEarningsRegistries()` → `registerPrepareStepsOnce()`.
 *
 * Ruling R2: the registered set is newsletter_rescan, consensus_row, intel,
 * con_id. The assertions below are in REGISTRATION order —
 * `listPrepareSteps()` reflects insertion order, which is NOT run order: the
 * runner (prepare-armed-event.ts) always selects work `ORDER BY p.step`
 * (alphabetical: con_id, consensus_row, intel, newsletter_rescan).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

describe("registry-bootstrap cold process (Ruling R1/R2)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("enqueuePrepareSteps lazily registers exactly the four A steps, in registration order, with nothing else imported", async () => {
    const { runMigrations } = await import("@/lib/db/migrate");
    const { armWorksheet } = await import("@/lib/mutations/earnings-worksheet-flags");
    const { enqueuePrepareSteps, listPrepareSteps, getPrepareStepRows } = await import(
      "@/lib/earnings/prepare-armed-event"
    );

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const id = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-03','GAMMA','k-registry-bootstrap','GAMMA')`,
        )
        .run().lastInsertRowid,
    );
    armWorksheet(db, id);

    const inserted = enqueuePrepareSteps(db, id);
    expect(inserted).toBe(4);
    expect(listPrepareSteps()).toEqual(["newsletter_rescan", "consensus_row", "intel", "con_id"]);
    expect(getPrepareStepRows(db, id).map((r) => r.step)).toEqual(["con_id", "consensus_row", "intel", "newsletter_rescan"]);

    // A second enqueue on the same event is a no-op — steps registered once, rows inserted once.
    const insertedAgain = enqueuePrepareSteps(db, id);
    expect(insertedAgain).toBe(0);
    expect(listPrepareSteps()).toEqual(["newsletter_rescan", "consensus_row", "intel", "con_id"]);
  });

  it("[nit] registerPrepareStepsOnce is idempotent when called directly, twice, in the same process", async () => {
    // The above test's "second call registers nothing" only proves the OUTER latch
    // (bootstrapEarningsRegistries()'s own `done` flag) short-circuits a second
    // enqueue — registerPrepareStepsOnce() itself is never invoked a second time
    // through that path. Call it directly to actually exercise its own
    // `have.has(name)` idempotency guard.
    const { listPrepareSteps } = await import("@/lib/earnings/prepare-armed-event");
    const { registerPrepareStepsOnce } = await import("@/lib/earnings/prepare-steps");

    registerPrepareStepsOnce();
    expect(listPrepareSteps()).toEqual(["newsletter_rescan", "consensus_row", "intel", "con_id"]);

    expect(() => registerPrepareStepsOnce()).not.toThrow();
    expect(listPrepareSteps()).toEqual(["newsletter_rescan", "consensus_row", "intel", "con_id"]);
  });
});
