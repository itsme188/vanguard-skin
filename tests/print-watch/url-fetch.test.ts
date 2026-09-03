import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { hardenedFetchBytes, classifyBytes, UrlFetchRefused } from "@/lib/print-watch/url-fetch";

/** A scripted https.request: one entry per URL; `chunks` streams the body. */
interface Scripted {
  status: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  hang?: boolean;
}

function fakeRequest(script: Record<string, Scripted>) {
  const calls: Array<{ host: string; path: string; opts: Record<string, unknown> }> = [];
  const destroyed: string[] = [];
  const request = ((opts: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
    const url = `https://${String(opts.host)}${String(opts.path)}`;
    calls.push({ host: String(opts.host), path: String(opts.path), opts });
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(err?: Error): void };
    req.end = () => {
      const entry = script[url];
      if (!entry) {
        setImmediate(() => req.emit("error", new Error(`unscripted ${url}`)));
        return;
      }
      if (entry.hang) return;
      const res = Readable.from(entry.chunks ?? [Buffer.alloc(0)]) as unknown as IncomingMessage;
      Object.assign(res, { statusCode: entry.status, headers: entry.headers ?? {} });
      const origDestroy = res.destroy.bind(res);
      res.destroy = ((err?: Error) => {
        destroyed.push(url);
        return origDestroy(err);
      }) as typeof res.destroy;
      setImmediate(() => cb(res));
    };
    req.destroy = () => {
      destroyed.push(`req:${url}`);
    };
    const signal = opts.signal as AbortSignal | undefined;
    signal?.addEventListener("abort", () => req.destroy());
    return req;
  }) as unknown as typeof import("node:https").request;
  return { request, calls, destroyed };
}

const PUBLIC = async () => [{ address: "104.16.0.1", family: 4 as const }];
const PRIVATE = async () => [{ address: "10.0.0.1", family: 4 as const }];

describe("hardenedFetchBytes", () => {
  it("fetches through the pinned lookup with SNI intact and returns the bytes", async () => {
    const { request, calls } = fakeRequest({
      "https://ir.example.com/release.pdf": { status: 200, headers: { "content-type": "application/pdf" }, chunks: [Buffer.from("%PDF-1.7 hello")] },
    });
    const out = await hardenedFetchBytes("https://ir.example.com/release.pdf", { label: "t", lookup: PUBLIC, request });
    expect(out.bytes.toString()).toBe("%PDF-1.7 hello");
    expect(out.finalUrl).toBe("https://ir.example.com/release.pdf");
    expect(out.contentType).toBe("application/pdf");
    expect(calls[0].opts.servername).toBe("ir.example.com");
    expect(calls[0].opts.port).toBe(443);
    expect(calls[0].opts.agent).toBe(false);
    const lookup = calls[0].opts.lookup as (h: string, o: Record<string, unknown>, cb: (...a: unknown[]) => void) => void;
    await new Promise<void>((resolve) =>
      lookup("ir.example.com", {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe("104.16.0.1");
        expect(family).toBe(4);
        resolve();
      }),
    );
    await new Promise<void>((resolve) =>
      lookup("ir.example.com", { all: true }, (err, addresses) => {
        expect(err).toBeNull();
        expect(addresses).toEqual([{ address: "104.16.0.1", family: 4 }]);
        resolve();
      }),
    );
  });

  it("refuses http, credentials, and a non-443 port before any lookup or request", async () => {
    const lookup = vi.fn(PUBLIC);
    const { request, calls } = fakeRequest({});
    for (const url of ["http://ir.example.com/x", "https://u:p@ir.example.com/x", "https://ir.example.com:8443/x"]) {
      await expect(hardenedFetchBytes(url, { label: "t", lookup, request })).rejects.toBeInstanceOf(UrlFetchRefused);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses a hostname that resolves to a private address and never opens a socket", async () => {
    const { request, calls } = fakeRequest({});
    await expect(hardenedFetchBytes("https://ir.example.com/x", { label: "t", lookup: PRIVATE, request })).rejects.toThrow(/non-routable/);
    expect(calls).toHaveLength(0);
  });

  it("follows up to 3 redirect hops, revalidating and re-pinning each, then refuses the 4th", async () => {
    const lookup = vi.fn(PUBLIC);
    const { request, calls } = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "/2" } },
      "https://a.example/2": { status: 301, headers: { location: "https://b.example/3" } },
      "https://b.example/3": { status: 307, headers: { location: "/4" } },
      "https://b.example/4": { status: 200, chunks: [Buffer.from("<html>ok</html>")] },
    });
    const out = await hardenedFetchBytes("https://a.example/1", { label: "t", lookup, request });
    expect(out.finalUrl).toBe("https://b.example/4");
    expect(calls.map((c) => c.host)).toEqual(["a.example", "a.example", "b.example", "b.example"]);
    expect(lookup).toHaveBeenCalledTimes(4);

    const four = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "/2" } },
      "https://a.example/2": { status: 302, headers: { location: "/3" } },
      "https://a.example/3": { status: 302, headers: { location: "/4" } },
      "https://a.example/4": { status: 302, headers: { location: "/5" } },
      "https://a.example/5": { status: 200, chunks: [Buffer.from("x")] },
    });
    await expect(hardenedFetchBytes("https://a.example/1", { label: "t", lookup: PUBLIC, request: four.request })).rejects.toThrow(/3 redirect hops/);
  });

  it("refuses a redirect hop that leaves https or lands on a private address", async () => {
    const { request } = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "http://a.example/2" } },
    });
    await expect(hardenedFetchBytes("https://a.example/1", { label: "t", lookup: PUBLIC, request })).rejects.toThrow(/https/);

    const lookup = vi.fn(async (host: string) => (host === "internal.example" ? PRIVATE() : PUBLIC()));
    const hop = fakeRequest({
      "https://a.example/1": { status: 302, headers: { location: "https://internal.example/2" } },
    });
    await expect(hardenedFetchBytes("https://a.example/1", { label: "t", lookup, request: hop.request })).rejects.toThrow(/non-routable/);
  });

  it("refuses on the content-length precheck and on the streamed cap, destroying the response", async () => {
    const declared = fakeRequest({
      "https://a.example/big": { status: 200, headers: { "content-length": String(11 * 1024 * 1024) }, chunks: [Buffer.alloc(10)] },
    });
    await expect(hardenedFetchBytes("https://a.example/big", { label: "t", lookup: PUBLIC, request: declared.request })).rejects.toThrow(/content-length/);
    expect(declared.destroyed).toContain("https://a.example/big");

    const streamed = fakeRequest({
      "https://a.example/lying": { status: 200, chunks: [Buffer.alloc(600), Buffer.alloc(600)] },
    });
    await expect(hardenedFetchBytes("https://a.example/lying", { label: "t", lookup: PUBLIC, request: streamed.request, maxBytes: 1000 })).rejects.toThrow(/exceeded/);
    expect(streamed.destroyed).toContain("https://a.example/lying");
  });

  it("aborts a hung request when the shared 20s budget elapses (here: 30ms) and closes the socket", async () => {
    const { request, destroyed } = fakeRequest({ "https://a.example/hang": { status: 200, hang: true } });
    await expect(hardenedFetchBytes("https://a.example/hang", { label: "t", lookup: PUBLIC, request, timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(destroyed).toContain("req:https://a.example/hang");
  });

  it("races the DNS lookup against the shared budget and never opens a socket after it lapses (Codex #8)", async () => {
    const { request, calls } = fakeRequest({});
    const never = () => new Promise<never>(() => {});
    await expect(hardenedFetchBytes("https://slow.example/x", { label: "t", lookup: never, request, timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(calls).toHaveLength(0);
  });

  it("applies allowHost at every hop and destroys the redirect response instead of reading it", async () => {
    const { request, destroyed } = fakeRequest({
      "https://ir.acme.example/1": { status: 302, headers: { location: "https://mirror.example/2" }, chunks: [Buffer.alloc(100)] },
      "https://mirror.example/2": { status: 200, chunks: [Buffer.from("x")] },
    });
    await expect(
      hardenedFetchBytes("https://ir.acme.example/1", { label: "t", lookup: PUBLIC, request, allowHost: (h) => h === "ir.acme.example" }),
    ).rejects.toThrow(/host not allowed/);
    expect(destroyed).toContain("https://ir.acme.example/1");
  });

  it("reports a 403 with the IR-site / EDGAR hint and never a raw token in any error", async () => {
    const { request } = fakeRequest({ "https://wire.example/story?token=SECRET": { status: 403 } });
    const err = await hardenedFetchBytes("https://wire.example/story?token=SECRET", { label: "t", lookup: PUBLIC, request }).catch((e) => e as UrlFetchRefused);
    expect(err).toBeInstanceOf(UrlFetchRefused);
    expect((err as UrlFetchRefused).status).toBe(403);
    expect((err as Error).message).toMatch(/IR-site link or the EDGAR exhibit/);
    expect((err as Error).message).not.toMatch(/SECRET/);
  });
});

describe("classifyBytes", () => {
  it("recognises PDF, HTML (doctype or tag, BOM tolerated), and text", () => {
    expect(classifyBytes(Buffer.from("%PDF-1.4\n"))).toBe("pdf");
    expect(classifyBytes(Buffer.from("  <!DOCTYPE html><p>x"))).toBe("html");
    expect(classifyBytes(Buffer.from("﻿<html><body>", "utf8"))).toBe("html");
    expect(classifyBytes(Buffer.from("ACME reports Q2 results\nRevenue $1.0B\n"))).toBe("text");
  });
  it("refuses binary: a NUL byte, or 2% or more control bytes in the first 4KB", () => {
    expect(classifyBytes(Buffer.from([0x41, 0x00, 0x42]))).toBe("binary");
    const controls = Buffer.alloc(100, 0x41);
    for (let i = 0; i < 2; i++) controls[i] = 0x01;
    expect(classifyBytes(controls)).toBe("binary");
    const ok = Buffer.alloc(100, 0x41);
    ok[0] = 0x01;
    expect(classifyBytes(ok)).toBe("text");
  });
});
