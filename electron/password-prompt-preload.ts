/**
 * Preload for the first-run password-prompt window (#35, task 15). Exposes a
 * tiny, single-purpose bridge — no `nodeIntegration` in the prompt window, so
 * the inline form talks to main only through these two channels.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("promptAPI", {
  /** Resolve the main-process promise with the chosen password. */
  submit: (password: string): Promise<boolean> =>
    ipcRenderer.invoke("password-prompt:submit", password),
  /** Reject the main-process promise (user cancelled). */
  cancel: (): void => ipcRenderer.send("password-prompt:cancel"),
});
