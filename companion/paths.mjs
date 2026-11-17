/**
 * Path rules for the companion: which Data-relative paths it may touch.
 *
 * Paths arrive the way Foundry hands them to the client: POSIX, relative to the Data folder, each
 * segment URL-encoded (Foundry's `encodeURL`). Nothing here touches the disk except `resolveReal`,
 * so the rules are unit-tested on plain strings.
 */
import fs from "node:fs";
import path from "node:path";

/** Where deleted entries go. Foundry's browser hides names starting with ".", so it stays invisible. */
export const TRASH_DIR = ".dimancer-trash";

/** Package type folders at the top of Data. */
const PACKAGE_ROOTS = ["worlds", "modules", "systems"];

/** Manifest files that make a folder a package. */
const MANIFESTS = ["world.json", "module.json", "system.json"];

export class PathError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Encode a decoded relative path the way Foundry's `encodeURL` does. */
export function encodePath(rel) {
  return rel.split("/").map(p => encodeURIComponent(p).replace(/'/g, "%27")).join("/");
}

/** Decode one client path; a malformed escape is taken literally, as Foundry's browser would show it. */
function decode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Turn a client path into clean decoded segments, or throw.
 * Refuses absolute paths, "..", empty segments, NUL and hidden (dot) segments.
 * @param {string} clientPath
 * @returns {string[]}
 */
export function toSegments(clientPath) {
  if ( typeof clientPath !== "string" ) throw new PathError("Path must be a string.");
  const raw = clientPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if ( !raw ) return [];
  const segments = raw.split("/").map(decode);
  for ( const s of segments ) {
    if ( !s || s.includes("\0") || s.includes("/") || s.includes("\\") ) throw new PathError(`Invalid path: ${clientPath}`);
    if ( s === "." || s === ".." ) throw new PathError(`Invalid path: ${clientPath}`);
    if ( s.startsWith(".") ) throw new PathError(`Hidden paths are off limits: ${clientPath}`);
  }
  return segments;
}

/**
 * May a new entry be placed directly inside this folder?
 * Mirrors Foundry's own upload rules (FilePicker#canCreateFolder): not into worlds/modules/systems
 * themselves, not into a package's database or compendium folders, and inside modules and systems
 * only under their persistent `storage/` folder. The Data root takes folders but not files.
 * @param {string[]} dir  Decoded segments of the folder.
 * @param {{isDir?: boolean}} [entry]  What would be placed there.
 * @returns {string|null}  Why not, or null when allowed.
 */
export function containerProblem(dir, { isDir = false } = {}) {
  if ( !dir.length ) return isDir ? null : "Files can't be placed in the root of the Data folder.";
  const [top, pkg, sub] = dir;
  if ( !PACKAGE_ROOTS.includes(top) ) return null;
  if ( dir.length === 1 ) return `The ${top} folder holds packages only.`;
  if ( top === "worlds" ) {
    if ( sub === "data" || sub === "packs" ) return `worlds/${pkg}/${sub} belongs to Foundry's database.`;
    return null;
  }
  if ( sub !== "storage" ) return `Inside ${top}/ only a package's storage/ folder may be changed.`;
  return null;
}

/**
 * May this entry be deleted, moved or renamed?
 * @param {string[]} entry  Decoded segments of the entry.
 * @param {{isDir?: boolean}} [info]
 * @returns {string|null}  Why not, or null when allowed.
 */
export function entryProblem(entry, { isDir = false } = {}) {
  if ( !entry.length ) return "The Data folder itself can't be changed.";
  const name = entry.at(-1);
  if ( entry.length === 1 && PACKAGE_ROOTS.includes(name) ) return `The ${name} folder can't be changed.`;
  if ( entry.length === 3 && PACKAGE_ROOTS.includes(entry[0]) && MANIFESTS.includes(name.toLowerCase()) ) {
    return `${name} is a package manifest.`;
  }
  if ( entry.length === 3 && entry[0] === "worlds" && ["data", "packs"].includes(name) ) {
    return `worlds/${entry[1]}/${name} belongs to Foundry's database.`;
  }
  // A package's storage/ folder itself is part of the package.
  if ( entry.length === 3 && ["modules", "systems"].includes(entry[0]) && name === "storage" ) {
    return "A package's storage folder can't be changed, only what's inside it.";
  }
  return containerProblem(entry.slice(0, -1), { isDir });
}

/**
 * Resolve segments against the Data root and check where they really lead.
 * Refuses entries that exist outside Data once symlinks are followed (in this dev setup
 * `Data/modules/<id>` are symlinks to the module sources), and re-applies the rules to the real
 * location, so a symlink inside a world can't reach a package.
 * @param {string} rootReal  The realpath of the Data folder.
 * @param {string[]} segments
 * @param {{mustExist?: boolean}} [options]
 * @returns {{abs: string, real: string, exists: boolean, stat: fs.Stats|null}}
 */
export function resolveReal(rootReal, segments, { mustExist = true } = {}) {
  const abs = path.join(rootReal, ...segments);
  let stat = null;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    if ( mustExist ) throw new PathError(`Not found: ${segments.join("/")}`, 404);
  }
  // Follow symlinks in the parent folders; the entry itself is judged by its own lstat.
  let parentReal;
  try {
    parentReal = fs.realpathSync(path.dirname(abs));
  } catch {
    if ( mustExist ) throw new PathError(`Not found: ${segments.join("/")}`, 404);
    parentReal = path.dirname(abs);
  }
  const real = path.join(parentReal, path.basename(abs));
  if ( !isContained(real, rootReal) && (real !== rootReal) ) {
    throw new PathError(`${segments.join("/")} leads outside the Data folder.`, 403);
  }
  if ( stat?.isSymbolicLink() ) {
    throw new PathError(`${segments.join("/")} is a symbolic link; change it on the server instead.`, 403);
  }
  return { abs, real, exists: !!stat, stat };
}

/** The real path's segments relative to the Data root, for re-checking the rules after symlinks. */
export function realSegments(rootReal, real) {
  const rel = path.relative(rootReal, real);
  return rel ? rel.split(path.sep) : [];
}

export function isContained(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Check a single new file or folder name. */
export function nameProblem(name) {
  if ( typeof name !== "string" || !name.trim() ) return "The name is empty.";
  if ( name !== name.trim() ) return "The name can't start or end with spaces.";
  if ( /[/\\\0]/.test(name) ) return "The name can't contain slashes.";
  if ( name === "." || name === ".." || name.startsWith(".") ) return "The name can't start with a dot.";
  if ( name.length > 255 ) return "The name is too long.";
  return null;
}
