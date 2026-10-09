/**
 * Static scan of the dashboard's client code for the "honest mutating handler"
 * rule (CLAUDE.md, rules from the 2026-10-05/06 backlog run):
 *
 *   - a mutating request (POST / PUT / PATCH / DELETE) reads its reply through
 *     `readMutationResult` (lib/ui/mutation-result.ts);
 *   - a request is never wrapped in an empty catch;
 *   - a caught exception is never printed as-is (`err.message` is the
 *     browser's own text, "Failed to fetch" or a JSON SyntaxError).
 *
 * The scan is textual on purpose: it is a tripwire for a NEW bare gate, not a
 * proof. A site that is honest by other means (a domain reader, a streamed
 * reply, a route with no success envelope) is listed in the test's allowlist
 * with its reason.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MUTATING_SITE = /method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/;
/** Lines after the `method:` line in which the reply must be read. */
const WINDOW_LINES = 45;
/** Two sites this close are one request written as a ternary; they share a window. */
const SAME_REQUEST_GAP = 8;
/** The call, with or without a type argument. */
const SHARED_READER = /readMutationResult\s*[<(]/;

const EMPTY_CATCH_BLOCK = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*\s*ignore\s*\*\/\s*)?\}/;
const EMPTY_CATCH_ARROW = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|void 0)\s*\)/;
const RAW_EXCEPTION_TEXT = /instanceof Error \?.*\.message|as Error\)\.message/;

export interface ScanHit {
  /** Path relative to the repo root, forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  text: string;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
}

/** Every client source file under app/, leaving out the server routes in app/api. */
export function clientSourceFiles(root: string = process.cwd()): { file: string; source: string }[] {
  const paths: string[] = [];
  walk(join(root, "app"), paths);
  return paths
    .map((path) => ({ path, file: relative(root, path).split(sep).join("/") }))
    .filter(({ file }) => !file.startsWith("app/api/"))
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ path, file }) => ({ file, source: readFileSync(path, "utf8") }));
}

/** Mutating request sites whose reply is NOT read through `readMutationResult`. */
export function bareMutatingSites(file: string, source: string): ScanHit[] {
  const lines = source.split("\n");
  const sites = lines.flatMap((text, i) => (MUTATING_SITE.test(text) ? [i] : []));
  const hits: ScanHit[] = [];
  sites.forEach((at, k) => {
    // The window runs to the next request, unless that request is the other
    // arm of the same ternary.
    let end = at + WINDOW_LINES;
    for (let n = k + 1; n < sites.length; n++) {
      if (sites[n] - sites[n - 1] <= SAME_REQUEST_GAP) continue;
      end = Math.min(end, sites[n] - 1);
      break;
    }
    const window = lines.slice(at, Math.min(lines.length, end + 1)).join("\n");
    if (!SHARED_READER.test(window)) {
      hits.push({ file, line: at + 1, text: lines[at].trim() });
    }
  });
  return hits;
}

function lineHits(file: string, source: string, patterns: RegExp[]): ScanHit[] {
  return source.split("\n").flatMap((text, i) =>
    patterns.some((p) => p.test(text)) ? [{ file, line: i + 1, text: text.trim() }] : [],
  );
}

/**
 * A catch that does nothing and says nothing: `catch {}`, `catch { /* ignore *\/ }`,
 * `.catch(() => {})`, `.catch(() => undefined)`. A catch whose comment explains
 * the deliberate skip is allowed, and so is `.catch(() => null)`: that one
 * hands back a value the caller then has to check.
 */
export function emptyCatches(file: string, source: string): ScanHit[] {
  return lineHits(file, source, [EMPTY_CATCH_BLOCK, EMPTY_CATCH_ARROW]);
}

/** A caught exception printed as-is. */
export function rawExceptionText(file: string, source: string): ScanHit[] {
  return lineHits(file, source, [RAW_EXCEPTION_TEXT]);
}

/** Hits per file, for comparing against an allowlist of counts. */
export function countByFile(hits: ScanHit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const hit of hits) out[hit.file] = (out[hit.file] ?? 0) + 1;
  return out;
}
