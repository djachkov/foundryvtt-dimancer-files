/**
 * Turning browse results into the rows the picker shows: names, kinds, sorting, filtering, ranges.
 * No Foundry globals, so it is unit-tested.
 */

export const IMAGE_EXT = ["apng", "avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "tiff", "webp"];
export const VIDEO_EXT = ["m4v", "mp4", "ogv", "webm"];
export const AUDIO_EXT = ["aac", "flac", "m4a", "mid", "mp3", "ogg", "opus", "wav"];

const ICONS = {
  folder: "fa-solid fa-folder",
  image: "fa-solid fa-file-image",
  video: "fa-solid fa-file-video",
  audio: "fa-solid fa-file-audio",
  pdf: "fa-solid fa-file-pdf",
  text: "fa-solid fa-file-lines",
  font: "fa-solid fa-font",
  model: "fa-solid fa-cube",
  file: "fa-solid fa-file"
};

function decode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** The last segment of a client path, decoded for display. */
export function baseName(p) {
  return decode(String(p).replace(/\/+$/, "").split("/").pop() ?? "");
}

/** The folder part of a client path (still encoded). */
export function dirName(p) {
  const parts = String(p).replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/");
}

export function extension(p) {
  const name = baseName(p).toLowerCase().split("?")[0];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** "image", "video", "audio", "pdf", "text", "font", "model" or "file". */
export function fileKind(p) {
  const ext = extension(p);
  if ( IMAGE_EXT.includes(ext) ) return "image";
  if ( VIDEO_EXT.includes(ext) ) return "video";
  if ( AUDIO_EXT.includes(ext) ) return "audio";
  if ( ext === "pdf" ) return "pdf";
  if ( ["txt", "md", "json", "csv", "xml", "html", "htm", "yaml", "yml"].includes(ext) ) return "text";
  if ( ["otf", "ttf", "woff", "woff2"].includes(ext) ) return "font";
  if ( ["glb", "gltf", "obj", "fbx"].includes(ext) ) return "model";
  return "file";
}

export const iconFor = kind => ICONS[kind] ?? ICONS.file;

/**
 * Rows for a folder listing: folders first, then files.
 * @param {{dirs: string[], files: string[], privateDirs?: string[], private?: boolean}} result
 * @param {Map<string, {size?: number|null, mtime?: number}>} [stats]
 */
export function buildItems(result, stats = new Map()) {
  const privateDirs = new Set(result.privateDirs ?? []);
  const dirs = (result.dirs ?? []).map(path => ({
    path, name: baseName(path), isDir: true, kind: "folder", ext: "",
    private: !!result.private || privateDirs.has(path), ...pickStats(stats.get(path))
  }));
  const files = (result.files ?? []).map(path => ({
    path, name: baseName(path), isDir: false, kind: fileKind(path), ext: extension(path), ...pickStats(stats.get(path))
  }));
  return [...dirs, ...files];
}

function pickStats(s) {
  return { size: s?.size ?? null, mtime: s?.mtime ?? null };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Sort rows. Folders always come first; missing sizes/dates sort last.
 * @param {object[]} items
 * @param {"name"|"type"|"size"|"date"} by
 * @param {1|-1} dir
 */
export function sortItems(items, by = "name", dir = 1) {
  const key = {
    name: () => 0,
    type: (a, b) => collator.compare(a.ext, b.ext),
    size: (a, b) => nullsLast(a.size, b.size, dir),
    date: (a, b) => nullsLast(a.mtime, b.mtime, dir)
  }[by] ?? (() => 0);
  return [...items].sort((a, b) => {
    if ( a.isDir !== b.isDir ) return a.isDir ? -1 : 1;
    const primary = key(a, b);
    if ( primary ) return (by === "size" || by === "date") ? primary : primary * dir;
    return collator.compare(a.name, b.name) * ((by === "name") ? dir : 1);
  });
}

/** Compare numbers with null at the end, whichever the direction. */
function nullsLast(a, b, dir) {
  if ( a === b ) return 0;
  if ( a === null || a === undefined ) return 1;
  if ( b === null || b === undefined ) return -1;
  return (a - b) * dir;
}

/** Rows whose name contains every word of the query (case-insensitive). */
export function filterItems(items, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if ( !words.length ) return items;
  return items.filter(i => {
    const name = i.name.toLowerCase();
    return words.every(w => name.includes(w));
  });
}

/**
 * The paths between two rows, inclusive, in display order: what shift-click selects.
 * @param {string[]} order  Paths in display order.
 */
export function rangeBetween(order, from, to) {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if ( a === -1 || b === -1 ) return [to];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return order.slice(lo, hi + 1);
}

/** Breadcrumbs for a folder: [{label, path}] from the root. */
export function crumbs(target) {
  const parts = String(target ?? "").split("/").filter(Boolean);
  return parts.map((p, i) => ({ label: decode(p), path: parts.slice(0, i + 1).join("/") }));
}

/** A free name in a folder: "a.png", "a (1).png", "a (2).png"… */
export function uniqueName(name, taken) {
  const lower = new Set([...taken].map(n => n.toLowerCase()));
  if ( !lower.has(name.toLowerCase()) ) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for ( let i = 1; ; i++ ) {
    const candidate = `${base} (${i})${ext}`;
    if ( !lower.has(candidate.toLowerCase()) ) return candidate;
  }
}
