/**
 * Dialogs and flows for the file changes the companion makes: delete, rename, move, trash, usages.
 */
import { companion } from "./companion-client.mjs";
import CompanionConfig from "./companion-config.mjs";
import { baseName } from "./listing.mjs";
import { SETTINGS, setting } from "./settings.mjs";
import { encodePath } from "./usage-core.mjs";
import { findUsages, rewriteReferences } from "./usage.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = s => foundry.utils.escapeHTML(String(s));
const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** How many names or documents a dialog lists before "and N more". */
const LIST_MAX = 12;

/* -------------------------------------------- */
/*  Shared bits                                 */
/* -------------------------------------------- */

function nameList(paths) {
  const shown = paths.slice(0, LIST_MAX).map(p => `<li>${esc(decodeURIComponent(p))}</li>`).join("");
  const more = paths.length > LIST_MAX ? `<li class="df-more">${loc("DIMANCER_FILES.AndMore", { n: paths.length - LIST_MAX })}</li>` : "";
  return `<ul class="df-dialog-list">${shown}${more}</ul>`;
}

async function usageList(usages) {
  const TextEditor = foundry.applications.ux.TextEditor.implementation;
  const shown = await Promise.all(usages.slice(0, LIST_MAX).map(async u => {
    const link = await TextEditor.enrichHTML(`@UUID[${u.uuid}]{${u.label.replace(/[{}\]]/g, "")}}`);
    return `<li>${link}</li>`;
  }));
  const more = usages.length > LIST_MAX ? `<li class="df-more">${loc("DIMANCER_FILES.AndMore", { n: usages.length - LIST_MAX })}</li>` : "";
  return `<ul class="df-dialog-list df-usages">${shown.join("")}${more}</ul>`;
}

async function scan(targets) {
  try {
    return await findUsages(targets, { compendia: setting(SETTINGS.scanCompendia) });
  } catch (err) {
    console.error("dimancer_files | usage scan failed", err);
    return [];
  }
}

/** Report per-entry failures from a companion batch; returns the successes. */
function report(results, key = "path") {
  const failed = results.filter(r => r.error);
  for ( const f of failed.slice(0, 5) ) ui.notifications.error(`${baseName(f[key] ?? "")}: ${f.error}`);
  if ( failed.length > 5 ) ui.notifications.error(loc("DIMANCER_FILES.MoreFailed", { n: failed.length - 5 }));
  return results.filter(r => !r.error);
}

async function rewrite(moves) {
  if ( !moves.length ) return;
  const result = await rewriteReferences(moves, { compendia: setting(SETTINGS.scanCompendia) });
  if ( result.updated ) ui.notifications.info(loc("DIMANCER_FILES.Rewrite.Done", { n: result.updated }));
  if ( result.locked.length ) ui.notifications.warn(loc("DIMANCER_FILES.Rewrite.Locked", { list: result.locked.join(", ") }));
  if ( result.failed.length ) ui.notifications.error(loc("DIMANCER_FILES.Rewrite.Failed", { list: result.failed.join(", ") }));
}

export function copyPaths(paths) {
  if ( !paths.length ) return;
  game.clipboard.copyPlainText(paths.join("\n"));
  ui.notifications.info(paths.length === 1
    ? loc("DIMANCER_FILES.Copied", { path: decodeURIComponent(paths[0]) })
    : loc("DIMANCER_FILES.CopiedMany", { n: paths.length }));
}

export function openCompanionConfig() {
  return new CompanionConfig().render({ force: true });
}

/** Ask for a name in a small dialog. */
export async function askName({ title, label, value = "", selectBase = false }) {
  const result = await DialogV2.wait({
    window: { title, icon: "fa-solid fa-i-cursor" },
    position: { width: 420 },
    content: `<div class="form-group"><label>${loc(label)}</label>
      <div class="form-fields"><input type="text" name="name" value="${esc(value)}" required autofocus></div></div>`,
    buttons: [
      { action: "ok", label: "DIMANCER_FILES.Ok", icon: "fa-solid fa-check", default: true,
        callback: (_e, button) => button.form.elements.name.value.trim() },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    render: (_event, dialog) => {
      const input = dialog.element.querySelector("input[name=name]");
      input.focus();
      const dot = value.lastIndexOf(".");
      input.setSelectionRange(0, selectBase && dot > 0 ? dot : value.length);
    },
    rejectClose: false
  });
  return (result && result !== "cancel") ? result : null;
}

/* -------------------------------------------- */
/*  Delete                                      */
/* -------------------------------------------- */

export async function deleteEntries(app, paths) {
  if ( !paths.length || !app.canChange ) return;
  const targets = paths.map(p => app.entryInfo(p));
  const usages = await scan(targets);
  const usageHTML = usages.length ? `<div class="df-usage-box df-warning">
      <p><i class="fa-solid fa-triangle-exclamation"></i> ${loc("DIMANCER_FILES.Delete.InUse", { n: usages.length })}</p>
      ${await usageList(usages)}</div>` : "";
  const choice = await DialogV2.wait({
    window: { title: "DIMANCER_FILES.Delete.Title", icon: "fa-solid fa-trash" },
    position: { width: 480 },
    content: `<p>${loc("DIMANCER_FILES.Delete.Prompt", { n: paths.length })}</p>${nameList(paths)}${usageHTML}
      ${companion.policy.permanent
        ? `<label class="df-check"><input type="checkbox" name="permanent"> ${loc("DIMANCER_FILES.Delete.Permanent")}</label>`
        : `<p class="hint">${loc("DIMANCER_FILES.Delete.TrashOnly")}</p>`}`,
    buttons: [
      { action: "delete", label: "DIMANCER_FILES.Delete.Button", icon: "fa-solid fa-trash", default: true,
        callback: (_e, button) => (button.form.elements.permanent?.checked ? "permanent" : "trash") },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });
  if ( !choice || (choice === "cancel") ) return;
  const permanent = choice === "permanent";
  if ( permanent ) {
    const sure = await DialogV2.confirm({
      window: { title: "DIMANCER_FILES.Delete.PermanentTitle", icon: "fa-solid fa-skull" },
      content: `<p>${loc("DIMANCER_FILES.Delete.PermanentConfirm", { n: paths.length })}</p>`,
      rejectClose: false
    });
    if ( !sure ) return;
  }
  let results;
  try {
    ({ results } = await companion.request("delete", { paths, permanent }));
  } catch (err) {
    return ui.notifications.error(err.message);
  }
  const done = report(results);
  if ( done.length ) {
    ui.notifications.info(loc(permanent ? "DIMANCER_FILES.Delete.DonePermanent" : "DIMANCER_FILES.Delete.DoneTrash",
      { n: done.length }));
  }
  for ( const d of done ) {
    app.selection.delete(d.path);
    if ( targets.find(t => t.path === d.path)?.isDir ) app.retarget(d.path, null);
  }
  await app.refresh();
}

/* -------------------------------------------- */
/*  Rename and move                             */
/* -------------------------------------------- */

/** A dialog for a rename or move, with the "update references" choice when documents use the files. */
async function changeDialog({ title, icon, content, usages, input }) {
  const usageHTML = usages.length ? `<div class="df-usage-box">
      <p>${loc("DIMANCER_FILES.UsedBy", { n: usages.length })}</p>${await usageList(usages)}
      <label class="df-check"><input type="checkbox" name="rewrite" checked> ${loc("DIMANCER_FILES.Rewrite.Label")}</label>
    </div>` : "";
  const inputHTML = input ? `<div class="form-group"><label>${loc(input.label)}</label>
      <div class="form-fields"><input type="text" name="value" value="${esc(input.value)}" required autofocus></div>
      ${input.hint ? `<p class="hint">${loc(input.hint)}</p>` : ""}</div>` : "";
  const result = await DialogV2.wait({
    window: { title, icon },
    position: { width: 500 },
    content: `${content}${inputHTML}${usageHTML}`,
    buttons: [
      { action: "ok", label: "DIMANCER_FILES.Ok", icon: "fa-solid fa-check", default: true,
        callback: (_e, button) => ({
          value: button.form.elements.value?.value.trim(),
          rewrite: !!button.form.elements.rewrite?.checked
        }) },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    render: (_event, dialog) => {
      const el = dialog.element.querySelector("input[name=value]");
      if ( !el || !input ) return;
      el.focus();
      const dot = input.value.lastIndexOf(".");
      el.setSelectionRange(0, input.selectBase && dot > 0 ? dot : input.value.length);
    },
    rejectClose: false
  });
  return (result && (result !== "cancel")) ? result : null;
}

/**
 * Rename an entry. Without `name` it asks for one; with `name` (typed in place in the tree) it only
 * asks when documents use the entry, to offer updating them.
 * @param {{name?: string, isDir?: boolean}} [options]
 * @returns {Promise<boolean>}  Whether it was renamed.
 */
export async function renameEntry(app, path, { name, isDir } = {}) {
  if ( !app.canChange ) return false;
  const info = app.entryInfo(path);
  if ( isDir !== undefined ) info.isDir = isDir;
  const usages = await scan([info]);
  let answer = { value: name, rewrite: false };
  if ( (name === undefined) || usages.length ) {
    answer = await changeDialog({
      title: "DIMANCER_FILES.Rename.Title", icon: "fa-solid fa-i-cursor", usages,
      content: name === undefined
        ? `<p>${esc(decodeURIComponent(path))}</p>`
        : `<p>${loc("DIMANCER_FILES.Rename.To", { from: esc(info.name), to: esc(name) })}</p>`,
      input: name === undefined ? { label: "DIMANCER_FILES.Rename.Label", value: info.name, selectBase: !info.isDir,
        hint: info.isDir ? null : "DIMANCER_FILES.Rename.Hint" } : null
    });
    if ( answer && (name !== undefined) ) answer.value = name;
  }
  if ( !answer?.value || (answer.value === info.name) ) return false;
  let result;
  try {
    result = await companion.request("rename", { path, name: answer.value });
  } catch (err) {
    ui.notifications.error(err.message);
    return false;
  }
  if ( answer.rewrite ) await rewrite([{ from: result.from, to: result.to, isDir: info.isDir }]);
  if ( app.request === path ) app.request = result.to;
  if ( info.isDir ) app.retarget(path, result.to);
  app.selection = new Set([result.to]);
  app.anchor = result.to;
  await app.refresh();
  return true;
}

/**
 * Move entries. With `toDir` (a drop) it only confirms; without it asks for the folder.
 * @param {string[]} paths
 * @param {string} [toDir]  Client path of the destination folder.
 */
export async function moveEntries(app, paths, toDir) {
  if ( !paths.length || !app.canChange ) return;
  const targets = paths.map(p => app.entryInfo(p));
  const usages = await scan(targets);
  const answer = await changeDialog({
    title: "DIMANCER_FILES.Move.Title", icon: "fa-solid fa-folder-arrow-up", usages,
    content: toDir === undefined
      ? `<p>${loc("DIMANCER_FILES.Move.Prompt", { n: paths.length })}</p>${nameList(paths)}`
      : `<p>${loc("DIMANCER_FILES.Move.PromptTo", { n: paths.length, dir: esc(decodeURIComponent(toDir) || "/") })}</p>${nameList(paths)}`,
    input: toDir === undefined
      ? { label: "DIMANCER_FILES.Move.Label", value: decodeURIComponent(app.target), hint: "DIMANCER_FILES.Move.Hint" }
      : null
  });
  if ( !answer ) return;
  const dest = toDir ?? encodePath(String(answer.value ?? "").replace(/^\/+|\/+$/g, ""));
  let results;
  try {
    ({ results } = await companion.request("move", { paths, toDir: dest }));
  } catch (err) {
    return ui.notifications.error(err.message);
  }
  const done = report(results);
  if ( done.length ) ui.notifications.info(loc("DIMANCER_FILES.Move.Done", { n: done.length }));
  const isDir = new Map(targets.map(t => [t.path, t.isDir]));
  if ( answer.rewrite ) await rewrite(done.map(d => ({ from: d.path, to: d.to, isDir: isDir.get(d.path) })));
  for ( const d of done ) {
    app.selection.delete(d.path);
    if ( app.request === d.path ) app.request = d.to;
    if ( isDir.get(d.path) ) app.retarget(d.path, d.to);
  }
  await app.refresh();
}

/* -------------------------------------------- */
/*  Usages                                      */
/* -------------------------------------------- */

export async function showUsages(app, paths) {
  if ( !paths.length ) return;
  const targets = paths.map(p => app.entryInfo(p));
  const usages = await scan(targets);
  const content = usages.length
    ? `<p>${loc("DIMANCER_FILES.UsedBy", { n: usages.length })}</p>${await usageList(usages)}`
    : `<p>${loc("DIMANCER_FILES.NotUsed")}</p>`;
  const scope = setting(SETTINGS.scanCompendia) ? "" : `<p class="hint">${loc("DIMANCER_FILES.WorldOnly")}</p>`;
  return DialogV2.prompt({
    window: { title: "DIMANCER_FILES.Action.Usages", icon: "fa-solid fa-link" },
    position: { width: 460 },
    content: `${nameList(paths)}${content}${scope}`,
    ok: { label: "DIMANCER_FILES.Ok" },
    rejectClose: false
  });
}

/* -------------------------------------------- */
/*  Trash                                       */
/* -------------------------------------------- */

export async function showTrash(app) {
  if ( !app.canChange ) return;
  try {
    app.trash = (await companion.request("trash", null)).items;
  } catch (err) {
    return ui.notifications.error(err.message);
  }
  app.view = "trash";
  app.selection.clear();
  app.searchResults = null;
  return app.render();
}

export async function restoreTrash(app, ids) {
  let results;
  try {
    ({ results } = await companion.request("trash/restore", { ids }));
  } catch (err) {
    return ui.notifications.error(err.message);
  }
  const done = report(results, "id");
  if ( done.length ) {
    ui.notifications.info(done.length === 1
      ? loc("DIMANCER_FILES.Trash.RestoredOne", { path: decodeURIComponent(done[0].path) })
      : loc("DIMANCER_FILES.Trash.Restored", { n: done.length }));
  }
  await app.reloadTree();
  return showTrash(app);
}

/** Delete trash items for good: the given ids, or all with null. */
export async function purgeTrash(app, ids) {
  const sure = await DialogV2.confirm({
    window: { title: "DIMANCER_FILES.Trash.EmptyTitle", icon: "fa-solid fa-dumpster" },
    content: `<p>${ids ? loc("DIMANCER_FILES.Trash.PurgeConfirm", { n: ids.length }) : loc("DIMANCER_FILES.Trash.EmptyConfirm")}</p>`,
    rejectClose: false
  });
  if ( !sure ) return;
  try {
    const { removed } = await companion.request("trash/empty", ids ? { ids } : {});
    ui.notifications.info(loc("DIMANCER_FILES.Trash.Purged", { n: removed }));
  } catch (err) {
    ui.notifications.error(err.message);
  }
  return showTrash(app);
}
