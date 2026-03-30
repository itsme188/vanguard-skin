/**
 * System tray for macOS — shows app icon with menu.
 */

import { Tray, Menu, nativeImage, type BrowserWindow } from "electron";
import path from "node:path";

let tray: Tray | null = null;

export function createTray(mainWindow: BrowserWindow | null): void {
  // Use a template image for macOS menu bar (16x16, @2x supported)
  const iconPath = path.join(__dirname, "..", "public", "tray-icon.png");

  // Create a simple tray icon — if icon file doesn't exist, create a basic one
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("Empty icon");
    // Resize for menu bar
    icon = icon.resize({ width: 18, height: 18 });
  } catch {
    // Fallback: create a simple colored square
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Vanguard Dashboard");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Dashboard",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        // Import app inline to avoid circular dependency
        const { app } = require("electron");
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
