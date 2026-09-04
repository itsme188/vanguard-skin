import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FirstPassRead, { readStatusLabel, verdictGlyph, calloutStateLabel, factRow, type FirstPassReadDto, type ActiveReadDto } from "@/app/dashboard/today/FirstPassRead";
import type { CalloutView, ReadFact } from "@/lib/print-watch/first-pass-types";
import { PrivacyProvider } from "@/lib/privacy/context";

const fact = (o: Partial<ReadFact> = {}): ReadFact => ({ metric_id: "revenue_q", label: "Revenue", state: "accepted", unit: "usd", period: "Q", kind: "point", actual: 898.2e6, actual_high: null, expected_consensus: 877.3e6, expected_whisper: null, expected_source: "VK", expected_consensus_vendor: null, expected_basis: "specified", delta_pct: 2.38, verdict: "beat", ...o });
const callout = (o: Partial<CalloutView> = {}): CalloutView => ({ id: 1, print_id: 1, read_id: 1, label: "ARR", label_norm: "arr", value: 3.74e9, value_high: null, unit: "usd", value_text: "$3.74B", snippet: "ARR reached $3.74 billion", doc_id: 1, doc_sha256: "d", evidence_sha256: "e", verifier_version: 1, vs_bogey_text: "no bogey on file", state: "proposed", accepted_at: null, revoked_at: null, superseded_by_read_id: null, created_at: "2026-09-10T20:07:00.000Z", updated_at: "2026-09-10T20:07:00.000Z", effective_state: "proposed", doc_kind: "user-drop", ...o });
const done: FirstPassReadDto = { id: 1, status: "done", nonce: 0, model_id: "m", generated_at: "2026-09-10T20:07:00.000Z", facts: [fact()], prose: { read: ["Revenue of $898.2M beat by 2.4%.", "Second line."], call_watch: ["FY27 framework", "Net new ARR", "Capex"], caveats: ["One document so far."] } };
const generating: ActiveReadDto = { id: 2, status: "generating", nonce: 1, attempts: 1, error_code: null, error: null, next_retry_at: null, claimed_at: "2026-09-10T20:08:00.000Z" };
const failed: ActiveReadDto = { ...generating, status: "failed", error_code: "model_error", error: "model call failed" };

// R-D12: usePrivacy() throws outside a PrivacyProvider, so every render call
// wraps the component. On the server renderer useState/useEffect never run a
// second time, so privacy stays OFF and prose renders in clear.
function renderWithPrivacy(props: Parameters<typeof FirstPassRead>[0]): string {
  return renderToStaticMarkup(createElement(PrivacyProvider, null, createElement(FirstPassRead, props)));
}

describe("helpers", () => {
  it("readStatusLabel covers every done/active combination (#15)", () => {
    // R-D21: facts are accepted-only, so the copy names the ACCEPT, not the parse.
    expect(readStatusLabel(null, null)).toBe("no read yet — generates after the first accept");
    expect(readStatusLabel(null, generating)).toBe("reading…");
    expect(readStatusLabel(null, failed)).toBe("read failed — model_error");
    expect(readStatusLabel(done, null)).toBe("read · 16:07 ET");
    expect(readStatusLabel(done, generating)).toBe("read · 16:07 ET · updating…");
    expect(readStatusLabel(done, failed)).toBe("read · 16:07 ET · update failed — model_error");
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
    expect(html).toContain("$898.2M"); expect(html).toContain("$877.3M (VK)"); expect(html).toContain("+2.4%");
    expect(html).toMatch(/<li[^>]*><span[^>]*>Revenue of \$898\.2M beat by 2\.4%\.<\/span><\/li>/);
    expect(html).toMatch(/<li[^>]*><span[^>]*>FY27 framework<\/span><\/li>/);
    expect(html).toMatch(/<span[^>]*>no bogey on file<\/span>/);
    expect(html).toContain("accept");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
  it("renders the empty state and a failed attempt", () => {
    expect(renderWithPrivacy({ read: null, activeRead: null, callouts: [], onChanged: async () => undefined })).toMatch(/no read yet/);
    expect(renderWithPrivacy({ read: null, activeRead: failed, callouts: [], onChanged: async () => undefined })).toContain("read failed — model_error");
  });
});

describe("mount", () => {
  it("PrintWatchPanel mounts FirstPassRead exactly once with the card's onChanged", () => {
    const src = readFileSync("app/dashboard/today/PrintWatchPanel.tsx", "utf8");
    expect(src.match(/<FirstPassRead\b/g)).toHaveLength(1);
    expect(src).toMatch(/<FirstPassRead[^>]*onChanged=\{onChanged\}/);
    expect(src).toMatch(/read\?: FirstPassReadDto \| null/);
    expect(src).toMatch(/activeRead\?: ActiveReadDto \| null/);
    expect(src).toMatch(/callouts\?: CalloutView\[\]/);
  });
});
