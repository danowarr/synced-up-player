// main.js
// Electron's "main process" — this is the Node.js side of the app.
// It owns the window and talks to mpv directly. The UI (renderer process)
// never touches mpv itself; it only sends messages over IPC and this file
// decides what to actually do.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const mpvAPI = require('node-mpv');
const { StreamRecorder } = require('./recorder');
const { startLocalServer } = require('./localServer');
const { KodiPlayer } = require('./kodiPlayer');
const { saveKodiCredentials, loadKodiCredentials, clearKodiCredentials } = require('./credentialStore');

// Where mpv actually comes from, in priority order:
//   1. A bundled binary shipped alongside a packaged build (resources/mpv/).
//      This is what makes a built release "just work" for someone who
//      downloads it — no PATH setup, no hunting for the .exe.
//   2. MPV_BINARY_PATH env var — for development, so nobody's personal
//      Downloads folder path ends up hardcoded and committed to the repo.
//      Set this once in your own shell profile, or pass it inline:
//        Windows (PowerShell): $env:MPV_BINARY_PATH="C:\path\to\mpv.exe"; npm start
//        macOS/Linux:          MPV_BINARY_PATH=/path/to/mpv npm start
//   3. Bare "mpv" — relies on it being resolvable via PATH. Fragile (see
//      the PATH troubleshooting in the README), kept only as a last resort.
function resolveMpvBinary() {
  if (app.isPackaged) {
    const bundled = path.join(
      process.resourcesPath,
      'mpv',
      process.platform === 'win32' ? 'mpv.exe' : 'mpv'
    );
    if (fs.existsSync(bundled)) return bundled;
    console.warn(`Bundled mpv not found at ${bundled} — falling back to PATH.`);
  }

  if (process.env.MPV_BINARY_PATH) return process.env.MPV_BINARY_PATH;

  return process.platform === 'win32' ? 'mpv.exe' : 'mpv';
}

const MPV_BINARY = resolveMpvBinary();

// Same reasoning as resolveMpvBinary() above, same fallback order.
function resolveFfmpegBinary() {
  if (app.isPackaged) {
    const bundled = path.join(
      process.resourcesPath,
      'ffmpeg',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    );
    if (fs.existsSync(bundled)) return bundled;
    console.warn(`Bundled ffmpeg not found at ${bundled} — falling back to PATH.`);
  }

  if (process.env.FFMPEG_BINARY_PATH) return process.env.FFMPEG_BINARY_PATH;

  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

const FFMPEG_BINARY = resolveFfmpegBinary();
const BUFFER_ROOT = path.join(app.getPath('userData'), 'stream-buffers');

const recorders = {
  tv: new StreamRecorder('tv', FFMPEG_BINARY, BUFFER_ROOT),
  radio: new StreamRecorder('radio', FFMPEG_BINARY, BUFFER_ROOT),
};

let mainWindow;
let players = {}; // { tv: mpvInstance, radio: mpvInstance }
let localHttpServer = null;
let localHttpPort = null;

// --- Stall-lock sync engine ---
// The whole point of this app: when one stream buffers, pause the other
// so they don't drift apart, then resume both once the stalled one
// catches up. This is deliberately the simplest possible version —
// manual offset alignment and drift correction (audio fingerprinting)
// come later, on top of this.

const bufferState = { tv: false, radio: false };  // is this player currently buffering?
const autoPaused = { tv: false, radio: false };   // is this player paused BY our sync logic (vs. the user)?
const pausedState = { tv: null, radio: null };    // actual current pause state, from mpv itself (null = unknown yet)

function otherLabel(label) {
  return label === 'tv' ? 'radio' : 'tv';
}

// Called whenever mpv reports a change in its 'paused-for-cache' property
// for a given player — mpv sets this to true itself whenever it stalls
// out waiting for more data, independent of anything we command.
function handleBufferChange(label, isBuffering, latencyMs = 0, recoveryAdvanceSeconds = 0) {
  bufferState[label] = isBuffering;
  const other = otherLabel(label);
  const otherPlayer = players[other];
  if (!otherPlayer) return;

  if (isBuffering) {
    // label just started buffering — pause the OTHER stream so it
    // doesn't run ahead while this one catches up. But only take
    // responsibility for it (and later auto-resuming it) if it was
    // actually playing right now — if the user had already paused it
    // themselves, leave that alone rather than relabeling their manual
    // pause as ours to auto-resume later.
    if (!autoPaused[other] && pausedState[other] === false) {
      otherPlayer.pause();
      autoPaused[other] = true;
      console.log(`[sync] ${label} buffering — auto-pausing ${other}`);

      // If detecting this stall took real measurable time (currently
      // only Kodi reports this — mpv's own paused-for-cache arrives
      // near-instantly via property observation, so it has nothing
      // meaningful to correct for), the OTHER stream kept playing that
      // whole time and is now ahead by roughly that amount. Seek it
      // back to correct for our own detection delay, not just the
      // underlying stall itself.
      if (latencyMs > 0 && typeof otherPlayer.seek === 'function') {
        const offsetSeconds = -(latencyMs / 1000);
        otherPlayer.seek(offsetSeconds).catch((err) => {
          // Not fatal — the stall-lock pause/resume still works fine
          // without this correction, it's just a bit less precise.
          console.warn(`[sync] failed to seek ${other} back ${-offsetSeconds}s to correct for detection latency:`, err.message);
        });
        console.log(`[sync] correcting ${other} back ${-offsetSeconds}s for ${label}'s detection latency`);
      }
    }
  } else {
    // label recovered. If our own sync logic is what's holding the
    // other stream paused, release it. (If the user paused it manually,
    // autoPaused[other] was never set to true for it, so this correctly
    // leaves it alone.)
    if (autoPaused[other]) {
      autoPaused[other] = false;

      // Unlike the onset correction above, this isn't an estimate —
      // recoveryAdvanceSeconds is the exact distance the source moved
      // before we noticed it recovering (see kodiPlayer.js's _poll()).
      // Seek BEFORE resuming, so playback comes back already caught up
      // instead of visibly jumping right after resuming.
      if (recoveryAdvanceSeconds > 0 && typeof otherPlayer.seek === 'function') {
        console.log(`[sync] ${label} recovered — catching ${other} up ${recoveryAdvanceSeconds.toFixed(2)}s before resuming`);
        otherPlayer.seek(recoveryAdvanceSeconds)
        otherPlayer.play()
          .catch((err) => {
            // Not fatal — resuming still works fine without this
            // correction, it's just a bit less precise.
            console.warn(`[sync] failed to seek ${other} forward ${recoveryAdvanceSeconds.toFixed(2)}s to catch up:`, err.message);
          })
          .finally(() => otherPlayer.play());
      } else {
        console.log(`[sync] ${label} recovered — resuming ${other}`);
        otherPlayer.play();
      }
    }
  }

  broadcastSyncStatus();
}

function broadcastSyncStatus() {
  if (!mainWindow) return;
  mainWindow.webContents.send('sync-status', {
    tv: { buffering: bufferState.tv, autoPaused: autoPaused.tv },
    radio: { buffering: bufferState.radio, autoPaused: autoPaused.radio },
  });
}

// Known limitation, worth knowing about rather than being surprised by:
// if TV and radio both start buffering at the same moment, each will
// try to auto-pause the other. That's harmless (they're both already
// stalled anyway) but the bookkeeping above doesn't distinguish "who
// caused what" in that edge case — it can very occasionally resume one
// stream a beat before the other if they recover at different times.
// Not worth solving until it actually causes a problem in practice.

function createWindow() {
  mainWindow = new BrowserWindow({
    x: 40,
    y: 40,
    width: 640,
    height: 760,
    minWidth: 500,
    minHeight: 600,
    webPreferences: {
      // The renderer (index.html) can't require() Node modules directly —
      // that's a deliberate Electron security boundary. preload.js is the
      // one file allowed to bridge the two sides, via contextBridge.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

// Creates one mpv instance. Called twice — once for 'tv', once for
// 'radio' — each gets its own IPC pipe/socket so they don't collide.
// node-mpv 1.5.0 spawns mpv synchronously inside the constructor; there's
// no async start() to await in this version.
function createMpvPlayer(label) {
  const options = {
    audio_only: label === 'radio', // radio never needs a video decode path
    binary: MPV_BINARY,
  };

  // Each instance needs its OWN pipe/socket — sharing one between two
  // mpv processes would make them fight over the same control channel.
  options.socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\mpv-${label}-pipe`
    : `/tmp/mpv-${label}.sock`;

  // mpv opens its own native window for video — Electron has no control
  // over that window once it exists. Rather than fight window-stacking
  // order (which mpv would "win" and land behind Electron on some
  // platforms), we just give it a fixed spot to the right of the control
  // window at (700, 40) so the two never overlap in the first place.
  // Radio never opens a video window at all (audio_only above), so it
  // doesn't need any of this.
  const mpvArgs = ['--idle=yes'];
  if (label === 'tv') {
    mpvArgs.push('--force-window=yes', '--geometry=800x450+700+40');
  }

  try {
    const player = new mpvAPI(options, mpvArgs);
    console.log(`mpv (${label}) instance created`);
    return player;
  } catch (err) {
    console.error(`Failed to create mpv (${label}) instance — check MPV_BINARY path above.`, err);
    return null;
  }
}

// Wires up status forwarding + the sync engine for whichever player
// backend is behind a given label. Called once per mpv instance at
// startup below, and called again whenever a KodiPlayer is connected
// for 'tv' — same function either way, since both backends emit the
// same 'statuschange' shape.
function attachPlayerListeners(label, player) {
  // 'paused-for-cache' isn't observed by default on mpv — ask it to
  // start reporting it. KodiPlayer has no such method (it just always
  // includes cachepercentage in its own poll), so this is skipped for
  // that backend automatically.
  if (typeof player.observeProperty === 'function') {
    player.observeProperty('paused-for-cache', 1);
  }

  player.on('statuschange', (status) => {
    if (mainWindow) mainWindow.webContents.send(`${label}-status`, status);

    if (typeof status.pause === 'boolean') {
      pausedState[label] = status.pause;
    }

    if (typeof status['paused-for-cache'] === 'boolean') {
      handleBufferChange(label, status['paused-for-cache'], status.bufferingLatencyMs || 0, status.recoveryAdvanceSeconds || 0);
    }
  });

  player.on('stopped', () => {
    if (mainWindow) mainWindow.webContents.send(`${label}-status`, { stopped: true });
  });
}

app.whenReady().then(async () => {
  createWindow();

  fs.mkdirSync(BUFFER_ROOT, { recursive: true });
  try {
    const { server, port } = await startLocalServer(BUFFER_ROOT);
    localHttpServer = server;
    localHttpPort = port;
    console.log(`[localServer] serving ${BUFFER_ROOT} on http://127.0.0.1:${port}`);
  } catch (err) {
    console.error('[localServer] failed to start — buffered playback will not work.', err);
  }

  players.tv = createMpvPlayer('tv');
  players.radio = createMpvPlayer('radio');

  for (const label of ['tv', 'radio']) {
    const player = players[label];
    if (!player) continue; // construction failed and already logged why
    attachPlayerListeners(label, player);
  }
});

// --- IPC handlers: these are the only things the UI is allowed to ask for ---
// player.load/play/pause are synchronous in this node-mpv version (they
// just write to the IPC socket), but keeping these handlers async costs
// nothing and means this code won't need to change if you swap in a
// version where they do return promises.

function registerPlayerHandlers(label) {
  ipcMain.handle(`${label}-load`, async (_event, url) => {
    const player = players[label];
    if (!player) throw new Error(`mpv (${label}) is not running — check the main process console for why.`);
    if (typeof player.load !== 'function') {
      throw new Error(`This backend doesn't support Load — start playback there directly, then Connect.`);
    }

    // Don't play the raw URL directly. Instead, start (or restart) a
    // local recording of it — see recorder.js — and once there's enough
    // local buffer to start from, point mpv at that instead. This is
    // what gives pause/catch-up a real multi-minute backlog to work
    // with, instead of hitting the upstream's live edge in seconds.
    const recorder = recorders[label];
    recorder.start(url);
    await recorder.waitUntilReady();

    if (localHttpPort === null) {
      throw new Error('Local buffer server is not running — check the main process console for why.');
    }

    // NOT recorder.playlistPath (a raw filesystem path) — mpv doesn't
    // reload a local file's contents to notice new segments the
    // recorder has written since it opened it. Going through our own
    // localhost server puts mpv on the same reload codepath it uses for
    // any live network playlist, which it DOES handle correctly.
    const localUrl = `http://127.0.0.1:${localHttpPort}/${label}/live.m3u8`;
    player.load(localUrl);
    return { ok: true };
  });

  ipcMain.handle(`${label}-play`, async () => {
    const player = players[label];
    if (!player) throw new Error(`mpv (${label}) is not running — check the main process console for why.`);
    player.play();
    return { ok: true };
  });

  ipcMain.handle(`${label}-pause`, async () => {
    const player = players[label];
    if (!player) throw new Error(`mpv (${label}) is not running — check the main process console for why.`);
    player.pause();
    return { ok: true };
  });

  // Used for manual align now (nudge one stream ahead until they line
  // up by ear), and this is the exact same primitive the future
  // fingerprint-based drift correction will call automatically instead
  // of you clicking a button — same mechanism, different trigger.
  ipcMain.handle(`${label}-set-speed`, async (_event, value) => {
    const player = players[label];
    if (!player) throw new Error(`mpv (${label}) is not running — check the main process console for why.`);
    player.setProperty('speed', value);
    return { ok: true };
  });

  ipcMain.handle(`${label}-toggle-mute`, async () => {
    const player = players[label];
    if (!player) throw new Error(`mpv (${label}) is not running — check the main process console for why.`);
    player.toggleMute();
    return { ok: true };
  });

  ipcMain.handle(`${label}-set-volume`, async (_event, value) => {
    const player = players[label];
    if (!player) throw new Error(`mpv (${label}) is not running — check the main process console for why.`);
    player.volume(value); // 0-100
    return { ok: true };
  });

  // Fullscreen only really means anything for a player with a video
  // window — radio's mpv instance never opens one — but the handler
  // works the same way for either, so it isn't restricted here. The UI
  // simply doesn't add a fullscreen button for radio.
  ipcMain.handle(`${label}-toggle-fullscreen`, async () => {
    const player = players[label];
    if (!player) throw new Error(`mpv (${label}) is not running — check the main process console for why.`);
    player.cycleProperty('fullscreen');
    return { ok: true };
  });
}

registerPlayerHandlers('tv');
registerPlayerHandlers('radio');

// TV-only: swaps players.tv from the mpv instance over to a KodiPlayer
// controlling an already-running Kodi install. No recorder/localServer
// involved — Kodi manages its own buffering entirely, which is the
// whole reason this backend exists in the first place.
//
// Known rough edge: the original mpv 'tv' process keeps running idle in
// the background rather than being torn down — switching back to mpv
// later is cheap, but it does mean an empty mpv window may be visible
// simultaneously while using the Kodi backend. Worth cleaning up later,
// not blocking for a first working version.
ipcMain.handle('tv-connect-kodi', async (_event, { host, port, username, password }) => {
  const kodi = new KodiPlayer({ host, port, username, password });
  await kodi.connect(); // throws with a clear message if this fails
  players.tv = kodi;
  attachPlayerListeners('tv', kodi);
  console.log(`[kodi] connected to ${host}:${port}`);
  return { ok: true };
});

// Credential persistence — separate from connecting itself. The
// renderer decides when to save (only after a successful connect, and
// only if the user opted in), never automatically.
ipcMain.handle('kodi-save-credentials', async (_event, creds) => {
  await saveKodiCredentials(creds); // throws its own clear error if unavailable — see credentialStore.js
  return { ok: true };
});

ipcMain.handle('kodi-load-credentials', async () => {
  return loadKodiCredentials(); // null if nothing saved, or if decryption failed
});

ipcMain.handle('kodi-clear-credentials', async () => {
  clearKodiCredentials();
  return { ok: true };
});

app.on('window-all-closed', async () => {
  for (const label of ['tv', 'radio']) {
    recorders[label].stop();
    const player = players[label];
    if (player) {
      try { await player.quit(); } catch (_) {}
    }
  }
  if (localHttpServer) {
    try { localHttpServer.close(); } catch (_) {}
  }
  // Clean up local buffer files rather than leaving hundreds of MB of
  // .ts segments sitting in userData between sessions.
  try { fs.rmSync(BUFFER_ROOT, { recursive: true, force: true }); } catch (_) {}
  if (process.platform !== 'darwin') app.quit();
});
