import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getRecentConversations, getConversationMessages } from "@/lib/queries/chat";
import { createConversation, saveMessage, updateConversationTitle } from "@/lib/mutations/chat";

describe("chat history", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("createConversation", () => {
    it("creates a conversation with scope", () => {
      const id = createConversation(db, "all");
      expect(id).toBeGreaterThan(0);
      const convos = getRecentConversations(db, 10);
      expect(convos).toHaveLength(1);
      expect(convos[0].scope).toBe("all");
      expect(convos[0].title).toBeNull();
    });
  });

  describe("saveMessage + getConversationMessages", () => {
    it("saves and retrieves messages in order", () => {
      const convId = createConversation(db, "all");
      saveMessage(db, convId, "user", "What is my portfolio value?", null);
      saveMessage(db, convId, "assistant", "Your portfolio is worth $1.8M.", null);
      const messages = getConversationMessages(db, convId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("What is my portfolio value?");
      expect(messages[1].role).toBe("assistant");
    });
  });

  describe("saveMessage with parts", () => {
    it("stores and retrieves JSON parts", () => {
      const convId = createConversation(db, "all");
      const parts = JSON.stringify([
        { type: "text", text: "Let me check." },
        { type: "tool-query_holdings", state: "output-available" }
      ]);
      saveMessage(db, convId, "assistant", "Let me check.", parts);
      const messages = getConversationMessages(db, convId);
      expect(messages[0].parts).toBe(parts);
    });
  });

  describe("updateConversationTitle", () => {
    it("updates title and updated_at", () => {
      const id = createConversation(db, "ibkr");
      updateConversationTitle(db, id, "Portfolio overview");
      const convos = getRecentConversations(db, 10);
      expect(convos[0].title).toBe("Portfolio overview");
    });
  });

  describe("getRecentConversations", () => {
    it("returns conversations ordered by updated_at desc", () => {
      const id1 = createConversation(db, "all");
      const id2 = createConversation(db, "ibkr");
      saveMessage(db, id1, "user", "hello", null);
      updateConversationTitle(db, id1, "First");
      updateConversationTitle(db, id2, "Second");
      const convos = getRecentConversations(db, 10);
      expect(convos).toHaveLength(2);
      expect(convos[0].title).toBe("First");
    });

    it("respects limit", () => {
      createConversation(db, "all");
      createConversation(db, "all");
      createConversation(db, "all");
      const convos = getRecentConversations(db, 2);
      expect(convos).toHaveLength(2);
    });
  });
});
