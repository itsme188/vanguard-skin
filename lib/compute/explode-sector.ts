type Weights = Map<string, Array<{ sector: string; weight_pct: number }>>;

/**
 * Distribute a holding's market value across GICS sectors.
 * - ETF/Mutual Fund WITH look-through weights → split by weight.
 * - Bond without a sector → "Fixed Income" (held Treasuries have NULL
 *   securities.sector; "Unknown" would misrepresent a cash-like sleeve).
 * - Otherwise → single bucket (the holding's own sector, or "Unknown").
 */
export function explodeHoldingBySector(
  symbol: string,
  securityType: string | null,
  marketValue: number,
  weights: Weights,
  ownSector?: string | null
): Array<{ sector: string; value: number }> {
  const type = (securityType ?? "").toLowerCase();
  const isFund = ["etf", "mutual fund"].includes(type);
  const w = isFund ? weights.get(symbol) : undefined;
  if (w && w.length > 0) {
    return w.map((row) => ({ sector: row.sector, value: marketValue * (row.weight_pct / 100) }));
  }
  const fallback = type === "bond" ? "Fixed Income" : "Unknown";
  return [{ sector: ownSector && ownSector.trim() !== "" ? ownSector : fallback, value: marketValue }];
}
