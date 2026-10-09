/**
 * "Held" for EARNINGS coverage in the cloud.
 *
 * On the Mac, earnings coverage and the three print-push gates ask one reader
 * (`getSymbolStatusDetailed`, lib/queries/briefing-symbols.ts) whether a name
 * is held. That reader counts a name held long OR short, and a name held only
 * through a live option on it (the option's underlying).
 *
 * `snapshot.heldSymbols` is narrower on purpose: long stock only. It feeds the
 * digest, the evening email, the briefing and newsletter relevance, and it
 * keeps that meaning.
 *
 * Snapshot v14 ships the Mac reader's own answer as `earningsHeldSymbols`
 * (symbols only). Every earnings reader in the Worker takes its held set from
 * HERE and from nowhere else:
 *
 *   - the field is present (a list, empty or not): that list IS the held set.
 *     An empty list means no held names; it never falls back.
 *   - the field is absent (a snapshot older than v14): `heldSymbols`, exactly
 *     as before.
 *
 * No option expiry is compared here and no quantity is read: the Mac decided,
 * on the snapshot's Eastern day.
 *
 * Guards: workers/cron/test/earnings-held.test.ts,
 * tests/scripts/snapshot-earnings-held-symbols.test.ts (Mac side, parity).
 */
import type { Snapshot } from "./state";

/** Upper-cased held set for earnings coverage. See the file header. */
export function earningsHeldSet(
  snapshot: Pick<Snapshot, "heldSymbols" | "earningsHeldSymbols">,
): Set<string> {
  const source = Array.isArray(snapshot.earningsHeldSymbols)
    ? snapshot.earningsHeldSymbols
    : (snapshot.heldSymbols ?? []);
  const out = new Set<string>();
  for (const s of source) {
    if (typeof s === "string" && s) out.add(s.toUpperCase());
  }
  return out;
}
