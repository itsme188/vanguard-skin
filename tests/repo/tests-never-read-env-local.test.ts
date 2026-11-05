import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getOpenAIApiKey, getAnthropicApiKey, getCloudflareGateway } from "@/lib/env";

describe("the test run never falls back to the developer's .env.local", () => {
  it("is wired in the vitest config and honoured by lib/env.ts", () => {
    expect(readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8")).toContain("tests/setup/env-guard.ts");
    expect(readFileSync(join(process.cwd(), "lib/env.ts"), "utf8")).toContain("VANGUARD_NO_ENV_LOCAL");
  });

  it("an empty variable reads as unconfigured even when a real .env.local sits in the cwd", () => {
    expect(process.env.VANGUARD_NO_ENV_LOCAL).toBe("1");
    const saved = { ...process.env };
    try {
      process.env.OPENAI_API_KEY = "";
      process.env.ANTHROPIC_API_KEY = "";
      process.env.CLOUDFLARE_ACCOUNT_ID = "";
      process.env.CLOUDFLARE_GATEWAY_ID = "";
      expect(getOpenAIApiKey()).toBeUndefined();
      expect(getAnthropicApiKey()).toBeUndefined();
      expect(getCloudflareGateway()).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});
