// Manual roads that start from a URL (spec §4.2 "URL"; slice C's go action
// reuses this for its pasted link). One place turns a link into a delivery
// and a human-readable outcome; every URL in the outcome is redacted.
import type Database from "better-sqlite3";
import { hardenedFetchBytes, classifyBytes, UrlFetchRefused } from "./url-fetch";
import { validatePublicUrl } from "./ssrf";
import { redactUrl } from "./hardened-fetch";
import { sha256Hex } from "./delivery";
import { ingestDocument, type IngestOutcome } from "./watcher";
import type { PrintWatchDocKind } from "./types";

export interface RoadOutcome {
  road: PrintWatchDocKind;
  outcome: IngestOutcome | "fetch_failed";
  detail: string;
  docId: number | null;
  isNew: boolean;
}

export interface UrlRoadSeams {
  fetchBytes?: typeof hardenedFetchBytes;
  ingest?: typeof ingestDocument;
}

const OUTCOME_COPY: Record<IngestOutcome, string> = {
  parsed: "fetched and parsed — the sheet has been updated",
  rejected: "fetched, but the document was refused by the issuer/period gate",
  duplicate: "fetched — this release was already in hand",
  queued: "fetched — parsing is waiting on the process that owns the watcher",
  refused: "fetched, but the body was refused",
  parse_failed: "fetched and stored, but the parse attempt failed — it will be retried",
};

/**
 * Turns a pasted link into a delivery: validate through the SSRF contract,
 * fetch through the hardened fetcher (address-pinned, redirect-revalidated),
 * classify the bytes, and hand accepted bytes to `ingestDocument` under the
 * `user-url` road. Every URL that reaches the returned `detail` (and the
 * `url`/`source` handed to the store) has already been through `redactUrl` —
 * a token/sig query param never survives into a document row or a report.
 */
export async function deliverFromUrl(
  db: Database.Database,
  printId: number,
  rawUrl: string,
  seams: UrlRoadSeams = {},
): Promise<RoadOutcome> {
  const fetchBytes = seams.fetchBytes ?? hardenedFetchBytes;
  const ingest = seams.ingest ?? ingestDocument;
  const road: PrintWatchDocKind = "user-url";

  const verdict = validatePublicUrl(rawUrl);
  if (!verdict.ok) {
    return { road, outcome: "refused", detail: `${verdict.reason} (${redactUrl(rawUrl)})`, docId: null, isNew: false };
  }

  let fetched;
  try {
    fetched = await fetchBytes(rawUrl, { label: "pasted link" });
  } catch (err) {
    const detail =
      err instanceof UrlFetchRefused ? err.message : `pasted link: ${redactUrl(rawUrl)} could not be fetched`;
    return { road, outcome: "fetch_failed", detail, docId: null, isNew: false };
  }

  const shown = redactUrl(fetched.finalUrl);
  if (classifyBytes(fetched.bytes) === "binary") {
    return {
      road,
      outcome: "refused",
      detail: `binary content at ${shown} — print-watch reads HTML, plain text, or PDF`,
      docId: null,
      isNew: false,
    };
  }

  // Road identity is a hash of the FULL final URL (M19): two long links that
  // redact or truncate alike stay two roads; the redacted form is for
  // display (and the stored `url` column) only.
  const roadSource = `user-url:${sha256Hex(fetched.finalUrl).slice(0, 16)}`;
  const result = await ingest(db, printId, road, roadSource, shown, fetched.bytes);
  const detail = result.rejectReason ? `${OUTCOME_COPY[result.outcome]}: ${result.rejectReason}` : OUTCOME_COPY[result.outcome];
  return {
    road,
    outcome: result.outcome,
    detail,
    docId: result.outcome === "refused" ? null : result.docId,
    isNew: result.isNew,
  };
}
