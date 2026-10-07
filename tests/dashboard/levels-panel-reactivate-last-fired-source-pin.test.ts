import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

describe("LevelsPanel reactivate last-fired handling (source pin)", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");

  it("reactivate retries with force after a would-fire-immediately 409 confirmation", () => {
    const start = anchorIndex(src, "async function handleReactivate");
    const body = src.slice(start, anchorIndex(src, "async function handleDelete", start));

    expect(body).toMatch(/force\s*=\s*false/);
    expect(body).toMatch(/body:\s*JSON\.stringify\(\{ id, action: "reactivate", force \}\)/);
    expect(body).toMatch(/result\.status\s*===\s*409/);
    expect(body).toMatch(/result\.code\s*===\s*"would_fire_immediately"/);
    expect(body).toMatch(/Price .* is already past this level/);
    expect(body).toMatch(/handleReactivate\(id,\s*true\)/);
  });

  it("renders active rows with prior trigger fields as Last fired, not Triggered", () => {
    const rowState = sliceBetween(
      src,
      "const lastFired = l.triggered_at != null;",
      "const actionVisibility = levelActionVisibility(l);",
    );
    expect(rowState).toMatch(/const triggered = l\.is_active === 0 && lastFired/);
    expect(rowState).toMatch(/const inactive = l\.is_active === 0 && !lastFired/);

    expect(src).toContain("Last fired at");
    expect(src).toContain("last fired at");
  });

  it("does not offer Pause/Reactivate on rows the scanner ignores for review status", () => {
    const start = anchorIndex(src, "const actionVisibility = levelActionVisibility(l);");
    const body = src.slice(start, anchorIndex(src, "return (", start));

    expect(body).toMatch(/showPause[\s\S]*review_status === "auto_approved"/);
    expect(body).toMatch(/showReactivate[\s\S]*review_status === "auto_approved"/);
  });
});
