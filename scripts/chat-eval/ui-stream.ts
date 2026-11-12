/**
 * Chat evaluation: read the route's UI message stream (pure parsing).
 *
 * The route answers with `toUIMessageStreamResponse` (AI SDK v6): Server-Sent
 * Events whose `data:` payloads are UI message chunks (`text-delta`,
 * `tool-input-available`, `finish`, `error`, ...), ending with `[DONE]`.
 * This file turns the body text into the things the scorer needs: the answer
 * text, the tool calls in order, the finish reason and the route's Contract B
 * metadata (`{ finishReason, stepCount }` on the finish chunk).
 *
 * For the multi-turn cache check the runner also needs the assistant
 * UIMessage the browser would hold; it builds that with the SDK's own
 * `readUIMessageStream` (run-golden.ts), not here.
 */

export interface StreamSummary {
  /** Every text block's text, blocks joined by a blank line (what the user reads). */
  text: string;
  /** Tool names in call order (repeats kept). */
  toolCalls: string[];
  /** Tool calls whose output was an error. */
  toolErrors: number;
  /** A tool-approval request arrived (create_note, Contract C). */
  approvalRequested: boolean;
  /** `finishReason` from the finish chunk or its metadata, else null. */
  finishReason: string | null;
  /** `stepCount` from the route's finish metadata, else null. */
  stepCount: number | null;
  /** Number of `finish-step` chunks seen. */
  finishSteps: number;
  /** The first `error` chunk's text, or null. */
  errorText: string | null;
  /** The stream was aborted. */
  aborted: boolean;
  /** `[DONE]` arrived. */
  done: boolean;
  /** Chunks that mean the model produced output (text, reasoning or tool-input). */
  contentChunks: number;
  /** Every parsed chunk, in order (kept for the UIMessage rebuild). */
  chunks: Record<string, unknown>[];
}

/** Parse SSE text into its JSON chunks (malformed payloads are skipped). */
export function parseSseChunks(body: string): { chunks: Record<string, unknown>[]; done: boolean } {
  const chunks: Record<string, unknown>[] = [];
  let done = false;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload) as unknown;
      if (obj && typeof obj === "object" && typeof (obj as { type?: unknown }).type === "string") {
        chunks.push(obj as Record<string, unknown>);
      }
    } catch {
      // not JSON: ignore
    }
  }
  return { chunks, done };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Summarise a parsed chunk list. Pure. */
export function summarizeChunks(chunks: readonly Record<string, unknown>[], done = true): StreamSummary {
  const textById = new Map<string, string>();
  const order: string[] = [];
  const toolCalls: string[] = [];
  const seenCalls = new Set<string>();
  let toolErrors = 0;
  let approvalRequested = false;
  let finishReason: string | null = null;
  let stepCount: number | null = null;
  let finishSteps = 0;
  let errorText: string | null = null;
  let aborted = false;
  let contentChunks = 0;

  const readMeta = (meta: unknown) => {
    if (!meta || typeof meta !== "object") return;
    const m = meta as Record<string, unknown>;
    if (typeof m.finishReason === "string") finishReason = m.finishReason;
    if (typeof m.stepCount === "number") stepCount = m.stepCount;
  };

  for (const c of chunks) {
    if (c.type === "text-delta" || c.type === "reasoning-delta" || c.type === "tool-input-start" || c.type === "tool-input-available") contentChunks++;
    switch (c.type) {
      case "text-start": {
        const id = str(c.id) ?? `t${order.length}`;
        if (!textById.has(id)) {
          textById.set(id, "");
          order.push(id);
        }
        break;
      }
      case "text-delta": {
        const id = str(c.id) ?? `t${order.length}`;
        if (!textById.has(id)) {
          textById.set(id, "");
          order.push(id);
        }
        textById.set(id, (textById.get(id) ?? "") + (str(c.delta) ?? ""));
        break;
      }
      case "tool-input-start":
      case "tool-input-available": {
        const id = str(c.toolCallId);
        const name = str(c.toolName);
        if (name && (!id || !seenCalls.has(id))) {
          if (id) seenCalls.add(id);
          toolCalls.push(name);
        }
        break;
      }
      case "tool-output-error":
      case "tool-input-error":
        toolErrors++;
        break;
      case "tool-approval-request":
        approvalRequested = true;
        break;
      case "finish-step":
        finishSteps++;
        break;
      case "finish":
        if (typeof c.finishReason === "string") finishReason = c.finishReason;
        readMeta(c.messageMetadata);
        break;
      case "message-metadata":
        readMeta(c.messageMetadata);
        break;
      case "error":
        if (errorText === null) errorText = str(c.errorText) ?? "stream error";
        break;
      case "abort":
        aborted = true;
        break;
      default:
        break;
    }
  }

  const text = order
    .map((id) => (textById.get(id) ?? "").trim())
    .filter((t) => t.length > 0)
    .join("\n\n");

  return {
    text,
    toolCalls,
    toolErrors,
    approvalRequested,
    finishReason,
    stepCount,
    finishSteps,
    errorText,
    aborted,
    done,
    contentChunks,
    chunks: [...chunks],
  };
}

/** Parse and summarise an SSE body in one call. */
export function summarizeSseBody(body: string): StreamSummary {
  const { chunks, done } = parseSseChunks(body);
  return summarizeChunks(chunks, done);
}
