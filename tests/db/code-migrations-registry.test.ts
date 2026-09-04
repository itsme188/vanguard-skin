import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CODE_MIGRATIONS } from "@/lib/db/code-migrations";

const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "db", "migrations");

describe("code-migrations registry (M1 guard)", () => {
  it("registers every NNN_*.ts file under lib/db/migrations, and nothing that is not on disk", () => {
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".ts")).sort();
    expect(Object.keys(CODE_MIGRATIONS).sort()).toEqual(onDisk);
  });

  it("uses the NNN_name.ts convention and never shares a number with a .sql migration", () => {
    const sqlNumbers = new Set(
      fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, 3)),
    );
    for (const name of Object.keys(CODE_MIGRATIONS)) {
      expect(name).toMatch(/^\d{3}_[a-z0-9_]+\.ts$/);
      expect(sqlNumbers.has(name.slice(0, 3))).toBe(false);
    }
  });
});
