# Monitor Input Switch Tray

Cross-platform tray app for switching any DDC/CI-capable monitor between two configured input modes.

## What it does

- Windows: system tray app with a right-click menu
- macOS: menu bar app with a click menu
- Switching happens from the tray/menu bar, not from a separate browser switch page
- Built-in local browser settings page for choosing the monitor name, macOS display index, and two input profiles
- Optional launch at login
- Windows uninstall entry via the packaged NSIS uninstaller
- macOS self-uninstall command from the app menu

## How configuration works

- The app stores one target monitor name
- You define two modes, each with a custom label and a numeric DDC input value
- Defaults are kept compatible with the original setup: `G72`, `Windows（DP2） = 16`, `Mac mini（HDMI1） = 17`
- Common input values are shown in the settings page as a reference

## Platform notes

- Windows switching is done with a bundled PowerShell DDC/CI helper that maps the target monitor through Win32 and WMI. The installer does **not** bundle `.NET`.
- macOS switching prefers a bundled `ddcctl` binary built during the macOS GitHub Actions release job.
- If the bundled macOS helper is unavailable, the app falls back to `betterdisplaycli` and then `ddcctl` from `PATH`.
- The app starts a local settings page on port `3847` and binds to `127.0.0.1`.
- If port `3847` is unavailable on Windows, the local pages automatically fall back to another free local port.
- macOS does not provide a hidden-screen self-recovery workflow. It only switches while the current Mac still has a visible picture and can launch the app/menu.

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

Tag a release with a `v` prefix, for example `v0.2.0`, and GitHub Actions will publish Windows and macOS release artifacts to GitHub Releases.
