# snipit-good

A lightweight Windows screenshot **and screen-recording** utility built for speed: snip with a
shortcut, annotate in one click, copy to clipboard and move on. The same overlay records any
region of the screen to MP4/WebM — press `Tab` to switch between snip and record. **Every
capture is kept** in a storage folder you choose, browsable in a built-in library where you can
re-edit anything and save edits as new variants.

## Install

Grab the latest installer from
[**Releases**](https://github.com/cwbrandsdal/snipit-good/releases/latest)
(`snipit-good-Setup-x.y.z.exe`), run it, done — snipit-good starts automatically and lives in
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

Icons are generated from `assets/icon-source.svg` and committed; after changing the artwork run
`npm run gen-icon` to render + round + regenerate every size (window/tray PNGs + the installer `.ico`).

## Sign-in (mtnauth.com)

The app requires an **mtnauth.com** sign-in (WorkOS AuthKit) before anything can be captured:

- **Create an account**: register at [MTN Auth](https://mtnauth.com) before launching the app.
  Use that same account when the hosted sign-in page opens.
- **Flow**: native OAuth 2.0 + PKCE (RFC 8252). Sign-in opens the hosted mtnauth login page in
  your default browser (reusing any existing session), redirects to a loopback listener on
  `127.0.0.1`, and the app exchanges the code directly with WorkOS — no client secret, no
  backend.
- **Config**: the public client ID is baked into the app (`src/main/auth.js`); the
  `SNIPIT_WORKOS_CLIENT_ID` env var exists as an escape hatch. Nothing to configure in
  settings.
- **Redirect URIs**: the loopback callback tries `http://127.0.0.1:39179/auth/callback`
  (already whitelisted for this environment) and falls back to
  `http://127.0.0.1:39184/auth/callback` — add that second one in the WorkOS dashboard
  (Redirects) so sign-in also works while Jotly is running.
- **Session**: the rotating refresh token is stored encrypted with Windows DPAPI
  (Electron `safeStorage`) in `%APPDATA%/snipit-good/auth.json`, verified at boot and
  refreshed periodically. Losing the network does **not** lock the tool — a previously
  verified session keeps working and re-verifies when you're back online; an explicitly
  revoked/expired session signs you out and locks captures until you sign in again.
- Signed out = locked: shortcuts, the bar, the library and the tray capture items all wait
  until you sign in (tray → *Sign in with mtnauth.com…*, or the login window that appears on
  launch). Settings → Account shows who is signed in and has the sign-out button.

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
   `Pictures\snipit-good`, configurable) with a readable name like `snip-20260702-101530.png` —
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

## Share links (snipit-good.io)

Recordings are awkward to email — so every capture can become a **private share link** that
plays in any browser:

- **From the bar**: the link icon on a capture uploads it with default options (30-day link)
  and puts the URL straight on your clipboard.
- **From the library**: **Share link** (on the video player, or in the image toolbar — images
  upload with your annotations baked in) opens a dialog with the full options: expiry
  (1/7/30 days or never), an optional **password**, and an optional **burn after N views**.
- **Manage links** in Settings → *Share links*: see views/expiry, copy again, or **revoke**
  (revoking deletes the upload from the server; your local file is untouched).

How it works: the app asks `snipit-good.io` for an upload slot (authenticated with your
mtnauth.com sign-in), uploads the file **directly to cloud storage**, and gets back an
unguessable link (`snipit-good.io/s/…`, 128-bit random id) served with a noindex viewer page
and range-request streaming. Only signed-in users can create links; anyone with the link (and
the password, if set) can view. Expired, revoked and view-limited shares are deleted from
storage automatically.

The backend service is not part of this repo, but the endpoint is configurable: set
`SNIPIT_SHARE_API` to point the app at any compatible self-hosted service. Everything else in
the app works fully without it.

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
- **Storage folder** — where all captures are written (default `Pictures\snipit-good`).
  Changing it affects new captures; existing ones stay where they are and remain in the library.

Settings persist in `%APPDATA%/snipit-good/settings.json`, the library index in
`%APPDATA%/snipit-good/library.json`, thumbnails in `%APPDATA%/snipit-good/thumbs/`.
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
  main/share.js         share-link uploads: initiate on snipit-good.io, PUT to storage, list/revoke
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
