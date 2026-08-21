# Synced Up Player

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/danowarr/synced-up-player?include_prereleases)](https://github.com/danowarr/synced-up-player/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational)](#getting-started)
[![Built with Electron](https://img.shields.io/badge/Electron-43-9FEAF9?logo=electron&logoColor=black)](https://www.electronjs.org/)

A local, on-device tool for keeping a TV stream and a radio broadcast
stream synchronized during a live sports game (or anything else where
you're watching one feed and listening to a separate commentary feed).
Bring-your-own-links — you provide the stream URLs, the app never
fetches, hosts, or rebroadcasts anything itself.

![Screenshot](docs/screenshot.png)


## Features

- Independent TV and radio playback (each its own mpv process)
- **Kodi backend** (TV only, alternative to pasting a link): control an
  already-running Kodi instance instead, including whatever
  DRM-protected content Kodi itself can already play — see "Kodi
  backend" below
- **Stall-lock**: when either stream buffers, the other pauses and waits
- **Local rolling buffer** (mpv backend only): each stream is
  continuously re-recorded locally (via ffmpeg) into a 10-minute
  rolling window before playback, so pausing or catching up has real
  backlog to work with instead of hitting the upstream source's live
  edge after a few tens of seconds
- **Manual align**: nudge whichever stream is behind (temporary
  playback-speed increase) until they line up by ear
- Mute and volume on both streams; fullscreen on TV
- Kodi credentials can be saved (encrypted) so you don't retype them
  every session

## Getting started

**Just want to run it?** Grab a release (zip on Windows, tar.gz on
Linux) — mpv and ffmpeg are bundled in, nothing else to install.
Extract and run.

**Running from source, or building your own release?** You'll need
mpv/ffmpeg installed locally for development — see "Running from
source" below.

## Kodi backend

Instead of pasting a stream URL, the TV side can control an
already-running Kodi instance instead of mpv — useful for anything
Kodi already handles well, including DRM-protected content via
whatever Kodi's own addons (e.g. `inputstream.adaptive`) give you
access to. This app itself never touches DRM either way — Kodi does
the actual decrypting and playing, using access you already have; this
app only ever sends play/pause/speed commands and reads back status.
Radio is unaffected regardless — it's always mpv, always via a pasted
link.

**Setup**: in Kodi, go to Settings → Services → Control and enable
"Allow remote control via HTTP" (Kodi requires a username/password
here even for localhost-only access). In this app, switch the TV
backend dropdown to Kodi, enter the host/port/credentials, start
playback in Kodi itself first, then hit Connect — this doesn't load
anything, it just takes over control of whatever's already playing,
the same idea as pointing a remote at a TV that's already on.

**Saving credentials**: check "Remember (encrypted)" after a
successful connect to skip retyping next time. This uses Electron's
built-in `safeStorage`, not plaintext. On Linux specifically, real
encryption only happens if an OS keyring (GNOME Keyring, KWallet) is
actually running — without one, saving is refused outright with a
clear error rather than silently falling back to a weak scheme. See
the comments in `credentialStore.js` for why that matters.

**How stall detection works, and its real limits**: Kodi doesn't push
a buffering notification the way mpv does, so `kodiPlayer.js` polls
`Player.GetProperties` on a short interval and combines two signals —
`cachepercentage` dipping, confirmed by playback position actually
failing to advance across consecutive polls — before declaring a real
stall. This deliberately trades some detection latency for fewer false
positives; see the comments in `kodiPlayer.js` for the reasoning and
the tunable constants (`CACHE_HEALTHY_THRESHOLD`, `STALL_CONFIRM_POLLS`,
`POLL_INTERVAL_MS`). When a stall is detected, the other stream gets
seeked to correct for however long detection took — an *estimate* on
the way into a stall (a fully-frozen reading can't reveal exactly when
within a poll interval it began; that's a real information limit, not
a tuning problem — see `kodiPlayer.js`'s comments for the proof), and
an *exact* correction coming out of one (a partial position advance on
the recovery poll directly reveals how far the source got ahead).

**Known gap**: very short stutters can still slip through undetected —
the same confirmation window that filters out false positives has a
floor on how brief a real stall it can catch. The likely next step is
a small Kodi addon running in-process (skipping the HTTP round-trip
that's the current dominant source of latency) pushing notifications
out via Kodi's own `JSONRPC.NotifyAll` rather than us polling from
outside — see `kodiPlayer.js`'s file comment for more.

**Known rough edge**: Right now if you connect kodi, you cannot go back
to using mpv player as the tv backend without restarting Synced Up Player.
The next patch will fix this. 

**Two Kodi-specific quirks worth knowing**, both handled in
`kodiPlayer.js`:
- Manual-align nudge only works with specific speed values on Kodi
  (2x, not mpv's gentle 1.5x) — Kodi's `SetSpeed` only accepts certain
  step values for live content, confirmed by testing.
- Returning to normal speed on Kodi needs a forced-resume call right
  after `SetSpeed(1)` — that command alone can report success without
  actually un-fast-forwarding a live stream. Confirmed by testing, not
  just theorized.

## Finding a stream URL to paste

Only relevant for the mpv backend — skip this if you're using Kodi.

This app needs a direct link to an HLS (`.m3u8`) stream for each side —
not a webpage URL. Most sites that embed a live video player don't show
you that link directly; it's a network request the page makes behind
the scenes to actually load the video. Two ways to find it:

**Browser DevTools** (works everywhere, nothing to install)

1. Open DevTools (F12, or Ctrl+Shift+I / Cmd+Option+I) and switch to
   the **Network** tab.
2. Filter by `m3u8`.
3. Start playing the video on the page.
4. Look for a request ending in `.m3u8` in the list — right-click it →
   **Copy → Copy link address**.
5. Paste that into this app.

**Browser extension** (faster, same underlying idea)

[m3u8 Sniffer TV](https://chromewebstore.google.com/detail/m3u8-sniffer-tv-find-and/akkncdpkjlfanomlnpmmolafofpnpjgn)
(Chrome Web Store) watches a page's network requests automatically and
surfaces any `.m3u8` URLs it finds in an overlay, so you don't have to
dig through the Network tab by hand. A similar
[Firefox extension](https://addons.mozilla.org/en-US/firefox/addon/m3u8-sniffer/)
exists too. Neither does anything this app doesn't already do
conceptually — they just automate the same lookup DevTools does
natively.

A few things worth knowing:

- Not every stream uses HLS/`.m3u8` — some use DASH (`.mpd`) instead,
  which this app doesn't currently handle; others are DRM-protected and
  won't work via the mpv backend at all (use the Kodi backend for those
  instead — see above).
- Radio stations often publish their stream URL directly and openly on
  their own site — no sniffing needed for those.
- This only works for content you already have legitimate access to and
  are already watching in your browser. Finding the URL your browser is
  already loading isn't meaningfully different from a browser's
  built-in "Copy Video Address" option on a plain `<video>` element —
  it's just the equivalent for players that don't expose that natively.

## Scope — what this deliberately does NOT do

This app plays streams you provide a direct URL for (mpv backend), or
controls playback in an already-running Kodi instance (Kodi backend).
It does not:

- Fetch, decrypt, or interact with DRM-protected content itself, under
  either backend — the Kodi backend works with DRM content only
  because Kodi does that decrypting on its own, using access you
  already have; this app just sends play/pause/speed commands
- Capture audio/video from other applications or browser tabs
- Host, proxy, or rebroadcast any stream to anyone else

This keeps the app in the same legal category as a generic media
player or remote control (like VLC, mpv, or Kodi's own official remote
apps) rather than a rebroadcasting service. If a stream requires DRM
and you're using the mpv backend, this app simply won't play it —
that's expected, not a bug.

## Not yet implemented

- Persisted offset / automatic drift correction via audio
  fingerprinting, for *structural* drift (e.g. a radio feed that's
  consistently a few minutes behind) — not implemented. Don't confuse
  this with the Kodi stall-latency correction described above, which
  is a different, narrower thing: correcting for our own detection
  delay around a single stall event, not general offset drift between
  two otherwise-healthy sources.
- Kodi stall detection still uses HTTP polling, not Kodi's WebSocket
  push notifications, and can still miss very short stutters — see
  "Kodi backend" above.
- No DRM support in this app itself, under either backend — see
  "Scope" above.
- **macOS** — not attempted. Apple's terms discourage running macOS in
  a VM outside their own hardware, so this needs testing on real Apple
  hardware rather than the way Linux support was verified. If you have
  a Mac and are interested in helping test/build this, that
  contribution would be genuinely useful — open an issue.

## Running from source

Only needed for development or building your own release — skip this
entirely if you just downloaded a bundled release (see "Getting
started" above).

### Prerequisites

- Node.js (18+)
- **mpv** — handles playback
  - macOS: `brew install mpv`
  - Debian/Ubuntu: `sudo apt install mpv`
  - Windows: a build from https://mpv.io/installation/
- **ffmpeg** — handles the local rolling buffer (recorder.js)
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Windows: https://www.gyan.dev/ffmpeg/builds/ (the "essentials" build
    is fine)

Sanity check both work standalone before touching this app:
`mpv --no-video <some-stream-url>` should play audio, and
`ffmpeg -i <some-stream-url>` should print stream info without erroring.
If either fails standalone, nothing above it will work either.

### Setup

```
cd synced-up-player
npm install
```

Both mpv and ffmpeg need to be locatable. In order of priority, each is
looked up via:

1. A bundled binary at `resources/mpv/` or `resources/ffmpeg/` — only
   present in a packaged release build, not when running from source.
2. Environment variables — this is what you want for local development:
   ```
   # Windows (PowerShell)
   $env:MPV_BINARY_PATH="C:\path\to\mpv.exe"
   $env:FFMPEG_BINARY_PATH="C:\path\to\ffmpeg.exe"
   npm start

   # macOS/Linux
   MPV_BINARY_PATH=/path/to/mpv FFMPEG_BINARY_PATH=/path/to/ffmpeg npm start
   ```
3. Bare `mpv`/`ffmpeg` resolved via PATH — works if properly on PATH,
   but this has been the least reliable option in practice (Windows
   PATH edits don't apply to already-open terminals, in particular).

Once both are locatable, `npm start` opens the app. Paste a TV stream
URL and a radio stream URL into their respective sections and hit Load
— expect roughly 15-20 seconds before playback starts, since the app is
building a local buffer before mpv reads from it, not connecting
directly to your pasted URL. (This delay doesn't apply to the Kodi
backend — see "Kodi backend" above.)

## Building a release

### Automated (GitHub Actions)

Pushing a tag matching `v*.*.*` (e.g. `v0.2.1`) triggers
`.github/workflows/release.yml`, which builds both platforms, generates
SHA256 checksums, and publishes a GitHub Release automatically. This is
the normal way to cut a real release — the manual steps below are
mainly useful for local test builds.

**One-time setup required**: there's no automatable source for the
Linux mpv binary (compiled from source by hand — see
`third-party-licenses/README.md` for the exact build details). Host
your own compiled build somewhere stable and set its URL as the
`MPV_LINUX_BINARY_URL` repository variable (Settings → Secrets and
variables → Actions → Variables tab). Windows needs no such setup —
both its binaries come from stable, automatable sources, already
wired into the workflow.

### Manual

Releases bundle the actual mpv/ffmpeg binaries so end users don't have
to install or configure anything (`resolveMpvBinary()`/
`resolveFfmpegBinary()` in main.js check for these first, before falling
back to the dev-mode env vars described above):

1. Drop the binaries in `vendor/mpv/<platform>/` and
   `vendor/ffmpeg/<platform>/` (see `vendor/README.md` for exact paths).
2. Note down exactly which build/version you used — required for the
   GPL "corresponding source" obligation, see
   `third-party-licenses/README.md`.
3. Build for whichever platform you're on:
   - `npm run dist:win` — produces a zip in `dist/`
   - `npm run dist:linux` — produces a tar.gz in `dist/`

   (Plain `npm run dist` auto-detects the current host platform. tar.gz
   was chosen over AppImage deliberately — AppImage needs FUSE
   installed on the user's system, which isn't present by default on
   several current distros; a plain tar.gz has no such dependency.)

Each platform's `extraResources` config (in package.json's `build`
section) pulls from its own `vendor/*/win/` or `vendor/*/linux/`
subfolder independently — building for one platform never touches the
other's binaries. `LICENSE`, `README.md`, and `third-party-licenses/`
are bundled into every release the same way.

**Windows will show a SmartScreen warning** ("Windows protected your
PC") when running the built .exe — expected for any unsigned binary
from a new publisher, not specific to this app. Some antivirus tools
may also flag it heuristically, specifically because it bundles
ffmpeg.exe/mpv.exe — a pattern some real malware droppers also use,
even though there's nothing to it here beyond that surface resemblance.
Click "More info" → "Run anyway" if you trust the source you got the
release from. Code-signing would reduce (not immediately eliminate)
this, but isn't worth the cost/verification overhead for early releases
of a free hobby project.

## How it fits together

**mpv backend:**

```
your pasted URL
      |
      v
ffmpeg (recorder.js) --writes--> local rolling HLS buffer (10 min window)
                                          |
                          served over http://127.0.0.1:<port> (localServer.js)
                                          |
                                          v
                                    mpv (playback)
```

**Kodi backend** (TV only): no local buffer involved — `kodiPlayer.js`
connects directly to Kodi's own JSON-RPC API and polls/commands it;
Kodi manages its own buffering entirely.

Two deliberate design choices worth knowing if you're reading the code:

- **mpv playback never points at your raw URL directly** — it always
  goes through the local recorder first. This is what makes stall-lock
  and manual-align actually useful instead of immediately hitting the
  upstream source's tiny live window.
- **The local buffer is served over HTTP, not read as a raw file path**
  — mpv/ffmpeg's HLS demuxer reliably reloads a *network* playlist to
  notice new segments, but doesn't reload a raw filesystem path the
  same way. Bound strictly to 127.0.0.1; nothing here is ever reachable
  from the network.

## Notes on other design choices

- `contextIsolation: true` / `nodeIntegration: false` in main.js is the
  standard secure Electron setup — the renderer never gets raw Node or
  player access, only the specific functions preload.js exposes.
- Each mpv instance (tv, radio) gets its own IPC pipe/socket and, for
  TV, a fixed screen position (`--geometry`) so its native video window
  doesn't spawn hidden behind the Electron control window.
- `kodiPlayer.js` deliberately mimics node-mpv's method names and event
  shape (`play`, `pause`, `setProperty('speed', v)`, `'statuschange'`
  events) so the sync engine in main.js doesn't need to know or care
  which backend is behind a given player — same reasoning as the
  `pausedState`/`autoPaused` note below.
- The stall-lock logic tracks real pause state (not just "did we issue
  a pause") specifically so a manual pause on one stream never gets
  silently auto-resumed later by the other stream recovering — see the
  comments around `pausedState`/`autoPaused` in main.js if extending
  this.
- `credentialStore.js` checks which storage backend Electron's
  `safeStorage` actually resolved to and refuses to save Kodi
  credentials under Linux's weak fallback (a publicly-known encryption
  key) rather than silently pretending it's secure.
- Whether a source "looks like HLS" (recorder.js's `looksLikeM3U8`) is
  a URL-extension heuristic, not real content-type detection — good
  enough for the sources tested so far, documented as a known
  limitation in the code rather than something to over-engineer early.

## Licensing

This project's own code: MIT (see `LICENSE`). mpv and ffmpeg are
controlled as separate OS processes over IPC — never linked as
libraries — which is why this app's own license doesn't inherit their
GPL terms. Kodi is controlled remotely over its own network API — this
app never bundles or links against Kodi at all. If you build a release
that BUNDLES the actual mpv/ffmpeg binaries rather than requiring the
user to install them, see `third-party-licenses/README.md` for what
that specifically requires.
