/**
 * The recap header's refresh sentence (U20): reaction only, actuals only, both,
 * or none; plus the standing "rebuilt from current data" line for every recap.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  scoreboardRefreshSentence,
  EmailViewerHeader,
  type EmailContentResponse,
} from "@/app/dashboard/components/EarningsEmailViewer";

const SENT = "2026-09-10 20:27:00";
const LEG = "2026-09-10T22:15:00.000Z"; // 6:15 PM ET
const ACT = "2026-09-10 21:05:00"; // 5:05 PM ET

describe("scoreboardRefreshSentence", () => {
  it("reaction only keeps the existing sentence", () => {
    expect(scoreboardRefreshSentence(SENT, LEG, null)).toBe(
      "Scoreboard refreshed after send — reaction captured Sep 10, 6:15 PM ET",
    );
  });
  it("actuals only", () => {
    expect(scoreboardRefreshSentence(SENT, null, ACT)).toBe(
      "Scoreboard refreshed after send — actuals entered Sep 10, 5:05 PM ET",
    );
  });
  it("both are named in one sentence", () => {
    expect(scoreboardRefreshSentence(SENT, LEG, ACT)).toBe(
      "Scoreboard refreshed after send — actuals entered Sep 10, 5:05 PM ET; reaction captured Sep 10, 6:15 PM ET",
    );
  });
  it("neither, or stamps not after the send, gives null", () => {
    expect(scoreboardRefreshSentence(SENT, null, null)).toBeNull();
    expect(scoreboardRefreshSentence(SENT, "2026-09-10T20:00:00.000Z", "2026-09-10 20:00:00")).toBeNull();
    expect(scoreboardRefreshSentence(null, LEG, ACT)).toBeNull();
  });
});

describe("EmailViewerHeader standing line", () => {
  const base: EmailContentResponse = {
    title: "XMPL2 Earnings Recap",
    sentAt: SENT,
    sentTo: "desk@example.com",
    eventDate: "2026-09-10",
    symbol: "XMPL2",
    phase: "recap",
    sentBy: "local",
    deliveryState: "sent",
    fullHtml: "",
  };
  const LINE = "The scoreboard is rebuilt from current data; the text below is what was sent.";
  it("shows on every sent recap, even with no refresh", () => {
    expect(renderToStaticMarkup(createElement(EmailViewerHeader, { data: base }))).toContain(LINE);
  });
  it("is absent from a preview and from a live (unsent) view", () => {
    expect(
      renderToStaticMarkup(createElement(EmailViewerHeader, { data: { ...base, phase: "preview" } })),
    ).not.toContain(LINE);
    expect(
      renderToStaticMarkup(createElement(EmailViewerHeader, { data: { ...base, sentAt: "", sentTo: "" } })),
    ).not.toContain(LINE);
  });
  it("renders the actuals sentence", () => {
    const html = renderToStaticMarkup(
      createElement(EmailViewerHeader, { data: { ...base, actualsChangedAt: ACT } }),
    );
    expect(html).toContain("actuals entered");
  });
});
