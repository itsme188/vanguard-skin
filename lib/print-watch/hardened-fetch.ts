// Shared outbound hardening for every attacker-reachable fetch in the
// print-watch subsystem (Task 8's Codex #24 hardening, generalised by the
// Codex fix wave, finding E).
//
// The IR newsroom feed, the article pages it links to, and every SEC EDGAR
// endpoint are all remote content this process parses and then shows the desk
// two minutes before it trades on it. Each of them gets the SAME four
// guarantees, from ONE implementation rather than a copy per adapter:
//
//   - `redirect: "manual"` on every request; a 3xx is followed only after its
//     Location header revalidates to the SAME host, at most `maxRedirects`
//     hops. The initial URL is host-checked too, so a caller can never be
//     talked off its own host by a value it forgot to validate.
//   - `content-length` PRECHECK (reject before reading a byte) AND a streamed
//     byte cap enforced while reading, so a missing or dishonest
//     content-length cannot bypass the cap.
//   - a content-type check: the caller states what shape it expects.
//   - JSON is read through the SAME capped reader and then parsed — never
//     `res.json()`, which is unbounded.
//
// This module never sleeps and never retries: per-host request spacing and
// cadence belong to the watcher (Task 9's spacer).

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 2MB, applied to both the content-length precheck and the streamed read. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECT_HOPS = 2;

/** Content-type families the print-watch adapters actually consume. */
export const CONTENT_TYPE_JSON = /json/i;
/** Markup or plain text: RSS/XML feeds, IR article pages, SEC index headers
 *  and EX-99 exhibits (some of which are served as text/plain). */
export const CONTENT_TYPE_MARKUP = /xml|html|text\/plain/i;

export interface HardenedFetchOptions {
  /** Every request — initial URL and every redirect hop — must stay here. */
  host: string;
  /** Error-message prefix, so a failure names the caller ("EDGAR submissions"). */
  label: string;
  /** The response's content-type must match this. */
  contentType: RegExp;
  /** Request headers (e.g. the SEC fair-access User-Agent). */
  headers?: Record<string, string>;
  maxBytes?: number;
  maxRedirects?: number;
}

export function isSameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/** Read a response body up to `capBytes`, streaming when possible so a
 *  missing or dishonest content-length header cannot bypass the cap. */
async function readCapped(
  res: Response,
  capBytes: number,
  url: string,
  label: string,
): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > capBytes) {
      throw new Error(`${label}: body exceeds ${capBytes}-byte cap for ${url}`);
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label}: streamed body exceeded ${capBytes}-byte cap for ${url}`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Fetch `url` as text, refusing to leave `opts.host` and refusing to read an
 * oversized or wrong-shaped body. See the module header for the full contract.
 */
export async function hardenedFetchText(
  url: string,
  fetchFn: FetchLike,
  opts: HardenedFetchOptions,
): Promise<string> {
  const { host, label } = opts;
  const capBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECT_HOPS;

  if (!isSameHost(url, host)) {
    throw new Error(`${label}: refusing off-host request to ${url} (expected host ${host})`);
  }

  let currentUrl = url;
  let res: Response;

  for (let hop = 0; ; hop += 1) {
    res = await fetchFn(currentUrl, {
      redirect: "manual",
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    if (res.status < 300 || res.status >= 400) break;

    if (hop >= maxRedirects) {
      throw new Error(`${label}: exceeded ${maxRedirects} redirect hops fetching ${url}`);
    }
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`${label}: redirect ${res.status} with no Location header for ${currentUrl}`);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    if (!isSameHost(nextUrl, host)) {
      throw new Error(
        `${label}: refusing cross-host redirect from ${currentUrl} to ${nextUrl} (expected host ${host})`,
      );
    }
    currentUrl = nextUrl;
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label}: HTTP ${res.status} for ${currentUrl}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!opts.contentType.test(contentType)) {
    throw new Error(`${label}: unexpected content-type "${contentType}" for ${currentUrl}`);
  }

  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > capBytes) {
    throw new Error(
      `${label}: content-length ${contentLength} exceeds ${capBytes}-byte cap for ${currentUrl}`,
    );
  }

  return readCapped(res, capBytes, currentUrl, label);
}

/**
 * The JSON twin of `hardenedFetchText` — the body is read through the same
 * capped reader and parsed here, because `Response.json()` reads an unbounded
 * body before anything gets a chance to refuse it.
 */
export async function hardenedFetchJson<T>(
  url: string,
  fetchFn: FetchLike,
  opts: HardenedFetchOptions,
): Promise<T> {
  const text = await hardenedFetchText(url, fetchFn, opts);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${opts.label}: response was not valid JSON (${(err as Error).message})`);
  }
}
