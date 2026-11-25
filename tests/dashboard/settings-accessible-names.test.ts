/**
 * Settings page: every text box is named for what it sets, and every Save
 * button says what it saves. Before this, the model boxes were named only by
 * a placeholder and dozens of buttons were all called "Save".
 *
 * No DOM harness in this repo: source pins on each component.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("settings accessible names (source pin)", () => {
  it("names each AI model box and its buttons for the feature", () => {
    const s = read("app/dashboard/components/AiModelsSection.tsx");
    expect(s).toContain("aria-label={`Model for ${row.key}`}");
    expect(s).toContain('aria-label={`${isSaving ? "Saving" : "Save"} model for ${row.key}`}');
    expect(s).toContain("aria-label={`Reset model for ${row.key}`}");
  });

  it("names each failover Save for the feature", () => {
    const s = read("app/dashboard/components/AiFailoverSection.tsx");
    expect(s).toContain(
      'aria-label={`${busy[row.key] ? "Saving" : "Save"} fallback order for ${row.key}`}',
    );
  });

  it("names each email recipient box by its visible label", () => {
    const s = read("app/dashboard/components/EmailRecipientsSection.tsx");
    const input = s.slice(s.indexOf("onBlur={() => saveField(key)}") - 200, s.indexOf("onBlur={() => saveField(key)}"));
    expect(input).toContain("aria-label={label}");
  });

  it("names the printing and position-limit Save buttons", () => {
    const printing = read("app/dashboard/components/settings/PrintingPreferences.tsx");
    expect(printing).toContain('aria-label="Save worksheet printer"');
    expect(printing).toContain('aria-label="Save pdftotext program"');
    const caps = read("app/dashboard/components/settings/ConstructionCapsPreferences.tsx");
    expect(caps).toMatch(/aria-label=\{`Save \$\{[^}]+\} limits`\}/);
  });
});
