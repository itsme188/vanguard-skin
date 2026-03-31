/**
 * Electron IPC handlers — bridge between renderer and main process.
 */

import { app, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import { getSettings, saveSettings, getSanitizedSettings } from "./settings-store";

export function setupIpcHandlers(): void {
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
