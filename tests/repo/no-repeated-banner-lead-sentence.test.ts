/**
 * QA 2026-09-12 (qa:analysis-giving--recompute-banner-repeats-sentence-verbatim):
 * pending-recompute banners render a bold "lead" sentence followed by a body
 * sentence — GivingView.tsx's conventionPending banner repeated the lead
 * sentence verbatim as the FIRST sentence of the body too:
 *
 *   "Cost-basis figures are pending a recompute." (bold lead)
 *   "Cost-basis figures are pending a recompute under the corrected dollar
 *    convention and may be unit-inconsistent until the next recompute
 *    completes." (body — repeats the lead almost word-for-word)
 *
 * This repo has no DOM test harness (no jsdom/RTL), so this is a
 * source-pin test: it reads the banner JSX block directly out of the .tsx
 * source and asserts the body does not START with the bold lead sentence
 * (punctuation-insensitive, since the lead's trailing "." never survives
 * into a body that continues the same clause with "under..."/"because...").
 *
 * TradeReviewView.tsx's sibling banners (narrativeStale, pairingsStale,
 * conventionPending) were checked by hand and do NOT repeat their lead
 * sentence — they are included here as a regression guard so a future edit
 * can't reintroduce the same copy bug.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameLocal, "../..");

interface LeadBanner {
  lead: string;
  body: string;
}

/**
 * Extracts every `<p ...>...</p>` block that contains a bold
 * `text-gold-ink font-medium` lead span, paired with the (whitespace-
 * normalized) body text that follows the span inside the same paragraph.
 * Generic across files — used on both GivingView.tsx and TradeReviewView.tsx.
 */
function extractLeadBanners(src: string): LeadBanner[] {
  const results: LeadBanner[] = [];
  const pRegex = /<p className="text-xs text-ink-dim leading-5">([\s\S]*?)<\/p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRegex.exec(src))) {
    const paragraph = pMatch[1];
    const leadRegex = /<span className="text-gold-ink font-medium">\s*([^<]+?)\s*<\/span>/;
    const leadMatch = leadRegex.exec(paragraph);
    if (!leadMatch) continue;
    const lead = leadMatch[1].trim().replace(/\s+/g, " ");
    const bodyRaw = paragraph.slice(leadMatch.index + leadMatch[0].length);
    const body = bodyRaw
      .replace(/\{"\s*"\}/g, " ") // the JSX literal-space expression between span and body
      .replace(/\s+/g, " ")
      .trim();
    results.push({ lead, body });
  }
  return results;
}

/** True when the body opens by restating the lead sentence verbatim. */
function bodyRepeatsLead({ lead, body }: LeadBanner): boolean {
  const leadCore = lead.replace(/[.!?]+$/, "");
  return body.startsWith(leadCore);
}

/**
 * Banner paragraphs with NO bold lead span (e.g. TradeReviewView's
 * pairingsStale banner) are invisible to extractLeadBanners. Collect their
 * text so a sentence repeated inside the same paragraph is still caught.
 */
function extractLeadlessBannerSentences(src: string): string[][] {
  const out: string[][] = [];
  const pRegex = /<p className="text-xs text-ink-dim leading-5">([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(src))) {
    if (/<span className="text-gold-ink font-medium">/.test(m[1])) continue;
    const text = m[1].replace(/\{"\s*"\}/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push(text.split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
  }
  return out;
}

describe("pending-recompute banners do not repeat their lead sentence", () => {
  it("self-test: flags a body that restates the lead, clears a body that continues it", () => {
    const repeatedParagraph = `<p className="text-xs text-ink-dim leading-5">
      <span className="text-gold-ink font-medium">
        Figures are pending a recompute.
      </span>{" "}
      Figures are pending a recompute under the new convention and may be stale.
    </p>`;
    const cleanParagraph = `<p className="text-xs text-ink-dim leading-5">
      <span className="text-gold-ink font-medium">
        Figures are pending a recompute.
      </span>{" "}
      They were computed under an earlier convention and may be stale.
    </p>`;
    const [repeated] = extractLeadBanners(repeatedParagraph);
    const [clean] = extractLeadBanners(cleanParagraph);
    expect(bodyRepeatsLead(repeated)).toBe(true);
    expect(bodyRepeatsLead(clean)).toBe(false);
  });

  for (const rel of [
    "app/dashboard/components/giving/GivingView.tsx",
    "app/dashboard/components/TradeReviewView.tsx",
  ]) {
    it(`${rel} — every bold-lead banner's body continues rather than restates the lead`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const banners = extractLeadBanners(src);
      expect(
        banners.length,
        "expected at least one bold-lead banner in this file",
      ).toBeGreaterThan(0);
      for (const banner of banners) {
        expect(
          bodyRepeatsLead(banner),
          `banner lead "${banner.lead}" is restated verbatim at the start of its own body:\n"${banner.body}"`,
        ).toBe(false);
      }
    });
  }

  it("TradeReviewView's lead-less banners (pairingsStale) never repeat a sentence", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "app/dashboard/components/TradeReviewView.tsx"),
      "utf8",
    );
    const leadless = extractLeadlessBannerSentences(src);
    expect(leadless.length, "expected at least one lead-less banner paragraph").toBeGreaterThan(0);
    expect(
      leadless.some((s) => s.join(" ").includes("outdated or unresolved trade pairings")),
      "the pairingsStale banner paragraph was not found by the extractor",
    ).toBe(true);
    for (const sentences of leadless) {
      expect(new Set(sentences).size, `repeated sentence in: ${sentences.join(" | ")}`).toBe(sentences.length);
    }
  });
});
