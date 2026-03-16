import { IBApiNext, ConnectionState } from "@stoqey/ib";
import type { TwsConfig, TwsConnectionState, TwsStatus } from "./types";

/**
 * Store TWS singleton state on globalThis so it survives Turbopack HMR
 * reloads in dev mode. Without this, module re-evaluation resets ibApi
 * to null while the TCP socket to TWS stays orphaned — causing
 * "TWS not connected" errors even though connect appeared to succeed.
 */
interface TwsGlobal {
  __tws_ibApi: IBApiNext | null;
  __tws_connectionState: TwsConnectionState;
  __tws_connectedAt: string | null;
  __tws_lastError: string | null;
  __tws_config: TwsConfig;
}

const g = globalThis as unknown as Partial<TwsGlobal>;
if (g.__tws_connectionState === undefined) {
  g.__tws_ibApi = null;
  g.__tws_connectionState = "disconnected";
  g.__tws_connectedAt = null;
  g.__tws_lastError = null;
  g.__tws_config = { host: "127.0.0.1", port: 7496, clientId: 1 };
}

export function getTwsStatus(): TwsStatus {
  return {
    state: g.__tws_connectionState!,
    host: g.__tws_config!.host,
    port: g.__tws_config!.port,
    clientId: g.__tws_config!.clientId,
    connectedAt: g.__tws_connectedAt ?? undefined,
    error: g.__tws_lastError ?? undefined,
  };
}

export async function connectTws(
  config?: Partial<TwsConfig>,
): Promise<TwsStatus> {
  if (g.__tws_connectionState === "connected" && g.__tws_ibApi) {
    return getTwsStatus();
  }

  // Disconnect any stale instance
  if (g.__tws_ibApi) {
    try {
      g.__tws_ibApi.disconnect();
    } catch {
      // ignore cleanup errors
    }
    g.__tws_ibApi = null;
  }

  if (config) {
    g.__tws_config = { ...g.__tws_config!, ...config };
  }

  g.__tws_connectionState = "connecting";
  g.__tws_lastError = null;

  let api: IBApiNext | null = null;
  try {
    api = new IBApiNext({
      host: g.__tws_config!.host,
      port: g.__tws_config!.port,
      reconnectInterval: 0, // no auto-reconnect in Phase 1
    });

    api.connect(g.__tws_config!.clientId);

    // Wait for connection to establish by watching connectionState observable
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout (10s)"));
      }, 10_000);

      const sub = api!.connectionState.subscribe({
        next: (state) => {
          if (state === ConnectionState.Connected) {
            clearTimeout(timeout);
            sub.unsubscribe();
            resolve();
          }
        },
        error: (err) => {
          clearTimeout(timeout);
          sub.unsubscribe();
          reject(err);
        },
      });
    });

    // Verify connection with a lightweight request (with its own timeout
    // so a hung IB handshake doesn't block forever)
    await Promise.race([
      api.getCurrentTime(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("getCurrentTime timeout (5s)")), 5_000),
      ),
    ]);

    g.__tws_ibApi = api;
    g.__tws_connectionState = "connected";
    g.__tws_connectedAt = new Date().toISOString();
  } catch (err) {
    g.__tws_connectionState = "error";
    g.__tws_lastError = err instanceof Error ? err.message : "Connection failed";
    // Clean up the local api instance to avoid orphaned TCP sockets
    if (api) {
      try {
        api.disconnect();
      } catch {
        // ignore
      }
    }
    g.__tws_ibApi = null;
  }

  return getTwsStatus();
}

export function disconnectTws(): TwsStatus {
  if (g.__tws_ibApi) {
    try {
      g.__tws_ibApi.disconnect();
    } catch {
      // ignore cleanup errors
    }
    g.__tws_ibApi = null;
  }
  g.__tws_connectionState = "disconnected";
  g.__tws_connectedAt = null;
  g.__tws_lastError = null;
  return getTwsStatus();
}

/**
 * Get the connected IBApiNext instance.
 * Returns null if not connected — callers should check and throw a friendly error.
 */
export function getIbApi(): IBApiNext | null {
  return g.__tws_connectionState === "connected" ? g.__tws_ibApi! : null;
}
