# snippit-good

A lightweight Windows screenshot **and screen-recording** utility built for speed: snip with a
shortcut, annotate in one click, copy to clipboard and move on. The same overlay records any
region of the screen to MP4/WebM — press `Tab` to switch between snip and record. **Every
capture is kept** in a storage folder you choose, browsable in a built-in library where you can
re-edit anything and save edits as new variants.

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
2. **Pick a mode** — the overlay opens in **Snip** mode; press `Tab` (or click the pill at the
   top) to switch to **Record**. `Ctrl+Alt+R` (configurable) skips straight to record mode.
3. **Pick the area** — drag a region, or just **hover a window and click**: the window under the
   cursor is highlighted automatically (title + size shown) and a single click captures or
   records its exact bounds. Marching-ants border (mint for snips, red for recordings), live
   size readout. `Esc` or right-click cancels.
4. **Release** —
   - **Snip:** the shot is **copied to the clipboard** (on by default) and lands in the
     recent-captures bar, lower-left, above the taskbar.
   - **Record:** a red frame marks the region and a floating bar appears. By default you get
     time to **prepare**: the desktop stays fully usable, and the frame can be **resized
     (corner/edge handles) and moved (drag its border)** until you press **Record** on the bar
     (or the shortcut again). The bar has live **audio toggles** — mute/unmute **system audio**
     and mute/enable the **microphone**, before or even during the recording (system sound and
     mic are mixed into one track). While recording it shows the elapsed time with
     **pause/resume**, **stop** and **discard**; press the shortcut (either one) or use the tray
     to stop. Prefer zero friction? Turn off *Adjust before recording* in settings and recording
     starts the instant you release the mouse. Recordings are saved as **MP4** (H.264 + AAC)
     when the encoder is available, otherwise WebM, and the finished **file is copied to the
     clipboard** so you can paste it straight into chats.
5. Every capture is **saved permanently** to the storage folder (default
   `Pictures\snippit-good`, configurable) with a readable name like `snip-20260702-101530.png` —
   nothing is deleted automatically. The floating bar shows the **last 3** for quick access,
   lingers ~10 seconds, then fades — hover to keep it, or pin it open.
6. **The library** (click any thumbnail, the bar's clock button, or the tray's *Library*) is one
   window with your **whole history in a scrollable sidebar** — snips, recordings and edits,
   with **edits nested under their original** so a base image and its variants read as one
   family (freshly edited families float to the top). Click an image to annotate it; click a
   recording to play it (copy file / save as / show in folder). Deleting there (or in the bar)
   removes the file for real.
7. **Editor** — pen, highlighter, rectangle, circle, line, arrow, text, and pixelate, with colour
   and stroke-width pickers, undo/redo (`Ctrl+Z` / `Ctrl+Y`), zoom (`Ctrl+wheel`), crop/reset, save
   to PNG (`Ctrl+S`), and **Copy to clipboard** (`Ctrl+C`).
8. **Save to library** stores your annotated result as a **new variant** — the original stays
   untouched, and the variant remembers its annotation ops, so reopening it later lets you keep
   editing (move/remove shapes via undo, add more) as long as the original is still around.

## Settings

Open from the bar's gear icon or the tray menu:

- **Capture shortcut** — click the field and press a new combination. Falls back safely if the
  combination can't be registered.
- **Recording shortcut** — opens the overlay directly in record mode; pressing it (or the capture
  shortcut) during a recording stops it.
- **Default capture** — whether the main shortcut opens in Snip or Record mode (`Tab` always
  switches in the overlay).
- **Adjust before recording** (default on) — after dragging a region, fine-tune it and press
  **Record** when ready; off means recording starts the moment the drag ends.
- **Copy on capture** — automatically put every new snip (or recording file) on the clipboard.
- **Record system audio** — recordings start with system sound on (loopback); the recording bar
  can mute/unmute it live either way.
- **Record microphone** — recordings start with the mic live; even when off, the recording
  bar's mic button can bring it in mid-recording.
- **Audio quality** — Low 64 / Standard 128 / High 192 kbps for the recorded audio track.
- **Storage folder** — where all captures are written (default `Pictures\snippit-good`).
  Changing it affects new captures; existing ones stay where they are and remain in the library.

Settings persist in `%APPDATA%/snippit-good/settings.json`, the library index in
`%APPDATA%/snippit-good/library.json`, thumbnails in `%APPDATA%/snippit-good/thumbs/`.
Recordings auto-stop after 30 minutes as a disk-space guard.

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
  main/main.js          app lifecycle, capture/recording orchestration, tray, shortcuts, library
  main/win-enum.js      PowerShell Win32 helper: app-window bounds for click-a-window snapping
  preload/preload.js    contextBridge IPC surface
  renderer/
    overlay/            fullscreen snipping overlay with snip/record mode (one per display)
    bar/                floating recent-captures bar (newest 3 library items)
    editor/             library window: history sidebar + annotation editor + video playback
    record/             recording HUD: region frame + control bar (hosts the MediaRecorder)
    settings/           shortcut recorders + options
scripts/gen-icon.js     generates assets/icon.png + tray.png (hand-rolled PNG encoder)
```

Recording pipeline: the selected display's `getDisplayMedia` stream is cropped to the region
through a canvas and encoded by a `MediaRecorder` in the (visible, never-throttled) control-bar
window; encoded chunks stream over IPC to the main process, which writes the file as it grows.

Run `npm run smoke` for a launch check (starts, then exits after 2.5 s).
Run `npx electron . --selftest` for the full synthetic-input regression suite (drives capture,
bar, editor, overlay mode toggle, drag-to-record, pause/resume and the player with fake input
and screenshots each window to `.selftest/`).

## Releasing (maintainers)

Releases are built and published automatically by GitHub Actions when a version tag is pushed:

```powershell
npm version patch -m "v%s [version bump]"   # or minor / major — bumps package.json + tags vX.Y.Z
git push --follow-tags
```

The `[version bump]` marker stops the CI workflow from redundantly building the bump commit —
the tag's Release workflow builds that exact commit anyway. (Don't use `[skip ci]` for this:
GitHub applies it to the tag push too and skips the release itself.)

The [Release workflow](.github/workflows/release.yml) builds the NSIS installer on
`windows-latest` and publishes it together with `latest.yml` (the auto-updater feed) to a GitHub
Release. Installed apps pick the new version up automatically. CI also builds (without
publishing) on every push and PR to `main`.

## License

[MIT](LICENSE)
