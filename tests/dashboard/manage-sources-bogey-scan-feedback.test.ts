import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ManageSourcesModal.tsx"),
  "utf8"
);

function handlerBody(): string {
  const start = anchorIndex(src, "const handleBogeyModeChange = useCallback(");
  const end = anchorIndex(src, "// ── Earnings hierarchy");
  return src.slice(start, end);
}

describe("ManageSourcesModal bogey scan switch reports its save", () => {
  it("reads the response through readMutationResult", () => {
    expect(handlerBody()).toMatch(/readMutationResult\(res\)/);
  });

  it("restores the previous value on failure and says why", () => {
    const body = handlerBody();
    const catchAt = anchorIndex(body, "catch (err)");
    const after = body.slice(catchAt);
    expect(after).toMatch(/\[sourceId\]: previous/);
    expect(after).toMatch(/setBogeyRowErrors/);
  });

  it("sets a saved marker only after the response was read ok", () => {
    const body = handlerBody();
    const okAt = anchorIndex(body, "if (!r.ok) throw");
    const savedAt = body.lastIndexOf("setBogeySaved(");
    expect(savedAt).toBeGreaterThan(-1);
    expect(savedAt).toBeGreaterThan(okAt);
  });

  it("renders a polite status element with the Saved text", () => {
    const at = anchorIndex(src, "bogeySaved[s.id]");
    const chunk = src.slice(at, at + 400);
    expect(chunk).toMatch(/role="status"/);
    expect(chunk).toMatch(/aria-live="polite"/);
    expect(chunk).toMatch(/Saved/);
  });
});
