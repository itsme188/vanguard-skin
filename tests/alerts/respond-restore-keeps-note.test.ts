/**
 * QA findings alerts-ignored--irreversible-no-undo-regression-2 and
 * alerts-archive-tabs--response-irreversible-no-controls-regression-1
 * (owner-approved option A): an archived alert can be restored to pending.
 *
 * respondToAlert used to write `user_response_note = NULL` whenever no note
 * was passed, so a restore erased the note logged with the original response.
 * A restore to pending now keeps it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  respondToAlert,
  triggerLevel,
  upsertLevel,
} from "@/lib/mutations/security-levels";
import { getAlerts, getPendingAlertCount } from "@/lib/queries/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedAlert(): number {
  const secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('AAA', 'AAA Corp', 'stock', 'equity', 1)",
    )
    .run().lastInsertRowid as number;
  const levelId = upsertLevel(db, { security_id: secId, level_type: "entry", price: 100 });
  const { alertId } = triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 99 });
  return alertId!;
}

describe("respondToAlert — restore to pending", () => {
  it("keeps the note logged with the original response", () => {
    const id = seedAlert();
    respondToAlert(db, id, "acted", "bought a starter position");
    expect(getPendingAlertCount(db)).toBe(0);

    respondToAlert(db, id, "pending");

    const alert = getAlerts(db)[0];
    expect(alert.user_response).toBe("pending");
    expect(alert.user_response_note).toBe("bought a starter position");
    expect(getPendingAlertCount(db)).toBe(1);
  });

  it("restores an ignored or dismissed alert that never had a note", () => {
    const id = seedAlert();
    for (const response of ["ignored", "dismissed"] as const) {
      respondToAlert(db, id, response);
      respondToAlert(db, id, "pending");
      const alert = getAlerts(db)[0];
      expect(alert.user_response).toBe("pending");
      expect(alert.user_response_note).toBeNull();
    }
  });

  it("an explicit note passed with a restore still replaces the stored one", () => {
    const id = seedAlert();
    respondToAlert(db, id, "acted", "first note");
    respondToAlert(db, id, "pending", "second note");
    expect(getAlerts(db)[0].user_response_note).toBe("second note");
  });

  it("every other response still writes the note it is given, including none", () => {
    const id = seedAlert();
    respondToAlert(db, id, "acted", "first note");
    respondToAlert(db, id, "ignored");
    expect(getAlerts(db)[0].user_response_note).toBeNull();
    respondToAlert(db, id, "acted", "replacement note");
    expect(getAlerts(db)[0].user_response_note).toBe("replacement note");
  });
});
