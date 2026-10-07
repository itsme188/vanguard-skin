/**
 * One synthetic book shared by the Mac and Worker email-finder tests
 * (tests/earnings/manual-twin-email.test.ts and
 * workers/cron/test/manual-twin-email-parity.test.ts), so both sides are held
 * to the SAME expectation: one company, two live hand-entered earnings rows a
 * day apart, and email follows the earlier one (owner ruling 2026-10-07).
 *
 * Imports nothing, so the Worker's test runtime can load it.
 */
export const MANUAL_TWIN_FIXTURE = {
  symbol: "ZZA",
  /** US-Eastern release time on both rows (after the close). */
  releaseTime: "16:00",
  earlier: { id: 1, eventDate: "2026-06-10" },
  later: { id: 2, eventDate: "2026-06-11" },
  /** 20:00 UTC = 16:00 ET in June; two hours before each row's release. */
  twoHoursBeforeEarlierRelease: "2026-06-10T18:00:00Z",
  twoHoursBeforeLaterRelease: "2026-06-11T18:00:00Z",
  /** Thirty minutes after the later row's actual was captured. */
  laterRowEnrichedAt: "2026-06-11 20:30:00",
  afterLaterRowEnriched: "2026-06-11T21:00:00Z",
  laterRowActual: "EPS 1.00 · Rev 1000000000",
} as const;
