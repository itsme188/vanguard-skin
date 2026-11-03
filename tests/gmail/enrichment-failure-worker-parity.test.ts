import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Worker classifier mirror (provider-failover slice 5)", () => {
  it("workers/cron/src/enrichment-failure.ts is a byte-identical copy of the Mac module", () => {
    const mac = readFileSync(join(process.cwd(), "lib/gmail/enrichment-failure.ts"), "utf8");
    const worker = readFileSync(join(process.cwd(), "workers/cron/src/enrichment-failure.ts"), "utf8");
    expect(worker).toBe(mac);
  });
});
