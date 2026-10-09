"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "./ConfirmDialog";
import { splitPromptParagraphs } from "./confirm-prompt-text";

export interface ConfirmPromptRequest {
  title: string;
  /** Blank lines separate paragraphs. */
  message: string;
  confirmLabel?: string;
  variant?: "danger" | "default";
}

export interface ConfirmPrompt {
  /**
   * Ask a yes/no question in the app's ConfirmDialog. Resolves true on the
   * confirm button, false on Cancel or Escape, and false if the asking
   * component goes away first, so a handler that awaits it never acts on a
   * question nobody answered.
   */
  ask: (request: ConfirmPromptRequest) => Promise<boolean>;
  /** Render this once, anywhere in the component's output. */
  dialog: ReactNode;
  /** True while a question is on screen. */
  isOpen: boolean;
}

function stopHere(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * The in-app replacement for `window.confirm` in an async handler:
 * `if (!(await prompt.ask({...}))) return;`.
 *
 * The dialog is portalled to the document body and only exists after the first
 * question. That keeps it out of the server render, out of any `<form>` it
 * would otherwise sit in (its buttons would submit the form), and out of a
 * link or a narrow inline parent. React still bubbles portal events to the
 * asking component's ancestors, so clicks and key presses stop at the wrapper:
 * answering a question must not also trigger a row or a backdrop behind it.
 */
export function useConfirmPrompt(): ConfirmPrompt {
  const [request, setRequest] = useState<ConfirmPromptRequest | null>(null);
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    resolve?.(ok);
  }, []);
  const confirm = useCallback(() => settle(true), [settle]);
  const cancel = useCallback(() => settle(false), [settle]);

  const ask = useCallback((next: ConfirmPromptRequest) => {
    return new Promise<boolean>((resolve) => {
      // A second question replaces the first, which counts as declined.
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setRequest(next);
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    return () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    };
  }, []);

  let dialog: ReactNode = null;
  if (request && typeof document !== "undefined") {
    const [first, ...rest] = splitPromptParagraphs(request.message);
    dialog = createPortal(
      <div onClick={stopHere} onKeyDown={stopHere} onKeyUp={stopHere}>
        <ConfirmDialog
          open={open}
          title={request.title}
          message={first}
          confirmLabel={request.confirmLabel}
          variant={request.variant}
          onConfirm={confirm}
          onCancel={cancel}
        >
          {rest.map((paragraph, index) => (
            <p key={index} className="mt-2 text-sm text-ink-dim">
              {paragraph}
            </p>
          ))}
        </ConfirmDialog>
      </div>,
      document.body,
    );
  }

  return { ask, dialog, isOpen: open };
}
