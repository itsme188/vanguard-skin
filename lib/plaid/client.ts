// Plain-fetch Plaid REST client. Deliberately NO npm SDK: keeps the
// dependency surface flat and matches the Worker-mirror convention
// (any future cloud path must be fetch-based anyway).
export interface PlaidClientConfig {
  clientId: string;
  secret: string;
  env: "sandbox" | "production";
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

const HOSTS: Record<PlaidClientConfig["env"], string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export function loadPlaidConfig(): PlaidClientConfig | null {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) return null;
  const env = process.env.PLAID_ENV === "sandbox" ? "sandbox" : "production";
  return {
    clientId,
    secret,
    env,
    redirectUri:
      process.env.PLAID_REDIRECT_URI || "http://localhost:3099/dashboard/plaid-link",
  };
}

export class PlaidApiError extends Error {
  errorCode: string;
  errorType: string;
  constructor(message: string, errorCode: string, errorType: string) {
    super(message);
    this.name = "PlaidApiError";
    this.errorCode = errorCode;
    this.errorType = errorType;
  }
}

async function plaidPost<T>(
  cfg: PlaidClientConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${HOSTS[cfg.env]}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof json.error_code === "string") {
    throw new PlaidApiError(
      String(json.error_message ?? `Plaid ${path} failed (HTTP ${res.status})`),
      String(json.error_code ?? `HTTP_${res.status}`),
      String(json.error_type ?? "UNKNOWN"),
    );
  }
  return json as T;
}

export async function createLinkToken(
  cfg: PlaidClientConfig,
  opts: { accessToken?: string } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    client_name: "Portfolio Desk",
    user: { client_user_id: "vanguard-skin-local" },
    country_codes: ["US"],
    language: "en",
    redirect_uri: cfg.redirectUri,
  };
  if (opts.accessToken) {
    body.access_token = opts.accessToken; // Link update mode (re-auth)
  } else {
    body.products = ["investments"];
  }
  const r = await plaidPost<{ link_token: string }>(cfg, "/link/token/create", body);
  return r.link_token;
}

export async function exchangePublicToken(
  cfg: PlaidClientConfig,
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const r = await plaidPost<{ access_token: string; item_id: string }>(
    cfg,
    "/item/public_token/exchange",
    { public_token: publicToken },
  );
  return { accessToken: r.access_token, itemId: r.item_id };
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
  balances: { current: number | null; available: number | null };
}

export interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number | null;
  institution_value: number | null;
  institution_price_as_of: string | null;
}

export interface PlaidSecurity {
  security_id: string;
  ticker_symbol: string | null;
  cusip: string | null;
  name: string | null;
  type: string | null;
  is_cash_equivalent: boolean | null;
  option_contract?: {
    contract_type: "call" | "put";
    expiration_date: string;
    strike_price: number;
    underlying_security_ticker: string | null;
  } | null;
}

export interface PlaidHoldingsResponse {
  accounts: PlaidAccount[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
}

export async function getInvestmentsHoldings(
  cfg: PlaidClientConfig,
  accessToken: string,
): Promise<PlaidHoldingsResponse> {
  return plaidPost<PlaidHoldingsResponse>(cfg, "/investments/holdings/get", {
    access_token: accessToken,
  });
}
