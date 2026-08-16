// renderer.js
// This runs in the browser-like window and can ONLY talk to mpv through
// window.api, which preload.js defined. No direct Node/mpv access here.

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
  let hasLoaded = false;

  document.getElementById(`${label}LoadBtn`).addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      statusDiv.textContent = 'Paste a URL first.';
      return;
    }
    statusDiv.textContent = 'Building local buffer... (takes ~15-20s)';
    try {
      await api.loadStream(url);
      hasLoaded = true;
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
    if (!hasLoaded) return; // ignore mpv's idle-mode default status until a real load happens
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
// bit (mpv pitch-corrects by default, so this doesn't sound chipmunked)
// until the user toggles it back off. Only one stream nudges at a time —
// speeding up "the one that's behind" is equivalent to slowing down the
// other, and this avoids the two fighting each other by accident.
const NUDGE_SPEED = 1.5;
const DISPLAY_NAME = { tv: 'TV', radio: 'radio' };

function setupNudgeButton(label, otherLabel) {
  const btn = document.getElementById(`${label}NudgeBtn`);
  const otherBtn = document.getElementById(`${otherLabel}NudgeBtn`);
  let active = false;

  btn.addEventListener('click', () => {
    active = !active;
    window.api[label].setSpeed(active ? NUDGE_SPEED : 1.0);
    btn.classList.toggle('active', active);
    btn.textContent = active
      ? `Nudging ${DISPLAY_NAME[label]}... click to stop`
      : `Nudge ${DISPLAY_NAME[label]} ahead`;

    // If the other stream was mid-nudge, stop it first — nudging both
    // at once doesn't accomplish anything useful.
    if (active && otherBtn.classList.contains('active')) {
      otherBtn.click();
    }
  });
}

setupNudgeButton('tv', 'radio');
setupNudgeButton('radio', 'tv');
