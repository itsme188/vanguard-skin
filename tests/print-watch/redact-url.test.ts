import { describe, it, expect } from "vitest";
import {
  CONTENT_TYPE_MARKUP,
  hardenedFetchText,
  redactUrl,
  type FetchLike,
} from "@/lib/print-watch/hardened-fetch";
import { AcquisitionScheduler } from "@/lib/print-watch/scheduler";

describe("redactUrl", () => {
  it("strips the named secret-bearing query parameters and keeps the rest", () => {
    expect(redactUrl("https://ir.example.com/release?id=42&token=SECRET&sig=S&signature=X&key=K&auth=A&session=Z&access=Q")).toBe(
      "https://ir.example.com/release?id=42",
    );
  });
  it("matches parameter names case-insensitively", () => {
    expect(redactUrl("https://x.example/a?Token=1&ID=2")).toBe("https://x.example/a?ID=2");
  });
  it("strips the whole secret-bearing families, not just seven exact names (M19)", () => {
    expect(
      redactUrl("https://x.example/a?api_key=1&apikey=2&X-Amz-Signature=3&X-Amz-Credential=4&client_secret=5&password=6&access_token=7&sessionid=8&page=2&keyword=q"),
    ).toBe("https://x.example/a?page=2&keyword=q");
  });
  it("drops embedded credentials and the fragment", () => {
    expect(redactUrl("https://user:pw@x.example/a#frag")).toBe("https://x.example/a");
  });
  it("truncates to 200 characters", () => {
    const long = `https://x.example/${"a".repeat(400)}`;
    expect(redactUrl(long)).toHaveLength(200);
    expect(redactUrl(long).endsWith("…")).toBe(true);
  });
  it("still redacts something that does not parse as a URL", () => {
    expect(redactUrl("not a url ?token=abc")).toBe("not a url ");
  });
});

/**
 * A scripted `FetchLike`: one entry per URL. Every body is a real
 * `ReadableStream` whose `cancel` is spied on, because "did this exit hand the
 * body back?" is the whole question — an abandoned body keeps the socket AND,
 * through `AcquisitionScheduler.fetchFor`, the host family's concurrency slot.
 */
interface Scripted {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function fakeFetch(script: Record<string, Scripted>) {
  const cancelled: string[] = [];
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    const spec = script[url];
    if (!spec) throw new Error(`unscripted fetch: ${url}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(spec.body ?? "payload"));
        controller.close();
      },
    });
    const passThrough = stream.cancel.bind(stream);
    stream.cancel = (reason?: unknown) => {
      cancelled.push(url);
      return passThrough(reason);
    };
    return new Response(stream, { status: spec.status, headers: spec.headers ?? {} });
  };
  return { fetchFn, cancelled, calls };
}

const HTML = { "content-type": "text/html" };
const OPTS = { host: "www.sec.gov", label: "EDGAR", contentType: CONTENT_TYPE_MARKUP };

/** The manual clock again (see `scheduler.test.ts`): no wall-clock waiting. */
function makeClock(start = 1_000_000) {
  let now = start;
  let sleepers: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ at: now + ms, resolve });
      }),
    async advance(ms: number) {
      now += ms;
      const due = sleepers.filter((s) => s.at <= now);
      sleepers = sleepers.filter((s) => s.at > now);
      for (const s of due.sort((a, b) => a.at - b.at)) s.resolve();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

describe("hardenedFetchText — every early exit hands the body back", () => {
  it("cancels the redirect's body before following the hop", async () => {
    const { fetchFn, cancelled } = fakeFetch({
      "https://www.sec.gov/a": { status: 302, headers: { location: "/b" } },
      "https://www.sec.gov/b": { status: 200, headers: HTML, body: "<html>ok</html>" },
    });
    expect(await hardenedFetchText("https://www.sec.gov/a", fetchFn, OPTS)).toBe("<html>ok</html>");
    // The redirect body went back; the 2xx body was READ, never cancelled.
    expect(cancelled).toEqual(["https://www.sec.gov/a"]);
  });

  it("cancels the body when the redirect hop cap is exceeded", async () => {
    const { fetchFn, cancelled } = fakeFetch({
      "https://www.sec.gov/a": { status: 302, headers: { location: "/b" } },
    });
    await expect(
      hardenedFetchText("https://www.sec.gov/a", fetchFn, { ...OPTS, maxRedirects: 0 }),
    ).rejects.toThrow("exceeded 0 redirect hops");
    expect(cancelled).toEqual(["https://www.sec.gov/a"]);
  });

  it("cancels the body when a redirect carries no Location header", async () => {
    const { fetchFn, cancelled } = fakeFetch({
      "https://www.sec.gov/a": { status: 302 },
    });
    await expect(hardenedFetchText("https://www.sec.gov/a", fetchFn, OPTS)).rejects.toThrow(
      "redirect 302 with no Location header",
    );
    expect(cancelled).toEqual(["https://www.sec.gov/a"]);
  });

  it("cancels the body when the redirect leaves the pinned host", async () => {
    const { fetchFn, cancelled, calls } = fakeFetch({
      "https://www.sec.gov/a": { status: 301, headers: { location: "https://evil.example/x" } },
    });
    await expect(hardenedFetchText("https://www.sec.gov/a", fetchFn, OPTS)).rejects.toThrow(
      "refusing cross-host redirect",
    );
    expect(cancelled).toEqual(["https://www.sec.gov/a"]);
    expect(calls).toEqual(["https://www.sec.gov/a"]); // still never left the host
  });

  it("cancels the body on a non-2xx status (the ordinary EDGAR 404)", async () => {
    const { fetchFn, cancelled } = fakeFetch({
      "https://www.sec.gov/a": { status: 404, headers: HTML, body: "not posted yet" },
    });
    await expect(hardenedFetchText("https://www.sec.gov/a", fetchFn, OPTS)).rejects.toThrow(
      "EDGAR: HTTP 404",
    );
    expect(cancelled).toEqual(["https://www.sec.gov/a"]);
  });

  it("cancels the body on an unexpected content-type", async () => {
    const { fetchFn, cancelled } = fakeFetch({
      "https://www.sec.gov/a": { status: 200, headers: { "content-type": "image/png" } },
    });
    await expect(hardenedFetchText("https://www.sec.gov/a", fetchFn, OPTS)).rejects.toThrow(
      'unexpected content-type "image/png"',
    );
    expect(cancelled).toEqual(["https://www.sec.gov/a"]);
  });

  it("cancels the body when content-length exceeds the cap", async () => {
    const { fetchFn, cancelled } = fakeFetch({
      "https://www.sec.gov/a": {
        status: 200,
        headers: { ...HTML, "content-length": "999999" },
      },
    });
    await expect(
      hardenedFetchText("https://www.sec.gov/a", fetchFn, { ...OPTS, maxBytes: 10 }),
    ).rejects.toThrow("content-length 999999 exceeds 10-byte cap");
    expect(cancelled).toEqual(["https://www.sec.gov/a"]);
  });

  it("does not cancel a body it actually reads", async () => {
    const { fetchFn, cancelled } = fakeFetch({
      "https://www.sec.gov/a": { status: 200, headers: HTML, body: "<html>filing</html>" },
    });
    expect(await hardenedFetchText("https://www.sec.gov/a", fetchFn, OPTS)).toBe(
      "<html>filing</html>",
    );
    expect(cancelled).toEqual([]);
  });

  it("two 404 polls do not block the next EDGAR fetch (scheduler + hardened fetch)", async () => {
    // The review's probe, end to end: before the fix, two ordinary "not posted
    // yet" polls took both SEC concurrency slots and stalled the lane for the
    // scheduler's 120s watchdog — starting at the moment the filing landed.
    const clock = makeClock();
    const scheduler = new AcquisitionScheduler(undefined, clock); // real SEC policy: 2/s, 2 in flight
    const pass = new AbortController();
    const { fetchFn } = fakeFetch({
      "https://www.sec.gov/poll-1": { status: 404, headers: HTML, body: "not posted yet" },
      "https://www.sec.gov/poll-2": { status: 404, headers: HTML, body: "not posted yet" },
      "https://www.sec.gov/filing": { status: 200, headers: HTML, body: "<html>8-K</html>" },
    });
    const scheduled = scheduler.fetchFor(pass.signal, fetchFn);

    await expect(hardenedFetchText("https://www.sec.gov/poll-1", scheduled, OPTS)).rejects.toThrow(
      "HTTP 404",
    );
    await expect(hardenedFetchText("https://www.sec.gov/poll-2", scheduled, OPTS)).rejects.toThrow(
      "HTTP 404",
    );

    let filing: string | null = null;
    const p = hardenedFetchText("https://www.sec.gov/filing", scheduled, OPTS).then((text) => {
      filing = text;
    });
    await clock.advance(500); // one refilled token at 2/s — NOT the 120s watchdog
    await p;
    expect(filing).toBe("<html>8-K</html>");
  });
});
