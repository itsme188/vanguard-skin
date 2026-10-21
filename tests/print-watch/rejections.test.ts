import { describe, it, expect } from "vitest";
import { rejectionSuffix, summarizeRejections } from "@/lib/print-watch/rejections";
import type { DocumentRoadRow, DocumentRow } from "@/lib/print-watch/types";

const doc = (o: Partial<DocumentRow>): DocumentRow =>
  ({
    id: 1, print_id: 1, kind: "edgar-ex99", source: "edgar:acc:ex99.htm", url: "https://sec.example/ex99.htm",
    gate_verdict: "accepted", gate_reason: null, ...o,
  }) as DocumentRow;
const road = (o: Partial<DocumentRoadRow>): DocumentRoadRow =>
  ({
    document_id: 1, kind: "edgar-ex99", source: "edgar:acc:ex99.htm", url: "https://sec.example/ex99.htm",
    road_verdict: "accepted", road_reason: null, ...o,
  }) as DocumentRoadRow;

describe("summarizeRejections", () => {
  it("reports a content-rejected document once per delivering road, with the gate reason", () => {
    const out = summarizeRejections(
      [doc({ gate_verdict: "rejected", gate_reason: "no fiscal-period token for this event" })],
      [road({})],
    );
    expect(out).toEqual([
      {
        docId: 1, road: "edgar", kind: "edgar-ex99", label: "https://sec.example/ex99.htm",
        reason: "no fiscal-period token for this event", scope: "content",
      },
    ]);
  });

  it("reports a road-only refusal on an accepted document", () => {
    const out = summarizeRejections(
      [doc({ kind: "ir-page", id: 2 })],
      [road({ document_id: 2, kind: "ir-page", road_verdict: "rejected", road_reason: "no accepting road yet" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ road: "ir", scope: "road", reason: "no accepting road yet" });
  });

  it("says nothing for accepted documents and falls back to the source token without a url", () => {
    expect(summarizeRejections([doc({})], [road({})])).toEqual([]);
    const out = summarizeRejections(
      [doc({ gate_verdict: "rejected", gate_reason: "x", kind: "dj-release", url: null, source: "dj:Headline" })],
      [],
    );
    expect(out[0]).toMatchObject({ road: "dj", label: "dj:Headline" });
  });
});

describe("rejectionSuffix", () => {
  const rej = summarizeRejections(
    [doc({ gate_verdict: "rejected", gate_reason: "no fiscal-period token for this event" })],
    [road({})],
  );
  it("names the count and reason for the road, empty for other roads", () => {
    expect(rejectionSuffix(rej, "edgar")).toBe(" · 1 rejected: no fiscal-period token for this event");
    expect(rejectionSuffix(rej, "dj")).toBe("");
  });
});
