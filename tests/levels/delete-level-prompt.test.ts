import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deleteLevelPrompt } from "@/lib/levels/delete-level-prompt";
import { anchorIndex } from "../helpers/source-anchor";

describe("deleteLevelPrompt", () => {
  const base = { typeLabel: "Resistance", price: 152.5, priceSource: "static", sourceAuthor: null };

  it("names the kind, the formatted price and the source", () => {
    const p = deleteLevelPrompt({ ...base, sourceAuthor: "Example Letter" }, "USD");
    expect(p.title).toBe("Delete level");
    expect(p.confirmLabel).toBe("Delete");
    expect(p.message).toBe(
      "Delete the Resistance level at $152.50 (Example Letter)? This cannot be undone.",
    );
  });

  it("labels a non-USD price in its own currency", () => {
    const p = deleteLevelPrompt({ ...base, price: 976000 }, "KRW");
    expect(p.message).toContain("976,000");
    expect(p.message).not.toContain("$");
  });

  it("omits the parenthesis when there is no source", () => {
    const p = deleteLevelPrompt(base, "USD");
    expect(p.message).toBe("Delete the Resistance level at $152.50? This cannot be undone.");
    expect(p.message).not.toContain("(");
  });

  it("differs between two levels", () => {
    const a = deleteLevelPrompt(base, "USD").message;
    const b = deleteLevelPrompt({ ...base, typeLabel: "Stop", price: 140 }, "USD").message;
    expect(a).not.toBe(b);
  });
});

describe("LevelsPanel delete wiring", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");
  it("builds the question with the builder, not the fixed sentence", () => {
    const at = anchorIndex(src, "function handleDelete(");
    const body = src.slice(at, anchorIndex(src, "async function deleteConfirmedLevel", at));
    expect(body).toContain("deleteLevelPrompt(");
    expect(src).not.toContain("Delete this level permanently?");
  });
});
