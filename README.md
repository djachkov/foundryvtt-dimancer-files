# Dimancer's Files

A file browser for Foundry VTT v14 that replaces the core File Picker everywhere, plus a small
companion service that lets the GM **delete, rename and move** files and folders. Foundry's server
can't do any of those three.

## Install

In Foundry's setup screen: **Add-on Modules → Install Module**, paste this manifest URL, and install:

```
https://github.com/djachkov/foundryvtt-dimancer-files/releases/latest/download/module.json
```

Enable **Dimancer's Files** in your world. Browsing, picking and uploading work right away. To
delete, rename and move files as well, set up [the companion](#the-companion) on the server.

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

**With the companion (GM only):**

- **Delete.** Files and folders go to a trash by default, with Restore. Permanent delete asks twice. The dialog warns when documents still use the files.
- **Folders in the tree:** right-click for New folder inside, Rename, Delete, Copy path and Where is it used?. Double-click a folder to rename it in place (Enter saves, Escape cancels).
- **Rename** (F2) and **move**, by dragging onto a folder (in the list, the tree or the breadcrumbs) or with Move to…. After a rename or move it offers to **update every document** that used the old path: tiles, tokens and their actor data, scene backgrounds, journal pages and their HTML, actor and item images, playlist sounds, settings and so on.
- **Sort by size and date**, plus fast recursive search.

## The companion

Foundry modules run only in the browser, and the Foundry server has no delete, rename or move. In
v14 its only file socket actions are browse, create folder and configure path. So the companion is a
separate small Node script (`companion/server.mjs`) that runs next to Foundry. It uses only Node
built-ins; there is nothing to install.

```bash
FOUNDRY_DATA=/path/to/foundrydata/Data \
DIMANCER_FILES_TOKEN="$(openssl rand -hex 24)" \
node /path/to/foundrydata/Data/modules/dimancer_files/companion/server.mjs
```

| Variable | Default | |
|---|---|---|
| `FOUNDRY_DATA` | (required) | Foundry's **Data** folder (the one holding `worlds/`, `modules/`, `systems/`) |
| `DIMANCER_FILES_TOKEN` | (required, 16+ characters) | Shared secret; the GM enters it in Foundry |
| `PORT` | `30001` | |
| `HOST` | `127.0.0.1` | Keep it local and reach it through your reverse proxy |
| `CORS_ORIGIN` | (none) | Only when the browser reaches it on a different origin, e.g. `http://localhost:30000` in local dev. Comma-separated for several; `localhost` also allows `127.0.0.1` and the other way round |

Module updates replace these files, so restart the companion after updating the module.

**Trying it locally** (no reverse proxy): add `CORS_ORIGIN=http://localhost:30000` (your Foundry address)
and use `http://localhost:30001` as the Address in Foundry.

Then, in Foundry as GM: **Game Settings → Dimancer's Files → File companion → Connect**, or the plug
icon in the browser. Enter the token, press Test, then Save. The token is stored in that browser only.
It is a client setting, because world settings are sent to every player.

### Behind your reverse proxy (recommended)

Serve it at `/dimancer-files/` on Foundry's own site. That way it shares Foundry's HTTPS, and the
Address field stays empty.

nginx:

```nginx
location /dimancer-files/ {
    proxy_pass http://127.0.0.1:30001/;
    client_max_body_size 1m;
}
```

Caddy:

```caddy
handle_path /dimancer-files/* {
    reverse_proxy 127.0.0.1:30001
}
```

If Foundry runs under a route prefix, the client asks for `/<prefix>/dimancer-files/…`; proxy that
path instead. The service accepts the prefix with or without stripping.

### Run it as a service

systemd (`/etc/systemd/system/dimancer-files.service`). Use **the same user Foundry runs as**, or it
can't delete the files Foundry wrote:

```ini
[Unit]
Description=dimancer_files companion
After=network.target

[Service]
User=foundry
Environment=FOUNDRY_DATA=/home/foundry/foundrydata/Data
Environment=DIMANCER_FILES_TOKEN=change-me-to-a-long-random-string
ExecStart=/usr/bin/node /home/foundry/foundrydata/Data/modules/dimancer_files/companion/server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Docker, next to e.g. `felddy/foundryvtt`: mount the same data volume and use the same uid/gid:

```yaml
  dimancer-files:
    image: node:24-alpine
    user: "1000:1000"            # the uid:gid that owns Foundry's data
    command: node /data/Data/modules/dimancer_files/companion/server.mjs
    environment:
      FOUNDRY_DATA: /data/Data
      DIMANCER_FILES_TOKEN: change-me-to-a-long-random-string
      HOST: 0.0.0.0              # reachable by the proxy container only; don't publish the port
    volumes:
      - foundry-data:/data
```

### What it refuses

- **Anything outside Data**, including through symbolic links.
- **Hidden names** (starting with `.`).
- **Package structure:**
  - the `worlds`, `modules` and `systems` folders and each package's folder
  - manifests (`world.json`, `module.json`, `system.json`)
  - a world's `data/` (its database) and `packs/`
  - anything inside a module or system except its `storage/` folder
- **Moves and renames that would overwrite something.**
- **Renames that change a file's extension.**

Deleted entries go to `Data/.dimancer-trash/<id>/` with a `manifest.json`. Foundry hides dot-folders,
so the trash never shows up in any picker. Empty it from the Trash view, or delete the folder on the
server.

## Development

```bash
node --test test/*.test.mjs
```

The tests cover:

- path rules
- the companion over HTTP, against a temporary Data folder, including symlink escapes, the trash
  round trip and move/rename collisions
- usage matching and rewriting
- listing, sorting and filtering
- which picker kinds map to which "replace" setting

GitHub Actions runs these tests on every push to `main` and on pull requests (`test.yml`).

**Releasing:** push a version tag, e.g. `git tag v0.2.0 && git push origin v0.2.0`. `release.yml`
runs the tests and writes the version and download URL from the tag into `module.json`. It then
attaches `module.json` and `module.zip` to a GitHub release; the zip includes `companion/`. Foundry
installs and updates from `releases/latest/download/module.json`. The version in the repo's
`module.json` is a placeholder. A release can be rebuilt for an existing tag from the Actions tab.
