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
import { registerEventMergeHandler } from "@/lib/earnings/event-merge";
import { registerPrepareStep } from "@/lib/earnings/prepare-armed-event";
import { mergePrintWatchState, PRINT_WATCH_MERGE_HANDLER_NAME } from "./merge-handler";
import { mergePrintWatchGoState, PRINT_WATCH_GO_MERGE_HANDLER_NAME } from "./go";
import { IR_BASELINE_STEP, IR_BASELINE_STEP_NAME } from "./ir-baseline-step";

let registered = false;

export function registerPrintWatch(): void {
  if (registered) return;
  registered = true;
  // Slice C FIRST, deliberately: B's handler deletes the donor print row at
  // the end of a both-prints merge, and go rows reference prints with no
  // cascade — C has to repoint them before that delete (see go.ts).
  registerEventMergeHandler(PRINT_WATCH_GO_MERGE_HANDLER_NAME, mergePrintWatchGoState);
  registerEventMergeHandler(PRINT_WATCH_MERGE_HANDLER_NAME, mergePrintWatchState);
  registerPrepareStep(IR_BASELINE_STEP_NAME, IR_BASELINE_STEP);
}

/** Tests that clear the registries (`__resetEventMergeHandlersForTests` /
 *  `__resetPrepareStepsForTests`) must clear this latch too, or the next
 *  `registerPrintWatch()` would silently register nothing. */
export function __resetRegisterForTests(): void {
  registered = false;
}
