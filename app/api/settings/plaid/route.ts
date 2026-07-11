import { db } from "@/lib/db";
import { buildPlaidSettingsPayload } from "@/lib/queries/plaid-settings-payload";
import { setPlaidAccountMap } from "@/lib/queries/plaid-settings";
import { getAllAccounts } from "@/lib/queries/accounts";

export async function GET() {
  return Response.json(buildPlaidSettingsPayload(db));
}

export async function PATCH(request: Request) {
  const { accountMap } = (await request.json()) as { accountMap?: Record<string, number> };
  if (!accountMap || typeof accountMap !== "object" || Array.isArray(accountMap)) {
    return Response.json({ success: false, error: "accountMap object required" }, { status: 400 });
  }
  const validIds = new Set(getAllAccounts(db).map((a) => a.id));
  for (const [plaidId, localId] of Object.entries(accountMap)) {
    if (!validIds.has(localId)) {
      return Response.json(
        { success: false, error: `Unknown local account id ${localId} for ${plaidId}` },
        { status: 400 },
      );
    }
  }
  setPlaidAccountMap(db, accountMap);
  return Response.json({ success: true, ...buildPlaidSettingsPayload(db) });
}
