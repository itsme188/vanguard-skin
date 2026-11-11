import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getRecentConversations,
  getConversationMessages,
  getConversationById,
  getLastConversationMessage,
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

  describe("getConversationById", () => {
    it("returns the stored row with its scope", () => {
      const id = createConversation(db, "ibkr");
      const row = getConversationById(db, id);
      expect(row?.id).toBe(id);
      expect(row?.scope).toBe("ibkr");
    });

    it("returns null for an unknown or deleted id", () => {
      expect(getConversationById(db, 999)).toBeNull();
      const id = createConversation(db, "all");
      deleteConversation(db, id);
      expect(getConversationById(db, id)).toBeNull();
    });
  });

  describe("getLastConversationMessage", () => {
    it("returns the newest row by insertion order, or null", () => {
      const id = createConversation(db, "all");
      expect(getLastConversationMessage(db, id)).toBeNull();
      saveMessage(db, id, "user", "first", null);
      saveMessage(db, id, "assistant", "second", null);
      saveMessage(db, id, "user", "third", null);
      const last = getLastConversationMessage(db, id);
      expect(last?.role).toBe("user");
      expect(last?.content).toBe("third");
    });
  });

  describe("getConversationMessages ordering (R3-8)", () => {
    it("rows saved in the same second come back in insertion order", () => {
      const id = createConversation(db, "all");
      const insert = db.prepare(
        "INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, '2026-11-11 10:00:00')",
      );
      insert.run(id, "user", "first");
      insert.run(id, "assistant", "second");
      insert.run(id, "user", "third");
      // A later row with an EARLIER timestamp still sorts by time first.
      db.prepare(
        "INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', 'zeroth', '2026-11-11 09:59:59')",
      ).run(id);
      expect(getConversationMessages(db, id).map((m) => m.content)).toEqual(["zeroth", "first", "second", "third"]);
      const sql = getConversationMessages.toString();
      expect(sql).toMatch(/ORDER BY created_at ASC, id ASC/);
    });
  });
});
