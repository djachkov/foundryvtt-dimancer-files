/**
 * Broken links: documents in this world that point at files which no longer exist, and the files they
 * probably became.
 *
 * The file manager updates references in the world it runs in. Other worlds (and anything changed
 * outside Foundry) keep the old paths: open the world, run this, and it suggests the converted,
 * moved or re-cased file for each missing one. The fix is the same reference rewrite a rename uses.
 */
import { TEMPLATES } from "./constants.mjs";
import { bestSuggestion, buildIndex, referencedPaths, suggest, unlistedFolder } from "./broken-core.mjs";
import { fileKind, iconFor } from "./listing.mjs";
import { rewrite } from "./operations-ui.mjs";
import { SETTINGS, setting } from "./settings.mjs";
import { encodePath } from "./usage-core.mjs";
import { describe, documents } from "./usage.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** Folders listed at most, and HEAD requests in flight at once. */
const MAX_FOLDERS = 5000;
const PARALLEL = 8;
/** Documents listed per broken file before "and N more". */
const DOCS_SHOWN = 6;

function decode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/* -------------------------------------------- */
/*  Scanning                                    */
/* -------------------------------------------- */

/** Every file in User Data (decoded paths), except package code and Foundry's databases. */
async function listData(progress) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  const files = [];
  const queue = [""];
  let folders = 0;
  let truncated = false;
  while ( queue.length ) {
    const dir = queue.shift();
    if ( ++folders > MAX_FOLDERS ) {
      truncated = true;
      break;
    }
    if ( folders % 25 === 0 ) progress(loc("DIMANCER_FILES.Broken.Listing", { n: folders }));
    let result;
    try {
      result = await FP.browse("data", dir);
    } catch {
      continue;
    }
    for ( const f of result.files ?? [] ) files.push(decode(f));
    for ( const d of result.dirs ?? [] ) {
      if ( !unlistedFolder(decode(d).split("/")) ) queue.push(d);
    }
  }
  return { files, truncated };
}

/** Which paths the server doesn't have (404). Other failures count as present, so nothing is "fixed" on a hiccup. */
async function missingOf(paths, progress) {
  const missing = new Set();
  let done = 0;
  const queue = [...paths];
  const worker = async () => {
    while ( queue.length ) {
      const p = queue.shift();
      try {
        const r = await fetch(foundry.utils.getRoute(encodePath(p)), { method: "HEAD", cache: "no-store" });
        if ( r.status === 404 ) missing.add(p);
      } catch {
        // Unreachable: not reported as broken.
      }
      if ( ++done % 50 === 0 ) progress(loc("DIMANCER_FILES.Broken.Checking", { done, total: paths.length }));
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return missing;
}

/**
 * Find the broken links of this world (and of compendiums, when the module checks them).
 * @param {(status: string) => void} [progress]
 * @returns {Promise<{rows: object[], references: number, truncated: boolean}>}
 */
export async function scanBrokenLinks(progress = () => {}) {
  const site = { origin: window.location.origin, prefix: foundry.utils.getRoute("").replace(/^\/+|\/+$/g, "") };
  progress(loc("DIMANCER_FILES.Broken.Reading"));
  const users = new Map();
  for ( const doc of await documents({ compendia: setting(SETTINGS.scanCompendia) }) ) {
    let data;
    try {
      data = doc.toObject();
    } catch {
      continue;
    }
    for ( const p of referencedPaths(data, site) ) {
      if ( !users.has(p) ) users.set(p, new Map());
      users.get(p).set(doc.uuid, { uuid: doc.uuid, label: describe(doc) });
    }
  }
  progress(loc("DIMANCER_FILES.Broken.Listing", { n: 0 }));
  const { files, truncated } = await listData(progress);
  const index = buildIndex(files);
  const unknown = [...users.keys()].filter(p => !index.all.has(p));
  progress(loc("DIMANCER_FILES.Broken.Checking", { done: 0, total: unknown.length }));
  const missing = await missingOf(unknown, progress);
  const rows = [...missing].sort((a, b) => a.localeCompare(b)).map(path => {
    const suggestions = suggest(path, index);
    const best = bestSuggestion(suggestions);
    return { path, docs: [...users.get(path).values()], suggestions, choice: best?.path ?? "", fix: !!best };
  });
  return { rows, references: users.size, truncated };
}

/* -------------------------------------------- */
/*  The window                                  */
/* -------------------------------------------- */

export default class BrokenLinks extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dimancer-files-broken",
    classes: ["dimancer-files-broken"],
    window: { title: "DIMANCER_FILES.Broken.Title", icon: "fa-solid fa-link-slash", resizable: true },
    position: { width: 760, height: 620 },
    actions: {
      scan: BrokenLinks.#onScan,
      fix: BrokenLinks.#onFix,
      pick: BrokenLinks.#onPick,
      all: BrokenLinks.#onAll
    }
  };

  static PARTS = {
    main: { template: TEMPLATES.broken, scrollable: [".df-broken-list"] }
  };

  /** Open the window (one at a time). It scans when it first opens. */
  static open() {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if ( existing ) return existing.render({ force: true });
    return new this().render({ force: true });
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Opened from the file manager or the module settings: scan straight away.
    if ( !this.result ) this.scan();
  }

  /** Scan results: {rows, references, truncated}, or null before the first scan. */
  result = null;

  /** Progress text while scanning or fixing. */
  status = "";

  busy = false;

  async scan() {
    if ( this.busy ) return;
    if ( !game.user.isGM ) return ui.notifications.warn(loc("DIMANCER_FILES.Broken.GMOnly"));
    this.busy = true;
    const progress = status => {
      this.status = status;
      if ( this.rendered ) this.render();
    };
    try {
      const result = await scanBrokenLinks(progress);
      const TextEditor = foundry.applications.ux.TextEditor.implementation;
      for ( const row of result.rows ) {
        const shown = row.docs.slice(0, DOCS_SHOWN).map(d => `@UUID[${d.uuid}]{${d.label.replace(/[{}\]]/g, "")}}`);
        const more = row.docs.length > DOCS_SHOWN ? ` ${loc("DIMANCER_FILES.AndMore", { n: row.docs.length - DOCS_SHOWN })}` : "";
        row.docsHTML = await TextEditor.enrichHTML(shown.join(" ") + more);
      }
      this.result = result;
      this.status = "";
    } catch (err) {
      console.error("dimancer_files | broken link scan failed", err);
      this.status = err.message;
    } finally {
      this.busy = false;
    }
    if ( this.rendered ) this.render();
  }

  /** @override */
  async _prepareContext() {
    const rows = this.result?.rows.map((row, index) => {
      const options = row.suggestions.map(s => ({
        value: s.path, label: `${s.path} · ${loc(`DIMANCER_FILES.Broken.Reason.${s.reason}`)}`, selected: s.path === row.choice
      }));
      if ( row.choice && !row.suggestions.some(s => s.path === row.choice) ) {
        options.push({ value: row.choice, label: `${row.choice} · ${loc("DIMANCER_FILES.Broken.Reason.chosen")}`, selected: true });
      }
      return { ...row, index, options, icon: iconFor(fileKind(row.path)), none: !row.suggestions.length && !row.choice };
    }) ?? null;
    const fixCount = rows?.filter(r => r.fix && r.choice).length ?? 0;
    return {
      busy: this.busy,
      status: this.status,
      scanned: !!this.result,
      rows,
      fixCount,
      summary: this.result ? loc("DIMANCER_FILES.Broken.Summary", {
        broken: this.result.rows.length, references: this.result.references,
        suggested: this.result.rows.filter(r => r.suggestions.length).length
      }) : "",
      truncated: this.result?.truncated,
      worldOnly: !setting(SETTINGS.scanCompendia),
      anyChoice: !!rows?.some(r => r.choice),
      allChecked: !!rows?.some(r => r.choice) && rows.every(r => !r.choice || r.fix)
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelectorAll(".df-broken-row").forEach(li => {
      const row = this.result.rows[Number(li.dataset.index)];
      li.querySelector("select[data-choice]")?.addEventListener("change", event => {
        row.choice = event.currentTarget.value;
        row.fix = !!row.choice;
        this.render();
      });
      li.querySelector("input[data-fix]")?.addEventListener("change", event => {
        row.fix = event.currentTarget.checked;
        this.render();
      });
    });
  }

  static #onScan() {
    return this.scan();
  }

  static #onAll() {
    if ( !this.result ) return;
    const all = this.result.rows.filter(r => r.choice).every(r => r.fix);
    for ( const r of this.result.rows ) r.fix = !all && !!r.choice;
    this.render();
  }

  /** Choose a replacement by hand, in the file browser. */
  static #onPick(_event, button) {
    const row = this.result?.rows[Number(button.dataset.index)];
    if ( !row ) return;
    const kind = fileKind(row.path);
    const type = ["image", "audio", "video"].includes(kind) ? kind : "any";
    const folder = row.path.split("/").slice(0, -1).join("/");
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({
      type,
      current: encodePath(folder),
      callback: path => {
        row.choice = decode(path).replace(/^\/+/, "");
        row.fix = true;
        this.render();
      }
    }).render({ force: true });
  }

  static async #onFix() {
    const chosen = this.result?.rows.filter(r => r.fix && r.choice) ?? [];
    if ( !chosen.length || this.busy ) return;
    this.busy = true;
    this.status = loc("DIMANCER_FILES.Broken.Fixing", { n: chosen.length });
    this.render();
    try {
      await rewrite(chosen.map(r => ({ from: encodePath(r.path), to: encodePath(r.choice), isDir: false })));
    } finally {
      this.busy = false;
    }
    return this.scan();
  }
}
