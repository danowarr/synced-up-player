// recorder.js
// Spawns an ffmpeg process per stream that continuously re-packages the
// live source into a LOCAL rolling HLS buffer (segments + a playlist)
// with a much bigger DVR window than the upstream source provides.
// Playback then points at this local buffer instead of the raw URL, so
// pausing or catching up has real backlog to work with instead of
// hitting the upstream's live edge after a few tens of seconds.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SEGMENT_SECONDS = 6;
const BUFFER_WINDOW_SECONDS = 600; // 10 minutes — adjust freely
const SEGMENT_COUNT = Math.ceil(BUFFER_WINDOW_SECONDS / SEGMENT_SECONDS);

// -allowed_extensions and -extension_picky are PRIVATE options on
// ffmpeg's HLS demuxer specifically — they don't exist for other
// demuxers (e.g. a raw MPEG-TS stream, which is what a lot of proxied
// sources look like). Passing them for a source ffmpeg doesn't detect
// as HLS isn't a harmless no-op — it's a hard error ("option not found
// for this input") that kills the whole recording. So: only add them
// when the source actually looks like an HLS playlist.
//
// This is a URL-extension heuristic, not real content-type detection —
// good enough for the vast majority of real sources, but if you ever
// hit a source that IS HLS without ".m3u8" in the URL (or vice versa),
// this is the function to make smarter (e.g. an HTTP HEAD check on
// Content-Type) rather than something to fight with flags.
function looksLikeM3U8(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch (_) {
    // Not a parseable absolute URL — fall back to a plain substring check.
    return url.toLowerCase().includes('.m3u8');
  }
}

class StreamRecorder {
  constructor(label, ffmpegBinary, bufferRootDir) {
    this.label = label;
    this.ffmpegBinary = ffmpegBinary;
    this.dir = path.join(bufferRootDir, label);
    this.process = null;
    this.playlistPath = path.join(this.dir, 'live.m3u8');
  }

  // Starts (or restarts, if already running) recording sourceUrl into
  // this stream's local buffer directory.
  start(sourceUrl) {
    this.stop();

    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });

    const args = [
      '-y',
      // Reconnect flags: the whole point of this app is dealing with
      // flaky sources, so the recorder needs to survive hiccups on the
      // upstream connection the same way you'd want playback to.
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ];

    if (looksLikeM3U8(sourceUrl)) {
      // Some HLS sources name their segments with non-standard
      // extensions (.js instead of .ts, seen in the wild) — the HLS
      // demuxer whitelists "safe" extensions by default and refuses
      // anything else. allowed_extensions=ALL disables that check;
      // extension_picky is a SEPARATE, newer check (added for
      // CVE-2023-6602) that needs disabling independently, or the same
      // error persists even with allowed_extensions set.
      args.push('-allowed_extensions', 'ALL', '-extension_picky', '0');
      console.log(`[recorder:${this.label}] source looks like HLS — adding extension-bypass flags.`);
    } else {
      console.log(`[recorder:${this.label}] source doesn't look like HLS — skipping HLS-only flags (they'd error on a non-HLS demuxer).`);
    }

    args.push(
      '-i', sourceUrl,
      '-c', 'copy', // no re-encode — cheap on CPU, preserves quality
      '-f', 'hls',
      '-hls_time', String(SEGMENT_SECONDS),
      '-hls_list_size', String(SEGMENT_COUNT),
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', path.join(this.dir, 'seg_%05d.ts'),
      this.playlistPath
    );

    console.log(`[recorder:${this.label}] starting: ${this.ffmpegBinary} ${args.join(' ')}`);
    this.process = spawn(this.ffmpegBinary, args);

    // ffmpeg logs everything — routine progress AND real errors — to
    // stderr. Keep a rolling tail of it so that if the process dies, we
    // can print the actual reason instead of just an exit code.
    this.stderrTail = '';
    this.process.stderr.on('data', (chunk) => {
      this.stderrTail += chunk.toString();
      if (this.stderrTail.length > 4000) {
        this.stderrTail = this.stderrTail.slice(-4000);
      }
    });

    this.process.on('exit', (code) => {
      console.log(`[recorder:${this.label}] ffmpeg exited (code ${code})`);
      if (code !== 0) {
        console.log(`[recorder:${this.label}] last ffmpeg output:\n${this.stderrTail}`);
      }
      this.process = null;
    });

    this.process.on('error', (err) => {
      console.error(`[recorder:${this.label}] failed to start ffmpeg — check FFMPEG_BINARY_PATH.`, err);
      this.process = null;
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  // Resolves once the local playlist has enough segments for mpv to
  // start playing without immediately running dry. Polling the file is
  // simpler than parsing ffmpeg's progress output and plenty accurate
  // for a few seconds of startup delay.
  async waitUntilReady(minSegments = 3, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(this.playlistPath)) {
        const content = fs.readFileSync(this.playlistPath, 'utf8');
        const segmentCount = (content.match(/\.ts/g) || []).length;
        if (segmentCount >= minSegments) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`[recorder:${this.label}] local buffer did not become ready in time — check ffmpeg's output in the console above.`);
  }
}

module.exports = { StreamRecorder, SEGMENT_SECONDS, BUFFER_WINDOW_SECONDS };
