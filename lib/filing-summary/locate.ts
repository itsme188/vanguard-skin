import type { Footnote, ModelCitation, TextBlock, DocText } from "@/lib/filing-summary/types";

export interface LocatedQuote {
  status: "found" | "not_found" | "ambiguous";
  fileName: string | null;
  block: TextBlock | null;
  sentence: string | null;
}

/** NFKC, curly quotes to straight, dashes/minus to "-", whitespace runs to one space, lowercase, trim. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

const CELL_SEP = " | ";

/** Normalize a cell or quote part for whole-cell equality: drop a trailing ":" and a trailing footnote marker. */
function cellKey(s: string): string {
  let t = normalizeForMatch(s);
  for (let i = 0; i < 3; i++) {
    const next = t.replace(/\s*(?:\(\s*[a-z0-9]{1,3}\s*\)|\*+)$/, "").replace(/\s*:$/, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

function rowMatches(blockText: string, quote: string): boolean {
  const parts = quote.split(CELL_SEP).map(cellKey).filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  const cells = blockText.split(CELL_SEP).map(cellKey);
  let from = 0;
  for (const part of parts) {
    let hit = -1;
    for (let i = from; i < cells.length; i++) {
      if (cells[i] === part) {
        hit = i;
        break;
      }
    }
    if (hit < 0) return false;
    from = hit + 1;
  }
  return true;
}

/** Indexes (within `blocks`) of every block that matches the quote. */
function matchingBlocks(blocks: TextBlock[], quote: string): TextBlock[] {
  const nq = normalizeForMatch(quote);
  if (nq.length === 0) return [];
  const isRowQuote = quote.includes(CELL_SEP);
  const norm = blocks.map((b) => normalizeForMatch(b.text));
  const out: TextBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    let hit = false;
    if (isRowQuote && b.tableId !== null) {
      hit = rowMatches(b.text, quote);
    } else if (norm[i].includes(nq)) {
      hit = true;
    } else if (i + 1 < blocks.length && blocks[i + 1].tableId === null && b.tableId === null) {
      // A quote spanning two adjacent blocks counts as a match on the first.
      hit = `${norm[i]} ${norm[i + 1]}`.includes(nq) && !norm[i + 1].includes(nq);
    }
    if (hit) out.push(b);
  }
  return out;
}

function sentenceFor(block: TextBlock, quote: string): string {
  if (block.tableId !== null) return block.text;
  const nq = normalizeForMatch(quote);
  const sentences = block.text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
  const whole = sentences.find((s) => normalizeForMatch(s).includes(nq));
  if (whole) return whole;
  const head = nq.slice(0, 40);
  const start = sentences.find((s) => normalizeForMatch(s).includes(head));
  return start ?? block.text;
}

export function locateQuote(
  docs: Array<{ fileName: string; text: DocText }>,
  citation: ModelCitation,
): LocatedQuote {
  const none: LocatedQuote = { status: "not_found", fileName: null, block: null, sentence: null };
  const cited = docs.find((d) => d.fileName === citation.document);
  const done = (fileName: string, block: TextBlock): LocatedQuote => ({
    status: "found",
    fileName,
    block,
    sentence: sentenceFor(block, citation.quote),
  });
  if (cited) {
    const m = matchingBlocks(cited.text.blocks, citation.quote);
    if (m.length === 1) return done(cited.fileName, m[0]);
    if (m.length > 1) return { status: "ambiguous", fileName: cited.fileName, block: null, sentence: null };
  }
  const hits: Array<{ fileName: string; block: TextBlock }> = [];
  for (const d of docs) {
    if (d === cited) continue;
    for (const b of matchingBlocks(d.text.blocks, citation.quote)) hits.push({ fileName: d.fileName, block: b });
  }
  if (hits.length === 1) return done(hits[0].fileName, hits[0].block);
  if (hits.length > 1) return { status: "ambiguous", fileName: null, block: null, sentence: null };
  return none;
}

const CIK_RE = /^\d{1,10}$/;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
const FILE_RE = /^[A-Za-z0-9._-]+$/;

/** EDGAR archive URL; throws on any malformed part. */
export function secArchiveUrl(cik: string, accession: string, fileName: string): string {
  if (!CIK_RE.test(cik)) throw new Error("invalid cik");
  if (!ACCESSION_RE.test(accession)) throw new Error("invalid accession");
  if (!FILE_RE.test(fileName) || fileName === "." || fileName === "..") throw new Error("invalid file name");
  const cikNum = cik.replace(/^0+(?=\d)/, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession.replace(/-/g, "")}/${fileName}`;
}

function encodeFragmentPart(s: string): string {
  return encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C");
}

/** Text-fragment link: whole sentence when <= 12 words, else first 8 words and last 4 as start,end. */
export function textFragmentUrl(baseUrl: string, sentence: string): string {
  const words = sentence.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= 12) return `${baseUrl}#:~:text=${encodeFragmentPart(words.join(" "))}`;
  const start = words.slice(0, 8).join(" ");
  const end = words.slice(-4).join(" ");
  return `${baseUrl}#:~:text=${encodeFragmentPart(start)},${encodeFragmentPart(end)}`;
}

/**
 * Build a footnote. `pageBreaksReliable` is the cited document's DocText flag;
 * when false the page is reported as null.
 */
export function toFootnote(
  cik: string,
  accession: string,
  citation: ModelCitation,
  located: LocatedQuote,
  pageBreaksReliable: boolean,
): Footnote {
  const document = located.fileName ?? citation.document;
  if (located.status === "found" && located.block && located.sentence !== null && located.fileName) {
    return {
      citationId: citation.id,
      document,
      status: "found",
      page: pageBreaksReliable ? located.block.page : null,
      para: located.block.para,
      sentence: located.sentence,
      url: textFragmentUrl(secArchiveUrl(cik, accession, located.fileName), located.sentence),
    };
  }
  const base = FILE_RE.test(document) ? secArchiveUrl(cik, accession, document) : null;
  return {
    citationId: citation.id,
    document,
    status: located.status === "ambiguous" ? "ambiguous" : "not_found",
    page: null,
    para: null,
    sentence: null,
    url: base,
  };
}
