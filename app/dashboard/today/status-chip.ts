/**
 * Pure status-chip helpers for the Today page. Split out of EarningsHub.tsx
 * ([C-17], live print v2 slice A Task 5): EarningsHub is a server component
 * that imports the `db` singleton at module load, so its helpers can't be
 * imported by a unit test. No imports beyond the `SymbolStatus` type.
 */
import type { SymbolStatus } from "@/lib/queries/briefing-symbols";

export function statusChipClass(status: SymbolStatus): string {
  if (status === "held") return "text-up bg-up/15 border border-up/30";
  if (status === "watchlist") return "text-gold-ink bg-gold/15 border border-gold/30";
  if (status === "armed") return "text-ink-dim bg-raised border border-edge-strong";
  return "text-ink-faint bg-raised border border-edge";
}

export function statusChipLabel(status: SymbolStatus): string {
  if (status === "held") return "HELD";
  if (status === "watchlist") return "WATCH";
  if (status === "armed") return "ARMED";
  return "—";
}
