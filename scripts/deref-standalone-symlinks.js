/**
 * Dereferences symlinks in the Next.js standalone output.
 *
 * Next.js standalone mode creates symlinks in .next/node_modules/ for native
 * addons (e.g., better-sqlite3-<hash> → ../../node_modules/better-sqlite3).
 * Scoped packages like @stoqey/ib-<hash> live one level deeper.
 * electron-builder breaks when it encounters these symlinks during packaging
 * because the symlink target falls outside the copied resource directory.
 *
 * This script recursively finds and replaces all symlinks with real copies.
 */

const fs = require("fs");
const path = require("path");

const dir = path.join(".next", "standalone", ".next", "node_modules");

if (!fs.existsSync(dir)) {
  console.log("No standalone .next/node_modules directory found — skipping.");
  process.exit(0);
}

let count = 0;

function derefSymlinks(searchDir) {
  const entries = fs.readdirSync(searchDir);

  for (const entry of entries) {
    const fullPath = path.join(searchDir, entry);
    const stat = fs.lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      const realPath = fs.realpathSync(fullPath);
      fs.rmSync(fullPath);
      fs.cpSync(realPath, fullPath, { recursive: true });
      console.log(`Dereferenced: ${path.relative(dir, fullPath)} → ${path.relative(".", realPath)}`);
      count++;
    } else if (stat.isDirectory() && entry.startsWith("@")) {
      // Recurse into scoped package directories (@scope/package-hash)
      derefSymlinks(fullPath);
    }
  }
}

derefSymlinks(dir);

if (count > 0) {
  console.log(`Resolved ${count} symlink(s) in standalone output.`);
} else {
  console.log("No symlinks found — nothing to do.");
}
