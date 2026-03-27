import { EventName, WshEventData } from "@stoqey/ib";
import type { IBApi } from "@stoqey/ib";
import { getIbApi } from "./client";

const WSH_TIMEOUT_MS = 30_000;

/**
 * Access the raw IBApi instance from IBApiNext.
 *
 * IBApiNext has NO promise wrappers for WSH methods — reqWshMetaData,
 * reqWshEventData, etc. are only on the underlying IBApi class.
 * IBApiNext stores it as `private readonly api`, but TypeScript's
 * `private` is not enforced at runtime. This is the same approach
 * the @stoqey/ib test suite uses.
 */
function getRawApi(): IBApi {
  const ibApiNext = getIbApi();
  if (!ibApiNext) {
    throw new Error("TWS not connected");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (ibApiNext as any).api as IBApi;
  if (!raw) {
    throw new Error("Could not access raw IBApi from IBApiNext");
  }
  return raw;
}

/**
 * Fetch Wall Street Horizon event data from TWS.
 *
 * Returns the raw JSON string from WSH — the format is undocumented
 * by IBKR, so callers should parse defensively and store `raw_json`
 * for iteration.
 *
 * @param options.conId  Contract ID (0 = use fillPortfolio/fillWatchlist flags)
 * @param options.startDate  "YYYYMMDD" format
 * @param options.endDate    "YYYYMMDD" format
 * @param options.fillPortfolio  Include events for portfolio holdings (default: true)
 * @param options.totalLimit  Max results (default: 200)
 */
export async function fetchWshEvents(options: {
  conId?: number;
  startDate: string;
  endDate: string;
  fillPortfolio?: boolean;
  totalLimit?: number;
}): Promise<string> {
  const api = getRawApi();

  return new Promise<string>((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 100000) + 10000;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WSH event data timeout (30s)"));
    }, WSH_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      api.removeListener(EventName.wshEventData, onData);
      api.removeListener(EventName.error, onError);
    }

    function onData(id: number, dataJson: string) {
      if (id !== reqId) return;
      cleanup();
      resolve(dataJson);
    }

    function onError(err: Error, code: number, id: number) {
      if (id !== reqId) return;
      cleanup();
      reject(new Error(`WSH error [${code}]: ${err.message}`));
    }

    api.on(EventName.wshEventData, onData);
    api.on(EventName.error, onError);

    const wshData = new WshEventData(
      options.conId ?? 0,
      false,                              // fillWatchlist
      options.fillPortfolio ?? true,       // fillPortfolio
      false,                              // fillCompetitors
      options.startDate,
      options.endDate,
      options.totalLimit ?? 200
    );

    api.reqWshEventData(reqId, wshData);
  });
}

/**
 * Fetch WSH metadata — returns JSON describing available data providers.
 * Useful as a one-time diagnostic to understand what WSH data is available.
 */
export async function fetchWshMetaData(): Promise<string> {
  const api = getRawApi();

  return new Promise<string>((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 100000) + 20000;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WSH metadata timeout (15s)"));
    }, 15_000);

    function cleanup() {
      clearTimeout(timeout);
      api.removeListener(EventName.wshMetaData, onData);
      api.removeListener(EventName.error, onError);
    }

    function onData(id: number, dataJson: string) {
      if (id !== reqId) return;
      cleanup();
      resolve(dataJson);
    }

    function onError(err: Error, code: number, id: number) {
      if (id !== reqId) return;
      cleanup();
      reject(new Error(`WSH metadata error [${code}]: ${err.message}`));
    }

    api.on(EventName.wshMetaData, onData);
    api.on(EventName.error, onError);

    api.reqWshMetaData(reqId);
  });
}
