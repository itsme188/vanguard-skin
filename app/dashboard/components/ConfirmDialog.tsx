"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional extra body content rendered between the message and the
   *  button row — e.g. a required date input for "mark reversed" (Task 13
   *  follow-up). Existing callers that omit it are unaffected. */
  children?: ReactNode;
  /** Disables the confirm button (e.g. an empty/invalid required field in
   *  `children`) without changing its label. Defaults to false so existing
   *  callers behave identically. */
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  variant = "default",
  onConfirm,
  onCancel,
  children,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      confirmRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleCancel = (e: Event) => {
      e.preventDefault();
      onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      // m-auto restores the UA stylesheet's dialog centering (margin: auto),
      // which Tailwind v4's universal preflight margin reset zeroes — without
      // it the top-layer dialog pins to the viewport's top-left corner
      // (deep-QA finding, recurrence — prior closure was non-repro only).
      className="m-auto rounded-xl border border-edge bg-panel p-0 text-ink backdrop:bg-canvas/70 backdrop:backdrop-blur-sm max-w-sm w-full"
    >
      <div className="p-6">
        <h3 className="text-base font-medium mb-2">{title}</h3>
        <p className="text-sm text-ink-dim">{message}</p>
        {children}
      </div>
      <div className="flex justify-end gap-3 px-6 pb-6">
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg border border-edge text-sm text-ink-dim hover:text-ink hover:bg-raised transition-colors focus-ring"
        >
          Cancel
        </button>
        <button
          ref={confirmRef}
          onClick={onConfirm}
          disabled={confirmDisabled}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-[filter,background-color,scale] active:scale-[0.96] focus-ring disabled:opacity-50 disabled:cursor-not-allowed ${
            variant === "danger"
              ? "bg-down/90 text-white hover:bg-down"
              : "bg-gold text-canvas hover:brightness-110"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
