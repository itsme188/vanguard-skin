import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SEND_TONES, SEND_GLYPHS, DELIVERY_UNKNOWN_TITLE, chipFor, fmtCountdown, stageChips, StageChipStrip, RowIntelLine,
  ALL_PREVIEW_STATES, ALL_RECAP_STATES, ALL_SEND_STATES, ALL_ACTUAL_STATES,
} from "@/app/dashboard/today/hub-live/send-state-chips";
import type { CockpitRowWire } from "@/app/dashboard/today/hub-live/types";
import { PrivacyProvider } from "@/lib/privacy/context";

/**
 * On THIS branch (controller ruling R-F14), `CockpitRowWire["stages"]` is the
 * server's REAL `EventStages` — its `preview`/`recap` fields do not yet carry
 * "delivery-unknown" (slice E adds it in a parallel worktree). The fixture
 * builder below widens just those two fields to `string` so tests can
 * construct the state the cross-slice contract requires F to render before E
 * merges; the final `as CockpitRowWire` reflects that gap in the TEST FIXTURE
 * only — `send-state-chips.tsx` itself takes zero casts (see its `stageChips`,
 * whose helpers only ever read these fields as plain strings).
 */
type StagesFixture = {
  preview: string;
  released: CockpitRowWire["stages"]["released"];
  actual: CockpitRowWire["stages"]["actual"];
  reaction: CockpitRowWire["stages"]["reaction"];
  recap: string;
};
type RowFixtureOverrides = Partial<Omit<CockpitRowWire, "stages">> & { stages?: StagesFixture };

const row = (o: RowFixtureOverrides = {}): CockpitRowWire =>
  ({
    eventId: 1, symbol: "XMPL1", securityId: null, title: "XMPL1 Q3", eventDate: "2026-09-10",
    eventTime: "AMC", releaseTime: "16:05", symbolStatus: "armed", consensus: "EPS 0.46", actual: null,
    stages: {
      preview: "sent",
      released: { state: "upcoming", releaseInstant: "2026-09-10T20:05:00.000Z" },
      actual: "pending",
      reaction: { state: "pending", source: null, readyAt: null },
      recap: "waiting",
    },
    netExposure: 0, isTopExposure: false, hasCallNote: false, carryover: false, intel: null,
    ...o,
  }) as CockpitRowWire;

describe("the tone and glyph maps are TOTAL over the stage unions (contract §1)", () => {
  it("every state across preview/recap/send/actual has a tone AND a glyph — so slice E's delivery-unknown can never render as a raw word", () => {
    const all = [...ALL_PREVIEW_STATES, ...ALL_RECAP_STATES, ...ALL_SEND_STATES, ...ALL_ACTUAL_STATES];
    const missingTone = all.filter((s) => SEND_TONES[s] === undefined);
    const missingGlyph = all.filter((s) => SEND_GLYPHS[s] === undefined);
    expect({ missingTone, missingGlyph }).toEqual({ missingTone: [], missingGlyph: [] });
  });
  it("renders delivery-unknown exactly as the contract specifies", () => {
    expect(chipFor("rec", "delivery-unknown")).toEqual({
      tone: "warn", text: "rec ?", title: DELIVERY_UNKNOWN_TITLE,
    });
    expect(DELIVERY_UNKNOWN_TITLE).toBe(
      "The provider's response was never received — check the mailbox or the Resend log for the message id, then resend by hand if needed.",
    );
  });
  it("uses the full word in the chip's own label where there is room", () => {
    expect(stageChips(row({ stages: { ...row().stages, recap: "delivery-unknown" } })).map((c) => c.text))
      .toContain("rec ? delivery unknown");
  });
});

describe("chipFor", () => {
  it("appends the glyph when there is one and leaves a bare label when there is not", () => {
    expect(chipFor("pre", "sent")).toMatchObject({ tone: "up", text: "pre ✓" });
    expect(chipFor("pre", "pending")).toMatchObject({ tone: "neutral", text: "pre" });
  });
  it("falls back to neutral with the state word for a state nobody has mapped yet", () => {
    expect(chipFor("pre", "brand-new")).toMatchObject({ tone: "neutral", text: "pre brand-new" });
  });
});

describe("fmtCountdown", () => {
  it("counts hours, minutes-and-seconds, seconds, and says now at or past zero", () => {
    expect(fmtCountdown(3 * 3_600_000 + 4 * 60_000)).toBe("3h 4m");
    expect(fmtCountdown(4 * 60_000 + 5_000)).toBe("4m 5s");
    expect(fmtCountdown(9_000)).toBe("9s");
    expect(fmtCountdown(0)).toBe("now");
    expect(fmtCountdown(-1)).toBe("now");
  });
});

describe("stageChips", () => {
  it("renders released/preview/actual/reaction/recap in cockpit order and marks what is clickable", () => {
    const chips = stageChips(row({ stages: { ...row().stages, preview: "sent", recap: "sent-by-cloud", actual: "blocked" } }));
    expect(chips.map((c) => c.key)).toEqual(["released", "preview", "actual", "reaction", "recap"]);
    expect(chips.find((c) => c.key === "preview")!.clickable).toBe("preview");
    expect(chips.find((c) => c.key === "recap")!.clickable).toBeNull();
    expect(chips.find((c) => c.key === "actual")!.clickable).toBe("actuals");
    expect(chips.find((c) => c.key === "reaction")!.clickable).toBeNull();
  });
  // Amendment (a) / contract §1 R-E14 REPLACES the plan's original pair of
  // tests here (a NOT-clickable delivery-unknown preview, and no sent-by-cloud
  // counter-case) — a delivery-unknown row DOES hold a stored body.
  it("a delivery-unknown preview IS clickable — the attempted body is stored (contract §1, R-E14)", () => {
    const chips = stageChips(row({ stages: { ...row().stages, preview: "delivery-unknown" } }));
    expect(chips.find((c) => c.key === "preview")!.clickable).toBe("preview");
    expect(chips.find((c) => c.key === "preview")!.title).toBe(DELIVERY_UNKNOWN_TITLE);
  });
  it("a sent-by-cloud chip is still NOT clickable — the Mac holds no copy of a Worker send", () => {
    const chips = stageChips(row({ stages: { ...row().stages, recap: "sent-by-cloud" } }));
    expect(chips.find((c) => c.key === "recap")!.clickable).toBeNull();
  });
});

// react-dom/server HTML-escapes `'` as `&#x27;` in both text and attribute
// output (verified directly: renderToStaticMarkup(<span title="It's" />) ->
// `<span title="It&#x27;s"></span>`) — DELIVERY_UNKNOWN_TITLE's one apostrophe
// (in "provider's") falls inside the plan's literal `.slice(0, 40)` comparison,
// which can therefore never match rendered output for ANY implementation.
// These two helpers make the comparisons match what actually gets rendered.
const htmlEscapeApos = (s: string) => s.replace(/'/g, "&#x27;");
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("StageChipStrip render", () => {
  it("renders a button only for clickable chips and text for the rest, with the title on delivery-unknown", () => {
    const html = renderToStaticMarkup(
      createElement(StageChipStrip, { row: row({ stages: { ...row().stages, recap: "delivery-unknown" } }), onOpen: () => undefined }),
    );
    expect(html).toContain("delivery unknown");
    expect(html).toContain(htmlEscapeApos(DELIVERY_UNKNOWN_TITLE).slice(0, 40));
    expect(html).not.toMatch(/<div[^>]*onclick/i);
  });
  it("a clickable delivery-unknown chip renders as a <button> carrying the contract's title, so the warn tone is never the only signal", () => {
    const html = renderToStaticMarkup(
      createElement(StageChipStrip, { row: row({ stages: { ...row().stages, recap: "delivery-unknown" } }), onOpen: () => undefined }),
    );
    const buttonWithTitle = new RegExp(`<button[^>]*title="${regexEscape(htmlEscapeApos(DELIVERY_UNKNOWN_TITLE))}"`);
    expect(html).toMatch(buttonWithTitle);
  });
  it("a sent-by-cloud chip renders as plain text, not a button — the Mac holds no copy of a Worker send", () => {
    const html = renderToStaticMarkup(
      createElement(StageChipStrip, { row: row({ stages: { ...row().stages, recap: "sent-by-cloud" } }), onOpen: () => undefined }),
    );
    // Exactly one clickable chip on this fixture (preview, default "sent") —
    // the sent-by-cloud recap chip must not add a second <button>.
    expect((html.match(/<button/g) ?? []).length).toBe(1);
  });
});

describe("privacy: public market data stays visible, the desk's own figures mask (Codex 15)", () => {
  const withIntel = (over: Partial<NonNullable<CockpitRowWire["intel"]>>) =>
    row({ intel: { impliedMovePct: 6, impliedMethod: "straddle", sheetSourceLabel: null,
                   histAvgAbsMovePct: 4.2, histBeatCount: 6, histQuarterCount: 8, ...over } });
  const render = (el: React.ReactElement) => renderToStaticMarkup(createElement(PrivacyProvider, null, el));
  const src = readFileSync("app/dashboard/today/hub-live/send-state-chips.tsx", "utf8");

  // `PrivacyProvider` holds `isPrivate` in state and only reads localStorage in
  // an effect, so under react-dom/server privacy is always OFF (the same note
  // tests/dashboard/first-pass-read.test.ts records as R-D12). The RENDER tests
  // below therefore prove the figures appear at all; WHICH wrapper each one
  // sits in is pinned by source, which is the only honest split available
  // without jsdom.
  it("renders every figure in the clear when privacy is off", () => {
    const html = render(createElement(RowIntelLine, { row: { ...withIntel({}), netExposure: 125_000 } }));
    expect(html).toContain("6.0% implied");
    expect(html).toContain("beat 6/8");
    expect(html).toContain("125,000");
  });

  it("renders nothing at all for a row with no intel, rather than an empty shell", () => {
    expect(render(createElement(RowIntelLine, { row: row({ intel: null }) }))).toBe("");
  });

  it("omits the exposure clause entirely at zero net exposure", () => {
    expect(render(createElement(RowIntelLine, { row: { ...withIntel({}), netExposure: 0 } }))).not.toContain("net");
  });

  it("puts the SHEET implied move behind PrivateText and leaves a market implied move plain", () => {
    // `impliedMethod: "sheet"` means the number came off the desk's own uploaded
    // bogey sheet — curated, not quoted — so it masks; a straddle or IV
    // approximation is the options market talking about a listed company.
    expect(src).toMatch(/impliedMethod === "sheet"/);
    expect(src).toMatch(/impliedIsDeskOwn \? <PrivateText>\{implied\}<\/PrivateText> : <span>\{implied\}<\/span>/);
  });

  it("renders net exposure through <Money> and never raw", () => {
    expect(src).toMatch(/<Money value=\{row\.netExposure\}/);
    // Deviation from the plan's literal regex here: `/\{row\.netExposure\}(?!\s*!?==)/`
    // also matches the correct `<Money value={row.netExposure}>` usage the line
    // above requires (verified with node -e: the substring is never followed by
    // "==" inside a JSX prop), so `not.toMatch` on it could never pass for any
    // implementation. The real intent — row.netExposure is interpolated exactly
    // once, and that's the <Money> prop, never a second bare render — is what
    // this asserts instead.
    const interpolations = src.match(/\{row\.netExposure\}/g) ?? [];
    expect(interpolations.length).toBe(1);
  });

  it("leaves the company's own reporting record public", () => {
    expect(src).toMatch(/beat \{intel\.histBeatCount\}\/\{intel\.histQuarterCount\}/);
    expect(src).not.toMatch(/<PrivateText>[^<]*histBeatCount/);
  });
});
