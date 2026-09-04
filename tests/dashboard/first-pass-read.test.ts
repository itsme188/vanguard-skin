import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FirstPassRead, { readStatusLabel, verdictGlyph, calloutStateLabel, factRow, type FirstPassReadDto, type ActiveReadDto, type LastAttemptDto } from "@/app/dashboard/today/FirstPassRead";
import type { CalloutView, ReadFact } from "@/lib/print-watch/first-pass-types";
import { PrivacyProvider } from "@/lib/privacy/context";

const fact = (o: Partial<ReadFact> = {}): ReadFact => ({ metric_id: "revenue_q", label: "Revenue", state: "accepted", unit: "usd", period: "Q", kind: "point", actual: 898.2e6, actual_high: null, expected_consensus: 877.3e6, expected_whisper: null, expected_source: "VK", expected_consensus_vendor: null, expected_basis: "specified", delta_pct: 2.38, verdict: "beat", ...o });
const callout = (o: Partial<CalloutView> = {}): CalloutView => ({ id: 1, print_id: 1, read_id: 1, label: "ARR", label_norm: "arr", value: 3.74e9, value_high: null, unit: "usd", value_text: "$3.74B", snippet: "ARR reached $3.74 billion", doc_id: 1, doc_sha256: "d", evidence_sha256: "e", verifier_version: 1, vs_bogey_text: "no bogey on file", state: "proposed", accepted_at: null, revoked_at: null, superseded_by_read_id: null, created_at: "2026-09-10T20:07:00.000Z", updated_at: "2026-09-10T20:07:00.000Z", effective_state: "proposed", doc_kind: "user-drop", ...o });
const done: FirstPassReadDto = { id: 1, status: "done", nonce: 0, model_id: "m", generated_at: "2026-09-10T20:07:00.000Z", facts: [fact()], prose: { read: ["Revenue of $898.2M beat by 2.4%.", "Second line."], call_watch: ["FY27 framework", "Net new ARR", "Capex"], caveats: ["One document so far."] } };
const generating: ActiveReadDto = { id: 2, status: "generating", nonce: 1, attempts: 1, claimed_at: "2026-09-10T20:08:00.000Z" };
// F10: a failure is a lastAttempt, never an "active" read.
const failed: LastAttemptDto = { id: 2, nonce: 1, attempts: 1, error_code: "model_error", error: "model call failed", next_retry_at: null, capped: false, claimed_at: "2026-09-10T20:08:00.000Z" };
const retrying: LastAttemptDto = { ...failed, error_code: "cites", error: "prose failed validation: read 5/6+", next_retry_at: "2026-09-10T20:12:00.000Z" };
const gaveUp: LastAttemptDto = { ...failed, error_code: "cites", error: "attempt cap reached (3/3): prose failed validation", attempts: 3, capped: true };

// R-D12: usePrivacy() throws outside a PrivacyProvider, so every render call
// wraps the component. On the server renderer useState/useEffect never run a
// second time, so privacy stays OFF and prose renders in clear.
function renderWithPrivacy(props: Parameters<typeof FirstPassRead>[0]): string {
  return renderToStaticMarkup(createElement(PrivacyProvider, null, createElement(FirstPassRead, props)));
}

describe("helpers", () => {
  it("readStatusLabel covers every done/active/last-attempt combination (#15, F10)", () => {
    // R-D21: facts are accepted-only, so the copy names the ACCEPT, not the parse.
    expect(readStatusLabel(null, null)).toBe("no read yet — generates after the first accept");
    expect(readStatusLabel(null, generating)).toBe("reading…");
    expect(readStatusLabel(done, null)).toBe("read · 16:07 ET");
    expect(readStatusLabel(done, generating)).toBe("read · 16:07 ET · updating…");
    // F10: the store's token becomes a word, and the desk is told what happens next.
    expect(readStatusLabel(null, null, failed)).toBe("read failed — model call failed");
    expect(readStatusLabel(null, null, retrying)).toBe("read failed — prose failed validation · retrying at 16:12 ET");
    expect(readStatusLabel(null, null, gaveUp)).toBe("read failed — prose failed validation · gave up after 3 attempts");
    expect(readStatusLabel(done, null, gaveUp)).toBe("read · 16:07 ET · update failed — prose failed validation · gave up after 3 attempts");
    // Live work outranks a past failure: the retry IS the answer to it.
    expect(readStatusLabel(done, generating, gaveUp)).toBe("read · 16:07 ET · updating…");
    // An unmapped code falls through as itself rather than inventing a description.
    expect(readStatusLabel(null, null, { ...failed, error_code: null })).toBe("read failed — unknown");
  });
  it("verdictGlyph and calloutStateLabel are text, never colour alone", () => {
    expect(verdictGlyph("range")).toBe("↔"); expect(verdictGlyph("n/a")).toBe("·");
    expect(calloutStateLabel(callout())).toMatch(/single source — verify/);
    expect(calloutStateLabel(callout({ state: "accepted", effective_state: "accepted" }))).toBe("accepted");
    expect(calloutStateLabel(callout({ effective_state: "revoked" }))).toMatch(/revoked/);
    expect(calloutStateLabel(callout({ state: "superseded", effective_state: "superseded" }))).toBe("superseded by a newer read");
  });
  it("factRow renders public figures plainly, the vendor figure with its basis label, ranges without a delta", () => {
    expect(factRow(fact())).toEqual({ label: "Revenue", actual: "$898.2M", bogey: "$877.3M (VK)", delta: "+2.4%", verdict: "beat" });
    expect(factRow(fact({ metric_id: "eps_adj_q", unit: "per_share", actual: 1.12, expected_consensus: null, expected_consensus_vendor: 1.1, expected_basis: "unspecified", expected_source: "vendor, basis unspecified", delta_pct: null, verdict: "n/a" }))).toEqual({ label: "Revenue", actual: "$1.12", bogey: "$1.10 (vendor, basis unspecified)", delta: "—", verdict: "n/a" });
    expect(factRow(fact({ kind: "range", actual: 900e6, actual_high: 905e6, delta_pct: null, verdict: "range" }))).toMatchObject({ actual: "$900.0M–$905.0M", delta: "range", verdict: "range" });
  });
});

describe("render (react-dom/server; #28)", () => {
  it("renders the done read with prose lines inside per-line PrivateText spans, public figures in clear, and the active line", () => {
    const html = renderWithPrivacy({ eventId: 5, read: done, activeRead: generating, callouts: [callout()], onChanged: async () => undefined });
    expect(html).toContain("read · 16:07 ET · updating…");
    // R-D34: the printed ACTUAL is public and renders bare; the BOGEY (the
    // desk's own curated expectation, masked in B's sheet) and the DELTA (which
    // reconstructs that bogey from the public actual) render inside PrivateText.
    expect(html).toMatch(/<td[^>]*>\$898\.2M<\/td>/);
    expect(html).toMatch(/<td[^>]*><span[^>]*>\$877\.3M \(VK\)<\/span><\/td>/);
    expect(html).toMatch(/<td[^>]*><span[^>]*>\+2\.4%<\/span><\/td>/);
    expect(html).toMatch(/<li[^>]*><span[^>]*>Revenue of \$898\.2M beat by 2\.4%\.<\/span><\/li>/);
    expect(html).toMatch(/<li[^>]*><span[^>]*>FY27 framework<\/span><\/li>/);
    expect(html).toMatch(/<span[^>]*>no bogey on file<\/span>/);
    expect(html).toContain("accept");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
  it("renders the empty state and a failed attempt", () => {
    expect(renderWithPrivacy({ read: null, activeRead: null, callouts: [], onChanged: async () => undefined })).toMatch(/no read yet/);
    const html = renderWithPrivacy({ read: null, activeRead: null, lastAttempt: gaveUp, callouts: [], onChanged: async () => undefined });
    expect(html).toContain("read failed — prose failed validation · gave up after 3 attempts");
    // F10: a terminal failure must not disable the way out of it. (The class
    // list carries "disabled:opacity-50"; the ATTRIBUTE is what matters, and
    // React renders a true `disabled` as `disabled=""`.)
    expect(html).toContain("regenerate");
    expect(html).not.toContain('disabled=""');
  });

  it("renders no call-watch heading or list when every call-watch line dropped (R-D36)", () => {
    const noWatch: FirstPassReadDto = { ...done, prose: { ...done.prose, call_watch: [], caveats: ["no call-watch lines survived validation"] } };
    const html = renderWithPrivacy({ read: noWatch, activeRead: null, callouts: [], onChanged: async () => undefined });
    expect(html).not.toContain("Call watch");
    expect(html).not.toContain("<ol");
    expect(html).toContain("no call-watch lines survived validation");
  });
});

// R-D37: mirrors the literal effect-deps array pinned below. There is no
// jsdom harness to mount the component and watch React's own dependency
// compare fire, so this is a manual stand-in for it — kept honest by the
// source-pin test asserting the component's actual array matches this same
// field list.
function noteEffectDeps(props: {
  read: FirstPassReadDto | null;
  activeRead: ActiveReadDto | null;
  lastAttempt?: LastAttemptDto | null;
}): readonly unknown[] {
  return [props.read?.id, props.activeRead?.id, props.activeRead?.status, props.lastAttempt?.id];
}
function depsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

describe("mount", () => {
  it("clears the action note whenever the read rows move (R-D35/R-D37) — source pin, no jsdom harness in this repo", () => {
    // Precedent for the source pin: tests/dashboard/narrative-block-refresh.test.ts
    // (this repo has no jsdom/@testing-library harness, and renderToStaticMarkup
    // never runs effects).
    const src = readFileSync("app/dashboard/today/FirstPassRead.tsx", "utf8");
    expect(src).toMatch(/useEffect\(\s*\(\)\s*=>\s*\{\s*setNote\(null\);?\s*\}\s*,\s*\[read\?\.id, activeRead\?\.id, activeRead\?\.status, lastAttempt\?\.id\]\)/);
  });

  it("R-D37: a new terminal attempt changes the deps even when read/activeRead never move — the poll-missed-the-generating-row case", () => {
    // Before R-D37: the FE's poll can jump straight from "nothing happening"
    // to "a terminal failure landed" without ever observing the row as
    // `activeRead` (F10 made `activeRead` live-work-only). `read` stays
    // whatever it was, `activeRead` stays null throughout — the OLD deps
    // never move, so a stale "Regenerating…" note would survive forever.
    const before = noteEffectDeps({ read: null, activeRead: null, lastAttempt: null });
    const after = noteEffectDeps({ read: null, activeRead: null, lastAttempt: failed });
    expect(depsEqual(before, after)).toBe(false);

    // Same failed row observed again on the next poll (nothing new happened)
    // must NOT look like a fresh change — no re-render churn on a steady state.
    const again = noteEffectDeps({ read: null, activeRead: null, lastAttempt: failed });
    expect(depsEqual(after, again)).toBe(true);

    // The done-read case (R-D35's original scenario) still moves the deps too.
    const doneAfter = noteEffectDeps({ read: done, activeRead: null, lastAttempt: null });
    expect(depsEqual(before, doneAfter)).toBe(false);
  });


  it("LivePrintRow mounts FirstPassRead exactly once with the row's onChanged", () => {
    // Slice F task 8: the panel's PrintCard became LivePrintRow, and the status
    // wire shape it renders moved to hub-live/types.ts (M-F18 — a client file
    // may not import the server cockpit types, so the wire shapes are
    // re-declared there). Same two facts, pinned on the two files that now
    // carry them.
    const src = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
    expect(src.match(/<FirstPassRead\b/g)).toHaveLength(1);
    expect(src).toMatch(/<FirstPassRead[^>]*onChanged=\{onChanged\}/);
    const wire = readFileSync("app/dashboard/today/hub-live/types.ts", "utf8");
    expect(wire).toMatch(/read\?: FirstPassReadDto \| null/);
    expect(wire).toMatch(/activeRead\?: ActiveReadDto \| null/);
    expect(wire).toMatch(/callouts\?: CalloutView\[\]/);
  });
});
