/**
 * The print card's new behaviour after slice F task 8 moved it out of
 * `PrintWatchPanel.tsx` (M-F6, M-F16, M-F17, M-F19, cross-slice contract
 * §2/§3/§4).
 *
 * No React Testing Library and no jsdom (neither is a dependency, and none may
 * be added): render assertions go through React 19's own `react-dom/server`,
 * and wiring with no render surface is pinned with `readFileSync` source scans.
 * Every identifier here is synthetic (R-F8).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyProvider } from "@/lib/privacy/context";
import PrintOutputs from "@/app/dashboard/today/live-print/PrintOutputs";
import PrepareStatus from "@/app/dashboard/today/live-print/PrepareStatus";
import { presentState } from "@/app/dashboard/today/live-print/helpers";
import type { PrintOutputsWire, PrepareStepWire } from "@/app/dashboard/today/hub-live/types";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const render = (el: ReactElement) => renderToStaticMarkup(createElement(PrivacyProvider, null, el));

const contract = {
  metric_id: "revenue_q",
  label: "Revenue",
  definition: "d",
  basis: "na",
  period: "Q",
  currency: "USD",
  unit: "usd",
  kind: "point",
  segment: null,
} as const;

const line = (o: Partial<PrintWatchLine> = {}): PrintWatchLine => ({
  metric_id: "revenue_q",
  contract,
  expected: { value: 3.85e9, value_high: null, whisper: null, source_label: "Sheet A" },
  state: "agreed",
  value: 4.0e9,
  value_high: null,
  snippet: null,
  source_doc_id: 1,
  candidates_json: "[]",
  ...o,
});

/** The promote control LivePrintRow hands down (F-S8) — the outputs row renders
 *  it, it never re-implements it. */
const promote = {
  label: "Promote",
  disabled: false,
  title: "Promote the headline pair",
  busy: false,
  onClick: () => undefined,
};

describe("presentState — the retired case (M-F17)", () => {
  it("names a retired line instead of falling through to pending", () => {
    expect(presentState(line({ state: "retired" }))).toEqual({
      text: "retired — definition changed",
      icon: "⌀",
      tone: "neutral",
    });
  });
  it("still renders every other state exactly as the panel did", () => {
    expect(presentState(line({ state: "agreed" }))).toMatchObject({ text: "agreed — verify" });
    expect(presentState(line({ state: "pending", value: null }))).toMatchObject({ text: "pending" });
  });
});

describe("the Δ column is masked whenever the bogey is (M-F19)", () => {
  const src = readFileSync("app/dashboard/today/live-print/LineRow.tsx", "utf8");
  it("wraps the delta cell in PrivateText on the same condition as the bogey cell", () => {
    // A masked bogey with an unmasked Δ leaks the bogey by division.
    expect(src).toMatch(/Δ vs bogey|delta/i);
    const deltaCell = src.slice(src.indexOf("delta === null"));
    expect(deltaCell).toMatch(/<PrivateText/);
    expect(deltaCell).toMatch(/line\.expected \? <PrivateText>/);
  });
  it("gives a retired line no accept control and dims it (M-F17)", () => {
    expect(src).toMatch(/const isRetired = line\.state === "retired";/);
    expect(src).toMatch(/isRetired \? "opacity-60" : ""/);
    expect(src).toMatch(/\{isRetired \? null : line\.state === "accepted" \?/);
  });
});

describe("PrintOutputs (contract §2/§3)", () => {
  const outputs: PrintOutputsWire = {
    printSheet: { enabled: true, reason: null },
    sendRecap: {
      enabled: false,
      reason:
        "Accept the headline pair first — EPS (adjusted or GAAP) and revenue must both be accepted with a reported value.",
      state: "unsent",
      providerMessageId: null,
    },
  };
  it("renders NOTHING when the payload has no outputs (slice E unmerged)", () => {
    expect(
      render(
        createElement(PrintOutputs, { printId: 1, outputs: undefined, onChanged: async () => undefined, promote }),
      ),
    ).toBe("");
  });
  it("renders all three buttons when outputs is present", () => {
    const html = render(
      createElement(PrintOutputs, { printId: 1, outputs, onChanged: async () => undefined, promote }),
    );
    expect(html).toContain("Print sheet");
    expect(html).toContain("Promote");
    expect(html).toContain("Send recap now");
  });
  it("shows a disabled reason as BOTH the title and visible text, never as colour alone", () => {
    const html = render(
      createElement(PrintOutputs, { printId: 1, outputs, onChanged: async () => undefined, promote }),
    );
    expect(html).toContain(
      `title="${outputs.sendRecap
        .reason!.replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;")}"`,
    );
    expect(html).toContain("Accept the headline pair first");
    expect(html).toMatch(/disabled=""/);
  });
  it("renders the recap state word when the recap is not unsent", () => {
    const sent: PrintOutputsWire = {
      ...outputs,
      sendRecap: { enabled: false, reason: "sent", state: "sent", providerMessageId: "re_123" },
    };
    expect(
      render(createElement(PrintOutputs, { printId: 1, outputs: sent, onChanged: async () => undefined, promote })),
    ).toContain("sent");
  });
  const src = readFileSync("app/dashboard/today/live-print/PrintOutputs.tsx", "utf8");
  it("posts the two E routes exactly once each and renders data.outcome + data.reason verbatim", () => {
    expect(src.match(/apiFetch\("\/api\/print-watch\/print-sheet"/g)).toHaveLength(1);
    expect(src.match(/apiFetch\("\/api\/print-watch\/send-recap"/g)).toHaveLength(1);
    expect(src).toMatch(/data\.data\?\.outcome/);
    expect(src).toMatch(/data\.data\?\.reason/);
  });
  it("checks res.ok AND data.success and never swallows a failure", () => {
    expect(src).toMatch(/!res\.ok \|\| !data\?\.success/);
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
  it("renders the promote control it is handed rather than re-implementing the 409 confirms (F-S8)", () => {
    const html = render(
      createElement(PrintOutputs, { printId: 1, outputs, onChanged: async () => undefined, promote }),
    );
    expect(html).toContain("Promote");
    expect(src).not.toMatch(/SUPERSEDED_ACCEPT_CONFIRM_COPY|promoteHeadline/);
  });
  it("renders a delivery_unknown note verbatim, because that arm carries no reason (contract §3)", () => {
    expect(src).toMatch(/data\.data\?\.reason \?\? data\.data\?\.note/);
  });
});

describe("PrepareStatus (M-F15)", () => {
  const step = (o: Partial<PrepareStepWire> = {}): PrepareStepWire => ({
    event_id: 1,
    step: "intel",
    status: "done",
    input_fingerprint: "f",
    attempts: 1,
    last_error: null,
    updated_at: "2026-09-10T20:00:00.000Z",
    ...o,
  });
  it("renders nothing when the controller has not fetched the steps yet", () => {
    expect(render(createElement(PrepareStatus, { steps: undefined }))).toBe("");
  });
  it("says 'ready' when every step is done", () => {
    expect(render(createElement(PrepareStatus, { steps: [step(), step({ step: "con_id" })] }))).toContain("ready");
  });
  it("calls a pending step WAITING, never stuck or failed", () => {
    const html = render(createElement(PrepareStatus, { steps: [step({ step: "intel", status: "pending" })] }));
    expect(html).toContain("waiting");
    expect(html).not.toMatch(/stuck|failed/);
  });
  it("names the IR page as the fix when ir_baseline is the only step still waiting (TODO.md slice-B minor)", () => {
    const html = render(
      createElement(PrepareStatus, { steps: [step(), step({ step: "ir_baseline", status: "pending" })] }),
    );
    expect(html).toContain("waiting on an IR page");
  });
  it("surfaces a real failure with its message", () => {
    const html = render(
      createElement(PrepareStatus, {
        steps: [step({ step: "intel", status: "failed", last_error: "TWS offline" })],
      }),
    );
    expect(html).toContain("intel failed — TWS offline");
  });
});

describe("GoControls — the paste box (contract §4)", () => {
  const src = readFileSync("app/dashboard/today/live-print/GoControls.tsx", "utf8");
  it("posts a pasted URL and a pasted file to the SAME go route, with the route's own body shape", () => {
    // The plan's own implementation folds every press into one `postGo(body,…)`
    // call site — which is what keeps the go route's 200/4xx handling and the
    // non-fatal-wake caveat in ONE place — so the body shapes are pinned at
    // their call sites and the pass-through is pinned once.
    expect(src).toMatch(/postGo\(\{ eventId, url: url\.trim\(\) \}/);
    expect(src).toMatch(/postGo\(\{ eventId, contentBase64, filename: file\.name \}/);
    expect(src).toMatch(/body: JSON\.stringify\(body\)/);
    expect(src.match(/apiFetch\("\/api\/print-watch\/go"/g)!.length).toBeGreaterThanOrEqual(1);
  });
  it("uses a native file input so the phone can pick a file (M-F10)", () => {
    expect(src).toMatch(/type="file"/);
  });
  it("renders the server's refusal verbatim rather than a generic failure", () => {
    expect(src).toMatch(/data\?\.error/);
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
});

describe("IrPageField reads before it writes (Codex 11)", () => {
  const src = readFileSync("app/dashboard/today/live-print/IrPageField.tsx", "utf8");
  it("GETs the stored row for its symbol and keeps Save disabled until it lands", () => {
    expect(src).toMatch(/\/api\/print-watch\/sources\?symbol=/);
    expect(src).toMatch(/disabled=\{!loaded/);
  });
  it("makes clearing its own button, never an empty Save", () => {
    expect(src).toContain("clear the stored page");
    expect(src).toMatch(/irPageUrl: ""/);
    expect(src).not.toMatch(/Leave it empty and save/);
  });
  it("explains all three outcomes in domain language and swallows nothing", () => {
    expect(src).toMatch(/nothing was cleared/);
    expect(src).toMatch(/will stop polling it/);
    expect(src).toMatch(/from the next poll/);
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
});

describe("LivePrintRow — no hover-only affordances, no div onClick, keyboard-first", () => {
  const src = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
  it("has no opacity-0 reveal and no clickable div (touch tap-trap + keyboard rules)", () => {
    expect(src).not.toMatch(/opacity-0/);
    expect(src).not.toMatch(/<div[^>]*onClick/);
  });
  it("keeps every table inside its own horizontal scroller so 752px of content never scrolls the page", () => {
    expect(src).toMatch(/<ScrollFade>/);
  });
  it("keeps promote reachable while slice E's outputs block is absent", () => {
    // PrintOutputs renders nothing without `outputs`, and promote is the whole
    // point of the sheet — so the row renders the SAME control itself in that
    // case, and exactly one of the two is ever on screen.
    expect(src).toMatch(/\{!print\.outputs && <PromoteButton promote=\{promoteControl\} \/>\}/);
    expect(src).toMatch(/<PrintOutputs[\s\S]*promote=\{promoteControl\}/);
  });
  it("owns the accept route and its three 409 confirms in one place (F-S8)", () => {
    expect(src).toMatch(/SUPERSEDED_CONFIRM_COPY/);
    expect(src).toMatch(/SUPERSEDED_ACCEPT_CONFIRM_COPY/);
    expect(src).toMatch(/SUPERSEDED_CANDIDATE_CONFIRM_COPY/);
    expect(src.match(/apiFetch\("\/api\/print-watch\/accept"/g)).toHaveLength(1);
  });
});
