export type TwsConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface TwsConfig {
  host: string; // default '127.0.0.1'
  port: number; // default 7497 (paper) or 7496 (live)
  clientId: number; // default 0
}

export interface TwsStatus {
  state: TwsConnectionState;
  host: string;
  port: number;
  clientId: number;
  serverVersion?: number;
  connectedAt?: string; // ISO timestamp
  error?: string;
}

export interface PriceFetchResult {
  symbol: string;
  securityId: number;
  barsInserted: number;
  barsSkipped: number;
  dateRange: { from: string; to: string } | null;
  error?: string;
}

export interface PriceFetchProgress {
  current: number; // 1-based index
  total: number;
  symbol: string;
  status: "fetching" | "done" | "error" | "rate_limited";
  result?: PriceFetchResult;
  waitingSeconds?: number; // estimated seconds until rate limit clears
}

export interface EnrichResult {
  symbol: string;
  securityId: number;
  enriched: boolean;
  sector?: string;
  industry?: string;
  exchange?: string;
  conId?: number;
  error?: string;
}
