/**
 * Gains at risk: the stress scope's account ids, one copy for the route and
 * the server section.
 *
 * SERVER-ONLY. It value-imports `lib/queries/accounts`, so no client file and
 * neither `gains-at-risk-view.ts` nor `gains-at-risk-input.ts` may import it
 * (the import-walk test in tests/dashboard/gains-at-risk-view-source.test.ts
 * refuses it).
 */

import type Database from "better-sqlite3";
import { resolveScope } from "@/lib/queries/accounts";
import type { AnalysisScope } from "@/lib/analysis/view-param";

/**
 * "all" is every account (undefined). Any other scope word reads only the
 * accounts it names; a word that names no account reads NOTHING ([]), never
 * every account (`resolveScope` alone would answer undefined there).
 */
export function gainsAtRiskAccountIds(db: Database.Database, scope: AnalysisScope): number[] | undefined {
  if (scope === "all") return undefined;
  return resolveScope(db, scope) ?? [];
}
