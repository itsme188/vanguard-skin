/**
 * A cloud-sent earnings email has no local copy of its prose, so the viewer
 * header must not also promise that "the text below is what was sent", and
 * its Sent line names the cloud fallback rather than printing the audit
 * recipient token as if it were a mailbox (QA
 * dashboard-today-hub-ko-recap-email-viewer-cloud-sent-...).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailViewerHeader, type EmailContentResponse } from "@/app/dashboard/components/EarningsEmailViewer";

const response = (o: Partial<EmailContentResponse> = {}): EmailContentResponse => ({
  title: "ACME Q3 Earnings Recap — Oct 27, 2026",
  sentAt: "2026-10-27 15:45:00",
  sentTo: "isaac@example.com",
  eventDate: "2026-10-27",
  symbol: "ACME",
  phase: "recap",
  sentBy: "local",
  fullHtml: "<p>body</p>",
  deliveryState: "sent",
  ...o,
});

const render = (data: EmailContentResponse) => renderToStaticMarkup(createElement(EmailViewerHeader, { data }));

describe("EmailViewerHeader — cloud-sent copy", () => {
  it("a locally sent recap still says the text below is what was sent", () => {
    const html = render(response());
    expect(html).toContain("the text below is what was sent");
    expect(html).toMatch(/>Sent [^<]*ET to isaac@example\.com/);
  });

  it("a cloud-sent recap drops that promise and names the cloud fallback as the sender", () => {
    const html = render(response({ sentBy: "cloud", deliveryState: "sent-by-cloud", sentTo: "cloud-fallback" }));
    expect(html).not.toContain("the text below is what was sent");
    expect(html).toContain("Delivered by cloud fallback — no local copy of the prose");
    expect(html).toMatch(/>Sent [^<]*ET by the cloud fallback</);
    expect(html).not.toContain("to cloud-fallback");
  });
});
