import type Database from "better-sqlite3";
import type { Note, NoteType, NoteSentiment } from "@/lib/types";

export interface CreateNoteParams {
  note_type: NoteType;
  content: string;
  security_id?: number | null;
  transaction_id?: number | null;
  event_date: string;
  tags?: string[] | null;
  sentiment?: NoteSentiment | null;
}

export interface UpdateNoteParams {
  content?: string;
  event_date?: string;
  tags?: string[] | null;
  sentiment?: NoteSentiment | null;
}

export function createNote(
  db: Database.Database,
  params: CreateNoteParams
): Note {
  const tagsJson = params.tags ? JSON.stringify(params.tags) : null;

  const result = db
    .prepare(
      `INSERT INTO notes (note_type, content, security_id, transaction_id, event_date, tags, sentiment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.note_type,
      params.content,
      params.security_id ?? null,
      params.transaction_id ?? null,
      params.event_date,
      tagsJson,
      params.sentiment ?? null
    );

  return db
    .prepare("SELECT * FROM notes WHERE id = ?")
    .get(result.lastInsertRowid) as Note;
}

export function updateNote(
  db: Database.Database,
  id: number,
  params: UpdateNoteParams
): Note | null {
  const sets: string[] = [];
  const values: (string | null)[] = [];

  if (params.content !== undefined) {
    sets.push("content = ?");
    values.push(params.content);
  }
  if (params.event_date !== undefined) {
    sets.push("event_date = ?");
    values.push(params.event_date);
  }
  if (params.tags !== undefined) {
    sets.push("tags = ?");
    values.push(params.tags ? JSON.stringify(params.tags) : null);
  }
  if (params.sentiment !== undefined) {
    sets.push("sentiment = ?");
    values.push(params.sentiment);
  }

  if (sets.length === 0) return getNoteRaw(db, id);

  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
    id
  );

  return getNoteRaw(db, id);
}

export function deleteNote(
  db: Database.Database,
  id: number
): { deleted: boolean } {
  const result = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return { deleted: result.changes > 0 };
}

function getNoteRaw(db: Database.Database, id: number): Note | null {
  return (db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note) ?? null;
}
