# Monitor Input Switch Tray

Cross-platform tray app for switching a DDC/CI-capable monitor directly between four configurable input interfaces.

## What it does

- Windows: system tray app with a right-click menu
- macOS: menu bar app with a click menu
- The tray/menu directly shows four switch actions: `DP1`, `DP2`, `HDMI1`, `HDMI2`
- Built-in local browser settings page for:
  - choosing the target monitor name
  - showing the current machine's detected displays
  - choosing which local display is the shared screen on this machine
  - choosing which interface belongs to the current machine
  - configuring the DDC input value for each of the four interfaces
- Optional Samsung / MStar compatibility mode for monitors whose real input-switch values do not match the standard MCCS values
- Optional Windows desktop handoff mode that removes the shared screen from the Windows desktop when switching away from the current machine's own interface, then restores extend mode when switching back
- Optional launch at login
- Windows uninstall entry via the packaged NSIS uninstaller
- macOS self-uninstall command from the app menu

## How configuration works

- The app stores one target monitor name
- The app always works with four interface slots:
  - `DP1`
  - `DP2`
  - `HDMI1`
  - `HDMI2`
- Each interface has its own numeric DDC input value
- The current machine also stores:
  - which detected local display is the shared screen
  - which of the four interfaces is this machine's own shared-screen cable
- Common input values are shown in the settings page as a reference

## Platform notes

- Windows switching is done with a bundled PowerShell DDC/CI helper that maps the target monitor through Win32 and WMI. The installer does **not** bundle `.NET`.
- Some monitors do not report a trustworthy “current input” value over DDC/CI. The settings page shows the current input only when it can be read back reliably.
- The app does **not** pretend to know whether every inactive interface has a live machine connected. It can reliably show the current active interface; inactive-interface connection state remains best-effort.
- For Samsung / MStar compatibility mode, the app sends the configured standard input value first and then tries a short list of known alternate values for the same port family.
- On Windows, desktop handoff uses the current machine's configured local interface:
  - switching to a different interface can detach the shared screen from the Windows desktop
  - switching back to the current machine's own interface can re-attach it and restore extend mode
- If `DisplaySwitch.exe /internal` or `/extend` is not enough, the app falls back to a bundled topology helper that directly detaches or re-attaches the configured shared monitor.
- Windows monitor matching accepts normalized names, but it no longer falls back to "the only remaining monitor" in a shared-screen setup, so the helper will not accidentally send DDC commands to the wrong fallback screen.
- If the target device is asleep, has no active signal, or the monitor is configured to auto-select a different source, the screen may stay on the current picture even though the switch command was sent.
- macOS switching now prefers BetterDisplay command-line control when it is available, because name-based matching is more reliable than a fixed display index on some Macs.
- If `betterdisplaycli` is not installed but `BetterDisplay.app` is present in `/Applications` or `~/Applications`, the app uses the BetterDisplay bundle binary directly.
- When BetterDisplay is used for input switching, the app reads the input value back after each write so Samsung / MStar displays can keep falling through to alternate values when the standard MCCS value is acknowledged but does not actually take effect.
- The macOS settings page includes a built-in input probe assistant, so you can test candidate input values and write a confirmed value back into one of the four interface slots without relying on an external script or an AI session.
- When a macOS switch command is accepted but the display clearly stays on the same input, the app now tells you that the configured input value is still wrong and points you back to the built-in probe assistant instead of only surfacing a generic failure.
- If BetterDisplay CLI is unavailable, the app falls back to the bundled `ddcctl` binary built during the macOS GitHub Actions release job, and then to `ddcctl` from `PATH`.
- When the app has to use `ddcctl`, it tries the configured local display index first, discovers how many external displays `ddcctl` can see, and then probes the remaining valid indices automatically.
- The app starts a local settings page on port `3847`. The HTTP server is only used for local setup and local direct switch actions; the app no longer relies on any LAN peer-discovery or cross-machine coordination path.
- If port `3847` is unavailable, the local pages automatically fall back to another free local port.
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
npm run verify:self
```

Tag a release with a `v` prefix, for example `v0.2.0`, and GitHub Actions will publish Windows and macOS release artifacts to GitHub Releases.
