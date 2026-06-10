# snippit-good

A lightweight Windows screenshot utility built for speed: snip with a shortcut, keep your last
three snips in a small floating bar in the lower-left corner, annotate in one click, copy to
clipboard and move on.

## Install

Grab the latest installer from
[**Releases**](https://github.com/cwbrandsdal/snippit-good/releases/latest)
(`snippit-good-Setup-x.y.z.exe`), run it, done — snippit-good starts automatically and lives in
the system tray. Press **Ctrl+Shift+S** (configurable) anywhere to snip.

> Windows SmartScreen may warn because the installer is not code-signed (this is a free,
> open-source project). Click **More info → Run anyway**.

**Auto-update:** the app checks GitHub Releases shortly after launch and every 4 hours, downloads
new versions in the background, and applies them the next time the app restarts (or immediately
via the tray's *Restart to update* item).

## Run from source

```powershell
npm install
npm start
```

Icons are generated from `assets/icon-source.png` and committed; after changing the artwork run
`npm run gen-icon` to regenerate every size (window/tray PNGs + the installer `.ico`).

## How it works

1. **Press the shortcut** — the screen dims and freezes (all monitors).
2. **Drag** to select an area. Marching-ants border, live size readout. `Esc` or right-click cancels;
   tiny accidental drags are ignored.
3. **Release** — the snip is **copied to the clipboard** (on by default, can be turned off) and
   lands in the recent-snips bar, lower-left, above the taskbar. The newest snip gets a mint
   "NEW" ring. The bar keeps the **last 3** snips, lingers for ~10 seconds, then fades away on
   its own — hover it to keep it around, or pin it open with the pin button.
4. **Hover a thumbnail** for actions: edit, copy to clipboard, remove. Clicking the
   thumbnail opens the editor.
5. **Editor** — pen, highlighter, rectangle, circle, line, arrow, text, and pixelate, with colour
   and stroke-width pickers, undo/redo (`Ctrl+Z` / `Ctrl+Y`), zoom (`Ctrl+wheel`), crop/reset, save
   to PNG (`Ctrl+S`), and **Copy to clipboard** (`Ctrl+C`).

## Settings

Open from the bar's gear icon or the tray menu:

- **Capture shortcut** — click the field and press a new combination. Falls back safely if the
  combination can't be registered.
- **Copy on capture** — automatically put every new snip on the clipboard.

Settings persist in `%APPDATA%/snippit-good/settings.json`; recent snips in
`%APPDATA%/snippit-good/snips/` (only the latest three are kept).

## Editor shortcuts

| Key | Action |
| --- | --- |
| `P` `H` `R` `C` `L` `A` `T` `X` | Pen, Highlight, Rectangle, Circle, Line, Arrow, Text, Pixelate |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+C` | Copy result to clipboard |
| `Ctrl+S` | Save as PNG |
| `Ctrl+wheel` | Zoom |
| `Esc` | Cancel current shape / crop mode |

## Project layout

```
src/
  main/main.js          app lifecycle, capture, tray, global shortcut, snip store
  preload/preload.js    contextBridge IPC surface
  renderer/
    overlay/            fullscreen snipping overlay (one per display)
    bar/                floating recent-snips bar
    editor/             annotation editor (vector op-list over the base image)
    settings/           shortcut recorder + options
scripts/gen-icon.js     generates assets/icon.png + tray.png (hand-rolled PNG encoder)
```

Run `npm run smoke` for a launch check (starts, then exits after 2.5 s).
Run `npx electron . --selftest` for the full synthetic-input regression suite (drives capture,
bar, editor and overlay with fake mouse input and screenshots each window to `.selftest/`).

## Releasing (maintainers)

Releases are built and published automatically by GitHub Actions when a version tag is pushed:

```powershell
npm version patch   # or minor / major — bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```

The [Release workflow](.github/workflows/release.yml) builds the NSIS installer on
`windows-latest` and publishes it together with `latest.yml` (the auto-updater feed) to a GitHub
Release. Installed apps pick the new version up automatically. CI also builds (without
publishing) on every push and PR to `main`.

## License

[MIT](LICENSE)
