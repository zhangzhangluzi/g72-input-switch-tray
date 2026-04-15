# Monitor Input Switch Tray

Cross-platform tray app for switching each locally connected external DDC/CI-capable monitor directly between four configurable input interfaces.

## What it does

- Windows: system tray app with a right-click menu
- macOS: menu bar app with a click menu
- The tray/menu groups actions by locally connected external physical screen
- Each detected local screen exposes four switch actions:
  - `DP1`
  - `DP2`
  - `HDMI1`
  - `HDMI2`
- Built-in local browser settings page for:
  - showing all screens currently detected on this machine
  - configuring one local-interface slot per detected screen
  - configuring the DDC input value for each of the four interfaces on each screen
- Optional Samsung / MStar compatibility mode for monitors whose real input-switch values do not match the standard MCCS values
- Optional Windows desktop handoff mode that removes a switched-away screen from the Windows desktop and re-attaches it automatically when that screen comes back to Windows
- Optional launch at login
- Windows uninstall entry via the packaged NSIS uninstaller
- macOS self-uninstall command from the app menu

## How configuration works

- The app auto-detects the external DDC/CI-capable screens currently attached to the local machine
- Each detected local external screen gets its own stored profile
- Each profile always has four interface slots:
  - `DP1`
  - `DP2`
  - `HDMI1`
  - `HDMI2`
- Each interface has its own numeric DDC input value
- Each profile also stores which one of the four interfaces is the local machine's own cable for that screen
- On Windows, the profile is matched primarily by the screen's Win32 `DeviceName`, so two same-model monitors can still be distinguished
- On macOS, the profile is matched primarily by the local display ID
- Internal laptop / built-in panels are not exposed as four-interface switch targets

## Platform notes

- Windows switching is done with a bundled PowerShell DDC/CI helper that maps the target monitor through Win32 / WMI / DXVA2. The installer does **not** bundle `.NET`.
- Some monitors do not report a trustworthy “current input” value over DDC/CI. The settings page shows the current input only when it can be read back reliably.
- If a switch command can be written but the monitor does not provide a reliable input readback, the app treats the action as “command sent, result not confirmed” instead of forcing a hard failure.
- The app does **not** pretend to know whether every inactive interface has a live machine connected. It can reliably show the current active interface when the monitor reports it; inactive-interface connection state remains best-effort.
- For Samsung / MStar compatibility mode, the app sends the configured standard input value first and then tries a short list of known alternate values for the same port family.
- On Windows, desktop handoff is per monitor profile:
  - switching away from the local interface can detach that specific screen from the Windows desktop
  - when that specific screen returns to Windows later, the watcher can re-attach it automatically
- If `DisplaySwitch.exe` is not enough, the app falls back to a bundled topology helper that directly detaches or re-attaches the targeted Windows monitor.
- Windows monitor matching no longer relies on friendly monitor names as the primary selector, so two same-model monitors do not collapse into one target.
- If the target device is asleep, has no active signal, or the monitor is configured to auto-select a different source, the screen may stay on the current picture even though the switch command was sent.
- macOS switching prefers BetterDisplay command-line control when it is available and targets the specific local display ID when possible.
- If `betterdisplaycli` is not installed but `BetterDisplay.app` is present in `/Applications` or `~/Applications`, the app uses the BetterDisplay bundle binary directly.
- When BetterDisplay is used for input switching, the app reads the input value back after each write so Samsung / MStar displays can keep falling through to alternate values when the standard MCCS value is acknowledged but does not actually take effect.
- If BetterDisplay CLI is unavailable, the app falls back to the bundled `ddcctl` binary built during the macOS GitHub Actions release job, and then to `ddcctl` from `PATH`.
- On macOS, `ddcctl` fallback is only considered safe when there is a single external display and the tool can report that count reliably. If multiple external displays are attached, or the count cannot be determined, the app refuses the fallback instead of risking a wrong-screen switch.
- When the app has to use `ddcctl`, it tries the configured local display index first, discovers how many external displays `ddcctl` can see, and then tries the remaining valid indices automatically.
- The app starts a local settings page on port `3847` and binds it to `127.0.0.1` only. The HTTP server is only used for local setup and local direct switch actions; the app does not rely on LAN peer discovery or cross-machine coordination.
- If port `3847` is unavailable, the local pages automatically fall back to another free local port.
- macOS only switches screens that are still visible to the current Mac. Once a screen has moved to another host, the current Mac no longer pretends it can still control that screen locally.
- On Windows, only screens that can be stably mapped to a local external display are exposed as switch targets.

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
