/**
 * The ONE slice-B file that names slice A's registries (plan M3, controller
 * ruling R-B1 — slice A merged first, so there is no shim: these are the real
 * `lib/earnings/*` registries).
 *
 * NOTHING is registered at module-evaluation time, and nothing may ever be.
 * A's composition root (`lib/earnings/registry-bootstrap.ts`) imports this
 * module at its own top level, and both registry modules import that root, so
 * the cycle event-merge → registry-bootstrap → register → event-merge is
 * traversed while `event-merge.ts`'s module body is still running: a
 * top-level `registerEventMergeHandler(...)` here would touch its `handlers`
 * map in the temporal dead zone. Registration happens ONLY inside
 * `registerPrintWatch()`, which the bootstrap calls lazily, from a function
 * body, after both registry modules have finished evaluating.
 *
 * Idempotent per process: the bootstrap is itself latched, but every entry
 * point may call this directly (tests do), and a second call must not trip the
 * registries' duplicate-name throw.
 */
import type Database from "better-sqlite3";
import { registerEventMergeHandler } from "@/lib/earnings/event-merge";
import { registerPrepareStep } from "@/lib/earnings/prepare-armed-event";
import { mergePrintWatchState, PRINT_WATCH_MERGE_HANDLER_NAME } from "./merge-handler";
import { mergePrintWatchGoState, PRINT_WATCH_GO_MERGE_HANDLER_NAME } from "./go";
import { IR_BASELINE_STEP, IR_BASELINE_STEP_NAME } from "./ir-baseline-step";
import { registerFirstPass, __resetFirstPassRegisterForTests } from "./first-pass-register";

let registered = false;

/** `db` is OPTIONAL and additive: only slice D's root uses it, to arm the
 *  durable first-pass reconcile timer. A's composition root calls this with no
 *  argument and registers the handlers alone. */
export function registerPrintWatch(db?: Database.Database): void {
  if (registered) return;
  registered = true;
  // Slices C and D BOTH register ahead of B, deliberately. B's handler deletes
  // the donor print row at the end of a both-prints merge; go rows
  // (print_watch_go_requests) and first-pass rows (print_watch_reads /
  // print_watch_callouts) all reference print_watch_prints with no cascade, so
  // each has to repoint its own rows before that delete (R-C7, plan M-D12).
  // C before D only to match slice order — the two are independent: no foreign
  // key runs between the go tables and the first-pass tables.
  registerEventMergeHandler(PRINT_WATCH_GO_MERGE_HANDLER_NAME, mergePrintWatchGoState);
  registerFirstPass(db);
  registerEventMergeHandler(PRINT_WATCH_MERGE_HANDLER_NAME, mergePrintWatchState);
  registerPrepareStep(IR_BASELINE_STEP_NAME, IR_BASELINE_STEP);
}

/** Tests that clear the registries (`__resetEventMergeHandlersForTests` /
 *  `__resetPrepareStepsForTests`) must clear this latch too, or the next
 *  `registerPrintWatch()` would silently register nothing. */
export function __resetRegisterForTests(): void {
  registered = false;
  __resetFirstPassRegisterForTests();
}
