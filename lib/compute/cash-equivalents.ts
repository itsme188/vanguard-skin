/**
 * Shared "is this security really just cash?" predicate.
 *
 * Money-market sweep funds (VMFXX/VFFXX/VFMXX and friends) are cash that
 * happens to have a ticker. The brokers disagree about how to report them:
 * the statement/canonical import path writes them as ordinary `holdings`
 * rows, while the Plaid daily path folds them straight into the cash
 * balance and never emits a position. Because `daily_valuations.cash_balance`
 * is a residual (snapshot_total − holdings_value), whichever source happened
 * to own the latest snapshot for a date decided whether the sweep balance
 * counted as cash or as holdings — a month-end split flip driven purely by
 * plumbing, with no economic event behind it.
 *
 * This predicate is the single place that answers the question, so every
 * surface that needs the same normalization can share it.
 *
 * Both signals already exist in the repo; do NOT add a symbol allowlist here
 * — identity is owned by the classification layer:
 *   1. `security_type` = 'money_market' / 'money market' — set by the static
 *      lookup's `fix_security_type` (lib/data/security-classifications.ts)
 *      and by broker/import type mapping.
 *   2. `fund_category` = 'Cash Equivalent' / 'Money Market' — set by the
 *      static lookup and by the auto rule in
 *      lib/compute/classify-securities.ts. This catches rows whose
 *      `security_type` was never repaired (brokers routinely label a
 *      money-market fund a plain 'Stock' or 'Mutual Fund'). The 'Money
 *      Market' spelling is accepted because that literal vocabulary already
 *      exists in-repo — lib/import/parsers/vanguard-export.ts:60 derives it.
 *
 * IMPORTANT — in current production data signal 2 is the ONLY one doing any
 * work: live VMFXX rows carry security_type = 'Mutual Fund' with
 * fund_category = 'Cash Equivalent', so the money_market branch of signal 1
 * matches nothing today. It is kept because the static lookup still writes
 * that type via `fix_security_type` and a re-classification run would revive
 * it — but do not assume signal 1 provides any live coverage, and do not
 * "simplify" signal 2 away on the grounds that signal 1 looks sufficient.
 *
 * Note what is deliberately NOT cash: bonds and ultra-short bond funds are
 * holdings — they carry duration and mark to market.
 */
export function isCashEquivalentSecurity(sec: {
  security_type: string | null;
  fund_category: string | null;
}): boolean {
  // Case-insensitive on both fields (project convention — broker feeds vary
  // the casing of every type string they send).
  const type = sec.security_type?.trim().toLowerCase();
  if (type === "money_market" || type === "money market") return true;

  // Exact match, never substring — "Cash Equivalent Alternatives" is a
  // different asset class.
  const category = sec.fund_category?.trim().toLowerCase();
  return category === "cash equivalent" || category === "money market";
}
