import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  layoutAfterGeneration,
  emptyWindowMessage,
  formatSince,
} from "@/app/dashboard/components/DigestEmailViewer";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// No DOM harness in this repo: the pure helpers are tested directly and the
// JSX is pinned by source anchors.
const SRC = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/DigestEmailViewer.tsx"),
  "utf8",
);

describe("digest preview: generation finishing never moves a reader off a tab they chose", () => {
  it("keeps the chosen tab when the Structured layout becomes ready", () => {
    expect(layoutAfterGeneration("by_company", true, true)).toBe("by_company");
    expect(layoutAfterGeneration("by_source", true, true)).toBe("by_source");
  });

  it("moves to Structured when the reader made no choice", () => {
    expect(layoutAfterGeneration("by_source", false, true)).toBe("structured");
  });

  it("stays put when no Structured layout came back", () => {
    expect(layoutAfterGeneration("by_source", false, false)).toBe("by_source");
    expect(layoutAfterGeneration("by_company", true, false)).toBe("by_company");
  });

  it("every tab click records the choice, and the POST result goes through the helper", () => {
    expect(SRC).not.toMatch(/onClick=\{\(\) => setLayout\(/);
    expect(SRC.match(/onClick=\{\(\) => pickLayout\(/g)?.length).toBe(4);
    const post = sliceBetween(SRC, 'apiFetch(url, { method: "POST" })', "} catch (err");
    expect(post).toContain("layoutAfterGeneration(current, userPickedLayout.current");
    expect(post).not.toContain('setLayout("structured")');
  });

  it("a new open forgets the previous choice", () => {
    const effect = sliceBetween(SRC, "if (!open) return;", "const qs =");
    expect(effect).toContain("userPickedLayout.current = false");
  });
});

describe("digest preview: the wait for the Structured layout is announced", () => {
  it("the Structured tab is usable and marked busy while generating, not merely disabled", () => {
    const tab = sliceBetween(SRC, 'onClick={() => pickLayout("structured")}', "</button>");
    expect(tab).toContain("disabled={!data?.structuredHtml && !structuredGenerating}");
    expect(tab).toContain("aria-busy={structuredGenerating}");
    expect(tab).toContain("animate-spin");
  });

  it("the other layouts carry a note that names the AI call", () => {
    const at = anchorIndex(SRC, 'structuredGenerating && layout !== "structured"');
    const note = SRC.slice(at, at + 400);
    expect(note).toContain('role="status"');
    expect(note).toMatch(/Generating the Structured view \(one AI call/);
  });

  it("a failed generation and an AI-synthesis fallback are both stated", () => {
    expect(SRC).toContain("The Structured view could not be generated this time.");
    const at = anchorIndex(SRC, "data.structuredHtml && data.synthesisFallback");
    expect(SRC.slice(at, at + 400)).toContain("per-source fallback layout");
  });

  it("the AI call still fires once per open, from the open effect only", () => {
    expect(SRC.match(/method: "POST"/g)?.length).toBe(1);
  });

  it("email HTML still renders only in the sandboxed frame", () => {
    expect(SRC).toContain("sandbox={EMAIL_FRAME_SANDBOX}");
    expect(SRC).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("digest preview: the empty state names the window it evaluated", () => {
  it("names a calendar-date window as written", () => {
    expect(emptyWindowMessage("2026-03-02")).toBe("No articles or alerts since Mar 2, 2026.");
  });

  it("shows the Eastern date and time of a timestamp window", () => {
    // 21:30 UTC on 2 March is 4:30 PM Eastern (standard time).
    expect(formatSince("2026-03-02T21:30:00.000Z")).toBe("Mar 2, 2026, 4:30 PM ET");
    // 02:15 UTC on 3 March is still 2 March in New York.
    expect(formatSince("2026-03-03T02:15:00.000Z")).toBe("Mar 2, 2026, 9:15 PM ET");
  });

  it("falls back to the generic line when the window is unknown", () => {
    expect(emptyWindowMessage("")).toBe("No articles or alerts in the selected window.");
    expect(emptyWindowMessage(undefined)).toBe("No articles or alerts in the selected window.");
  });

  it("the empty state renders through the helper", () => {
    const at = anchorIndex(SRC, "{data?.empty && (");
    expect(SRC.slice(at, at + 300)).toContain("{emptyWindowMessage(data.since)}");
  });
});
