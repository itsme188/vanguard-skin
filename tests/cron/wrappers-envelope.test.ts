import { describe, it, expect, afterEach } from "vitest";
import { withCronAuth } from "@/lib/cron/wrappers";

describe("withCronAuth error envelope", () => {
  const prev = process.env.CRON_SHARED_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.CRON_SHARED_SECRET;
    else process.env.CRON_SHARED_SECRET = prev;
  });
  const req = (secret?: string) =>
    new Request("http://x/api/cron/t", { headers: secret ? { "x-cron-secret": secret } : {} });

  it("missing server secret -> 500 with success:false", async () => {
    delete process.env.CRON_SHARED_SECRET;
    const res = await withCronAuth(req("a"), async () => ({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, error: expect.any(String) });
  });

  it("wrong secret -> 401 with success:false", async () => {
    process.env.CRON_SHARED_SECRET = "right";
    const res = await withCronAuth(req("wrong"), async () => ({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "unauthorized" });
  });

  it("thrown {status,message} keeps status and gets success:false", async () => {
    process.env.CRON_SHARED_SECRET = "right";
    const res = await withCronAuth(req("right"), async () => {
      throw { status: 409, message: "busy" };
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "busy" });
  });

  it("generic throw -> 500 with success:false", async () => {
    process.env.CRON_SHARED_SECRET = "right";
    const res = await withCronAuth(req("right"), async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "boom" });
  });
});
