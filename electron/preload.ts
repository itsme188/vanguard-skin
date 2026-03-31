/**
 * Electron preload script — exposes safe APIs to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getDataPath: () => ipcRenderer.invoke("get-data-path"),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke("save-settings", settings),

  // App lifecycle
  restartApp: () => ipcRenderer.invoke("restart-app"),

  // First-run onboarding
  isFirstRun: () => ipcRenderer.invoke("is-first-run"),
  completeFirstRun: () => ipcRenderer.invoke("complete-first-run"),

  // Platform detection
  isElectron: true,
  platform: process.platform,
});
