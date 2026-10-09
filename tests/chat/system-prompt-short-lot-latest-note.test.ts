/**
 * Two reading rules the chat prompt gives the model for tool rows.
 *
 * 1. `query_tax_lots` marks an open lot `position_side: "short"`. The tool
 *    description and the row's status note (`SHORT_LOT_CHAT_NOTE`) say how to
 *    read it; the prompt's own tax-lot guidance said nothing, and its
 *    harvesting and long-term language is written for long lots.
 * 2. `query_earnings_transcript` answers `latest_confirmed: false` with a
 *    `latest_note` when the document could not be tied to the issuer's most
 *    recent print. The prompt told the model to quote "the latest earnings
 *    data" and never mentioned the flag.
 *
 * The wording is pinned loosely (the facts, not the sentence) and checked
 * against the status note the tool attaches, so the two cannot drift apart.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";
import { SHORT_LOT_CHAT_NOTE } from "@/lib/queries/chat-tools";

const PORTFOLIO_SCOPES = ["all", "ibkr", "vanguard-taxable", "vanguard-roth-ira"] as const;
const prompt = (scope: (typeof PORTFOLIO_SCOPES)[number]) =>
  buildSystemPrompt("## Portfolio Summary\n- Test data", "2026-03-17", scope);

function lineWith(text: string, needle: string): string {
  const line = text.split("\n").find((l) => l.includes(needle));
  expect(line, `no prompt line mentions ${needle}`).toBeDefined();
  return line as string;
}

describe("chat prompt: an open short lot", () => {
  it.each(PORTFOLIO_SCOPES)("%s: one line says how to read position_side short", (scope) => {
    const line = lineWith(prompt(scope), 'position_side');
    expect(line).toContain('"short"');
    // The gain is already signed for the short side: no sign flip by the model.
    expect(line).toMatch(/unrealized_gain is already signed for the short side/);
    // Closing a short is a purchase.
    expect(line).toMatch(/buying to cover/);
    // Never long-term, never approaching it.
    expect(line).toMatch(/never long-term/);
    expect(line).toMatch(/approaching long-term/);
  });

  it("sits in the ground-truth tax-lot guidance, after the open-lot ownership rule", () => {
    const text = prompt("all");
    const ground = text.indexOf("## Ground Truth Rules");
    const nextSection = text.indexOf("## Data Quality Awareness");
    const at = text.indexOf("position_side");
    expect(at).toBeGreaterThan(text.indexOf("quantity_remaining > 0"));
    expect(at).toBeGreaterThan(ground);
    expect(at).toBeLessThan(nextSection);
  });

  it("agrees with the status note the tool attaches to a short lot", () => {
    // Both must state the same three facts.
    for (const fact of [/signed for the short side/, /buying to cover/]) {
      expect(SHORT_LOT_CHAT_NOTE).toMatch(fact);
      expect(lineWith(prompt("all"), "position_side")).toMatch(fact);
    }
    expect(SHORT_LOT_CHAT_NOTE).toMatch(/short-term however long/);
  });

  it("macro mode has no tax-lot guidance and does not gain the line", () => {
    expect(buildSystemPrompt("", "2026-03-17", "macro")).not.toContain("position_side");
  });
});

describe("chat prompt: a transcript not confirmed as the latest", () => {
  it.each(PORTFOLIO_SCOPES)("%s: says to relay latest_note before quoting the document", (scope) => {
    const text = prompt(scope);
    const line = lineWith(text, "latest_confirmed");
    expect(line).toContain("latest_confirmed: false");
    expect(line).toContain("latest_note");
    expect(line).toMatch(/before quoting/);
    const section = text.indexOf("## Earnings Intelligence");
    expect(text.indexOf("latest_confirmed")).toBeGreaterThan(section);
    expect(text.indexOf("latest_confirmed")).toBeLessThan(text.indexOf("## Wash Sale Awareness"));
  });
});
