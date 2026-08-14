import { describe, expect, it, vi } from "vitest";
import { makeApiFetch } from "@/lib/http/apiFetch";

// Packaged-app trust boundary (#35, task 8) — apiFetch is the ONE client
// wrapper allowed to make a mutating /api/* call: it attaches the
// X-CSRF-Token header on unsafe methods so the double-submit check in
// lib/auth/csrf.ts has something to compare against. Node-env safe (no
// jsdom): the injectable cookie reader means this test never touches
// `document`.

function headerValue(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe("makeApiFetch", () => {
  it("sets X-CSRF-Token from the reader on POST", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as unknown as typeof fetch);

    await apiFetch("/api/import", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(headerValue(init, "X-CSRF-Token")).toBe("TOKEN123");
  });

  it("does not set X-CSRF-Token on GET", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const readCsrf = vi.fn(() => "TOKEN123");
    const apiFetch = makeApiFetch(readCsrf, fetchMock as unknown as typeof fetch);

    await apiFetch("/api/summary");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(headerValue(init, "X-CSRF-Token")).toBeNull();
    expect(readCsrf).not.toHaveBeenCalled();
  });

  it.each(["PUT", "PATCH", "DELETE"])("sets X-CSRF-Token on %s", async (method) => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as unknown as typeof fetch);

    await apiFetch("/api/levels/1", { method });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(headerValue(init, "X-CSRF-Token")).toBe("TOKEN123");
  });

  it("preserves caller-provided headers alongside the CSRF header", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as unknown as typeof fetch);

    await apiFetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "abc" },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(headerValue(init, "Content-Type")).toBe("application/json");
    expect(headerValue(init, "X-Custom")).toBe("abc");
    expect(headerValue(init, "X-CSRF-Token")).toBe("TOKEN123");
  });

  it("preserves other caller init fields (body, cache) untouched", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as unknown as typeof fetch);

    await apiFetch("/api/import", { method: "POST", body: JSON.stringify({ a: 1 }), cache: "no-store" });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.cache).toBe("no-store");
  });

  it("defaults credentials to same-origin when the caller doesn't specify", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as unknown as typeof fetch);

    await apiFetch("/api/summary");

    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.credentials).toBe("same-origin");
  });

  it("lets the caller override credentials", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as unknown as typeof fetch);

    await apiFetch("/api/summary", { credentials: "include" });

    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.credentials).toBe("include");
  });

  it("passes the input (URL) through unchanged", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as unknown as typeof fetch);

    await apiFetch("/api/import");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/import");
  });
});

describe("default apiFetch export", () => {
  it("can be imported in a Node test environment without touching document", async () => {
    // The whole point of the lazy binding: this import must not throw even
    // though there's no `document` global in Vitest's default Node env.
    const mod = await import("@/lib/http/apiFetch");
    expect(typeof mod.default).toBe("function");
  });
});
