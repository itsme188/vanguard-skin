/**
 * Source-pin: every file-store key the Settings page offers a control for must
 * be in the dev route's ALLOWED array, or `npm run dev` silently drops the save.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sliceBetween } from "../helpers/source-anchor";

const src = readFileSync(join(process.cwd(), "app/api/settings/route.ts"), "utf8");
const allowedBlock = sliceBetween(src, "const ALLOWED", "];");
const allowed = [...allowedBlock.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]);

describe("POST /api/settings ALLOWED array", () => {
  it("lists every file-store key the Settings page has a control for", async () => {
    // Implementer B's plain module; fails loudly if it is missing.
    const mod = await import("@/app/dashboard/components/settings/settings-fields");
    const fields = mod.FILE_STORE_FIELDS as Array<{ key: string }>;
    expect(fields.length).toBeGreaterThan(0);
    const missing = fields.map((f) => f.key).filter((k) => !allowed.includes(k));
    expect(missing).toEqual([]);
  });

  it("includes the five keys the old modal showed but dev dropped, and the newly exposed ones", () => {
    for (const k of [
      "resendApiKey", "resendFromDomain", "googleClientId", "googleClientSecret",
      "googleRefreshToken", "pushoverLinkBase", "finnhubApiKey", "r2AccessKeyId",
      "r2BucketName", "r2SecretAccessKey", "workerMarkerUrl", "plaidClientId",
      "plaidSecret", "plaidEnv", "plaidRedirectUri",
    ]) {
      expect(allowed, k).toContain(k);
    }
  });

  it("never lets the page write the Worker-paired cron secret", () => {
    expect(allowed).not.toContain("cronSharedSecret");
  });

  it("the page never offers a control for cronSharedSecret or firstRunComplete", async () => {
    const mod = await import("@/app/dashboard/components/settings/settings-fields");
    const keys = (mod.FILE_STORE_FIELDS as Array<{ key: string }>).map((f) => f.key);
    expect(keys).not.toContain("cronSharedSecret");
    expect(keys).not.toContain("firstRunComplete");
  });
});
