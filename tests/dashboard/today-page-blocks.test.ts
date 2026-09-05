import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyProvider } from "@/lib/privacy/context";
import { MomentumPulse } from "@/app/dashboard/components/MomentumPulse";
import type { MomentumPulse as MomentumPulseData } from "@/lib/compute/momentum-spread";

const today = readFileSync("app/dashboard/today/page.tsx", "utf8");
const analysis = readFileSync("app/dashboard/analysis/page.tsx", "utf8");

describe("Today keeps only the blocks the spec keeps (§2 ruling, §4.6)", () => {
  it("no longer imports or renders Alerts, Nearby Levels, Momentum Pulse, Significant Moves, the cockpit or the print panel", () => {
    for (const gone of [
      "getAlerts", "NearbyLevelsCard", "getLevelsNearPrice", "MomentumPulse",
      "computeMomentumPulse", "SignificantMovesCard", "EarningsCockpit", "PrintWatchPanel",
    ]) {
      expect(today, `Today still references ${gone}`).not.toContain(gone);
    }
    expect(today).not.toMatch(/AlertGroup|EnrichedAlert|triggeredToday/);
  });
  it("still renders the header, the portfolio strip, releases, the Hub, the chat button and the one-line IBKR snapshot, in that order", () => {
    expect(today).toContain("<EarningsHub");
    expect(today).toContain("<OpenChatButton");
    expect(today).toContain("<TodayReleases");
    const order = ["Portfolio", "<TodayReleases", "<EarningsHub", "<OpenChatButton", "IBKR today"].map((s) => today.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > -1)).toBe(true);
  });
  it("collapses IBKR today to one line: count, signed money, percent, refresh, and a link to Accounts", () => {
    expect(today).toMatch(/<Count\b/);
    expect(today).toMatch(/<Money[^>]*signed/);
    expect(today).toMatch(/<Pct\b/);
    expect(today).toContain("<IbkrRefreshButton");
    expect(today).toContain("/dashboard/accounts");
    // The per-name list is gone: no map over holdings and no per-row security link.
    expect(today).not.toMatch(/holdings\.map\(/);
  });
  it("keeps force-dynamic and renders an EmptySection-equivalent rather than nothing when there is no IBKR account", () => {
    expect(today).toMatch(/export const dynamic = "force-dynamic"/);
    expect(today).toMatch(/No IBKR account/);
  });
  it("lets releases span the full row now that the momentum tile is gone", () => {
    expect(today).not.toMatch(/md:grid-cols-2[^]*TodayReleases/);
  });
  // Codex 15: nothing on this line may render a figure the app does not have.
  // A null today_gain is UNKNOWN, never zero — a morning before any prior
  // close has landed must never render "$0.00 today" in the up colour.
  it("treats a missing today's-move as unknown, never zero, and wraps every number in a privacy component", () => {
    expect(today).toMatch(/todayGain === null \? null : moved\.reduce/);
    expect(today).toContain("no prior-close prices yet — today's move is unavailable");
    expect(today).toMatch(/<Count value=\{holdings\.length - moved\.length\} \/>/);
    // Every $, % and count on the line sits inside a privacy wrapper: the
    // only braces in that block that reach a number are the wrappers' own
    // `value=` props — a bare `{todayGain}`/`{todayPct}`/`{holdings.length}`
    // used any other way (e.g. as raw JSX text) is the exact bug this test
    // guards against.
    const line = today.slice(today.indexOf("IBKR today — one line"), today.indexOf("</section>", today.indexOf("IBKR today — one line")));
    expect(line).not.toMatch(/(?<!value=)(\{todayGain\}|\{todayPct\}|\{holdings\.length\})/);
  });
});

describe("the two deleted components are really gone (M-F11)", () => {
  it("EarningsCockpit.tsx and PrintWatchPanel.tsx no longer exist and nothing imports them", () => {
    expect(existsSync("app/dashboard/today/EarningsCockpit.tsx")).toBe(false);
    expect(existsSync("app/dashboard/today/PrintWatchPanel.tsx")).toBe(false);
  });
  it("SignificantMovesCard moved to app/dashboard/components", () => {
    expect(existsSync("app/dashboard/components/SignificantMovesCard.tsx")).toBe(true);
    expect(existsSync("app/dashboard/today/SignificantMovesCard.tsx")).toBe(false);
  });
});

describe("Analysis diagnostics gains the two moved cards (§4.6 bullet 2)", () => {
  it("imports and renders both, above TrustStrip and below the view toggle", () => {
    expect(analysis).toContain("SignificantMovesCard");
    expect(analysis).toContain("computeMomentumPulse");
    const toggle = analysis.indexOf("<AnalysisViewToggle");
    const cards = analysis.indexOf("<SignificantMovesCard");
    const pulse = analysis.indexOf("<MomentumPulse");
    const trust = analysis.lastIndexOf("<TrustStrip");
    expect(toggle).toBeGreaterThan(-1);
    expect(cards).toBeGreaterThan(toggle);
    expect(pulse).toBeGreaterThan(toggle);
    expect(trust).toBeGreaterThan(cards);
    expect(trust).toBeGreaterThan(pulse);
  });
  it("computes the pulse itself, because MomentumPulse is prop-driven while SignificantMovesCard self-loads", () => {
    expect(analysis).toMatch(/computeMomentumPulse\(db\)/);
    expect(analysis).toMatch(/<MomentumPulse pulse=/);
    expect(analysis).toMatch(/<SignificantMovesCard \/>/);
  });
});

describe("MomentumPulse still renders in its new home", () => {
  const pulse: MomentumPulseData = {
    spreads: {
      mtum_vs_spy: { return30d: 1.2, return5d: 0.4, return1d: 0.1 },
      spmo_vs_spy: { return30d: 1.0, return5d: 0.3, return1d: 0.1 },
      usmv_vs_spy: { return30d: -0.4, return5d: -0.1, return1d: 0.0 },
    },
    status: "leading", trigger: "5d", reason: "Momentum is leading over five days.", asOf: "2026-09-10",
  };
  it("renders the headline status and reason from a fixture, and its own empty state for null", () => {
    const html = renderToStaticMarkup(createElement(PrivacyProvider, null, createElement(MomentumPulse, { pulse })));
    expect(html).toContain("Momentum is leading over five days.");
    const empty = renderToStaticMarkup(createElement(PrivacyProvider, null, createElement(MomentumPulse, { pulse: null })));
    expect(empty).not.toBe("");
  });
});
