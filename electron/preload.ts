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

  // Change password (Settings action) — #35 task 15. Passwords are sent to
  // main once and never returned or persisted (only the scrypt hash is stored,
  // encrypted, in secrets.json). Resolves to { success, error? }.
  changePassword: (currentPassword: string, newPassword: string) =>
    ipcRenderer.invoke("change-password", { currentPassword, newPassword }),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateDownloading: (callback: () => void) =>
    ipcRenderer.on("update-downloading", callback),

  // Platform detection
  isElectron: true,
  platform: process.platform,
});
