/**
 * Finding and rewriting file paths inside document data. No Foundry globals here, so it is unit-tested.
 *
 * Documents store paths the way they were picked: usually URL-encoded per segment (what the
 * FilePicker returns), sometimes decoded (typed by hand), sometimes with a leading "/" or a full URL.
 * Both spellings are matched, at a path boundary, so "maps/a.png" doesn't match "old-maps/a.png" and
 * "a.png" doesn't match "a.png.bak".
 */

/**
 * What may precede a path inside a string: the start, a quote, space, "(" or "=" (each optionally
 * followed by "/"), or the host of a full URL. Not any "/", or "maps/a.png" would match "old/maps/a.png".
 */
const BEFORE = String.raw`(^\/?|[\s"'(=]\/?|:\/\/[^\/\s"'()]+\/)`;
/** After a file path: anything that can't continue a file name. */
const AFTER_FILE = String.raw`(?=$|[^\w.\-%])`;

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function decode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** Encode per segment like Foundry's `encodeURL`. */
export function encodePath(p) {
  return p.split("/").map(s => encodeURIComponent(s).replace(/'/g, "%27")).join("/");
}

/** The spellings of a client path that may appear in data: encoded and decoded (deduplicated). */
export function spellings(clientPath) {
  const clean = String(clientPath).replace(/^\/+|\/+$/g, "");
  const decoded = decode(clean);
  return [...new Set([encodePath(decoded), decoded, clean])];
}

/**
 * A matcher for a set of paths.
 * @param {{path: string, isDir?: boolean}[]} targets
 * @returns {{test: (text: string) => boolean, regex: RegExp}|null}
 */
export function pathMatcher(targets) {
  const parts = [];
  for ( const { path, isDir } of targets ) {
    for ( const s of spellings(path) ) {
      if ( !s ) continue;
      parts.push(isDir ? `${escapeRegExp(s)}/` : `${escapeRegExp(s)}${AFTER_FILE}`);
    }
  }
  if ( !parts.length ) return null;
  const source = `${BEFORE}(?:${parts.join("|")})`;
  return { regex: new RegExp(source), test: text => new RegExp(source).test(text) };
}

/**
 * Replace paths in a string. A folder rename rewrites every path below it.
 * The replacement keeps the spelling it found (encoded stays encoded).
 * @param {string} text
 * @param {{from: string, to: string, isDir?: boolean}[]} moves
 * @returns {string}
 */
export function rewriteString(text, moves) {
  let out = text;
  for ( const { from, to, isDir } of moves ) {
    const fromDecoded = decode(from.replace(/^\/+|\/+$/g, ""));
    const toDecoded = decode(to.replace(/^\/+|\/+$/g, ""));
    // Both spellings in one pass, so a folder moved into itself ("a" → "a/old") isn't rewritten twice.
    // When both spellings of the old path are the same, the encoded new path wins: that is what
    // Foundry's picker would have stored.
    const map = new Map([[fromDecoded, toDecoded], [encodePath(fromDecoded), encodePath(toDecoded)]]);
    const alternatives = [...map.keys()].sort((x, y) => y.length - x.length).map(escapeRegExp).join("|");
    const rx = new RegExp(`${BEFORE}(${alternatives})${isDir ? "/" : AFTER_FILE}`, "g");
    out = out.replace(rx, (_m, before, found) => `${before}${map.get(found)}${isDir ? "/" : ""}`);
  }
  return out;
}

/**
 * Rewrite every string inside plain data. Returns the same object when nothing changed.
 * @template T
 * @param {T} value
 * @param {{from: string, to: string, isDir?: boolean}[]} moves
 * @returns {T}
 */
export function rewriteValue(value, moves) {
  if ( typeof value === "string" ) return rewriteString(value, moves);
  if ( Array.isArray(value) ) {
    let changed = false;
    const out = value.map(v => {
      const r = rewriteValue(v, moves);
      if ( r !== v ) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if ( value && (typeof value === "object") ) {
    let changed = false;
    const out = {};
    for ( const [k, v] of Object.entries(value) ) {
      const r = rewriteValue(v, moves);
      if ( r !== v ) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * Only the changed top-level keys of a rewrite, for a document update.
 * @param {object} before
 * @param {object} after
 * @returns {object}
 */
export function changedKeys(before, after) {
  const changes = {};
  for ( const [k, v] of Object.entries(after) ) {
    if ( v !== before[k] ) changes[k] = v;
  }
  return changes;
}
