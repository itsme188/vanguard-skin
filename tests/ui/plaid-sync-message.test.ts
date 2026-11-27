/**
 * The "Sync Vanguard (Plaid)" button's words (plan v4 section A "The
 * button", unit U2). The helper `lib/ui/plaid-sync-message.ts` holds every
 * sentence; the button only shows what it returns. The repo has no DOM
 * harness, so the button itself is pinned by reading its source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  joinNames,
  plaidNewSecuritiesSentence,
  plaidSyncFailureText,
  plaidSyncMessage,
  PLAID_AFTER_OPEN_TEXT,
  PLAID_BEFORE_WINDOW_TEXT,
  PLAID_MARKET_CLOSED_TEXT,
  PLAID_NO_RESULT_TEXT,
  PLAID_VALUES_NOT_UPDATED_TEXT,
} from "@/lib/ui/plaid-sync-message";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { joinSentences } from "@/lib/ui/join-sentences";

const S = "2026-07-13";
const A = { accountName: "Synthetic A" };
const B = { accountName: "Synthetic B" };

describe("skipped reads say Nothing stored, as information", () => {
  it("market closed", () => {
    expect(plaidSyncMessage({ skippedReason: "market_closed", session: null })).toEqual({
      text: "Nothing stored: the market is closed today. Vanguard figures are read before the open on trading days.",
      tone: "info",
      refresh: false,
    });
    expect(PLAID_MARKET_CLOSED_TEXT).toContain("market is closed");
  });

  it("before 07:30", () => {
    expect(plaidSyncMessage({ skippedReason: "before_window" })).toEqual({
      text: "Nothing stored: it is before 7:30 a.m. Eastern. Vanguard figures for the previous close are read from 7:30 a.m. on trading days.",
      tone: "info",
      refresh: false,
    });
    expect(PLAID_BEFORE_WINDOW_TEXT).toContain("before 7:30 a.m. Eastern");
  });

  it("after the open, and a read that finished after the open, share one sentence", () => {
    const expected = {
      text: "Nothing stored: it is past 9:30 a.m. Eastern. A read taken after the open cannot be tied to one trading session. The next read is before tomorrow's open.",
      tone: "info",
      refresh: false,
    };
    expect(plaidSyncMessage({ skippedReason: "after_open" })).toEqual(expected);
    expect(plaidSyncMessage({ skippedReason: "read_finished_after_open" })).toEqual(expected);
    expect(PLAID_AFTER_OPEN_TEXT).toBe(expected.text);
  });

  it("already synced today (not reachable from the forced button, but never a success)", () => {
    const m = plaidSyncMessage({ skippedReason: "already_synced_today" });
    expect(m.tone).toBe("info");
    expect(m.refresh).toBe(false);
    expect(m.text.startsWith("Nothing new stored")).toBe(true);
  });

  it("a forced skipped read whose connection check worked says so first", () => {
    expect(plaidSyncMessage({ skippedReason: "market_closed", connectionChecked: true })).toEqual({
      text: `Connection confirmed. ${PLAID_MARKET_CLOSED_TEXT}`,
      tone: "info",
      refresh: false,
    });
    expect(plaidSyncMessage({ skippedReason: "after_open", connectionChecked: true }).text).toBe(
      `Connection confirmed. ${PLAID_AFTER_OPEN_TEXT}`,
    );
    // No prefix without the check.
    expect(plaidSyncMessage({ skippedReason: "market_closed", connectionChecked: false }).text).toBe(
      PLAID_MARKET_CLOSED_TEXT,
    );
  });

  it("the re-auth page's line reads Re-authenticated. Connection confirmed. Nothing stored: ...", () => {
    const outcome = plaidSyncMessage({ skippedReason: "before_window", connectionChecked: true });
    expect(joinSentences("Re-authenticated.", outcome.text)).toBe(
      `Re-authenticated. Connection confirmed. ${PLAID_BEFORE_WINDOW_TEXT}`,
    );
  });

  it("an answer without a result is information", () => {
    expect(plaidSyncMessage(null)).toEqual({ text: PLAID_NO_RESULT_TEXT, tone: "info", refresh: false });
    expect(plaidSyncMessage(undefined).tone).toBe("info");
  });
});

describe("a stored read", () => {
  it("full success names the session and every stored account, and refreshes the page", () => {
    expect(
      plaidSyncMessage({ skippedReason: null, session: S, storedAccounts: [A, B], skippedAccounts: [] }),
    ).toEqual({
      text: `Vanguard figures for the ${S} close stored for Synthetic A and Synthetic B.`,
      tone: "success",
      refresh: true,
    });
  });

  it("partial success adds one sentence per account not stored", () => {
    const m = plaidSyncMessage({
      skippedReason: null,
      session: S,
      storedAccounts: [A],
      skippedAccounts: [
        { accountName: "Synthetic B", reason: "missing_in_response" },
        { accountName: "Synthetic C", reason: "statement_on_session" },
        { accountName: "Synthetic D", reason: "legacy_rows_after_session" },
        { accountName: "Synthetic E", reason: "no_positions" },
      ],
    });
    expect(m).toEqual({
      text: [
        `Vanguard figures for the ${S} close stored for Synthetic A.`,
        "Synthetic B: missing from Plaid's answer.",
        `Synthetic C: a statement already covers ${S}.`,
        "Synthetic D: older rows still need the repair.",
        "Synthetic E: no positions in Plaid's answer.",
      ].join(" "),
      tone: "success",
      refresh: true,
    });
  });

  it("zero stored is information, never success, and does not refresh", () => {
    const m = plaidSyncMessage({
      skippedReason: null,
      session: S,
      storedAccounts: [],
      skippedAccounts: [{ accountName: "Synthetic A", reason: "statement_on_session" }],
    });
    expect(m.tone).toBe("info");
    expect(m.refresh).toBe(false);
    expect(m.text).toBe(
      `No Vanguard account was stored for the ${S} close. Synthetic A: a statement already covers ${S}.`,
    );
    expect(m.text).not.toContain("stored for Synthetic");
  });

  it("a failed valuation recompute adds the A8 sentence", () => {
    const m = plaidSyncMessage({
      skippedReason: null,
      session: S,
      storedAccounts: [A],
      skippedAccounts: [],
      valuationsRecomputed: false,
    });
    expect(m.text).toBe(
      `Vanguard figures for the ${S} close stored for Synthetic A. Positions stored; values not yet updated (they update at the next sync).`,
    );
    expect(PLAID_VALUES_NOT_UPDATED_TEXT).toBe(
      "Positions stored; values not yet updated (they update at the next sync).",
    );
    expect(m.refresh).toBe(true);
  });

  it("an account with no name falls back to its id", () => {
    const m = plaidSyncMessage({
      skippedReason: null,
      session: S,
      storedAccounts: [A],
      skippedAccounts: [{ accountId: 7, reason: "no_positions" }],
    });
    expect(m.text).toContain("Account 7: no positions in Plaid's answer.");
  });
});

describe("small helpers", () => {
  it("joinNames", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });

  it("the new-securities sentence (Settings panel)", () => {
    expect(plaidNewSecuritiesSentence([])).toBe("");
    expect(plaidNewSecuritiesSentence(["FAKE1", "FAKE2"])).toBe(
      "New securities created: FAKE1, FAKE2 — verify these aren't duplicates of existing holdings.",
    );
  });

  it("failure text carries the server's own reason", () => {
    expect(plaidSyncFailureText("Plaid is not connected")).toBe("Vanguard sync failed: Plaid is not connected");
  });
});

describe("PlaidSyncButton takes its words only from the helper", () => {
  const src = readFileSync("app/dashboard/components/PlaidSyncButton.tsx", "utf8");
  const handler = src.slice(anchorIndex(src, "async function handleClick()"), anchorIndex(src, "return ("));

  it("reads the answer through readMutationResult and the helper", () => {
    expect(handler).toContain("readMutationResult<PlaidSyncResponse>(res)");
    expect(handler).toContain("plaidSyncMessage(result.data.data)");
    expect(handler).toContain("toast(message.text, message.tone)");
    expect(handler).toContain("toast(plaidSyncFailureText(result.message), \"error\")");
    expect(handler).toContain("networkFailureMessage(PLAID_SYNC_ACTION)");
  });

  it("writes no sentence of its own in the handler", () => {
    // Every toast argument is a helper call: no string or template literal.
    for (const m of handler.matchAll(/toast\(([^,]+),/g)) {
      expect(m[1]).not.toMatch(/["'`]/);
    }
    expect(src).not.toContain("Vanguard synced");
    expect(src).not.toContain("holdings updated");
  });

  it("refreshes the page only when the helper says an account was stored", () => {
    expect(handler).toContain("if (message.refresh) router.refresh();");
    expect(handler.match(/router\.refresh\(\)/g)).toHaveLength(1);
  });
});

describe("the Settings panel (PlaidSection) words the sync through the helper", () => {
  const src = readFileSync("app/dashboard/components/PlaidSection.tsx", "utf8");
  const handler = src.slice(
    anchorIndex(src, "async function handleSync()"),
    anchorIndex(src, "if (!payload && !loadError)"),
  );

  it("reads { success, data } through readMutationResult and the helper", () => {
    expect(handler).toContain("readMutationResult<SyncResponse>(res)");
    expect(handler).toContain("const data = result.data.data ?? null;");
    expect(handler).toContain("const outcome = plaidSyncMessage(data);");
    expect(handler).toContain("kind: outcome.tone");
    expect(handler).toContain("plaidSyncFailureText(result.message)");
  });

  it("writes no outcome sentence of its own and shows no holding count", () => {
    expect(handler).not.toMatch(/message:\s*`/);
    expect(handler).not.toMatch(/message:\s*"/);
    expect(src).not.toContain("holdingsWritten");
    expect(src).not.toContain("accountsSynced");
  });

  it("re-reads the settings only when an account was stored", () => {
    expect(handler).toContain("if (outcome.refresh) void refreshAfterWrite();");
    expect(handler.match(/refreshAfterWrite\(\)/g)).toHaveLength(1);
  });

  it("an info outcome renders in neutral ink, not the success colour", () => {
    const block = src.slice(anchorIndex(src, "{syncStatus && ("));
    expect(block).toContain('syncStatus.kind === "success"');
    expect(block).toContain('"text-ink-dim"');
  });
});

describe("the re-auth page words its sync through the helper", () => {
  const src = readFileSync("app/dashboard/plaid-link/page.tsx", "utf8");
  const reauth = src.slice(
    anchorIndex(src, "async function reauthSuccessAndSync()"),
    anchorIndex(src, "function handleExit("),
  );

  it("reads { success, data } and takes the outcome sentence from plaidSyncMessage", () => {
    expect(reauth).toContain("readMutationResult<{ data?: PlaidSyncAnswer | null }>(res)");
    expect(reauth).toContain("const outcome = plaidSyncMessage(result.data.data);");
    expect(reauth).toContain('joinSentences("Re-authenticated.", outcome.text)');
    expect(src).not.toContain("holdingsWritten");
    expect(src).not.toContain("holdings updated");
  });

  it("is a success only when an account was stored; otherwise neutral information", () => {
    expect(reauth).toContain('kind: outcome.refresh ? "success" : "info"');
    const block = src.slice(anchorIndex(src, '{state.kind === "info" && ('));
    expect(block.slice(0, block.indexOf(")}"))).toContain("text-ink-dim");
  });
});
