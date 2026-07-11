import { db } from "@/lib/db";
import {
  exchangePublicToken,
  getInvestmentsHoldings,
  loadPlaidConfig,
} from "@/lib/plaid/client";
import { proposeAccountMap } from "@/lib/plaid/map-accounts";
import {
  setPlaidAccountMap,
  setPlaidAccountsCache,
  setPlaidItem,
} from "@/lib/queries/plaid-settings";
import { getAllAccounts } from "@/lib/queries/accounts";

export async function POST(request: Request) {
  const cfg = loadPlaidConfig();
  if (!cfg) {
    return Response.json({ success: false, error: "Plaid not configured." }, { status: 400 });
  }
  const { publicToken } = (await request.json()) as { publicToken?: string };
  if (!publicToken) {
    return Response.json({ success: false, error: "publicToken required" }, { status: 400 });
  }
  try {
    const { accessToken, itemId } = await exchangePublicToken(cfg, publicToken);
    setPlaidItem(db, accessToken, itemId);
    const holdings = await getInvestmentsHoldings(cfg, accessToken);
    const plaidAccounts = holdings.accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask,
      subtype: a.subtype,
    }));
    setPlaidAccountsCache(db, plaidAccounts);
    const accountMap = proposeAccountMap(holdings.accounts, getAllAccounts(db));
    setPlaidAccountMap(db, accountMap);
    return Response.json({ success: true, plaidAccounts, accountMap });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "exchange failed" },
      { status: 500 },
    );
  }
}
