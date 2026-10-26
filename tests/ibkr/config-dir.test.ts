import { describe, it, expect } from "vitest";
import { ibkrOAuthDir } from "@/lib/ibkr/config";

describe("ibkrOAuthDir", () => {
  const cwd = "/Applications/App/standalone";
  it("VANGUARD_DB_DIR wins over cwd (packaged app)", () => {
    expect(ibkrOAuthDir({ VANGUARD_DB_DIR: "/x/data" }, cwd)).toBe("/x/data/ibkr-oauth");
  });
  it("IBKR_OAUTH_DIR wins over both", () => {
    expect(
      ibkrOAuthDir({ IBKR_OAUTH_DIR: "/o", VANGUARD_DB_DIR: "/x/data" }, cwd),
    ).toBe("/o");
  });
  it("falls back to cwd/data/ibkr-oauth", () => {
    expect(ibkrOAuthDir({}, "/repo")).toBe("/repo/data/ibkr-oauth");
  });
  it("ignores DATABASE_PATH so a sandbox DB copy never reads live credentials", () => {
    expect(ibkrOAuthDir({ DATABASE_PATH: "/sbx/vanguard.db" }, "/repo")).toBe(
      "/repo/data/ibkr-oauth",
    );
  });
});
