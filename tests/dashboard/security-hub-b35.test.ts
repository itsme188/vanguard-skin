/**
 * Security hub page fixes (unit B35). The page reads the real db singleton at
 * module scope, so page behaviour is pinned two ways: the extracted pure
 * helpers are unit-tested, and the markup is source-pinned with anchorIndex
 * (a vanished anchor fails loudly). Synthetic fixtures only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import {
  assetClassLabel,
  transcriptPreviewText,
  type SecurityDetailTransaction,
} from "@/lib/queries/security-detail";
import { countTransactionScopes } from "@/app/dashboard/components/TransactionsSection";

const page = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
const txnSrc = readFileSync("app/dashboard/components/TransactionsSection.tsx", "utf8");

function between(src: string, startNeedle: string, endNeedle: string): string {
  const start = anchorIndex(src, startNeedle);
  return src.slice(start, anchorIndex(src, endNeedle, start + startNeedle.length));
}

// qa: security-detail-transcripts--truncated-preview-no-expand-regression-1
describe("transcript card preview text", () => {
  it("a desk note: skips the '#' title and strips the markdown markers", () => {
    const note = [
      "# Acme (AAA) - Q2 2026 Earnings Desk Note",
      "",
      "**Guidance**",
      "- Q3 revenue raised to a higher range",
      "- Margin outlook unchanged",
      "",
      "**Tone**",
      "- Confident",
    ].join("\n");
    const out = transcriptPreviewText(note);
    expect(out.startsWith("Guidance: Q3 revenue raised to a higher range")).toBe(true);
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out).not.toContain("Desk Note");
  });

  it("an inline bold label keeps its text", () => {
    expect(transcriptPreviewText("- **Guidance**: raised for the year")).toBe(
      "Guidance: raised for the year"
    );
  });

  it("a call excerpt: skips the operator's logistics turn and starts at the next speaker", () => {
    const excerpt =
      "Operator (Operator): Thank you for standing by, and welcome to the call. " +
      "To ask a question, press star one. Jane Doe (Chief Executive Officer): " +
      "Thanks, everyone. Demand was strong across the quarter.";
    const out = transcriptPreviewText(excerpt);
    expect(out.startsWith("Jane Doe (Chief Executive Officer): Thanks, everyone.")).toBe(true);
    expect(out).not.toContain("press star one");
  });

  it("skips a second operator turn too", () => {
    const excerpt =
      "Operator (Operator): Welcome. Operator (Operator): One moment please. " +
      "John Roe (CFO): Revenue grew.";
    expect(transcriptPreviewText(excerpt)).toBe("John Roe (CFO): Revenue grew.");
  });

  it("an operator-only excerpt falls back to the text rather than an empty card", () => {
    const excerpt = "Operator (Operator): Thank you for standing by.";
    expect(transcriptPreviewText(excerpt)).toBe(excerpt);
  });

  it("cuts a long preview on a word boundary", () => {
    const out = transcriptPreviewText("word ".repeat(300), 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });

  it("empty input gives an empty string", () => {
    expect(transcriptPreviewText(null)).toBe("");
    expect(transcriptPreviewText("   ")).toBe("");
  });
});

describe("hub page source: transcript and note cards expand", () => {
  it("a transcript card with a summary is a <details> with read / collapse and a rendered desk note", () => {
    const row = between(page, "function TranscriptRow(", "function TranscriptList(");
    expect(row).toContain("<details");
    expect(row).toContain("read ▾");
    expect(row).toContain("collapse ▴");
    expect(row).toContain("transcriptPreviewText(t.summary)");
    expect(row).toContain("<MarkdownMessage content={t.summary} />");
    // Kind comes from the shared presentation helpers, never the raw source.
    expect(row).toContain("kindLabel(t)");
    expect(row).not.toContain("t.source");
  });

  // qa: security-detail-notes--hub-cards-2-line-clamp-no-expander
  it("a long note is a <details> whose open state shows the whole note, still masked", () => {
    const notes = between(page, "{/* Notes & Theses */}", "{/* Research Documents");
    expect(notes).toContain("<details");
    expect(notes).toContain("read ▾");
    expect(notes).toContain("collapse ▴");
    expect(notes).toContain("line-clamp-2");
    expect(notes).toContain("whitespace-pre-wrap");
    // One masked node feeds the clamped copy, the open copy and the short
    // note, so no copy can be left unmasked.
    expect(notes).toContain("const noteBody = <PrivateText>{note.content}</PrivateText>;");
    const open = notes.slice(anchorIndex(notes, "whitespace-pre-wrap"));
    expect(open).toContain("{noteBody}");
    expect(notes.match(/note\.content\}/g)).toHaveLength(1);
  });
});

// qa: security-detail-header--raw-broker-asset-class-code-stk-opt-regression-1
describe("assetClassLabel", () => {
  it("maps broker contract codes and lower-case synonyms to one label", () => {
    expect(assetClassLabel("STK")).toBe("Equity");
    expect(assetClassLabel("stk")).toBe("Equity");
    expect(assetClassLabel("equity")).toBe("Equity");
    expect(assetClassLabel("OPT")).toBe("Option");
    expect(assetClassLabel("option")).toBe("Option");
    expect(assetClassLabel(" Opt ")).toBe("Option");
  });

  it("keeps a value it does not know, and returns null for nothing", () => {
    expect(assetClassLabel("Forecast Contracts")).toBe("Forecast Contracts");
    expect(assetClassLabel(null)).toBeNull();
    expect(assetClassLabel("  ")).toBeNull();
  });

  it("the header label goes through it", () => {
    const label = between(page, "const typeLabel =", "return (");
    expect(label).toContain("assetClassLabel(security.asset_class)");
    expect(label).not.toMatch(/^\s*security\.asset_class,\s*$/m);
  });
});

// qa: security-detail-empty-state--no-portfolio-data-under-populated-transactions
describe("hub page source: the 'No portfolio data' empty state", () => {
  it("does not render when option transactions, sales or expired lots are on the page", () => {
    const start = anchorIndex(page, "{/* Empty state — no positions, no data */}");
    const cond = page.slice(start, anchorIndex(page, "No portfolio data for", start));
    expect(cond).toContain("recentTransactions.length === 0");
    expect(cond).toContain("relatedOptionTransactions.length === 0");
    expect(cond).toContain("closedSales.length === 0");
    expect(cond).toContain("expiredOptionLotsAwaitingClose.length === 0");
  });
});

describe("hub page source: Open Tax Lots", () => {
  const lots = between(page, "{/* Tax Lots */}", "{/* Closed Sales */}");

  // qa: security-detail-lot-coverage-note--singular-contract-plural-verb
  it("the coverage note has no verb that must agree with the quantity", () => {
    expect(lots).not.toContain("have no cost-basis history");
    expect(lots).toContain("no cost-basis history for");
  });

  // qa: security-detail-open-tax-lots--zero-count-header-only-table-contracts-called-shares
  it("zero lots renders a sentence, not a header-only table", () => {
    expect(lots).toMatch(/openTaxLots\.length === 0 \? \(/);
    expect(lots).toContain("No open tax lots on record");
    expect(lots).toContain("<QuantityUnit securityType={security.security_type}");
  });
});

function txn(over: Partial<SecurityDetailTransaction>): SecurityDetailTransaction {
  return {
    id: 1,
    account_name: "Acct One",
    type: "BUY",
    option_type: null,
    security_type: "Stock",
    ...over,
  } as SecurityDetailTransaction;
}

// qa: security-detail-transactions--options-chip-count-ignores-account-filter
describe("transaction type chips count what they return", () => {
  const rows = [
    txn({ id: 1, account_name: "Acct One", type: "BUY" }),
    txn({ id: 2, account_name: "Acct One", type: "SELL_TO_OPEN", option_type: "CALL", security_type: "Option" }),
    txn({ id: 3, account_name: "Acct Two", type: "BUY_TO_OPEN", option_type: "PUT", security_type: "Option" }),
    txn({ id: 4, account_name: "Acct Two", type: "SELL_TO_CLOSE", option_type: "PUT", security_type: "Option" }),
    txn({ id: 5, account_name: "Acct Two", type: "DIVIDEND" }),
  ];

  it("all accounts", () => {
    expect(countTransactionScopes(rows, "All")).toEqual({ all: 5, stocks: 2, options: 3 });
  });

  it("one account: the counts follow the account filter", () => {
    expect(countTransactionScopes(rows, "Acct One")).toEqual({ all: 2, stocks: 1, options: 1 });
    expect(countTransactionScopes(rows, "Acct Two")).toEqual({ all: 3, stocks: 1, options: 2 });
  });

  it("the chips read those counts, and Stocks carries one too", () => {
    expect(txnSrc).toContain("label={`Stocks (${scopeCounts.stocks})`}");
    expect(txnSrc).toContain("label={`Options (${scopeCounts.options})`}");
    expect(txnSrc).not.toContain("Options (${optionTransactions.length})");
  });
});

// qa: mobile-security-detail-transactions--option-labels-wrap-five-lines-15000px-table
describe("transactions table: option labels stay on one line", () => {
  it("the Security cell and the option label do not wrap", () => {
    const label = txnSrc.slice(anchorIndex(txnSrc, "function OptionLabel("));
    expect(label).not.toContain("flex-wrap");
    expect(label).toContain("whitespace-nowrap");
    const cell = between(txnSrc, "<OptionLabel txn={t} />", "</td>");
    expect(cell).toBeDefined();
    expect(txnSrc).toMatch(/<td className=\{`\$\{TD_CLASS\} whitespace-nowrap`\}>\s*\{isOpt \?/);
  });
});
