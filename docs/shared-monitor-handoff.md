# Local Monitor Switching Rules

This project now uses one rule set only:

- each app instance controls only the external physical screens that are currently attached to the local host
- no LAN peer discovery
- no cross-machine ownership endpoint
- no shared-screen negotiation layer
- no remote prepare / receive handshake

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
- When the same screen later returns to the Windows cable, the app can add that screen back into the Windows desktop topology.
- This is not remote coordination. It is only Windows repairing its own local desktop state.

### 5. Current input readback

- If the monitor reports its current input reliably, the app shows it.
- If the monitor does not report it reliably, the UI must say that the state is unknown.
- The app must not claim that an inactive interface definitely has or does not have a connected machine behind it.
- A confirmed mismatch after readback is a real switch failure; missing readback support is not.
- On Windows, only displays that can be stably mapped to a local external screen are allowed into the switchable list.
- On macOS, if `ddcctl` cannot reliably report the external-display count, the fallback path must stop instead of scanning candidate indices blindly.

## Error interpretation

### macOS side

- If macOS writes the input value and readback still stays on the old input, the failure means:
  - wrong input value, or
  - target interface has no stable signal, or
  - the monitor acknowledged the write but did not actually switch

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
