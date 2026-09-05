/**
 * Repo guard, slice F (M-F20). `CONTENT_COLUMNS` (lib/mutations/earnings-bogeys.ts)
 * drives hasAnyContent + the preserve-mode COALESCE; `BOGEY_CONTENT`
 * (lib/earnings/event-merge.ts) drives the collision SET list. They are
 * deliberately NOT merged — they mean different things and event-merge also
 * carries BOGEY_PROVENANCE — but a content column the upsert knows about and
 * the merge does not would be silently destroyed on every (source, source_label)
 * collision. This pins containment in the direction that can lose data.
 */
import { describe, it, expect } from "vitest";
import { BOGEY_CONTENT } from "@/lib/earnings/event-merge";
import { CONTENT_COLUMNS } from "@/lib/mutations/earnings-bogeys";

describe("bogey content column lists", () => {
  it("every upsert content column is also carried by the merge", () => {
    const missing = CONTENT_COLUMNS.filter((c) => !(BOGEY_CONTENT as readonly string[]).includes(c));
    expect(missing).toEqual([]);
  });
  it("extra_metrics_json is in both (slice F)", () => {
    expect(CONTENT_COLUMNS as readonly string[]).toContain("extra_metrics_json");
    expect(BOGEY_CONTENT as readonly string[]).toContain("extra_metrics_json");
  });
});
