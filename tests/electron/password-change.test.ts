import { describe, it, expect, vi } from "vitest";
import { runPasswordChange } from "@/electron/password-change";

// Packaged-app trust boundary (#35, task 15) — the change-password transaction
// sequencer. This pure function is the testable core of the Electron-side
// transaction: given injected step fns it enforces the ONE order the spec (§B)
// requires — verify current → write new hash → revoke all sessions → restart
// the child server → re-bootstrap the desktop session. A running server cannot
// hot-swap APP_PASSWORD_HASH, so the restart MUST follow the hash write and
// precede the re-bootstrap, and every session must be revoked before the old
// server is torn down.

function makeDeps(overrides: Partial<Parameters<typeof runPasswordChange>[0]> = {}) {
  const calls: string[] = [];
  const deps = {
    verifyCurrent: vi.fn(() => {
      calls.push("verifyCurrent");
      return true;
    }),
    writeHash: vi.fn(() => {
      calls.push("writeHash");
    }),
    revokeAll: vi.fn(async () => {
      calls.push("revokeAll");
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

describe("runPasswordChange", () => {
  it("runs the steps in the exact spec order and reports success", async () => {
    const { deps, calls } = makeDeps();
    const result = await runPasswordChange(deps);

    expect(result).toEqual({ success: true });
    expect(calls).toEqual([
      "verifyCurrent",
      "writeHash",
      "revokeAll",
      "restart",
      "rebootstrap",
    ]);
  });

  it("writes the new hash BEFORE revoking, revokes BEFORE restarting, restarts BEFORE re-bootstrapping", async () => {
    const { deps, calls } = makeDeps();
    await runPasswordChange(deps);

    expect(calls.indexOf("writeHash")).toBeLessThan(calls.indexOf("revokeAll"));
    expect(calls.indexOf("revokeAll")).toBeLessThan(calls.indexOf("restart"));
    expect(calls.indexOf("restart")).toBeLessThan(calls.indexOf("rebootstrap"));
  });

  it("aborts BEFORE writing anything when the current password is wrong", async () => {
    const { deps, calls } = makeDeps({
      verifyCurrent: vi.fn(() => {
        calls.push("verifyCurrent");
        return false;
      }),
    });
    const result = await runPasswordChange(deps);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/current password/i);
    expect(deps.writeHash).not.toHaveBeenCalled();
    expect(deps.revokeAll).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
    expect(deps.rebootstrap).not.toHaveBeenCalled();
    expect(calls).toEqual(["verifyCurrent"]);
  });

  it("propagates a thrown error from a later step (transaction is not silently swallowed)", async () => {
    const { deps } = makeDeps({
      restart: vi.fn(async () => {
        throw new Error("child server failed to restart");
      }),
    });
    await expect(runPasswordChange(deps)).rejects.toThrow(/restart/i);
    // The hash write + revoke already happened; re-bootstrap did not.
    expect(deps.writeHash).toHaveBeenCalledOnce();
    expect(deps.revokeAll).toHaveBeenCalledOnce();
    expect(deps.rebootstrap).not.toHaveBeenCalled();
  });
});
