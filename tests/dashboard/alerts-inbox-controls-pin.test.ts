/**
 * Alerts inbox (app/dashboard/alerts/page.tsx): source pins for one batch of
 * QA findings. There is no DOM test harness in this repo, so behaviour that
 * lives in JSX is pinned by reading the source; the pure pieces are imported
 * and run.
 *
 *  - alerts-inbox--auto-fires-suggest-on-every-page-load-regression-2
 *  - alerts-ai-suggestion--silent-failure-no-marker-no-retry-on-server-config-error
 *  - alerts-ignored--irreversible-no-undo-regression-2
 *  - alerts-archive-tabs--response-irreversible-no-controls-regression-1
 *  - alerts-review--move-needed-chip-blind-to-trigger-direction-approve-409
 *  - alerts-acted-note--enter-does-nothing-only-log-button-submits
 *  - alerts-conflicts--empty-state-claims-all-agree-hides-conflict-outside-14-day-window
 *  - alerts-tabs--emails-badge-lazy-no-count-until-visited
 *  - mobile-alerts--acted-note-form-cancel-37x16-no-touch-extension
 *  - mobile-alerts--scan-banner-dismiss-7px-no-touch-extension
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { alertsAfterRestore } from "@/app/dashboard/alerts/page";

function read(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
}

const src = read("app/dashboard/alerts/page.tsx");

/** The source of every `useEffect(...)` call in the file, parens balanced. */
function useEffectBlocks(source: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("useEffect(", from);
    if (start === -1) break;
    let depth = 0;
    let end = start + "useEffect".length;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    blocks.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return blocks;
}

/** A function declared in the page, from its header to the next sibling. */
function fnBody(header: string, nextHeader: string): string {
  return sliceBetween(src, header, nextHeader);
}

const TOUCH_EXTENSION =
  "pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5";

describe("no AI suggestion is requested on page load", () => {
  const SUGGEST_URL = '"/api/alerts/suggest"';

  it("the suggest endpoint is called from exactly two functions", () => {
    expect(src.split(SUGGEST_URL).length - 1).toBe(2);
    expect(fnBody("async function runSuggest(", "async function suggestOne(")).toContain(
      SUGGEST_URL,
    );
    expect(
      fnBody("async function suggestOne(", "// Build the stream of items"),
    ).toContain(SUGGEST_URL);
  });

  it("no effect calls either of them, or the endpoint", () => {
    const effects = useEffectBlocks(src);
    // The page has effects (refresh on mount, lazy email rows); an empty list
    // would make this test pass without checking anything.
    expect(effects.length).toBeGreaterThanOrEqual(2);
    for (const block of effects) {
      expect(block).not.toMatch(/runSuggest|suggestOne|onSuggest|alerts\/suggest/);
    }
  });

  it("refresh, which runs on every load, does not call them either", () => {
    const refresh = fnBody("const refresh = useCallback(", "useEffect(() => {");
    expect(refresh).not.toMatch(/runSuggest|suggestOne|alerts\/suggest/);
  });

  it("every reference to the two functions is a click handler or a prop handed to a row", () => {
    const uses = [...src.matchAll(/^.*\b(runSuggest|suggestOne)\b.*$/gm)]
      .map((m) => m[0].trim())
      .filter((line) => !line.startsWith("//") && !line.startsWith("async function"));
    expect(uses.sort()).toEqual(
      [
        "onClick={() => runSuggest()}",
        "onSuggest={suggestOne}",
        "onSuggest={suggestOne}",
      ].sort(),
    );
    // The row's own use of the prop is a click handler too.
    const ask = fnBody("async function askSuggestion()", "const when = new Date(");
    expect(ask).toContain("await onSuggest(alert.id)");
    expect(src.split("askSuggestion").length - 1).toBe(2);
    expect(src).toContain("onClick={askSuggestion}");
  });

  it("the silent auto-fill path is gone", () => {
    expect(src).not.toMatch(/silent\s*[?:]|opts\?\.silent/);
    expect(src).not.toContain("needsSuggestion");
  });
});

describe("a row with no stored suggestion offers one, and says why a request failed", () => {
  it("the control shows only when no suggestion is stored, on pending and ignored alerts", () => {
    const start = anchorIndex(src, "const canAskSuggestion =");
    const rule = src.slice(start, anchorIndex(src, ";", start));
    expect(rule).toContain("!alert.suggested_action");
    expect(rule).toContain("isPending");
    expect(rule).toContain('alert.user_response === "ignored"');
  });

  it("a failure is shown on the row with a Retry label", () => {
    const start = anchorIndex(src, "{canAskSuggestion && (");
    const block = src.slice(start, anchorIndex(src, "{alert.user_response_note && (", start));
    expect(block).toContain("Suggestion unavailable.");
    expect(block).toContain('"Retry"');
    expect(block).toContain('"Get suggestion"');
    expect(block).toContain("disabled={suggestBusy}");
  });

  it("the request reads its result through readMutationResult", () => {
    const body = fnBody("async function suggestOne(", "// Build the stream of items");
    expect(body).toContain("readMutationResult(res)");
    expect(body).toContain("networkFailureMessage(");
    expect(body).not.toMatch(/res\.ok/);
  });
});

describe("Restore to pending on archived alerts", () => {
  const rows = [
    { id: 1, user_response: "ignored" as const, note: "a" },
    { id: 2, user_response: "ignored" as const, note: "b" },
  ];

  it("on an archive tab the restored row leaves the list at once", () => {
    for (const filter of ["acted", "ignored", "dismissed"] as const) {
      expect(alertsAfterRestore(rows, 1, filter)).toEqual([rows[1]]);
    }
  });

  it("on the All tab the row stays and reads pending", () => {
    expect(alertsAfterRestore(rows, 1, "all")).toEqual([
      { id: 1, user_response: "pending", note: "a" },
      rows[1],
    ]);
  });

  it("never mutates the list it was given, so the caller can put it back", () => {
    const before = JSON.stringify(rows);
    alertsAfterRestore(rows, 1, "ignored");
    alertsAfterRestore(rows, 1, "all");
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("the handler reads the result through readMutationResult and reverts on both failure paths", () => {
    const body = fnBody("async function restoreToPending(", "function clearForceConfirm(");
    expect(body).toContain("const before = alerts;");
    expect(body).toContain("setAlerts((prev) => alertsAfterRestore(prev, id, filter))");
    expect(body).toContain("readMutationResult(res)");
    expect(body).not.toMatch(/res\.ok/);
    // One revert closure, used by the network failure and the server refusal.
    const failed = body.slice(
      anchorIndex(body, "const failed = "),
      anchorIndex(body, "let res: Response;"),
    );
    expect(failed).toContain("setAlerts(before)");
    expect(failed).toContain('"error"');
    expect(body).toContain('failed(networkFailureMessage("restore that alert"))');
    expect(body).toContain("failed(result.message)");
    // The success toast comes only after the result check.
    expect(anchorIndex(body, "Alert restored to pending")).toBeGreaterThan(
      anchorIndex(body, "if (!result.ok)"),
    );
    expect(body).toContain('response: "pending"');
  });

  it("every non-pending alert row renders the control", () => {
    const start = anchorIndex(src, "{responseLabel[alert.user_response].label}");
    const tail = src.slice(start, start + 900);
    expect(tail).toContain("onClick={() => onRestore(alert.id)}");
    expect(tail).toContain("Restore to pending");
  });

  it("the kept note shows on the restored row and seeds the Acted form", () => {
    expect(src).toContain("{alert.user_response_note && (");
    expect(src).not.toContain("{!isPending && alert.user_response_note && (");
    expect(src).toContain('const keptNote = alert.user_response_note ?? "";');
    expect(src).toContain("useState(keptNote)");
  });
});

describe("the move-needed chip reads the direction-aware helper", () => {
  it("the Review row takes pct and alreadyMet from moveNeededView", () => {
    const row = src.slice(anchorIndex(src, "function ReviewRow("));
    expect(row).toContain("moveNeededView(");
    expect(row).not.toContain("moveNeededPct(");
    expect(row).toContain("{CONDITION_ALREADY_MET_LABEL}");
    // The percentage is the fallback branch, never rendered beside the label.
    const chip = row.slice(
      anchorIndex(row, "{alreadyMet ? ("),
      anchorIndex(row, "{distVal !== null && ("),
    );
    expect(anchorIndex(chip, "CONDITION_ALREADY_MET_LABEL")).toBeLessThan(
      anchorIndex(chip, "move needed"),
    );
  });

  it("the page never re-types the direction rule", () => {
    expect(src).not.toMatch(/goingDown/);
    expect(src).not.toMatch(/\[\s*"support"\s*,\s*"entry"/);
  });

  it("the Armed row claims 'already past' only for a row the scanner evaluates", () => {
    const row = fnBody("function ArmedLevelRow(", "function SplitPendingStream(");
    const rule = row.slice(
      anchorIndex(row, "const alreadyMet ="),
      anchorIndex(row, "return ("),
    );
    expect(rule).toContain("!beyondScanRange");
    expect(rule).toContain("!stalePrice");
    expect(rule).toContain("isLevelConditionMet(");
  });
});

describe("the Acted note form", () => {
  const form = src.slice(anchorIndex(src, "{noteOpen && isPending && ("));

  it("Enter runs the same handler as Log, and Escape the same handler as Cancel", () => {
    const keys = form.slice(
      anchorIndex(form, "onKeyDown={(e) => {"),
      anchorIndex(form, "autoFocus"),
    );
    expect(keys).toMatch(/e\.key === "Enter"[\s\S]*submitNote\(\)/);
    expect(keys).toMatch(/e\.key === "Escape"[\s\S]*cancelNote\(\)/);
    expect(keys).toContain("isComposing");
    expect(form).toContain("onClick={submitNote}");
    expect(form).toContain("onClick={cancelNote}");
  });

  it("Cancel carries the touch extension its sibling dismiss button has", () => {
    const start = anchorIndex(form, "onClick={cancelNote}");
    const button = form.slice(start, anchorIndex(form, "Cancel", start));
    expect(button).toContain("relative");
    expect(button).toContain(TOUCH_EXTENSION);
  });
});

describe("small disclosures", () => {
  it("the scan-result banner's dismiss button carries the touch extension", () => {
    const end = anchorIndex(src, 'aria-label="Dismiss status"');
    const start = src.lastIndexOf("<button", end);
    const button = src.slice(start, end);
    expect(button).toContain("relative");
    expect(button).toContain(TOUCH_EXTENSION);
  });

  it("the Conflicts empty state names the window the conflicts query really uses", () => {
    // The window lives in lib/queries/calendar.ts. If it changes, this copy
    // must change with it, so both are read here.
    const query = read("lib/queries/calendar.ts");
    const fn = query.slice(anchorIndex(query, "export function getEarningsDateConflicts("));
    expect(fn.slice(0, 600)).toContain("addDays(today, 14)");

    const empty = src.slice(
      anchorIndex(src, 'if (filter === "conflicts") {'),
      anchorIndex(src, 'const label = filter === "all"'),
    );
    expect(empty).toContain("No date conflicts in the next 14 days.");
    expect(empty).not.toContain("Every upcoming earnings date agrees");
  });

  it("the Emails badge count is fetched on every refresh; the rows stay lazy", () => {
    const refresh = fnBody("const refresh = useCallback(", "useEffect(() => {");
    expect(refresh).toContain('fetch("/api/earnings/emails?countOnly=true")');
    expect(refresh).toContain("setEmailCount(");
    expect(refresh).not.toContain("setSentEmails(");
    // Once the rows are loaded the badge counts the rows themselves.
    const badge = src.slice(
      anchorIndex(src, 'opt.value === "emails"'),
      anchorIndex(src, "return (", anchorIndex(src, 'opt.value === "emails"')),
    );
    expect(badge).toMatch(/emailsLoaded\s*\?\s*sentEmails\.length\s*:\s*emailCount/);
  });
});
