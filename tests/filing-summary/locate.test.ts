import { describe, it, expect } from "vitest";
import {
  normalizeForMatch,
  locateQuote,
  secArchiveUrl,
  textFragmentUrl,
  toFootnote,
} from "@/lib/filing-summary/locate";
import type { DocText, ModelCitation, TextBlock } from "@/lib/filing-summary/types";

function block(index: number, text: string, extra: Partial<TextBlock> = {}): TextBlock {
  return { index, page: 1, para: index + 1, text, tableId: null, rowIndex: null, ...extra };
}
function doc(blocks: TextBlock[], pageBreaksReliable = true): DocText {
  return { extractorVersion: 1, pageCount: 3, pageBreaksReliable, blocks, tables: [], documentScaleNote: null };
}
function cite(quote: string, document = "a.htm", isTableRow = false): ModelCitation {
  return { id: "c1", document, quote, isTableRow };
}

describe("normalizeForMatch", () => {
  it("folds quotes, dashes, whitespace and case", () => {
    expect(normalizeForMatch("  “Revenue”—up  5\n%  ")).toBe('"revenue"-up 5 %');
    expect(normalizeForMatch("a − b – c")).toBe("a - b - c");
    expect(normalizeForMatch("it’s")).toBe("it's");
  });
});

describe("locateQuote", () => {
  const d = doc([
    block(0, "Revenue was “strong” — up 12% from last year. Margins grew."),
    block(1, "Other   text   here."),
  ]);
  it("finds through curly quotes and dashes", () => {
    const r = locateQuote([{ fileName: "a.htm", text: d }], cite('Revenue was "strong" - up 12% from last year.'));
    expect(r.status).toBe("found");
    expect(r.block?.index).toBe(0);
    expect(r.fileName).toBe("a.htm");
    expect(r.sentence).toBe("Revenue was “strong” — up 12% from last year.");
  });
  it("tolerates whitespace differences", () => {
    const r = locateQuote([{ fileName: "a.htm", text: d }], cite("other text here."));
    expect(r.status).toBe("found");
    expect(r.block?.index).toBe(1);
  });
  it("ambiguous when two blocks hold it", () => {
    const dd = doc([block(0, "Same sentence here."), block(1, "Same sentence here.")]);
    expect(locateQuote([{ fileName: "a.htm", text: dd }], cite("same sentence here")).status).toBe("ambiguous");
  });
  it("not_found when absent", () => {
    const r = locateQuote([{ fileName: "a.htm", text: d }], cite("nothing like this"));
    expect(r).toEqual({ status: "not_found", fileName: null, block: null, sentence: null });
  });
  it("matches a quote spanning two adjacent blocks on the first", () => {
    const dd = doc([block(0, "The company expects"), block(1, "growth next year."), block(2, "Unrelated.")]);
    const r = locateQuote([{ fileName: "a.htm", text: dd }], cite("company expects growth next year"));
    expect(r.status).toBe("found");
    expect(r.block?.index).toBe(0);
  });
  it("falls back to other documents when the cited one has none", () => {
    const other = doc([block(0, "Unique phrase lives here.")]);
    const r = locateQuote(
      [{ fileName: "a.htm", text: d }, { fileName: "b.htm", text: other }],
      cite("unique phrase lives here"),
    );
    expect(r.status).toBe("found");
    expect(r.fileName).toBe("b.htm");
  });
  it("ambiguous across several other documents", () => {
    const o1 = doc([block(0, "Twin line.")]);
    const o2 = doc([block(0, "Twin line.")]);
    const r = locateQuote(
      [{ fileName: "a.htm", text: d }, { fileName: "b.htm", text: o1 }, { fileName: "c.htm", text: o2 }],
      cite("twin line"),
    );
    expect(r.status).toBe("ambiguous");
  });
  it("prefers the cited document", () => {
    const o = doc([block(0, "Twin line.")]);
    const a = doc([block(0, "Twin line.")]);
    const r = locateQuote([{ fileName: "b.htm", text: o }, { fileName: "a.htm", text: a }], cite("twin line"));
    expect(r.status).toBe("found");
    expect(r.fileName).toBe("a.htm");
  });
  it("locates a table row by ordered cells", () => {
    const t = doc([
      block(0, "Intro."),
      block(1, "Revenue | 64,601 | 51,242", { tableId: 0, rowIndex: 0 }),
      block(2, "Cost | 10 | 20", { tableId: 0, rowIndex: 1 }),
    ]);
    const r = locateQuote([{ fileName: "a.htm", text: t }], cite("Revenue | 64,601 | 51,242", "a.htm", true));
    expect(r.status).toBe("found");
    expect(r.block?.index).toBe(1);
    const r2 = locateQuote([{ fileName: "a.htm", text: t }], cite("Revenue | 51,242 | 64,601", "a.htm", true));
    expect(r2.status).toBe("not_found");
    const r3 = locateQuote([{ fileName: "a.htm", text: t }], cite("Revenue | 64,601", "a.htm", true));
    expect(r3.status).toBe("found");
  });
});

describe("secArchiveUrl", () => {
  it("builds the archive URL", () => {
    expect(secArchiveUrl("0001045810", "0001045810-26-000123", "nvda-8k.htm")).toBe(
      "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/nvda-8k.htm",
    );
  });
  it("rejects bad parts", () => {
    expect(() => secArchiveUrl("1", "0001045810-26-000123", "../x")).toThrow();
    expect(() => secArchiveUrl("1", "000104581026000123", "x.htm")).toThrow();
    expect(() => secArchiveUrl("a1", "0001045810-26-000123", "x.htm")).toThrow();
  });
});

describe("textFragmentUrl", () => {
  it("uses the whole short sentence", () => {
    expect(textFragmentUrl("https://x/y", "Hello, world")).toBe("https://x/y#:~:text=Hello%2C%20world");
  });
  it("uses start,end for long sentences and encodes - and ,", () => {
    const s = "one two three four five six seven eight nine ten eleven twelve thirteen, fourteen-x";
    const u = textFragmentUrl("https://x/y", s);
    expect(u).toBe(
      "https://x/y#:~:text=one%20two%20three%20four%20five%20six%20seven%20eight,eleven%20twelve%20thirteen%2C%20fourteen%2Dx",
    );
  });
});

describe("toFootnote", () => {
  const cik = "0001045810";
  const acc = "0001045810-26-000123";
  const b = block(0, "Revenue was strong.", { page: 4, para: 9 });
  const found = { status: "found" as const, fileName: "a.htm", block: b, sentence: "Revenue was strong." };
  it("found with page", () => {
    const f = toFootnote(cik, acc, cite("x"), found, true);
    expect(f).toMatchObject({ status: "found", page: 4, para: 9, document: "a.htm", sentence: "Revenue was strong." });
    expect(f.url).toContain("#:~:text=");
  });
  it("page null when breaks unreliable", () => {
    expect(toFootnote(cik, acc, cite("x"), found, false).page).toBeNull();
  });
  it("not_found has plain url, no page", () => {
    const f = toFootnote(cik, acc, cite("x"), { status: "not_found", fileName: null, block: null, sentence: null }, true);
    expect(f).toMatchObject({ status: "not_found", page: null, para: null, sentence: null });
    expect(f.url).toBe("https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/a.htm");
  });
});
