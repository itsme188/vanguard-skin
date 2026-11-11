/**
 * B20: the conversation routes answer in the project envelope
 * (`{ success: true, data }` / `{ success: false, error }`), and POST refuses
 * a scope outside VALID_SCOPES (a stored bad scope made every later send in
 * that conversation answer 400 "Invalid scope").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
}));

import { GET as listGET, POST as createPOST } from "@/app/api/chat/conversations/route";
import { DELETE as convDELETE } from "@/app/api/chat/conversations/[id]/route";
import { GET as messagesGET } from "@/app/api/chat/conversations/[id]/messages/route";
import { createConversation, saveMessage } from "@/lib/mutations/chat";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function post(body: unknown) {
  return new Request("http://localhost/api/chat/conversations", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  h.db = db;
});

describe("conversation routes envelope (B20)", () => {
  it("GET list answers { success: true, data: { conversations } }", async () => {
    createConversation(h.db, "all");
    const res = await listGET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.conversations)).toBe(true);
    expect(body.data.conversations).toHaveLength(1);
  });

  it("POST with a valid scope creates and answers the id in data", async () => {
    const res = await createPOST(post({ scope: "ibkr" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.data.id).toBe("number");
    const row = h.db.prepare("SELECT scope FROM chat_conversations WHERE id = ?").get(body.data.id) as {
      scope: string;
    };
    expect(row.scope).toBe("ibkr");
  });

  it("POST with no scope defaults to all", async () => {
    const res = await createPOST(post({}));
    const body = await res.json();
    expect(body.success).toBe(true);
    const row = h.db.prepare("SELECT scope FROM chat_conversations WHERE id = ?").get(body.data.id) as {
      scope: string;
    };
    expect(row.scope).toBe("all");
  });

  it("POST with a scope outside VALID_SCOPES answers 400 and saves nothing", async () => {
    const res = await createPOST(post({ scope: "everything" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    const n = h.db.prepare("SELECT COUNT(*) AS n FROM chat_conversations").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("POST with a body that is not JSON answers 400", async () => {
    const res = await createPOST(post("not json"));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("DELETE answers success, then 404 in the envelope for a missing id", async () => {
    const id = createConversation(h.db, "all");
    const ok = await convDELETE(new Request("http://localhost"), params(String(id)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true, data: { deleted: true } });

    const gone = await convDELETE(new Request("http://localhost"), params(String(id)));
    expect(gone.status).toBe(404);
    const body = await gone.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("DELETE with a bad id answers 400 in the envelope", async () => {
    const res = await convDELETE(new Request("http://localhost"), params("abc"));
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
  });

  it("GET messages answers { success: true, data: { messages } }", async () => {
    const id = createConversation(h.db, "all");
    saveMessage(h.db, id, "user", "Synthetic question", null);
    const res = await messagesGET(new Request("http://localhost"), params(String(id)));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.messages).toHaveLength(1);
  });

  it("GET messages with a bad id answers 400 in the envelope", async () => {
    const res = await messagesGET(new Request("http://localhost"), params("0"));
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
  });
});
