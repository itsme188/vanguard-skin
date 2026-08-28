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

/**
 * Renders an actual/expected revenue pair on ONE shared scale (chosen from
 * the larger magnitude) at the smallest decimal precision (1-3dp) that
 * still keeps the two rendered numbers visually distinct — fixes the CRWD
 * 2026-08-26 bug where compactRevenue's fixed 1dp rounded both the
 * 1,468,800,000 estimate and the 1,470,900,000 actual to "1.5B", erasing
 * the beat from the push. If the pair is STILL equal at 3dp, they
 * genuinely are equal at that precision and render equal — no
 * special-casing needed, the loop below lands there on its own.
 *
 * `surprise` uses a DEDICATED 1-decimal formatter (never the 2-decimal
 * `pct()` used for the T+2h reaction line — that's a different number with
 * a different job). It is null only when expected is 0 or non-finite,
 * i.e. when a percent-of-expected can't be expressed at all. An EXACT
 * match (actual === expected) still yields "+0.0%" — that's a real,
 * well-defined (zero) surprise, not an unrepresentable one.
 */
function compactRevenuePair(
  actual: number,
  expected: number,
): { actual: string; expected: string; surprise: string | null } {
  const larger = Math.max(Math.abs(actual), Math.abs(expected));
  let scale = 1;
  let suffix = "";
  if (larger >= 1e9) {
    scale = 1e9;
    suffix = "B";
  } else if (larger >= 1e6) {
    scale = 1e6;
    suffix = "M";
  } else if (larger >= 1e3) {
    scale = 1e3;
    suffix = "K";
  }

  let actualStr: string;
  let expectedStr: string;
  if (suffix === "") {
    actualStr = actual.toFixed(0);
    expectedStr = expected.toFixed(0);
  } else {
    const a = actual / scale;
    const e = expected / scale;
    actualStr = `${a.toFixed(1)}${suffix}`;
    expectedStr = `${e.toFixed(1)}${suffix}`;
    for (let d = 2; d <= 3 && actualStr === expectedStr; d++) {
      actualStr = `${a.toFixed(d)}${suffix}`;
      expectedStr = `${e.toFixed(d)}${suffix}`;
    }
  }

  let surprise: string | null = null;
  if (Number.isFinite(actual) && Number.isFinite(expected) && expected !== 0) {
    const v = ((actual - expected) / expected) * 100;
    const s = v.toFixed(1);
    surprise = v >= 0 ? `+${s}%` : `${s}%`;
  }

  return { actual: actualStr, expected: expectedStr, surprise };
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
    if (cons.revenueRaw != null) {
      const p = compactRevenuePair(act.revenueRaw, cons.revenueRaw);
      parts.push(`Rev ${p.actual} vs ${p.expected}${p.surprise ? ` (${p.surprise})` : ""}`);
    } else {
      parts.push(`Rev ${compactRevenue(act.revenueRaw)}`);
    }
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
