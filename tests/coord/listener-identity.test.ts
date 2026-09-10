import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const helper = path.resolve(__dirname, "../../scripts/coord/listener-identity.py");
const app = "/Applications/Portfolio Fixture.app";
const cwd = `${app}/Contents/Resources/standalone`;
const executable = `${app}/Contents/MacOS/Portfolio Fixture`;
const probe = String.raw`
import importlib.util, json, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("identity", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
d = json.load(sys.stdin)
with patch.object(m.subprocess, "check_output") as command, patch.object(m, "process_executable") as exe:
    command.side_effect = OSError("gone") if d.get("gone") else ["p4321\nfcwd\nn" + d["cwd"] + "\n", str(d.get("parent", 1234))]
    exe.return_value = d["executable"]
    print(json.dumps(m.belongs_to_app(4321, d["app"])))
`;
function check(extra: Record<string, unknown> = {}) {
  const result = spawnSync("python3", ["-c", probe, helper], {
    input: JSON.stringify({ app, cwd, executable, ...extra }), encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
describe("installed app listener identity (Next rewrites its process title)", () => {
  it("accepts the standalone listener owned by the actual app executable without consulting argv", () => expect(check()).toBe(true));
  it("rejects a matching cwd when an unrelated process is the parent", () => expect(check({ executable: "/usr/bin/python3" })).toBe(false));
  it("rejects a different cwd even with the correct app parent", () => expect(check({ cwd: "/private/tmp/other" })).toBe(false));
  it("rejects a bundle-name prefix collision", () => expect(check({ cwd: cwd.replace(".app/", ".app-other/") })).toBe(false));
  it("rejects an orphaned listener", () => expect(check({ parent: 1 })).toBe(false));
  it("fails closed when process metadata disappears", () => expect(check({ gone: true })).toBe(false));
});
