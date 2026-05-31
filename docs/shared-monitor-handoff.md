# Local Monitor Switching Rules

This project now uses one rule set only:

- each app instance controls only the external physical screens that are currently attached to the local host
- no LAN peer discovery
- no cross-machine ownership endpoint
- no shared-screen negotiation layer
- no remote prepare / receive handshake

## Daily user model

- `Give to peer`: use this when the shared screen is currently visible on the local host. On Windows this also removes the shared screen from the Windows desktop topology so windows move back to the remaining screen.
- `Take back to Windows`: use this when the shared screen is currently on the peer machine but Windows still has a detached display device candidate. The app first re-attaches that Windows display device, then switches the monitor back to the configured local Windows interface.
- `Advanced repair`: use this only when Windows display state is stuck, for example when Settings still shows a gray second screen after the shared monitor has been handed away.
- A gray second screen in Windows Settings is not treated as proof that Windows owns the picture. It can be a detached / remembered topology entry.
- DP / HDMI numeric values are calibration data only. UI labels should keep the user's mental model stable even when MCCS values differ from the monitor menu names.

## Current business rules

### 1. Screen discovery

- The app reads the external DDC/CI-capable screens that the current host can see right now.
- If the current host sees 1 external screen, the UI shows 1 screen.
- If the current host sees 2 or 3 external screens, the UI shows 2 or 3 screens.
- The app does not keep showing screens that are no longer attached to the current host.
- Internal / built-in panels are not treated as four-interface switch targets.

### 2. Interface model

- Every local screen profile exposes four configurable interface slots:
  - `DP1`
  - `DP2`
  - `HDMI1`
  - `HDMI2`
- Each slot stores one DDC input value.
- Each screen profile also stores which slot is the current host's own cable for that screen.
- On macOS, the app prefers hardware identity for profile matching when the monitor reports a usable vendor / product / serial tuple; otherwise it falls back to the local display ID.

### 3. Direct switching

- macOS switches locally through `resources/mac/switch-input.sh`.
- Windows switches locally through `resources/windows/set-input.ps1`.
- A direct switch action means: "send a DDC input-switch command from this host to this local screen now."
- It does not mean the other host is ready.
- It does not mean the other host has already accepted the screen.
- If the write succeeds but the monitor does not provide a trustworthy current-input readback, the action should be recorded as "command sent, state not confirmed", not as a hard failure.
- On macOS, `ddcctl` fallback must not be used to target one specific screen when multiple external displays are attached.

### 4. Windows desktop handoff

- This is local to Windows only.
- When Windows switches a screen away from Windows' own cable, the app can remove that screen from the Windows desktop topology.
- That detach step is allowed only after the switch result has been confirmed, not when the command is merely unconfirmed.
- If the target Windows screen is still the current primary desktop, another attached Windows screen must become primary first before the target can be detached.
- The background watcher does not blindly re-add a detached waiting screen. A user-triggered takeover / refresh action is the path that may add that screen back into the Windows desktop topology.
- The takeover path first attaches the detached Windows display device, then switches that screen to the configured local interface.
- The takeover path is hardware-bound: if the monitor does not expose a DDC/CI physical monitor handle to Windows while it is displaying another input, Windows cannot actively pull that screen back.
- If a same-model duplicate attached to Windows while its input is not that screen's configured local interface, the app can remove that duplicate from the Windows desktop topology.
- This is not remote coordination. It is only Windows repairing its own local desktop state.

### 5. Current input readback

- If the monitor reports its current input reliably, the app shows it.
- If the monitor does not report it reliably, the UI must say that the state is unknown.
- The app must not claim that an inactive interface definitely has or does not have a connected machine behind it.
- A write helper failure is a switch failure; a readback mismatch or missing readback is diagnostic-only and must be shown as unknown / unconfirmed.
- On Windows, only displays that can be stably mapped to a local external screen are allowed into the switchable list.
- On macOS, if `ddcctl` cannot reliably report the external-display count, the fallback path must stop instead of scanning candidate indices blindly.
- On macOS, topology refresh must reuse a short-lived cached `system_profiler` result during steady state and force-refresh it only on real display add / remove events.

## Error interpretation

### macOS side

- If macOS writes the input value and readback stays on the old input, the UI records the command as unconfirmed.
- The raw helper output may still be useful for diagnostics, but the app must not turn unreliable readback into a hard failure.
- A local health check must not trigger DDC probing, current-input readback, or persisted monitor-configuration rewrites.

### Windows side

- If Windows cannot map the target screen to a local physical monitor handle, the failure means:
  - Windows does not currently see that screen in a controllable way, or
  - the monitor handle is unavailable, or
  - DDC/CI is blocked or disabled

## Explicit non-goals

These are not part of the current product model and should not be reintroduced implicitly:

- peer URL input
- LAN ownership checks
- shared-screen session state
- "prepare transfer" / "receive transfer" actions
- remote trigger between macOS and Windows
- stale `G72`-style single shared monitor assumptions

## Engineering rule

If code, UI text, or documentation implies that one host knows the other host's live state over the network, that is a bug in the current model.
