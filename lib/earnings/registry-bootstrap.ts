// Composition root for the two registries. Called by mergeEarningsEventState, enqueuePrepareSteps
// and runPrepareSteps before they read a registry, so no entrypoint can forget it. Idempotent.
//
// [C-14] The body is deliberately EMPTY at this point in the build: Task 10 adds
//   import { registerPrepareStepsOnce } from "./prepare-steps";
// and its call below, and slice B's integration task adds registerPrintWatch().
// Until then every call site self-bootstraps against an empty registry, which is
// exactly the pre-Task-10 behaviour (no steps registered).
//
// NOTHING here may be imported at module-evaluation time by the modules it
// bootstraps — the cycle prepare-armed-event → registry-bootstrap → prepare-steps
// → prepare-armed-event must only ever be traversed lazily, inside a function body.

let done = false;
let suppressed = false;

export function bootstrapEarningsRegistries(): void {
  if (done || suppressed) return;
  done = true;
  // registerPrepareStepsOnce();   // Task 10
  // registerPrintWatch();         // slice B (integration task)
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
