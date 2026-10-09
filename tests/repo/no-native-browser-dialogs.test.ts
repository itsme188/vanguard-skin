/**
 * No native browser dialog under app/ (owner ruling 2026-10-08).
 *
 * `window.confirm` / `window.alert` are drawn by the browser, not the app:
 * they ignore the theme, block the page, and in the packaged desktop shell
 * carry the shell's own title. A yes/no question goes through
 * `useConfirmPrompt` (app/dashboard/components/useConfirmPrompt.tsx); a
 * failure is said on the page.
 *
 * A file that declares its OWN `confirm` / `alert` function (for example the
 * earnings date chip's `async function confirm(date, time)`) is calling that,
 * not the browser, so a bare call there is allowed; a `window.`-qualified call
 * never is.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function nativeDialogCalls(src: string): string[] {
  const hits: string[] = [];
  for (const name of ["confirm", "alert"]) {
    const declaresOwn = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\(|function))`).test(src);
    const qualified = new RegExp(`window\\.${name}\\s*\\(`);
    const bare = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
    src.split("\n").forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (new RegExp(`function\\s+${name}\\s*\\(`).test(line)) return;
      if (qualified.test(line) || (!declaresOwn && bare.test(line))) {
        hits.push(`${i + 1}: ${line.trim()}`);
      }
    });
  }
  return hits;
}

describe("the scanner itself", () => {
  it("flags a bare and a window-qualified call", () => {
    expect(nativeDialogCalls('if (!confirm("x")) return;')).toHaveLength(1);
    expect(nativeDialogCalls('if (!window.confirm("x")) return;')).toHaveLength(1);
    expect(nativeDialogCalls("alert(`Error`);")).toHaveLength(1);
  });

  it("ignores a locally declared function, a method and a comment", () => {
    expect(
      nativeDialogCalls("async function confirm(date: string) {}\nonClick={() => confirm(eventDate)}"),
    ).toEqual([]);
    expect(nativeDialogCalls("prompt.confirm(1); setConfirm(2);")).toEqual([]);
    expect(nativeDialogCalls("// was: confirm(message)")).toEqual([]);
  });

  it("a window-qualified call is flagged even beside a local of the same name", () => {
    expect(
      nativeDialogCalls("function confirm() {}\nwindow.confirm('x');"),
    ).toHaveLength(1);
  });
});

describe("app/ asks and reports in the app's own UI", () => {
  it("no file calls the browser's confirm() or alert()", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("app")) {
      for (const hit of nativeDialogCalls(readFileSync(file, "utf8"))) {
        offenders.push(`${file}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
