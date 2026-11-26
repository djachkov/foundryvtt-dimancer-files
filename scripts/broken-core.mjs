/**
 * Finding broken file links: pulling media paths out of document data, and suggesting which existing
 * file a missing one became (converted to another format, moved, renamed folder, changed case).
 * No Foundry globals here, so it is unit-tested.
 */
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, fileKind } from "./listing.mjs";

/** Extensions treated as file links. Others (html, js, json…) aren't, to avoid matching plain text. */
export const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT, "pdf", "webm", "otf", "ttf", "woff", "woff2"]);

/** Data folders whose files the scan doesn't list: package code and Foundry's databases. */
export function unlistedFolder(segments) {
  const [top, , sub] = segments;
  if ( (top === "modules") || (top === "systems") ) return true;
  return (top === "worlds") && ((sub === "data") || (sub === "packs"));
}

function decode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

const extOf = name => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
const stemOf = name => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * One reference as found in data, as a decoded Data-relative path; null when it isn't a local media
 * path (external URL, data URI, wildcard, template, not a media file).
 * @param {string} raw
 * @param {{origin?: string, prefix?: string}} [site]  This site's origin and route prefix (no slashes).
 */
export function normalizeRef(raw, { origin = "", prefix = "" } = {}) {
  let s = String(raw).trim();
  if ( !s || (s.length > 1024) || /[\n<>"]/.test(s) || s.startsWith("//") ) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if ( scheme ) {
    if ( !/^https?$/i.test(scheme[1]) || !origin ) return null;
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if ( url.origin !== origin ) return null;
    s = url.pathname;
  }
  s = s.replace(/[?#].*$/, "").replace(/^\/+/, "");
  if ( prefix && s.startsWith(`${prefix}/`) ) s = s.slice(prefix.length + 1);
  // Wildcard token images (tokens/goblin*.png) and template strings aren't single files.
  if ( !s || /[*{}[\]]/.test(s) || s.startsWith("./") ) return null;
  const path = decode(s);
  const segments = path.split("/");
  if ( segments.some(x => !x || (x === "..") || (x === ".")) ) return null;
  if ( !MEDIA_EXT.has(extOf(segments.at(-1))) ) return null;
  return path;
}

/** Attribute values and CSS urls inside HTML or CSS text. */
const IN_MARKUP = [
  /\b(?:src|href|poster|data-src)\s*=\s*(["'])(.*?)\1/gi,
  /url\(\s*(["']?)([^"')]*?)\1\s*\)/gi
];

/** The local media paths in one string: the whole string, or the links inside HTML/CSS. */
export function pathsInString(text, site) {
  if ( !/[<(]/.test(text) ) {
    const p = normalizeRef(text, site);
    return p ? [p] : [];
  }
  const out = [];
  for ( const rx of IN_MARKUP ) {
    for ( const m of text.matchAll(rx) ) {
      const p = normalizeRef(m[2].replace(/&amp;/g, "&"), site);
      if ( p ) out.push(p);
    }
  }
  return out;
}

/**
 * Every local media path inside plain data (a document's toObject(), embedded documents included).
 * @returns {Set<string>}  Decoded Data-relative paths.
 */
export function referencedPaths(value, site, out = new Set()) {
  if ( typeof value === "string" ) {
    for ( const p of pathsInString(value, site) ) out.add(p);
  }
  else if ( Array.isArray(value) ) for ( const v of value ) referencedPaths(v, site, out);
  else if ( value && (typeof value === "object") ) for ( const v of Object.values(value) ) referencedPaths(v, site, out);
  return out;
}

/* -------------------------------------------- */
/*  Suggestions                                 */
/* -------------------------------------------- */

/**
 * An index of existing files for suggestions.
 * @param {string[]} paths  Decoded Data-relative paths of files.
 */
export function buildIndex(paths) {
  const all = new Set(paths);
  const byName = new Map();
  const byStem = new Map();
  const add = (map, key, p) => {
    if ( !map.has(key) ) map.set(key, []);
    map.get(key).push(p);
  };
  for ( const p of all ) {
    const name = p.split("/").pop();
    add(byName, name.toLowerCase(), p);
    add(byStem, stemOf(name).toLowerCase(), p);
  }
  return { all, byName, byStem };
}

/** How many folder names two paths share, as a tie-breaker (the deeper the match, the likelier). */
function sharedFolders(a, b) {
  const x = a.split("/").slice(0, -1);
  const y = new Set(b.split("/").slice(0, -1));
  return x.filter(s => y.has(s)).length;
}

/**
 * Existing files a missing one may have become, best first.
 * - "case": the same path in another letter case;
 * - "converted": the same name with another extension of the same kind (image, audio…), same folder;
 * - "moved": the same file name in another folder (moved, or its folder renamed);
 * - "movedConverted": the same name with another extension, in another folder.
 * @param {string} missing  Decoded Data-relative path.
 * @param {ReturnType<buildIndex>} index
 * @returns {{path: string, reason: string, score: number}[]}
 */
export function suggest(missing, index) {
  const parts = missing.split("/");
  const name = parts.pop();
  const folder = parts.join("/");
  const kind = fileKind(name);
  const found = new Map();
  const offer = (path, reason, score) => {
    if ( path === missing ) return;
    const best = found.get(path);
    if ( !best || (best.score < score) ) found.set(path, { path, reason, score });
  };
  for ( const p of index.byName.get(name.toLowerCase()) ?? [] ) {
    const sameFolder = p.slice(0, p.lastIndexOf("/") + 1) === (folder ? `${folder}/` : "");
    if ( p.toLowerCase() === missing.toLowerCase() ) offer(p, "case", 95);
    else if ( !sameFolder ) offer(p, "moved", 60 + Math.min(sharedFolders(missing, p), 10));
  }
  for ( const p of index.byStem.get(stemOf(name).toLowerCase()) ?? [] ) {
    if ( extOf(p) === extOf(name) ) continue;
    if ( fileKind(p) !== kind ) continue;
    const sameFolder = p.slice(0, p.lastIndexOf("/") + 1).toLowerCase() === (folder ? `${folder}/` : "").toLowerCase();
    if ( sameFolder ) offer(p, "converted", 90 + (extOf(p) === "webp" ? 1 : 0));
    else offer(p, "movedConverted", 40 + Math.min(sharedFolders(missing, p), 10));
  }
  return [...found.values()].sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
}

/** The suggestion to preselect: the best one, only when nothing ties with it. */
export function bestSuggestion(suggestions) {
  const [first, second] = suggestions;
  if ( !first ) return null;
  return (second && (second.score === first.score)) ? null : first;
}
