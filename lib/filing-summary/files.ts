/**
 * Where a filing's documents live on disk (spec §4: "raw HTML is kept on disk
 * like print-watch documents, so footnotes can be located later").
 *
 *   <resolveDbDir()>/filing-summary/<cik>/<accession>/<fileName>
 *
 * The path is keyed by accession and file name only, so an event merge that
 * folds two filing rows for the same accession loses nothing on disk. Every
 * part is validated with the same patterns `secArchiveUrl` uses (a 1-10 digit
 * CIK, a `##########-##-######` accession, a plain file name), because the
 * accession and file name come from remote content.
 *
 * The path is assembled with Array#join + normalize rather than `path.join`,
 * for the reason given in `lib/print-watch/storage-path.ts` (Turbopack's
 * tracer turns a `path.join` of dynamic parts into a glob and warns on every
 * build).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDbDir } from "@/lib/db/db-path";
import { secArchiveUrl } from "./locate";

/** Validates the three parts (throws on a malformed one) and returns the path. */
export function filingStoragePath(
  cik: string,
  accession: string,
  fileName: string,
  root: string = resolveDbDir(),
): string {
  // Throws "invalid cik" / "invalid accession" / "invalid file name".
  secArchiveUrl(cik, accession, fileName);
  return path.normalize([root, "filing-summary", cik, accession, fileName].join(path.sep));
}

export interface WrittenFilingDocument {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Writes the document (atomically: a temp file in the same folder, then a
 * rename) and returns its path, SHA-256 and byte length.
 */
export function writeFilingDocument(
  cik: string,
  accession: string,
  fileName: string,
  content: string,
  root: string = resolveDbDir(),
): WrittenFilingDocument {
  const finalPath = filingStoragePath(cik, accession, fileName, root);
  const buf = Buffer.from(content, "utf8");
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmp = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, finalPath);
  return { path: finalPath, sha256, bytes: buf.length };
}

/** The stored document's text, or null when it is missing or unreadable. */
export function readFilingDocument(storedPath: string): string | null {
  try {
    return fs.readFileSync(storedPath, "utf8");
  } catch {
    return null;
  }
}
