/**
 * "Today's reporters" — pure renderer, Worker mirror.
 *
 * Byte-parity hand-copy of lib/digest/todays-reporters-render.ts below
 * this header (the print-push-message.ts / presence-position.ts pattern
 * — the Worker can't cross the Next.js path-alias boundary). Pinned by
 * workers/cron/test/todays-reporters.test.ts. Change BOTH files together.
 */

export interface ReporterRowView {
  /** "BMO" | "AMC" | "TBD" — release slot. */
  slot: string;
  /** "HH:MM" ET release time, or null when unknown. */
  time: string | null;
  symbol: string;
  /** "held" | "wl" | "rt" | "" — empty renders as an em-dash. */
  chip: string;
  /** Compact consensus ("$3.80 · $12.84B") or null. */
  cons: string | null;
  /** "±X.X%" implied move from the earnings_intel cache, or null. */
  impl: string | null;
}

/** Empty rows → null: the block self-quiets outside earnings season. */
export function renderTodaysReportersBlock(rows: ReporterRowView[]): string | null {
  if (rows.length === 0) return null;
  const lines: string[] = [
    "## Today's reporters",
    "",
    "| | Sym | Pos | Cons | Impl move |",
    "|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const slot = r.time ? `${r.slot} ${r.time}` : r.slot;
    lines.push(
      `| ${slot} | ${r.symbol} | ${r.chip || "—"} | ${r.cons ?? "—"} | ${r.impl ?? "—"} |`,
    );
  }
  return lines.join("\n");
}
