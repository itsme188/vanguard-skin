import { describe, it, expect } from "vitest";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";

function res(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("readMutationResult", () => {
  it("returns ok with the parsed body on 2xx + success:true", async () => {
    const r = await readMutationResult<{ id: number }>(res(JSON.stringify({ success: true, id: 7 }), 200));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe(7);
  });

  it("prefers the server's error text on !res.ok with a JSON body", async () => {
    const r = await readMutationResult(res(JSON.stringify({ success: false, error: "Level not found" }), 404));
    expect(r).toEqual({ ok: false, status: 404, message: "Level not found" });
  });

  it("falls back to the HTTP status when a non-OK body is not JSON", async () => {
    const r = await readMutationResult(res("<html>boom</html>", 500));
    expect(r).toEqual({
      ok: false,
      status: 500,
      message: "The server returned an error (HTTP 500).",
    });
  });

  it("fails a 200 whose body says success:false, using its error text", async () => {
    const r = await readMutationResult(res(JSON.stringify({ success: false, error: "Nothing changed" }), 200));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("Nothing changed");
  });

  it("fails a 200 with an unreadable body rather than treating it as success", async () => {
    const r = await readMutationResult(res("not json", 200));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("HTTP 200");
  });
});

describe("networkFailureMessage", () => {
  it("never carries a raw exception string", () => {
    expect(networkFailureMessage("add the level")).toBe(
      "Couldn't add the level: could not reach the server. Try again.",
    );
    expect(networkFailureMessage()).not.toMatch(/Failed to fetch/i);
  });
});
