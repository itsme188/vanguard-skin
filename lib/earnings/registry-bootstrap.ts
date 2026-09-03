// Composition root for the two registries. Called by mergeEarningsEventState, enqueuePrepareSteps
// and runPrepareSteps before they read a registry, so no entrypoint can forget it. Idempotent.
//
// NOTHING here may be imported at module-evaluation time by the modules it
// bootstraps — the cycle prepare-armed-event → registry-bootstrap → prepare-steps
// → prepare-armed-event must only ever be traversed lazily, inside a function body.
import { registerPrepareStepsOnce } from "./prepare-steps";
// import { registerPrintWatch } from "@/lib/print-watch/register";   // slice B — enabled by the post-merge integration task

let done = false;
let suppressed = false;

export function bootstrapEarningsRegistries(): void {
  if (done || suppressed) return;
  done = true;
  registerPrepareStepsOnce();
  // registerPrintWatch();   // slice B (integration task)
}

/** Unit tests that register their own steps/handlers call this (via the two __reset helpers)
 *  so the real steps are not silently added under them. */
export function __isBootstrapSuppressedForTests(value?: boolean): boolean {
  if (value !== undefined) {
    suppressed = value;
    done = false;
  }
  return suppressed;
}
