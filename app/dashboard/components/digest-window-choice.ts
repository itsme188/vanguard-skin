import { todayET } from "@/lib/calendar/date-utils";

/**
 * The digest window a reader picked, shared by the Send panel and the Preview
 * so the preview shows the window a send would cover.
 *
 * Client-safe on purpose: the server rule is `resolveDigestSince`
 * (lib/digest/digest-window.ts), which reads the database. This file states
 * the same rule for the two modes that need no database, and leaves the third
 * (since last email) to the server. A test pins the two against each other.
 */
export type DigestMode = "today" | "since_last" | "since_date";

export interface DigestWindowChoice {
  mode: DigestMode;
  /** YYYY-MM-DD; used only in "since_date" mode. "" = not chosen yet. */
  sinceDate: string;
}

export const DEFAULT_DIGEST_WINDOW: DigestWindowChoice = { mode: "today", sinceDate: "" };

export const DIGEST_WINDOW_OPTIONS: ReadonlyArray<{ mode: DigestMode; label: string }> = [
  { mode: "today", label: "Today's articles" },
  { mode: "since_last", label: "Since last email" },
  { mode: "since_date", label: "Since date..." },
];

export function isDigestMode(value: string): value is DigestMode {
  return value === "today" || value === "since_last" || value === "since_date";
}

/**
 * A date mode with no date picked. Neither surface may act on it: the server
 * would quietly use a different window.
 */
export function digestWindowNeedsDate(choice: DigestWindowChoice): boolean {
  return choice.mode === "since_date" && !choice.sinceDate;
}

/**
 * The `since` the preview asks for. `undefined` means "send none": the preview
 * route then applies the sender's own since-last-email rule.
 */
export function digestPreviewSince(choice: DigestWindowChoice, now = new Date()): string | undefined {
  if (choice.mode === "today") return todayET(now);
  if (choice.mode === "since_date" && choice.sinceDate) return choice.sinceDate;
  return undefined;
}

/** The window fields of the send request. */
export function digestSendBody(choice: DigestWindowChoice): { mode: DigestMode; sinceDate?: string } {
  if (choice.mode === "since_date" && choice.sinceDate) {
    return { mode: choice.mode, sinceDate: choice.sinceDate };
  }
  return { mode: choice.mode };
}
