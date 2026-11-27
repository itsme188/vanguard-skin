/**
 * The words the "Sync Vanguard (Plaid)" button shows (plan v4, section A
 * "The button"). Plain module, no imports. Three callers take the sync
 * outcome sentence from here: the Accounts-tab button
 * (`app/dashboard/components/PlaidSyncButton.tsx`), the Settings panel's
 * "Sync Vanguard now" (`app/dashboard/components/PlaidSection.tsx`) and the
 * re-auth page (`app/dashboard/plaid-link/page.tsx`). The repo has no DOM
 * harness, so these rules are unit-tested here.
 *
 * Rules:
 *  - a skipped read says "Nothing stored" and why, as information;
 *  - a read that stored at least one account is a success and names the
 *    session and the accounts, then one sentence per account not stored;
 *  - a read that stored no account is information, never success;
 *  - the page is refreshed only when at least one account was stored.
 * No holding counts are shown, so nothing here needs the privacy components.
 */

/** The parts of the sync answer the message reads (the route's `data`). */
export interface PlaidSyncAnswer {
  skippedReason?: string | null;
  session?: string | null;
  storedAccounts?: { accountName: string }[];
  skippedAccounts?: { accountName?: string; accountId?: number; reason: string }[];
  valuationsRecomputed?: boolean;
  /** A forced skipped read checked the Plaid login and it worked. */
  connectionChecked?: boolean;
}

export type PlaidSyncTone = "success" | "info";

export interface PlaidSyncMessage {
  text: string;
  tone: PlaidSyncTone;
  /** True only when at least one account was stored. */
  refresh: boolean;
}

export const PLAID_MARKET_CLOSED_TEXT =
  "Nothing stored: the market is closed today. Vanguard figures are read before the open on trading days.";

export const PLAID_BEFORE_WINDOW_TEXT =
  "Nothing stored: it is before 7:30 a.m. Eastern. Vanguard figures for the previous close are read from 7:30 a.m. on trading days.";

export const PLAID_AFTER_OPEN_TEXT =
  "Nothing stored: it is past 9:30 a.m. Eastern. A read taken after the open cannot be tied to one trading session. The next read is before tomorrow's open.";

export const PLAID_ALREADY_SYNCED_TEXT =
  "Nothing new stored: Vanguard figures were already read today.";

export const PLAID_VALUES_NOT_UPDATED_TEXT =
  "Positions stored; values not yet updated (they update at the next sync).";

/** Prefix for a skipped forced read whose connection check succeeded. */
export const PLAID_CONNECTION_CONFIRMED_TEXT = "Connection confirmed.";

export const PLAID_NO_RESULT_TEXT =
  "The sync answered without a result. Nothing is known to be stored.";

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function accountLabel(a: { accountName?: string; accountId?: number }): string {
  if (a.accountName && a.accountName.trim().length > 0) return a.accountName;
  return a.accountId != null ? `Account ${a.accountId}` : "An account";
}

/** One sentence for an account the read did not store. */
export function plaidAccountSkipSentence(
  account: { accountName?: string; accountId?: number; reason: string },
  session: string | null,
): string {
  const name = accountLabel(account);
  switch (account.reason) {
    case "missing_in_response":
      return `${name}: missing from Plaid's answer.`;
    case "no_positions":
      return `${name}: no positions in Plaid's answer.`;
    case "statement_on_session":
      return session
        ? `${name}: a statement already covers ${session}.`
        : `${name}: a statement already covers that session.`;
    case "legacy_rows_after_session":
      return `${name}: older rows still need the repair.`;
    default:
      return `${name}: not stored.`;
  }
}

function skipSentence(reason: string | null | undefined): string | null {
  switch (reason) {
    case "market_closed":
      return PLAID_MARKET_CLOSED_TEXT;
    case "before_window":
      return PLAID_BEFORE_WINDOW_TEXT;
    case "after_open":
    case "read_finished_after_open":
      return PLAID_AFTER_OPEN_TEXT;
    case "already_synced_today":
      return PLAID_ALREADY_SYNCED_TEXT;
    default:
      return null;
  }
}

/** The button's message for a successful answer (`readMutationResult` ok). */
export function plaidSyncMessage(answer: PlaidSyncAnswer | null | undefined): PlaidSyncMessage {
  if (!answer) return { text: PLAID_NO_RESULT_TEXT, tone: "info", refresh: false };

  const skipText = skipSentence(answer.skippedReason);
  if (skipText) {
    const text = answer.connectionChecked ? `${PLAID_CONNECTION_CONFIRMED_TEXT} ${skipText}` : skipText;
    return { text, tone: "info", refresh: false };
  }

  const session = answer.session ?? null;
  const stored = answer.storedAccounts ?? [];
  const notStored = (answer.skippedAccounts ?? []).map((a) => plaidAccountSkipSentence(a, session));

  if (stored.length === 0) {
    const lead = session
      ? `No Vanguard account was stored for the ${session} close.`
      : "No Vanguard account was stored.";
    return { text: [lead, ...notStored].join(" "), tone: "info", refresh: false };
  }

  const lead = `Vanguard figures for the ${session ?? "previous"} close stored for ${joinNames(
    stored.map(accountLabel),
  )}.`;
  const parts = [lead, ...notStored];
  if (answer.valuationsRecomputed === false) parts.push(PLAID_VALUES_NOT_UPDATED_TEXT);
  return { text: parts.join(" "), tone: "success", refresh: true };
}

/**
 * The Settings panel's extra line when the read created securities that did
 * not exist before (symbol drift can make a duplicate). Empty list: "".
 */
export function plaidNewSecuritiesSentence(symbols: readonly string[]): string {
  if (symbols.length === 0) return "";
  return `New securities created: ${symbols.join(", ")} — verify these aren't duplicates of existing holdings.`;
}

/** The button's message when the request failed (server refusal or error). */
export function plaidSyncFailureText(serverMessage: string): string {
  return `Vanguard sync failed: ${serverMessage}`;
}

/** The action named in the network-failure sentence (`networkFailureMessage`). */
export const PLAID_SYNC_ACTION = "sync Vanguard";
