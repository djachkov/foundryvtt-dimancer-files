/**
 * Converting images to WebP, in the GM's browser.
 *
 * Each image is decoded and re-encoded with an OffscreenCanvas, and the .webp is saved next to it
 * through Foundry's own upload. Then the documents that used the original are pointed at the WebP
 * (the same rewrite as a rename), and the original goes to the companion's trash, so it can be
 * restored. The companion never sees image contents. Animated images are skipped: a canvas keeps
 * only their first frame.
 */
import { companion } from "./companion-client.mjs";
import { CONVERTIBLE_EXT, isAnimated, isConvertible, planConversions, savings } from "./convert-core.mjs";
import { baseName, dirName, extension } from "./listing.mjs";
import { nameList, report, rewrite, scan, usageList } from "./operations-ui.mjs";
import { saveUiPrefs, uiPrefs } from "./settings.mjs";

const { DialogV2 } = foundry.applications.api;
const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
const esc = s => foundry.utils.escapeHTML(String(s));
const formatSize = n => foundry.utils.formatFileSize(n, { decimalPlaces: 1 });

/** At most this many images per run, and folders walked looking for them. */
const MAX_FILES = 2000;
const MAX_FOLDERS = 500;
export const DEFAULT_QUALITY = 85;

/** Whether this browser's canvas can write WebP (Safari writes PNG instead). Asked once. */
let encoderCheck;
function canEncodeWebp() {
  encoderCheck ??= (async () => {
    try {
      // convertToBlob refuses a canvas without a context.
      const canvas = new OffscreenCanvas(1, 1);
      canvas.getContext("2d").fillRect(0, 0, 1, 1);
      const blob = await canvas.convertToBlob({ type: "image/webp" });
      return blob.type === "image/webp";
    } catch {
      return false;
    }
  })();
  return encoderCheck;
}

/** Whether "Convert to WebP" fits these entries: a GM on User Data, and a folder or an image among them. */
export function canConvert(app, paths) {
  if ( !game.user.isGM || (app.activeSource !== "data") || (game.user.can("FILES_UPLOAD") === false) ) return false;
  return paths.some(p => app.entryInfo(p).isDir || isConvertible(p));
}

/* -------------------------------------------- */
/*  Finding the images                          */
/* -------------------------------------------- */

const FP = () => foundry.applications.apps.FilePicker.implementation;

/** Decoded names in a folder listing. */
const namesOf = files => new Set(files.map(f => baseName(f)));

/**
 * The images to convert among the entries, walking folders, and every name in their folders.
 * @returns {Promise<{files: string[], taken: Map<string, Set<string>>, truncated: boolean}>}
 */
async function collect(targets) {
  const files = [];
  const taken = new Map();
  let truncated = false;
  const listing = async folder => {
    if ( !taken.has(folder) ) {
      const result = await FP().browse("data", folder).catch(() => ({ files: [], dirs: [] }));
      taken.set(folder, namesOf(result.files ?? []));
      return result;
    }
    return null;
  };
  const queue = [];
  for ( const t of targets ) {
    if ( t.isDir ) queue.push(t.path);
    else if ( isConvertible(t.path) ) {
      files.push(t.path);
      await listing(dirName(t.path));
    }
  }
  let walked = 0;
  while ( queue.length && !truncated ) {
    const folder = queue.shift();
    if ( ++walked > MAX_FOLDERS ) {
      truncated = true;
      break;
    }
    const result = await listing(folder);
    if ( !result ) continue;
    queue.push(...(result.dirs ?? []));
    for ( const f of result.files ?? [] ) {
      if ( !isConvertible(f) ) continue;
      if ( files.length >= MAX_FILES ) {
        truncated = true;
        break;
      }
      files.push(f);
    }
  }
  return { files: [...new Set(files)], taken, truncated };
}

/* -------------------------------------------- */
/*  Encoding                                    */
/* -------------------------------------------- */

/**
 * Fetch an image and encode it as WebP.
 * @returns {Promise<{blob?: Blob, before: number, animated?: boolean}>}
 */
async function encode(path, quality) {
  const response = await fetch(foundry.utils.getRoute(path), { cache: "no-store" });
  if ( !response.ok ) throw new Error(`HTTP ${response.status}`);
  const source = await response.blob();
  const bytes = new Uint8Array(await source.arrayBuffer());
  if ( isAnimated(bytes, extension(path)) ) return { before: source.size, animated: true };
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: quality / 100 });
    if ( blob.type !== "image/webp" ) throw new Error(loc("DIMANCER_FILES.Convert.Unsupported"));
    return { blob, before: source.size };
  } finally {
    bitmap.close();
  }
}

/* -------------------------------------------- */
/*  The flow                                    */
/* -------------------------------------------- */

async function askOptions({ files, truncated, usages, quality }) {
  const usageHTML = usages.length ? `<div class="df-usage-box">
      <p>${loc("DIMANCER_FILES.UsedBy", { n: usages.length })}</p>${await usageList(usages)}
      <label class="df-check"><input type="checkbox" name="rewrite" checked> ${loc("DIMANCER_FILES.Convert.Rewrite")}</label>
    </div>` : "";
  const trashHTML = companion.available
    ? `<label class="df-check"><input type="checkbox" name="trash" checked> ${loc("DIMANCER_FILES.Convert.Trash")}</label>
       <p class="hint">${loc("DIMANCER_FILES.Convert.TrashHint")}</p>`
    : `<p class="hint">${loc("DIMANCER_FILES.Convert.KeepHint")}</p>`;
  const result = await DialogV2.wait({
    window: { title: "DIMANCER_FILES.Convert.Title", icon: "fa-solid fa-file-image" },
    position: { width: 520 },
    content: `<p>${loc("DIMANCER_FILES.Convert.Prompt", { n: files.length })}</p>${nameList(files)}
      ${truncated ? `<p class="hint df-warning">${loc("DIMANCER_FILES.Convert.Truncated", { n: MAX_FILES })}</p>` : ""}
      <div class="form-group"><label>${loc("DIMANCER_FILES.Convert.Quality")}</label>
        <div class="form-fields"><range-picker name="quality" value="${quality}" min="50" max="100" step="1"></range-picker></div>
        <p class="hint">${loc("DIMANCER_FILES.Convert.QualityHint")}</p></div>
      ${usageHTML}${trashHTML}
      <p class="hint">${loc("DIMANCER_FILES.Convert.Skips")}</p>`,
    buttons: [
      { action: "ok", label: "DIMANCER_FILES.Convert.Button", icon: "fa-solid fa-wand-magic-sparkles", default: true,
        callback: (_e, button) => {
          const data = new foundry.applications.ux.FormDataExtended(button.form).object;
          return { quality: Number(data.quality) || DEFAULT_QUALITY, rewrite: !!data.rewrite, trash: !!data.trash };
        } },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });
  return (result && (result !== "cancel")) ? result : null;
}

async function showSummary(outcome) {
  const { converted, larger, animated, clashes, failed, trashed, originals } = outcome;
  const total = savings(converted);
  const rows = [];
  if ( converted.length ) {
    rows.push(loc("DIMANCER_FILES.Convert.Converted", { n: converted.length, before: formatSize(total.before),
      after: formatSize(total.after), percent: total.percent }));
  }
  else rows.push(loc("DIMANCER_FILES.Convert.NoneConverted"));
  if ( larger.length ) rows.push(loc("DIMANCER_FILES.Convert.Larger", { n: larger.length }));
  if ( animated.length ) rows.push(loc("DIMANCER_FILES.Convert.Animated", { n: animated.length }));
  if ( clashes.length ) rows.push(loc("DIMANCER_FILES.Convert.Clashes", { n: clashes.length }));
  if ( failed.length ) rows.push(loc("DIMANCER_FILES.Convert.Failed", { n: failed.length }));
  if ( converted.length ) rows.push(loc(`DIMANCER_FILES.Convert.Originals${originals}`, { n: trashed }));
  const failures = failed.length ? `<ul class="df-dialog-list">${failed.slice(0, 12)
    .map(f => `<li>${esc(decodeURIComponent(f.path))}: ${esc(f.error)}</li>`).join("")}</ul>` : "";
  return DialogV2.prompt({
    window: { title: "DIMANCER_FILES.Convert.Title", icon: "fa-solid fa-file-image" },
    position: { width: 480 },
    content: `<ul class="df-summary-list">${rows.map(r => `<li>${r}</li>`).join("")}</ul>${failures}`,
    ok: { label: "DIMANCER_FILES.Ok" },
    rejectClose: false
  });
}

/**
 * Convert images (and the images in folders, below them too) to WebP.
 * @param {import("./picker.mjs").default} app
 * @param {string[]} paths  Client paths of files and folders.
 */
export async function convertToWebp(app, paths) {
  if ( !canConvert(app, paths) || app.uploads ) return;
  if ( !await canEncodeWebp() ) return ui.notifications.error(loc("DIMANCER_FILES.Convert.Unsupported"));

  const { files, taken, truncated } = await collect(paths.map(p => app.entryInfo(p)));
  if ( !files.length ) {
    return ui.notifications.info(loc("DIMANCER_FILES.Convert.Nothing", { list: CONVERTIBLE_EXT.join(", ") }));
  }
  const usages = await scan(files.map(path => ({ path, isDir: false })));
  const options = await askOptions({ files, truncated, usages, quality: uiPrefs().webpQuality ?? DEFAULT_QUALITY });
  if ( !options ) return;
  await saveUiPrefs({ webpQuality: options.quality });

  const outcome = { converted: [], larger: [], animated: [], clashes: [], failed: [], trashed: 0, originals: "Kept" };
  const plan = planConversions(files, taken);
  app.convertStop = false;
  let done = 0;
  for ( const step of plan ) {
    if ( app.convertStop ) break;
    app.uploads = { done: done++, total: plan.length, name: baseName(step.path), convert: true };
    app.render({ parts: ["footer"] });
    if ( step.clash ) {
      outcome.clashes.push(step);
      continue;
    }
    try {
      const encoded = await encode(step.path, options.quality);
      if ( encoded.animated ) {
        outcome.animated.push(step);
        continue;
      }
      // Only worth it when it saves something; the original stays as it is otherwise.
      if ( encoded.blob.size >= encoded.before ) {
        outcome.larger.push(step);
        continue;
      }
      const file = new File([encoded.blob], step.name, { type: "image/webp" });
      const response = await FP().upload("data", step.folder, file, {}, { notify: false });
      if ( !response?.path ) throw new Error(loc("DIMANCER_FILES.Convert.UploadFailed"));
      outcome.converted.push({ ...step, to: response.path, before: encoded.before, after: encoded.blob.size });
    } catch (err) {
      console.error(`dimancer_files | couldn't convert ${step.path}`, err);
      outcome.failed.push({ ...step, error: err.message });
    }
  }
  const stopped = app.convertStop && (done < plan.length);
  app.uploads = null;
  app.convertStop = false;

  // Point documents at the WebP files, then trash the originals, unless a document still uses them.
  const moves = outcome.converted.map(c => ({ from: c.path, to: c.to, isDir: false }));
  let rewriteProblem = false;
  if ( moves.length && usages.length && options.rewrite ) {
    const result = await rewrite(moves);
    rewriteProblem = !!(result.failed.length || result.locked.length);
  }
  const docsSafe = !usages.length || (options.rewrite && !rewriteProblem);
  if ( moves.length && options.trash && companion.available && docsSafe ) {
    try {
      const { results } = await companion.request("delete", { paths: moves.map(m => m.from) });
      outcome.trashed = report(results).length;
      outcome.originals = "Trashed";
    } catch (err) {
      ui.notifications.error(err.message);
    }
  }
  else if ( moves.length && options.trash && rewriteProblem ) outcome.originals = "KeptInUse";

  if ( stopped ) ui.notifications.warn(loc("DIMANCER_FILES.Convert.Stopped", { n: done, total: plan.length }));
  const here = outcome.converted.filter(c => dirName(c.to) === app.target).map(c => c.to);
  if ( here.length ) {
    app.selection = new Set(here);
    app.anchor = here[0];
  }
  await app.refresh();
  return showSummary(outcome);
}
