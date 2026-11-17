import { MODULE_ID } from "./constants.mjs";

export const SETTINGS = Object.freeze({
  companion: "companion",
  ui: "ui",
  scanCompendia: "scanCompendia"
});

/**
 * What the browser replaces, one world setting each. Every Foundry picker has a `type`
 * (FilePicker.FILE_TYPES); the canvas Tile Browser is the one opened with `tileSize`.
 */
export const REPLACE = Object.freeze({
  images: { key: "replaceImages", types: ["image", "imagevideo", "graphics", "texture"] },
  audio: { key: "replaceAudio", types: ["audio"] },
  video: { key: "replaceVideo", types: ["video"] },
  other: { key: "replaceOther", types: ["any", "text", "font"] },
  folders: { key: "replaceFolders", types: ["folder"] },
  tiles: { key: "replaceTileBrowser", types: [] }
});

/** Which REPLACE entry a picker's options fall under. */
export function replaceCategory({ type = "any", tileSize = false } = {}) {
  if ( tileSize ) return "tiles";
  for ( const [id, { types }] of Object.entries(REPLACE) ) if ( types.includes(type) ) return id;
  return "other";
}

/** Whether this module's browser should open for these picker options (the file manager always does). */
export function replaces(options = {}) {
  if ( options.mode === "manage" ) return true;
  return game.settings.get(MODULE_ID, REPLACE[replaceCategory(options)].key) !== false;
}

export const UI_DEFAULTS = Object.freeze({ display: "grid", tile: 112, sort: "name", dir: 1, details: true });

export const setting = key => game.settings.get(MODULE_ID, key);

export function uiPrefs() {
  return { ...UI_DEFAULTS, ...(setting(SETTINGS.ui) ?? {}) };
}

export function saveUiPrefs(changes) {
  return game.settings.set(MODULE_ID, SETTINGS.ui, { ...uiPrefs(), ...changes });
}

export function registerSettings() {
  // Read each time a picker opens, so changes apply without a reload.
  for ( const [id, { key }] of Object.entries(REPLACE) ) {
    const name = id.charAt(0).toUpperCase() + id.slice(1);
    game.settings.register(MODULE_ID, key, {
      name: `DIMANCER_FILES.Settings.Replace${name}.Name`,
      hint: `DIMANCER_FILES.Settings.Replace${name}.Hint`,
      scope: "world",
      config: true,
      type: new foundry.data.fields.BooleanField({ initial: true })
    });
  }
  game.settings.register(MODULE_ID, SETTINGS.scanCompendia, {
    name: "DIMANCER_FILES.Settings.ScanCompendiums.Name",
    hint: "DIMANCER_FILES.Settings.ScanCompendiums.Hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: false })
  });
  // Kept in this browser only: world settings are sent to every player, and this holds the token.
  game.settings.register(MODULE_ID, SETTINGS.companion, {
    scope: "client",
    config: false,
    type: Object,
    default: { url: "", token: "" }
  });
  game.settings.register(MODULE_ID, SETTINGS.ui, {
    scope: "client",
    config: false,
    type: Object,
    default: { ...UI_DEFAULTS }
  });
}
