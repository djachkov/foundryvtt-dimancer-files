import { MODULE_ID, TEMPLATES } from "./constants.mjs";
import { companion } from "./companion-client.mjs";
import CompanionConfig from "./companion-config.mjs";
import DimancerFilePicker from "./picker.mjs";
import { registerSettings } from "./settings.mjs";
import { findUsages, rewriteReferences } from "./usage.mjs";

Hooks.once("init", () => {
  registerSettings();
  game.settings.registerMenu(MODULE_ID, "companionMenu", {
    name: "DIMANCER_FILES.Companion.Title",
    label: "DIMANCER_FILES.Companion.Open",
    hint: "DIMANCER_FILES.Companion.Hint",
    icon: "fa-solid fa-plug",
    type: CompanionConfig,
    restricted: true
  });
  game.keybindings.register(MODULE_ID, "open", {
    name: "DIMANCER_FILES.Keybinding.Open",
    editable: [{ key: "KeyF", modifiers: ["Control", "Shift"] }],
    onDown: () => {
      openManager();
      return true;
    },
    restricted: false
  });
  // Always registered: each picker checks the "replace" settings when it opens and hands the kinds
  // left to Foundry back to core's picker.
  CONFIG.ux.FilePicker = DimancerFilePicker;
});

Hooks.once("ready", () => {
  foundry.applications.handlebars.loadTemplates(Object.values(TEMPLATES));
  if ( game.user.isGM ) companion.check();
  addSidebarButton(ui.sidebar?.element);
  game.modules.get(MODULE_ID).api = {
    /** Open the file manager window. */
    open: options => DimancerFilePicker.manage(options),
    DimancerFilePicker,
    companion,
    /** Documents using files: findUsages([{path, isDir}]). */
    findUsages,
    /** Point references at new paths: rewriteReferences([{from, to, isDir}]). */
    rewriteReferences
  };
});

/** Open the file manager, or bring the open one to the front. */
function openManager() {
  const open = [...foundry.applications.instances.values()]
    .find(app => (app instanceof DimancerFilePicker) && (app.mode === "manage"));
  if ( open ) return open.bringToFront();
  return DimancerFilePicker.manage();
}

const canBrowse = () => game.user.can("FILES_BROWSE") !== false;

/** A File Manager button in the sidebar's tab strip, always visible, even with the sidebar collapsed. */
function addSidebarButton(html) {
  if ( !html || !canBrowse() ) return;
  const menu = html.querySelector("#sidebar-tabs > menu, nav.tabs > menu");
  if ( !menu || menu.querySelector(".dimancer-files-tab") ) return;
  const li = document.createElement("li");
  const label = game.i18n.localize("DIMANCER_FILES.Title");
  li.innerHTML = `<button type="button" class="ui-control plain icon fa-solid fa-folder-tree dimancer-files-tab"
    aria-label="${label}" data-tooltip></button>`;
  li.querySelector("button").addEventListener("click", openManager);
  // Before the collapse toggle, after the tabs.
  const collapse = menu.querySelector("button.collapse")?.closest("li");
  menu.insertBefore(li, collapse ?? null);
}

// The sidebar first renders before the world is fully set up, so add the button again once ready;
// later re-renders of the tab strip go through the hook.
Hooks.on("renderSidebar", (_app, html) => addSidebarButton(html));

/** Also in the Settings sidebar, next to Configure Settings. */
Hooks.on("renderSettings", (_app, html) => {
  if ( !canBrowse() ) return;
  const section = html.querySelector("section.settings");
  if ( !section || section.querySelector(".dimancer-files-open") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dimancer-files-open";
  button.innerHTML = `<i class="fa-solid fa-folder-tree" inert></i> ${game.i18n.localize("DIMANCER_FILES.Title")}`;
  button.addEventListener("click", openManager);
  section.querySelector("h4")?.after(button);
});
