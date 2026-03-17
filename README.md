# Monitor Input Switch Tray

Cross-platform tray app for switching any DDC/CI-capable monitor between two configured input modes.

## What it does

- Windows: system tray app with a right-click menu
- macOS: menu bar app with a click menu
- Switching happens from the tray/menu bar, not from a separate browser switch page
- Built-in local browser settings page for choosing the monitor name, macOS display index, and two input profiles
- The tray/menu shows the last requested switch target, not a guaranteed real-time input readback
- Optional Samsung / MStar compatibility mode for monitors whose real input-switch values do not match the standard MCCS values
- Optional Windows desktop handoff mode that moves the desktop to the remaining screen when the target monitor switches away, then restores extend mode when that monitor comes back
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
- Some monitors do not report a trustworthy “current input” value over DDC/CI. The app now treats the tray state as the last command sent, and the settings page shows monitor diagnostics when Windows can read them.
- Some monitors, especially Samsung / MStar models, continue reporting an active connection to the current computer even after the picture switches away. The app no longer treats “still attached” as a failure for those screens.
- For Samsung / MStar compatibility mode, the app uses a short list of known alternate values for the same port family. On Windows switch-away paths it prioritizes those alternates first, because some Samsung / MStar displays ignore the standard MCCS value but still accept the compatibility value.
- On Windows, desktop handoff uses the system display switcher to move the desktop off the departing monitor. The app only restores extend mode after the shared monitor becomes DDC-readable again, which avoids treating a phantom re-enumerated display as a real return.
- On Windows, the app also bundles a display-topology helper that can directly detach the configured shared monitor from the desktop and remember its last known mode for later re-attach attempts.
- The Windows "refresh display state" action now forces another shared-monitor detach attempt whenever the last requested target is `Mac`, even if the previous switch result was recorded as a failure.
- If the target device is asleep, has no active signal, or the monitor is configured to auto-select a different source, the screen may stay on the current picture even though the switch command was sent.
- macOS switching now prefers `betterdisplaycli` when it is available, because name-based matching is more reliable than a fixed display index on some Macs.
- If BetterDisplay CLI is unavailable, the app falls back to the bundled `ddcctl` binary built during the macOS GitHub Actions release job, and then to `ddcctl` from `PATH`.
- When the app has to use `ddcctl`, it tries the configured macOS display index first and then probes a few common fallback indices automatically.
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
