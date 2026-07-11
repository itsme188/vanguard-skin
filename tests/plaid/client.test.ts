import { describe, it, expect } from "vitest";
import {
  createLinkToken,
  exchangePublicToken,
  getInvestmentsHoldings,
  loadPlaidConfig,
  PlaidApiError,
  type PlaidClientConfig,
} from "@/lib/plaid/client";

function stubFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function cfg(fetchImpl: typeof fetch): PlaidClientConfig {
  return {
    clientId: "cid",
    secret: "sec",
    env: "sandbox",
    redirectUri: "http://localhost:3099/dashboard/plaid-link",
    fetchImpl,
  };
}

describe("plaid client", () => {
  it("createLinkToken posts investments product + redirect_uri and returns token", async () => {
    const { impl, calls } = stubFetch([{ json: { link_token: "link-abc" } }]);
    const token = await createLinkToken(cfg(impl));
    expect(token).toBe("link-abc");
    expect(calls[0].url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(calls[0].body.client_id).toBe("cid");
    expect(calls[0].body.secret).toBe("sec");
    expect(calls[0].body.products).toEqual(["investments"]);
    expect(calls[0].body.country_codes).toEqual(["US"]);
    expect(calls[0].body.redirect_uri).toBe("http://localhost:3099/dashboard/plaid-link");
  });

  it("createLinkToken in reauth mode passes access_token and omits products", async () => {
    const { impl, calls } = stubFetch([{ json: { link_token: "link-re" } }]);
    await createLinkToken(cfg(impl), { accessToken: "access-1" });
    expect(calls[0].body.access_token).toBe("access-1");
    expect(calls[0].body.products).toBeUndefined();
  });

  it("exchangePublicToken returns accessToken + itemId", async () => {
    const { impl } = stubFetch([{ json: { access_token: "access-x", item_id: "item-x" } }]);
    const r = await exchangePublicToken(cfg(impl), "public-1");
    expect(r).toEqual({ accessToken: "access-x", itemId: "item-x" });
  });

  it("getInvestmentsHoldings returns the typed payload", async () => {
    const payload = { accounts: [], holdings: [], securities: [] };
    const { impl, calls } = stubFetch([{ json: payload }]);
    const r = await getInvestmentsHoldings(cfg(impl), "access-x");
    expect(r).toEqual(payload);
    expect(calls[0].url).toBe("https://sandbox.plaid.com/investments/holdings/get");
    expect(calls[0].body.access_token).toBe("access-x");
  });

  it("maps Plaid error bodies to PlaidApiError with error_code", async () => {
    const { impl } = stubFetch([
      {
        status: 400,
        json: { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", error_message: "re-auth" },
      },
    ]);
    await expect(getInvestmentsHoldings(cfg(impl), "access-x")).rejects.toThrowError(PlaidApiError);
    try {
      await getInvestmentsHoldings(cfg(impl), "access-x");
    } catch (e) {
      expect((e as PlaidApiError).errorCode).toBe("ITEM_LOGIN_REQUIRED");
    }
  });

  describe("loadPlaidConfig redirectUri (F3)", () => {
    // process.env.PLAID_REDIRECT_URI ?? default treated "" (Electron
    // settings.json injection with an unset/blank field) as PRESENT,
    // shipping an empty redirect_uri to Plaid. Must fall back to the
    // default on empty string, not just undefined.
    const ENV_KEYS = ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_REDIRECT_URI", "PLAID_ENV"] as const;
    const saved: Record<string, string | undefined> = {};

    function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      try {
        for (const key of ENV_KEYS) {
          if (overrides[key] === undefined) delete process.env[key];
          else process.env[key] = overrides[key];
        }
        fn();
      } finally {
        for (const key of ENV_KEYS) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    }

    it("falls back to the default redirectUri when PLAID_REDIRECT_URI is an empty string", () => {
      withEnv(
        { PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", PLAID_REDIRECT_URI: "" },
        () => {
          const cfg = loadPlaidConfig();
          expect(cfg?.redirectUri).toBe("http://localhost:3099/dashboard/plaid-link");
        },
      );
    });

    it("uses PLAID_REDIRECT_URI when it's a non-empty string", () => {
      withEnv(
        {
          PLAID_CLIENT_ID: "cid",
          PLAID_SECRET: "sec",
          PLAID_REDIRECT_URI: "https://example.com/plaid-link",
        },
        () => {
          const cfg = loadPlaidConfig();
          expect(cfg?.redirectUri).toBe("https://example.com/plaid-link");
        },
      );
    });
  });
});
