import { describe, expect, it } from "vitest";
import { failoverBanner } from "@/lib/filing-summary/ran-on";

/**
 * The failover banner counts honestly: a run whose every finished section
 * was written by the fallback model says so, next to a header that already
 * names that model
 * [qa:filing-summary-failover-banner-today-xmtr-2301-panel-and-dashboard-print-2301-filings-failover-banner-says-som].
 */
describe("failoverBanner", () => {
  const who = "OpenAI gpt-6-astra";

  it("one section of one: 'the section was'", () => {
    const text = failoverBanner([who], "billing", 1);
    expect(text).toContain("the section was written by OpenAI gpt-6-astra");
    expect(text).not.toContain("some sections");
  });

  it("every section of several: 'every section was'", () => {
    const text = failoverBanner([who, who], "billing", 2);
    expect(text).toContain("every section was written by OpenAI gpt-6-astra");
    expect(text).not.toContain("some sections");
  });

  it("a part of the run: 'N of M sections were'", () => {
    const text = failoverBanner([who], "auth", 3);
    expect(text).toContain("1 of 3 sections were written by OpenAI gpt-6-astra");
    expect(text).toContain("(key rejected)");
  });

  it("two fallback models are both named once", () => {
    const text = failoverBanner([who, "Cloudflare Workers AI llama", who], "config", 3);
    expect(text).toContain("every section was written by OpenAI gpt-6-astra and Cloudflare Workers AI llama");
  });
});
