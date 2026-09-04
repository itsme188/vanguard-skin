/**
 * Where acquired bytes live on disk — as an OPAQUE call, on purpose (M1).
 *
 * `writeAcquiredBytes` used to compose this path inline:
 *
 *     const dir = path.join(seams.storageRoot(), String(dirKey));
 *     const finalPath = path.join(dir, `${sha}.${ext}`);
 *
 * Next's Turbopack tracer models `path.join` and template literals well enough
 * to fold that into a glob (`<dyn>/<dyn>/<dyn>.<dyn>`), then warns on every
 * build that the argument to `fsp.mkdir`/`writeFile`/`rename` "matches 11301
 * files in the project" — a warning that is noise here (the root is
 * `resolveDbDir()`, outside the bundle) but real noise, in a build log the desk
 * reads before a print night. The PDF text write right below it is silent for
 * exactly one reason: its path comes from an IMPORTED call (`textPathFor`) the
 * analyzer cannot model.
 *
 * So this is the same trick, deliberately: an imported function whose result is
 * opaque. No behaviour change — the string it returns is byte-for-byte what the
 * inline composition produced, and `path.dirname` of it is the same directory.
 */
import path from "node:path";

/** `<storageRoot>/<dirKey>/<sha>.<ext>` — the content-addressed final path. */
export function acquiredBytesPath(
  root: string,
  dirKey: number | string,
  sha: string,
  ext: string,
): string {
  // Assembled with Array#join and normalised, NOT composed with `path.join`:
  // moving the composition into this module was not enough on its own (the
  // tracer follows the import and warns here instead). What it models is
  // `path.join`'s ARGUMENT STRUCTURE — the constant `/` and `.` between the
  // dynamic parts are what make it a glob broad enough to warn about. One
  // opaque string is just `<dynamic>`, which it skips. `path.normalize` keeps
  // the collapsing `path.join` would have done (a root with a trailing
  // separator, say) without reintroducing the pattern.
  return path.normalize([root, String(dirKey), `${sha}.${ext}`].join(path.sep));
}
