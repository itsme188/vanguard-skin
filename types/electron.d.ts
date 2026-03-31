/**
 * Global type declarations for Electron's preload API.
 * Only available when the app runs inside Electron (window.electronAPI is undefined in browser).
 * Must stay in sync with electron/preload.ts.
 */

interface ElectronAPI {
  // App info
  getAppVersion: () => Promise<string>;
  getDataPath: () => Promise<string>;

  // Shell actions
  openDataDir: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;

  // Settings
  getSettings: () => Promise<Record<string, string | number | boolean>>;
  saveSettings: (settings: Record<string, unknown>) => Promise<{ success: boolean }>;

  // App lifecycle
  restartApp: () => Promise<void>;

  // Platform detection
  isElectron: true;
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
