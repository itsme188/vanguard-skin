import { db } from "@/lib/db";
import { createLinkToken, loadPlaidConfig } from "@/lib/plaid/client";
import { getPlaidConnection } from "@/lib/queries/plaid-settings";

export async function POST(request: Request) {
  const cfg = loadPlaidConfig();
  if (!cfg) {
    return Response.json(
      { success: false, error: "Plaid not configured — set PLAID_CLIENT_ID and PLAID_SECRET." },
      { status: 400 },
    );
  }
  let mode: string | undefined;
  try {
    mode = ((await request.json()) as { mode?: string }).mode;
  } catch {
    // empty body is fine
  }
  try {
    let accessToken: string | undefined;
    if (mode === "reauth") {
      const conn = getPlaidConnection(db);
      if (!conn.accessToken) {
        return Response.json(
          { success: false, error: "No existing Plaid connection to re-authenticate." },
          { status: 400 },
        );
      }
      accessToken = conn.accessToken;
    }
    const linkToken = await createLinkToken(cfg, { accessToken });
    return Response.json({ success: true, linkToken });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "link token failed" },
      { status: 500 },
    );
  }
}
