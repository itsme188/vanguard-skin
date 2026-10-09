/**
 * BogeysUploadButton — what the outcome line says, and when a rejection
 * clears (qa: match-success-unnamed-off-week-invisible, bare-zero-matched-
 * no-explanation, pdf-validation-error-never-clears). No DOM harness in this
 * repo: the wording is a pure function, the handlers are pinned from source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { describeUploadOutcome } from "@/app/dashboard/today/BogeysUploadButton";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const text = (r: Parameters<typeof describeUploadOutcome>[0], file = "sheet.pdf") =>
  describeUploadOutcome(r, file).map((l) => l.text);

describe("describeUploadOutcome", () => {
  it("names the file when nothing was extracted, instead of a bare 0/0", () => {
    const lines = describeUploadOutcome({ symbolsExtracted: 0, eventsMatched: 0, eventsUnmatched: [], results: [] }, "sheet.pdf");
    expect(lines).toEqual([
      {
        text: "No tickers found in sheet.pdf — it may be blank, unreadable or not an earnings sheet. Nothing was stored.",
        tone: "warn",
      },
    ]);
  });

  it("names every symbol it saved bogeys for", () => {
    expect(
      text({
        symbolsExtracted: 2,
        eventsMatched: 2,
        eventsUnmatched: [],
        results: [
          { symbol: "AAA", eventId: 11, bogeyId: 5 },
          { symbol: "ZZZ", eventId: 12, bogeyId: 6 },
        ],
      }),
    ).toEqual(["2/2 matched", "bogeys saved for AAA, ZZZ"]);
  });

  it("shows the event's own date when the route supplies it", () => {
    expect(
      text({
        symbolsExtracted: 1,
        eventsMatched: 1,
        results: [{ symbol: "AAA", eventId: 11, bogeyId: 5, eventDate: "2026-09-07" }],
      }),
    ).toEqual(["1/1 matched", "bogeys saved for AAA (Sep 7)"]);
  });

  it("says so when a matched symbol had no figure to store (bogeyId 0)", () => {
    const lines = describeUploadOutcome(
      {
        symbolsExtracted: 2,
        eventsMatched: 2,
        results: [
          { symbol: "AAA", eventId: 11, bogeyId: 5 },
          { symbol: "ZZZ", eventId: 12, bogeyId: 0 },
        ],
      },
      "sheet.pdf",
    );
    expect(lines.map((l) => l.text)).toEqual([
      "2/2 matched",
      "bogeys saved for AAA",
      "no figures found for ZZZ — nothing stored",
    ]);
    expect(lines[2].tone).toBe("warn");
  });

  it("keeps naming the unmatched symbols", () => {
    const lines = describeUploadOutcome(
      { symbolsExtracted: 2, eventsMatched: 0, eventsUnmatched: ["AAA", "ZZZ"], results: [
        { symbol: "AAA", eventId: null }, { symbol: "ZZZ", eventId: null },
      ] },
      "sheet.pdf",
    );
    expect(lines).toEqual([
      { text: "0/2 matched", tone: "plain" },
      { text: "AAA, ZZZ unmatched", tone: "warn" },
    ]);
  });
});

describe("BogeysUploadButton — a rejection clears on the next interaction", () => {
  const src = readFileSync("app/dashboard/today/BogeysUploadButton.tsx", "utf8");

  it("re-opening the chooser clears the message before the chooser opens", () => {
    const click = anchorIndex(src, "fileInputRef.current?.click()");
    const handler = src.slice(src.lastIndexOf("onClick", click), click);
    expect(handler).toContain("setError(null)");
  });

  it("a chooser closed with no file clears it too", () => {
    const start = anchorIndex(src, "const f = e.target.files?.[0];");
    expect(src.slice(start, start + 120)).toMatch(/else setError\(null\)/);
  });

  it("the message carries its own dismiss control", () => {
    const start = anchorIndex(src, "{error && (");
    const block = src.slice(start, start + 520);
    expect(block).toContain('role="alert"');
    expect(block).toContain("onClick={() => setError(null)}");
    expect(block).toContain('aria-label="Dismiss this message"');
  });

  it("renders the described outcome, not a bare count", () => {
    expect(src).toContain("describeUploadOutcome(result.data, result.fileName)");
  });
});
