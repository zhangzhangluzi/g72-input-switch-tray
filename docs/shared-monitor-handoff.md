# Shared Monitor Handoff Logic

This note separates three concerns that are easy to mix together when one monitor is shared by a macOS machine and a Windows machine.

## 1. Monitor input ownership

This is the DDC/CI input-switch command sent to the monitor itself.

- On macOS, the app sends the switch locally through `resources/mac/switch-input.sh`.
- On Windows, the app sends the switch locally through `resources/windows/set-input.ps1`.
- The two apps do not currently talk to each other when sending the switch command.

Implication:

- `Mac -> Windows` does **not** require the Windows app to be running in order to send the DDC command.
- `Windows -> Mac` does **not** require the macOS app to be running in order to send the DDC command.

## 2. Windows desktop handoff

This is a Windows-only concern. It is not the same thing as monitor input switching.

- When Windows switches the shared monitor away to the other device, the Windows app can call `DisplaySwitch.exe /external` so the desktop moves to the remaining screen.
- When the shared monitor later comes back to Windows, the Windows app can call `DisplaySwitch.exe /extend` to restore extended desktop mode.

Safety constraint:

- `DisplaySwitch.exe /external` is only considered safe when Windows also has an internal display.
- On desktop-style setups where both monitors are external, forcing `/external` can black-screen the wrong output, so the app should leave desktop topology alone.

Implication:

- The Windows app must be running if you want automatic desktop topology recovery on Windows.
- But this still does not control the monitor input switch itself; it only controls where Windows places the desktop.

## 3. Target-device signal readiness

Even if the DDC command is sent correctly, the monitor may stay on the current picture when:

- the target device is asleep
- the target device is not outputting a stable signal yet
- the configured input value is wrong for that path

Current macOS behavior:

- The app writes the input value.
- It then reads the monitor's current input back.
- If the readback still reports the old input, the app knows only that the monitor did not switch away.
- It cannot prove whether the cause was "wrong input value" or "target device had no stable signal".

## What the current code really does

### macOS side

- `switchMonitor()` dispatches to `switchOnMac()` on macOS.
- `switchOnMac()` only runs the local shell helper with the configured candidate input values.
- No remote call to the Windows app happens in this path.

Result:

- A macOS-side failure means "the monitor did not switch away from the current input after the local DDC attempt".
- It does **not** mean "the Windows handoff agent was missing".

### Windows side

- `switchMonitor()` dispatches to `switchOnWindows()` on Windows.
- `switchOnWindows()` sends the local DDC command.
- If Windows desktop handoff is enabled, it also manages `/external` when switching away and `/extend` when the shared monitor returns.

Result:

- A Windows-side name-mismatch failure means "the Windows helper could not map the configured monitor name to what Windows currently sees".
- It is unrelated to the macOS-side DDC write path.

## Recommended two-machine contract

Treat the shared screen as a **single-owner resource**, not as a monitor that both machines can safely seize at any time.

Treat the handoff as three ordered phases, not one blended action:

1. Prepare the target machine.
2. Switch the monitor input.
3. Repair local desktop topology if needed.

### Recommended operational rules

- The machine that currently owns the visible picture should initiate the input switch.
- Both tray apps should run at login.
- Windows should keep its tray app running so desktop handoff and recovery stay automatic.
- macOS should use the built-in input probe assistant to verify the real input value for the Windows path.
- Windows should use the exact monitor name that Windows currently detects.
- If Windows no longer sees the shared screen, Windows should stop offering local switch actions and defer ownership return to the Mac side or the monitor's own buttons.

### Recommended flow: Mac -> Windows

1. Confirm Windows is awake and actively outputting to the shared monitor path.
2. macOS sends the DDC input-switch command.
3. If the monitor readback still reports the old input, interpret that as:
   - wrong input value, or
   - Windows target path not ready
4. Do not blame Windows desktop handoff for this failure; that is a separate concern.

### Recommended flow: Windows -> Mac

1. Windows sends the DDC input-switch command.
2. After the switch-away delay, Windows moves the desktop to the remaining screen with `/external` only when the current Windows machine has a safe internal-display fallback.
3. Windows marks a pending restore.
4. When the shared monitor later comes back, Windows restores `/extend`.

## Recommended next implementation step

The current app is still asymmetric because input switching is local-only.

If we want true dual-machine coordination, add an optional peer handshake layer:

- macOS can call a Windows "prepare" endpoint before attempting `Mac -> Windows`
- Windows can call a macOS "prepare" endpoint before attempting `Windows -> Mac`
- Windows can expose a "ready for shared monitor" state after forcing `/extend`
- The switching machine can then decide whether the peer is ready before writing DDC

That would let the app distinguish:

- peer not reachable
- peer reachable but not ready
- DDC command sent but monitor stayed put
- desktop restore pending

Without that peer handshake, the best the current code can do is:

- report the input-switch result honestly
- keep Windows desktop handoff separate
- make configuration and signal-readiness problems visible to the user
