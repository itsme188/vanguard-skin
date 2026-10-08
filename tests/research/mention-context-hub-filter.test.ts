/**
 * Security hub · Research Mentions (pure helpers in lib/research/mention-context.ts).
 *
 * qa: security-detail-research-mentions--legacy-placeholder-rows-fail-word-boundary-filter-section-hidden
 * qa: security-detail-research-mentions--excerpt-renders-opaque-tracking-token
 * qa: security-detail-research-mentions--caps-at-5-prints-3-of-5-filtered-while-hundreds-exist
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MENTION_CONTEXT_PLACEHOLDER,
  displayableMentionContext,
  filterHubMentions,
  mentionsHeading,
  stripOpaqueTokens,
} from "@/lib/research/mention-context";
import { anchorIndex } from "../helpers/source-anchor";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Synthetic: 43 characters of the base64url alphabet, mixed case + digits.
const TOKEN = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kM9nP2r";

describe("filterHubMentions", () => {
  const row = (mention_context: string | null, subject = "Morning wrap") => ({
    mention_context,
    subject,
  });

  it("keeps a legacy placeholder row exactly like a NULL-excerpt row", () => {
    const rows = [row(MENTION_CONTEXT_PLACEHOLDER), row(null)];
    expect(filterHubMentions("ZZZ", rows)).toHaveLength(2);
  });

  it("keeps a subject-line backstop row (a diagnostic string, not an excerpt)", () => {
    const rows = [row('Subject-line backstop match: "Weekly wrap"', "Weekly wrap")];
    expect(filterHubMentions("ZZZ", rows)).toHaveLength(1);
  });

  it("still drops a real excerpt that only contains the ticker inside a longer word", () => {
    expect(filterHubMentions("NET", [row("The internet backbone build-out continues.")])).toEqual([]);
    expect(filterHubMentions("NET", [row("NET raised its outlook this quarter.")])).toHaveLength(1);
  });

  it("still drops a URL-fragment excerpt", () => {
    expect(filterHubMentions("NET", [row("net/assets/images/resources//section1.")])).toEqual([]);
  });
});

describe("tracking tokens in an excerpt", () => {
  it("removes the token and the bracket debris after it, keeping the prose", () => {
    expect(displayableMentionContext(`${TOKEN} ] Lots to get to. ZZZ: upgraded to Outperform.`)).toBe(
      "Lots to get to. ZZZ: upgraded to Outperform.",
    );
    expect(stripOpaqueTokens(`Intro ${TOKEN} ]) Compute and edge`)).toBe("Intro Compute and edge");
  });

  it("returns null when the token was the whole excerpt", () => {
    expect(displayableMentionContext(`${TOKEN} ]`)).toBeNull();
  });

  it("leaves long ordinary words, hyphenated phrases and numbers alone", () => {
    for (const s of [
      "A state-of-the-art-next-generation-accelerator ships in 2027.",
      "Pneumonoultramicroscopicsilicovolcanoconiosis is a long word.",
      "Order 1234567890123456789012345678901234567890 shipped.",
      "ZZZ raised its price target (to $125) [see note].",
    ]) {
      expect(displayableMentionContext(s)).toBe(s);
    }
  });
});

describe("mentionsHeading", () => {
  it("prints no count when the true total is unknown — the loaded rows are a LIMIT, not a population", () => {
    expect(mentionsHeading(3, undefined)).toEqual({ title: "Research Mentions", subtitle: "Latest 3" });
    expect(mentionsHeading(3, null).title).toBe("Research Mentions");
  });

  it("shows the true total and how many of it are on screen", () => {
    expect(mentionsHeading(3, 500)).toEqual({
      title: "Research Mentions · 500",
      subtitle: "Showing 3 of 500",
    });
    expect(mentionsHeading(4, 4)).toEqual({ title: "Research Mentions · 4", subtitle: "All 4" });
  });

  it("ignores a total smaller than what is shown (stale or wrong count)", () => {
    expect(mentionsHeading(5, 2).title).toBe("Research Mentions");
  });
});

describe("source pins — ResearchMentionsSection", () => {
  const src = read("app/dashboard/components/ResearchMentionsSection.tsx");

  it("filters through the shared helper and never prints the old 'of N — filtered' line", () => {
    anchorIndex(src, "filterHubMentions(ticker, mentions)");
    anchorIndex(src, "mentionsHeading(filtered.length, totalCount)");
    expect(src).not.toContain("— filtered");
  });

  it("explains an all-filtered list instead of vanishing", () => {
    const at = anchorIndex(src, "if (filtered.length === 0) {");
    expect(src.slice(at, at + 200)).toContain("<EmptySection");
  });

  it("scopes the feeds link to the symbol", () => {
    anchorIndex(src, "/dashboard/research?view=feeds&symbol=${encodeURIComponent(ticker)}");
  });
});

describe("source pin — ResearchDocumentsPanel", () => {
  // qa: security-detail-research-documents--view-all-drops-security-filter
  it("carries the symbol on the View all link", () => {
    anchorIndex(
      read("app/dashboard/components/ResearchDocumentsPanel.tsx"),
      "/dashboard/research?view=documents&symbol=${encodeURIComponent(symbol)}",
    );
  });
});
