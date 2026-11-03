import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("AI failover settings page (source pin)", () => {
  const section = read("app/dashboard/components/AiFailoverSection.tsx");

  it("is mounted in the settings modal", () => {
    expect(read("app/dashboard/components/SettingsModal.tsx")).toMatch(/<AiFailoverSection \/>/);
  });

  it("writes only through the failover route, reading the result the app's way", () => {
    expect(section).toContain("/api/settings/ai-failover");
    expect(section).toContain("readMutationResult");
    expect(section).toContain("networkFailureMessage");
    expect(section).not.toMatch(/\bconfirm\(|\balert\(|\bprompt\(/);
  });

  it("offers no controls for parked rows: they render from the parked list only", () => {
    // Controls are mapped over the eligible rows; the parked rows are plain text.
    expect(section).toMatch(/eligible\.map\(/);
    expect(section).toMatch(/parked\.map\(/);
    const parkedBlock = section.slice(section.indexOf("parked.map("));
    expect(parkedBlock.slice(0, parkedBlock.indexOf("))}"))).not.toMatch(/<input|<button/);
  });
});
