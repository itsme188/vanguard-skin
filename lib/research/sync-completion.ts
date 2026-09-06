/**
 * Drain the research route's SSE response and require its terminal completion
 * event. HTTP 200 only means the stream opened: Gmail can fail afterwards.
 * Per-stage errors are recoverable; the route still emits complete for those.
 */
export async function researchSyncCompleted(response: Response): Promise<boolean> {
  if (!response.ok || !response.body) return false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let failed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // This route emits one JSON data line per event. Keep incomplete lines
      // across chunks; a truncated terminal event must never count as success.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const event: unknown = JSON.parse(line.slice(5).trim());
        if (!event || typeof event !== "object" || !("phase" in event)) continue;
        if (event.phase === "complete") completed = true;
        if (event.phase === "error") failed = true;
      }
    }
    return completed && !failed;
  } catch {
    // A broken stream or malformed event isn't evidence of a completed sync.
    return false;
  } finally {
    reader.releaseLock();
  }
}
