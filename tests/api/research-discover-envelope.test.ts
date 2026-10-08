/**
 * POST /api/research/discover answers with the standard envelope, and its
 * failures name a remedy the product offers: the Google OAuth fields in
 * Settings (qa:research-gmail--error-remedy-names-env-local-keys-settings-cannot-set,
 * owner ruling 2026-09-14). A packaged-app owner has no .env.local to edit.
 *
 * No message may carry a token, a client secret or the name of an env key.
 * Every credential-looking string below is invented.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const hoisted = vi.hoisted(() => ({
  configured: true,
  discover: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@/lib/gmail/auth", () => ({
  isGmailConfigured: vi.fn(() => hoisted.configured),
  getGmailClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/gmail/discover", () => ({
  discoverNewsletterSenders: hoisted.discover,
}));

import { POST } from "@/app/api/research/discover/route";

beforeEach(() => {
  hoisted.configured = true;
  hoisted.discover.mockReset();
  hoisted.discover.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const ENV_NAMES = /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|\.env/;

describe("POST /api/research/discover", () => {
  it("success is { success: true, data }", async () => {
    hoisted.discover.mockResolvedValue([{ email: "news@example.com", name: "News", count: 3 }]);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: [{ email: "news@example.com", name: "News", count: 3 }],
    });
  });

  it("not configured: success:false, points at Settings, never at .env.local", async () => {
    hoisted.configured = false;
    const res = await POST();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Settings/);
    expect(body.error).toMatch(/Google OAuth/);
    expect(body.error).not.toMatch(ENV_NAMES);
    expect(hoisted.discover).not.toHaveBeenCalled();
  });

  it("an expired or revoked sign-in says to enter a new refresh token in Settings", async () => {
    hoisted.discover.mockRejectedValue(new Error("invalid_grant"));
    const res = await POST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/refresh token/i);
    expect(body.error).toMatch(/Settings/);
    expect(body.error).not.toMatch(ENV_NAMES);
  });

  it("a wrong client id or secret points at those two Settings fields", async () => {
    hoisted.discover.mockRejectedValue(new Error("invalid_client"));
    const body = await (await POST()).json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/client ID/i);
    expect(body.error).toMatch(/Settings/);
  });

  it("any other failure is a plain sentence and never echoes the raw error", async () => {
    const raw = "request to https://example.invalid failed, token=FAKE-TOKEN-zzzz secret=FAKE-SECRET-zzzz";
    hoisted.discover.mockRejectedValue(new Error(raw));
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).not.toContain("FAKE-TOKEN");
    expect(body.error).not.toContain("FAKE-SECRET");
    expect(body.error).toMatch(/Gmail/);
    // Nothing credential-shaped reaches the log either.
    const logged = JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain("FAKE-TOKEN");
    expect(logged).not.toContain("FAKE-SECRET");
  });
});

describe("SettingsModal offers the three Google OAuth fields", () => {
  const src = readFileSync("app/dashboard/components/SettingsModal.tsx", "utf8");
  const start = anchorIndex(src, "const SECTIONS = [");
  const sections = src.slice(start, anchorIndex(src, "] as const;", start));

  it("client id is plain; client secret and refresh token are masked inputs", () => {
    expect(sections).toMatch(/key: "googleClientId",[^}]*sensitive: false/);
    expect(sections).toMatch(/key: "googleClientSecret",[^}]*sensitive: true/);
    expect(sections).toMatch(/key: "googleRefreshToken",[^}]*sensitive: true/);
  });

  it("the section says these are for inbound newsletters, apart from outbound Resend", () => {
    const at = anchorIndex(sections, 'key: "googleClientId"');
    const title = sections.slice(sections.lastIndexOf("title:", at), at);
    expect(title).toMatch(/inbound/i);
    // Outbound stays Resend: the Resend fields are still there, unchanged.
    expect(sections).toContain('{ key: "resendApiKey", label: "Resend API Key (outbound)", sensitive: true }');
  });

  it("the desktop settings store carries and threads the same three keys", () => {
    const store = readFileSync("electron/settings-store.ts", "utf8");
    const main = readFileSync("electron/main.ts", "utf8");
    for (const [key, env] of [
      ["googleClientId", "GOOGLE_CLIENT_ID"],
      ["googleClientSecret", "GOOGLE_CLIENT_SECRET"],
      ["googleRefreshToken", "GOOGLE_REFRESH_TOKEN"],
    ]) {
      expect(store).toContain(`["${env}", "${key}"]`);
      expect(main).toContain(`if (settings.${key}) env.${env} = settings.${key};`);
    }
    // The two secrets are masked before they reach the renderer.
    expect(store).toContain('googleClientSecret: s.googleClientSecret ? "***" + s.googleClientSecret.slice(-4) : ""');
    expect(store).toContain('googleRefreshToken: s.googleRefreshToken ? "***" + s.googleRefreshToken.slice(-4) : ""');
  });
});
