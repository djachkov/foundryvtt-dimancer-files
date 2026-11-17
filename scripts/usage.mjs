/**
 * Which documents use a file, and rewriting those references after a move or rename. GM only.
 */
import { changedKeys, pathMatcher, rewriteValue } from "./usage-core.mjs";

/** Every world document collection, including world settings (module settings can hold paths). */
function worldCollections() {
  const collections = new Set(game.collections.values());
  const settings = game.settings.storage.get("world");
  if ( settings ) collections.add(settings);
  return [...collections];
}

/**
 * Documents to scan: the world, and with `compendia` every compendium's documents too.
 * @param {{compendia?: boolean}} [options]
 */
async function documents({ compendia = false } = {}) {
  const docs = [];
  for ( const c of worldCollections() ) docs.push(...c.contents);
  if ( compendia ) {
    for ( const pack of game.packs ) {
      try {
        docs.push(...await pack.getDocuments());
      } catch (err) {
        console.warn(`dimancer_files | couldn't read ${pack.collection}`, err);
      }
    }
  }
  return docs;
}

/** A label for a document in lists: "Scene: Castle". */
export function describe(doc) {
  const type = game.i18n.localize(doc.constructor.metadata.label);
  const name = doc.name ?? doc.key ?? doc.id;
  return doc.pack ? `${type}: ${name} (${doc.pack})` : `${type}: ${name}`;
}

/**
 * Documents (top-level, embedded ones count towards their parent) that use any of these paths.
 * @param {{path: string, isDir?: boolean}[]} targets  Client paths.
 * @param {{compendia?: boolean}} [options]
 * @returns {Promise<{uuid: string, label: string, doc: foundry.abstract.Document}[]>}
 */
export async function findUsages(targets, options = {}) {
  const matcher = pathMatcher(targets);
  if ( !matcher ) return [];
  const found = [];
  for ( const doc of await documents(options) ) {
    let text;
    try {
      text = JSON.stringify(doc.toObject());
    } catch {
      continue;
    }
    if ( matcher.test(text) ) found.push({ uuid: doc.uuid, label: describe(doc), doc });
  }
  return found;
}

/**
 * Rewrite paths in a document and its embedded documents (tiles, tokens and their deltas, pages, items…).
 * Each document only updates its own fields, so embedded collections are never replaced wholesale.
 * @returns {Promise<number>}  How many documents changed.
 */
async function rewriteDocument(doc, moves) {
  let count = 0;
  const hierarchy = doc.constructor.hierarchy ?? {};
  const own = doc.toObject();
  for ( const key of Object.keys(hierarchy) ) delete own[key];
  const changes = changedKeys(own, rewriteValue(own, moves));
  if ( !foundry.utils.isEmpty(changes) ) {
    await doc.update(changes, { dimancerFiles: true });
    count++;
  }
  for ( const key of Object.keys(hierarchy) ) {
    const value = doc[key];
    if ( !value ) continue;
    const children = value instanceof foundry.abstract.Document ? [value] : (value.contents ?? []);
    for ( const child of children ) count += await rewriteDocument(child, moves);
  }
  return count;
}

/**
 * Point every reference to moved files at their new paths.
 * Locked compendia are skipped and reported.
 * @param {{from: string, to: string, isDir?: boolean}[]} moves
 * @param {{compendia?: boolean}} [options]
 * @returns {Promise<{documents: number, updated: number, failed: string[], locked: string[]}>}
 */
export async function rewriteReferences(moves, options = {}) {
  const usages = await findUsages(moves.map(m => ({ path: m.from, isDir: m.isDir })), options);
  const result = { documents: usages.length, updated: 0, failed: [], locked: [] };
  for ( const { doc, label } of usages ) {
    if ( doc.pack && game.packs.get(doc.pack)?.locked ) {
      result.locked.push(label);
      continue;
    }
    try {
      result.updated += await rewriteDocument(doc, moves);
    } catch (err) {
      console.error(`dimancer_files | couldn't update ${doc.uuid}`, err);
      result.failed.push(label);
    }
  }
  return result;
}
