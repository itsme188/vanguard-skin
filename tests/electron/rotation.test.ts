import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { runCredentialRotation } from "@/electron/credential-rotation";
import { handleDesktopBootstrap } from "@/app/api/auth/desktop-bootstrap/route";
import { verifyElectronCred } from "@/lib/auth/electron-cred";

// Packaged-app trust boundary (#35, task 17) — service-credential ROTATION.
//
// ELECTRON_SERVICE_CRED lives in the already-spawned child server's env, so it
// cannot be hot-swapped. Rotation must re-mint it, restart the child (the only
// way a Node process picks up a changed env var), and re-bootstrap the desktop
// session so Electron main's own fetches (bootstrap + tws/*) use the new
// value. This file has two independent halves:
//
//   1. `runCredentialRotation` — the pure, DI'd sequencer. Proves the ORDER
//      (write new cred -> restart -> re-bootstrap) and that a mid-step throw
//      aborts cleanly and is reported (propagated, not swallowed — mirrors
//      task 15's runPasswordChange).
//   2. The credential-decision consequence — using the existing
//      `verifyElectronCred` (the single source of truth both desktop-bootstrap
//      and revoke-all gate on) and `handleDesktopBootstrap` directly, proves
//      that once ELECTRON_SERVICE_CRED changes (what a real restart does by
//      re-reading env at spawn), the OLD value 401s and the NEW value 200s.
//      This is what makes "restart picks up new env" real rather than assumed.

function makeDeps(overrides: Partial<Parameters<typeof runCredentialRotation>[0]> = {}) {
  const calls: string[] = [];
  const deps = {
    writeCred: vi.fn(() => {
      calls.push("writeCred");
      return "new-cred-value";
    }),
    restart: vi.fn(async () => {
      calls.push("restart");
    }),
    rebootstrap: vi.fn(async () => {
      calls.push("rebootstrap");
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("runCredentialRotation", () => {
  it("runs the steps in the exact order and reports success with the new credential", async () => {
    const { deps, calls } = makeDeps();
    const result = await runCredentialRotation(deps);

    expect(result).toEqual({ success: true, newCred: "new-cred-value" });
    expect(calls).toEqual(["writeCred", "restart", "rebootstrap"]);
  });

  it("writes the new cred BEFORE restarting, restarts BEFORE re-bootstrapping", async () => {
    const { deps, calls } = makeDeps();
    await runCredentialRotation(deps);

    expect(calls.indexOf("writeCred")).toBeLessThan(calls.indexOf("restart"));
    expect(calls.indexOf("restart")).toBeLessThan(calls.indexOf("rebootstrap"));
  });

  it("propagates a thrown error from restart (transaction is not silently swallowed)", async () => {
    const { deps } = makeDeps({
      restart: vi.fn(async () => {
        throw new Error("child server failed to restart");
      }),
    });
    await expect(runCredentialRotation(deps)).rejects.toThrow(/restart/i);
    // The new cred was already written (durable) but rebootstrap never ran —
    // a half-rotated state is surfaced by the throw, not swallowed.
    expect(deps.writeCred).toHaveBeenCalledOnce();
    expect(deps.rebootstrap).not.toHaveBeenCalled();
  });

  it("propagates a thrown error from rebootstrap (restart already happened)", async () => {
    const { deps } = makeDeps({
      rebootstrap: vi.fn(async () => {
        throw new Error("bootstrap POST failed");
      }),
    });
    await expect(runCredentialRotation(deps)).rejects.toThrow(/bootstrap/i);
    expect(deps.writeCred).toHaveBeenCalledOnce();
    expect(deps.restart).toHaveBeenCalledOnce();
  });

  it("aborts before restart/rebootstrap when writeCred itself throws (e.g. keychain unavailable)", async () => {
    const { deps } = makeDeps({
      writeCred: vi.fn(() => {
        throw new Error("safeStorage unavailable");
      }),
    });
    await expect(runCredentialRotation(deps)).rejects.toThrow(/safeStorage/i);
    expect(deps.restart).not.toHaveBeenCalled();
    expect(deps.rebootstrap).not.toHaveBeenCalled();
  });
});

// ─── Credential-decision consequence ───────────────────────────────────────

const T0 = Date.parse("2026-08-14T12:00:00Z");

function freshDb(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}

describe("rotation changes the credential decision (old 401, new 200)", () => {
  const originalCred = process.env.ELECTRON_SERVICE_CRED;

  afterEach(() => {
    if (originalCred === undefined) {
      delete process.env.ELECTRON_SERVICE_CRED;
    } else {
      process.env.ELECTRON_SERVICE_CRED = originalCred;
    }
  });

  it("verifyElectronCred: OLD value fails, NEW value passes, once ELECTRON_SERVICE_CRED rotates", () => {
    const OLD = "old-service-cred-111";
    const NEW = "new-service-cred-222";

    process.env.ELECTRON_SERVICE_CRED = OLD;
    expect(verifyElectronCred(OLD)).toEqual({ ok: true });

    // What a real restart does: the child re-reads the rotated secret from
    // its env at spawn. Mutating process.env here IS that mechanism under
    // test — verifyElectronCred always reads process.env fresh, never a
    // cached value, so this proves a restart is sufficient (no other
    // caching layer needs to be busted).
    process.env.ELECTRON_SERVICE_CRED = NEW;

    const oldResult = verifyElectronCred(OLD);
    expect(oldResult.ok).toBe(false);
    if (!oldResult.ok) expect(oldResult.status).toBe(401);

    expect(verifyElectronCred(NEW)).toEqual({ ok: true });
  });

  it("handleDesktopBootstrap: OLD cred 401s and NEW cred 200s once ELECTRON_SERVICE_CRED rotates", () => {
    const db = freshDb();
    const OLD = "old-service-cred-aaa";
    const NEW = "new-service-cred-bbb";

    process.env.ELECTRON_SERVICE_CRED = OLD;
    const beforeRotation = handleDesktopBootstrap(db, OLD, T0);
    expect(beforeRotation.status).toBe(200);

    process.env.ELECTRON_SERVICE_CRED = NEW;

    const oldAfterRotation = handleDesktopBootstrap(db, OLD, T0 + 1);
    expect(oldAfterRotation.status).toBe(401);
    expect(oldAfterRotation.body.success).toBe(false);

    const newAfterRotation = handleDesktopBootstrap(db, NEW, T0 + 2);
    expect(newAfterRotation.status).toBe(200);
    expect(newAfterRotation.body.success).toBe(true);
  });
});
