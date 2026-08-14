/**
 * Electron IPC handlers — bridge between renderer and main process.
 */

import { app, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import { getSettings, saveSettings, getSanitizedSettings } from "./settings-store";
import type { PasswordChangeResult } from "./password-change";
import type { RotateCredentialResult } from "./credential-rotation";

/**
 * Dependencies injected by main.ts — the change-password + credential-rotation
 * transactions live there (they need serverProcess/mainWindow/service-credential
 * state), but the IPC surface is registered here (#35 tasks 15 + 17).
 */
export interface IpcHandlerDeps {
  changePassword: (currentPassword: string, newPassword: string) => Promise<PasswordChangeResult>;
  rotateServiceCredential: () => Promise<RotateCredentialResult>;
}

export function setupIpcHandlers(deps: IpcHandlerDeps): void {
  ipcMain.handle("get-app-version", () => app.getVersion());

  ipcMain.handle("get-data-path", () => {
    if (!app.isPackaged) {
      return path.join(__dirname, "..", "data");
    }
    return path.join(app.getPath("userData"), "data");
  });

  ipcMain.handle("open-data-dir", async () => {
    const dataPath = app.isPackaged
      ? path.join(app.getPath("userData"), "data")
      : path.join(__dirname, "..", "data");
    await shell.openPath(dataPath);
  });

  ipcMain.handle("open-external", async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle("get-settings", () => {
    return getSanitizedSettings();
  });

  ipcMain.handle("save-settings", (_event, settings: Record<string, unknown>) => {
    saveSettings(settings);
    return { success: true };
  });

  ipcMain.handle("restart-app", () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle("is-first-run", () => {
    const settings = getSettings();
    return !settings.firstRunComplete;
  });

  ipcMain.handle("complete-first-run", () => {
    saveSettings({ firstRunComplete: true });
    return { success: true };
  });

  // #35 task 15 — Settings "change password" action. The plaintext passwords
  // cross the IPC boundary ONCE, from the Settings form to main, and are never
  // persisted (only the scrypt hash is). The secret hash is NOT exposed on any
  // get-settings surface. Returns a domain result so the renderer can show the
  // outcome (wrong current password, restart failure, or success).
  ipcMain.handle(
    "change-password",
    async (
      _event,
      payload: { currentPassword?: string; newPassword?: string },
    ): Promise<PasswordChangeResult> => {
      const current = payload?.currentPassword ?? "";
      const next = payload?.newPassword ?? "";
      return deps.changePassword(current, next);
    },
  );

  // #35 task 17 — Settings "rotate service credential" action. Re-mints
  // ELECTRON_SERVICE_CRED, restarts the child server so it picks up the new
  // value from env, and re-bootstraps the desktop session. Takes no payload
  // (there is nothing for the renderer to supply — the new credential is
  // generated in main and never returned to the renderer). Returns a domain
  // result so the renderer can show the outcome.
  ipcMain.handle(
    "rotate-service-credential",
    async (): Promise<RotateCredentialResult> => {
      return deps.rotateServiceCredential();
    },
  );

  // Auto-update
  ipcMain.handle("check-for-updates", async () => {
    if (!app.isPackaged) return { available: false, reason: "dev-mode" };
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        available: !!result?.updateInfo,
        version: result?.updateInfo?.version,
      };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("install-update", () => {
    autoUpdater.quitAndInstall();
  });
}
