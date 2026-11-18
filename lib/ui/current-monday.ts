/**
 * The Monday of the current Eastern calendar week, as YYYY-MM-DD.
 * Pure and import-free. The Eastern day is read through Intl; a UTC date
 * slice would be a day early from 20:00 Eastern.
 */
export function currentMondayET(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  // Calendar arithmetic on the Eastern date, done in UTC so no zone moves it.
  const ms = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) - Math.max(back, 0));
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
