/**
 * synthesis-dating.ts — the send-date block of the digest synthesis prompt.
 * Mac side; the Worker carries a byte-identical mirror.
 */
// Dating rules mirrored byte for byte in lib/digest/synthesis-dating.ts and
// workers/cron/src/synthesis-dating.ts (tests/digest/synthesis-dating.test.ts
// pins the two files from this line down). Import-free on purpose.

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function longDate(d: Date, withYear: boolean): string {
  const base = `${WEEKDAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withYear ? `${base}, ${d.getUTCFullYear()}` : base;
}

/**
 * The prompt block that anchors every forward reference to the send date.
 *
 * A newsletter written on Friday says "next week's CPI"; copied into a digest
 * dated the following Monday that phrase tells the reader the print is a week
 * further away than it is. Likewise a dawn note's "IBKR reports after the
 * close" is stale in a digest dated the next morning. The model is told the
 * send date, that date's Monday-to-Friday trading week, and that a source's
 * relative words are relative to the source's own date.
 *
 * `sendDate` is the Eastern calendar day, YYYY-MM-DD. Anything else returns
 * "" so a malformed date never injects a wrong week.
 */
export function digestDatingRules(sendDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sendDate);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return "";
  const dow = d.getUTCDay();
  // Saturday looks back at the week just ended; Sunday looks ahead to the
  // week starting tomorrow; a weekday sits inside its own week.
  const mondayOffset = dow === 0 ? 1 : dow === 6 ? -5 : 1 - dow;
  const monday = new Date(d.getTime() + mondayOffset * 86_400_000);
  const friday = new Date(monday.getTime() + 4 * 86_400_000);
  const weekPhrase =
    dow === 6
      ? `The trading week just ended ran ${longDate(monday, false)} to ${longDate(friday, false)}.`
      : dow === 0
        ? `The coming trading week runs ${longDate(monday, false)} to ${longDate(friday, false)}.`
        : `Its trading week runs ${longDate(monday, false)} to ${longDate(friday, false)}.`;
  return [
    "DATING (HARD):",
    `- This digest is dated ${longDate(d, true)}. ${weekPhrase} Date every time reference from the send date, never from the day a source was written.`,
    `- An event inside that trading week is "this week", named by its weekday ("Wednesday's CPI"), never "next week". Only an event in the week after it is "next week".`,
    `- An event dated before the send date has already happened: describe it as reported, in the past tense, even where a source written earlier says it "reports after the close" or is "ahead of next week's results". A source's "today", "tonight", "tomorrow" and "next week" are relative to THAT source's date, not to this digest.`,
  ].join("\n");
}
