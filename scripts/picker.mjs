/**
 * The file browser that replaces Foundry's FilePicker (CONFIG.ux.FilePicker).
 *
 * Two modes: "pick" (opened by any image/audio/file field: returns a path, keeping core's contract
 * of field + change event + callback) and "manage" (a standalone window). Browsing, uploads and
 * folder creation go through core's static API, so they work for everyone. Delete, rename, move,
 * sizes and the trash need the companion service and a GM.
 */
import { PAGE_SIZE, TEMPLATES } from "./constants.mjs";
import { companion } from "./companion-client.mjs";
import * as L from "./listing.mjs";
import * as Ops from "./operations-ui.mjs";
import { replaces, saveUiPrefs, uiPrefs } from "./settings.mjs";
import { filesFromDrop, filesFromInput, runUploads } from "./upload.mjs";

const CoreFilePicker = foundry.applications.apps.FilePicker;
/** Core's parent prototype, to run ApplicationV2's hooks without core's FilePicker-specific ones. */
const BaseProto = Object.getPrototypeOf(CoreFilePicker.prototype);

/** Drag data type for entries dragged inside the browser (moving files). */
export const DRAG_TYPE = "application/x-dimancer-files";

export default class DimancerFilePicker extends CoreFilePicker {
  constructor(options = {}) {
    // The tile browser (tileSize) is a canvas palette with its own UI; core keeps it.
    // Kinds of picker the GM left to Foundry (module settings) get core's picker.
    if ( !replaces(options) ) return new CoreFilePicker(options);
    super(options);
    /** "pick" (a field), "manage" (the file manager) or "tiles" (the canvas Tile Browser). */
    this.mode = options.mode === "manage" ? "manage" : options.tileSize ? "tiles" : "pick";
    this.prefs = uiPrefs();
  }

  static DEFAULT_OPTIONS = {
    id: "dimancer-files-{id}",
    classes: ["dimancer-files"],
    window: {
      icon: "fa-solid fa-folder-tree",
      resizable: true,
      contentClasses: ["dimancer-files-content"],
      controls: [
        { icon: "fa-solid fa-file-magnifying-glass", label: "DIMANCER_FILES.CorePicker", action: "dfCore" },
        { icon: "fa-solid fa-plug", label: "DIMANCER_FILES.Companion.Title", action: "dfCompanion",
          visible: () => game.user.isGM }
      ]
    },
    position: { width: 960, height: 640 },
    actions: {
      dfCore: DimancerFilePicker.#onCore,
      dfCompanion: DimancerFilePicker.#onCompanion,
      dfSource: DimancerFilePicker.#onSource,
      dfTreeToggle: DimancerFilePicker.#onTreeToggle,
      dfGo: DimancerFilePicker.#onGo,
      dfUp: DimancerFilePicker.#onUp,
      dfFavorite: DimancerFilePicker.#onFavorite,
      dfGoFavorite: DimancerFilePicker.#onGoFavorite,
      dfRemoveFavorite: DimancerFilePicker.#onRemoveFavorite,
      dfDisplay: DimancerFilePicker.#onDisplay,
      dfSort: DimancerFilePicker.#onSort,
      dfSearchAll: DimancerFilePicker.#onSearchAll,
      dfToggleDetails: DimancerFilePicker.#onToggleDetails,
      dfNewFolder: DimancerFilePicker.#onNewFolder,
      dfUpload: DimancerFilePicker.#onUpload,
      dfUploadFolder: DimancerFilePicker.#onUploadFolder,
      dfPrivacy: DimancerFilePicker.#onPrivacy,
      dfMore: DimancerFilePicker.#onMore,
      dfRefresh: DimancerFilePicker.#onRefresh,
      dfOpen: DimancerFilePicker.#onOpen,
      dfCopyPath: DimancerFilePicker.#onCopyPath,
      dfDelete: DimancerFilePicker.#onDelete,
      dfRename: DimancerFilePicker.#onRename,
      dfMove: DimancerFilePicker.#onMove,
      dfUsages: DimancerFilePicker.#onUsages,
      dfTrash: DimancerFilePicker.#onTrash,
      dfRestore: DimancerFilePicker.#onRestore,
      dfPurge: DimancerFilePicker.#onPurge,
      dfEmptyTrash: DimancerFilePicker.#onEmptyTrash,
      dfCancel: DimancerFilePicker.#onCancel
    },
    form: { handler: DimancerFilePicker.#onSubmit, submitOnChange: false, closeOnSubmit: false }
  };

  static PARTS = {
    toolbar: { template: TEMPLATES.toolbar },
    sidebar: { template: TEMPLATES.sidebar, scrollable: [""] },
    files: { template: TEMPLATES.files, scrollable: [""] },
    details: { template: TEMPLATES.details, scrollable: [""] },
    footer: { template: TEMPLATES.footer }
  };

  /** Open the browser as a standalone file manager. */
  static manage(options = {}) {
    return new this({ mode: "manage", type: "any", ...options }).render({ force: true });
  }

  /* -------------------------------------------- */
  /*  State                                       */
  /* -------------------------------------------- */

  /** Selected client paths. */
  selection = new Set();

  /** Where shift-click ranges and arrow keys start. */
  anchor = null;

  /** Companion stats of the browsed folder: path → {size, mtime}. */
  stats = new Map();

  /** Folder tree: key → child folders. */
  tree = new Map();

  /** Expanded tree keys. */
  expanded = new Set();

  /** The filter typed in the toolbar. */
  filter = "";

  /** Search every subfolder instead of filtering the folder. */
  searchAll = false;

  /** {items, truncated, query} while showing recursive search results. */
  searchResults = null;

  /** "files" or "trash". */
  view = "files";

  /** Trash items while the trash is shown. */
  trash = [];

  /** How many entries are shown before "Show more". */
  limit = PAGE_SIZE;

  /** Upload progress {done, total, name}, or null. */
  uploads = null;

  /** Paths in display order, for ranges and arrow keys. */
  #order = [];

  /** Rows by path from the last render. */
  #rows = new Map();

  #browsedKey = null;

  #searchToken = 0;

  #filterTimer = null;

  get title() {
    return this.mode === "manage" ? game.i18n.localize("DIMANCER_FILES.Title") : super.title;
  }

  /** Whether the GM can delete, rename and move here (companion reachable, Data storage). */
  get canChange() {
    return companion.available && (this.activeSource === "data");
  }

  /** What a row is, from the last listing or the folder tree. */
  entryInfo(path) {
    const row = this.#rows.get(path);
    if ( row ) return { path, isDir: row.isDir, name: row.name };
    const isDir = this.#knownDirs.has(path) || (this.result?.dirs?.includes(path) ?? false);
    return { path, isDir, name: L.baseName(path) };
  }

  /** Folder paths seen in the tree, so a tree row is known to be a folder. */
  #knownDirs = new Set();

  /** The browse in flight, so the tree's inline rename can wait for its re-render. */
  #pending = Promise.resolve();

  /**
   * Follow a folder that was renamed or moved (`to`) or deleted (`to` null): the browsed folder and the
   * expanded tree branches move with it, or go up to its parent.
   */
  retarget(from, to) {
    const t = this.target;
    if ( (t === from) || t.startsWith(`${from}/`) ) {
      this.source.target = to === null ? L.dirName(from) : `${to}${t.slice(from.length)}`;
    }
    const prefix = this.#treeKey(from);
    for ( const key of [...this.expanded] ) {
      if ( (key !== prefix) && !key.startsWith(`${prefix}/`) ) continue;
      this.expanded.delete(key);
      if ( to !== null ) this.expanded.add(`${this.#treeKey(to)}${key.slice(prefix.length)}`);
    }
  }

  /* -------------------------------------------- */
  /*  Browsing                                    */
  /* -------------------------------------------- */

  /** @override */
  browse(target = this.target, options = {}) {
    const promise = this.#browse(target, options);
    this.#pending = promise.catch(() => {});
    return promise;
  }

  async #browse(target, options) {
    const render = options.render ?? true;
    if ( game.user.isGM ) await companion.check();
    await super.browse(target, { ...options, render: false });
    if ( !this.result ) return this;
    const key = `${this.activeSource}|${this.source.bucket ?? ""}|${this.result.target}`;
    if ( key !== this.#browsedKey ) {
      this.selection.clear();
      this.anchor = null;
      this.limit = PAGE_SIZE;
      this.searchResults = null;
      this.filter = this.searchAll ? this.filter : "";
    }
    this.#browsedKey = key;
    this.view = "files";
    this.tree.set(this.#treeKey(this.result.target), this.#treeChildren(this.result));
    await this.#revealInTree(this.result.target);
    if ( this.request && !this.selection.size && this.result.files.includes(this.request) ) {
      this.selection.add(this.request);
      this.anchor = this.request;
      this.#scrollToSelection = true;
    }
    await this.#loadStats();
    if ( this.searchAll && this.filter ) await this.#runSearch();
    if ( render ) return this.render({ force: !this.rendered });
    return this;
  }

  /** Re-read the current folder (after a change) and the tree. */
  async refresh() {
    this.tree.clear();
    await this.browse(this.target, { render: false });
    await this.reloadTree();
    return this.render();
  }

  /** Re-read the root and every expanded folder of the tree. */
  async reloadTree() {
    for ( const key of [...this.tree.keys()] ) if ( key.startsWith(`${this.activeSource}|`) ) this.tree.delete(key);
    await Promise.all([this.#loadTree(""), ...[...this.expanded].map(k => this.#loadTreeKey(k))]);
  }

  async #loadStats() {
    this.stats = new Map();
    if ( !this.canChange ) return;
    const paths = [...this.result.dirs, ...this.result.files];
    if ( !paths.length ) return;
    try {
      const { entries } = await companion.request("stat", { paths });
      for ( const e of entries ) if ( !e.error ) this.stats.set(e.path, e);
    } catch (err) {
      console.warn("dimancer_files | stat failed", err);
    }
  }

  /* -------------------------------------------- */
  /*  Folder tree                                 */
  /* -------------------------------------------- */

  #treeKey(path, source = this.activeSource) {
    return `${source}|${this.sources[source]?.bucket ?? ""}|${path}`;
  }

  #treeChildren(result) {
    const privateDirs = new Set(result.privateDirs ?? []);
    for ( const d of result.dirs ?? [] ) this.#knownDirs.add(d);
    return (result.dirs ?? []).map(d => ({ path: d, name: L.baseName(d), private: result.private || privateDirs.has(d) }))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang, { numeric: true }));
  }

  async #loadTree(path) {
    const result = await this.constructor.browse(this.activeSource, path, { type: "folder", bucket: this.source.bucket })
      .catch(() => null);
    this.tree.set(this.#treeKey(path), result ? this.#treeChildren(result) : []);
  }

  async #loadTreeKey(key) {
    const [source, , path] = key.split("|");
    if ( source !== this.activeSource ) return;
    if ( !this.tree.has(key) ) await this.#loadTree(path);
  }

  /** Expand the tree down to a folder, loading what's missing. */
  async #revealInTree(target) {
    const parts = String(target).split("/").filter(Boolean);
    const paths = [""];
    for ( let i = 1; i <= parts.length; i++ ) paths.push(parts.slice(0, i).join("/"));
    await Promise.all(paths.filter(p => !this.tree.has(this.#treeKey(p))).map(p => this.#loadTree(p)));
    for ( const p of paths ) if ( p ) this.expanded.add(this.#treeKey(p));
  }

  #treeRows() {
    const rows = [];
    const walk = (path, depth) => {
      for ( const child of this.tree.get(this.#treeKey(path)) ?? [] ) {
        const key = this.#treeKey(child.path);
        const loaded = this.tree.get(key);
        const expanded = this.expanded.has(key);
        rows.push({
          ...child, depth, expanded,
          leaf: !!loaded && !loaded.length,
          active: (this.view === "files") && !this.searchResults && (child.path === this.target),
          indent: depth * 14
        });
        if ( expanded ) walk(child.path, depth + 1);
      }
    };
    walk("", 0);
    return rows;
  }

  /* -------------------------------------------- */
  /*  Search                                      */
  /* -------------------------------------------- */

  async #runSearch() {
    const query = this.filter.trim();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if ( !this.searchAll || !words.length || (query.length < 2) ) {
      this.searchResults = null;
      return;
    }
    const token = ++this.#searchToken;
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    let found = [];
    let truncated = false;
    try {
      if ( this.canChange && longest.length >= 2 ) {
        const r = await companion.request("search", {
          root: this.result.target, query: longest, extensions: this.extensions, limit: 1000
        });
        found = r.results;
        truncated = r.truncated;
      }
      else ({ found, truncated } = await this.#crawl(this.result.target, words));
    } catch (err) {
      ui.notifications.error(err.message);
    }
    if ( token !== this.#searchToken ) return;
    const items = found.map(f => ({
      path: f.path, name: L.baseName(f.path), isDir: f.isDir, kind: f.isDir ? "folder" : L.fileKind(f.path),
      ext: f.isDir ? "" : L.extension(f.path), size: null, mtime: null, folder: decodeURIComponent(L.dirName(f.path))
    }));
    this.searchResults = { query, items: L.filterItems(items, query), truncated };
  }

  /** Search without the companion: browse folder by folder (at most 300). */
  async #crawl(root, words) {
    const queue = [root];
    const found = [];
    let visited = 0;
    const matches = name => words.every(w => name.toLowerCase().includes(w));
    while ( queue.length && (visited < 300) && (found.length < 500) ) {
      const batch = queue.splice(0, 6);
      visited += batch.length;
      const results = await Promise.all(batch.map(dir => this.constructor.browse(this.activeSource, dir, {
        extensions: this.extensions, bucket: this.source.bucket
      }).catch(() => null)));
      for ( const r of results ) {
        if ( !r ) continue;
        queue.push(...r.dirs);
        for ( const d of r.dirs ) if ( matches(L.baseName(d)) ) found.push({ path: d, isDir: true });
        for ( const f of r.files ) if ( matches(L.baseName(f)) ) found.push({ path: f, isDir: false });
      }
    }
    return { found, truncated: queue.length > 0 || found.length >= 500 };
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  #scrollToSelection = false;

  /** @override */
  async _prepareContext(options) {
    const context = await BaseProto._prepareContext.call(this, options);
    const prefs = this.prefs;
    const isGM = game.user.isGM;

    // Rows
    let items = [];
    if ( this.view === "files" ) {
      const base = this.searchResults ? this.searchResults.items : L.buildItems(this.result, this.stats);
      items = L.sortItems(this.searchResults ? base : L.filterItems(base, this.filter), prefs.sort, prefs.dir);
    }
    this.#order = items.map(i => i.path);
    this.#rows = new Map(items.map(i => [i.path, i]));
    const shown = items.slice(0, this.limit).map(i => this.#decorate(i));

    // Sources
    const sources = Object.keys(this.sources).map(id => ({
      id, label: game.i18n.localize(`FILES.TABS.${id}`), active: id === this.activeSource,
      icon: { data: "fa-solid fa-database", public: "fa-solid fa-server", s3: "fa-solid fa-cloud" }[id]
    }));

    const favoriteKey = `${this.activeSource}-${`${this.target}/`.replace(/\/+$/, "/")}`;
    const favorites = Object.entries(this.favorites ?? {}).map(([key, f]) => ({
      ...f, key, active: key === favoriteKey
    }));

    const stats = this.#folderSummary(items);
    return Object.assign(context, {
      mode: this.mode,
      isManage: this.mode === "manage",
      isTiles: this.mode === "tiles",
      tileSize: this.tileSize,
      isGM,
      view: this.view,
      prefs,
      isList: prefs.display === "list",
      sortOptions: ["name", "type", "size", "date"].map(id => ({
        id, label: `DIMANCER_FILES.Sort.${id}`, active: prefs.sort === id,
        disabled: ["size", "date"].includes(id) && !this.canChange
      })),
      sortIcon: prefs.dir === 1 ? "fa-arrow-down-short-wide" : "fa-arrow-down-wide-short",
      sources,
      isS3: this.activeSource === "s3",
      bucket: this.source.bucket,
      buckets: this.activeSource === "s3" ? (this.source.buckets ?? []).map(b => ({ value: b, label: b })) : [],
      sourceLabel: sources.find(s => s.active)?.label,
      rootActive: (this.view === "files") && !this.searchResults && !this.target,
      tree: this.#treeRows(),
      favorites,
      isFavorite: favoriteKey in (this.favorites ?? {}),
      crumbs: L.crumbs(this.target),
      target: this.target,
      canUp: !!this.target,
      filter: this.filter,
      searchAll: this.searchAll,
      searching: !!this.searchResults,
      search: this.searchResults,
      canCreateFolder: this.canCreateFolder,
      canUpload: this.canUpload,
      canTogglePrivacy: isGM && (this.activeSource !== "public"),
      isPrivate: !!this.result?.private,
      canChange: this.canChange,
      companion: isGM ? companion.status : null,
      companionLoggedIn: companion.loggedIn,
      canPurge: this.canChange && companion.policy.permanent,
      items: shown,
      more: Math.max(0, items.length - shown.length),
      empty: !items.length,
      trash: this.trash.map(t => ({
        ...t, sizeLabel: formatSize(t.size), dateLabel: formatDate(t.deletedAt), folder: decodeURIComponent(L.dirName(t.path)),
        icon: t.isDir ? L.iconFor("folder") : L.iconFor(L.fileKind(t.path))
      })),
      summary: stats,
      details: prefs.details ? this.#details() : null,
      showDetails: prefs.details,
      pickValue: this.#pickValue(),
      isFolderPicker: this.type === "folder",
      uploads: this.uploads,
      accept: this.extensions.join(",")
    });
  }

  #decorate(item) {
    return {
      ...item,
      icon: L.iconFor(item.kind),
      thumb: (item.kind === "image") ? item.path : null,
      sizeLabel: formatSize(item.size),
      dateLabel: formatDate(item.mtime),
      typeLabel: item.isDir ? game.i18n.localize("DIMANCER_FILES.Folder") : item.ext.toUpperCase(),
      selected: this.selection.has(item.path),
      picked: item.path === this.request
    };
  }

  #folderSummary(items) {
    const dirs = items.filter(i => i.isDir).length;
    const known = items.filter(i => !i.isDir && (i.size !== null));
    return {
      dirs, files: items.length - dirs,
      size: known.length ? formatSize(known.reduce((s, i) => s + i.size, 0)) : null
    };
  }

  #details() {
    const selected = [...this.selection];
    if ( selected.length === 1 ) {
      const row = this.#rows.get(selected[0]);
      const item = this.#decorate(row ?? {
        path: selected[0], name: L.baseName(selected[0]), isDir: false, kind: L.fileKind(selected[0]),
        ext: L.extension(selected[0]), size: null, mtime: null
      });
      return {
        single: item,
        isImage: item.kind === "image", isVideo: item.kind === "video", isAudio: item.kind === "audio",
        displayPath: decodeURIComponent(item.path)
      };
    }
    if ( selected.length > 1 ) {
      const rows = selected.map(p => this.#rows.get(p)).filter(Boolean);
      const known = rows.filter(r => r.size !== null);
      return {
        multiple: selected.length,
        size: known.length ? formatSize(known.reduce((s, r) => s + r.size, 0)) : null
      };
    }
    return null;
  }

  /** The path the Select button returns. */
  #pickValue() {
    if ( this.type === "folder" ) {
      const dir = [...this.selection].find(p => this.#rows.get(p)?.isDir);
      return dir ?? this.target;
    }
    const file = [...this.selection].find(p => this.#rows.get(p) && !this.#rows.get(p).isDir);
    return file ?? this.request ?? "";
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const el = this.element;
    el.addEventListener("click", this.#onClick.bind(this));
    el.addEventListener("dblclick", this.#onDoubleClick.bind(this));
    el.addEventListener("keydown", this.#onKeyDown.bind(this));
    el.addEventListener("input", this.#onInput.bind(this));
    el.addEventListener("change", this.#onChange.bind(this));
    el.addEventListener("dragstart", this.#onDragStart.bind(this));
    el.addEventListener("dragover", this.#onDragOver.bind(this));
    el.addEventListener("dragleave", this.#onDragLeave.bind(this));
    el.addEventListener("drop", this.#onDrop.bind(this));
    new foundry.applications.ux.ContextMenu(el, ".df-tree .df-node", this.#treeContextEntries(), {
      jQuery: false,
      fixed: true
    });
    new foundry.applications.ux.ContextMenu(el, ".df-entry", this.#contextEntries(), {
      jQuery: false,
      fixed: true,
      onOpen: target => {
        const path = target.dataset.path;
        if ( !this.selection.has(path) ) this.#selectOnly(path);
      }
    });
  }

  /** @override */
  async _onRender(context, options) {
    // ApplicationV2's hooks, not core FilePicker's (they expect core's template).
    await BaseProto._onRender.call(this, context, options);
    this.element.style.setProperty("--df-tile", `${this.prefs.tile}px`);
    this.element.classList.toggle("df-no-details", !this.prefs.details);
    this.element.classList.toggle("df-pick", this.mode === "pick");

    // Dimensions of the previewed image or video.
    const media = this.element.querySelector(".df-details .df-preview :is(img, video)");
    const dims = this.element.querySelector(".df-details [data-dimensions]");
    if ( media && dims ) {
      const show = () => {
        const w = media.naturalWidth || media.videoWidth;
        const h = media.naturalHeight || media.videoHeight;
        if ( w ) dims.textContent = `${w} × ${h} px`;
      };
      if ( media.complete || (media.readyState > 0) ) show();
      media.addEventListener("load", show, { once: true });
      media.addEventListener("loadedmetadata", show, { once: true });
    }
    // Size and date of the previewed file without the companion: ask the web server.
    const sizeEl = this.element.querySelector(".df-details [data-size-pending]");
    if ( sizeEl ) this.#headStats(sizeEl.dataset.sizePending, sizeEl);

    if ( this.#scrollToSelection ) {
      this.#scrollToSelection = false;
      this.element.querySelector(".df-entry.selected")?.scrollIntoView({ block: "center" });
    }
  }

  async #headStats(path, el) {
    try {
      const r = await fetch(path, { method: "HEAD", cache: "no-store" });
      if ( !r.ok ) return;
      const size = Number(r.headers.get("content-length"));
      const modified = r.headers.get("last-modified");
      if ( !el.isConnected ) return;
      el.textContent = [Number.isFinite(size) && size ? formatSize(size) : null, modified ? formatDate(Date.parse(modified)) : null]
        .filter(Boolean).join(" · ");
    } catch {
      // Remote or blocked: no size then.
    }
  }

  /* -------------------------------------------- */
  /*  Selection                                   */
  /* -------------------------------------------- */

  #selectOnly(path) {
    this.selection = new Set(path ? [path] : []);
    this.anchor = path;
    this.#syncSelection();
  }

  #select(path, event) {
    const additive = event.ctrlKey || event.metaKey;
    if ( event.shiftKey && this.anchor ) {
      const range = L.rangeBetween(this.#order, this.anchor, path);
      this.selection = new Set(additive ? [...this.selection, ...range] : range);
    }
    else if ( additive ) {
      if ( this.selection.has(path) ) this.selection.delete(path);
      else this.selection.add(path);
      this.anchor = path;
    }
    else {
      this.selection = new Set([path]);
      this.anchor = path;
    }
    this.#syncSelection();
  }

  /** Reflect the selection without re-rendering the (possibly long) list. */
  #syncSelection() {
    for ( const entry of this.element.querySelectorAll(".df-entry") ) {
      entry.classList.toggle("selected", this.selection.has(entry.dataset.path));
    }
    this.render({ parts: ["details", "footer"] });
  }

  /* -------------------------------------------- */
  /*  Events                                      */
  /* -------------------------------------------- */

  #onClick(event) {
    if ( event.target.closest("[data-action], input, select, button, a, audio, video") ) return;
    const entry = event.target.closest(".df-entry");
    if ( entry ) return this.#select(entry.dataset.path, event);
    // A click on the empty list clears the selection.
    if ( event.target.closest(".df-files") && !event.ctrlKey && !event.metaKey && !event.shiftKey ) this.#selectOnly(null);
  }

  #onDoubleClick(event) {
    // A folder in the tree: rename it in place.
    const node = event.target.closest(".df-tree .df-node[data-path]");
    if ( node && node.dataset.path && !event.target.closest(".df-caret, input") ) {
      event.preventDefault();
      return this.renameInTree(node.dataset.path);
    }
    const entry = event.target.closest(".df-entry");
    if ( !entry ) return;
    event.preventDefault();
    this.#activate(entry.dataset.path);
  }

  /**
   * Rename a tree folder in place: its label becomes a text field. Enter or leaving the field renames,
   * Escape cancels. Waits for the browse the double-click's first click started, so the re-render
   * doesn't wipe the field.
   */
  async renameInTree(path) {
    if ( !this.canChange || !path ) return;
    await this.#pending;
    const node = this.element.querySelector(`.df-tree .df-node[data-path="${CSS.escape(path)}"]`);
    const label = node?.querySelector(".df-label");
    if ( !label ) return;
    const name = L.baseName(path);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "df-inline";
    input.value = name;
    input.setAttribute("aria-label", game.i18n.localize("DIMANCER_FILES.Rename.Label"));
    label.replaceWith(input);
    node.removeAttribute("data-tooltip");
    game.tooltip.deactivate();
    input.focus();
    input.select();
    let done = false;
    const finish = async commit => {
      if ( done ) return;
      done = true;
      const value = input.value.trim();
      if ( !commit || !value || (value === name) ) return this.render({ parts: ["sidebar"] });
      input.disabled = true;
      const renamed = await Ops.renameEntry(this, path, { name: value, isDir: true });
      if ( !renamed ) this.render({ parts: ["sidebar"] });
    };
    // Keep clicks and keys inside the field away from the row (navigation) and from Foundry (Escape closes windows).
    for ( const type of ["click", "dblclick", "pointerdown"] ) input.addEventListener(type, e => e.stopPropagation());
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      if ( event.key === "Enter" ) {
        event.preventDefault();
        finish(true);
      }
      else if ( event.key === "Escape" ) {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  /** Ask for a name and create a folder inside `parent` (client path). */
  async newFolder(parent = this.target) {
    const name = await Ops.askName({ title: "DIMANCER_FILES.NewFolder", label: "DIMANCER_FILES.FolderName" });
    if ( !name ) return;
    if ( /[/\\]/.test(name) || name.startsWith(".") ) {
      return ui.notifications.error("DIMANCER_FILES.Error.BadFolderName", { localize: true });
    }
    const path = [parent, encodeURIComponent(name)].filterJoin("/");
    try {
      await this.constructor.createDirectory(this.activeSource, path, { bucket: this.source.bucket });
    } catch (err) {
      return ui.notifications.error(err.message);
    }
    if ( parent ) this.expanded.add(this.#treeKey(parent));
    await this.refresh();
  }

  /** Open a folder, pick a file (picker) or open it (manager). */
  #activate(path) {
    const row = this.#rows.get(path);
    if ( row?.isDir ) {
      if ( this.searchResults ) this.searchResults = null;
      return this.browse(path);
    }
    if ( this.mode === "pick" ) {
      this.#selectOnly(path);
      return this.#submitPath(path);
    }
    return this.#open(path);
  }

  #onKeyDown(event) {
    if ( event.target.closest("input, textarea, select") ) {
      if ( (event.key === "Enter") && (event.target.name === "filter") ) event.preventDefault();
      if ( (event.key === "Enter") && (event.target.name === "file") ) {
        event.preventDefault();
        this.#submitPath(event.target.value);
      }
      return;
    }
    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;
    const selected = [...this.selection];
    if ( mod && (key.toLowerCase() === "a") ) {
      event.preventDefault();
      this.selection = new Set(this.#order.slice(0, this.limit));
      return this.#syncSelection();
    }
    if ( mod && (key.toLowerCase() === "c") && selected.length ) {
      event.preventDefault();
      return Ops.copyPaths(selected);
    }
    if ( (key === "Delete") && selected.length && this.canChange ) {
      event.preventDefault();
      return Ops.deleteEntries(this, selected);
    }
    if ( (key === "F2") && (selected.length === 1) && this.canChange ) {
      event.preventDefault();
      return Ops.renameEntry(this, selected[0]);
    }
    if ( (key === "Enter") && this.anchor ) {
      event.preventDefault();
      return this.#activate(this.anchor);
    }
    if ( (key === "Backspace") && this.target ) {
      event.preventDefault();
      return this.browse(L.dirName(this.target));
    }
    if ( ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key) ) {
      event.preventDefault();
      this.#moveFocus(key, event);
    }
  }

  #moveFocus(key, event) {
    const entries = [...this.element.querySelectorAll(".df-files .df-entry")];
    if ( !entries.length ) return;
    const index = Math.max(0, entries.findIndex(e => e.dataset.path === this.anchor));
    // Columns in the grid: entries sharing the first row's top.
    const top = entries[0].offsetTop;
    const columns = this.prefs.display === "list" ? 1 : Math.max(1, entries.findIndex(e => e.offsetTop !== top));
    const cols = columns === -1 ? entries.length : columns;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[key];
    let next = key === "Home" ? 0 : key === "End" ? entries.length - 1 : index + step;
    if ( this.anchor === null ) next = 0;
    next = Math.clamp(next, 0, entries.length - 1);
    const path = entries[next].dataset.path;
    if ( event.shiftKey ) {
      const anchor = this.anchor;
      this.#select(path, { shiftKey: true });
      this.anchor = anchor;
    }
    else this.#selectOnly(path);
    this.anchor = path;
    entries[next].scrollIntoView({ block: "nearest" });
  }

  #onInput(event) {
    const input = event.target;
    if ( input.name === "filter" ) {
      clearTimeout(this.#filterTimer);
      this.#filterTimer = setTimeout(async () => {
        this.filter = input.value;
        this.limit = PAGE_SIZE;
        if ( this.searchAll ) await this.#runSearch();
        this.render({ parts: ["files", "details", "sidebar", "footer"] });
      }, this.searchAll ? 350 : 120);
    }
    else if ( input.name === "tileSize" ) {
      const size = Number(input.value);
      this.constructor.LAST_TILE_SIZE = (Number.isFinite(size) && size > 0) ? size : null;
    }
    else if ( input.name === "tile" ) {
      this.prefs.tile = Number(input.value);
      this.element.style.setProperty("--df-tile", `${this.prefs.tile}px`);
    }
  }

  async #onChange(event) {
    const input = event.target;
    if ( input.name === "tile" ) return saveUiPrefs({ tile: Number(input.value) });
    if ( input.name === "tileSize" ) {
      const size = Number(input.value);
      this.constructor.LAST_TILE_SIZE = (Number.isFinite(size) && size > 0) ? size : null;
      return;
    }
    if ( input.name === "bucket" ) {
      this.sources.s3.bucket = input.value;
      this.tree.clear();
      return this.browse("");
    }
    if ( input.name === "upload-files" || input.name === "upload-folder" ) {
      const entries = filesFromInput(input.files);
      input.value = "";
      return this.upload(entries, this.target);
    }
  }

  /** Upload files (with their sub-folders) into a folder. */
  async upload(entries, targetDir = this.target) {
    if ( !entries.length ) return;
    const uploaded = await runUploads(this, entries, targetDir);
    if ( uploaded.length === 1 ) this.request = uploaded[0];
    await this.refresh();
    if ( uploaded.length && (targetDir === this.target) ) {
      this.selection = new Set(uploaded.filter(p => this.#rows.has(p)));
      this.anchor = uploaded.at(-1);
      this.#syncSelection();
    }
  }

  /* -------------------------------------------- */
  /*  Drag and drop                               */
  /* -------------------------------------------- */

  /** Grid size of the assets dragged onto the canvas (Tile Browser): pixels per grid square. */
  get tileSize() {
    return this.constructor.LAST_TILE_SIZE || canvas?.dimensions?.size || 100;
  }

  #onDragStart(event) {
    const entry = event.target.closest(".df-entry");
    if ( !entry ) return;
    const path = entry.dataset.path;
    if ( !this.selection.has(path) ) this.#selectOnly(path);
    const paths = [...this.selection];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ source: this.activeSource, paths }));
    event.dataTransfer.effectAllowed = "copyMove";
    const row = this.#rows.get(path);
    // An image or video dropped on the canvas becomes a Tile, as from core's picker.
    if ( row && !row.isDir && ["image", "video"].includes(row.kind) && game.user.isGM && canvas?.ready ) {
      const tileSize = this.mode === "tiles" ? this.tileSize : canvas.dimensions.size;
      event.dataTransfer.setData("text/plain", JSON.stringify({
        type: "Tile", texture: { src: path }, fromFilePicker: true, tileSize
      }));
      // Preview at the size the tile will have on the canvas, like core's Tile Browser.
      const img = entry.querySelector(".df-thumb img");
      if ( img?.naturalWidth ) {
        const ratio = canvas.dimensions.size / tileSize;
        const w = img.naturalWidth * ratio * canvas.stage.scale.x;
        const h = img.naturalHeight * ratio * canvas.stage.scale.y;
        const preview = foundry.applications.ux.DragDrop.implementation.createDragImage(img, w, h);
        event.dataTransfer.setDragImage(preview, w / 2, h / 2);
      }
    }
    else event.dataTransfer.setData("text/plain", path);
  }

  /** The folder a drag is over: a folder row, the tree, a crumb, or the list itself. */
  #dropDir(event) {
    const zone = event.target.closest("[data-drop-dir]");
    if ( zone ) return zone.dataset.dropDir;
    if ( event.target.closest(".df-files") && (this.view === "files") && !this.searchResults ) return this.target;
    return null;
  }

  #onDragOver(event) {
    const dir = this.#dropDir(event);
    if ( dir === null ) return;
    const types = event.dataTransfer.types;
    const internal = types.includes(DRAG_TYPE);
    const external = types.includes("Files");
    if ( internal ? !this.canChange : !(external && this.canUpload) ) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = internal ? "move" : "copy";
    const zone = event.target.closest("[data-drop-dir]") ?? event.target.closest(".df-files");
    if ( zone !== this.#dropZone ) {
      this.#dropZone?.classList.remove("df-drop");
      this.#dropZone = zone;
      zone?.classList.add("df-drop");
    }
  }

  #dropZone = null;

  #onDragLeave(event) {
    if ( this.#dropZone && !this.#dropZone.contains(event.relatedTarget) ) {
      this.#dropZone.classList.remove("df-drop");
      this.#dropZone = null;
    }
  }

  async #onDrop(event) {
    const dir = this.#dropDir(event);
    this.#dropZone?.classList.remove("df-drop");
    this.#dropZone = null;
    if ( dir === null ) return;
    const internal = event.dataTransfer.getData(DRAG_TYPE);
    if ( internal ) {
      event.preventDefault();
      event.stopPropagation();
      const { source, paths } = JSON.parse(internal);
      if ( (source !== this.activeSource) || !this.canChange ) return;
      const moving = paths.filter(p => (p !== dir) && (L.dirName(p) !== dir));
      if ( moving.length ) await Ops.moveEntries(this, moving, dir);
      return;
    }
    if ( event.dataTransfer.files?.length && this.canUpload ) {
      event.preventDefault();
      event.stopPropagation();
      const entries = await filesFromDrop(event.dataTransfer);
      await this.upload(entries, dir);
    }
  }

  /* -------------------------------------------- */
  /*  Context menu                                */
  /* -------------------------------------------- */

  /** Right-click on a folder in the tree. The root row has an empty path. */
  #treeContextEntries() {
    const path = el => el.dataset.path ?? "";
    const canCreate = () => (this.options.allowUpload !== false) && ["data", "s3"].includes(this.activeSource)
      && (game.user.can("FILES_UPLOAD") !== false);
    return [
      { label: "DIMANCER_FILES.Action.Open", icon: "fa-solid fa-folder-open",
        onClick: (_e, el) => this.browse(path(el)) },
      { label: "DIMANCER_FILES.NewFolderInside", icon: "fa-solid fa-folder-plus",
        visible: canCreate, onClick: (_e, el) => this.newFolder(path(el)) },
      { label: "DIMANCER_FILES.Action.Rename", icon: "fa-solid fa-i-cursor",
        visible: el => this.canChange && !!path(el), onClick: (_e, el) => this.renameInTree(path(el)) },
      { label: "DIMANCER_FILES.Action.CopyPath", icon: "fa-solid fa-copy",
        visible: el => !!path(el), onClick: (_e, el) => Ops.copyPaths([path(el)]) },
      { label: "DIMANCER_FILES.Action.Usages", icon: "fa-solid fa-link",
        visible: el => game.user.isGM && !!path(el), onClick: (_e, el) => Ops.showUsages(this, [path(el)]) },
      { label: "DIMANCER_FILES.Action.Delete", icon: "fa-solid fa-trash", classes: "df-danger",
        visible: el => this.canChange && !!path(el), onClick: (_e, el) => Ops.deleteEntries(this, [path(el)]) }
    ];
  }

  #contextEntries() {
    const isDir = el => el.dataset.dir === "true";
    return [
      { label: "DIMANCER_FILES.Action.Open", icon: "fa-solid fa-up-right-from-square",
        onClick: (_e, el) => this.#activate(el.dataset.path) },
      { label: "DIMANCER_FILES.Action.Select", icon: "fa-solid fa-check",
        visible: el => (this.mode === "pick") && (isDir(el) === (this.type === "folder")),
        onClick: (_e, el) => this.#submitPath(el.dataset.path) },
      { label: "DIMANCER_FILES.Action.CopyPath", icon: "fa-solid fa-copy",
        onClick: () => Ops.copyPaths([...this.selection]) },
      { label: "DIMANCER_FILES.NewFolderInside", icon: "fa-solid fa-folder-plus",
        visible: el => isDir(el) && (this.selection.size === 1) && (this.options.allowUpload !== false)
          && (game.user.can("FILES_UPLOAD") !== false),
        onClick: (_e, el) => this.newFolder(el.dataset.path) },
      { label: "DIMANCER_FILES.Action.Rename", icon: "fa-solid fa-i-cursor",
        visible: () => this.canChange && (this.selection.size === 1),
        onClick: (_e, el) => Ops.renameEntry(this, el.dataset.path) },
      { label: "DIMANCER_FILES.Action.Move", icon: "fa-solid fa-folder-arrow-up",
        visible: () => this.canChange, onClick: () => Ops.moveEntries(this, [...this.selection]) },
      { label: "DIMANCER_FILES.Action.Usages", icon: "fa-solid fa-link",
        visible: () => game.user.isGM, onClick: () => Ops.showUsages(this, [...this.selection]) },
      { label: "DIMANCER_FILES.Action.Delete", icon: "fa-solid fa-trash", classes: "df-danger",
        visible: () => this.canChange, onClick: () => Ops.deleteEntries(this, [...this.selection]) }
    ];
  }

  /* -------------------------------------------- */
  /*  Picking                                     */
  /* -------------------------------------------- */

  /** Core's contract: fill the bound field, fire change, call back, close. */
  async #submitPath(path) {
    if ( !path ) {
      ui.notifications.error("DIMANCER_FILES.Error.NothingSelected", { localize: true });
      return;
    }
    if ( this.mode !== "pick" ) return Ops.copyPaths([path]);
    if ( this.field ) {
      this.field.value = path;
      this.field.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    }
    if ( this.callback ) this.callback(path, this);
    await this.close();
  }

  static async #onSubmit(event) {
    const value = this.element.elements.file?.value ?? this.#pickValue();
    return this.#submitPath(value);
  }

  #open(path) {
    const kind = L.fileKind(path);
    if ( kind === "image" ) {
      return new foundry.applications.apps.ImagePopout({ src: path, window: { title: L.baseName(path) } })
        .render({ force: true });
    }
    window.open(path, "_blank", "noopener");
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onCore() {
    const options = {
      type: this.type, current: this.#pickValue() || this.request, field: this.field, button: this.button,
      callback: this.callback, allowUpload: this.options.allowUpload, redirectToRoot: this.options.redirectToRoot
    };
    await this.close();
    const picker = new CoreFilePicker(options);
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  static #onCompanion() {
    return Ops.openCompanionConfig(this);
  }

  static async #onSource(_event, button) {
    const id = button.dataset.source;
    if ( !(id in this.sources) || (id === this.activeSource && this.view === "files") ) return;
    this.activeSource = this.tabGroups.sources = id;
    this.searchResults = null;
    await this.browse(this.source.target);
  }

  static async #onTreeToggle(event, button) {
    event.stopPropagation();
    const key = this.#treeKey(button.dataset.path);
    if ( this.expanded.has(key) ) this.expanded.delete(key);
    else {
      if ( !this.tree.has(key) ) await this.#loadTree(button.dataset.path);
      this.expanded.add(key);
    }
    this.render({ parts: ["sidebar"] });
  }

  static async #onGo(_event, button) {
    this.searchResults = null;
    if ( this.searchAll ) this.filter = "";
    this.view = "files";
    await this.browse(button.dataset.path ?? "");
  }

  static async #onUp() {
    if ( this.target ) await this.browse(L.dirName(this.target));
  }

  static async #onFavorite() {
    const path = `${this.target}/`.replace(/\/+$/, "/");
    const key = `${this.activeSource}-${path}`;
    const favorites = foundry.utils.deepClone(this.favorites);
    if ( key in favorites ) delete favorites[key];
    else favorites[key] = { source: this.activeSource, path, label: path === "/" ? "root" : path.split("/").at(-2) };
    await game.settings.set("core", "favoritePaths", favorites);
    this.render({ parts: ["toolbar", "sidebar"] });
  }

  static async #onGoFavorite(_event, button) {
    const { source, path } = button.dataset;
    if ( source in this.sources ) this.activeSource = this.tabGroups.sources = source;
    this.searchResults = null;
    await this.browse(path === "/" ? "" : path.replace(/\/$/, ""));
  }

  static async #onRemoveFavorite(event, button) {
    event.stopPropagation();
    const favorites = foundry.utils.deepClone(this.favorites);
    delete favorites[button.dataset.key];
    await game.settings.set("core", "favoritePaths", favorites);
    this.render({ parts: ["toolbar", "sidebar"] });
  }

  static async #onDisplay(_event, button) {
    this.prefs.display = button.dataset.display;
    await saveUiPrefs({ display: this.prefs.display });
    this.render({ parts: ["toolbar", "files"] });
  }

  static async #onSort(_event, button) {
    const by = button.dataset.sort;
    if ( by === "dir" ) this.prefs.dir = -this.prefs.dir;
    else this.prefs.sort = by;
    await saveUiPrefs({ sort: this.prefs.sort, dir: this.prefs.dir });
    this.render({ parts: ["toolbar", "files"] });
  }

  static async #onSearchAll() {
    this.searchAll = !this.searchAll;
    this.filter = this.element.elements.filter?.value ?? this.filter;
    this.limit = PAGE_SIZE;
    await this.#runSearch();
    this.render({ parts: ["toolbar", "files", "sidebar", "details", "footer"] });
  }

  static async #onToggleDetails() {
    this.prefs.details = !this.prefs.details;
    await saveUiPrefs({ details: this.prefs.details });
    this.render();
  }

  static #onNewFolder() {
    return this.newFolder(this.target);
  }

  static #onUpload() {
    this.element.querySelector("input[name=upload-files]")?.click();
  }

  static #onUploadFolder() {
    this.element.querySelector("input[name=upload-folder]")?.click();
  }

  static async #onPrivacy() {
    const result = await this.constructor.configurePath(this.activeSource, this.target, {
      private: !this.result.private, bucket: this.result.bucket
    });
    this.result.private = result.private;
    this.render({ parts: ["toolbar", "files"] });
  }

  static #onMore() {
    this.limit += PAGE_SIZE;
    this.render({ parts: ["files"] });
  }

  static async #onRefresh() {
    if ( game.user.isGM ) await companion.check({ force: true });
    if ( this.view === "trash" ) return Ops.showTrash(this);
    await this.refresh();
  }

  static #onOpen(_event, button) {
    return this.#activate(button.dataset.path ?? this.anchor);
  }

  static #onCopyPath(_event, button) {
    return Ops.copyPaths(button.dataset.path ? [button.dataset.path] : [...this.selection]);
  }

  static #onDelete() {
    return Ops.deleteEntries(this, [...this.selection]);
  }

  static #onRename() {
    const [path] = this.selection;
    return path && Ops.renameEntry(this, path);
  }

  static #onMove() {
    return Ops.moveEntries(this, [...this.selection]);
  }

  static #onUsages() {
    return Ops.showUsages(this, [...this.selection]);
  }

  static #onTrash() {
    return Ops.showTrash(this);
  }

  static #onRestore(_event, button) {
    return Ops.restoreTrash(this, [button.dataset.id]);
  }

  static #onPurge(_event, button) {
    return Ops.purgeTrash(this, [button.dataset.id]);
  }

  static #onEmptyTrash() {
    return Ops.purgeTrash(this, null);
  }

  static #onCancel() {
    return this.close();
  }
}

/* -------------------------------------------- */

export function formatSize(size) {
  if ( (size === null) || (size === undefined) ) return "";
  return foundry.utils.formatFileSize(size, { decimalPlaces: 1 });
}

export function formatDate(ms) {
  if ( !ms ) return "";
  return new Date(ms).toLocaleString(game.i18n.lang, { dateStyle: "medium", timeStyle: "short" });
}
