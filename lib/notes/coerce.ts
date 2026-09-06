import { NOTE_SENTIMENTS, NOTE_TYPES, type NoteSentiment, type NoteType } from "@/lib/types";

/**
 * Coerce a raw, user-editable query-param string to a NoteType — exact
 * match against NOTE_TYPES only. Anything else (an unknown value, notably
 * the guessable "all", empty string, null, or undefined) returns
 * `undefined` ("no filter") rather than being cast straight through, which
 * would otherwise match zero rows and render an empty-notebook state over a
 * full one.
 */
export function coerceNoteType(raw: string | null | undefined): NoteType | undefined {
  return (NOTE_TYPES as readonly string[]).includes(raw ?? "")
    ? (raw as NoteType)
    : undefined;
}

/**
 * Same contract as coerceNoteType, for the sentiment filter.
 */
export function coerceNoteSentiment(raw: string | null | undefined): NoteSentiment | undefined {
  return (NOTE_SENTIMENTS as readonly string[]).includes(raw ?? "")
    ? (raw as NoteSentiment)
    : undefined;
}
