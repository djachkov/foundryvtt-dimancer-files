/**
 * The parts of WebP conversion that don't need a browser or Foundry: which files qualify, what the
 * new names are, and spotting animated images a canvas would flatten. Unit-tested.
 */

/** Extensions the browser can decode and WebP usually beats. AVIF and SVG are left alone. */
export const CONVERTIBLE_EXT = ["png", "jpg", "jpeg", "gif", "bmp"];

/**
 * Data folders never converted. Package files are replaced on update and their compendiums are
 * locked, so a conversion there would neither stick nor rewrite.
 */
export const SKIPPED_ROOTS = ["modules", "systems"];

function decode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a client path is a file this converts (by extension and location). */
export function isConvertible(clientPath) {
  const clean = String(clientPath).replace(/^\/+/, "");
  if ( SKIPPED_ROOTS.includes(clean.split("/")[0]) ) return false;
  return CONVERTIBLE_EXT.includes(extOf(decode(clean.split("/").pop() ?? "").split("?")[0]));
}

/** "My Map.png" → "My Map.webp" (decoded names). */
export function webpName(name) {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.webp`;
}

/**
 * Pair each file with its WebP name, refusing names already taken in its folder (on disk, or by an
 * earlier file of the same batch: "a.png" and "a.jpg" can't both become "a.webp").
 * @param {string[]} paths  Client paths of files.
 * @param {Map<string, Set<string>>} taken  Encoded folder → decoded file names in it (any case).
 * @returns {{path: string, folder: string, name: string, clash: boolean}[]}
 */
export function planConversions(paths, taken) {
  const lower = new Map();
  for ( const [folder, names] of taken ) lower.set(folder, new Set([...names].map(n => n.toLowerCase())));
  return [...new Set(paths)].map(path => {
    const parts = path.split("/");
    const name = webpName(decode(parts.pop()));
    const folder = parts.join("/");
    if ( !lower.has(folder) ) lower.set(folder, new Set());
    const names = lower.get(folder);
    const clash = names.has(name.toLowerCase());
    names.add(name.toLowerCase());
    return { path, folder, name, clash };
  });
}

/* -------------------------------------------- */
/*  Animation                                   */
/* -------------------------------------------- */

/** An APNG has an acTL chunk before its first IDAT. */
export function pngIsAnimated(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if ( (bytes.length < 8) || sig.some((b, i) => bytes[i] !== b) ) return false;
  let i = 8;
  while ( i + 8 <= bytes.length ) {
    const length = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if ( type === "acTL" ) return true;
    if ( (type === "IDAT") || (type === "IEND") ) return false;
    i += 12 + length;
  }
  return false;
}

/** Skip GIF data sub-blocks starting at i; returns the index after the terminator. */
function skipSubBlocks(bytes, i) {
  while ( i < bytes.length ) {
    const size = bytes[i++];
    if ( size === 0 ) break;
    i += size;
  }
  return i;
}

/** How many frames a GIF has, counting up to `stopAt`. */
export function gifFrameCount(bytes, stopAt = 2) {
  const head = String.fromCharCode(...bytes.slice(0, 3));
  if ( (head !== "GIF") || (bytes.length < 13) ) return 0;
  let i = 13;
  const flags = bytes[10];
  if ( flags & 0x80 ) i += 3 * (1 << ((flags & 7) + 1));
  let frames = 0;
  while ( i < bytes.length ) {
    const block = bytes[i];
    if ( block === 0x3b ) break; // trailer
    if ( block === 0x21 ) i = skipSubBlocks(bytes, i + 2); // extension: introducer, label, sub-blocks
    else if ( block === 0x2c ) { // image descriptor
      if ( ++frames >= stopAt ) return frames;
      const local = bytes[i + 9];
      i += 10;
      if ( local & 0x80 ) i += 3 * (1 << ((local & 7) + 1));
      i = skipSubBlocks(bytes, i + 1); // LZW minimum code size, then the image data
    }
    else break;
  }
  return frames;
}

/** Whether an image has frames a canvas would drop. */
export function isAnimated(bytes, ext) {
  if ( ext === "gif" ) return gifFrameCount(bytes) > 1;
  if ( (ext === "png") || (ext === "apng") ) return pngIsAnimated(bytes);
  return false;
}

/** Totals for the summary: bytes before and after, and the share saved (0–100). */
export function savings(converted) {
  const before = converted.reduce((s, c) => s + c.before, 0);
  const after = converted.reduce((s, c) => s + c.after, 0);
  return { before, after, percent: before ? Math.round((1 - (after / before)) * 100) : 0 };
}
