# vendor/

Drop the actual mpv and ffmpeg binaries here before running a build —
this folder is deliberately gitignored (binaries are large, and you
want to consciously choose which build/version you're shipping each
release, not have one silently committed and go stale).

```
vendor/
  mpv/
    win/mpv.exe
    linux/mpv
  ffmpeg/
    win/ffmpeg.exe
    linux/ffmpeg
```

(macOS — `mac/` — once that platform is actually verified; see the
main README. Building on Apple hardware is a genuine open item —
looking for a contributor with a Mac to help test, not something we're
attempting via a VM.)

For Linux binaries, `chmod +x` them before building if they aren't
already executable — electron-builder generally preserves the
executable bit from the source file, but it's worth a quick check
(`ls -l vendor/mpv/linux/mpv`) rather than assuming.

electron-builder copies whatever's in here into the packaged app's
`resources/mpv/` and `resources/ffmpeg/` at build time — see the `build`
section of package.json. main.js's resolveMpvBinary()/resolveFfmpegBinary()
already look there first in a packaged build.

## Before every release

Note down, somewhere in the release notes, exactly which build/version
of each binary you dropped in here — this is what makes the GPL
"corresponding source" obligation satisfiable (see
../third-party-licenses/README.md). A vague "whatever was current" isn't
good enough; a specific version number or download link is.
