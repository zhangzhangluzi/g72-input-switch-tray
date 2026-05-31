# Monitor Input Switch Tray

Cross-platform tray app for switching each locally connected external DDC/CI-capable monitor directly between four configurable input interfaces.

## 日常使用逻辑

这个软件现在按“共享屏交接”理解，不按“两个电脑互相联网控制”理解：

- 共享屏现在显示 Windows 画面时，在 Windows 托盘点 `交给对方机器`。Windows 会发送切到对方输入的命令，并把这块屏从 Windows 桌面移除，让窗口回到剩下的主屏。
- 共享屏现在显示对方机器画面时，在 Windows 托盘点 `接回 Windows 的共享屏`。Windows 会先尝试把断开的显示设备加回桌面，再发送切回 Windows 接口的命令。
- Windows 设置里看到灰色第二屏，通常只是拓扑残留或等待接回，不代表 Windows 已经真正拿到画面。卡住时再用 `高级：修复 Windows 屏幕状态`。
- macOS 端只控制当前还能被 Mac 看见的屏幕。屏幕已经切走之后，Mac 不负责远程抢回，由 Windows 接回或通过显示器实体菜单处理。
- `DP1` / `DP2` / `HDMI1` / `HDMI2` 的 DDC 数值只是高级校准项。显示器菜单名和 DDC 数值不一致时，只改数值，不改日常按钮含义。
- “日常交给对方接口”决定 `交给对方机器` 实际切到哪个输入口；“连接设备名”只决定按钮上显示成 `Mac mini`、`游戏机` 这类名字。

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
- Optional Windows desktop handoff mode that removes a switched-away screen from the Windows desktop, keeps it out while it belongs to another host, and lets an explicit takeover / refresh action add it back
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
- Each profile can optionally store which interface should be used by the daily "give to peer" action; if unset, the app falls back to the old platform default
- On Windows, the profile is matched primarily by the screen's Win32 `DeviceName`, so two same-model monitors can still be distinguished
- On macOS, the profile is matched primarily by hardware identity when the monitor reports a usable vendor / product / serial tuple; otherwise it falls back to the local display ID
- Internal laptop / built-in panels are not exposed as four-interface switch targets

## Platform notes

- Windows switching is done with a bundled PowerShell DDC/CI helper that maps the target monitor through Win32 / WMI / DXVA2. The installer does **not** bundle `.NET`.
- Some monitors do not report a trustworthy “current input” value over DDC/CI. The settings page shows the current input only when it can be read back reliably.
- If a switch command can be written but the monitor does not provide a reliable input readback, the app treats the action as “command sent, result not confirmed” instead of forcing a hard failure.
- The app does **not** pretend to know whether every inactive interface has a live machine connected. It can reliably show the current active interface when the monitor reports it; inactive-interface connection state remains best-effort.
- For Samsung / MStar compatibility mode, the app sends the configured standard input value first and then tries a short list of known alternate values for the same port family.
- On Windows, desktop handoff is per monitor profile:
  - switching away from the local interface can detach that specific screen from the Windows desktop
  - if that specific screen is still the current Windows primary display, another attached Windows screen is promoted to primary first
  - the background watcher does not blindly re-add a detached waiting screen; the explicit takeover / refresh action is allowed to attach it back
  - the takeover action first adds the detached display back to the Windows desktop topology, then switches it to the configured local interface
  - takeover still depends on the monitor / GPU exposing a DDC/CI control path while the screen is on another input; if Windows cannot get a physical monitor handle, the app reports that hardware limit instead of showing a raw helper error
  - if Windows keeps a same-model duplicate attached while its input is not that screen's configured local interface, the app removes that duplicate from the Windows desktop topology
- If `DisplaySwitch.exe` is not enough, the app falls back to a bundled topology helper that directly detaches or re-attaches the targeted Windows monitor.
- Windows monitor matching no longer relies on friendly monitor names as the primary selector, so two same-model monitors do not collapse into one target.
- If the target device is asleep, has no active signal, or the monitor is configured to auto-select a different source, the screen may stay on the current picture even though the switch command was sent.
- macOS switching prefers BetterDisplay command-line control when it is available and targets the specific local display ID when possible.
- When macOS can read a reliable hardware identity for a screen, that identity is persisted so same-model dual-screen setups are less likely to swap profiles after reconnects.
- macOS display metadata is cached briefly and force-refreshed when the local display topology changes, so tray refresh stays responsive without using stale topology after a plug / unplug event.
- If `betterdisplaycli` is not installed but `BetterDisplay.app` is present in `/Applications` or `~/Applications`, the app uses the BetterDisplay bundle binary directly.
- When BetterDisplay is used for input switching, the app reads the input value back after each write so Samsung / MStar displays can keep falling through to alternate values when the standard MCCS value is acknowledged but does not actually take effect.
- If BetterDisplay CLI is unavailable, the app falls back to the bundled `ddcctl` binary built during the macOS GitHub Actions release job, and then to `ddcctl` from `PATH`.
- On macOS, `ddcctl` fallback is only considered safe when there is a single external display and the tool can report that count reliably. If multiple external displays are attached, or the count cannot be determined, the app refuses the fallback instead of risking a wrong-screen switch.
- When the app has to use `ddcctl`, it tries the configured local display index first, discovers how many external displays `ddcctl` can see, and then tries the remaining valid indices automatically.
- The app starts a local settings page on port `3847` and binds it to `127.0.0.1` only. The HTTP server is only used for local setup and local direct switch actions; the app does not rely on LAN peer discovery or cross-machine coordination.
- If port `3847` is unavailable, the local pages automatically fall back to another free local port.
- The local `/health` endpoint reports an Electron display snapshot only; it does not run DDC probes, query current input, or rewrite monitor configuration.
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
