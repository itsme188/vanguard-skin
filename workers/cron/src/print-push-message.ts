/**
 * Push-at-print message composer — Worker byte-parity mirror of
 * lib/alerts/print-push-message.ts (below this header comment).
 *
 * The Worker can't cross the Next.js `@/` path-alias boundary, so (like the
 * issuerSiblings copy in fallback-earnings.ts / the presence-position.ts
 * mirror) this is a hand copy. PURE and dependency-free ON PURPOSE — do not
 * add imports here — change both files together. Parity enforced by
 * print-push-message.test.ts.
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

// Read-through lines (#13): target symbols + the user's own curated
// hypothesis text — the ONLY non-public content the push may carry (never
// quantities or values). Capped + truncated so a push stays glanceable.
const READ_THROUGH_LINE_CAP = 3;
const HYPOTHESIS_CHAR_CAP = 140;

export interface PrintPushReadThrough {
  target: string;
  /** "held" | "watchlist" — resolved by the caller against current positions. */
  targetStatus: string;
  hypothesis: string | null;
}

export function composePrintPushMessage(input: {
  symbol: string;
  actualValue: string;
  consensusValue: string | null;
  reactionJson: string | null;
  /** Live read-through pairs for this reporter (weight-sorted upstream). */
  readThroughs?: PrintPushReadThrough[];
  /** True when the push exists ONLY because of the read-through (the
   *  reporter itself is neither held nor watchlisted) — flags the title. */
  readThroughOnly?: boolean;
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

  const lines = [parts.join(" · ")];
  for (const rt of (input.readThroughs ?? []).slice(0, READ_THROUGH_LINE_CAP)) {
    const hyp =
      rt.hypothesis && rt.hypothesis.length > HYPOTHESIS_CHAR_CAP
        ? `${rt.hypothesis.slice(0, HYPOTHESIS_CHAR_CAP)}…`
        : rt.hypothesis;
    lines.push(`→ ${rt.target.toUpperCase()} (${rt.targetStatus})${hyp ? `: ${hyp}` : ""}`);
  }

  return {
    title: `${input.symbol.toUpperCase()} reported${input.readThroughOnly ? " — read-through" : ""}`,
    message: lines.join("\n"),
  };
}
