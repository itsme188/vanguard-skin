import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("password minimum length is single-sourced", () => {
  it("electron mirror constant equals the lib constant", () => {
    const m = read("electron/password-prompt.ts").match(/export const MIN_PASSWORD_LENGTH = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(MIN_PASSWORD_LENGTH);
  });

  it("no consumer re-hardcodes the length", () => {
    for (const f of ["electron/main.ts", "app/dashboard/components/SecuritySection.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("MIN_PASSWORD_LENGTH");
      expect(src, f).not.toMatch(/length < 8\b/);
      expect(src, f).not.toMatch(/at least 8 characters/);
    }
  });

  it("LoginResponse is exported once from the login route", () => {
    expect(read("app/login/page.tsx")).not.toMatch(/type LoginResponse =/);
    expect(read("app/api/auth/login/route.ts")).toMatch(/export type LoginResponse =/);
  });
});
