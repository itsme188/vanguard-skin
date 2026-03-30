/**
 * Electron IPC handlers — bridge between renderer and main process.
 */

import { app, ipcMain, shell } from "electron";
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
}
