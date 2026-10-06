import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/compute/cost-basis-reconciliation", () => ({ reconcileCostBasis: vi.fn() }));
vi.mock("@/lib/queries/accounts", () => ({ resolveScope: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} as never }));

import { GET } from "@/app/api/compute/reconciliation/route";
import { reconcileCostBasis } from "@/lib/compute/cost-basis-reconciliation";
import { resolveScope } from "@/lib/queries/accounts";

function makeReq(qs: string) {
  return { url: `http://localhost/api/compute/reconciliation${qs}` };
}

describe("GET /api/compute/reconciliation scope handling", () => {
  beforeEach(() => {
    vi.mocked(reconcileCostBasis).mockReset();
    vi.mocked(reconcileCostBasis).mockReturnValue({ ok: true } as never);
  });

  it("refuses a multi-account scope with a 400 instead of using the first account", async () => {
    vi.mocked(resolveScope).mockReturnValue([4, 5]);
    const res = await GET(makeReq("?scope=ibkr") as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/one account at a time/);
    expect(reconcileCostBasis).not.toHaveBeenCalled();
  });

  it("passes a single-account scope through", async () => {
    vi.mocked(resolveScope).mockReturnValue([4]);
    const res = await GET(makeReq("?scope=roth") as never);
    expect(res.status).toBe(200);
    expect(reconcileCostBasis).toHaveBeenCalledWith({}, { accountId: 4 });
  });

  it("runs across all accounts when the scope is unrestricted", async () => {
    vi.mocked(resolveScope).mockReturnValue(undefined);
    await GET(makeReq("?scope=all") as never);
    expect(reconcileCostBasis).toHaveBeenCalledWith({}, { accountId: undefined });
  });

  it("an explicit accountId wins and skips scope resolution", async () => {
    await GET(makeReq("?accountId=7&scope=ibkr") as never);
    expect(reconcileCostBasis).toHaveBeenCalledWith({}, { accountId: 7 });
  });
});
