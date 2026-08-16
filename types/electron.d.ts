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

  // Change password (#35 task 15). Passwords are sent to main once and never
  // returned or persisted (only the scrypt hash is stored). Resolves to
  // { success, error? }.
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<{ success: boolean; error?: string }>;

  // Rotate the Electron-main service credential (#35 task 17). No payload —
  // the new credential never crosses the IPC boundary. Resolves to
  // { success, error? }.
  rotateServiceCredential: () => Promise<{ success: boolean; error?: string }>;

  // App lifecycle
  restartApp: () => Promise<void>;

  // First-run onboarding
  isFirstRun: () => Promise<boolean>;
  completeFirstRun: () => Promise<{ success: boolean }>;

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
