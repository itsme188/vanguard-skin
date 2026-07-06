/**
 * Push-at-print message composer (Wave 1 §2).
 *
 * PURE and dependency-free ON PURPOSE: workers/cron/src/print-push-message.ts
 * is a byte-parity mirror of everything below this header (parity-tested).
 * Do not add imports here — change both files together.
 *
 * Input actual/consensus are the Finnhub-shape strings stored in
 * calendar_events ("EPS 1.42 · Rev 775,200,000"); output is human-formatted
 * public market data only (no position info ever).
 */

interface ParsedFigure {
  eps: string | null; // verbatim EPS token, e.g. "1.42" / "-0.24"
  revenueRaw: number | null;
}

function parseFigure(raw: string | null): ParsedFigure {
  if (!raw) return { eps: null, revenueRaw: null };
  const epsMatch = raw.match(/EPS\s+(-?[\d.]+)/i);
  const revMatch = raw.match(/Rev\s+([\d,]+(?:\.\d+)?)/i);
  const revenueRaw = revMatch ? Number(revMatch[1].replace(/,/g, "")) : null;
  return {
    eps: epsMatch ? epsMatch[1] : null,
    revenueRaw: Number.isFinite(revenueRaw ?? NaN) ? revenueRaw : null,
  };
}

function compactRevenue(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function pct(v: number): string {
  const s = v.toFixed(2);
  return v >= 0 ? `+${s}%` : `${s}%`;
}

export function composePrintPushMessage(input: {
  symbol: string;
  actualValue: string;
  consensusValue: string | null;
  reactionJson: string | null;
}): { title: string; message: string } {
  const act = parseFigure(input.actualValue);
  const cons = parseFigure(input.consensusValue);

  const parts: string[] = [];
  if (act.eps != null) {
    parts.push(cons.eps != null ? `EPS ${act.eps} vs ${cons.eps} est` : `EPS ${act.eps}`);
  }
  if (act.revenueRaw != null) {
    parts.push(
      cons.revenueRaw != null
        ? `Rev ${compactRevenue(act.revenueRaw)} vs ${compactRevenue(cons.revenueRaw)}`
        : `Rev ${compactRevenue(act.revenueRaw)}`,
    );
  }

  if (input.reactionJson) {
    try {
      const snap = JSON.parse(input.reactionJson) as {
        symbol?: { delta_pct?: number };
        spy?: { delta_pct?: number };
      };
      const symPct = snap.symbol?.delta_pct;
      const spyPct = snap.spy?.delta_pct;
      if (typeof symPct === "number" && typeof spyPct === "number") {
        parts.push(`${input.symbol.toUpperCase()} ${pct(symPct)} vs SPY ${pct(spyPct)} (T+2h)`);
      }
    } catch {
      // malformed snapshot → no reaction tail
    }
  }

  return {
    title: `${input.symbol.toUpperCase()} reported`,
    message: parts.join(" · "),
  };
}
