interface SnapshotAgeProps {
  asOfDate: string | null;
  /**
   * Source label rendered before the date — typically "Snapshot" for
   * statement-based accounts (Vanguard) or "Vanguard" when rendered
   * in a header that also surfaces IBKR / aggregate freshness.
   */
  label?: string;
  /**
   * When true, render even for fresh data. Default false hides the chip
   * for snapshots <= 1 day old (avoids noise on live-sync accounts).
   */
  alwaysShow?: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtShortDate(iso: string): string {
  const [, month, day] = iso.split("T")[0].split("-");
  return `${MONTHS[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

export interface SnapshotAgeMeta {
  ageDays: number;
  ageLabel: string;
  tone: "ink-faint" | "ink-dim" | "warn";
  glyph: string;
}

/**
 * Pure helper exported for tests. Computes display metadata for a snapshot
 * `asOfDate` (YYYY-MM-DD) relative to `now`. Tone escalates with age:
 *   0-7d   → ink-faint (statement just landed, expected)
 *   8-21d  → ink-dim   (mid-cycle, structurally normal)
 *   22d+   → warn      (full statement cycle missed, import overdue)
 *
 * The thresholds are tuned to Vanguard's monthly-statement cadence: a
 * normal monthly statement lands 10-15d after period-end, so up to ~21d
 * is the expected envelope. Anything beyond suggests the user missed
 * an import.
 */
export function computeSnapshotAgeMeta(asOfDate: string, now: Date = new Date()): SnapshotAgeMeta {
  const then = new Date(asOfDate.split("T")[0] + "T00:00:00");
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const ageDays = Math.max(0, Math.floor((today.getTime() - then.getTime()) / 86_400_000));
  const ageLabel = ageDays === 0 ? "today" : ageDays === 1 ? "1d ago" : `${ageDays}d ago`;
  if (ageDays >= 22) return { ageDays, ageLabel, tone: "warn", glyph: "⚠ " };
  if (ageDays >= 8) return { ageDays, ageLabel, tone: "ink-dim", glyph: "" };
  return { ageDays, ageLabel, tone: "ink-faint", glyph: "" };
}

const TONE_CLASS: Record<SnapshotAgeMeta["tone"], string> = {
  "ink-faint": "text-ink-faint",
  "ink-dim": "text-ink-dim",
  warn: "text-down/80",
};

export function SnapshotAge({ asOfDate, label = "Snapshot", alwaysShow = false }: SnapshotAgeProps) {
  if (!asOfDate) return null;
  const meta = computeSnapshotAgeMeta(asOfDate);
  if (!alwaysShow && meta.ageDays <= 1) return null;

  return (
    <span
      className={`text-[11px] font-mono ${TONE_CLASS[meta.tone]}`}
      title={`Holdings as of ${asOfDate}. Vanguard accounts update only on statement import; cash and positions reflect the last imported statement.`}
    >
      {meta.glyph}
      {label} · {fmtShortDate(asOfDate)} · {meta.ageLabel}
    </span>
  );
}
