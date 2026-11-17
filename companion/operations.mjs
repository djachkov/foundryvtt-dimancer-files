/**
 * The file operations Foundry's server lacks: stat, search, delete (to a trash), restore, rename, move.
 * Every path goes through paths.mjs first. All paths in and out are client paths (Data-relative,
 * URL-encoded per segment, like Foundry's own browse results).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PathError, TRASH_DIR, containerProblem, encodePath, entryProblem, nameProblem, realSegments, resolveReal,
  toSegments
} from "./paths.mjs";

export class Operations {
  /** @param {string} dataRoot  The Foundry Data folder. */
  constructor(dataRoot) {
    this.root = fs.realpathSync(dataRoot);
    this.trash = path.join(this.root, TRASH_DIR);
  }

  /* -------------------------------------------- */
  /*  Checks                                      */
  /* -------------------------------------------- */

  /** Resolve an existing entry that may be changed. */
  #entry(clientPath) {
    const segments = toSegments(clientPath);
    const info = resolveReal(this.root, segments);
    const isDir = info.stat.isDirectory();
    const problem = entryProblem(segments, { isDir }) ?? entryProblem(realSegments(this.root, info.real), { isDir });
    if ( problem ) throw new PathError(problem, 403);
    return { ...info, segments, isDir };
  }

  /** Resolve an existing folder new entries may be placed in. */
  #container(clientPath, { isDir }) {
    const segments = toSegments(clientPath);
    const info = resolveReal(this.root, segments);
    if ( !info.stat.isDirectory() ) throw new PathError(`${clientPath} is not a folder.`);
    const problem = containerProblem(segments, { isDir })
      ?? containerProblem(realSegments(this.root, info.real), { isDir });
    if ( problem ) throw new PathError(problem, 403);
    return { ...info, segments };
  }

  /* -------------------------------------------- */
  /*  Reading                                     */
  /* -------------------------------------------- */

  /**
   * Size and modification time of each path. Unknown or unreadable paths come back with `error`.
   * @param {string[]} paths
   */
  stat(paths) {
    if ( !Array.isArray(paths) ) throw new PathError("paths must be an array.");
    if ( paths.length > 10000 ) throw new PathError("Too many paths.");
    return paths.map(p => {
      try {
        const { stat } = resolveReal(this.root, toSegments(p));
        return { path: p, isDir: stat.isDirectory(), size: stat.isDirectory() ? null : stat.size,
          mtime: stat.mtimeMs };
      } catch (err) {
        return { path: p, error: err.message };
      }
    });
  }

  /**
   * Find files and folders whose name contains the query, below a folder.
   * Skips hidden entries and symbolic links (so it never loops and never leaves Data).
   * @param {{root?: string, query: string, extensions?: string[], limit?: number}} options
   */
  search({ root = "", query, extensions = [], limit = 500 } = {}) {
    const q = String(query ?? "").trim().toLowerCase();
    if ( q.length < 2 ) throw new PathError("Search for at least two characters.");
    const start = resolveReal(this.root, toSegments(root));
    if ( !start.stat.isDirectory() ) throw new PathError(`${root} is not a folder.`);
    const exts = (Array.isArray(extensions) ? extensions : []).map(e => e.toLowerCase());
    const max = Math.min(Math.max(1, Number(limit) || 500), 2000);
    const results = [];
    const queue = [start.abs];
    let truncated = false;
    let visited = 0;
    while ( queue.length ) {
      const dir = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for ( const e of entries ) {
        if ( e.name.startsWith(".") || e.isSymbolicLink() ) continue;
        if ( ++visited > 200000 ) {
          truncated = true;
          break;
        }
        const abs = path.join(dir, e.name);
        const isDir = e.isDirectory();
        if ( isDir ) queue.push(abs);
        if ( !e.name.toLowerCase().includes(q) ) continue;
        if ( !isDir && exts.length && !exts.includes(path.extname(e.name).toLowerCase()) ) continue;
        results.push({ path: encodePath(path.relative(this.root, abs).split(path.sep).join("/")), isDir });
        if ( results.length >= max ) {
          truncated = true;
          break;
        }
      }
      if ( truncated ) break;
    }
    return { results, truncated };
  }

  /* -------------------------------------------- */
  /*  Changing                                    */
  /* -------------------------------------------- */

  /**
   * Delete entries: into the trash by default, or for good.
   * Each path succeeds or fails on its own; the result says which.
   * @param {string[]} paths
   * @param {{permanent?: boolean}} [options]
   */
  async delete(paths, { permanent = false } = {}) {
    if ( !Array.isArray(paths) || !paths.length ) throw new PathError("Nothing to delete.");
    const results = [];
    for ( const p of nested(paths) ) {
      try {
        const entry = this.#entry(p);
        if ( permanent ) {
          await fs.promises.rm(entry.abs, { recursive: true, force: false });
          results.push({ path: p, deleted: true });
        } else {
          const id = await this.#toTrash(entry);
          results.push({ path: p, deleted: true, trashId: id });
        }
      } catch (err) {
        results.push({ path: p, error: err.message });
      }
    }
    return { results };
  }

  /**
   * Rename one entry inside its folder. A file keeps its extension, so it stays a file Foundry accepts.
   * @param {string} clientPath
   * @param {string} name  The new, decoded name.
   */
  async rename(clientPath, name) {
    const entry = this.#entry(clientPath);
    const problem = nameProblem(name);
    if ( problem ) throw new PathError(problem);
    if ( !entry.isDir ) {
      const before = path.extname(entry.segments.at(-1)).toLowerCase();
      if ( path.extname(name).toLowerCase() !== before ) throw new PathError(`The file must keep its ${before || "missing"} extension.`);
    }
    const segments = [...entry.segments.slice(0, -1), name];
    const renameProblem = entryProblem(segments, { isDir: entry.isDir });
    if ( renameProblem ) throw new PathError(renameProblem, 403);
    const dest = path.join(path.dirname(entry.abs), name);
    // A case-only rename is the same entry on case-insensitive disks.
    if ( (dest.toLowerCase() !== entry.abs.toLowerCase()) && fs.existsSync(dest) ) {
      throw new PathError(`${name} already exists here.`, 409);
    }
    await fs.promises.rename(entry.abs, dest);
    return { from: clientPath, to: encodePath(segments.join("/")) };
  }

  /**
   * Move entries into another folder. Never overwrites; a clash fails that one entry.
   * @param {string[]} paths
   * @param {string} toDir
   */
  async move(paths, toDir) {
    if ( !Array.isArray(paths) || !paths.length ) throw new PathError("Nothing to move.");
    const results = [];
    for ( const p of nested(paths) ) {
      try {
        const entry = this.#entry(p);
        const target = this.#container(toDir, { isDir: entry.isDir });
        const dest = path.join(target.abs, path.basename(entry.abs));
        if ( dest === entry.abs ) throw new PathError("It is already in that folder.");
        if ( entry.isDir && (dest + path.sep).startsWith(entry.abs + path.sep) ) {
          throw new PathError("A folder can't be moved into itself.");
        }
        if ( fs.existsSync(dest) ) throw new PathError(`${path.basename(dest)} already exists there.`, 409);
        await moveEntry(entry.abs, dest);
        results.push({ path: p, to: encodePath([...target.segments, path.basename(dest)].join("/")) });
      } catch (err) {
        results.push({ path: p, error: err.message });
      }
    }
    return { results };
  }

  /* -------------------------------------------- */
  /*  Trash                                       */
  /* -------------------------------------------- */

  /** Move an entry into a new trash slot with a manifest. */
  async #toTrash(entry) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const slot = path.join(this.trash, id);
    await fs.promises.mkdir(slot, { recursive: true });
    const size = entry.isDir ? folderSize(entry.abs) : entry.stat.size;
    const manifest = {
      id,
      path: encodePath(entry.segments.join("/")),
      name: entry.segments.at(-1),
      isDir: entry.isDir,
      size,
      deletedAt: Date.now()
    };
    try {
      await moveEntry(entry.abs, path.join(slot, "item"));
    } catch (err) {
      await fs.promises.rm(slot, { recursive: true, force: true });
      throw err;
    }
    await fs.promises.writeFile(path.join(slot, "manifest.json"), JSON.stringify(manifest, null, 2));
    return id;
  }

  /** Everything in the trash, newest first. */
  trashList() {
    if ( !fs.existsSync(this.trash) ) return { items: [] };
    const items = [];
    for ( const id of fs.readdirSync(this.trash) ) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(this.trash, id, "manifest.json"), "utf8"));
        if ( fs.existsSync(path.join(this.trash, id, "item")) ) items.push({ ...manifest, id });
      } catch {
        // A slot without a readable manifest is left alone.
      }
    }
    items.sort((a, b) => b.deletedAt - a.deletedAt);
    return { items };
  }

  /**
   * Put trashed entries back where they were. A name taken in the meantime gets " (restored)".
   * The original folder is re-created when it was deleted too.
   * @param {string[]} ids
   */
  async trashRestore(ids) {
    if ( !Array.isArray(ids) || !ids.length ) throw new PathError("Nothing to restore.");
    const results = [];
    for ( const id of ids ) {
      try {
        const slot = this.#slot(id);
        const manifest = JSON.parse(fs.readFileSync(path.join(slot, "manifest.json"), "utf8"));
        const segments = toSegments(manifest.path);
        const parent = segments.slice(0, -1);
        const problem = containerProblem(parent, { isDir: manifest.isDir });
        if ( problem ) throw new PathError(problem, 403);
        const parentInfo = resolveReal(this.root, parent, { mustExist: false });
        await fs.promises.mkdir(parentInfo.abs, { recursive: true });
        const name = freeName(parentInfo.abs, segments.at(-1));
        await moveEntry(path.join(slot, "item"), path.join(parentInfo.abs, name));
        await fs.promises.rm(slot, { recursive: true, force: true });
        results.push({ id, path: encodePath([...parent, name].join("/")) });
      } catch (err) {
        results.push({ id, error: err.message });
      }
    }
    return { results };
  }

  /**
   * Delete trashed entries for good: the given ids, or everything.
   * @param {string[]} [ids]
   */
  async trashEmpty(ids) {
    const all = !ids;
    const list = all ? this.trashList().items.map(i => i.id) : ids;
    if ( !Array.isArray(list) ) throw new PathError("ids must be an array.");
    let removed = 0;
    for ( const id of list ) {
      await fs.promises.rm(this.#slot(id), { recursive: true, force: true });
      removed++;
    }
    return { removed };
  }

  /** The folder of a trash slot, refusing anything that isn't a plain slot id. */
  #slot(id) {
    if ( typeof id !== "string" || !/^\d+-[0-9a-f]{8}$/.test(id) ) throw new PathError(`Unknown trash item ${id}.`, 404);
    const slot = path.join(this.trash, id);
    if ( !fs.existsSync(slot) ) throw new PathError(`Unknown trash item ${id}.`, 404);
    return slot;
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Drop paths inside another listed folder: deleting or moving the folder takes them along,
 * and handling them first would break the folder's own move.
 */
export function nested(paths) {
  const unique = [...new Set(paths.map(p => String(p).replace(/^\/+|\/+$/g, "")))];
  return unique.filter(p => !unique.some(o => (o !== p) && p.startsWith(`${o}/`)));
}

/** Rename, falling back to copy + delete across file systems. */
async function moveEntry(from, to) {
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ( err.code !== "EXDEV" ) throw err;
    await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fs.promises.rm(from, { recursive: true, force: true });
  }
}

function folderSize(dir) {
  let total = 0;
  for ( const e of fs.readdirSync(dir, { withFileTypes: true }) ) {
    const abs = path.join(dir, e.name);
    if ( e.isSymbolicLink() ) continue;
    if ( e.isDirectory() ) total += folderSize(abs);
    else total += fs.statSync(abs).size;
  }
  return total;
}

/** `name`, or `name (restored).ext`, `name (restored 2).ext`… whichever is free in `dir`. */
export function freeName(dir, name) {
  if ( !fs.existsSync(path.join(dir, name)) ) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for ( let i = 1; ; i++ ) {
    const candidate = `${base} (restored${i > 1 ? ` ${i}` : ""})${ext}`;
    if ( !fs.existsSync(path.join(dir, candidate)) ) return candidate;
  }
}
