import { describe, expect, it } from "vitest";
import { researchSyncCompleted } from "@/lib/research/sync-completion";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

describe("researchSyncCompleted", () => {
  it.each([400, 401, 409, 500])("does not credit HTTP %i as a sync", async (status) => {
    expect(await researchSyncCompleted(new Response("rejected", { status }))).toBe(false);
  });

  it("does not credit an empty response or progress-only stream", async () => {
    expect(await researchSyncCompleted(new Response(null))).toBe(false);
    expect(await researchSyncCompleted(streamResponse([
      'data: {"phase":"fetch","status":"done"}\n\n',
    ]))).toBe(false);
  });

  it("requires completion even when the HTTP-200 stream ends normally", async () => {
    expect(await researchSyncCompleted(streamResponse([
      'data: {"phase":"error","message":"Gmail unavailable"}\n\n',
    ]))).toBe(false);
  });

  it("accepts completion split across arbitrary network chunks", async () => {
    const payload = 'data: {"phase":"fetch","status":"done"}\r\n\r\ndata: {"phase":"complete","totalFetched":0}\r\n\r\n';
    expect(await researchSyncCompleted(streamResponse([...payload]))).toBe(true);
  });

  it("allows recoverable stage errors when the route ultimately completes", async () => {
    expect(await researchSyncCompleted(streamResponse([
      'data: {"phase":"levels","status":"error"}\n\n',
      'data: {"phase":"complete","totalFetched":2}\n\n',
    ]))).toBe(true);
  });

  it("rejects a terminal error even if completion was also received", async () => {
    expect(await researchSyncCompleted(streamResponse([
      'data: {"phase":"complete"}\n\ndata: {"phase":"error"}\n\n',
    ]))).toBe(false);
  });

  it("does not credit a truncated or malformed completion event", async () => {
    for (const payload of ['data: {"phase":"complete"', 'data: not-json\n\n']) {
      expect(await researchSyncCompleted(streamResponse([payload]))).toBe(false);
    }
  });

  it("does not credit a transport failure and releases its reader", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection lost")); },
    }));
    expect(await researchSyncCompleted(response)).toBe(false);
    expect(response.body?.locked).toBe(false);
  });
});
