/**
 * The email-content route rebuilds the scoreboard from the CURRENT calendar
 * row for BOTH phases, so a SENT preview can show a different vendor
 * consensus than the sent text quotes. The "rebuilt from current data" line
 * must therefore show for any sent email (preview or recap), and a live
 * preview (no sentAt) must keep only "Live preview — not sent".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/EarningsEmailViewer.tsx"),
  "utf8",
);

describe("rebuilt-scoreboard line covers a sent preview", () => {
  it("flag is sentAt gated on preview OR recap, not recap only", () => {
    const at = anchorIndex(src, "const isSentWithRebuiltScoreboard =");
    const stmt = src.slice(at, src.indexOf(";", at));
    expect(stmt).toContain("!!data.sentAt");
    expect(stmt).toContain('data.phase === "preview"');
    expect(stmt).toContain('data.phase === "recap"');
  });
  it("the disclosure line renders off that flag", () => {
    const at = anchorIndex(src, "{isSentWithRebuiltScoreboard && (");
    expect(src.slice(at, at + 300)).toContain("The scoreboard is rebuilt from current data");
  });
  it("live preview branch is still !data.sentAt", () => {
    const at = anchorIndex(src, "Live preview — not sent");
    expect(src.slice(Math.max(0, at - 120), at)).toContain("data && !data.sentAt");
  });
});
