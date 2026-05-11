/**
 * ISO-week Monday for a given YYYY-MM-DD date.
 * Returns YYYY-MM-DD. Sunday rolls back to the prior Monday.
 */
export function mondayOf(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00Z"); // noon UTC avoids DST edges
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offset = day === 0 ? -6 : 1 - day; // Sun → -6, Mon → 0, Tue → -1, ...
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the YYYY-MM-DD date exactly 7 days before the input.
 */
export function weekAgo(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}
