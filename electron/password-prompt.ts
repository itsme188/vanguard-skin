/**
 * First-run native password prompt (#35, task 15).
 *
 * Electron has no built-in text-input dialog, so this opens a small, fixed-size
 * BrowserWindow that loads a self-authored inline HTML form (a data: URL — no
 * remote content, no navigation) collecting a new password + confirmation with
 * a basic strength guard. The window uses `contextIsolation` + a dedicated
 * preload (NOT nodeIntegration): the form reaches main only through the two
 * `promptAPI` channels.
 *
 * `promptForNewPassword` resolves with the chosen plaintext password (the
 * caller hashes + stores it) or rejects if the user cancels/closes the window —
 * the app must NOT start a server that trusts remote clients without a
 * provisioned password, so a rejection is treated as fatal by the caller.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";

/** Minimum password length enforced both client-side (for UX) and here. */
export const MIN_PASSWORD_LENGTH = 8;

const PROMPT_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  :root { color-scheme: dark; }
  body {
    font-family: -apple-system, "IBM Plex Sans", system-ui, sans-serif;
    background: #080B12; color: #E6EAF2; margin: 0; padding: 22px 24px;
    -webkit-user-select: none; user-select: none;
  }
  h1 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  p.sub { font-size: 12px; color: #8A94A6; margin: 0 0 16px; line-height: 1.4; }
  label { display: block; font-size: 11px; color: #8A94A6; margin: 12px 0 4px; }
  input {
    width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px;
    background: #10141D; border: 1px solid #232A38; border-radius: 6px;
    color: #E6EAF2; outline: none;
  }
  input:focus { border-color: #E0A73B; }
  .err { color: #E5484D; font-size: 11px; min-height: 14px; margin-top: 10px; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
  button {
    padding: 7px 16px; font-size: 13px; border-radius: 6px; border: 1px solid #232A38;
    background: #10141D; color: #E6EAF2; cursor: pointer;
  }
  button.primary { background: #E0A73B; border-color: #E0A73B; color: #1A1206; font-weight: 600; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <h1>Set your dashboard password</h1>
  <p class="sub">This unlocks Portfolio Desk on this Mac and on your phone. It is stored encrypted in the macOS keychain and can be changed later in Settings. There is no remote reset.</p>
  <label for="pw">Password (at least ${MIN_PASSWORD_LENGTH} characters)</label>
  <input id="pw" type="password" autofocus autocomplete="new-password" />
  <label for="pw2">Confirm password</label>
  <input id="pw2" type="password" autocomplete="new-password" />
  <div class="err" id="err"></div>
  <div class="row">
    <button id="cancel">Quit</button>
    <button id="save" class="primary" disabled>Set Password</button>
  </div>
<script>
  var pw = document.getElementById('pw');
  var pw2 = document.getElementById('pw2');
  var err = document.getElementById('err');
  var save = document.getElementById('save');
  var cancel = document.getElementById('cancel');
  var MIN = ${MIN_PASSWORD_LENGTH};

  function validate() {
    var a = pw.value, b = pw2.value;
    if (a.length > 0 && a.length < MIN) { err.textContent = 'Password must be at least ' + MIN + ' characters.'; save.disabled = true; return false; }
    if (b.length > 0 && a !== b) { err.textContent = 'Passwords do not match.'; save.disabled = true; return false; }
    err.textContent = '';
    var ok = a.length >= MIN && a === b;
    save.disabled = !ok;
    return ok;
  }
  pw.addEventListener('input', validate);
  pw2.addEventListener('input', validate);

  function submit() {
    if (!validate()) return;
    save.disabled = true;
    window.promptAPI.submit(pw.value);
  }
  save.addEventListener('click', submit);
  pw2.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  cancel.addEventListener('click', function () { window.promptAPI.cancel(); });
</script>
</body>
</html>`;

export function promptForNewPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 440,
      height: 380,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Set Dashboard Password",
      backgroundColor: "#080B12",
      webPreferences: {
        preload: path.join(__dirname, "password-prompt-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);

    let settled = false;

    const cleanup = () => {
      ipcMain.removeHandler("password-prompt:submit");
      ipcMain.removeListener("password-prompt:cancel", onCancel);
    };

    const onSubmit = (_event: IpcMainInvokeEvent, password: string): boolean => {
      if (settled) return false;
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        // Client already guards this; treat a malformed value as a no-op rather
        // than resolving with a too-weak password.
        return false;
      }
      settled = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      resolve(password);
      return true;
    };

    const onCancel = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      reject(new Error("Password setup was cancelled."));
    };

    ipcMain.handle("password-prompt:submit", onSubmit);
    ipcMain.on("password-prompt:cancel", onCancel);

    win.on("closed", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Password setup window was closed before a password was set."));
    });

    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROMPT_HTML)}`);
  });
}
