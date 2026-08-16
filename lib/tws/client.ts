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
  __tws_connectionSub: { unsubscribe(): void } | null;
}

const g = globalThis as unknown as Partial<TwsGlobal>;
if (g.__tws_connectionState === undefined) {
  g.__tws_ibApi = null;
  g.__tws_connectionState = "disconnected";
  g.__tws_connectedAt = null;
  g.__tws_lastError = null;
  g.__tws_config = { host: "127.0.0.1", port: 7496, clientId: 1 };
  g.__tws_connectionSub = null;
}

/**
 * Cross-check stored connection state against the actual IBApiNext instance.
 * If we think we're connected but the socket is dead, force-transition to
 * disconnected. This is synchronous (no I/O) — safe for polling endpoints.
 */
function verifyConnectionState(): void {
  if (
    g.__tws_connectionState === "connected" &&
    g.__tws_ibApi &&
    !g.__tws_ibApi.isConnected
  ) {
    // Socket is dead — clean up stale state
    g.__tws_connectionSub?.unsubscribe();
    g.__tws_connectionSub = null;
    try {
      g.__tws_ibApi.disconnect();
    } catch {
      // ignore cleanup errors
    }
    g.__tws_ibApi = null;
    g.__tws_connectionState = "disconnected";
    g.__tws_connectedAt = null;
    g.__tws_lastError = "Connection lost";
  }
}

/**
 * Standard TWS API ports this app documents/supports (see TwsConfig.port
 * comment in ./types.ts): 7496 (live) and 7497 (paper). IB Gateway's
 * 4001/4002 are deliberately NOT included — nothing in this codebase
 * connects to or documents support for IB Gateway; adding unused ports to
 * an allowlist only widens the attack surface without a real need.
 */
const ALLOWED_TWS_PORTS = new Set([7496, 7497]);

/**
 * Defense-in-depth (packaged-app trust boundary #35, Task 19, spec §G):
 * `POST /api/tws/connect` forwards a caller-supplied host/port straight into
 * this module's raw TCP connect. Without a target check, a caller with a
 * stolen session/cred could use the route as an SSRF/port-scan primitive —
 * probing arbitrary host:port combos through the app's network position.
 * This does NOT replace the auth boundary (the route is `dual` class); it
 * limits blast radius after any credential compromise.
 *
 * Throws when `host`/`port` fall outside the allowlist:
 *   - host: 127.0.0.1, localhost, or the configured TWS_HOST env value
 *     (if set) — case-insensitive.
 *   - port: 7496 (live) or 7497 (paper).
 */
export function assertAllowedTwsTarget(host: string, port: number): void {
  const allowedHosts = new Set(["127.0.0.1", "localhost"]);
  const configuredHost = process.env.TWS_HOST;
  if (configuredHost) allowedHosts.add(configuredHost.toLowerCase());

  const normalizedHost = (host ?? "").toLowerCase();
  if (!allowedHosts.has(normalizedHost)) {
    throw new Error(`TWS connect target not allowed: host "${host}" is not in the allowlist`);
  }

  if (!ALLOWED_TWS_PORTS.has(port)) {
    throw new Error(`TWS connect target not allowed: port ${port} is not a standard TWS port`);
  }
}

export function getTwsStatus(): TwsStatus {
  verifyConnectionState();
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

  // Clean up any stale subscription
  g.__tws_connectionSub?.unsubscribe();
  g.__tws_connectionSub = null;

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

    // Install persistent subscription to detect disconnects automatically.
    // Without this, g.__tws_connectionState stays "connected" forever after
    // TWS closes — the 30s UI polling just reads the stale globalThis state.
    g.__tws_connectionSub = api.connectionState.subscribe({
      next: (state) => {
        if (state === ConnectionState.Disconnected) {
          g.__tws_connectionState = "disconnected";
          g.__tws_connectedAt = null;
          g.__tws_lastError = "Connection lost";
          g.__tws_ibApi = null;
          g.__tws_connectionSub?.unsubscribe();
          g.__tws_connectionSub = null;
        }
      },
      error: (err) => {
        g.__tws_connectionState = "error";
        g.__tws_lastError = err instanceof Error ? err.message : "Connection error";
        g.__tws_ibApi = null;
        g.__tws_connectionSub?.unsubscribe();
        g.__tws_connectionSub = null;
      },
    });
  } catch (err) {
    g.__tws_connectionState = "error";
    g.__tws_lastError = err instanceof Error ? err.message : "Connection failed";
    // Clean up subscription if somehow set
    g.__tws_connectionSub?.unsubscribe();
    g.__tws_connectionSub = null;
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
  // Clean up the persistent connection subscription first
  g.__tws_connectionSub?.unsubscribe();
  g.__tws_connectionSub = null;

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
  verifyConnectionState();
  return g.__tws_connectionState === "connected" ? g.__tws_ibApi! : null;
}
