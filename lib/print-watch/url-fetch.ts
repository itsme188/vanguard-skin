// The pasted-URL road's fetch (spec §4.2 "URL", plan M2). `node:https` with
// the socket's `lookup` pinned to the address the SSRF contract already
// validated, so a DNS answer cannot change between validation and connect.
// One AbortController budgets every hop; `req.destroy()` closes the socket.
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { validatePublicUrl, resolvePinnedAddress, type LookupFn, type ResolvedAddress } from "./ssrf";
import { redactUrl } from "./hardened-fetch";

export const URL_FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const URL_FETCH_TIMEOUT_MS = 20_000;
export const URL_FETCH_MAX_REDIRECTS = 3;
const USER_AGENT = "PortfolioDesk contact@myportfoliodesk.com";

export type BytesKind = "pdf" | "html" | "text";
export type RequestLike = typeof https.request;

export class UrlFetchRefused extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "UrlFetchRefused";
  }
}

export interface FetchedBytes {
  bytes: Buffer;
  finalUrl: string;
  status: number;
  contentType: string | null;
}

export interface HardenedFetchBytesOptions {
  label: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  lookup?: LookupFn;
  request?: RequestLike;
  /** Applied to the initial host AND every redirect hop (the IR lane passes its allowlist). */
  allowHost?: (hostname: string) => boolean;
}

const HINT_403 = "wire syndicators often block direct fetches — paste the company's IR-site link or the EDGAR exhibit instead";

/** Node's socket `lookup` callback takes an array when `options.all` is set
 *  (the autoSelectFamily path on Node ≥ 20) and a single address otherwise. */
function pinnedLookup(pinned: ResolvedAddress) {
  return (
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ): void => {
    if (typeof options === "function") {
      (options as (...a: unknown[]) => void)(null, pinned.address, pinned.family);
      return;
    }
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

/**
 * Race `work` against the ONE shared budget. The abort listener is removed
 * whichever way the race settles, so a four-hop fetch does not leave four
 * listeners (and four pending rejections) hanging off the signal.
 */
async function raceAbortBudget<T>(
  work: Promise<T>,
  signal: AbortSignal,
  makeError: () => UrlFetchRefused,
): Promise<T> {
  if (signal.aborted) throw makeError();
  let onAbort!: () => void;
  const lapsed = new Promise<never>((_, reject) => {
    onAbort = () => reject(makeError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, lapsed]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function readCappedStream(
  res: IncomingMessage,
  capBytes: number,
  signal: AbortSignal,
  label: string,
  shownUrl: string,
  closeSocket: () => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onAbort = () => {
      res.destroy();
      closeSocket();
      reject(new UrlFetchRefused(`${label}: timed out reading ${shownUrl}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > capBytes) {
        signal.removeEventListener("abort", onAbort);
        res.destroy();
        closeSocket();
        reject(new UrlFetchRefused(`${label}: streamed body exceeded ${capBytes}-byte cap (${shownUrl})`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (err: Error) => {
      signal.removeEventListener("abort", onAbort);
      closeSocket();
      reject(new UrlFetchRefused(`${label}: ${err.message} (${shownUrl})`));
    });
  });
}

export async function hardenedFetchBytes(
  rawUrl: string,
  opts: HardenedFetchBytesOptions,
): Promise<FetchedBytes> {
  const { label } = opts;
  const maxBytes = opts.maxBytes ?? URL_FETCH_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
  const lookup = opts.lookup ?? undefined;
  const request = opts.request ?? https.request;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const shownStart = redactUrl(rawUrl);
  const timedOut = () => new UrlFetchRefused(`${label}: timed out after ${timeoutMs}ms (${shownStart})`);

  try {
    let current = rawUrl;
    for (let hop = 0; ; hop += 1) {
      const verdict = validatePublicUrl(current);
      if (!verdict.ok) throw new UrlFetchRefused(`${label}: ${verdict.reason} (${redactUrl(current)})`);
      if (opts.allowHost && !opts.allowHost(verdict.hostname)) {
        throw new UrlFetchRefused(`${label}: host not allowed for this road (${redactUrl(current)})`);
      }
      // The lookup is raced against the shared deadline (Codex #8): a stalled
      // resolver must not outlive the 20-second contract any more than a
      // socket, and no socket is opened once the budget has lapsed.
      const pinned = await raceAbortBudget(
        resolvePinnedAddress(verdict.hostname, lookup),
        controller.signal,
        timedOut,
      ).catch((err: Error) => {
        if (err instanceof UrlFetchRefused) throw err;
        throw new UrlFetchRefused(`${label}: ${err.message.replace(verdict.hostname, redactUrl(current))}`);
      });

      const u = new URL(current);
      const shown = redactUrl(current);
      // Held outside the promise so every bail-out below closes the socket,
      // not just the response stream.
      let req!: ClientRequest;
      const closeSocket = () => req.destroy();
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          req.destroy();
          reject(timedOut());
        };
        try {
          req = request(
            {
              protocol: "https:",
              host: verdict.hostname,
              servername: verdict.hostname,
              port: 443,
              path: `${u.pathname}${u.search}`,
              method: "GET",
              agent: false,
              headers: { "User-Agent": USER_AGENT, ...(opts.headers ?? {}) },
              lookup: pinnedLookup(pinned) as unknown as https.RequestOptions["lookup"],
              signal: controller.signal,
            },
            (response) => {
              if (settled) {
                response.destroy();
                return;
              }
              settled = true;
              controller.signal.removeEventListener("abort", onAbort);
              resolve(response);
            },
          );
        } catch (err) {
          // A synchronous throw out of request() (bad option shape) must still
          // reach the caller as a refusal carrying only the redacted URL.
          settled = true;
          reject(new UrlFetchRefused(`${label}: ${(err as Error).message} (${shown})`));
          return;
        }
        // Stays attached for the life of the request: a socket torn down after
        // the response arrived still emits 'error', and an EventEmitter with no
        // 'error' listener throws. Post-settle errors are swallowed here.
        req.on("error", (err: Error) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          reject(
            controller.signal.aborted ? timedOut() : new UrlFetchRefused(`${label}: ${err.message} (${shown})`),
          );
        });
        controller.signal.addEventListener("abort", onAbort, { once: true });
        req.end();
      });

      const status = res.statusCode ?? 0;
      // Every non-final response is DESTROYED, never resumed (Codex #8): a
      // redirect body must not be read to completion on the caller's budget.
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.destroy();
        closeSocket();
        if (hop >= URL_FETCH_MAX_REDIRECTS) {
          throw new UrlFetchRefused(`${label}: exceeded ${URL_FETCH_MAX_REDIRECTS} redirect hops (${shownStart})`);
        }
        if (!location) throw new UrlFetchRefused(`${label}: redirect ${status} with no Location (${shown})`);
        current = new URL(Array.isArray(location) ? location[0] : location, current).toString();
        continue;
      }
      if (status === 403) {
        res.destroy();
        closeSocket();
        throw new UrlFetchRefused(`${label}: HTTP 403 for ${shown} — ${HINT_403}`, 403);
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        closeSocket();
        throw new UrlFetchRefused(`${label}: HTTP ${status} for ${shown}`, status);
      }
      const declared = res.headers["content-length"];
      if (declared && Number(declared) > maxBytes) {
        res.destroy();
        closeSocket();
        throw new UrlFetchRefused(`${label}: content-length ${declared} exceeds ${maxBytes}-byte cap (${shown})`);
      }
      const bytes = await readCappedStream(res, maxBytes, controller.signal, label, shown, closeSocket);
      const contentTypeHeader = res.headers["content-type"];
      return {
        bytes,
        finalUrl: current,
        status,
        contentType: Array.isArray(contentTypeHeader) ? contentTypeHeader[0] ?? null : contentTypeHeader ?? null,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Type by magic bytes (spec §4.2): `%PDF-`; `<html` / `<!doctype`; else text
 *  only if the first 4KB has no NUL and under 2% control bytes; else binary. */
export function classifyBytes(buf: Buffer): BytesKind | "binary" {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  let head = buf.subarray(0, 4096);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) head = head.subarray(3);
  const lower = head.toString("latin1").trimStart().toLowerCase();
  if (lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.includes("<html")) return "html";
  if (head.length === 0) return "binary";
  let control = 0;
  for (const b of head) {
    if (b === 0) return "binary";
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control += 1;
  }
  return control / head.length < 0.02 ? "text" : "binary";
}
