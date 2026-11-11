/**
 * Chat evaluation: send one chat request to the running app and collect
 * what came back (the stream, the conversation id, the usage lines).
 *
 * The request body is the shape the browser's `useChat` sends per call
 * (Contract A): `{ id, messages, trigger, scope, conversationId, page }`,
 * authenticated the way a browser is (session cookie, double-submit CSRF
 * cookie + header, trusted Origin). Nothing is sent that the app would not
 * receive from the real client.
 *
 * `fetch` and the log reader are injectable so the whole loop can be proven
 * against a stub server with no model call.
 */

import fs from "node:fs";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { summarizeSseBody, type StreamSummary } from "./ui-stream";
import { parseUsageLines, splitTurns, type TurnUsage } from "./usage-lines";

export interface Session {
  rawToken: string;
  csrfToken: string;
}

export interface TransportDeps {
  fetch: typeof fetch;
  /** Log text appended since `fromByte`. */
  readLogSince: (fromByte: number) => string;
  /** Current log size in bytes. */
  logSize: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function fileLogDeps(logPath: string): Pick<TransportDeps, "readLogSince" | "logSize"> {
  return {
    logSize: () => {
      try {
        return fs.statSync(logPath).size;
      } catch {
        return 0;
      }
    },
    readLogSince: (fromByte: number) => {
      try {
        const fd = fs.openSync(logPath, "r");
        try {
          const size = fs.fstatSync(fd).size;
          if (size <= fromByte) return "";
          const buf = Buffer.alloc(size - fromByte);
          fs.readSync(fd, buf, 0, buf.length, fromByte);
          return buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return "";
      }
    },
  };
}

export interface ChatRequest {
  baseUrl: string;
  session: Session;
  chatId: string;
  scope: string;
  conversationId: number | null;
  messages: UIMessage[];
  pagePath?: string;
  timeoutMs: number;
}

export interface ChatExchange {
  status: number;
  conversationId: number | null;
  summary: StreamSummary;
  /** The assistant message as the browser would hold it (SDK reconstruction). */
  assistantMessage: UIMessage | null;
  /** Non-stream error body (HTTP error), trimmed. */
  httpError: string | null;
  elapsedMs: number;
}

export function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

async function rebuildAssistant(chunks: readonly Record<string, unknown>[]): Promise<UIMessage | null> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c as unknown as UIMessageChunk);
      controller.close();
    },
  });
  let last: UIMessage | null = null;
  try {
    for await (const m of readUIMessageStream({ stream, terminateOnError: false })) last = m as UIMessage;
  } catch {
    // a malformed stream leaves the last good snapshot
  }
  return last;
}

export async function sendChat(req: ChatRequest, deps: TransportDeps): Promise<ChatExchange> {
  const origin = new URL(req.baseUrl).origin;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  try {
    const res = await deps.fetch(`${origin}/api/chat`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        origin,
        "x-csrf-token": req.session.csrfToken,
        cookie: `vgs_session=${req.session.rawToken}; vgs_csrf=${req.session.csrfToken}`,
      },
      body: JSON.stringify({
        id: req.chatId,
        messages: req.messages,
        trigger: "submit-message",
        scope: req.scope,
        conversationId: req.conversationId ?? undefined,
        ...(req.pagePath ? { page: { path: req.pagePath } } : {}),
      }),
    });
    const convHeader = res.headers.get("x-conversation-id");
    const conversationId = convHeader && /^\d+$/.test(convHeader) ? Number(convHeader) : null;
    const body = await res.text();
    if (!res.ok) {
      return {
        status: res.status,
        conversationId,
        summary: summarizeSseBody(""),
        assistantMessage: null,
        httpError: body.slice(0, 300) || `HTTP ${res.status}`,
        elapsedMs: Date.now() - started,
      };
    }
    const summary = summarizeSseBody(body);
    return {
      status: res.status,
      conversationId,
      summary,
      assistantMessage: await rebuildAssistant(summary.chunks),
      httpError: null,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return {
      status: 0,
      conversationId: null,
      summary: summarizeSseBody(""),
      assistantMessage: null,
      httpError: ctrl.signal.aborted ? `timed out after ${req.timeoutMs} ms` : (err as Error)?.message?.slice(0, 200) ?? "fetch failed",
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until the log holds `wantTurns` turn lines for the conversation
 * (the route writes the turn line in onFinish, just after the stream ends).
 * Returns whatever it has at the deadline.
 */
export async function waitForUsage(
  deps: TransportDeps,
  fromByte: number,
  conversationId: number,
  wantTurns: number,
  timeoutMs = 15000,
): Promise<TurnUsage[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turns = splitTurns(parseUsageLines(deps.readLogSince(fromByte)), conversationId);
    if (turns.filter((t) => t.turn !== null).length >= wantTurns || Date.now() >= deadline) return turns;
    await deps.sleep(250);
  }
}
