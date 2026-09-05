/**
 * GET /api/earnings/email-content now returns an additive `deliveryState`
 * ("sent" | "sent-by-cloud" | "delivery-unknown") beside `sentBy` — a
 * delivery-unknown row's `sentBy` answers "local" (true — this Mac made the
 * provider call) but that alone misleads the reader into thinking the email
 * definitely arrived. EarningsEmailViewer.tsx must declare and read the new
 * field so an unknown-delivery row's header says "Delivery unknown" instead
 * of "Sent" and shows a caveat, matching the existing sentBy === "cloud"
 * treatment.
 *
 * The viewer component itself fetches its data in a useEffect and has no
 * fixture-driven render path (and this repo has no React Testing Library
 * or jsdom — see tests/dashboard/first-pass-read.test.ts and
 * tests/dashboard/live-print-row.test.ts for the established
 * react-dom/server harness), so the header + caveat block is pulled out
 * into a small pure presentational component, `EmailViewerHeader`, that
 * takes the fetched response as a prop. This test renders that component
 * directly with three fixtures.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EmailViewerHeader,
  type EmailContentResponse,
} from "@/app/dashboard/components/EarningsEmailViewer";

const response = (o: Partial<EmailContentResponse> = {}): EmailContentResponse => ({
  title: "ACME Q3 Earnings Preview — Sep 10, 2026",
  sentAt: "2026-09-10 20:07:00",
  sentTo: "isaac@example.com",
  eventDate: "2026-09-10",
  symbol: "ACME",
  phase: "preview",
  sentBy: "local",
  fullHtml: "<p>body</p>",
  deliveryState: "sent",
  ...o,
});

const render = (data: EmailContentResponse | null) =>
  renderToStaticMarkup(createElement(EmailViewerHeader, { data }));

describe("EmailViewerHeader — deliveryState caveat (email-content route addition)", () => {
  it("a normal delivered email says 'Sent' and shows no caveat", () => {
    const html = render(response());
    expect(html).toMatch(/>Sent [^<]*ET to isaac@example\.com/);
    expect(html).not.toContain("Delivery unknown");
    expect(html).not.toContain("The provider never confirmed");
  });

  it("a sent-by-cloud email keeps the existing cloud caveat verbatim; header word stays 'Sent'", () => {
    const html = render(response({ sentBy: "cloud", deliveryState: "sent-by-cloud" }));
    expect(html).toMatch(/>Sent [^<]*ET to isaac@example\.com/);
    expect(html).toContain(
      "Delivered by cloud fallback — no local copy of the prose (scoreboard below is still live-rebuilt)",
    );
    expect(html).not.toContain("Delivery unknown");
    expect(html).not.toContain("The provider never confirmed");
  });

  it("a delivery-unknown email says 'Delivery unknown' instead of 'Sent' and shows the required caveat verbatim — sentBy is still 'local'", () => {
    const html = render(response({ sentBy: "local", deliveryState: "delivery-unknown" }));
    expect(html).toMatch(/>Delivery unknown [^<]*ET to isaac@example\.com/);
    expect(html).not.toMatch(/>Sent /);
    expect(html).toContain(
      "The provider never confirmed this email was delivered — check the mailbox or the Resend log for the message id before sending it again.",
    );
    // Body still renders — a delivery-unknown row HAS a body (checked at the
    // viewer level: fullHtml is unconditionally srcDoc'd regardless of
    // deliveryState).
    expect(response({ deliveryState: "delivery-unknown" }).fullHtml).toBe("<p>body</p>");
  });

  it("shows no sent/caveat rows before data has loaded (data is null)", () => {
    const html = render(null);
    expect(html).toContain("Earnings email");
    expect(html).not.toContain("Live preview");
    expect(html).not.toContain("Delivery unknown");
    expect(html).not.toContain("The provider never confirmed");
  });
});

describe("source pins", () => {
  const src = readFileSync("app/dashboard/components/EarningsEmailViewer.tsx", "utf8");

  it("declares deliveryState on EmailContentResponse as additive/optional", () => {
    expect(src).toMatch(
      /deliveryState\?:\s*"sent"\s*\|\s*"sent-by-cloud"\s*\|\s*"delivery-unknown"/,
    );
  });

  it("reads the literal 'delivery-unknown' state to drive the header/caveat", () => {
    expect(src).toContain('"delivery-unknown"');
  });

  it("keeps the existing sentBy === 'cloud' caveat text unchanged", () => {
    // Source wraps this across two JSX lines; collapse whitespace before
    // comparing (the rendered-HTML assertions above already check the
    // actual browser-visible, single-run text).
    expect(src.replace(/\s+/g, " ")).toContain(
      "Delivered by cloud fallback — no local copy of the prose (scoreboard below is still live-rebuilt)",
    );
  });
});
