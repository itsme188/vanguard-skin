> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# Electron Build

## Electron Build

- **DMG build**: `npm run electron:pack` (chains: `rm -rf dist` → `next build` → `tsc` → copy static → deref symlinks → `electron-builder --mac`)
- **`npmRebuild: false`** in `electron-builder.yml` — prevents electron-builder from trying to recompile better-sqlite3 for Electron's V8 (it fails and deletes the working `.node` binary). If it ever runs without this flag, rebuild with `npx node-gyp rebuild --directory=node_modules/better-sqlite3`
- **Symlink dereferencing**: `scripts/deref-standalone-symlinks.js` replaces symlinks in `.next/standalone/.next/node_modules/` with real copies (electron-builder breaks on symlinks post-copy)
- **Explicit `node_modules`** in `extraResources` — electron-builder silently excludes `node_modules` directories even from `extraResources`; the standalone server needs them
- **App icon**: `build/icon.icns` (tracked in git despite `/build/*` in gitignore via `!/build/icon.icns`)
- **Tray icons**: `public/tray-iconTemplate.png` + `@2x.png` — macOS template images (black on transparent, auto-adapt to dark/light)
- **Server logs persist** (2026-08-04): `electron/server-log.ts` tees the Next server's stdout/stderr to `~/Library/Logs/Vanguard Dashboard/server.log` (5MB rotation to `server.log.1`, timestamped `[server]`/`[server:err]`/`[electron]` tags; every failure path degrades to console-only). Deliberately electron-import-free so it's unit-testable (`tests/electron/server-log.test.ts`). First place to look when diagnosing packaged-app server behavior — the pre-fix useRTH failure had zero breadcrumbs.
- **Settings**: `autoConnectTws` (default: true), `refreshIntervalMinutes` (default: 30), and `firstRunComplete` (default: false) in AppSettings
- **WelcomeOverlay ↔ SettingsModal**: communicate via custom DOM event `open-settings` (siblings in server component layout, can't share state via props)
- **Code signing**: Developer ID Application certificate (team 8D2724Y4G2), hardened runtime, notarization via App Store Connect API key
- **Notarization env vars**: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (set in `~/.zshrc`, not `.env.local`)
- **Entitlements**: `build/entitlements.mac.plist` — JIT, unsigned memory, disable library validation (V8 JIT needs these), network, file access
- **Build gotcha**: `dist/` must be cleaned before `next build` — Next.js standalone tracer copies it, causing recursive `.app` nesting during signing

