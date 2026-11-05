/**
 * "Send preview now" (owner request 2026-11-04): a manual send control beside
 * the preview chip's skip control in the Earnings Hub.
 *
 * Source-scan, not a render test: this repo has no jsdom/RTL harness (same
 * reasoning as earnings-row-chips-pre-print-toast.test.ts). The endpoint itself
 * is covered by the earnings email route tests; this pins the UI wiring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/today/EarningsRowChips.tsx", "utf8");
const fn = src.slice(anchorIndex(src, "async function sendPreviewNow()"));
const handler = fn.slice(0, anchorIndex(fn, "if (skipped) {"));

describe("send preview now — request shape", () => {
  it("POSTs the existing endpoint with eventId and phase preview, and nothing else", () => {
    expect(handler).toContain('apiFetch("/api/earnings/email"');
    expect(handler).toContain('method: "POST"');
    expect(handler).toContain('JSON.stringify({ eventId, phase: "preview" })');
  });

  it("adds no candidate-window or readiness check in the UI", () => {
    expect(handler).not.toMatch(/previewWindow|isLateArmPreviewInWindow|slotFloor/);
  });
});

describe("send preview now — states", () => {
  const pendingBranch = src.slice(src.lastIndexOf("<span className=\"inline-flex items-center gap-0.5\">"));

  it("renders only in the pending branch: after sent, skipped and missed have returned", () => {
    const sent = anchorIndex(src, "if (sent) {");
    const skippedBranch = anchorIndex(src, "if (skipped) {");
    const missedBranch = anchorIndex(src, "if (missed) {");
    const control = anchorIndex(src, 'aria-label="Send preview email now"');
    expect(sent).toBeLessThan(skippedBranch);
    expect(skippedBranch).toBeLessThan(missedBranch);
    expect(missedBranch).toBeLessThan(control);
  });

  it("is a preview-only control", () => {
    expect(pendingBranch).toMatch(/phase === "preview" && \(\s*<button/);
    expect(pendingBranch).toContain("onClick={sendPreviewNow}");
  });

  it("shows progress and cannot be double-fired", () => {
    expect(handler).toContain("if (sendingRef.current) return;");
    expect(handler).toContain("sendingRef.current = true;");
    expect(handler).toMatch(/finally \{\s*sendingRef\.current = false;\s*setSending\(false\);/);
    expect(pendingBranch).toContain("disabled={sending}");
    expect(pendingBranch).toContain('{sending ? "sending…" : "send now"}');
  });
});

describe("send preview now — outcomes", () => {
  it("shows the endpoint's own refusal reason in an error toast", () => {
    expect(handler).toContain("readMutationResult");
    expect(handler).toMatch(/if \(!r\.ok\) \{\s*toast\(r\.message, "error"\);\s*return;/);
  });

  it("names a network failure in plain words", () => {
    expect(handler).toContain('networkFailureMessage("send the preview")');
  });

  it("on success refreshes the server row and the cockpit poller without a reload", () => {
    const ok = handler.slice(anchorIndex(handler, "if (!r.ok)"));
    expect(ok).toContain('new Event("earnings-data-changed")');
    expect(ok).toContain("router.refresh()");
  });
});

describe("send preview now — scope", () => {
  it("adds no recap twin (follow-up, owner asked for preview only)", () => {
    expect(src).not.toContain("sendRecapNow");
  });
});
