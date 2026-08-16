# Contributing

This is a hobby project maintained in spare time — response times on
issues/PRs will vary, but contributions are genuinely welcome.

## Reporting bugs

Open an issue with:
- Platform (Windows/Linux) and whether you're running a downloaded
  release or from source
- What you did, what you expected, what actually happened
- Anything from the terminal running `npm start` (or the release's
  console output) around when the problem happened — most bugs in this
  codebase show their real cause there, not just in the UI

## Suggesting features

Open an issue describing the use case, not just the feature — this is
a fairly opinionated tool built around one specific workflow (syncing
a TV and radio broadcast), so it helps to know what problem you're
actually trying to solve.

## Code contributions

- Look at the "Notes on other design choices" section in the README
  before touching main.js/recorder.js/localServer.js — a few things
  that might look like odd choices (HTTP server instead of a raw file
  path for the local buffer, the pausedState tracking in the sync
  engine) are deliberate, with the reasoning documented right there or
  in inline comments.
- Keep PRs focused — one change per PR is much easier to review than a
  bundle of unrelated fixes.
- If you're adding a new platform target (macOS, in particular — see
  the README's "Not yet implemented" section), it doesn't need
  application-code changes; every platform-specific branch already
  exists in main.js/recorder.js. It's mostly a packaging/vendor-folder
  concern — see "Building a release" in the README.

## What this project won't do

See "Scope" in the README — no DRM handling, no capturing other
apps'/tabs' audio, no hosting or rebroadcasting streams. PRs that push
in that direction won't be merged, regardless of how well-implemented
they are — it's a deliberate boundary, not an oversight.
