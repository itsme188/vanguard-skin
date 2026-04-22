import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getRecentConversations,
  getConversationMessages,
} from "@/lib/queries/chat";
import {
  createConversation,
  saveMessage,
  updateConversationTitle,
  deleteConversation,
} from "@/lib/mutations/chat";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("chat queries + mutations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  describe("createConversation + saveMessage", () => {
    it("creates a conversation and records messages", () => {
      const convId = createConversation(db, "ibkr");
      expect(convId).toBeGreaterThan(0);

      saveMessage(db, convId, "user", "What's my NVDA position?", null);
      saveMessage(db, convId, "assistant", "You hold 100 shares.", null);

      const messages = getConversationMessages(db, convId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("What's my NVDA position?");
      expect(messages[1].role).toBe("assistant");
    });

    it("stores parts JSON string when provided", () => {
      const convId = createConversation(db, "all");
      const parts = JSON.stringify([{ type: "text", text: "hello" }]);
      saveMessage(db, convId, "user", null, parts);

      const messages = getConversationMessages(db, convId);
      expect(messages[0].parts).toBe(parts);
    });
  });

  describe("getRecentConversations", () => {
    it("orders by updated_at DESC and includes message_count", () => {
      const a = createConversation(db, "all");
      const b = createConversation(db, "ibkr");
      const c = createConversation(db, "vanguard-taxable");

      // Messages (irrelevant to ordering but used for count assertion)
      saveMessage(db, b, "user", "hi", null);
      saveMessage(db, b, "assistant", "hello", null);

      // Force distinct updated_at values — datetime('now') only has second
      // resolution, so same-tick inserts tie. Set explicit timestamps.
      const stamp = db.prepare(
        `UPDATE chat_conversations SET updated_at = ? WHERE id = ?`,
      );
      stamp.run("2026-04-22 10:00:00", a);
      stamp.run("2026-04-22 10:00:01", b);
      stamp.run("2026-04-22 10:00:02", c);

      const convs = getRecentConversations(db, 10);
      expect(convs.length).toBe(3);
      expect(convs[0].id).toBe(c);
      expect(convs[1].id).toBe(b);
      expect(convs[2].id).toBe(a);

      const bRow = convs.find((x) => x.id === b)!;
      expect(bRow.message_count).toBe(2);
      const aRow = convs.find((x) => x.id === a)!;
      expect(aRow.message_count).toBe(0);
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) createConversation(db, "all");
      const convs = getRecentConversations(db, 3);
      expect(convs.length).toBe(3);
    });
  });

  describe("updateConversationTitle", () => {
    it("sets the title", () => {
      const id = createConversation(db, "all");
      updateConversationTitle(db, id, "My NVDA question");
      const [conv] = getRecentConversations(db, 10);
      expect(conv.title).toBe("My NVDA question");
    });
  });

  describe("deleteConversation", () => {
    it("returns true when row existed and cascades messages", () => {
      const id = createConversation(db, "all");
      saveMessage(db, id, "user", "hi", null);
      saveMessage(db, id, "assistant", "hello", null);
      expect(getConversationMessages(db, id)).toHaveLength(2);

      const ok = deleteConversation(db, id);
      expect(ok).toBe(true);
      expect(getConversationMessages(db, id)).toHaveLength(0);
      expect(getRecentConversations(db, 10).find((c) => c.id === id)).toBeUndefined();
    });

    it("returns false when id doesn't exist", () => {
      expect(deleteConversation(db, 99999)).toBe(false);
    });

    it("does not affect other conversations", () => {
      const keep = createConversation(db, "all");
      saveMessage(db, keep, "user", "keep me", null);
      const drop = createConversation(db, "all");
      saveMessage(db, drop, "user", "drop me", null);

      deleteConversation(db, drop);

      expect(getConversationMessages(db, keep)).toHaveLength(1);
      expect(getConversationMessages(db, drop)).toHaveLength(0);
    });
  });
});
