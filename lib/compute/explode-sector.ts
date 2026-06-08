type Weights = Map<string, Array<{ sector: string; weight_pct: number }>>;

/**
 * Distribute a holding's market value across GICS sectors.
 * - ETF/Mutual Fund WITH look-through weights → split by weight.
 * - Otherwise → single bucket (the holding's own sector, or "Unknown").
 */
export function explodeHoldingBySector(
  symbol: string,
  securityType: string | null,
  marketValue: number,
  weights: Weights,
  ownSector?: string | null
): Array<{ sector: string; value: number }> {
  const isFund = ["etf", "mutual fund"].includes((securityType ?? "").toLowerCase());
  const w = isFund ? weights.get(symbol) : undefined;
  if (w && w.length > 0) {
    return w.map((row) => ({ sector: row.sector, value: marketValue * (row.weight_pct / 100) }));
  }
  return [{ sector: ownSector && ownSector.trim() !== "" ? ownSector : "Unknown", value: marketValue }];
}
