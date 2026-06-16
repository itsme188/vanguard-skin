import { describe, it, expect } from "vitest";
import {
  classifyForwardedEmail,
  extractArticleUrls,
  type ParsedForwardedEmail,
  type ForwardedAttachment,
} from "@/lib/research-inbox/classify";

function att(filename: string, mimeType: string): ForwardedAttachment {
  return { filename, mimeType, bytes: new Uint8Array([1, 2, 3]) };
}
function email(p: Partial<ParsedForwardedEmail>): ParsedForwardedEmail {
  return { subject: null, from: null, bodyText: "", attachments: [], ...p };
}

describe("extractArticleUrls", () => {
  it("pulls http(s) links and drops noise (unsubscribe, trailing punctuation)", () => {
    const text =
      "Check this out: https://example.com/great-read. Also https://x.com/unsubscribe?u=1 and mailto:a@b.com";
    expect(extractArticleUrls(text)).toEqual(["https://example.com/great-read"]);
  });
});

describe("classifyForwardedEmail", () => {
  it("emits one pdf job per PDF attachment (attachments win)", () => {
    const jobs = classifyForwardedEmail(
      email({
        bodyText: "fyi",
        attachments: [att("report.pdf", "application/pdf"), att("deck.pdf", "application/pdf")],
      }),
    );
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.kind === "pdf")).toBe(true);
  });

  it("emits an image job for a screenshot attachment", () => {
    const jobs = classifyForwardedEmail(
      email({ attachments: [att("Screenshot.png", "image/png")] }),
    );
    expect(jobs).toEqual([{ kind: "image", attachment: expect.objectContaining({ filename: "Screenshot.png" }) }]);
  });

  it("classifies a short 'here's a link' email as a link job", () => {
    const jobs = classifyForwardedEmail(
      email({ bodyText: "worth a read https://example.com/post" }),
    );
    expect(jobs).toEqual([{ kind: "link", url: "https://example.com/post", note: "worth a read https://example.com/post" }]);
  });

  it("classifies a long body (no attachment, no dominant link) as a long-read body job", () => {
    const long = "Lorem ipsum ".repeat(40); // ~480 chars
    const jobs = classifyForwardedEmail(email({ bodyText: long }));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("body");
  });

  it("prefers the link when a long body is essentially a URL wrapper but thin", () => {
    // body under BODY_MIN with a link → link
    const jobs = classifyForwardedEmail(email({ bodyText: "https://example.com/x" }));
    expect(jobs[0].kind).toBe("link");
  });

  it("returns no jobs for an empty/blank email", () => {
    expect(classifyForwardedEmail(email({ bodyText: "  " }))).toEqual([]);
  });

  it("ignores non-pdf/non-image attachments", () => {
    const jobs = classifyForwardedEmail(
      email({ bodyText: "see attached invite", attachments: [att("invite.ics", "text/calendar")] }),
    );
    // falls through to body (but body too short) → no jobs
    expect(jobs).toEqual([]);
  });
});
