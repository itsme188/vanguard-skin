import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// Mock the TWS client module
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

// Mock the rate limiter to be instant
vi.mock("@/lib/tws/rate-limiter", () => ({
  RateLimiter: class {
    async waitForSlot() {}
    get activeCount() { return 0; }
    reset() {}
  },
}));

import { getIbApi } from "@/lib/tws/client";
import { enrichSecurities } from "@/lib/tws/contracts";

const mockedGetIbApi = vi.mocked(getIbApi);

function seedSecurity(
  db: Database.Database,
  symbol: string,
  securityType?: string,
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)",
    )
    .run(symbol, symbol + " Corp", securityType ?? "stock");
  return result.lastInsertRowid as number;
}

describe("enrichSecurities", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.clearAllMocks();
  });

  it("throws when TWS not connected", async () => {
    mockedGetIbApi.mockReturnValue(null);
    await expect(enrichSecurities(db)).rejects.toThrow("TWS not connected");
  });

  it("enriches a security with contract details", async () => {
    const secId = seedSecurity(db, "AAPL", "stock");

    const mockApi = {
      getContractDetails: vi.fn().mockResolvedValue([
        {
          industry: "Technology",
          category: "Computers",
          subcategory: "Consumer Electronics",
          contract: { conId: 265598, primaryExch: "NASDAQ" },
        },
      ]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await enrichSecurities(db, [secId]);

    expect(results).toHaveLength(1);
    expect(results[0].enriched).toBe(true);
    expect(results[0].sector).toBe("Technology");
    expect(results[0].industry).toBe("Computers");
    expect(results[0].exchange).toBe("NASDAQ");
    expect(results[0].conId).toBe(265598);

    // Verify DB was updated
    const sec = db
      .prepare(
        "SELECT sector, industry, exchange, ib_con_id FROM securities WHERE id = ?",
      )
      .get(secId) as {
      sector: string;
      industry: string;
      exchange: string;
      ib_con_id: number;
    };
    expect(sec.sector).toBe("Technology");
    expect(sec.industry).toBe("Computers");
    expect(sec.exchange).toBe("NASDAQ");
    expect(sec.ib_con_id).toBe(265598);
  });

  it("handles no contract details found", async () => {
    const secId = seedSecurity(db, "UNKNOWN", "stock");

    const mockApi = {
      getContractDetails: vi.fn().mockResolvedValue([]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await enrichSecurities(db, [secId]);

    expect(results).toHaveLength(1);
    expect(results[0].enriched).toBe(false);
  });

  it("only fetches held securities without ib_con_id when no IDs specified", async () => {
    // Security with ib_con_id already set (held)
    db.prepare(
      "INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, ?, ?)",
    ).run("AAPL", "Apple", "stock", 265598);
    const aaplId = db.prepare("SELECT id FROM securities WHERE symbol = 'AAPL'").get() as { id: number };

    // Security without ib_con_id (held)
    const msftId = seedSecurity(db, "MSFT", "stock");

    // Security without ib_con_id (NOT held — should be skipped)
    seedSecurity(db, "GOOG", "stock");

    // Create an account and holdings for AAPL and MSFT only
    db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
    const acctId = (db.prepare("SELECT id FROM accounts WHERE name = 'Test'").get() as { id: number }).id;
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)").run(acctId, aaplId.id, 100, "2026-04-01");
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)").run(acctId, msftId, 50, "2026-04-01");

    const mockApi = {
      getContractDetails: vi.fn().mockResolvedValue([
        {
          industry: "Technology",
          category: "Software",
          contract: { conId: 272093, primaryExch: "NASDAQ" },
        },
      ]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await enrichSecurities(db);

    // Should only enrich MSFT (AAPL already has ib_con_id)
    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe("MSFT");
    expect(results[0].enriched).toBe(true);
  });

  it("handles errors per-security without aborting batch", async () => {
    const secId1 = seedSecurity(db, "GOOD", "stock");
    const secId2 = seedSecurity(db, "BAD", "stock");

    const mockApi = {
      getContractDetails: vi.fn().mockImplementation((contract: { symbol?: string }) => {
        if (contract.symbol === "BAD") {
          return Promise.reject(new Error("Contract not found"));
        }
        return Promise.resolve([
          {
            industry: "Technology",
            category: "Software",
            contract: { conId: 12345, primaryExch: "NYSE" },
          },
        ]);
      }),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await enrichSecurities(db, [secId1, secId2]);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.symbol === "GOOD")?.enriched).toBe(true);
    expect(results.find((r) => r.symbol === "BAD")?.enriched).toBe(false);
    expect(results.find((r) => r.symbol === "BAD")?.error).toBe(
      "Contract not found",
    );
  });
});
