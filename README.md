# Dimancer's Files

A file browser for Foundry VTT v14 that replaces the core File Picker everywhere, plus support for a
separately installed companion service that lets the GM **delete, rename and move** files and folders. Foundry's server
can't do any of those three.

## Install

In Foundry's setup screen: **Add-on Modules → Install Module**, paste this manifest URL, and install:

```
https://github.com/djachkov/foundryvtt-dimancer-files/releases/latest/download/module.json
```

Enable **Dimancer's Files** in your world. Browsing, picking and uploading work right away. To
delete, rename and move files as well, install [the companion](#the-companion) on the server.

Requires Foundry VTT v14. It works with any game system.

## What you get

**Without the companion (everyone, within their Foundry file permissions):**

- A folder tree, breadcrumbs, favorites (shared with core's favorites) and the Data / Core Data / S3 sources.
- Thumbnail grid with a size slider, or a details list.
- Multi-select with Ctrl/Shift-click, Ctrl+A and the arrow keys.
- Instant filtering of the folder, or a search through every subfolder.
- A preview panel: image, video or audio, dimensions, size and date.
- Upload several files, or whole folders, by dropping them or with the toolbar buttons. Names that already exist ask once: keep both, replace or skip.
- New folders (toolbar, or right-click a folder) and the private/public folder toggle.
- Dragging an image onto the canvas makes a Tile, as in core.
- **Picker mode.** Every image, sound and file field opens this browser. Double-click or Select returns the path, exactly as core does.
- **Tile Browser.** The canvas Tile Browser (Tiles → Browse) opens it too, with core's asset grid size field. Drag images or videos onto the canvas to place them as tiles.
- **Choose what it replaces.** World settings for image, sound, video, other-file and folder pickers, and the Tile Browser. Unticked kinds open Foundry's own picker. The change applies the next time a picker opens; no reload is needed.
- **Manager mode.** A **File Manager** button in the sidebar's tab strip (always visible, even with the sidebar collapsed), in the Settings sidebar, or Ctrl+Shift+F.
- **Where is it used?** Lists the documents that reference a file or folder: world documents, and compendiums if you turn that on.
- The window header's ⋮ menu always has **Open Foundry's file picker**.
- **Broken links (GM).** Finds documents in the open world that point at files which no longer exist,
  and suggests the file each one became: the same name in a new format in the same folder (a WebP
  conversion), the same path in another letter case, the same name in another folder (moved, or its folder
  renamed), or another folder and format. A suggestion is preselected only when it clearly wins; otherwise
  pick one, or **Choose…** a file by hand. **Fix** updates the documents, the same way a rename does.
  Renames, moves and conversions only update the world they're done in, so **run this in your other worlds
  afterwards**. Open it from the file manager's ⋮ menu or **Game Settings → Dimancer's Files → Find broken
  links**. It reads world documents, and compendiums when "Check compendiums" is on. Links to external sites,
  wildcard token images and template strings are ignored. A path counts as broken only when Foundry answers
  404 for it.
- **Convert to WebP (GM).** Right-click images, or a folder in the tree (it includes subfolders), or use the
  details panel. Each PNG, JPEG, GIF or BMP is re-encoded in your browser at the quality you pick (85 by
  default) and saved as a `.webp` next to it through Foundry's own upload. The documents that use the
  originals are pointed at the WebP files. A summary shows what was saved. Skipped: animated GIFs and PNGs
  (a canvas keeps only the first frame), images whose WebP wouldn't be smaller, the `modules` and `systems`
  folders, and names that already have a `.webp`. Nothing is overwritten. With the companion logged in,
  the originals go to its trash; without it they stay where they are. It needs a browser that can write
  WebP: Chrome, Edge, Firefox and the Foundry desktop app can; Safari can't.

**With the companion (GM only):**

- **Delete.** Files and folders go to the trash, with Restore per item and **Restore All** / **Delete All** (in the trash, or by right-clicking Trash in the sidebar), each confirmed first. Delete All needs the server to allow permanent delete. Permanent delete, when the server allows it, asks twice. The dialog warns when documents still use the files.
- **Folders in the tree:** right-click for New folder inside, Rename, Delete, Copy path and Where is it used?. Double-click a folder to rename it in place (Enter saves, Escape cancels).
- **Rename** (F2) and **move**, by dragging onto a folder (in the list, the tree or the breadcrumbs) or with Move to…. Folders in the tree drag too, to nest one inside another or move it back out (onto its parent or the drive row). After a rename or move it offers to **update every document** that used the old path: tiles, tokens and their actor data, scene backgrounds, journal pages and their HTML, actor and item images, playlist sounds, settings and so on.
- **Sort by size and date**, plus fast recursive search.

## The companion

Foundry modules run only in the browser, and the Foundry server has no delete, rename or move: in v14
its only file actions are browse, create folder and configure path. Those three come from the
**Dimancer's Files companion**, a small Node service you install on the server yourself.

**[djachkov/dimancer-files-companion](https://github.com/djachkov/dimancer-files-companion)**
covers installing it, putting it behind your reverse proxy, running it as a hardened service, and what
it can and can't do.

It is deliberately **not** part of this module. It runs on your server, so its code shouldn't change
whenever Foundry updates a module. You install it and update it yourself, after reading what changed.

Once it runs: **Game Settings → Dimancer's Files → File companion → Connect** (or the plug icon in the
browser). Set its address if it isn't behind your proxy, then **log in** with its secret, once per Foundry
session. The secret is never saved; the login lives in that page's memory and ends on reload, logout or
expiry. What the companion allows is set on the server, and the browser follows it: permanent delete is
off by default (trash only), and changes can be limited to some folders.

This module needs companion **0.2 or newer** (API 2). It checks the version and tells you when one of
the two needs updating.

## Development

```bash
node --test test/*.test.mjs
```

The tests cover:

- usage matching and rewriting
- WebP conversion planning: which files qualify, name clashes, spotting animated GIFs and PNGs
- broken links: pulling paths out of document data and HTML, and ranking suggestions
- listing, sorting and filtering
- which picker kinds map to which "replace" setting

GitHub Actions runs these tests on every push to `main` and on pull requests (`test.yml`).

**Releasing:** push a version tag, e.g. `git tag v0.2.0 && git push origin v0.2.0`. `release.yml`
runs the tests and writes the version and download URL from the tag into `module.json`. It then
attaches `module.json` and `module.zip` to a GitHub release. Foundry
installs and updates from `releases/latest/download/module.json`. The version in the repo's
`module.json` is a placeholder. A release can be rebuilt for an existing tag from the Actions tab.
