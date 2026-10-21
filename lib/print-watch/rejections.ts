/**
 * Documents a road DELIVERED that the gate then REFUSED, read off the stored
 * `print_watch_documents` / `print_watch_document_roads` verdicts.
 *
 * Why this exists (2026-10-20, Netflix): EDGAR served the real release and the
 * gate refused it ("no fiscal-period token for this event"), yet the road's
 * status read "ok — 0 filing(s), 0 exhibit(s)". The count is only what a poll
 * found NEW — `pollEdgar` skips any accession already in `seenAccessions`, and
 * the watcher marks it seen as soon as its exhibits are ingested — so every
 * poll after the first one overwrote the note with zeros, and the refusal lived
 * only in the separate `gate` key (itself overwritten by the next ingest).
 * The stored verdicts are the durable truth, so both the status line and the
 * panel read them from here.
 *
 * Pure and import-free beyond types: the status route, the watcher and (via the
 * wire type) the panel all share ONE reading.
 */
import type { DocumentRoadRow, DocumentRow, PrintWatchDocKind } from "./types";

export type RejectionRoad = "edgar" | "dj" | "ir" | "user-drop" | "user-url";

export interface RejectedDocument {
  docId: number;
  road: RejectionRoad;
  /** The document kind (`edgar-ex99`, …) — the panel names the document by it. */
  kind: string;
  /** The URL when the road had one, else the road's source token (a filename
   *  or headline key). Never bytes, never document text. */
  label: string;
  /** The gate's reason, verbatim. */
  reason: string;
  /** `content`: the document is not this event's. `road`: the content fits but
   *  no road we trust carried it yet. */
  scope: "content" | "road";
}

const ROAD_OF_KIND: Record<PrintWatchDocKind, RejectionRoad> = {
  "edgar-ex99": "edgar",
  "dj-release": "dj",
  "ir-page": "ir",
  "user-drop": "user-drop",
  "user-url": "user-url",
};

export function summarizeRejections(
  docs: DocumentRow[],
  roads: DocumentRoadRow[],
): RejectedDocument[] {
  const out: RejectedDocument[] = [];
  for (const doc of docs) {
    const mine = roads.filter((r) => r.document_id === doc.id);
    if (doc.gate_verdict === "rejected") {
      const reason = doc.gate_reason ?? "rejected";
      const via = mine.length > 0 ? mine : [{ kind: doc.kind, source: doc.source, url: doc.url }];
      for (const r of via) {
        out.push({
          docId: doc.id,
          road: ROAD_OF_KIND[r.kind],
          kind: r.kind,
          label: r.url ?? r.source,
          reason,
          scope: "content",
        });
      }
      continue;
    }
    for (const r of mine) {
      if (r.road_verdict !== "rejected") continue;
      out.push({
        docId: doc.id,
        road: ROAD_OF_KIND[r.kind],
        kind: r.kind,
        label: r.url ?? r.source,
        reason: r.road_reason ?? "rejected",
        scope: "road",
      });
    }
  }
  return out;
}

/** The suffix a road's status line carries: ` · 1 rejected: <reason>`. Empty
 *  when nothing from that road was refused. Distinct documents are counted
 *  once; distinct reasons are listed once each. */
export function rejectionSuffix(rejections: RejectedDocument[], road: RejectionRoad): string {
  const mine = rejections.filter((r) => r.road === road);
  if (mine.length === 0) return "";
  const docs = new Set(mine.map((r) => r.docId)).size;
  const reasons = [...new Set(mine.map((r) => r.reason))];
  return ` · ${docs} rejected: ${reasons.join("; ")}`;
}
