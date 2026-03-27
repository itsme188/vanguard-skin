"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { LiveQuote } from "@/lib/tws/streaming";

interface StreamingState {
  quotes: Map<number, LiveQuote>;
  isStreaming: boolean;
  error: string | null;
}

/**
 * React hook for consuming live streaming quotes via SSE.
 * Auto-reconnects on disconnect.
 */
export function useStreamingQuotes(enabled: boolean = false): StreamingState & {
  start: () => void;
  stop: () => void;
  saveSnapshot: () => Promise<number>;
} {
  const [quotes, setQuotes] = useState<Map<number, LiveQuote>>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = new EventSource("/api/tws/stream");
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      if (event.data === "[DONE]") {
        setIsStreaming(false);
        return;
      }

      try {
        const payload = JSON.parse(event.data);

        if (payload.type === "status") {
          setIsStreaming(payload.streaming);
          setError(null);
        }

        if (payload.type === "error") {
          setError(payload.message);
          setIsStreaming(false);
        }

        if (payload.type === "snapshot" || payload.type === "update") {
          setQuotes((prev) => {
            const next = new Map(prev);
            for (const q of payload.quotes as LiveQuote[]) {
              next.set(q.securityId, q);
            }
            return next;
          });
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      setIsStreaming(false);

      // Reconnect after 5 seconds
      reconnectTimerRef.current = setTimeout(() => {
        if (enabled) connect();
      }, 5000);
    };
  }, [enabled]);

  const start = useCallback(() => {
    setError(null);
    connect();
  }, [connect]);

  const stop = useCallback(async () => {
    // Cancel reconnect
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Close EventSource
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    // Tell server to stop
    try {
      await fetch("/api/tws/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
    } catch {
      // ignore
    }

    setIsStreaming(false);
  }, []);

  const saveSnapshot = useCallback(async (): Promise<number> => {
    try {
      const res = await fetch("/api/tws/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "snapshot" }),
      });
      const json = await res.json();
      return json.pricesSaved ?? 0;
    } catch {
      return 0;
    }
  }, []);

  // Auto-connect when enabled
  useEffect(() => {
    if (enabled) {
      connect();
    }
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [enabled, connect]);

  return { quotes, isStreaming, error, start, stop, saveSnapshot };
}
