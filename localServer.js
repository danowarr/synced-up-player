// localServer.js
// Serves the local rolling HLS buffers (recorder.js's output) over
// plain HTTP on 127.0.0.1. This exists specifically because mpv/ffmpeg's
// HLS demuxer reliably re-polls a NETWORK playlist for new segments as
// they appear, but doesn't reload a raw local file path the same way —
// pointing mpv at a filesystem .m3u8 path causes it to read whatever
// segments existed at open time and then stall once it runs out, even
// though the recorder keeps writing new ones. Serving the exact same
// files over HTTP (still 100% local — never leaves the machine) puts
// mpv on the codepath it actually expects for live playlists.

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

function startLocalServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Reject anything trying to escape rootDir via ../ — this server
      // only ever talks to localhost, but no reason to be sloppy.
      const safePath = path.normalize(decodeURIComponent(req.url)).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(rootDir, safePath);

      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end();
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          // Expected and harmless during the first second or two of a
          // recording — mpv may ask for a segment fractionally before
          // ffmpeg finishes writing it. A 404 here just means "try again."
          res.writeHead(404);
          res.end();
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, {
          'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      });
    });

    // Bind to 127.0.0.1 specifically, not 0.0.0.0 — this should never be
    // reachable from anywhere but this machine. Port 0 = let the OS pick
    // any free port.
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });

    server.on('error', reject);
  });
}

module.exports = { startLocalServer };
