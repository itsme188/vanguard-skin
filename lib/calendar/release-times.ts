/**
 * Scheduled release times for macro + earnings events, "HH:MM" US Eastern.
 *
 * The enrichment runner uses these to decide when an event's release window
 * has opened — it only attempts to fetch actuals + reaction snapshots once
 * `event_date + release_time` is in the past (but within ~2 hours).
 *
 * Times here are authoritative: FRED schedules and the BLS/BEA/Fed
 * release calendar are public knowledge that doesn't drift without notice.
 * Keep this file in sync with the RELEASE_MAP guard in macro-events.ts.
 */

/** Macro event_type → scheduled US-Eastern release time. */
export const RELEASE_TIMES_ET: Record<string, string> = {
  // 08:30 ET releases — BLS / BEA / Census data drops
  cpi: "08:30",
  core_cpi: "08:30",
  ppi: "08:30",
  core_pce: "08:30",
  gdp: "08:30",
  nonfarm_payrolls: "08:30",
  unemployment: "08:30",
  retail_sales: "08:30",
  housing_starts: "08:30",
  durable_goods: "08:30",
  trade_balance: "08:30",
  jobs: "08:30",              // maps to existing event_type in DB
  housing: "08:30",

  // 10:00 ET releases — ISM / survey-based data
  ism_manufacturing: "10:00",
  ism_services: "10:00",
  umich_sentiment: "10:00",
  consumer_confidence: "10:00",
  pmi: "10:00",               // maps to existing event_type in DB

  // 14:00 ET — FOMC rate decision
  fomc_rate_decision: "14:00",
  fomc: "14:00",              // maps to existing event_type in DB
};

/**
 * Per-symbol release-time overrides for the handful of names whose actual
 * release time differs materially from the BMO/AMC defaults below. These
 * supersede the generic BMO/AMC mapping when a symbol is supplied.
 *
 * Add new entries here whenever a name reports outside the 08:00 / 16:15
 * defaults — the preview-window cron uses release_time to decide when to
 * fire the email, so getting these right prevents pre-release sends.
 *
 * Symbol keys are uppercase and dual-class siblings should be added together
 * (e.g. GOOG + GOOGL).
 */
export const SYMBOL_RELEASE_TIMES_ET: Record<string, string> = {
  AAPL: "16:30",
  AMZN: "16:01",
  GOOGL: "16:01",
  GOOG: "16:01",
  IMAX: "07:30", // verified: Q2 2026 press release wire PUB 07/23/2026 07:30 AM ET (DISC 07:33 AM ET) — BusinessWire, corroborated by AOL + voiceofalexandria mirrors. BMO reporter; Finnhub+Nasdaq both mis-slotted it AMC (2026-07-23).
  META: "16:05",
  MSFT: "16:05",
};

/**
 * Convert Finnhub's `hour` field to an HH:MM ET release time.
 *
 * Per-symbol overrides in `SYMBOL_RELEASE_TIMES_ET` win when supplied.
 *
 * BMO (before-market-open) → 08:00 ET — most companies report in the
 *   07:00–08:30 window before futures start to move on open.
 * AMC (after-market-close) → 16:15 ET — earnings calls are typically
 *   at 16:30–17:00 ET after the press release.
 * DMH (during-market-hours) / null / unknown → 16:15 ET default. Rare
 *   in practice; erring on the side of AMC means we still capture a
 *   reaction snapshot from today's close rather than skipping the event.
 */
export function earningsHourToReleaseTime(
  hour: "bmo" | "amc" | "dmh" | null | undefined,
  symbol?: string | null,
): string {
  if (symbol) {
    const override = SYMBOL_RELEASE_TIMES_ET[symbol.trim().toUpperCase()];
    if (override) return override;
  }
  switch (hour) {
    case "bmo":
      return "08:00";
    case "amc":
      return "16:15";
    case "dmh":
      return "16:15";
    default:
      return "16:15";
  }
}

export function normalizeEarningsHour(value: unknown): "bmo" | "amc" | "dmh" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "bmo" || normalized === "amc" || normalized === "dmh") {
    return normalized;
  }
  if (normalized === "unknown") return null;
  return null;
}

/**
 * Return the release time for a calendar_events row.
 *
 * Priority:
 *   1. If `event_time` is already "HH:MM", use it.
 *   2. If earnings + symbol has a per-symbol override, use it (wins over BMO/AMC).
 *   3. If event_type is in RELEASE_TIMES_ET, use the lookup.
 *   4. If earnings event, parse BMO/AMC/DMH from raw_json.entry.hour.
 *   5. Otherwise return null — event is skipped by the enrichment runner.
 */
export function resolveReleaseTime(row: {
  event_type: string;
  event_time: string | null;
  raw_json: string | null;
  symbol?: string | null;
}): string | null {
  if (row.event_time && /^\d{2}:\d{2}$/.test(row.event_time)) {
    return row.event_time;
  }

  if (row.event_type === "earnings") {
    const fromEventTime = normalizeEarningsHour(row.event_time);
    if (fromEventTime || row.event_time?.trim().toLowerCase() === "unknown") {
      return earningsHourToReleaseTime(fromEventTime, row.symbol);
    }
  }

  const fromMap = RELEASE_TIMES_ET[row.event_type];
  if (fromMap) return fromMap;

  if (row.event_type === "earnings" && row.raw_json) {
    try {
      const parsed = JSON.parse(row.raw_json) as {
        entry?: { hour?: unknown };
      };
      if (Object.prototype.hasOwnProperty.call(parsed.entry ?? {}, "hour")) {
        return earningsHourToReleaseTime(
          normalizeEarningsHour(parsed.entry?.hour),
          row.symbol,
        );
      }
    } catch {
      // Malformed JSON — fall through to null.
    }
  }

  return null;
}
