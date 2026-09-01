/**
 * Escape a user-typed search term for use inside a SQLite LIKE pattern.
 *
 * `_` and `%` are LIKE wildcards; unescaped they make searches return rows
 * that don't contain the term ("guidance_raise" matching "guidance raise",
 * "20%" matching anything with "20"). Callers must pair the escaped term
 * with `ESCAPE '\'` on the LIKE itself.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}
