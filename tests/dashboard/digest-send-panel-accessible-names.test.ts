import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DIGEST_WINDOW_LABEL,
  DIGEST_WINDOW_DATE_LABEL,
} from "@/app/dashboard/components/digest-window-choice";
import { anchorIndex } from "../helpers/source-anchor";

// No DOM harness: the JSX wiring is pinned by source anchors.
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PANEL = read("app/dashboard/components/SendDigestPanel.tsx");
const VIEWER = read("app/dashboard/components/DigestEmailViewer.tsx");

/** The opening tag of the first element of `tag` at or after `anchor`. */
function openingTag(src: string, anchor: string): string {
  const start = anchorIndex(src, anchor);
  const tagStart = src.lastIndexOf("<", start);
  const end = anchorIndex(src, ">", start);
  return src.slice(tagStart, end);
}

describe("digest Send panel: accessible names", () => {
  it("names the window select with the shared label, same as the Preview", () => {
    expect(DIGEST_WINDOW_LABEL).toBe("Digest window");
    const panelSelect = openingTag(PANEL, "value={digestMode}");
    const viewerSelect = openingTag(VIEWER, "value={digestWindow.mode}");
    expect(panelSelect).toContain("<select");
    expect(panelSelect).toContain("aria-label={DIGEST_WINDOW_LABEL}");
    expect(viewerSelect).toContain("aria-label={DIGEST_WINDOW_LABEL}");
  });

  it("names the since-date input like the Preview's", () => {
    expect(DIGEST_WINDOW_DATE_LABEL).toBe("Digest window start date");
    expect(openingTag(PANEL, "value={sinceDate}")).toContain("aria-label={DIGEST_WINDOW_DATE_LABEL}");
    expect(openingTag(VIEWER, "value={digestWindow.sinceDate}")).toContain(
      "aria-label={DIGEST_WINDOW_DATE_LABEL}",
    );
  });

  it("names the recipient input", () => {
    const tag = openingTag(PANEL, 'placeholder="recipient@email.com"');
    expect(tag).toContain('aria-label="Recipient email"');
  });
});
