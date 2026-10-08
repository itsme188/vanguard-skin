/** QA B46/B48/B50 footer: touch extension on the small footer controls. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const cases: Array<[string, string, string]> = [
  ["app/dashboard/today/EarningsHubRefreshButton.tsx", "onClick={refresh}", "-inset-y-3 "],
  ["app/dashboard/today/BogeysUploadButton.tsx", 'className="text-gold-ink hover:text-gold/80', "-inset-y-3 "],
  ["app/dashboard/today/IbkrRefreshButton.tsx", "onClick={refresh}", "-inset-y-3.5"],
  ["app/dashboard/components/TodayReleases.tsx", 'href="/dashboard/calendar"', "-inset-y-3.5"],
];

describe("footer controls carry the touch extension", () => {
  for (const [file, anchor, inset] of cases) {
    it(file, () => {
      const src = readFileSync(file, "utf8");
      const i = anchorIndex(src, anchor);
      const chunk = src.slice(i, i + 360);
      expect(chunk).toContain("relative pointer-coarse:after:absolute pointer-coarse:after:content-['']");
      expect(chunk).toContain(inset);
    });
  }
});
