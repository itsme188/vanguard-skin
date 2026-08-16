"use client";

/**
 * Security settings (#35, tasks 15 + 16 + 17):
 *   - Change password  -> window.electronAPI.changePassword (IPC wired in
 *     task 15; this closes the "no user-reachable trigger" gap). Electron-only
 *     — the transaction rehashes, logs out everywhere, restarts + rebootstraps.
 *   - Rotate service credential -> window.electronAPI.rotateServiceCredential
 *     (IPC wired in task 17). Electron-only — re-mints ELECTRON_SERVICE_CRED,
 *     restarts the child server (a running process can't hot-swap its own
 *     env), and re-bootstraps the desktop session. Does not touch the app
 *     password or human sessions — it only affects Electron main's own
 *     service-to-service credential (bootstrap + tws/* calls).
 *   - Set a convenience PIN -> POST /api/auth/pin (requires the live session
 *     cookie; the PIN re-unlocks THIS device only, spec §B2).
 *   - Lock now -> dispatches the `lock-app` event the PinUnlock overlay listens
 *     for, so the PIN flow is demonstrable without waiting for an idle timeout.
 */

import { useState } from "react";
import { useElectron } from "@/lib/hooks/useElectron";
import apiFetch from "@/lib/http/apiFetch";

type Status = "idle" | "pending" | "ok" | "error";

export function SecuritySection() {
  const { api } = useElectron();

  // --- Change password ---
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwStatus, setPwStatus] = useState<Status>("idle");
  const [pwError, setPwError] = useState<string | null>(null);

  async function handleChangePassword() {
    if (!api?.changePassword) return;
    if (next.length < 8) {
      setPwStatus("error");
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setPwStatus("error");
      setPwError("New password and confirmation do not match.");
      return;
    }
    setPwStatus("pending");
    setPwError(null);
    try {
      const result = await api.changePassword(current, next);
      if (result.success) {
        setPwStatus("ok");
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        setPwStatus("error");
        setPwError(result.error ?? "Password change failed.");
      }
    } catch {
      setPwStatus("error");
      setPwError("Password change failed.");
    }
  }

  // --- Rotate service credential ---
  const [rotateStatus, setRotateStatus] = useState<Status>("idle");
  const [rotateError, setRotateError] = useState<string | null>(null);

  async function handleRotateCredential() {
    if (!api?.rotateServiceCredential) return;
    if (
      !window.confirm(
        "Rotate the service credential? The app will briefly restart its server and reload.",
      )
    ) {
      return;
    }
    setRotateStatus("pending");
    setRotateError(null);
    try {
      const result = await api.rotateServiceCredential();
      if (result.success) {
        setRotateStatus("ok");
      } else {
        setRotateStatus("error");
        setRotateError(result.error ?? "Credential rotation failed.");
      }
    } catch {
      setRotateStatus("error");
      setRotateError("Credential rotation failed.");
    }
  }

  // --- Convenience PIN ---
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinStatus, setPinStatus] = useState<Status>("idle");
  const [pinError, setPinError] = useState<string | null>(null);

  async function handleSetPin() {
    if (!/^\d{4,8}$/.test(pin)) {
      setPinStatus("error");
      setPinError("PIN must be 4–8 digits.");
      return;
    }
    if (pin !== pinConfirm) {
      setPinStatus("error");
      setPinError("PIN and confirmation do not match.");
      return;
    }
    setPinStatus("pending");
    setPinError(null);
    try {
      const res = await apiFetch("/api/auth/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (res.ok && body?.success) {
        setPinStatus("ok");
        setPin("");
        setPinConfirm("");
      } else {
        setPinStatus("error");
        setPinError(body?.error ?? (res.status === 401 ? "Sign in with your password first." : "Could not set PIN."));
      }
    } catch {
      setPinStatus("error");
      setPinError("Could not set PIN.");
    }
  }

  const inputCls =
    "w-full px-2 py-1 text-xs font-mono bg-raised border border-edge rounded text-ink";

  return (
    <div className="space-y-4">
      <p className="text-[10px] text-ink-faint uppercase tracking-wider">Security</p>

      {/* Change password — Electron-only */}
      {api?.changePassword && (
        <div className="space-y-2">
          <p className="text-[11px] text-ink-dim font-medium">Change password</p>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={current}
            onChange={(e) => { setCurrent(e.target.value); setPwStatus("idle"); }}
            className={inputCls}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="New password (min 8 chars)"
            value={next}
            onChange={(e) => { setNext(e.target.value); setPwStatus("idle"); }}
            className={inputCls}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => { setConfirm(e.target.value); setPwStatus("idle"); }}
            className={inputCls}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleChangePassword}
              disabled={pwStatus === "pending" || !current || !next || !confirm}
              className="px-4 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold-ink hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {pwStatus === "pending" ? "Changing…" : "Change password"}
            </button>
            {pwStatus === "ok" && <span className="text-[11px] text-up">Password changed</span>}
            {pwStatus === "error" && <span className="text-[11px] text-down">{pwError}</span>}
          </div>
          <p className="text-[10px] text-ink-faint">
            Changing your password signs out every device (including a lost phone).
          </p>
        </div>
      )}

      {/* Rotate service credential — Electron-only */}
      {api?.rotateServiceCredential && (
        <div className="space-y-2 pt-2 border-t border-edge">
          <p className="text-[11px] text-ink-dim font-medium">Service credential</p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRotateCredential}
              disabled={rotateStatus === "pending"}
              className="px-4 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {rotateStatus === "pending" ? "Rotating…" : "Rotate service credential"}
            </button>
            {rotateStatus === "ok" && <span className="text-[11px] text-up">Rotated</span>}
            {rotateStatus === "error" && <span className="text-[11px] text-down">{rotateError}</span>}
          </div>
          <p className="text-[10px] text-ink-faint">
            Re-mints the app&apos;s internal service credential and restarts its server.
            Does not change your password or sign out other devices.
          </p>
        </div>
      )}

      {/* Convenience PIN */}
      <div className="space-y-2 pt-2 border-t border-edge">
        <p className="text-[11px] text-ink-dim font-medium">Convenience PIN</p>
        <input
          type="password"
          inputMode="numeric"
          placeholder="New PIN (4–8 digits)"
          value={pin}
          onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setPinStatus("idle"); }}
          maxLength={8}
          className={inputCls}
        />
        <input
          type="password"
          inputMode="numeric"
          placeholder="Confirm PIN"
          value={pinConfirm}
          onChange={(e) => { setPinConfirm(e.target.value.replace(/\D/g, "")); setPinStatus("idle"); }}
          maxLength={8}
          className={inputCls}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleSetPin}
            disabled={pinStatus === "pending" || !pin || !pinConfirm}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold-ink hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {pinStatus === "pending" ? "Saving…" : "Set PIN"}
          </button>
          <button
            onClick={() => window.dispatchEvent(new Event("lock-app"))}
            className="px-4 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:bg-raised transition-colors"
          >
            Lock now
          </button>
          {pinStatus === "ok" && <span className="text-[11px] text-up">PIN set</span>}
          {pinStatus === "error" && <span className="text-[11px] text-down">{pinError}</span>}
        </div>
        <p className="text-[10px] text-ink-faint">
          The PIN re-unlocks this device only. It stops working when this device is
          signed out, and after too many wrong tries you&apos;ll need your password.
        </p>
      </div>
    </div>
  );
}
