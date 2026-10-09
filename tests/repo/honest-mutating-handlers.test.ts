import { describe, it, expect } from "vitest";
import {
  bareMutatingSites,
  clientSourceFiles,
  countByFile,
  emptyCatches,
  rawExceptionText,
  type ScanHit,
} from "../helpers/mutating-handler-scan";

/**
 * Repo-wide guard for honest mutating handlers. The older pin
 * (tests/dashboard/honest-mutating-handlers-pin.test.ts) names the files
 * converted on 2026-10-05; this one scans every client file under app/, so a
 * NEW bare gate, empty catch or printed exception fails without anyone having
 * to add the file to a list.
 *
 * Each allowlist is a count per file. A count that goes UP is a new hit: fix
 * it, or add it here with the reason. A count that goes DOWN means a site was
 * fixed: lower the number so the fix cannot quietly regress.
 */

/**
 * Mutating requests whose reply is not read through `readMutationResult`.
 * Reasons, by group:
 *  - "own reader": the handler checks `res.ok` AND the body's `success`, and
 *    names the failure itself, because it also branches on a status the shared
 *    helper does not carry (a 409 code, a challenge, a restore of the list).
 *  - "no envelope": the route answers without `success: true` (a payload or
 *    `{ ok: true }`), so the shared helper would read every success as a
 *    failure. Converting these needs a server change.
 *  - "flow": the request is handed to a shared flow that reads the reply.
 *  - "stream": the reply is a stream read phase by phase.
 */
const BARE_SITE_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "app/dashboard/alerts/page.tsx": {
    count: 3,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; restore, approve and re-arm also put the list back and branch on a 409",
  },
  "app/dashboard/components/ChatInterface.tsx": {
    count: 1,
    reason:
      "protected file (chat integration is not to be edited); its delete checks res.ok and has a catch",
  },
  "app/dashboard/components/DataConfidenceIndicator.tsx": {
    count: 1,
    reason:
      "no envelope: the fix endpoint comes from the data, and those routes do not share one reply shape; res.ok is the gate and both failure lines exist",
  },
  "app/dashboard/components/DigestCatchup.tsx": {
    count: 1,
    reason:
      "no envelope: the status poll answers with the status object; a failed poll leaves the banner as it was (said in the catch)",
  },
  "app/dashboard/components/DigestEmailViewer.tsx": {
    count: 1,
    reason:
      "no envelope: the preview POST answers with the preview itself; res.ok is the gate and a failure keeps the other views with a retry",
  },
  "app/dashboard/components/EarningsEmailsSection.tsx": {
    count: 1,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself (listed in the 2026-10-05 pin as a user of networkFailureMessage)",
  },
  "app/dashboard/components/EmailRecipientsSection.tsx": {
    count: 2,
    reason:
      "no envelope: the route answers { ok: true }; res.ok is the gate. Each field shows only 'Save failed', with no reason: needs a design decision",
  },
  "app/dashboard/components/ImportHistory.tsx": {
    count: 1,
    reason:
      "own reader: the first DELETE is the undo challenge (a 409 with a token), read by hand; the confirmed DELETE below it uses readMutationResult",
  },
  "app/dashboard/components/LevelsPanel.tsx": {
    count: 1,
    reason:
      "no envelope: the narratives POST answers with the levels; res.ok is the gate and a failure sets the commentary-unavailable note",
  },
  "app/dashboard/components/ManageSourcesModal.tsx": {
    count: 2,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself",
  },
  "app/dashboard/components/NotesAmbient.tsx": {
    count: 1,
    reason:
      "own reader: the notes copy (describeNoteSaveFailure), pinned by the 2026-10-05 test",
  },
  "app/dashboard/components/NotesView.tsx": {
    count: 3,
    reason:
      "own reader: the notes copy (describeNoteSaveFailure) for save, edit and delete",
  },
  "app/dashboard/components/PinUnlock.tsx": {
    count: 1,
    reason:
      "own reader: also branches on 423 lock-out and the attempts-remaining count",
  },
  "app/dashboard/components/ResearchDocumentsView.tsx": {
    count: 3,
    reason:
      "no envelope on upload and delete (payload / { ok: true }); res.ok is the gate, with a failure line and a network line. The tag PATCH has its own reader",
  },
  "app/dashboard/components/ResearchFeedsView.tsx": {
    count: 1,
    reason:
      "stream: the sync reply is read phase by phase",
  },
  "app/dashboard/components/SecurityChart.tsx": {
    count: 1,
    reason:
      "no envelope: a POST that LOADS chart bars and answers with them; res.ok is the gate",
  },
  "app/dashboard/components/SecuritySection.tsx": {
    count: 1,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; also words the 401 case",
  },
  "app/dashboard/components/SettingsModal.tsx": {
    count: 1,
    reason:
      "no envelope: the settings route answers with the settings object (said in the code); res.ok is the gate",
  },
  "app/dashboard/components/TradeReviewView.tsx": {
    count: 1,
    reason:
      "stream: the review reply is read phase by phase",
  },
  "app/dashboard/components/analysis/MacroOverlayCard.tsx": {
    count: 1,
    reason:
      "own reader: describeRefreshFailure words the rate limit and cooldown by status",
  },
  "app/dashboard/components/analysis/NarrativeBlock.tsx": {
    count: 1,
    reason:
      "own reader: describeRefreshFailure words the rate limit and cooldown by status",
  },
  "app/dashboard/components/giving/GivingYearSection.tsx": {
    count: 3,
    reason:
      "flow: the request is handed to the ledger-recompute flow (ledger-recompute-flow.ts), which reads the reply and the 409 acknowledgement",
  },
  "app/dashboard/components/giving/LotAssignmentDrawer.tsx": {
    count: 1,
    reason:
      "flow: handed to the ledger-recompute flow, which reads the reply and the 409 acknowledgement",
  },
  "app/dashboard/components/giving/ReconciliationStrip.tsx": {
    count: 1,
    reason:
      "flow: handed to the ledger-recompute flow, which reads the reply and the 409 acknowledgement",
  },
  "app/dashboard/today/BogeysEditModal.tsx": {
    count: 5,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; the saves also branch on 409 codes (pre_print) and on the recompile report",
  },
  "app/dashboard/today/CallNoteModal.tsx": {
    count: 1,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; the modal stays open with the text intact",
  },
  "app/dashboard/today/EarningsDateChip.tsx": {
    count: 1,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; also branches on the 409 ask-first replies",
  },
  "app/dashboard/today/EarningsHubAddForm.tsx": {
    count: 1,
    reason:
      "own reader: branches on two 409 codes (slot_contradicts_known_time, would_supersede_vendor) before the plain failure",
  },
  "app/dashboard/today/EarningsHubLive.tsx": {
    count: 2,
    reason:
      "background polls (ensure, cockpit refresh): each checks res.ok and success; a failure goes to the console or keeps the last good payload by design, said in the code",
  },
  "app/dashboard/today/EarningsRowChips.tsx": {
    count: 5,
    reason:
      "own readers for arm and recap (res.ok and success, 409 branches, a stream); the best-effort ensure is commented; skip / un-skip has no envelope ({ ok: true }) and gates on res.ok with both failure lines",
  },
  "app/dashboard/today/LivePrintRow.tsx": {
    count: 2,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; accept also branches on the 409 pre_print ask",
  },
  "app/dashboard/today/live-print/GoControls.tsx": {
    count: 2,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; the success path reads the wake warning",
  },
  "app/dashboard/today/live-print/IrPageField.tsx": {
    count: 1,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself",
  },
  "app/dashboard/today/live-print/PrintOutputs.tsx": {
    count: 2,
    reason:
      "own reader: checks res.ok and the body's success, names the failure and the network case itself; a 409 from the print gate is shown in the server's own words",
  },
  "app/login/page.tsx": {
    count: 1,
    reason:
      "bootstrap: no session yet; the page reads the status (200 / 401 / 429) and never shows raw text",
  },
};

/** Empty catches. */
const EMPTY_CATCH_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "app/dashboard/today/hub-live/poll-controller.ts": {
    count: 1,
    reason:
      "fireSettled: a failed run is already routed to the stream's onError; the catch only stops a stream bug from becoming an unhandled rejection (said above it)",
  },
};

/** A caught exception printed as-is. */
const RAW_EXCEPTION_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "app/dashboard/components/DigestEmailViewer.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/components/EarningsEmailViewer.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/components/PerformanceView.tsx": {
    count: 1,
    reason:
      "server-side compute error shown on the page, not a fetch; wording needs a pass",
  },
  "app/dashboard/components/ResearchMentionsSection.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/components/SecurityChart.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass (the chart POST is a load)",
  },
  "app/dashboard/components/SettingsModal.tsx": {
    count: 1,
    reason:
      "prints sentences the settings source throws itself (dev-mode notice, HTTP status); a lost connection would print the browser's text",
  },
  "app/dashboard/components/TaxReportCard.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/components/analysis/CashDeployCard.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/components/analysis/DrillDownPanel.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/components/analysis/NarrativeBlock.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/components/giving/LotAssignmentDrawer.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/plaid-link/page.tsx": {
    count: 1,
    reason:
      "prints sentences this page throws itself (script not initialised, stored Link session missing) or the Plaid widget's error; the request has its own catch",
  },
  "app/dashboard/security/[id]/FactorProfileSection.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
  "app/dashboard/today/EarningsHubLive.tsx": {
    count: 1,
    reason:
      "status poll: prints the reason the poll threw; wording needs a pass",
  },
  "app/dashboard/today/EarningsRowChips.tsx": {
    count: 1,
    reason:
      "recap generation: the catch prints the server's own refusal, thrown a few lines above; the stream path is pinned by the recap-modal tests",
  },
  "app/dashboard/today/live-print/GoControls.tsx": {
    count: 1,
    reason:
      "reading a dropped FILE, not a request: the browser's file error is the only detail there is",
  },
  "app/dashboard/today/live-print/IrPageField.tsx": {
    count: 1,
    reason:
      "load path: the catch prints what the loader threw (a status line it built, or the browser's text on a lost connection); wording needs a pass",
  },
};

const files = clientSourceFiles();

function describeHits(hits: ScanHit[]): string {
  return hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n");
}

function compare(
  hits: ScanHit[],
  allowlist: Record<string, { count: number; reason: string }>,
): { over: string[]; under: string[] } {
  const counts = countByFile(hits);
  const over: string[] = [];
  const under: string[] = [];
  for (const file of new Set([...Object.keys(counts), ...Object.keys(allowlist)])) {
    const found = counts[file] ?? 0;
    const allowed = allowlist[file]?.count ?? 0;
    const where = describeHits(hits.filter((h) => h.file === file));
    if (found > allowed) over.push(`${file}: ${found} found, ${allowed} allowed\n${where}`);
    if (found < allowed) under.push(`${file}: ${found} found, ${allowed} allowed`);
  }
  return { over, under };
}

describe("honest mutating handlers, every client file under app/", () => {
  it("scans a real set of files", () => {
    expect(files.length).toBeGreaterThan(100);
    // The scan must be able to see a site at all: this file is a known user
    // of the shared helper with a mutating request.
    const known = files.find((f) => f.file === "app/dashboard/today/EarningsDeleteButton.tsx");
    expect(known).toBeDefined();
    expect(known!.source).toMatch(/method: "DELETE"/);
    expect(bareMutatingSites(known!.file, known!.source)).toEqual([]);
  });

  it("the scanner flags a bare gate, an empty catch and a printed exception", () => {
    const bare = [
      "async function save() {",
      '  const res = await apiFetch("/api/x", {',
      '    method: "POST",',
      "  });",
      "  if (res.ok) done();",
      "}",
    ].join("\n");
    expect(bareMutatingSites("x.tsx", bare)).toHaveLength(1);
    const honest = bare.replace("if (res.ok) done();", "const r = await readMutationResult(res);");
    expect(bareMutatingSites("x.tsx", honest)).toEqual([]);

    // The reader of an EARLIER request does not cover a later one.
    const two = `${honest}\n${"\n".repeat(10)}${bare}`;
    expect(bareMutatingSites("x.tsx", two).map((h) => h.line)).toEqual([19]);

    // Both arms of one ternary share the reader below them.
    const ternary = [
      "const res = undo",
      '  ? await apiFetch("/api/x?id=1", { method: "DELETE" })',
      '  : await apiFetch("/api/x", {',
      '      method: "POST",',
      "    });",
      "const r = await readMutationResult(res);",
    ].join("\n");
    expect(bareMutatingSites("x.tsx", ternary)).toEqual([]);

    expect(emptyCatches("x.tsx", "try { go(); } catch {}")).toHaveLength(1);
    expect(emptyCatches("x.tsx", "try { go(); } catch { /* ignore */ }")).toHaveLength(1);
    expect(emptyCatches("x.tsx", "fetch(u).catch(() => {});")).toHaveLength(1);
    expect(emptyCatches("x.tsx", "fetch(u).catch(() => undefined);")).toHaveLength(1);
    expect(emptyCatches("x.tsx", "try { go(); } catch { /* chart already disposed */ }")).toEqual([]);
    expect(emptyCatches("x.tsx", "const body = await res.json().catch(() => null);")).toEqual([]);

    expect(
      rawExceptionText("x.tsx", 'setError(err instanceof Error ? err.message : "Failed");'),
    ).toHaveLength(1);
    expect(
      rawExceptionText("x.tsx", "setError(err instanceof Error ? `Save failed: ${err.message}` : x);"),
    ).toHaveLength(1);
    expect(rawExceptionText("x.tsx", 'setError(networkFailureMessage("save"));')).toEqual([]);
  });

  it("no new mutating request skips the shared result reader", () => {
    const hits = files.flatMap((f) => bareMutatingSites(f.file, f.source));
    const { over, under } = compare(hits, BARE_SITE_ALLOWLIST);
    expect(over, "new bare mutating request(s): read the reply through readMutationResult").toEqual([]);
    expect(under, "a listed site was fixed: lower its count in BARE_SITE_ALLOWLIST").toEqual([]);
  });

  it("no request is wrapped in an empty catch", () => {
    const hits = files.flatMap((f) => emptyCatches(f.file, f.source));
    const { over, under } = compare(hits, EMPTY_CATCH_ALLOWLIST);
    expect(over, "empty catch: show a failure line, or say in a comment why nothing is shown").toEqual([]);
    expect(under, "a listed catch was fixed: lower its count in EMPTY_CATCH_ALLOWLIST").toEqual([]);
  });

  it("no new handler prints a caught exception as-is", () => {
    const hits = files.flatMap((f) => rawExceptionText(f.file, f.source));
    const { over, under } = compare(hits, RAW_EXCEPTION_ALLOWLIST);
    expect(over, "raw exception text: use networkFailureMessage or plain wording").toEqual([]);
    expect(under, "a listed site was fixed: lower its count in RAW_EXCEPTION_ALLOWLIST").toEqual([]);
  });

  it("every allowlist entry carries a reason", () => {
    for (const list of [BARE_SITE_ALLOWLIST, EMPTY_CATCH_ALLOWLIST, RAW_EXCEPTION_ALLOWLIST]) {
      for (const [file, entry] of Object.entries(list)) {
        expect(entry.reason.trim().length, file).toBeGreaterThan(20);
        expect(entry.count, file).toBeGreaterThan(0);
      }
    }
  });
});
