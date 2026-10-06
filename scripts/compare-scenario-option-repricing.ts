/**
 * Read-only check of how the scenario engines treat option positions on a
 * database copy (spec: docs/superpowers/specs/
 * 2026-10-06-scenario-option-repricing-design.md, section 9).
 *
 * Usage, from the repo root:
 *   npx tsx scripts/compare-scenario-option-repricing.ts <path-to-db-copy>
 *
 * Output is direction-only: counts of option rows by volatility source, by
 * "not modelled" reason and by the sign of their change. It prints no dollar
 * amount, no share of the book and no symbol, so the output is safe to paste
 * into a committed document. The database is opened read-only.
 */
import Database from "better-sqlite3";
import { computeAllScenarios, computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { isOptionSecurityType } from "@/lib/compute/option-elasticity";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: npx tsx scripts/compare-scenario-option-repricing.ts <path-to-db-copy>");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tally(result: ScenarioResult) {
  const options = result.positionImpacts.filter((p) => isOptionSecurityType(p.securityType));
  const bySource: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let gains = 0;
  let losses = 0;
  let flat = 0;
  let notFinite = 0;
  for (const p of options) {
    if (!Number.isFinite(p.estimatedChange) || !Number.isFinite(p.changePercent)) notFinite += 1;
    if (p.unmodelledReason) byReason[p.unmodelledReason] = (byReason[p.unmodelledReason] ?? 0) + 1;
    else bySource[p.ivSource ?? "no-source-field"] = (bySource[p.ivSource ?? "no-source-field"] ?? 0) + 1;
    if (p.estimatedChange > 0) gains += 1;
    else if (p.estimatedChange < 0) losses += 1;
    else flat += 1;
  }
  const rowSum = result.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
  return {
    scenario: result.scenario.id,
    optionRows: options.length,
    bySource,
    notModelled: byReason,
    optionChangeSign: { gains, losses, flat },
    notFinite,
    totalTiesToRows: Math.abs(rowSum - result.estimatedChange) < 1e-6,
  };
}

const results: ScenarioResult[] = [
  ...computeAllScenarios(db),
  computeScenario(db, { id: "custom", name: "check", description: "", category: "custom", marketMove: -0.3 }),
  computeScenario(db, { id: "custom", name: "check-vol", description: "", category: "custom", marketMove: -0.3, volMove: 20 }),
];

for (const [i, r] of results.entries()) {
  const row = tally(r);
  if (i === results.length - 1) row.scenario = "custom -30%, volatility +20 points";
  else if (i === results.length - 2) row.scenario = "custom -30%";
  console.log(JSON.stringify(row));
}
db.close();
