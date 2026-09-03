/**
 * Live print v2 slice A — registration module for the concrete prepare
 * steps. Side-effect-free at import time (registerPrepareStepsOnce is
 * called only from lib/earnings/registry-bootstrap.ts, never here) — see
 * that file's header for why the registration must stay lazy.
 *
 * Ruling R2 (plan defect fix): Task 10 registers only the three steps that
 * exist here — consensus_row, intel, con_id — in run order. Task 11 adds
 * `newsletter_rescan` (imported + registered FIRST, ahead of consensus_row,
 * per spec §4.1's step order) and updates the cold-process assertion to the
 * final four.
 */
import { listPrepareSteps, registerPrepareStep } from "../prepare-armed-event";
import { consensusRowStep } from "./consensus-row";
import { intelStep } from "./intel";
import { conIdStep } from "./con-id";
// TASK 11 INSERTS HERE: import { newsletterRescanStep } from "./newsletter-rescan";

/** Idempotent: safe to call from every entry point (route, sweep, scripts). Order = run order. */
export function registerPrepareStepsOnce(): void {
  const have = new Set(listPrepareSteps());
  // TASK 11 INSERTS HERE: if (!have.has("newsletter_rescan")) registerPrepareStep("newsletter_rescan", newsletterRescanStep);
  if (!have.has("consensus_row")) registerPrepareStep("consensus_row", consensusRowStep);
  if (!have.has("intel")) registerPrepareStep("intel", intelStep);
  if (!have.has("con_id")) registerPrepareStep("con_id", conIdStep);
}
// NO top-level call: registration happens through bootstrapEarningsRegistries() (registry-bootstrap.ts),
// lazily, so the import cycle prepare-armed-event → registry-bootstrap → prepare-steps →
// prepare-armed-event never touches an uninitialised binding at module-evaluation time.
