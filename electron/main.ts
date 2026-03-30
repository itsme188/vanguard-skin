/**
 * Electron main process — launches a production Next.js server as a child
 * process and opens a BrowserWindow pointed at it.
 *
 * Data directory: ~/Library/Application Support/vanguard-skin/ (macOS)
 * Settings: stored via electron-store (encrypted API keys)
 */

import { app, BrowserWindow, shell, ipcMain, dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { setupIpcHandlers } from "./ipc-handlers";
import { createTray } from "./tray";
import { getSettings } from "./settings-store";

// ─── Find System Node.js ────────────────────────────────────────

/**
 * Find the system Node.js binary. Electron embeds its own Node.js with a
 * different ABI version, so native modules (better-sqlite3) won't load.
 * The Next.js server must run under system Node.js.
 */
function findSystemNode(): string {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");

  // Try common locations
  const candidates = [
    "/opt/homebrew/bin/node",  // macOS Apple Silicon (Homebrew)
    "/usr/local/bin/node",     // macOS Intel (Homebrew)
    "/usr/bin/node",           // Linux system
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Fallback: ask the shell
  try {
    const result = execSync("which node", { encoding: "utf-8" }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // Fall through
  }

  throw new Error("Could not find system Node.js. Install Node.js via Homebrew or nvm.");
}

// ─── Constants ──────────────────────────────────────────────────

const APP_NAME = "Vanguard Dashboard";
const IS_DEV = !app.isPackaged;
const PORT = 3099;

/** Where the Next.js standalone server lives after packaging. */
function getServerDir(): string {
  if (IS_DEV) {
    return path.join(__dirname, "..");
  }
  // In packaged app: resources/app/.next/standalone
  return path.join(process.resourcesPath, "standalone");
}

/** User data directory for SQLite DB and settings. */
function getDataDir(): string {
  if (IS_DEV) {
    return path.join(__dirname, "..", "data");
  }
  return path.join(app.getPath("userData"), "data");
}

// ─── State ──────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

// ─── Server Lifecycle ───────────────────────────────────────────

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverDir = getServerDir();
    const dataDir = getDataDir();

    // Ensure data directory exists
    fs.mkdirSync(dataDir, { recursive: true });

    // Build environment for the Next.js server
    const settings = getSettings();
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(PORT),
      HOSTNAME: "localhost",
      NODE_ENV: "production",
      VANGUARD_DB_DIR: dataDir,
      ELECTRON: "true",
    };

    // Inject settings as env vars
    if (settings.anthropicApiKey) env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
    if (settings.ibkrAccountCode) env.IBKR_ACCOUNT_CODE = settings.ibkrAccountCode;
    if (settings.twsHost) env.TWS_HOST = settings.twsHost;
    if (settings.twsPort) env.TWS_PORT = String(settings.twsPort);
    if (settings.gmailAddress) env.GMAIL_ADDRESS = settings.gmailAddress;
    if (settings.gmailAppPassword) env.GMAIL_APP_PASSWORD = settings.gmailAppPassword;
    if (settings.briefingEmailTo) env.BRIEFING_EMAIL_TO = settings.briefingEmailTo;
    if (settings.fredApiKey) env.FRED_API_KEY = settings.fredApiKey;
    if (settings.edgarContactEmail) env.EDGAR_CONTACT_EMAIL = settings.edgarContactEmail;
    if (settings.apiNinjasKey) env.API_NINJAS_API_KEY = settings.apiNinjasKey;

    // Use the standalone server.js (works in both dev and packaged modes)
    const serverScript = IS_DEV
      ? path.join(serverDir, ".next", "standalone", "server.js")
      : path.join(serverDir, "server.js");

    console.log(`Starting server: ${serverScript}`);
    console.log(`Data directory: ${dataDir}`);

    // Use system Node.js (not Electron's) to avoid native module ABI mismatch.
    // better-sqlite3 was compiled for system Node.js and won't load in Electron's runtime.
    const nodePath = findSystemNode();

    serverProcess = spawn(nodePath, [serverScript], {
      cwd: IS_DEV ? path.join(serverDir, ".next", "standalone") : serverDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        reject(new Error("Server failed to start within 30 seconds"));
      }
    }, 30_000);

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString();
      console.log(`[server] ${line.trim()}`);

      // Detect when Next.js is ready
      if (!started && (line.includes("Ready in") || line.includes(`localhost:${PORT}`))) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[server:err] ${data.toString().trim()}`);
    });

    serverProcess.on("exit", (code) => {
      console.log(`Server process exited with code ${code}`);
      serverProcess = null;
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

function stopServer(): void {
  if (!serverProcess) return;
  console.log("Stopping server...");

  // Graceful shutdown
  serverProcess.kill("SIGTERM");

  // Force kill after 5 seconds
  const forceKillTimeout = setTimeout(() => {
    if (serverProcess) {
      serverProcess.kill("SIGKILL");
      serverProcess = null;
    }
  }, 5_000);

  serverProcess.on("exit", () => {
    clearTimeout(forceKillTimeout);
    serverProcess = null;
  });
}

// ─── Window ─────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: "#080B12", // Midnight Portfolio canvas color
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}/dashboard`);

  // Scale content to fit Electron window (Next.js assumes full browser viewport)
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.setZoomFactor(0.85);
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────

app.setName(APP_NAME);

app.whenReady().then(async () => {
  setupIpcHandlers();

  try {
    await startServer();
    createWindow();
    createTray(mainWindow);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    dialog.showErrorBox(
      "Failed to Start",
      `The server could not be started:\n\n${message}\n\nCheck that no other process is using port ${PORT}.`
    );
    app.quit();
  }

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0 && serverProcess) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS, keep app running in the tray
  if (process.platform !== "darwin") {
    stopServer();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopServer();
});
