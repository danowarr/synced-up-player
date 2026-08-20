// renderer.js
// This runs in the browser-like window and can ONLY talk to mpv through
// window.api, which preload.js defined. No direct Node/mpv access here.

// Shared across wireUpPlayer() and the Kodi connect wiring below, since
// connecting to Kodi also needs to mark 'tv' as loaded — and that
// button lives outside wireUpPlayer's own closure.
const loadedState = { tv: false, radio: false };

// Wires up one section's (tv or radio) buttons and status display. Called
// twice below — same pattern as playerAPI() in preload.js and
// createMpvPlayer() in main.js. Mute and volume apply to both; fullscreen
// only wires up if that button actually exists in this section's markup
// (radio has no video window, so its section has no fullscreen button).
function wireUpPlayer(label) {
  const api = window.api[label];
  const urlInput = document.getElementById(`${label}UrlInput`);
  const statusDiv = document.getElementById(`${label}Status`);
  const muteBtn = document.getElementById(`${label}MuteBtn`);
  const fullscreenBtn = document.getElementById(`${label}FullscreenBtn`);
  const volumeSlider = document.getElementById(`${label}VolumeSlider`);

  // mpv reports a default status (including pause: false) as soon as
  // the idle process exists, well before anything is actually loaded —
  // without this guard, that default chatter overwrites "Idle — nothing
  // loaded yet." with "playing" before you've even pasted a URL.

  document.getElementById(`${label}LoadBtn`).addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      statusDiv.textContent = 'Paste a URL first.';
      return;
    }
    statusDiv.textContent = 'Building local buffer... (takes ~15-20s)';
    try {
      await api.loadStream(url);
      loadedState[label] = true;
    } catch (err) {
      statusDiv.textContent = 'Failed to load: ' + err.message;
    }
  });

  document.getElementById(`${label}PlayBtn`).addEventListener('click', () => {
    api.play();
  });

  document.getElementById(`${label}PauseBtn`).addEventListener('click', () => {
    api.pause();
  });

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      api.toggleMute();
    });
  }

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
      api.toggleFullscreen();
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      api.setVolume(Number(volumeSlider.value));
    });
  }

  api.onStatus((status) => {
    if (!loadedState[label]) return; // ignore backend default status until a real load/connect happens
    if (status.stopped) {
      statusDiv.textContent = 'Stopped.';
      return;
    }
    const parts = [];
    if (typeof status.pause === 'boolean') parts.push(status.pause ? 'paused' : 'playing');
    if (typeof status.position === 'number') parts.push(`${status.position.toFixed(1)}s`);
    statusDiv.textContent = parts.length ? parts.join(' · ') : JSON.stringify(status);
  });
}

wireUpPlayer('tv');
wireUpPlayer('radio');

// TV backend toggle — mpv (paste a link) vs Kodi (connect to a running
// instance). Kodi doesn't "load" anything; you start playback there
// yourself and this just takes over control of it.
const tvMpvFields = document.getElementById('tvMpvFields');
const tvKodiFields = document.getElementById('tvKodiFields');
const tvStatusDiv = document.getElementById('tvStatus');
const tvFullscreenBtn = document.getElementById('tvFullscreenBtn')

function updateTvBackendFields() {
  const useKodi = document.getElementById('tvBackend').value === 'kodi';
  tvMpvFields.style.display = useKodi ? 'none' : '';
  tvKodiFields.style.display = useKodi ? '' : 'none';
  tvFullscreenBtn.style.display = useKodi ? 'none' : '';
}

document.getElementById('tvBackend').addEventListener('change', updateTvBackendFields);

// Prefill saved Kodi connection details, if any exist and decrypted
// successfully. Password included — this app already trusts the
// renderer with the plaintext password the moment you type it into the
// field in the first place, so prefilling it back is the same trust
// boundary, not a new exposure.
(async () => {
  try {
    const saved = await window.api.tv.loadKodiCredentials();
    if (saved) {
      document.getElementById('kodiHost').value = saved.host || '';
      document.getElementById('kodiPort').value = saved.port || '8080';
      document.getElementById('kodiUsername').value = saved.username || '';
      document.getElementById('kodiPassword').value = saved.password || '';
      document.getElementById('kodiRememberCheckbox').checked = true;
    }
  } catch (err) {
    console.error('[kodi] failed to load saved credentials:', err.message);
  }
})();

document.getElementById('kodiConnectBtn').addEventListener('click', async () => {
  const host = document.getElementById('kodiHost').value.trim();
  const port = document.getElementById('kodiPort').value.trim() || '8080';
  const username = document.getElementById('kodiUsername').value.trim();
  const password = document.getElementById('kodiPassword').value;
  const remember = document.getElementById('kodiRememberCheckbox').checked;

  if (!host) {
    tvStatusDiv.textContent = 'Enter a Kodi host first.';
    return;
  }

  tvStatusDiv.textContent = 'Connecting...';
  try {
    await window.api.tv.connectKodi(host, port, username, password);
    loadedState.tv = true;
    tvStatusDiv.textContent = 'Connected to Kodi.';

    // Only save on a CONFIRMED successful connect — never save
    // credentials that might just be a typo.
    if (remember) {
      try {
        await window.api.tv.saveKodiCredentials(host, port, username, password);
      } catch (saveErr) {
        // Connect succeeded, but saving failed (e.g. no OS keyring
        // available — see credentialStore.js). Don't hide this behind
        // the "Connected" message, since it means next launch will
        // need the password typed in again despite the checkbox.
        tvStatusDiv.textContent = `Connected to Kodi, but couldn't save: ${saveErr.message}`;
      }
    }
  } catch (err) {
    tvStatusDiv.textContent = 'Failed to connect: ' + err.message;
  }
});

document.getElementById('kodiForgetLink').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await window.api.tv.clearKodiCredentials();
    document.getElementById('kodiPassword').value = '';
    document.getElementById('kodiRememberCheckbox').checked = false;
    tvStatusDiv.textContent = 'Saved Kodi credentials cleared.';
  } catch (err) {
    tvStatusDiv.textContent = 'Failed to clear saved credentials: ' + err.message;
  }
});

// Sync banner — reflects what main.js's stall-lock logic is doing, so an
// auto-pause doesn't look like a mystery freeze in the UI.
const syncBanner = document.getElementById('syncBanner');

window.api.onSyncStatus((status) => {
  const { tv, radio } = status;

  if (tv.buffering) {
    syncBanner.textContent = radio.autoPaused
      ? 'Sync: TV is buffering — radio paused, waiting for it to catch up.'
      : 'Sync: TV is buffering.';
    syncBanner.classList.add('locked');
  } else if (radio.buffering) {
    syncBanner.textContent = tv.autoPaused
      ? 'Sync: Radio is buffering — TV paused, waiting for it to catch up.'
      : 'Sync: Radio is buffering.';
    syncBanner.classList.add('locked');
  } else {
    syncBanner.textContent = 'Sync: both streams healthy.';
    syncBanner.classList.remove('locked');
  }
});

// Manual align — nudge whichever stream is behind by speeding it up a
// bit until the user toggles it back off. Only one stream nudges at a
// time — speeding up "the one that's behind" is equivalent to slowing
// down the other, and this avoids the two fighting each other by
// accident.
//
// Two different speed values, not one: mpv accepts a continuous speed
// (1.5 = gentle, pitch-corrected, doesn't sound chipmunked) but Kodi's
// Player.SetSpeed only accepts specific step values — every real-world
// example is an integer like 2 or 4, not something like 1.5, and 1.5
// silently does nothing against Kodi. 2x is the smallest step that
// actually works there, so expect the Kodi nudge to feel like a much
// bigger, more noticeable jump than the mpv one — that's an inherent
// difference between the backends, not a bug to chase further right now.
const NUDGE_SPEED_MPV = 1.5;
const NUDGE_SPEED_KODI = 2;
const DISPLAY_NAME = { tv: 'TV', radio: 'radio' };

function currentNudgeSpeed(label) {
  // Only 'tv' can ever be Kodi-backed — radio is always mpv.
  if (label === 'tv' && document.getElementById('tvBackend').value === 'kodi') {
    return NUDGE_SPEED_KODI;
  }
  return NUDGE_SPEED_MPV;
}

function setupNudgeButton(label, otherLabel) {
  const btn = document.getElementById(`${label}NudgeBtn`);
  const otherBtn = document.getElementById(`${otherLabel}NudgeBtn`);
  let active = false;

  btn.addEventListener('click', async () => {
    active = !active;
    const speed = active ? currentNudgeSpeed(label) : 1.0;
    console.log(`[nudge] ${label} click — active=${active}, sending speed=${speed}`);
    btn.classList.toggle('active', active);
    btn.textContent = active
      ? `Nudging ${DISPLAY_NAME[label]}... click to stop`
      : `Nudge ${DISPLAY_NAME[label]} ahead`;

    try {
      await window.api[label].setSpeed(speed);
    } catch (err) {
      // Previously this failed completely silently — a rejected speed
      // value (e.g. mpv's 1.5 against Kodi, which only accepts certain
      // step values) just did nothing with no indication why. Surface
      // it instead, even though there's no dedicated error slot for the
      // nudge buttons specifically — the browser console is enough to
      // stop this from looking like a mystery next time.
      console.error(`[nudge] setSpeed(${speed}) failed for ${label}:`, err.message);
    }

    // If the other stream was mid-nudge, stop it first — nudging both
    // at once doesn't accomplish anything useful.
    if (active && otherBtn.classList.contains('active')) {
      otherBtn.click();
    }
  });
}

setupNudgeButton('tv', 'radio');
setupNudgeButton('radio', 'tv');
