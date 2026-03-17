# Monitor Input Switch Tray

Cross-platform tray app for switching any DDC/CI-capable monitor between two configured input modes.

## What it does

- Windows: system tray app with a right-click menu
- macOS: menu bar app with a click menu
- Switching happens from the tray/menu bar, not from a separate browser switch page
- Built-in local browser settings page for choosing the monitor name, macOS display index, and two input profiles
- The tray/menu separates "current shared-screen owner" from "last requested switch target"
- Tray/menu-triggered switch failures are now recorded inside the tray/menu state instead of opening a blocking error dialog
- Optional Samsung / MStar compatibility mode for monitors whose real input-switch values do not match the standard MCCS values
- Optional Windows desktop handoff mode that moves the desktop back to the Windows primary screen when the shared monitor switches away, then restores extend mode when that monitor comes back
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
- For Samsung / MStar compatibility mode, the app sends the configured standard input value first and then tries a short list of known alternate values for the same port family.
- On Windows, desktop handoff uses the system display switcher to move the desktop off the departing monitor, and retries extend mode until that monitor is available again.
- Windows desktop handoff now uses the system "PC screen only" path to move Windows back to its primary display when the shared monitor switches away, then restores `extend` when the shared monitor comes back.
- If `DisplaySwitch.exe /internal` still leaves the shared screen in Windows desktop topology, the app now falls back to a bundled topology helper that explicitly collapses Windows down to the primary display.
- On Windows, the app now keeps switch failures user-facing and concise: monitor-name mismatches are reported together with the names Windows currently sees, instead of showing a raw PowerShell stack trace.
- Windows monitor matching now accepts normalized names, but it no longer falls back to "the only remaining monitor" in a shared-screen setup, so the helper will not accidentally send DDC commands to the Windows fallback screen.
- On Windows, the app now distinguishes "still enumerated by Windows" from "still usable as the active shared screen". If the shared monitor keeps reporting an attached EDID after switching away, Windows reads the current input back and uses local desktop-topology state to decide whether the shared screen has already left Windows.
- The app is now centered on a built-in "manual handoff assistant" with two explicit local actions: "prepare transfer" and "prepare receive". The side that currently owns the picture should click transfer, the other side should click receive, and the app cancels stale manual sessions after 30 seconds so Windows can roll back any temporary desktop-topology changes.
- For a shared-screen setup, treat the monitor as a single-owner resource: whichever machine currently owns the visible picture is the one that should hand it off.
- On Windows, if the shared screen is no longer visible to Windows, the tray now treats that as "ownership has moved away" and stops offering local switch actions until the screen comes back.
- When Windows no longer sees the shared screen after a successful `Windows -> Mac` handoff, the app can now infer locally that the screen moved away based on Windows topology alone.
- When macOS loses its only shared display right after a successful `Mac -> Windows` handoff, the app can now infer locally that the screen moved away based on the Mac's own display state.
- Switch success confirmation now checks local topology first for the current attempt. If Windows has already collapsed back to its fallback screen, or macOS has already lost the only shared display, the app treats that as a successful local handoff instead of waiting for another machine.
- Windows desktop handoff verification now reads the bundled topology helper summary back, so the app verifies the real Windows desktop topology instead of relying only on Electron's cached display list.
- If `DisplaySwitch.exe /extend` still leaves Windows stuck on “only show on 1”, the bundled Windows topology helper now tries to re-attach the detached displays with their stored modes so the shared input can present a stable signal before the monitor switches back.
- If you want Windows to truly drop the shared screen from desktop topology during `Windows -> Mac`, set the Windows fallback screen as the primary display; the handoff path now returns Windows to that primary display.
- On Windows, the app also bundles a display-topology helper that can directly detach the configured shared monitor from the desktop and remember its last known mode for later re-attach attempts.
- The Windows "refresh display state" action now forces another shared-monitor detach attempt whenever the last requested target is `Mac`, even if the previous switch result was recorded as a failure.
- If the target device is asleep, has no active signal, or the monitor is configured to auto-select a different source, the screen may stay on the current picture even though the switch command was sent.
- macOS switching now prefers BetterDisplay command-line control when it is available, because name-based matching is more reliable than a fixed display index on some Macs.
- If `betterdisplaycli` is not installed but `BetterDisplay.app` is present in `/Applications` or `~/Applications`, the app uses the BetterDisplay bundle binary directly.
- When BetterDisplay is used for input switching, the app reads the input value back after each write so Samsung / MStar displays can keep falling through to alternate values when the standard MCCS value is acknowledged but does not actually take effect.
- The macOS settings page now includes a built-in input probe assistant, so you can test candidate input values and write a confirmed value back into Mode A / Mode B without relying on an external script or an AI session.
- When a macOS switch command is accepted but the display clearly stays on the same input, the app now tells you that the configured input value is still wrong and points you back to the built-in probe assistant instead of only surfacing a generic failure.
- If BetterDisplay CLI is unavailable, the app falls back to the bundled `ddcctl` binary built during the macOS GitHub Actions release job, and then to `ddcctl` from `PATH`.
- When the app has to use `ddcctl`, it tries the configured macOS display index first, discovers how many external displays `ddcctl` can see, and then probes the remaining valid indices automatically.
- The app starts a local settings page on port `3847`. The HTTP server is only used for local setup and local manual actions; the app no longer relies on any LAN peer-discovery or cross-machine coordination path.
- If port `3847` is unavailable, the local pages automatically fall back to another free local port.
- macOS does not provide a hidden-screen self-recovery workflow. It only switches while the current Mac still has a visible picture and can launch the app/menu.
- A longer handoff design note for the "shared screen + Windows fallback screen" model lives in `docs/shared-monitor-handoff.md`.

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
