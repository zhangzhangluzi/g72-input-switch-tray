# G72 Input Switch Tray

Cross-platform tray app for switching a `G72` monitor between:

- `DP2` for Windows
- `HDMI1` for a Mac mini

## What it does

- Windows: system tray app with a right-click menu
- macOS: menu bar app with a click menu
- Switch target with one click
- Built-in browser control page for cases where the current machine has no visible screen
- Optional launch at login
- Windows uninstall entry via the packaged NSIS uninstaller
- macOS self-uninstall command from the app menu

## Platform notes

- Windows switching is done with a bundled PowerShell DDC/CI helper that maps the target monitor through Win32 and WMI. The installer does **not** bundle `.NET`.
- macOS switching prefers a bundled `ddcctl` binary built during the macOS GitHub Actions release job.
- If the bundled macOS helper is unavailable, the app falls back to `betterdisplaycli` and then `ddcctl` from `PATH`.
- The app also starts a browser control page on port `3847`. For a single-screen Mac mini setup, bookmark that page on your phone or another device before switching away from macOS.

## Development

```bash
npm install
npm start
```

## Packaging

```bash
npm run dist:win
npm run dist:mac
```

Tag a release with a `v` prefix, for example `v0.1.0`, and GitHub Actions will publish Windows and macOS release artifacts to GitHub Releases.
