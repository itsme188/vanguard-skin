import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  IN_PROGRESS, SENDING, SENT_BY_CLOUD, DELIVERY_UNKNOWN,
  LIVE_CLAIM_STATES, DELIVERED_SENTINELS,
  isLiveClaim, isDelivered, isDeliveredStrict,
  notLiveClaimSql, deliveredSql, sendStateFor, sentByFor,
} from "@/lib/earnings/email-states";

describe("email-states vocabulary", () => {
  it("names the five states", () => {
    expect([IN_PROGRESS, SENDING, SENT_BY_CLOUD, DELIVERY_UNKNOWN])
      .toEqual(["in_progress", "sending", "sent-by-cloud", "delivery_unknown"]);
    expect(LIVE_CLAIM_STATES).toEqual(["in_progress", "sending"]);
    expect(DELIVERED_SENTINELS).toEqual(["sent-by-cloud", "delivery_unknown"]);
  });

  it("isLiveClaim covers both live values and nothing else", () => {
    expect(isLiveClaim("in_progress")).toBe(true);
    expect(isLiveClaim("sending")).toBe(true);
    for (const v of [null, "sent-by-cloud", "delivery_unknown", "Send failed: boom"]) {
      expect(isLiveClaim(v)).toBe(false);
    }
  });

  it("isDelivered admits legacy text; isDeliveredStrict does not (they are different questions)", () => {
    for (const v of [null, "sent-by-cloud", "delivery_unknown"]) {
      expect(isDelivered(v)).toBe(true);
      expect(isDeliveredStrict(v)).toBe(true);
    }
    expect(isDelivered("Send failed: boom")).toBe(true);
    expect(isDeliveredStrict("Send failed: boom")).toBe(false);
    expect(isDelivered("in_progress")).toBe(false);
    expect(isDelivered("sending")).toBe(false);
    expect(isDeliveredStrict("sending")).toBe(false);
  });

  it("maps a stored value to its display word and its sender", () => {
    expect(sendStateFor(null)).toBe("sent");
    expect(sendStateFor("sent-by-cloud")).toBe("sent-by-cloud");
    expect(sendStateFor("in_progress")).toBe("in-flight");
    expect(sendStateFor("sending")).toBe("in-flight");
    expect(sendStateFor("delivery_unknown")).toBe("delivery-unknown");
    expect(sendStateFor("Send failed: boom")).toBe("sent");
    expect(sentByFor("sent-by-cloud")).toBe("cloud");
    expect(sentByFor(null)).toBe("local");
    expect(sentByFor("delivery_unknown")).toBe("local");
  });

  it("the SQL fragments say exactly what the JS twins say, against a real table", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const eventIds: number[] = [];
    const states: Array<string | null> = [null, "in_progress", "sending", "sent-by-cloud", "delivery_unknown", "Send failed: boom"];
    states.forEach((state, i) => {
      const id = Number(
        db.prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
           VALUES ('manual','earnings','2026-09-10','XMPL','XMPL',?)`,
        ).run(`k${i}`).lastInsertRowid,
      );
      eventIds.push(id);
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, error) VALUES (?, 'recap', 'x@y.com', ?)`,
      ).run(id, state);
    });
    const notLive = db.prepare(
      `SELECT error FROM earnings_emails WHERE ${notLiveClaimSql("error")} ORDER BY id`,
    ).all() as Array<{ error: string | null }>;
    expect(notLive.map((r) => r.error)).toEqual(
      states.filter((s) => !isLiveClaim(s)),
    );
    const delivered = db.prepare(
      `SELECT error FROM earnings_emails WHERE ${deliveredSql("error")} ORDER BY id`,
    ).all() as Array<{ error: string | null }>;
    expect(delivered.map((r) => r.error)).toEqual(
      states.filter((s) => isDeliveredStrict(s)),
    );
    db.close();
  });

  it("the SQL builders quote the column they are given", () => {
    expect(notLiveClaimSql("ee.error")).toBe(
      "(ee.error IS NULL OR ee.error NOT IN ('in_progress','sending'))",
    );
    expect(deliveredSql("ee.error")).toBe(
      "(ee.error IS NULL OR ee.error IN ('sent-by-cloud','delivery_unknown'))",
    );
  });
});
