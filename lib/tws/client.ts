import { IBApiNext, ConnectionState } from "@stoqey/ib";
import type { TwsConfig, TwsConnectionState, TwsStatus } from "./types";

/** Module-level singleton state (persists across API route invocations). */
let ibApi: IBApiNext | null = null;
let connectionState: TwsConnectionState = "disconnected";
let connectedAt: string | null = null;
let lastError: string | null = null;
let currentConfig: TwsConfig = { host: "127.0.0.1", port: 7497, clientId: 0 };

export function getTwsStatus(): TwsStatus {
  return {
    state: connectionState,
    host: currentConfig.host,
    port: currentConfig.port,
    clientId: currentConfig.clientId,
    connectedAt: connectedAt ?? undefined,
    error: lastError ?? undefined,
  };
}

export async function connectTws(
  config?: Partial<TwsConfig>,
): Promise<TwsStatus> {
  if (connectionState === "connected" && ibApi) {
    return getTwsStatus();
  }

  // Disconnect any stale instance
  if (ibApi) {
    try {
      ibApi.disconnect();
    } catch {
      // ignore cleanup errors
    }
    ibApi = null;
  }

  if (config) {
    currentConfig = { ...currentConfig, ...config };
  }

  connectionState = "connecting";
  lastError = null;

  try {
    ibApi = new IBApiNext({
      host: currentConfig.host,
      port: currentConfig.port,
      reconnectInterval: 0, // no auto-reconnect in Phase 1
    });

    ibApi.connect(currentConfig.clientId);

    // Wait for connection to establish by watching connectionState observable
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout (10s)"));
      }, 10_000);

      const sub = ibApi!.connectionState.subscribe({
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

    // Verify connection with a lightweight request
    await ibApi.getCurrentTime();

    connectionState = "connected";
    connectedAt = new Date().toISOString();
  } catch (err) {
    connectionState = "error";
    lastError = err instanceof Error ? err.message : "Connection failed";
    if (ibApi) {
      try {
        ibApi.disconnect();
      } catch {
        // ignore
      }
    }
    ibApi = null;
  }

  return getTwsStatus();
}

export function disconnectTws(): TwsStatus {
  if (ibApi) {
    try {
      ibApi.disconnect();
    } catch {
      // ignore cleanup errors
    }
    ibApi = null;
  }
  connectionState = "disconnected";
  connectedAt = null;
  lastError = null;
  return getTwsStatus();
}

/**
 * Get the connected IBApiNext instance.
 * Returns null if not connected — callers should check and throw a friendly error.
 */
export function getIbApi(): IBApiNext | null {
  return connectionState === "connected" ? ibApi : null;
}
