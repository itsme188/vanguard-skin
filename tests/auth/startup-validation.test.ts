import { describe, it, expect, vi } from "vitest";
import {
  findBlankServiceSecrets,
  assertServiceSecretsConfigured,
} from "@/lib/auth/startup-validation";

// Packaged-app trust boundary (#35, task 18) — boot-time fail-fast validation
// (brief Step 1/Step 3): a blank service secret must be flagged at startup.

describe("findBlankServiceSecrets", () => {
  it("flags a blank cron secret", () => {
    expect(findBlankServiceSecrets({ cronSecret: "", electronCred: "e" })).toEqual([
      "CRON_SHARED_SECRET",
    ]);
  });

  it("flags a blank electron cred", () => {
    expect(findBlankServiceSecrets({ cronSecret: "c", electronCred: undefined })).toEqual([
      "ELECTRON_SERVICE_CRED",
    ]);
  });

  it("flags whitespace-only as blank", () => {
    expect(findBlankServiceSecrets({ cronSecret: "   ", electronCred: "\t" })).toEqual([
      "CRON_SHARED_SECRET",
      "ELECTRON_SERVICE_CRED",
    ]);
  });

  it("returns empty when both secrets are set", () => {
    expect(findBlankServiceSecrets({ cronSecret: "c", electronCred: "e" })).toEqual([]);
  });
});

describe("assertServiceSecretsConfigured", () => {
  it("throws (refuses to start) on a blank secret when throwOnBlank", () => {
    const logError = vi.fn();
    expect(() =>
      assertServiceSecretsConfigured(
        { cronSecret: "", electronCred: "e" },
        { throwOnBlank: true, logError }
      )
    ).toThrow(/CRON_SHARED_SECRET/);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("logs loudly but does NOT throw when throwOnBlank is false (dev boot)", () => {
    const logError = vi.fn();
    const missing = assertServiceSecretsConfigured(
      { cronSecret: "c", electronCred: "" },
      { throwOnBlank: false, logError }
    );
    expect(missing).toEqual(["ELECTRON_SERVICE_CRED"]);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("does not log or throw when both secrets are set (normal boot)", () => {
    const logError = vi.fn();
    const missing = assertServiceSecretsConfigured(
      { cronSecret: "c", electronCred: "e" },
      { throwOnBlank: true, logError }
    );
    expect(missing).toEqual([]);
    expect(logError).not.toHaveBeenCalled();
  });
});
