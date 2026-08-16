# Third-party licenses

This app controls two external programs as separate OS processes,
communicating over IPC/pipes — never linked as libraries. That
distinction matters: it's why bundling or requiring these tools doesn't
bring this app's own code under their licenses. But when a build of
this app BUNDLES the actual binaries (rather than requiring the user to
install them separately), that build is redistributing GPL-licensed
software, which comes with its own small set of obligations, handled
here.

## mpv — license depends on which build you use

- Project: https://github.com/mpv-player/mpv
- **Community builds** (shinchiro's and zhongfly's, linked from
  https://mpv.io/installation/) are GPL-2.0-or-later.
- **Official upstream CI builds**, published directly from
  `github.com/mpv-player/mpv/releases` (e.g. filenames like
  `mpv-v0.41.0-x86_64-pc-windows-msvc.zip`) — **this is what's actually
  bundled here on Windows** — are **LGPL-2.1**, per that build's own
  winget package listing. Less restrictive than the community builds;
  fetch `lgpl-2.1.txt` below rather than `gpl-2.0.txt` for this one.
- Bottom line: don't assume — check which specific build you're
  bundling before picking a license file. An exact GitHub release
  URL (see "Bundled versions" below) is the most reliable way to record
  which one you used, since it's traceable back to upstream by anyone.

## ffmpeg — GPL-3.0 (for the gyan.dev "essentials" Windows build)

- Project: https://ffmpeg.org / https://github.com/FFmpeg/FFmpeg
- Windows builds: https://github.com/GyanD/codexffmpeg
- This specifically depends on which build you use. The gyan.dev
  "essentials" build (built with `--enable-gpl --enable-version3
  --enable-libx264 --enable-libx265 ...`) is GPL-3.0. A build without
  `--enable-gpl` would be LGPL instead — check `ffmpeg -version`'s
  printed `configuration:` line for whichever build you actually bundle,
  since this isn't fixed across all ffmpeg builds the way mpv's default
  mostly is.

## Fetching the canonical license texts

Don't hand-copy license text — get it directly from the source so it's
guaranteed byte-exact:

```
# from this directory
curl -o gpl-2.0.txt https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.txt
curl -o gpl-3.0.txt https://www.gnu.org/licenses/gpl-3.0.txt
curl -o lgpl-2.1.txt https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.txt
```

(PowerShell: `Invoke-WebRequest -Uri <url> -OutFile <file>`)

Only include the texts that actually apply to what's bundled in a given
release — for the current Windows build (official mpv CI + gyan.dev
ffmpeg), that's `lgpl-2.1.txt` and `gpl-3.0.txt`; `gpl-2.0.txt` only
applies if you ever switch to a community mpv build instead.

Include the relevant files in any release that bundles the actual
mpv/ffmpeg binaries, alongside this README. If a release instead
requires the user to install mpv/ffmpeg themselves (see the main
README's `MPV_BINARY_PATH` / `FFMPEG_BINARY_PATH` env vars), none of
this applies — you're not redistributing anything, so there's no
obligation to satisfy.

## Bundled versions

This is the actual "corresponding source" record — update it every time
the binaries in `vendor/` change. Get each version with:

- `ffmpeg -version` (first line + the `configuration:` line — the
  configuration matters for confirming GPL vs LGPL, not just the version)
- `mpv --version`
- For a **from-source mpv build specifically**: also record the exact
  git commit you built from (`git rev-parse HEAD` in the mpv source
  checkout) — "built from main" isn't reproducible, a commit hash is.

### Windows

- ffmpeg: `9.0.1-essentials_build` (gyan.dev), built with
  `--enable-gpl --enable-version3 --enable-libx264 --enable-libx265 ...`
  → GPL-3.0, confirmed from this build's own `configuration:` output.
- mpv: `v0.41.0`, official upstream CI build (MSVC) —
  https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-x86_64-pc-windows-msvc.zip
  → LGPL-2.1 (see corrected license note above)

### Linux

- ffmpeg: _fill in — `ffmpeg -version`, first line + `configuration:` line_
- mpv: _fill in — built from source, so record the git commit hash
  (`git rev-parse HEAD`) from the source checkout used, not just
  `mpv --version`'s own output_
