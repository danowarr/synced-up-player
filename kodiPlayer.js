// kodiPlayer.js
// A player backend that controls an ALREADY-RUNNING Kodi instance over
// its JSON-RPC HTTP API, instead of spawning our own mpv process. Kodi
// handles playback entirely on its own — including any DRM-protected
// content via whatever the user has configured there (e.g.
// inputstream.adaptive). This file only ever sends play/pause/speed
// commands and reads back status. It never sees a stream URL, never
// touches a key, never goes near DRM in any way — Kodi is the one
// doing the actual playback, using access the user already has.
//
// Deliberately shaped to emit the same 'statuschange' event shape
// node-mpv uses ({ pause, 'paused-for-cache', position }), so main.js's
// existing sync engine (handleBufferChange, pausedState, autoPaused)
// works completely unchanged regardless of which backend is behind
// players.tv. Method names (play, pause, setProperty, toggleMute,
// volume, cycleProperty, quit) deliberately match node-mpv's own so the
// existing generic IPC handlers in main.js don't need to know or care
// which backend they're talking to.
//
// Known gaps, worth reading before extending this:
//  - Uses HTTP polling, not Kodi's WebSocket push notifications. Kodi
//    does support a WebSocket transport specifically for real-time
//    events, which would be the "correct" long-term version of this —
//    polling was the pragmatic first choice to avoid requiring users to
//    enable and troubleshoot a second port (9090) on top of the HTTP
//    one they already have working.
//  - setSpeed's exact granularity on Kodi hasn't been fully verified
//    the way play/pause/cachepercentage have (tested together against
//    one real source). Kodi's SetSpeed has historically worked in
//    discrete multiplier steps for some player/content types rather
//    than arbitrary values like mpv's 1.5x — test this specifically
//    against a new source before assuming smooth nudge-align behavior.
//  - Buffering detection combines two signals, not just cachepercentage
//    alone: cachepercentage dipping below CACHE_HEALTHY_THRESHOLD is a
//    coarse pre-filter, confirmed by position actually failing to
//    advance across STALL_CONFIRM_POLLS consecutive polls before
//    declaring a real stall. cachepercentage alone was producing false
//    positives from ordinary buffer-level jitter that never actually
//    froze playback.
//  - Detection-latency correction has two separate, asymmetric halves:
//    ONSET (main.js seeks the other stream BACKWARD when pausing it)
//    uses a midpoint ESTIMATE, because a fully-frozen position reading
//    carries zero information about exactly when within a poll
//    interval the freeze began — this is a real mathematical limit,
//    not something a cleverer formula can fix, only more frequent
//    polling can. RECOVERY (main.js seeks the other stream FORWARD
//    right before resuming it) is exact, not estimated — a PARTIAL
//    position advance on the recovery poll directly reveals how far
//    the source got ahead before we noticed. See the comments in
//    _poll() for the reasoning.

const EventEmitter = require('events');

const POLL_INTERVAL_MS = 200;
const CACHE_HEALTHY_THRESHOLD = 95; // percent; below this counts as "possibly buffering"
const STALL_CONFIRM_POLLS = 2; // consecutive non-advancing polls required before declaring a real stall

class KodiPlayer extends EventEmitter {
  constructor({ host, port, username, password }) {
    super();
    this.baseUrl = `http://${host}:${port}/jsonrpc`;
    this.authHeader = username
      ? 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64')
      : null;
    this.playerId = null;
    this.pollTimer = null;
    this.lastState = { pause: null, bufferingLike: null, position: null };
    this.lastPositionMs = null;
    this.previousPollTime = null; // wall-clock time of the PREVIOUS poll — needed for the onset estimate below
    this.stalledPollCount = 0;
    this.stallStartedAt = null; // estimated wall-clock moment the stall actually began (midpoint estimate — see _poll())
  }

  async _call(method, params = {}) {
    let res;
    try {
      res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authHeader ? { Authorization: this.authHeader } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch (err) {
      throw new Error(`Couldn't reach Kodi at ${this.baseUrl} — check host/port and that its webserver is enabled. (${err.message})`);
    }

    if (res.status === 401) {
      throw new Error('Kodi rejected the username/password (401).');
    }
    if (!res.ok) {
      throw new Error(`Kodi JSON-RPC HTTP ${res.status} calling ${method}.`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`Kodi JSON-RPC error calling ${method}: ${data.error.message}`);
    }
    return data.result;
  }

  // Finds whatever Kodi is currently playing and starts polling it.
  // Doesn't "load" anything — playback has to already be started in
  // Kodi's own UI first; this just connects to it, same idea as
  // pointing a remote at a TV that's already on.
  async connect() {
    const activePlayers = await this._call('Player.GetActivePlayers');
    if (!activePlayers || activePlayers.length === 0) {
      throw new Error('Nothing is playing in Kodi right now — start playback there first, then connect.');
    }
    this.playerId = activePlayers[0].playerid;
    this._startPolling();
    return { ok: true, playerId: this.playerId };
  }

  _startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  async _poll() {
    if (this.playerId === null) return;
    try {
      const pollTime = Date.now();
      const props = await this._call('Player.GetProperties', {
        playerid: this.playerId,
        properties: ['speed', 'cachepercentage', 'time'],
      });

      const pause = props.speed === 0;

      // Millisecond precision matters here — Kodi's Time type actually
      // includes a milliseconds field; dropping it (as an earlier
      // version did) means two polls landing within the same integer
      // second look like "position didn't advance" even during
      // perfectly normal playback, purely from polling granularity.
      const positionMs = props.time
        ? ((props.time.hours * 3600 + props.time.minutes * 60 + props.time.seconds) * 1000)
          + (props.time.milliseconds || 0)
        : null;

      const cacheLow = typeof props.cachepercentage === 'number'
        && props.cachepercentage < CACHE_HEALTHY_THRESHOLD;

      // The real symptom of a stall: position isn't moving despite not
      // being paused. This is a direct measurement, unlike
      // cachepercentage — which is really about the read-ahead buffer
      // level and can dip from ordinary jitter without playback ever
      // actually freezing.
      const positionStalled = !pause
        && positionMs !== null
        && this.lastPositionMs === positionMs;

      // How far position moved since the LAST poll — normal per-poll
      // advance during healthy playback, but also exactly the signal
      // recovery needs below. Computed BEFORE lastPositionMs gets
      // overwritten, using the true previous value.
      const positionAdvanceSeconds = (positionMs !== null && this.lastPositionMs !== null)
        ? (POLL_INTERVAL_MS - (positionMs - this.lastPositionMs) + this.prestallLatency) / 1000
        : 0;

      if (positionStalled) {
        if (this.stalledPollCount === 0) {
          // First frozen sample. 
          const preStallPosition = this.beforeLastPositionMs;
          const stallPosition = this.lastPositionMs;
          const preStallTime = this.beforePreviousPollTime;
          const stallTime = this.previousPollTime
          this.prestallLatency = preStallPosition + (stallTime - preStallTime) - stallPosition;
        }
        this.stalledPollCount += 1;
      } else {
        this.stalledPollCount = 0;
        this.stallStartedAt = null;
      }

      // Require BOTH: cachepercentage dipping AND position confirmed
      // stalled across STALL_CONFIRM_POLLS consecutive polls.
      // cachepercentage alone was producing false positives from
      // ordinary buffer-level jitter; the confirmed position-stall
      // filters those out — at the direct cost of roughly
      // STALL_CONFIRM_POLLS * POLL_INTERVAL_MS more detection latency
      // for genuine stalls. Tune both constants against real testing;
      // there's no setting that improves both false-positive rate and
      // latency at once, it's a real tradeoff, not a bug to solve away.
      const bufferingLike = cacheLow && this.stalledPollCount >= STALL_CONFIRM_POLLS;

      // ONSET correction: how long did confirming this stall take,
      // measured from our midpoint ESTIMATE of when it actually began?
      // Only meaningful on the specific poll where bufferingLike first
      // flips true — main.js uses this to seek the OTHER stream
      // backward by this amount once it pauses it.
      const bufferingLatencyMs =
        (bufferingLike && !this.lastState.bufferingLike && this.stallStartedAt)
          ? pollTime - this.stallStartedAt 
          : 0;

      // RECOVERY correction: the mirror case, but NOT an estimate —
      // this is exact. Only meaningful on the specific poll where a
      // CONFIRMED buffering state flips back to healthy.
      // positionAdvanceSeconds directly tells us how far the source
      // moved before we noticed it moving again — no assumption
      // needed, unlike onset — so main.js uses this to seek the OTHER
      // stream FORWARD by this amount right before resuming it.
      const recoveryAdvanceSeconds =
        (!bufferingLike && this.lastState.bufferingLike)
          ? positionAdvanceSeconds 
          : 0;

      this.beforeLastPositionMs = this.lastPositionMs;
      this.beforePreviousPollTime = this.previousPollTime
      this.previousPollTime = pollTime;
      this.lastPositionMs = positionMs;

      const position = positionMs !== null ? positionMs / 1000 : null;

      const changed =
        pause !== this.lastState.pause ||
        bufferingLike !== this.lastState.bufferingLike ||
        position !== this.lastState.position;

      this.lastState = { pause, bufferingLike, position };

      if (changed) {
        this.emit('statuschange', {
          pause,
          'paused-for-cache': bufferingLike,
          position,
          bufferingLatencyMs,
          recoveryAdvanceSeconds,
        });
      }
    } catch (err) {
      // A single missed poll (e.g. a network hiccup talking to Kodi
      // itself) shouldn't tear anything down — log it and try again
      // next tick rather than crashing the connection.
      console.warn('[kodiPlayer] poll failed:', err.message);
    }
  }

  async play() {
    await this._call('Player.PlayPause', { playerid: this.playerId, play: true });
  }

  async pause() {
    await this._call('Player.PlayPause', { playerid: this.playerId, play: false });
  }

  // Matches node-mpv's setProperty(property, value) signature so
  // main.js's generic '${label}-set-speed' handler (which calls
  // player.setProperty('speed', value)) works unmodified for either
  // backend. Only 'speed' is actually meaningful here.
  async setProperty(property, value) {
    if (property !== 'speed') return;

    await this._call('Player.SetSpeed', { playerid: this.playerId, speed: value });

    // Kodi's live-content speed handling has a real rough edge: after
    // fast-forwarding a LIVE stream (as opposed to a local/VOD file),
    // SetSpeed(1) alone often reports success but doesn't fully snap
    // the player back to normal playback — confirmed by testing, where
    // hitting Play (Player.PlayPause) afterward reliably fixes it, even
    // though SetSpeed(1) alone didn't error. So: when explicitly
    // returning to normal speed, follow it with the same forced resume
    // Play uses, rather than trusting SetSpeed alone for this case.
    if (value === 1) {
      await this._call('Player.PlayPause', { playerid: this.playerId, play: true });
    }
  }

  async toggleMute() {
    const props = await this._call('Application.GetProperties', { properties: ['muted'] });
    await this._call('Application.SetMute', { mute: !props.muted });
  }

  // 0-100, matching node-mpv's volume() range — the UI slider is
  // already built around that, so no conversion needed either way.
  async volume(value) {
    await this._call('Application.SetVolume', { volume: value });
  }

  async cycleProperty(property) {
    // This is removed from the UI because it doesn't do what I was expecting.
    // Instead of toggling fullscreen mode for kodi it toggles fullscreen mode
    // within kodi.
    if (property === 'fullscreen') {
      await this._call('GUI.SetFullscreen', { fullscreen: 'toggle' });
    }
  }

  // Relative seek by offsetSeconds (negative = backward), matching
  // node-mpv's seek(seconds) signature/semantics.
  //
  // Deliberately does NOT use Player.Seek's documented relative-seconds
  // shorthand ({"value": {"seconds": N}}, or a bare integer). Both have
  // confirmed, open Kodi bugs: a bare positive integer is silently
  // reinterpreted as a PERCENTAGE of total runtime rather than a
  // relative seek, and the {"seconds": N} object form has documented
  // inconsistent behavior for positive values specifically.
  // (https://github.com/xbmc/xbmc/issues/15865,
  //  https://github.com/xbmc/xbmc/issues/15914)
  // Negative values reportedly behave correctly, which is the only
  // direction this app actually needs — but rather than depend on a
  // known-flaky code path even for the case that "currently works",
  // this computes the absolute target time itself (from our own
  // recently-polled position) and issues a well-documented ABSOLUTE
  // seek instead, sidestepping the bug entirely.
  async seek(offsetSeconds) {
    const currentSeconds = this.lastState.position;
    if (currentSeconds === null || currentSeconds === undefined) {
      throw new Error('Cannot seek — no known current position yet (nothing polled successfully so far).');
    }

    const targetSeconds = Math.max(0, currentSeconds + offsetSeconds);
    const hours = Math.floor(targetSeconds / 3600);
    const minutes = Math.floor((targetSeconds % 3600) / 60);
    const seconds = Math.floor(targetSeconds % 60);

    await this._call('Player.Seek', {
      playerid: this.playerId,
      value: { hours, minutes, seconds },
    });
  }

  // Doesn't actually quit Kodi (that would be rude) — just stops OUR
  // polling loop. Matches node-mpv's quit() name so the shutdown code
  // in main.js doesn't need to know which backend it's talking to.
  async quit() {
    this.stop();
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.playerId = null;
  }
}

module.exports = { KodiPlayer };
