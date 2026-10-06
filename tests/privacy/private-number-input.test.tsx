import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

let mockPrivate = false;
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: mockPrivate, setPrivate: () => {}, toggle: () => {} }),
}));

import { PrivateNumberInput, isPrivateInputMasked } from "@/lib/privacy/components";

describe("PrivateNumberInput", () => {
  it("masks only when private and unfocused", () => {
    expect(isPrivateInputMasked(true, false)).toBe(true);
    expect(isPrivateInputMasked(true, true)).toBe(false);
    expect(isPrivateInputMasked(false, false)).toBe(false);
  });

  it("private + unfocused: bullets, read-only, real value absent from markup", () => {
    mockPrivate = true;
    const html = renderToStaticMarkup(
      <PrivateNumberInput value={1234.5} max={9999} aria-label="Shares" onChange={() => {}} />,
    );
    expect(html).toContain("•••");
    expect(html).toContain('type="text"');
    expect(html).toContain("readOnly");
    expect(html).toContain('aria-label="Shares"');
    expect(html).not.toContain("1234");
    expect(html).not.toContain("9999");
  });

  it("not private: plain number input with the real value", () => {
    mockPrivate = false;
    const html = renderToStaticMarkup(
      <PrivateNumberInput value={1234.5} max={9999} onChange={() => {}} />,
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('value="1234.5"');
    expect(html).not.toContain("•••");
  });

  it("Assign-lots drawer uses the wrapper for the quantity input", () => {
    const src = readFileSync("app/dashboard/components/giving/LotAssignmentDrawer.tsx", "utf8");
    expect(src).toContain("PrivateNumberInput");
    expect(src).not.toMatch(/<input\s+type="number"/);
  });
});
