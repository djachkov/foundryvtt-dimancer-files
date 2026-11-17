/**
 * Uploading several files, or whole folders, with progress and a choice for names that already exist.
 * Goes through core's FilePicker.upload / createDirectory, so it follows the server's rules.
 */
import { extension, uniqueName } from "./listing.mjs";
import { encodePath } from "./usage-core.mjs";

const { DialogV2 } = foundry.applications.api;
const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/**
 * @typedef {{file: File, dir: string[]}} UploadEntry  A file and its sub-folder (decoded segments).
 */

/**
 * Files from a drop, walking dropped folders. Call it straight from the drop handler:
 * the entries must be taken before anything awaits.
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<UploadEntry[]>}
 */
export function filesFromDrop(dataTransfer) {
  const roots = [...(dataTransfer.items ?? [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const plain = [...(dataTransfer.files ?? [])];
  if ( !roots.length ) return Promise.resolve(plain.map(file => ({ file, dir: [] })));
  const out = [];
  const walk = async (entry, dir) => {
    if ( entry.isFile ) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, dir });
    }
    else if ( entry.isDirectory ) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for ( const child of batch ) await walk(child, [...dir, entry.name]);
      } while ( batch.length );
    }
  };
  return (async () => {
    for ( const root of roots ) await walk(root, []);
    return out;
  })();
}

/** Files from an <input type="file">, keeping sub-folders of a folder upload. */
export function filesFromInput(fileList) {
  return [...(fileList ?? [])].map(file => {
    const parts = (file.webkitRelativePath || file.name).split("/");
    parts.pop();
    return { file, dir: parts };
  });
}

const join = (...parts) => parts.filter(Boolean).join("/");

/**
 * Upload entries into a folder.
 * @param {import("./picker.mjs").default} app
 * @param {UploadEntry[]} entries
 * @param {string} targetDir  Client path (encoded).
 * @returns {Promise<string[]>}  Paths of the uploaded files.
 */
export async function runUploads(app, entries, targetDir) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  const source = app.activeSource;
  const bucket = app.source.bucket;

  // Only types this picker accepts (and the server allows).
  const allowed = new Set(app.extensions.map(e => e.toLowerCase()));
  const rejected = [];
  const accepted = entries.filter(e => {
    if ( allowed.has(`.${extension(e.file.name)}`) ) return true;
    rejected.push(e.file.name);
    return false;
  });
  if ( rejected.length ) {
    ui.notifications.warn(loc("DIMANCER_FILES.Upload.Rejected", {
      n: rejected.length, list: rejected.slice(0, 5).join(", ") + (rejected.length > 5 ? "…" : "")
    }));
  }
  if ( !accepted.length ) return [];

  // Sub-folders first, shallowest first. "Already exists" is fine.
  const dirs = new Set();
  for ( const e of accepted ) for ( let i = 1; i <= e.dir.length; i++ ) dirs.add(e.dir.slice(0, i).join("/"));
  for ( const d of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length) ) {
    try {
      await FP.createDirectory(source, join(targetDir, encodePath(d)), { bucket });
    } catch (err) {
      if ( !/exist/i.test(err.message) ) {
        ui.notifications.error(err.message);
        return [];
      }
    }
  }

  // Names that are already taken, per folder.
  const byFolder = new Map();
  for ( const e of accepted ) {
    const folder = join(targetDir, encodePath(e.dir.join("/")));
    if ( !byFolder.has(folder) ) byFolder.set(folder, []);
    byFolder.get(folder).push(e);
  }
  const taken = new Map();
  const conflicts = [];
  for ( const [folder, list] of byFolder ) {
    const result = await FP.browse(source, folder, { bucket }).catch(() => ({ files: [] }));
    const names = new Set(result.files.map(f => decodeURIComponent(f.split("/").pop())));
    taken.set(folder, names);
    for ( const e of list ) if ( [...names].some(n => n.toLowerCase() === e.file.name.toLowerCase()) ) conflicts.push(e);
  }
  let policy = "replace";
  if ( conflicts.length ) {
    policy = await DialogV2.wait({
      window: { title: "DIMANCER_FILES.Upload.ConflictTitle", icon: "fa-solid fa-clone" },
      position: { width: 460 },
      content: `<p>${loc("DIMANCER_FILES.Upload.Conflict", { n: conflicts.length })}</p><ul class="df-dialog-list">${
        conflicts.slice(0, 10).map(c => `<li>${foundry.utils.escapeHTML(c.file.name)}</li>`).join("")}</ul>`,
      buttons: [
        { action: "keep", label: "DIMANCER_FILES.Upload.KeepBoth", icon: "fa-solid fa-copy", default: true },
        { action: "replace", label: "DIMANCER_FILES.Upload.Replace", icon: "fa-solid fa-file-import" },
        { action: "skip", label: "DIMANCER_FILES.Upload.Skip", icon: "fa-solid fa-forward" }
      ],
      rejectClose: false
    });
    if ( !policy ) return [];
  }

  // Upload one by one with progress in the footer.
  const uploaded = [];
  let failed = 0;
  let index = 0;
  const conflictSet = new Set(conflicts);
  app.uploads = { done: 0, total: accepted.length, name: "" };
  for ( const [folder, list] of byFolder ) {
    const names = taken.get(folder);
    for ( let e of list ) {
      index++;
      let file = e.file;
      if ( conflictSet.has(e) ) {
        if ( policy === "skip" ) continue;
        if ( policy === "keep" ) {
          const name = uniqueName(file.name, names);
          file = new File([file], name, { type: file.type, lastModified: file.lastModified });
        }
      }
      names.add(file.name);
      app.uploads = { done: index - 1, total: accepted.length, name: file.name };
      app.render({ parts: ["footer"] });
      const response = await FP.upload(source, folder, file, { bucket }, { notify: false });
      if ( response?.path ) uploaded.push(response.path);
      else failed++;
    }
  }
  app.uploads = null;
  if ( uploaded.length ) ui.notifications.info(loc("DIMANCER_FILES.Upload.Done", { n: uploaded.length }));
  if ( failed ) ui.notifications.error(loc("DIMANCER_FILES.Upload.Failed", { n: failed }));
  return uploaded;
}
