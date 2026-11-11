/**
 * Contract F: the chat client reads tool labels from the one client-safe map
 * (lib/chat/tool-labels.ts), not a private copy that drifts behind CHAT_TOOLS.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { CHAT_TOOL_LABELS, toolLabel } from "@/lib/chat/tool-labels";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("chat client tool labels (Contract F)", () => {
  it("imports toolLabel and keeps no local label map", () => {
    expect(src).toMatch(/import \{[^}]*\btoolLabel\b[^}]*\} from "@\/lib\/chat\/tool-labels"/);
    expect(src).not.toContain("const TOOL_LABELS");
    anchorIndex(src, "const label = toolLabel(name);");
  });

  it("the shared map is import-free and covers the market snapshot tool", () => {
    const file = readFileSync("lib/chat/tool-labels.ts", "utf8");
    expect(file).not.toMatch(/^import /m);
    expect(CHAT_TOOL_LABELS.query_market_snapshot).toBeTruthy();
    expect(toolLabel("no_such_tool")).toBe("Using no_such_tool");
  });
});
