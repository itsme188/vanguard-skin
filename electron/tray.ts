/**
 * System tray for macOS — shows app icon with portfolio summary.
 * Periodically fetches portfolio value from the local API and updates
 * the tooltip and context menu.
 */

import { Tray, Menu, nativeImage, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";

let tray: Tray | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;

const PORT = 3099;
const UPDATE_INTERVAL_MS = 5 * 60_000; // 5 minutes

interface PortfolioSummary {
  totalValue: number | null;
  pricesAsOf: string | null;
  twsState: string;
}

function formatCurrency(value: number): string {
  return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatShortDate(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

async function fetchSummary(): Promise<PortfolioSummary | null> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/summary`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function buildContextMenu(
  mainWindow: BrowserWindow | null,
  summary: PortfolioSummary | null,
): Electron.Menu {
  const items: Electron.MenuItemConstructorOptions[] = [];

  // Portfolio value at top (non-clickable)
  if (summary?.totalValue != null) {
    items.push({
      label: `Portfolio: ${formatCurrency(summary.totalValue)}`,
      enabled: false,
    });
  }
  if (summary?.pricesAsOf) {
    items.push({
      label: `Prices: ${formatShortDate(summary.pricesAsOf)}`,
      enabled: false,
    });
  }
  if (items.length > 0) {
    items.push({ type: "separator" });
  }

  items.push({
    label: "Show Dashboard",
    click: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    },
  });
  items.push({
    label: "Check for Updates...",
    click: () => {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.log("[tray] Update check failed:", err.message);
      });
    },
  });
  items.push({ type: "separator" });
  items.push({
    label: "Quit",
    click: () => {
      const { app } = require("electron");
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}

async function updateTray(mainWindow: BrowserWindow | null): Promise<void> {
  if (!tray) return;

  const summary = await fetchSummary();

  // Update tooltip
  let tooltip = "Vanguard Dashboard";
  if (summary?.totalValue != null) {
    tooltip += `\n${formatCurrency(summary.totalValue)}`;
  }
  if (summary?.pricesAsOf) {
    tooltip += `\nPrices: ${formatShortDate(summary.pricesAsOf)}`;
  }
  tray.setToolTip(tooltip);

  // Rebuild context menu with current data
  tray.setContextMenu(buildContextMenu(mainWindow, summary));
}

export function createTray(mainWindow: BrowserWindow | null): void {
  // Use template images for macOS menu bar — Electron auto-detects the
  // "Template" suffix and adapts the icon for light/dark mode.
  // Expects tray-iconTemplate.png (18px) and tray-iconTemplate@2x.png (36px).
  const iconPath = path.join(__dirname, "..", "public", "tray-iconTemplate.png");

  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("Empty icon");
    icon.setTemplateImage(true);
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Vanguard Dashboard");

  // Set initial context menu (before first summary fetch)
  tray.setContextMenu(buildContextMenu(mainWindow, null));

  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // First summary update after a short delay (server needs to be ready)
  setTimeout(() => updateTray(mainWindow), 5_000);

  // Periodic updates
  updateInterval = setInterval(() => updateTray(mainWindow), UPDATE_INTERVAL_MS);
}

export function destroyTray(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
