import { describe, it, expect } from "vitest";
import { parseImport } from "@/lib/import/engine";

const BOM = String.fromCharCode(0xfeff);

describe("parseImport on an empty file", () => {
  const expected = (name: string) =>
    `This file is empty, there is nothing to import: ${name}`;

  it("names the file as empty for a 0-byte input", async () => {
    const r = await parseImport("", "empty.csv");
    expect(r.sourceType).toBe("unknown");
    expect(r.errors).toEqual([expected("empty.csv")]);
    expect(r.errors.join(" ")).not.toContain("Unknown file format");
    expect(r.transactions).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("treats whitespace and newlines only as empty", async () => {
    const r = await parseImport("  \n\r\n\t \n", "blank.csv");
    expect(r.sourceType).toBe("unknown");
    expect(r.errors).toEqual([expected("blank.csv")]);
  });

  it("treats a byte-order-mark-only file as empty", async () => {
    const r = await parseImport(BOM, "bom.csv");
    expect(r.sourceType).toBe("unknown");
    expect(r.errors).toEqual([expected("bom.csv")]);
    const r2 = await parseImport(`${BOM}\n  \n`, "bom2.csv");
    expect(r2.errors).toEqual([expected("bom2.csv")]);
  });

  it("treats an empty Buffer as empty", async () => {
    const r = await parseImport(Buffer.alloc(0), "empty.csv");
    expect(r.errors).toEqual([expected("empty.csv")]);
  });

  it("keeps the unknown-format message for a non-empty unrecognised file", async () => {
    const r = await parseImport("foo,bar\n1,2\n", "mystery.csv");
    expect(r.sourceType).toBe("unknown");
    expect(r.errors).toEqual(["Unknown file format: mystery.csv"]);
  });
});
