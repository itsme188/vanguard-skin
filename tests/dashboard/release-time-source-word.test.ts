import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  releaseTimeSourceWord,
  standingOverrideLine,
  type ReleaseTimeState,
} from "@/app/dashboard/today/EarningsDateChip";

/**
 * QA findings dashboard-today-earnings-hub-rgti-2318-2-src-date-popover-… and
 * dashboard-today-earnings-hub-entered-by-you-date-release-time-popover-…:
 * the "Reports at" line printed the stored source token ("web_verified")
 * while the Standing line two lines below said "web-verified". One word
 * table serves both lines, and a long quoted note wraps inside the popover.
 */
const DATE_CHIP = readFileSync(join(__dirname, "../../app/dashboard/today/EarningsDateChip.tsx"), "utf8");

describe("releaseTimeSourceWord", () => {
  it("turns every resolver token into words", () => {
    expect(releaseTimeSourceWord("user")).toBe("set by you");
    expect(releaseTimeSourceWord("web_verified")).toBe("web-verified");
    expect(releaseTimeSourceWord("observed")).toBe("observed from past prints");
  });

  it("never prints an underscore token for an unknown source", () => {
    expect(releaseTimeSourceWord("some_new_source")).not.toContain("_");
  });

  it("the Standing line reads the same table", () => {
    expect(standingOverrideLine({ source: "web_verified", release_time: "16:05" })).toContain("16:05 · web-verified");
    expect(standingOverrideLine({ source: "user", release_time: "07:00" })).toContain("07:00 · set by you");
  });
});

describe("the editor renders the source in words", () => {
  const editor = sliceBetween(DATE_CHIP, "function ReleaseTimeEditor(", "export function EarningsDateChip(");

  it("maps the Reports-at source through the table", () => {
    anchorIndex(editor, "releaseTimeSourceWord(source)");
    expect(editor).not.toContain("· {source}</span>");
  });

  it("lets a long quoted note wrap inside the popover", () => {
    const at = anchorIndex(editor, "{standingOverrideLine(rt?.override) && (");
    const para = editor.slice(at, anchorIndex(editor, "</p>", at));
    anchorIndex(para, "[overflow-wrap:anywhere]");
  });
});

// Type-level pin: the state shape the editor reads is unchanged.
const _state: ReleaseTimeState = { resolved: { time: "16:05", source: "web_verified" }, override: null };
void _state;
