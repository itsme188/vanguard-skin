/**
 * An expired option whose closing entry is recorded (EXPIRED in the ledger,
 * no open lot) is not "expired — awaiting its closing entry", even when a
 * stale non-statement holdings row still carries a quantity and the newer
 * statement book omits the pair without a tombstone. It takes the
 * pending-statement wording (warning, never critical). A pair that still has
 * an open lot keeps the expired wording. Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { createPendingTestDb, seedSec, seedFill, seedHold } from "../setup/pending-statement-fixtures";

const IBKR = 3;
const TODAY = "2026-11-11";

let db: Database.Database;
let closed: number;
let open: number;

beforeEach(() => {
  db = createPendingTestDb();
  // The account's statement book is newer than either option's rows and
  // carries neither of them (no tombstone was written for them).
  const stock = seedSec(db, "ZZST");
  seedFill(db, IBKR, stock, "2026-01-05", "BUY", 10, 10);
  seedHold(db, IBKR, stock, "2026-03-31", "stmt", 10);

  // Closed: opened, expired with its EXPIRED entry recorded; a stale live row
  // from before the expiry still says 2.
  closed = seedSec(db, "ZZXC  260220C00010000", "Option");
  db.prepare("UPDATE securities SET expiration_date = ? WHERE id = ?").run("2026-02-20", closed);
  seedFill(db, IBKR, closed, "2026-01-05", "BUY_TO_OPEN", 2, 1);
  seedFill(db, IBKR, closed, "2026-02-20", "EXPIRED", 2, 0);
  seedHold(db, IBKR, closed, "2026-01-30", "tws", 2);

  // Open: expired, no closing entry; the statement agrees with the lot and a
  // later live row differs, so the pair reaches the statement-agrees branch.
  open = seedSec(db, "ZZXO  260220C00010000", "Option");
  db.prepare("UPDATE securities SET expiration_date = ? WHERE id = ?").run("2026-02-20", open);
  seedFill(db, IBKR, open, "2026-01-05", "BUY_TO_OPEN", 2, 1);
  seedHold(db, IBKR, open, "2026-01-30", "stmt", 2);
  seedHold(db, IBKR, open, "2026-02-10", "tws", 1);

  computeTaxLots(db);
});

describe("expired option: closing entry recorded vs still awaited", () => {
  it("the fixture has the intended lots", () => {
    const remaining = (id: number) =>
      (db.prepare("SELECT SUM(quantity_remaining) AS q FROM tax_lots WHERE security_id = ?").get(id) as { q: number }).q;
    expect(remaining(closed)).toBe(0);
    expect(remaining(open)).toBe(2);
  });

  it("a closed lot with a stale live row is not 'awaiting its closing entry'", () => {
    const { warnings, critical, lotDriftChecked } = runIntegrityChecks(db, { today: TODAY });
    expect(lotDriftChecked).toBe(true);
    const key = `lot-drift:${IBKR}:${closed}`;
    expect(critical.find((c) => c.key.startsWith(key))).toBeUndefined();
    const hits = warnings.filter((w) => w.key.startsWith(key));
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe(
      "ZZXC  260220C00010000 (IBKR): expired — its last holdings row has not been cleared yet"
    );
    expect(hits[0].kind).toBe("statement-lag");
    expect(hits[0].reason).not.toMatch(/awaiting its closing entry/);
    expect(hits[0].reason).not.toMatch(/live position/);
  });

  it("an open lot keeps the expired wording", () => {
    const { warnings, critical } = runIntegrityChecks(db, { today: TODAY });
    const key = `lot-drift:${IBKR}:${open}`;
    expect(critical.find((c) => c.key.startsWith(key))).toBeUndefined();
    const hit = warnings.find((w) => w.key === key);
    expect(hit?.reason).toBe("ZZXO  260220C00010000 (IBKR): expired — awaiting its closing entry");
  });
});

describe("expired option that never had a lot or a ledger row", () => {
  it("is never worded as a live position", () => {
    const d = createPendingTestDb();
    const stock = seedSec(d, "ZZST");
    seedFill(d, IBKR, stock, "2026-01-05", "BUY", 10, 10);
    seedHold(d, IBKR, stock, "2026-03-31", "stmt", 10);
    const never = seedSec(d, "AAA   260220C00010000", "Option");
    d.prepare("UPDATE securities SET expiration_date = ? WHERE id = ?").run("2026-02-20", never);
    seedHold(d, IBKR, never, "2026-02-10", "tws", 3);
    computeTaxLots(d);
    const { warnings, critical } = runIntegrityChecks(d, { today: TODAY });
    const key = `lot-drift:${IBKR}:${never}`;
    expect(critical.find((c) => c.key.startsWith(key))).toBeUndefined();
    const hit = warnings.find((w) => w.key.startsWith(key));
    expect(hit?.reason).toMatch(/expired/);
    expect(hit?.reason).not.toMatch(/live position/);
    expect(hit?.kind).toBe("statement-lag");
  });
});
