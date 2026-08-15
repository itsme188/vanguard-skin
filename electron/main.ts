/**
 * Electron main process — launches a production Next.js server as a child
 * process and opens a BrowserWindow pointed at it.
 *
 * Data directory: ~/Library/Application Support/vanguard-skin/ (macOS)
 * Settings: stored via electron-store (encrypted API keys)
 */

import { app, BrowserWindow, shell, ipcMain, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { setupIpcHandlers } from "./ipc-handlers";
import { createTray } from "./tray";
import {
  getSettings,
  bootstrapFromEnvLocal,
  loadOrCreateSecret,
  getEncryptedSecret,
  setEncryptedSecret,
  rotateSecret,
} from "./settings-store";
import { openServerLog, serverLogLine } from "./server-log";
import {
  buildBootstrapCookieArgs,
  ELECTRON_SERVICE_CRED_KEY,
  ELECTRON_SERVICE_CRED_ENV,
  APP_PASSWORD_HASH_KEY,
  APP_PASSWORD_HASH_ENV,
  type BootstrapResponse,
} from "./bootstrap-auth";
import { hashPassword, verifyPassword } from "./password-hash";
import { promptForNewPassword } from "./password-prompt";
import { runPasswordChange, type PasswordChangeResult } from "./password-change";
import { runCredentialRotation, type RotateCredentialResult } from "./credential-rotation";

// ─── Find System Node.js ────────────────────────────────────────

/**
 * The Node ABI (process.versions.modules) the app's bundled better-sqlite3
 * binary was compiled against. Pinned by `npmRebuild: false` in
 * electron-builder.yml — the checked-in binary targets Node 20 (ABI 115).
 * If the binary is ever rebuilt for a newer Node line, update this constant
 * in the same commit.
 */
const REQUIRED_NODE_ABI = "137";

/**
 * Find the system Node.js binary. Electron embeds its own Node.js with a
 * different ABI version, so native modules (better-sqlite3) won't load —
 * the Next.js server must run under a system Node.js.
 *
 * ABI-aware since 2026-08-10: a `brew upgrade` moved /opt/homebrew/bin/node
 * to v26 (ABI 147) and the freshly launched app died on ERR_DLOPEN_FAILED —
 * blank window, server exiting in a loop. Path-existence alone is not
 * enough; prefer the first candidate whose ABI matches the bundled binary,
 * and only fall back to bare existence when no candidate matches (better to
 * crash with the loud module-version error in server.log than to not start).
 */
function findSystemNode(): string {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");

  const candidates = [
    "/opt/homebrew/opt/node@24/bin/node", // versioned keg — survives `brew upgrade node`
    "/opt/homebrew/opt/node@20/bin/node", // legacy keg (pre-2026-08-11 installs)
    "/opt/homebrew/bin/node",  // macOS Apple Silicon (Homebrew)
    "/usr/local/bin/node",     // macOS Intel (Homebrew)
    "/usr/bin/node",           // Linux system
  ];

  // Shell fallback candidate, appended last.
  try {
    const result = execSync("which node", { encoding: "utf-8" }).trim();
    if (result) candidates.push(result);
  } catch {
    // Fall through
  }

  const existing = candidates.filter((p) => fs.existsSync(p));

  // First pass: exact ABI match against the bundled native module.
  for (const p of existing) {
    try {
      const abi = execSync(`"${p}" -p process.versions.modules`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (abi === REQUIRED_NODE_ABI) return p;
    } catch {
      // Unprobeable candidate — skip in this pass, existence pass may still use it.
    }
  }

  // Second pass: old behavior — first existing path, ABI unknown/mismatched.
  if (existing.length > 0) {
    console.warn(
      `[electron] No Node with ABI ${REQUIRED_NODE_ABI} found; falling back to ${existing[0]} — ` +
        `better-sqlite3 may fail to load (install node@24 via Homebrew to fix)`,
    );
    return existing[0];
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

/** User data directory for SQLite DB and settings.
 *  Both dev and packaged modes use the project's data/ directory
 *  so imports and changes are shared — single source of truth. */
function getDataDir(): string {
  if (IS_DEV) {
    return path.join(__dirname, "..", "data");
  }
  // Shared with dev mode — one DB for both Electron and npm run dev
  const homeDir = process.env.HOME || "/Users/Yitzi";
  return path.join(homeDir, "code", "vanguard-skin", "data");
}

// ─── State ──────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
/**
 * Electron-main service credential (#35 task 14). Loaded/generated once at
 * startup via `loadOrCreateSecret` (OS-keychain encrypted), injected into the
 * child server as ELECTRON_SERVICE_CRED, and sent as the `X-Electron-Cred`
 * header on the main process's own fetches (desktop-bootstrap + the tws/*
 * auto-connect calls), which do NOT carry the renderer window's cookie jar.
 */
let electronServiceCred: string | null = null;
/**
 * Durable sink for the Next server's stdout/stderr (2026-08-04): a
 * Finder-launched .app discards Electron main's console, so without this
 * file server-side warnings leave no trace (the useRTH reaction failure
 * needed a live probe to diagnose). Null = console-only (logging must
 * never block the app).
 */
let serverLogStream: ReturnType<typeof openServerLog> = null;

function getServerLogDir(): string {
  // macOS-only app (DMG/launchd); matches Console.app's per-app log folder.
  const homeDir = process.env.HOME || "/Users/Yitzi";
  return path.join(homeDir, "Library", "Logs", APP_NAME);
}

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
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      VANGUARD_DB_DIR: dataDir,
      ELECTRON: "true",
    };

    // #35 task 14 — the Electron-main service credential the desktop-bootstrap
    // route (and the tws/* auto-connect routes) authenticate against. Loaded
    // before startServer() in whenReady; injected here alongside the settings.
    if (electronServiceCred) env[ELECTRON_SERVICE_CRED_ENV] = electronServiceCred;

    // #35 task 15 — the app password hash the /api/auth/login route verifies
    // against. Read fresh from safeStorage on EVERY spawn so a change-password
    // restart picks up the new hash from env (a running server can't hot-swap
    // it). Provisioned before the first startServer() in whenReady, so it is
    // always present here; a running server with no hash refuses remote logins.
    const passwordHash = getEncryptedSecret(APP_PASSWORD_HASH_KEY);
    if (passwordHash) env[APP_PASSWORD_HASH_ENV] = passwordHash;

    // Inject settings as env vars
    if (settings.anthropicApiKey) env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
    if (settings.ibkrAccountCode) env.IBKR_ACCOUNT_CODE = settings.ibkrAccountCode;
    if (settings.twsHost) env.TWS_HOST = settings.twsHost;
    if (settings.twsPort) env.TWS_PORT = String(settings.twsPort);
    if (settings.gmailAddress) env.GMAIL_ADDRESS = settings.gmailAddress;
    if (settings.gmailAppPassword) env.GMAIL_APP_PASSWORD = settings.gmailAppPassword;
    if (settings.resendApiKey) env.RESEND_API_KEY = settings.resendApiKey;
    if (settings.resendFromDomain) env.RESEND_FROM_DOMAIN = settings.resendFromDomain;
    if (settings.briefingEmailTo) env.BRIEFING_EMAIL_TO = settings.briefingEmailTo;
    if (settings.fredApiKey) env.FRED_API_KEY = settings.fredApiKey;
    if (settings.edgarContactEmail) env.EDGAR_CONTACT_EMAIL = settings.edgarContactEmail;
    if (settings.apiNinjasKey) env.API_NINJAS_API_KEY = settings.apiNinjasKey;
    if (settings.alphaVantageApiKey) env.ALPHA_VANTAGE_API_KEY = settings.alphaVantageApiKey;
    if (settings.pushoverAppToken) env.PUSHOVER_APP_TOKEN = settings.pushoverAppToken;
    if (settings.pushoverUserKey) env.PUSHOVER_USER_KEY = settings.pushoverUserKey;
    if (settings.pushoverLinkBase) env.PUSHOVER_LINK_BASE = settings.pushoverLinkBase;
    if (settings.cloudflareAccountId) env.CLOUDFLARE_ACCOUNT_ID = settings.cloudflareAccountId;
    if (settings.cloudflareGatewayId) env.CLOUDFLARE_GATEWAY_ID = settings.cloudflareGatewayId;
    if (settings.cloudflareGatewayToken) env.CLOUDFLARE_GATEWAY_TOKEN = settings.cloudflareGatewayToken;
    if (settings.cloudflareWorkersAIToken) env.CLOUDFLARE_WORKERS_AI_TOKEN = settings.cloudflareWorkersAIToken;
    if (settings.openaiApiKey) env.OPENAI_API_KEY = settings.openaiApiKey;
    // Migrated off the bundled .env.local (2026-06-16) — these used to reach the
    // server only via Next auto-loading Resources/standalone/.env.local, which
    // shipped every secret in the DMG. Now injected like the rest.
    if (settings.cronSharedSecret) env.CRON_SHARED_SECRET = settings.cronSharedSecret;
    if (settings.finnhubApiKey) env.FINNHUB_API_KEY = settings.finnhubApiKey;
    if (settings.googleClientId) env.GOOGLE_CLIENT_ID = settings.googleClientId;
    if (settings.googleClientSecret) env.GOOGLE_CLIENT_SECRET = settings.googleClientSecret;
    if (settings.googleRefreshToken) env.GOOGLE_REFRESH_TOKEN = settings.googleRefreshToken;
    if (settings.r2AccessKeyId) env.R2_ACCESS_KEY_ID = settings.r2AccessKeyId;
    if (settings.r2BucketName) env.R2_BUCKET_NAME = settings.r2BucketName;
    if (settings.r2SecretAccessKey) env.R2_SECRET_ACCESS_KEY = settings.r2SecretAccessKey;
    if (settings.workerMarkerUrl) env.WORKER_MARKER_URL = settings.workerMarkerUrl;
    if (settings.plaidClientId) env.PLAID_CLIENT_ID = settings.plaidClientId;
    if (settings.plaidSecret) env.PLAID_SECRET = settings.plaidSecret;
    if (settings.plaidEnv) env.PLAID_ENV = settings.plaidEnv;
    if (settings.plaidRedirectUri) env.PLAID_REDIRECT_URI = settings.plaidRedirectUri;

    // Use the standalone server.js (works in both dev and packaged modes)
    const serverScript = IS_DEV
      ? path.join(serverDir, ".next", "standalone", "server.js")
      : path.join(serverDir, "server.js");

    console.log(`Starting server: ${serverScript}`);
    console.log(`Data directory: ${dataDir}`);

    serverLogStream = openServerLog(getServerLogDir());
    serverLogStream?.write(
      serverLogLine("[electron]", `Starting server: ${serverScript} (data: ${dataDir})`),
    );

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
      serverLogStream?.write(serverLogLine("[server]", line));

      // Detect when Next.js is ready
      if (!started && (line.includes("Ready in") || line.includes(`localhost:${PORT}`))) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString();
      console.error(`[server:err] ${line.trim()}`);
      serverLogStream?.write(serverLogLine("[server:err]", line));
    });

    serverProcess.on("exit", (code) => {
      console.log(`Server process exited with code ${code}`);
      serverLogStream?.write(serverLogLine("[electron]", `Server process exited with code ${code}`));
      serverLogStream?.end();
      serverLogStream = null;
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

/**
 * Stops the child server and RESOLVES once it has actually exited (SIGTERM,
 * then SIGKILL after 5s). Unlike stopServer() this awaits the exit so a
 * restart never races a still-bound port 3099. Safe to call with no server
 * running (resolves immediately).
 */
function stopServerAsync(): Promise<void> {
  return new Promise((resolve) => {
    const proc = serverProcess;
    if (!proc) {
      resolve();
      return;
    }
    const forceKill = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5_000);
    proc.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

/**
 * #35 task 15 — restart the child server so it re-reads its env (the new
 * APP_PASSWORD_HASH after a password change, or a rotated service credential).
 * A running Node process cannot hot-swap its env, so the only correct way to
 * pick up a changed secret is a full stop→start. startServer() re-reads
 * safeStorage + settings on spawn.
 */
async function restartServer(): Promise<void> {
  await stopServerAsync();
  await startServer();
}

// ─── Window ─────────────────────────────────────────────────────

/**
 * Calls the loopback desktop-bootstrap route to mint the renderer window's
 * human session, authenticating with the Electron-main service credential.
 * Retries briefly: startServer() resolves on Next's "Ready" line, but the
 * first request also triggers lazy DB migrations, so an early attempt can
 * race. Bounded so a genuinely broken server never hangs the launch forever.
 */
async function bootstrapDesktopSession(): Promise<BootstrapResponse> {
  const attempts = 5;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/auth/desktop-bootstrap`, {
        method: "POST",
        headers: { "X-Electron-Cred": electronServiceCred ?? "" },
      });
      const json = (await res.json()) as BootstrapResponse;
      if (res.ok && json?.success) return json;
      lastErr = new Error(`bootstrap HTTP ${res.status}: ${json?.error ?? "unknown"}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw lastErr instanceof Error ? lastErr : new Error("desktop bootstrap failed");
}

/**
 * Mints a fresh desktop session via the loopback bootstrap route and installs
 * the returned session + CSRF cookies on the given window's partition. Shared
 * by first launch (createWindow) and the change-password re-bootstrap. Throws
 * if the bootstrap call or cookie install fails — callers decide whether that
 * is fatal.
 */
async function mintAndInstallDesktopSession(window: BrowserWindow): Promise<void> {
  const boot = await bootstrapDesktopSession();
  const cookieArgs = buildBootstrapCookieArgs(PORT, boot);
  for (const c of cookieArgs) {
    await window.webContents.session.cookies.set({
      url: c.url,
      name: c.name,
      value: c.value,
      httpOnly: c.httpOnly,
    });
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: "#080B12", // Midnight Portfolio canvas color
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    // #35 task 14 — do NOT reveal the window until it's authenticated: create
    // hidden, install the session cookies, load /dashboard, THEN show(). This
    // avoids a visible flash of the /login bounce on every launch.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Start maximized — the dashboard is designed for full-width viewports
  mainWindow.maximize();

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Silent auth: mint the human session server-side and install both cookies
  // on this window's partition BEFORE loading the dashboard. If it fails, we
  // still load — the window will bounce to /login (task 18) where the password
  // can be entered manually. A failure here must never crash the app.
  try {
    await mintAndInstallDesktopSession(mainWindow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[electron] desktop bootstrap failed:", message);
    serverLogStream?.write(
      serverLogLine("[electron]", `desktop bootstrap failed (window will bounce to /login): ${message}`),
    );
  }

  // Guard loadURL: a rejection (ERR_ABORTED when a redirect supersedes the
  // navigation, or a mid-load server hiccup) must NOT skip show() nor escape
  // to whenReady's outer catch — that would pop a misleading "Failed to Start"
  // dialog and quit even though the server is healthy. The window ALWAYS
  // appears; a failed load simply lands on Chromium's error page.
  try {
    await mainWindow.loadURL(`http://localhost:${PORT}/dashboard/today`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[electron] loadURL failed:", message);
    serverLogStream?.write(serverLogLine("[electron]", `loadURL failed: ${message}`));
  }
  mainWindow.show();
}

// ─── TWS Auto-Connect ───────────────────────────────────────────

async function autoConnectTws(): Promise<void> {
  const settings = getSettings();
  if (settings.autoConnectTws === false) {
    console.log("[auto-connect] Disabled in settings");
    return;
  }

  try {
    // Check if already connected. These main-process fetches carry no window
    // cookie jar, so they authenticate with the Electron service credential
    // (#35 task 14 — /api/tws/status + /api/tws/connect are classified
    // `electron` in lib/auth/route-policy.ts).
    const statusRes = await fetch(`http://localhost:${PORT}/api/tws/status`, {
      headers: { "X-Electron-Cred": electronServiceCred ?? "" },
    });
    const statusData = await statusRes.json();
    if (statusData?.data?.state === "connected") {
      console.log("[auto-connect] TWS already connected");
      return;
    }

    // Attempt connection
    const res = await fetch(`http://localhost:${PORT}/api/tws/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Electron-Cred": electronServiceCred ?? "",
      },
      body: JSON.stringify({
        host: settings.twsHost || "127.0.0.1",
        port: settings.twsPort || 7496,
        clientId: 1,
      }),
    });
    const data = await res.json();
    if (data.success) {
      console.log("[auto-connect] TWS connected successfully");
    } else {
      console.log("[auto-connect] TWS not available:", data.error || "unknown");
    }
  } catch {
    console.log("[auto-connect] TWS connection attempt failed (TWS may not be running)");
  }
}

// ─── Password provisioning + change transaction (#35 task 15) ───

/**
 * First-run provisioning. If no app password hash exists in safeStorage, opens
 * the native prompt, scrypt-hashes the chosen password, and stores it — BEFORE
 * the child server is spawned, so the server never serves a login it can't
 * verify. Idempotent: a no-op once a hash exists. Throws if the user
 * cancels/closes the prompt (the caller treats that as fatal — no password,
 * no trusted server) or if safeStorage is unavailable (fail-closed, via
 * getEncryptedSecret/setEncryptedSecret).
 */
async function ensureAppPasswordProvisioned(): Promise<void> {
  const existing = getEncryptedSecret(APP_PASSWORD_HASH_KEY); // fail-closed guard runs here
  if (existing !== null) return;
  const password = await promptForNewPassword();
  setEncryptedSecret(APP_PASSWORD_HASH_KEY, hashPassword(password));
  console.log("[electron] app password provisioned (first run)");
  serverLogStream?.write(serverLogLine("[electron]", "app password provisioned (first run)"));
}

/**
 * Calls the server-owned POST /api/auth/revoke-all on the CURRENT (pre-restart)
 * child, authenticated with the Electron service credential. Electron main
 * cannot open the SQLite session store itself (better-sqlite3 ABI), so the
 * server must do the delete. Throws on any non-2xx so the transaction surfaces
 * the failure instead of silently leaving stale sessions alive.
 */
async function callRevokeAll(): Promise<void> {
  const res = await fetch(`http://localhost:${PORT}/api/auth/revoke-all`, {
    method: "POST",
    headers: { "X-Electron-Cred": electronServiceCred ?? "" },
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
  if (!res.ok || !json?.success) {
    throw new Error(`revoke-all failed: HTTP ${res.status} ${json?.error ?? ""}`.trim());
  }
}

/**
 * Re-mints the desktop session on the restarted server and reloads the window
 * so it drops the now-revoked cookie and picks up the fresh one. Best-effort on
 * the reload (a failed navigation lands on /login, where the new password
 * works) but the mint+install must succeed or the window would be stuck logged
 * out — so this rethrows a mint failure to the transaction.
 */
async function rebootstrapWindowSession(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mintAndInstallDesktopSession(mainWindow);
  try {
    await mainWindow.loadURL(`http://localhost:${PORT}/dashboard/today`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[electron] post-change reload failed:", message);
    serverLogStream?.write(serverLogLine("[electron]", `post-change reload failed: ${message}`));
  }
}

/**
 * The full change-password transaction, invoked from the Settings IPC handler.
 * Order is enforced by the pure `runPasswordChange` sequencer (verify → write
 * → revoke-all → restart child → re-bootstrap window). Returns a domain result;
 * a thrown step (e.g. the restart) is caught and returned as a failure so the
 * renderer can explain the no-op rather than crashing the main process.
 */
async function changePasswordTransaction(
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeResult> {
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return { success: false, error: "New password must be at least 8 characters." };
  }
  try {
    return await runPasswordChange({
      verifyCurrent: () => {
        const stored = getEncryptedSecret(APP_PASSWORD_HASH_KEY);
        return stored !== null && verifyPassword(currentPassword, stored);
      },
      writeHash: () => setEncryptedSecret(APP_PASSWORD_HASH_KEY, hashPassword(newPassword)),
      revokeAll: callRevokeAll,
      restart: restartServer,
      rebootstrap: rebootstrapWindowSession,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[electron] change-password transaction failed:", message);
    serverLogStream?.write(serverLogLine("[electron]", `change-password failed: ${message}`));
    return { success: false, error: `Password change failed after starting: ${message}` };
  }
}

// ─── Service-credential rotation transaction (#35 task 17) ──────

/**
 * The full ELECTRON_SERVICE_CRED rotation transaction, invoked from the
 * Settings IPC handler. Order is enforced by the pure `runCredentialRotation`
 * sequencer (mint + persist new cred -> restart child -> re-bootstrap
 * window). ELECTRON_SERVICE_CRED lives in the already-spawned child's env, so
 * it cannot be hot-swapped — restarting is the only way the server picks up
 * the new value.
 *
 * `writeCred` updates the module-level `electronServiceCred` BEFORE restart
 * runs, so every later reader (startServer()'s env injection, and
 * bootstrapDesktopSession()/autoConnectTws()'s `X-Electron-Cred` header) sees
 * the new value — none of them capture it in a closure, they all read the
 * live variable. A thrown step (e.g. safeStorage unavailable, or the restart
 * itself failing) is caught here and returned as a domain failure so the
 * renderer can explain the no-op rather than crashing the main process; the
 * raw new credential never crosses the IPC boundary (RotateCredentialResult
 * carries no secret).
 */
async function rotateServiceCredentialTransaction(): Promise<RotateCredentialResult> {
  try {
    const result = await runCredentialRotation({
      writeCred: () => {
        const newCred = rotateSecret(ELECTRON_SERVICE_CRED_KEY);
        electronServiceCred = newCred;
        return newCred;
      },
      restart: restartServer,
      rebootstrap: rebootstrapWindowSession,
    });
    return { success: result.success };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[electron] credential rotation transaction failed:", message);
    serverLogStream?.write(serverLogLine("[electron]", `credential rotation failed: ${message}`));
    return { success: false, error: `Credential rotation failed after starting: ${message}` };
  }
}

// ─── Auto-Update ────────────────────────────────────────────────

function setupAutoUpdater(): void {
  // Don't check for updates in dev mode
  if (IS_DEV) return;

  autoUpdater.logger = console;
  autoUpdater.autoDownload = false; // Ask user before downloading

  autoUpdater.on("update-available", (info) => {
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Available",
        message: `Version ${info.version} is available.`,
        detail: "Would you like to download it now?",
        buttons: ["Download", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate();
          // Notify renderer
          mainWindow?.webContents.send("update-downloading");
        }
      });
  });

  autoUpdater.on("update-downloaded", () => {
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Ready",
        message: "Update downloaded. Restart now to install?",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("[auto-update] Error:", err.message);
  });

  // Check for updates silently
  autoUpdater.checkForUpdates().catch((err) => {
    console.log("[auto-update] Check failed:", err.message);
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────

app.setName(APP_NAME);

app.whenReady().then(async () => {
  // On first launch, import API keys from .env.local
  bootstrapFromEnvLocal();
  setupIpcHandlers({
    changePassword: changePasswordTransaction,
    rotateServiceCredential: rotateServiceCredentialTransaction,
  });

  // #35 task 14 — load/generate the Electron-main service credential BEFORE
  // starting the server (it must be present in the child env). FAIL-CLOSED:
  // loadOrCreateSecret throws if the OS keychain is unavailable (safeStorage
  // off/locked) — surface a clear dialog rather than crashing uncaught or
  // silently launching an app that can't authenticate its own window.
  try {
    electronServiceCred = loadOrCreateSecret(ELECTRON_SERVICE_CRED_KEY);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    dialog.showErrorBox(
      "Secure Storage Unavailable",
      `The app could not access the OS keychain to load its service credential:\n\n${message}\n\n` +
        `Unlock your login keychain and relaunch. The app cannot start securely without it.`,
    );
    app.quit();
    return;
  }

  // #35 task 15 — provision the app password on first run BEFORE the server is
  // spawned (its hash is injected into the child env, and the server must never
  // serve a login it can't verify). FAIL-CLOSED: a cancelled prompt or an
  // unavailable keychain means we cannot start a trustworthy server — surface a
  // dialog and quit rather than launching without a password boundary.
  try {
    await ensureAppPasswordProvisioned();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    dialog.showErrorBox(
      "Password Required",
      `Portfolio Desk needs an app password before it can start:\n\n${message}\n\n` +
        `Relaunch and set a password to continue.`,
    );
    app.quit();
    return;
  }

  try {
    await startServer();
    await createWindow();
    createTray(mainWindow);

    // Non-blocking TWS auto-connect after server warmup
    setTimeout(() => autoConnectTws(), 3_000);

    // Check for updates (non-blocking, only in packaged app)
    setupAutoUpdater();
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
