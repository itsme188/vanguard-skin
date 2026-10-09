/**
 * Join two parts of one status line: "<what happened> <what that means>".
 *
 * The first part is often text the server wrote, which does not always end in
 * a full stop ("...already exists for this security on 2026-07-01"). Printed
 * straight before the next sentence it runs into it. This adds a full stop
 * only when the first part does not already end a sentence: a ".", "!" or "?"
 * counts, with or without a closing bracket or quote after it.
 *
 * Pure. An empty part is left out, and the other is returned as it is.
 */
const CLOSERS = /[)\]"'”’]+$/;

export function joinSentences(first: string, next: string): string {
  const head = first.trim();
  const tail = next.trim();
  if (head === "") return tail;
  if (tail === "") return head;
  const ended = /[.!?…]$/.test(head.replace(CLOSERS, ""));
  return `${head}${ended ? "" : "."} ${tail}`;
}
