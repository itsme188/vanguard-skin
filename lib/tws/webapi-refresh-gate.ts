/**
 * Gate for the disconnected-path background refresh (R1 auto-cadence,
 * spec: docs/superpowers/specs/2026-07-03-away-from-home-auto-refresh-design.md).
 *
 * When TWS is down but the app is awake, useAutoRefresh fires the IBKR Web
 * API fallback on the normal 30-min rhythm — but only Mon–Fri 9:30–16:00
 * ET and never on NYSE holidays. ET is read from an Intl wall clock, NEVER
 * the local clock (the Mac travels; see the ET-anchor convention).
 * Pure — `now` injected for testability.
 */

import { todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";

const ET_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const MARKET_OPEN_MINUTES = 9 * 60 + 30; // 9:30 ET
const MARKET_CLOSE_MINUTES = 16 * 60; // 16:00 ET

export interface DisconnectedRefreshGateInput {
  now: Date;
  /** Epoch ms of the last disconnected-path refresh; 0 = never. */
  lastRefreshMs: number;
  /** Refresh interval in minutes; 0 disables. */
  intervalMinutes: number;
}

export function shouldFireDisconnectedRefresh(input: DisconnectedRefreshGateInput): boolean {
  const { now, lastRefreshMs, intervalMinutes } = input;
  if (intervalMinutes <= 0) return false;
  if (now.getTime() - lastRefreshMs < intervalMinutes * 60_000) return false;

  const parts = ET_CLOCK.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;

  // "24" can appear for midnight under hour12:false hourCycle quirks — % 24.
  const minutesOfDay = ((Number(get("hour")) % 24) * 60 + Number(get("minute")));
  if (minutesOfDay < MARKET_OPEN_MINUTES || minutesOfDay >= MARKET_CLOSE_MINUTES) return false;

  return !isMarketClosed(todayET(now));
}
