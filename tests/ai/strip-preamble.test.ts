import { describe, it, expect } from "vitest";
import { stripModelPreamble } from "@/lib/ai/strip-preamble";

describe("stripModelPreamble", () => {
  it("removes leading narration before first markdown structure marker", () => {
    const input = "Good, now I have enough.\n\nLet me synthesize...\n\n# Heading\nBody content here";
    const result = stripModelPreamble(input);
    expect(result).toBe("# Heading\nBody content here");
  });

  it("preserves output that already starts with a marker", () => {
    const input = "# Heading\nBody content\nMore content";
    const result = stripModelPreamble(input);
    expect(result).toBe("# Heading\nBody content\nMore content");
  });

  it("treats pipe character as valid marker", () => {
    const input = "Some preamble\nMore preamble\n| Header | Value |\nBody";
    const result = stripModelPreamble(input);
    expect(result).toBe("| Header | Value |\nBody");
  });

  it("treats dash, asterisk, and plus as valid list markers", () => {
    const input = "Preamble text\n- List item\nMore content";
    const result = stripModelPreamble(input);
    expect(result).toBe("- List item\nMore content");

    const input2 = "Preamble text\n* List item\nMore content";
    const result2 = stripModelPreamble(input2);
    expect(result2).toBe("* List item\nMore content");

    const input3 = "Preamble text\n+ List item\nMore content";
    const result3 = stripModelPreamble(input3);
    expect(result3).toBe("+ List item\nMore content");
  });

  it("treats blockquote (>) as valid marker", () => {
    const input = "Preamble\n> Quote line\nMore";
    const result = stripModelPreamble(input);
    expect(result).toBe("> Quote line\nMore");
  });

  it("treats horizontal rule (---) as valid marker", () => {
    const input = "Preamble\n---\nContent below";
    const result = stripModelPreamble(input);
    expect(result).toBe("---\nContent below");
  });

  it("treats code fence as valid marker", () => {
    const input = "Preamble\n```typescript\ncode\n```";
    const result = stripModelPreamble(input);
    expect(result).toBe("```typescript\ncode\n```");
  });

  it("returns full text (pass-through) when no marker is found", () => {
    const input = "Just preamble\nNo structure markers here\nNothing but text";
    const result = stripModelPreamble(input);
    expect(result).toBe("Just preamble\nNo structure markers here\nNothing but text");
  });

  it("skips blank lines when searching for first marker", () => {
    const input = "Preamble\n\n\n\n# Heading\nContent";
    const result = stripModelPreamble(input);
    expect(result).toBe("# Heading\nContent");
  });

  it("preserves whitespace after marker is found", () => {
    const input = "Preamble\n# Heading\n\nParagraph with spaces\n  Indented";
    const result = stripModelPreamble(input);
    expect(result).toBe("# Heading\n\nParagraph with spaces\n  Indented");
  });
});
