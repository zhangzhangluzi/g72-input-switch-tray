const { app, Tray, Menu, nativeImage, Notification, dialog, shell, screen } = require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  doesMonitorListContainConfiguredMonitor,
  normalizeText,
} = require("./monitor-name-helpers");

const APP_NAME = "显示器输入切换";
const APP_ID = "com.zhangzhangluzi.g72inputswitchtray";
const WINDOWS_TRAY_GUID = "f5b6f5d6-2917-42e3-b552-b5796b6f7f0d";
const PREFERRED_CONTROL_PORT = 3847;
const TRAY_REBUILD_DELAY_MS = 1200;
const TRAY_HEALTHCHECK_INTERVAL_MS = 5000;
const WINDOWS_DISPLAY_HANDOFF_DELAY_MS = 1500;
const PEER_CONFIRMATION_TIMEOUT_MS = 4000;
const PEER_CONFIRMATION_POLL_MS = 250;
const LOCAL_HANDOFF_INFERENCE_WINDOW_MS = 10 * 60 * 1000;
const MANUAL_HANDOFF_TIMEOUT_MS = 30 * 1000;
const TARGET_IDS = ["windows", "mac"];
const COMMON_INPUT_VALUES = [
  { value: 15, label: "15: DP1" },
  { value: 16, label: "16: DP2" },
  { value: 17, label: "17: HDMI1" },
  { value: 18, label: "18: HDMI2" },
  { value: 19, label: "19: HDMI3 / Component" },
  { value: 27, label: "27: USB-C / Type-C（部分显示器）" },
];
const COMMON_INPUT_LABELS = new Map(
  COMMON_INPUT_VALUES.map((item) => [item.value, item.label.replace(/^\d+:\s*/, "")])
);
const MAC_PROBE_COMMON_INPUT_VALUES = Array.from(
  new Set([...COMMON_INPUT_VALUES.map((item) => item.value), 3, 5, 6, 7, 9])
);

let tray = null;
let controlServer = null;
let controlServerError = null;
let activeControlPort = PREFERRED_CONTROL_PORT;
let windowsRestoreTimer = null;
let windowsRestoreInFlight = false;
let windowsMonitorAvailability = {
  status: "unknown",
  names: [],
  message: "",
  owner: "unknown",
  currentInputValue: null,
};
let windowsMonitorAvailabilityInFlight = false;
let trayRebuildTimer = null;
let trayHealthTimer = null;
let explorerSignature = null;
let manualSessionTimer = null;
let manualSessionInFlight = false;
let state = createDefaultState();

// Suppress noisy Chromium network-change logs on some Windows systems.
app.commandLine.appendSwitch("log-level", "3");

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

process.on("unhandledRejection", (reason) => {
  appendDiagnosticLog("Unhandled promise rejection", reason);
  scheduleTrayRebuild("unhandled-rejection", 0);
});

process.on("uncaughtException", (error) => {
  appendDiagnosticLog("Uncaught exception", error);
  scheduleTrayRebuild("uncaught-exception", 0);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (tray && process.platform === "win32") {
    tray.popUpContextMenu();
  }
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  if (controlServer) {
    controlServer.close();
  }

  if (windowsRestoreTimer) {
    clearInterval(windowsRestoreTimer);
    windowsRestoreTimer = null;
  }

  if (trayRebuildTimer) {
    clearTimeout(trayRebuildTimer);
    trayRebuildTimer = null;
  }

  if (trayHealthTimer) {
    clearInterval(trayHealthTimer);
    trayHealthTimer = null;
  }

  if (manualSessionTimer) {
    clearInterval(manualSessionTimer);
    manualSessionTimer = null;
  }
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  state = loadState();
  state.manualSession = createDefaultManualSessionState();
  saveState(state);
  startControlServer();
  startWindowsRestoreWatcher();
  startWindowsTrayWatcher();
  createTray();
  refreshMenu();
});

function createTray() {
  const iconName = process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const iconPath = path.join(__dirname, "..", "assets", iconName);
  let icon = nativeImage.createFromPath(iconPath);

  if (process.platform === "darwin") {
    icon = icon.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
  }

  destroyTray();
  tray =
    process.platform === "win32"
      ? new Tray(icon, WINDOWS_TRAY_GUID)
      : new Tray(icon);
  tray.setToolTip(APP_NAME);

  if (process.platform === "win32") {
    tray.on("click", () => tray.popUpContextMenu());
    tray.on("right-click", () => tray.popUpContextMenu());
  }
}

function destroyTray() {
  if (!tray) {
    return;
  }

  try {
    tray.destroy();
  } catch {
    // Ignore stale tray handles during shell/display transitions.
  }

  tray = null;
}

function rebuildTray(reason = "unknown") {
  appendDiagnosticLog(`Rebuilding tray (${reason})`);
  createTray();
  refreshMenu();
}

function scheduleTrayRebuild(reason, delayMs = TRAY_REBUILD_DELAY_MS) {
  if (process.platform !== "win32") {
    return;
  }

  if (trayRebuildTimer) {
    clearTimeout(trayRebuildTimer);
  }

  trayRebuildTimer = setTimeout(() => {
    trayRebuildTimer = null;
    rebuildTray(reason);
  }, delayMs);
}

function refreshMenu() {
  if (!tray) {
    return;
  }

  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const configErrors = getConfigValidationErrors(state.config);
  const directSwitchMenuItems = TARGET_IDS.map((targetId) => ({
    label: `直接切到 ${getTarget(targetId).label}`,
    enabled: configErrors.length === 0,
    click: () => handleTrayDirectSwitch(targetId),
  }));
  const refreshWindowsMenuItems =
    process.platform === "win32"
      ? [
          {
            label: "主动刷新 Windows 屏幕状态",
            click: () => {
              void refreshWindowsDisplayState({
                notifyOnSuccess: true,
              });
            },
          },
        ]
      : [];

  const menu = Menu.buildFromTemplate([
    {
      label: `版本：v${app.getVersion()}`,
      enabled: false,
    },
    {
      label: `当前显示器：${state.config.monitorName || "未设置"}`,
      enabled: false,
    },
    ...(process.platform === "win32" && state.windowsDesktop.pendingRestore
      ? [
          {
            label: `Windows 桌面：当前只保留主屏；等软件判断 ${state.config.monitorName || "目标显示器"} 回来后再尝试恢复扩展`,
            enabled: false,
          },
        ]
      : []),
    ...(configErrors.length > 0
      ? [
          {
            label: `配置未完成：${configErrors[0]}`,
            enabled: false,
          },
        ]
      : []),
    { type: "separator" },
    ...directSwitchMenuItems,
    ...(
      refreshWindowsMenuItems.length > 0
        ? [{ type: "separator" }, ...refreshWindowsMenuItems]
        : []
    ),
    { type: "separator" },
    {
      label: "开机时启动",
      type: "checkbox",
      checked: openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
        });
        refreshMenu();
      },
    },
    {
      label: "打开应用所在文件夹",
      click: () => shell.showItemInFolder(process.execPath),
    },
    { type: "separator" },
    {
      label: "卸载...",
      click: () => uninstallApp(),
    },
    {
      label: "退出",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(menu);
}

function handleTrayDirectSwitch(targetId) {
  void switchMonitor(targetId, {
    notifyOnSuccess: true,
    showErrorDialog: false,
  }).catch((error) => {
    appendDiagnosticLog(`Direct local switch failed (${targetId})`, error);
  });
}

function handleTrayManualHandoffAction(targetId, preferredAction) {
  void prepareManualHandoff(targetId, {
    showErrorDialog: false,
    preferredAction,
  }).catch((error) => {
    appendDiagnosticLog(`Manual handoff preparation failed (${preferredAction || "auto"}:${targetId})`, error);
  });
}

async function switchMonitor(targetId, options = {}) {
  const { notifyOnSuccess = true, showErrorDialog = false } = options;
  const target = getTarget(targetId);
  const configErrors = getConfigValidationErrors(state.config);

  if (configErrors.length > 0) {
    const error = new Error(configErrors.join(" "));
    recordSwitchOutcome("error", targetId, error.message);
    saveState(state);
    refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, `当前配置无效。\n\n${error.message}`);
    }

    throw error;
  }

  try {
    resetManualSessionState();

    if (process.platform === "win32") {
      await switchOnWindows(targetId, target);
    } else if (process.platform === "darwin") {
      await switchOnMac(targetId, target);
    } else {
      throw new Error(`当前平台不受支持：${process.platform}`);
    }

    persistSuccessfulLocalSwitch(targetId, target);

    if (notifyOnSuccess) {
      notify(`本机切换流程已执行，并已向 ${state.config.monitorName} 发送切换命令：${target.label}。`);
    }
  } catch (error) {
    const userFacingError = createUserFacingSwitchError(targetId, error);
    recordSwitchOutcome("error", targetId, userFacingError.message);
    saveState(state);
    refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(
        APP_NAME,
        `${target.label} 切换失败。\n\n${userFacingError.message}`
      );
    }

    throw userFacingError;
  }
}

async function prepareManualHandoff(targetId, options = {}) {
  const { notifyOnSuccess = true, showErrorDialog = false, preferredAction = null } = options;
  const target = getTarget(targetId);
  const configErrors = getConfigValidationErrors(state.config);

  if (configErrors.length > 0) {
    const error = new Error(configErrors.join(" "));
    state.lastSwitchOutcome = createSwitchOutcome({
      status: "error",
      targetId,
      mode: "manual_prep",
      message: error.message,
    });
    saveState(state);
    refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, `当前配置无效。\n\n${error.message}`);
    }

    throw error;
  }

  try {
    const plan = resolveManualHandoffPlan(targetId, preferredAction);
    await assertManualHandoffStartState(plan);
    const result =
      plan.kind === "transfer"
        ? await prepareManualTransfer(plan, target)
        : await prepareManualReceive(plan, target);
    const message = result.message;
    const shouldStartSession = result.startSession !== false;
    const preserveSwitchOutcome = result.preserveSwitchOutcome === true;

    state.macInputProbe = createMacInputProbeResult();
    state.manualSession = shouldStartSession
      ? createManualSessionState({
          kind: plan.kind,
          expectedOwnerTargetId: plan.expectedOwnerTargetId,
          sourceTargetId: plan.sourceTargetId,
          localAction: result.localAction,
        })
      : createDefaultManualSessionState();
    if (!preserveSwitchOutcome) {
      state.lastSwitchOutcome = createSwitchOutcome({
        status: "success",
        targetId,
        mode: "manual_prep",
        message,
      });
    }
    saveState(state);
    refreshMenu();

    if (notifyOnSuccess) {
      notify(message);
    }
  } catch (error) {
    const userFacingError = createUserFacingSwitchError(targetId, error);
    state.lastSwitchOutcome = createSwitchOutcome({
      status: "error",
      targetId,
      mode: "manual_prep",
      message: userFacingError.message,
    });
    saveState(state);
    refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, `手动交接准备失败。\n\n${userFacingError.message}`);
    }

    throw userFacingError;
  }
}

function persistSuccessfulLocalSwitch(targetId, target) {
  state.lastTarget = targetId;
  state.macInputProbe = createMacInputProbeResult();
  recordSwitchOutcome("success", targetId, `本机切换流程已执行，并已向 ${state.config.monitorName} 发送切换命令：${target.label}。`);
  saveState(state);
  refreshMenu();
}

function resolveManualHandoffPlan(targetId, preferredAction = null) {
  const localTargetId = getLocalPlatformTargetId();
  const parsedTargetId = parseTargetId(targetId);
  const parsedAction = parseManualHandoffAction(preferredAction);
  const oppositeTargetId = getOppositeTargetId(localTargetId);

  if (!localTargetId) {
    throw new Error("当前平台没有实现手动切源辅助。");
  }

  if (!parsedTargetId) {
    throw new Error("当前没有可用的手动交接目标。");
  }

  if (state.manualSession.active) {
    throw new Error(`当前有一笔手动交接正在等待完成（剩余 ${getManualSessionRemainingSeconds()} 秒）。`);
  }

  if (parsedAction === "receive") {
    if (parsedTargetId !== localTargetId) {
      throw new Error(`“接收”只能在 ${getTarget(localTargetId).label} 这一侧执行。`);
    }

    return {
      kind: "receive",
      localTargetId,
      targetId: localTargetId,
      sourceTargetId: oppositeTargetId,
      expectedOwnerTargetId: localTargetId,
    };
  }

  if (parsedAction === "transfer") {
    if (parsedTargetId !== oppositeTargetId) {
      throw new Error(`“移交”只能把共享屏交给 ${getTarget(oppositeTargetId).label}。`);
    }

    return {
      kind: "transfer",
      localTargetId,
      targetId: oppositeTargetId,
      sourceTargetId: localTargetId,
      expectedOwnerTargetId: oppositeTargetId,
    };
  }

  if (parsedTargetId === localTargetId) {
    return {
      kind: "receive",
      localTargetId,
      targetId: parsedTargetId,
      sourceTargetId: oppositeTargetId,
      expectedOwnerTargetId: localTargetId,
    };
  }

  return {
    kind: "transfer",
    localTargetId,
    targetId: parsedTargetId,
    sourceTargetId: localTargetId,
    expectedOwnerTargetId: parsedTargetId,
  };
}

async function assertManualHandoffStartState(plan) {
  const snapshot = await getTargetedLocalOwnershipSnapshot(plan.expectedOwnerTargetId);
  if (snapshot.owner === "unknown") {
    return;
  }

  if (plan.kind === "transfer" && snapshot.owner === plan.expectedOwnerTargetId) {
    throw new Error(
      `软件当前判断 ${state.config.monitorName} 已经在 ${getTarget(plan.expectedOwnerTargetId).label} 这一侧，不需要再从本侧点“移交”。`
    );
  }

  if (plan.kind === "receive" && snapshot.owner === plan.expectedOwnerTargetId) {
    throw new Error(
      `软件当前判断 ${state.config.monitorName} 已经回到 ${getTarget(plan.expectedOwnerTargetId).label} 这一侧，不需要再重复点“接收”。`
    );
  }
}

async function prepareManualTransfer(plan, target) {
  if (process.platform === "win32") {
    return prepareManualTransferOnWindows(plan, target);
  }

  if (process.platform === "darwin") {
    return prepareManualTransferOnMac(plan, target);
  }

  throw new Error(`当前平台不受支持：${process.platform}`);
}

async function prepareManualReceive(plan, target) {
  if (process.platform === "win32") {
    return prepareManualReceiveOnWindows(plan, target);
  }

  if (process.platform === "darwin") {
    return prepareManualReceiveOnMac(plan, target);
  }

  throw new Error(`当前平台不受支持：${process.platform}`);
}

async function switchOnWindows(targetId, target, options = {}) {
  const { forceDisplayHandoff = false } = options;
  const attachedDisplayCountBeforeSwitch =
    targetId !== "windows"
      ? await getCurrentWindowsAttachedDisplayCount()
      : null;
  const handoffEnabledByConfig = state.config.windowsDisplayHandoffMode !== "off";
  const canDetachSharedMonitor =
    (Number.isInteger(attachedDisplayCountBeforeSwitch) &&
      attachedDisplayCountBeforeSwitch > 1) ||
    canWindowsManualTransferDetachSharedMonitor();
  const useDisplayHandoff = forceDisplayHandoff
    ? targetId !== "windows" && canDetachSharedMonitor
    : targetId === "windows"
      ? state.windowsDesktop.pendingRestore || shouldUseWindowsDisplayHandoff(state.config)
      : handoffEnabledByConfig &&
        (shouldUseWindowsDisplayHandoff(state.config) || canDetachSharedMonitor);
  await assertWindowsSharedMonitorAvailableForSwitch();
  let desktopHandedOff = false;

  if (useDisplayHandoff && targetId === "windows") {
    await restoreWindowsDesktopToTargetMonitor();
    clearPendingWindowsDesktopRestore();
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const candidates = getInputCandidates(target);
  const expectedValues = getExpectedProbeInputValues(target.inputValue);

  try {
    await runCandidateSequence(candidates, async (candidate) => {
      await runCommand("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-MonitorName",
        state.config.monitorName,
        "-InputValue",
        String(candidate),
      ]);
      await verifyWindowsSwitchOutcome(targetId, target, expectedValues);
    });
  } catch (error) {
    if (
      useDisplayHandoff &&
      targetId !== "windows" &&
      shouldAttemptWindowsDesktopHandoffRecovery(error)
    ) {
      desktopHandedOff = await attemptWindowsDesktopHandoffRecovery(
        targetId,
        attachedDisplayCountBeforeSwitch
      );
      if (desktopHandedOff) {
        return;
      }
    }

    const ownershipConfirmation = await confirmTargetOwnership(targetId);
    if (!ownershipConfirmation.confirmed) {
      throw error;
    }
  }

  if (useDisplayHandoff && targetId !== "windows" && !desktopHandedOff) {
    await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
    await handOffWindowsDesktop();
    markPendingWindowsDesktopRestore(attachedDisplayCountBeforeSwitch);
  }
}

async function prepareManualTransferOnWindows(plan, target) {
  const willDetachSharedScreen = canWindowsManualTransferDetachSharedMonitor();
  await switchOnWindows(plan.targetId, target, {
    forceDisplayHandoff: true,
  });
  persistSuccessfulLocalSwitch(plan.targetId, target);
  return {
    message: willDetachSharedScreen
      ? `Windows 已执行移交，并已尝试把 ${state.config.monitorName} 切到 ${target.label}；桌面也已退回主显示器。若另一侧已先点“接收”，软件会继续判断接收是否完成。`
      : `Windows 已执行移交，并已尝试把 ${state.config.monitorName} 切到 ${target.label}。若另一侧已先点“接收”，软件会继续判断接收是否完成。`,
    localAction: "none",
    startSession: false,
    preserveSwitchOutcome: true,
  };
}

function switchOnMac(targetId, target) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  const candidates = getInputCandidates(target);
  return Promise.resolve()
    .then(() =>
      runCandidateSequence(candidates, (candidate) =>
        runCommand("/bin/sh", [scriptPath, String(candidate)], {
          env: {
            DISPLAY_NAME: state.config.monitorName,
            DISPLAY_INDEX: String(state.config.macDisplayIndex),
          },
        })
      )
    )
    .catch(async (error) => {
      const ownershipConfirmation = await confirmTargetOwnership(targetId);
      if (ownershipConfirmation.confirmed) {
        return;
      }

      throw error;
    });
}

async function prepareManualTransferOnMac(plan, target) {
  await switchOnMac(plan.targetId, target);
  persistSuccessfulLocalSwitch(plan.targetId, target);
  return {
    message: `Mac 已执行移交，并已尝试把 ${state.config.monitorName} 切到 ${target.label}。若 ${getTarget(
      plan.targetId
    ).label} 那一侧已先点“接收”，软件会继续判断接收是否完成。`,
    localAction: "none",
    startSession: false,
    preserveSwitchOutcome: true,
  };
}

async function prepareManualReceiveOnWindows(plan, target) {
  const result = await prepareWindowsDesktopForIncomingOwnership();
  if (!result.prepared) {
    throw new Error(result.detail || `Windows 没有准备好接收 ${target.label}。`);
  }

  return {
    message: `Windows 已准备好接收。现在请回到 ${getTarget(
      plan.sourceTargetId
    ).label} 那一侧点击“移交”；真正的切屏动作会在那一侧执行。`,
    localAction: "windows_receive",
  };
}

async function prepareManualReceiveOnMac(plan, target) {
  return {
    message: `Mac 已进入手动接收流程；这一步只负责等待共享屏回来，不会立即切屏。现在请回到 ${getTarget(
      plan.sourceTargetId
    ).label} 那一侧点击“移交”；真正的切屏动作会在那一侧执行。`,
    localAction: "none",
  };
}

function createUserFacingSwitchError(targetId, error) {
  const rawMessage = normalizeText(error?.message);
  const formattedMessage = formatSwitchErrorMessage(targetId, rawMessage);

  if (!formattedMessage || formattedMessage === rawMessage) {
    return error;
  }

  const nextError = new Error(formattedMessage);
  nextError.cause = error;
  return nextError;
}

function formatSwitchErrorMessage(targetId, rawMessage) {
  if (!rawMessage) {
    return "切换失败。请打开设置页检查当前配置。";
  }

  if (process.platform === "darwin") {
    return formatMacSwitchErrorMessage(targetId, rawMessage);
  }

  if (process.platform === "win32") {
    return formatWindowsSwitchErrorMessage(targetId, rawMessage);
  }

  return rawMessage;
}

function formatMacSwitchErrorMessage(targetId, rawMessage) {
  const betterDisplayMismatchMatch = /^BetterDisplay 已发送输入切换命令，但当前输入仍是 ([0-9]+)，未匹配目标值集合：([0-9 ]+)$/u.exec(
    rawMessage
  );
  if (betterDisplayMismatchMatch) {
    const currentValue = Number.parseInt(betterDisplayMismatchMatch[1], 10);
    const expectedValues = betterDisplayMismatchMatch[2].trim().split(/\s+/).join(" / ");
    const target = getTarget(targetId);
    return `显示器仍停留在 ${describeInputValue(
      currentValue
    )}。这只说明显示器没有切到 ${target.label}；常见原因是 ${getTargetSlotName(
      targetId
    )} 的输入值还没配对，或者目标设备当前没有稳定可切入的信号。请先确认目标设备正在输出画面，再到设置页里的“输入值探测助手”为 ${target.label} 测试并保存正确值。当前候选集合：${expectedValues}。`;
  }

  if (/^Failed\.?$/i.test(rawMessage)) {
    return `底层工具只返回了“Failed.”。请打开设置页里的“输入值探测助手”，重新确认 ${getTargetSlotName(
      targetId
    )} 的输入值。`;
  }

  return rawMessage;
}

function formatWindowsSwitchErrorMessage(targetId, rawMessage) {
  const missingMonitorMatch = /^No monitor matched '([^']+)'\. Available monitors: (.+)$/i.exec(rawMessage);
  if (missingMonitorMatch) {
    const requestedName = missingMonitorMatch[1];
    const availableText = missingMonitorMatch[2];

    if (availableText === "<none>") {
      return `Windows 当前没有看到共享屏“${requestedName}”。如果它已经切到 Mac，这是正常的，请在 Mac 端或显示器菜单把它切回；如果它本来就在 Windows 侧，请确认显示器已连接、已亮屏，并且 DDC/CI 已开启。`;
    }

    return `Windows 当前没有看到配置的共享屏“${requestedName}”。现在能看到的是：${availableText}。如果共享屏已经切到 Mac，这是预期行为，请到 Mac 端或显示器菜单切回；如果共享屏此刻明明在 Windows 侧，再把设置页里的“显示器名称”改成 Windows 实际识别到的名称。`;
  }

  const noPhysicalHandleMatch = /^No physical monitor handles were found for '([^']+)'\.$/i.exec(rawMessage);
  if (noPhysicalHandleMatch) {
    return `Windows 找到了“${noPhysicalHandleMatch[1]}”，但没有拿到可控的物理显示器句柄。请确认它是支持 DDC/CI 的外接显示器，并在显示器菜单里开启 DDC/CI。`;
  }

  const setInputFailedMatch = /^Setting VCP 0x60 to value ([0-9]+) failed for '([^']+)'\.$/i.exec(rawMessage);
  if (setInputFailedMatch) {
    return `Windows 已找到“${setInputFailedMatch[2]}”，但显示器拒绝了输入值 ${setInputFailedMatch[1]}。请确认 DDC/CI 已开启，并检查模式 A / 模式 B 的输入值是否填对。`;
  }

  const windowsMismatchMatch = /^Windows 已发送输入切换命令，但当前输入仍是 ([0-9]+)，未匹配目标值集合：([0-9 ]+)$/u.exec(
    rawMessage
  );
  if (windowsMismatchMatch) {
    const currentValue = Number.parseInt(windowsMismatchMatch[1], 10);
    const expectedValues = windowsMismatchMatch[2].trim().split(/\s+/).join(" / ");
    const target = getTarget(targetId);
    return `Windows 已把切换命令发给 ${state.config.monitorName}，但这块共享屏仍停留在 ${describeInputValue(
      currentValue
    )}。这通常说明 ${target.label} 的输入值还没配对，或者目标设备当前没有稳定可切入的信号。请先确认目标设备正在输出画面，再检查设置页里的输入值配置。当前候选集合：${expectedValues}。`;
  }

  const windowsVerificationMatch = /^Windows 已发送输入切换命令，但还没有确认 (.+) 是否真正接管了共享屏。$/u.exec(
    rawMessage
  );
  if (windowsVerificationMatch) {
    return `Windows 已发出切换命令，但暂时还没确认 ${windowsVerificationMatch[1]} 是否真正接管了共享屏。请确认目标设备正在输出画面，并检查显示器名称、DDC/CI 与输入值配置。`;
  }

  if (/^Failed\.?$/i.test(rawMessage)) {
    return "Windows 底层命令只返回了“Failed.”。请先到设置页确认显示器名称和输入值，再重新尝试切换。";
  }

  return rawMessage;
}

function uninstallApp() {
  const { response } = dialog.showMessageBoxSync
    ? {
        response: dialog.showMessageBoxSync({
          type: "question",
          buttons: ["取消", "卸载"],
          defaultId: 1,
          cancelId: 0,
          title: APP_NAME,
          message: `要卸载 ${APP_NAME} 吗？`,
          detail:
            process.platform === "win32"
              ? "将打开 Windows 卸载程序。"
              : "应用将退出，然后从“应用程序”中移除自身。",
        }),
      }
    : { response: 0 };

  if (response !== 1) {
    return;
  }

  app.setLoginItemSettings({ openAtLogin: false });

  if (process.platform === "win32") {
    uninstallOnWindows();
    return;
  }

  if (process.platform === "darwin") {
    uninstallOnMac();
    return;
  }

  dialog.showErrorBox(APP_NAME, `当前平台不支持卸载：${process.platform}。`);
}

function uninstallOnWindows() {
  const appDir = path.dirname(process.execPath);
  const entries = fs.readdirSync(appDir);
  const uninstallFile = entries.find((entry) => /^Uninstall .*\.exe$/i.test(entry));

  if (!uninstallFile) {
    dialog.showErrorBox(APP_NAME, "在应用可执行文件旁未找到 Windows 卸载程序。");
    return;
  }

  execFile(path.join(appDir, uninstallFile), (error) => {
    if (error) {
      dialog.showErrorBox(APP_NAME, `无法打开卸载程序。\n\n${error.message}`);
    }
  });

  app.quit();
}

function uninstallOnMac() {
  const appBundlePath = path.resolve(process.execPath, "../../..");
  const tempScriptPath = path.join(os.tmpdir(), `monitor-input-switch-uninstall-${Date.now()}.sh`);
  const escapedAppPath = shellEscape(appBundlePath);
  const appleScriptPath = appleScriptEscape(appBundlePath);

  const script = `#!/bin/sh
APP_PATH='${escapedAppPath}'
sleep 2
/usr/bin/osascript <<APPLESCRIPT
set appPath to "${appleScriptPath}"
try
  tell application "Finder"
    delete POSIX file appPath
  end tell
on error
  do shell script "rm -rf " & quoted form of appPath with administrator privileges
end try
APPLESCRIPT
rm -f "$0"
`;

  fs.writeFileSync(tempScriptPath, script, { mode: 0o700 });
  const child = execFile("/bin/sh", [tempScriptPath], {
    detached: true,
    windowsHide: true,
  });
  child.unref();
  app.quit();
}

function startControlServer() {
  controlServerError = null;
  activeControlPort = PREFERRED_CONTROL_PORT;
  controlServer = http.createServer((request, response) => {
    handleControlRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`设置页请求失败：${error.message}`);
    });
  });

  let fallbackAttempted = false;

  controlServer.on("error", (error) => {
    if (!fallbackAttempted && isRecoverablePortError(error)) {
      fallbackAttempted = true;
      setImmediate(() => {
        if (controlServer) {
          controlServer.listen(0, "0.0.0.0");
        }
      });
      return;
    }

    controlServerError = error;
    controlServer = null;
    refreshMenu();
    notify(`本机设置页启动失败：${error.message}`);
  });

  controlServer.listen(PREFERRED_CONTROL_PORT, "0.0.0.0", () => {
    activeControlPort = getListeningPort();
    controlServerError = null;
    refreshMenu();
  });
}

async function handleControlRequest(request, response) {
  const baseUrl = `http://${request.headers.host || "127.0.0.1"}`;
  const requestUrl = new URL(request.url || "/", baseUrl);
  const controlPath = getControlPath();
  const settingsPath = getSettingsPath();
  const statePath = `/api/${state.controlToken}/state`;
  const configPath = `/api/${state.controlToken}/config`;
  const monitorsPath = `/api/${state.controlToken}/monitors`;
  const switchWindowsPath = `/api/${state.controlToken}/switch/windows`;
  const switchMacPath = `/api/${state.controlToken}/switch/mac`;
  const manualWindowsPath = `/api/${state.controlToken}/manual/windows`;
  const manualMacPath = `/api/${state.controlToken}/manual/mac`;
  const windowsRefreshPath = `/api/${state.controlToken}/windows/refresh`;
  const macProbePath = `/api/${state.controlToken}/probe/mac`;
  const macProbeApplyPath = `/api/${state.controlToken}/probe/mac/apply`;

  if (requestUrl.pathname === "/health") {
    return writeJson(response, 200, {
      ok: true,
      appName: APP_NAME,
      version: app.getVersion(),
      lastTarget: state.lastTarget,
      monitorName: state.config.monitorName,
    });
  }

  if (!isLoopbackRequest(request)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("仅允许本机访问设置与控制接口。");
    return;
  }

  if (requestUrl.pathname === statePath) {
    return writeJson(response, 200, {
      ok: true,
      version: app.getVersion(),
      config: state.config,
    });
  }

  if (requestUrl.pathname === configPath && request.method === "GET") {
    return writeJson(response, 200, {
      ok: true,
      config: state.config,
    });
  }

  if (requestUrl.pathname === monitorsPath) {
    const monitors = await getAvailableMonitorNames();

    return writeJson(response, 200, {
      ok: true,
      monitors,
    });
  }

  if (requestUrl.pathname === controlPath) {
    return redirectToSettingsPage(response, requestUrl, {});
  }

  if (requestUrl.pathname === settingsPath) {
    const [monitors, diagnostics, macProbeDiagnostics] = await Promise.all([
      getAvailableMonitorNames(),
      getMonitorDiagnostics(),
      getMacProbeDiagnostics(),
    ]);
    return writeHtml(
      response,
      200,
      renderSettingsPage(requestUrl, monitors, diagnostics, macProbeDiagnostics)
    );
  }

  if (requestUrl.pathname === configPath && request.method === "POST") {
    return handleConfigSave(request, response, requestUrl);
  }

  if (requestUrl.pathname === switchWindowsPath && request.method === "POST") {
    return handleSwitchRequest(response, requestUrl, "windows");
  }

  if (requestUrl.pathname === switchMacPath && request.method === "POST") {
    return handleSwitchRequest(response, requestUrl, "mac");
  }

  if (requestUrl.pathname === macProbePath && request.method === "POST") {
    return handleMacProbe(request, response, requestUrl);
  }

  if (requestUrl.pathname === macProbeApplyPath && request.method === "POST") {
    return handleMacProbeApply(request, response, requestUrl);
  }

  if (requestUrl.pathname === manualWindowsPath) {
    return handleManualHandoffRequest(request, response, requestUrl, "windows");
  }

  if (requestUrl.pathname === manualMacPath) {
    return handleManualHandoffRequest(request, response, requestUrl, "mac");
  }

  if (requestUrl.pathname === windowsRefreshPath && request.method === "POST") {
    return handleWindowsRefreshRequest(response, requestUrl);
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("未找到对应页面。");
}

async function handleConfigSave(request, response, requestUrl) {
  const body = await readRequestBody(request);
  const form = new URLSearchParams(body);
  const { config, errors } = buildConfigFromForm(form);

  if (errors.length > 0) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: errors.join(" "),
    });
    return;
  }

  state.config = config;
  state.macInputProbe = createMacInputProbeResult();
  saveState(state);
  refreshMenu();
  if (process.platform === "win32") {
    void refreshWindowsMonitorAvailability();
  }

  redirectToSettingsPage(response, requestUrl, {
    status: "success",
  });
}

async function handleSwitchRequest(response, requestUrl, targetId) {
  try {
    await switchMonitor(targetId, {
      notifyOnSuccess: true,
      showErrorDialog: false,
    });
  } catch (error) {
    notify(normalizeText(error.message) || "直接切换失败。");
  }

  redirectToSettingsPage(response, requestUrl, {});
}

async function handleManualHandoffRequest(request, response, requestUrl, targetId) {
  if (!["GET", "POST"].includes(request.method || "GET")) {
    response.writeHead(405, {
      Allow: "GET, POST",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("当前接口只支持 GET 或 POST。");
    return;
  }

  let preferredAction = parseManualHandoffAction(requestUrl.searchParams.get("action"));
  if (request.method === "POST") {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    preferredAction = parseManualHandoffAction(form.get("action")) || preferredAction;
  }

  try {
    await prepareManualHandoff(targetId, {
      notifyOnSuccess: true,
      showErrorDialog: false,
      preferredAction,
    });
    redirectToSettingsPage(response, requestUrl, {});
  } catch (error) {
    notify(error.message || "手动交接准备失败。");
    redirectToSettingsPage(response, requestUrl, {});
  }
}

async function handleWindowsRefreshRequest(response, requestUrl) {
  try {
    await refreshWindowsDisplayState({
      notifyOnSuccess: true,
    });
  } catch (error) {
    notify(normalizeText(error.message) || "Windows 主动刷新失败。");
  }

  redirectToSettingsPage(response, requestUrl, {});
}

async function handleMacProbe(request, response, requestUrl) {
  const body = await readRequestBody(request);
  const form = new URLSearchParams(body);
  const targetId = parseTargetId(form.get("targetId"));
  const candidate = parseInputValue(form.get("candidate"));

  if (process.platform !== "darwin") {
    state.macInputProbe = createMacInputProbeResult({
      targetId,
      candidate,
      status: "error",
      message: "输入值探测目前只在 macOS 版本里提供。",
    });
    saveState(state);
    redirectToSettingsPage(response, requestUrl, {});
    return;
  }

  if (!targetId) {
    state.macInputProbe = createMacInputProbeResult({
      targetId: "windows",
      candidate,
      status: "error",
      message: "请选择要写回的目标模式。",
    });
    saveState(state);
    redirectToSettingsPage(response, requestUrl, {});
    return;
  }

  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 255) {
    state.macInputProbe = createMacInputProbeResult({
      targetId,
      candidate: null,
      status: "error",
      message: "请输入 1 到 255 的输入值后再测试。",
    });
    saveState(state);
    redirectToSettingsPage(response, requestUrl, {});
    return;
  }

  state.macInputProbe = await runMacInputProbe(targetId, candidate);
  saveState(state);
  redirectToSettingsPage(response, requestUrl, {});
}

async function handleMacProbeApply(request, response, requestUrl) {
  const body = await readRequestBody(request);
  const form = new URLSearchParams(body);
  const targetId = parseTargetId(form.get("targetId"));
  const candidate = parseInputValue(form.get("candidate"));

  if (!targetId || !Number.isInteger(candidate) || candidate < 1 || candidate > 255) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: "没有可保存的探测结果。",
    });
    return;
  }

  state.config.targets[targetId].inputValue = candidate;
  state.macInputProbe = createMacInputProbeResult({
    targetId,
    candidate,
    status: "saved",
    message: `${getTarget(targetId).label} 的输入值已更新为 ${candidate}。`,
  });
  saveState(state);
  refreshMenu();
  redirectToSettingsPage(response, requestUrl, {
    status: "success",
    message: state.macInputProbe.message,
  });
}

async function runMacInputProbe(targetId, candidate) {
  const beforeResult = await getMacCurrentInputResult();
  let commandError = "";

  try {
    await sendMacInputValue(candidate);
  } catch (error) {
    commandError = error.message;
  }

  await delay(250);
  const afterResult = await getMacCurrentInputResult();
  const expectedValues = getExpectedProbeInputValues(candidate);
  const beforeValue = beforeResult.ok ? beforeResult.value : null;
  const matchedExpectedValue = afterResult.ok && expectedValues.includes(afterResult.value);
  const unchangedValue =
    afterResult.ok && beforeResult.ok && afterResult.value === beforeResult.value;

  if (matchedExpectedValue) {
    if (commandError && unchangedValue) {
      return createMacInputProbeResult({
        targetId,
        candidate,
        status: "error",
        beforeValue,
        afterValue: afterResult.value,
        expectedValues,
        commandError,
        message: `测试 ${candidate} 时底层命令返回了错误，当前输入虽然仍是 ${describeInputValue(
          afterResult.value
        )}，但无法确认这次切换是否真的成功。`,
      });
    }

    return createMacInputProbeResult({
      targetId,
      candidate,
      status: "matched",
      beforeValue,
      afterValue: afterResult.value,
      expectedValues,
      commandError,
      message: commandError
        ? `测试 ${candidate} 时底层命令返回了错误，但当前输入回报已经命中 ${getTargetSlotName(
            targetId
          )} 的候选集合：${describeInputValue(afterResult.value)}。请结合画面实际变化确认。`
        : `值 ${candidate} 已命中 ${getTargetSlotName(targetId)} 的候选集合，当前输入回报为 ${describeInputValue(
            afterResult.value
          )}。`,
    });
  }

  if (unchangedValue) {
    return createMacInputProbeResult({
      targetId,
      candidate,
      status: commandError ? "error" : "unchanged",
      beforeValue: beforeResult.value,
      afterValue: afterResult.value,
      expectedValues,
      commandError,
      message: commandError
        ? `测试 ${candidate} 时底层命令失败，显示器当前输入仍是 ${describeInputValue(
            afterResult.value
          )}。`
        : `测试 ${candidate} 后，显示器当前输入仍是 ${describeInputValue(afterResult.value)}。`,
    });
  }

  if (afterResult.ok) {
    return createMacInputProbeResult({
      targetId,
      candidate,
      status: commandError ? "error" : "different",
      beforeValue,
      afterValue: afterResult.value,
      expectedValues,
      commandError,
      message: commandError
        ? `测试 ${candidate} 时底层命令失败，当前输入回报为 ${describeInputValue(
            afterResult.value
          )}，没有匹配预期集合 ${expectedValues.join(" / ")}。`
        : `测试 ${candidate} 后，当前输入回报为 ${describeInputValue(
            afterResult.value
          )}，没有匹配预期集合 ${expectedValues.join(" / ")}。`,
    });
  }

  return createMacInputProbeResult({
    targetId,
    candidate,
    status: "inconclusive",
    beforeValue: beforeResult.ok ? beforeResult.value : null,
    afterValue: null,
    expectedValues,
    commandError,
    message:
      commandError ||
      afterResult.error ||
      "命令已发送，但目前无法重新读回当前输入值。若画面已经切到另一台设备，请切回后把这个值保存到对应模式。",
  });
}

async function getMacProbeDiagnostics() {
  if (process.platform !== "darwin") {
    return null;
  }

  const monitorName = normalizeText(state.config.monitorName);
  if (!monitorName) {
    return {
      monitorName: "",
      currentInputValue: null,
      currentInputLabel: null,
      currentInputError: "先填写显示器名称，再使用输入值探测。",
      quickCandidateGroups: getMacProbeCandidateGroups(),
      lastProbe: state.macInputProbe,
    };
  }

  const currentInputResult = await getMacCurrentInputResult();

  return {
    monitorName,
    currentInputValue: currentInputResult.ok ? currentInputResult.value : null,
    currentInputLabel: currentInputResult.ok
      ? describeInputValue(currentInputResult.value)
      : null,
    currentInputError: currentInputResult.ok ? null : currentInputResult.error,
    quickCandidateGroups: getMacProbeCandidateGroups(),
    lastProbe: state.macInputProbe,
  };
}

async function getMacCurrentInputResult() {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      value: null,
      error: "当前平台不支持 macOS 输入值读取。",
    };
  }

  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");

  try {
    const output = await runCommand("/bin/sh", [scriptPath, "--query-input"], {
      env: {
        DISPLAY_NAME: state.config.monitorName,
        DISPLAY_INDEX: String(state.config.macDisplayIndex),
      },
    });
    const parsedValue = parseMacInputValueOutput(output);

    if (!Number.isInteger(parsedValue)) {
      throw new Error(`无法从探测输出里解析输入值：${output}`);
    }

    return {
      ok: true,
      value: parsedValue,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: error.message,
    };
  }
}

function sendMacInputValue(candidate) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  return runCommand("/bin/sh", [scriptPath, String(candidate)], {
    env: {
      DISPLAY_NAME: state.config.monitorName,
      DISPLAY_INDEX: String(state.config.macDisplayIndex),
    },
  });
}

function parseMacInputValueOutput(output) {
  const normalized = normalizeText(output);
  return /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : NaN;
}

function createMacInputProbeResult({
  targetId = "windows",
  candidate = null,
  status = "idle",
  message = "",
  beforeValue = null,
  afterValue = null,
  expectedValues = [],
  commandError = "",
} = {}) {
  return {
    targetId,
    candidate: Number.isInteger(candidate) ? candidate : null,
    status,
    message,
    beforeValue: Number.isInteger(beforeValue) ? beforeValue : null,
    afterValue: Number.isInteger(afterValue) ? afterValue : null,
    expectedValues: Array.isArray(expectedValues)
      ? expectedValues.filter((value) => Number.isInteger(value))
      : [],
    commandError: normalizeText(commandError),
    updatedAt: new Date().toISOString(),
  };
}

function buildConfigFromForm(form) {
  const config = {
    monitorName: normalizeText(form.get("monitorName")),
    macDisplayIndex: normalizePositiveInteger(form.get("macDisplayIndex"), 1),
    compatibilityMode: parseCompatibilityMode(form.get("compatibilityMode")),
    windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
      form.get("windowsDisplayHandoffMode")
    ),
    targets: {
      windows: {
        label: normalizeText(form.get("windowsLabel")),
        inputValue: parseInputValue(form.get("windowsInputValue")),
      },
      mac: {
        label: normalizeText(form.get("macLabel")),
        inputValue: parseInputValue(form.get("macInputValue")),
      },
    },
  };

  return {
    config,
    errors: getConfigValidationErrors(config),
  };
}

function getConfigValidationErrors(config) {
  const errors = [];

  if (!normalizeText(config.monitorName)) {
    errors.push("显示器名称不能为空。");
  }

  if (!Number.isInteger(config.macDisplayIndex) || config.macDisplayIndex < 1) {
    errors.push("macOS 显示器序号必须是大于等于 1 的整数。");
  }

  if (!["auto", "off", "samsung_mstar"].includes(config.compatibilityMode)) {
    errors.push("兼容模式配置无效。");
  }

  if (!["auto", "off", "external"].includes(config.windowsDisplayHandoffMode)) {
    errors.push("Windows 桌面联动配置无效。");
  }

  for (const targetId of TARGET_IDS) {
    const target = config.targets?.[targetId];

    if (!normalizeText(target?.label)) {
      errors.push(`${getTargetSlotName(targetId)} 的名称不能为空。`);
    }

    if (!Number.isInteger(target?.inputValue) || target.inputValue < 1 || target.inputValue > 255) {
      errors.push(`${getTargetSlotName(targetId)} 的输入值必须是 1 到 255 的整数。`);
    }
  }

  return Array.from(new Set(errors));
}

function getTargetSlotName(targetId) {
  return targetId === "windows" ? "模式 A" : "模式 B";
}

function parseTargetId(value) {
  return TARGET_IDS.includes(value) ? value : null;
}

function parseManualHandoffAction(value) {
  return ["transfer", "receive"].includes(value) ? value : null;
}

function getOppositeTargetId(targetId) {
  if (targetId === "windows") {
    return "mac";
  }

  if (targetId === "mac") {
    return "windows";
  }

  return null;
}

async function getAvailableMonitorNames() {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
    const output = await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ListOnly",
    ]);
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.filter(Boolean);
    }

    if (typeof parsed === "string" && parsed.trim()) {
      return [parsed.trim()];
    }

    return [];
  } catch {
    return [];
  }
}

async function assertWindowsSharedMonitorAvailableForSwitch() {
  if (process.platform !== "win32") {
    return;
  }

  const names = await getAvailableMonitorNames();
  const availability = await updateWindowsMonitorAvailability(names);

  if (availability.status === "visible") {
    return;
  }

  if (availability.status === "away") {
    throw new Error(availability.message || `${state.config.monitorName} 当前画面看起来已交给另一台电脑。`);
  }

  const availableText = names.length > 0 ? names.join("、") : "<none>";
  throw new Error(`No monitor matched '${state.config.monitorName}'. Available monitors: ${availableText}`);
}

async function getMonitorDiagnostics() {
  if (process.platform !== "win32") {
    return null;
  }

  const monitorName = normalizeText(state.config.monitorName);
  if (!monitorName) {
    return null;
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const diagnostics = {
    monitorName,
    supportedInputs: [],
    currentInputValue: null,
    currentInputLabel: null,
    currentInputReliable: false,
    capabilitiesError: null,
    currentInputError: null,
    configWarnings: [],
  };

  const [capabilitiesResult, currentInputResult] = await Promise.allSettled([
    runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-MonitorName",
      monitorName,
      "-ReadCapabilities",
    ]),
    getWindowsCurrentInputResult(monitorName),
  ]);

  if (capabilitiesResult.status === "fulfilled") {
    try {
      const parsed = JSON.parse(capabilitiesResult.value);
      diagnostics.supportedInputs = parseSupportedInputsFromCapabilities(parsed.capabilities);
    } catch (error) {
      diagnostics.capabilitiesError = error.message;
    }
  } else {
    diagnostics.capabilitiesError = capabilitiesResult.reason?.message || "读取失败";
  }

  if (currentInputResult.status === "fulfilled") {
    diagnostics.currentInputValue = currentInputResult.value.ok ? currentInputResult.value.value : null;
    diagnostics.currentInputError = currentInputResult.value.ok ? null : currentInputResult.value.error;
  } else {
    diagnostics.currentInputError = currentInputResult.reason?.message || "读取失败";
  }

  if (Number.isInteger(diagnostics.currentInputValue)) {
    const matchedInput = diagnostics.supportedInputs.find(
      (item) => item.value === diagnostics.currentInputValue
    );
    diagnostics.currentInputReliable = Boolean(matchedInput);
    diagnostics.currentInputLabel = matchedInput ? matchedInput.label : null;
  }

  if (diagnostics.supportedInputs.length > 0) {
    const supportedValues = new Set(diagnostics.supportedInputs.map((item) => item.value));
    diagnostics.configWarnings = TARGET_IDS
      .filter((targetId) => !supportedValues.has(getTarget(targetId).inputValue))
      .map((targetId) => {
        const target = getTarget(targetId);
        return `${target.label} 的输入值 ${target.inputValue} 不在当前显示器支持列表里。`;
      });
  }

  if (state.config.windowsDisplayHandoffMode !== "off") {
    const handoffDisabledReason = getWindowsDisplayHandoffDisabledReason();
    if (handoffDisabledReason) {
      diagnostics.configWarnings.push(handoffDisabledReason);
    }
  }

  return diagnostics;
}

function parseSupportedInputsFromCapabilities(capabilities) {
  const match = /60\(([^)]*)\)/i.exec(String(capabilities || ""));
  if (!match) {
    return [];
  }

  return match[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((hexValue) => Number.parseInt(hexValue, 16))
    .filter((value) => Number.isInteger(value))
    .map((value) => ({
      value,
      label: describeInputValue(value),
    }));
}

function redirectToControlPage(response, requestUrl, query) {
  redirectToPath(response, requestUrl, getControlPath(), query);
}

function redirectToSettingsPage(response, requestUrl, query) {
  redirectToPath(response, requestUrl, getSettingsPath(), query);
}

function redirectToPath(response, requestUrl, pathName, query) {
  const nextUrl = new URL(pathName, requestUrl);

  for (const [key, value] of Object.entries(query)) {
    if (value) {
      nextUrl.searchParams.set(key, value);
    }
  }

  response.writeHead(303, {
    "Location": `${nextUrl.pathname}${nextUrl.search}`,
    "Cache-Control": "no-store",
  });
  response.end();
}

function renderSettingsPage(requestUrl, monitorNames, diagnostics, macProbeDiagnostics) {
  const status = requestUrl.searchParams.get("status");
  const message = requestUrl.searchParams.get("message");
  const statusHtml = renderSettingsBanner(status, message);
  const monitorHintHtml = renderMonitorHints(monitorNames);
  const diagnosticsHtml = renderMonitorDiagnostics(diagnostics);
  const directSwitchHtml = renderDirectSwitchCard();
  const macProbeHtml = renderMacProbeAssistant(macProbeDiagnostics);

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(APP_NAME)} 设置页</title>
  <style>
    ${renderSharedStyles()}
    form {
      display: grid;
      gap: 16px;
    }
    label {
      display: grid;
      gap: 8px;
      font-weight: 700;
      color: var(--ink);
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 13px 14px;
      font-size: 16px;
      background: rgba(255, 255, 255, 0.96);
      color: var(--ink);
    }
    select {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 13px 14px;
      font-size: 16px;
      background: rgba(255, 255, 255, 0.96);
      color: var(--ink);
    }
    .two-col {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .tip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .pill {
      padding: 8px 10px;
      border-radius: 999px;
      background: rgba(13, 107, 98, 0.1);
      color: var(--accent-strong);
      font-size: 13px;
    }
    .help {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.6;
    }
    .section-title {
      margin: 4px 0 0;
      font-size: 20px;
    }
    .actions-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .probe-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .probe-buttons form {
      display: block;
    }
    .probe-buttons button {
      width: auto;
      min-height: 0;
      padding: 10px 12px;
      border-radius: 999px;
      font-size: 14px;
    }
    .probe-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .probe-actions form {
      display: block;
      flex: 1 1 220px;
    }
    .probe-meta {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .link-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 52px;
      padding: 0 18px;
      border-radius: 16px;
      text-decoration: none;
      color: var(--ink);
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.7);
      font-weight: 700;
    }
    @media (max-width: 640px) {
      .two-col {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Local Setup · v${escapeHtml(app.getVersion())}</div>
    <h1>${escapeHtml(APP_NAME)} 设置</h1>
    <p>这里现在按“当前这台主机直接发切源命令”的逻辑工作；不再把手动交接、归属判断或双端协同放在主流程里。</p>
    <div class="stack">
      ${statusHtml}
      ${diagnosticsHtml}
      ${directSwitchHtml}
      ${macProbeHtml}
      <div class="card">
        <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/config">
          <label>
            显示器名称
            <input name="monitorName" value="${escapeHtml(state.config.monitorName)}" placeholder="例如：G72、DELL U2723QE、LG ULTRAGEAR">
          </label>
          <div class="help">
            Windows 会按这个名字去匹配目标显示器。macOS 会优先按这个名字调用 BetterDisplay CLI；如果回退到 ddcctl，再参考下面的显示器序号。
          </div>
          ${monitorHintHtml}
          <label>
            macOS 显示器序号
            <input name="macDisplayIndex" type="number" min="1" step="1" value="${escapeHtml(String(state.config.macDisplayIndex))}">
          </label>
          <div class="help">
            这个值只影响 Mac 版本在“当前有画面时”的本机切换。应用会先试这里的序号，再自动补试常见序号；单屏通常填 1，多屏时可能需要改成 2、3 等。
          </div>
          <label>
            兼容模式
            <select name="compatibilityMode">
              ${renderNamedOption("auto", "自动判断", state.config.compatibilityMode)}
              ${renderNamedOption("off", "关闭兼容补发", state.config.compatibilityMode)}
              ${renderNamedOption("samsung_mstar", "Samsung / MStar", state.config.compatibilityMode)}
            </select>
          </label>
          <div class="help">
            对部分 Samsung / MStar 显示器，标准值不会直接生效。开启兼容后，应用会自动补发一组三星常见替代值。
          </div>
          <label>
            Windows 桌面联动
            <select name="windowsDisplayHandoffMode">
              ${renderNamedOption("auto", "自动处理（切走后退回主屏）", state.config.windowsDisplayHandoffMode)}
              ${renderNamedOption("off", "关闭联动", state.config.windowsDisplayHandoffMode)}
              ${renderNamedOption(
                "external",
                "强制启用（调试）",
                state.config.windowsDisplayHandoffMode
              )}
            </select>
          </label>
          <div class="help">
            只影响 Windows 版。切给另一台设备后，应用会尝试把 Windows 桌面退回主显示器；共享屏回到 Windows 后，再恢复扩展显示。要想切走后真正只剩保底屏，请先把保底屏设为 Windows 主显示器。
          </div>
          <div class="card soft">
            <div class="section-title">模式 A</div>
            <div class="two-col">
              <label>
                名称
                <input name="windowsLabel" value="${escapeHtml(state.config.targets.windows.label)}" placeholder="例如：工作电脑、游戏主机、Windows">
              </label>
              <label>
                输入值
                <input name="windowsInputValue" type="number" min="1" max="255" step="1" value="${escapeHtml(String(state.config.targets.windows.inputValue))}">
              </label>
            </div>
            <div class="help">常见值：DP1=15，DP2=16，HDMI1=17，HDMI2=18。</div>
          </div>
          <div class="card soft">
            <div class="section-title">模式 B</div>
            <div class="two-col">
              <label>
                名称
                <input name="macLabel" value="${escapeHtml(state.config.targets.mac.label)}" placeholder="例如：Mac mini、笔记本、Apple TV">
              </label>
              <label>
                输入值
                <input name="macInputValue" type="number" min="1" max="255" step="1" value="${escapeHtml(String(state.config.targets.mac.inputValue))}">
              </label>
            </div>
            <div class="help">如果你的显示器把 USB-C 当作 DP，通常会用 15 或 16，而不一定是独立值。</div>
          </div>
          <div class="card">
            <div class="help">常见输入值参考</div>
            <div class="tip-list">
              ${COMMON_INPUT_VALUES.map((item) => `<span class="pill">${escapeHtml(item.label)}</span>`).join("")}
            </div>
          </div>
          <button type="submit">保存设置</button>
        </form>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderMonitorHints(monitorNames) {
  if (monitorNames.length === 0) {
    return `<div class="help">当前平台没有自动列出显示器名称时，直接手动填写即可。若切换失败，错误提示里也会告诉你当前可用名称。</div>`;
  }

  const configuredName = normalizeText(state.config.monitorName);
  const hasConfiguredMatch = doesMonitorListContainConfiguredMonitor(monitorNames, configuredName);
  const mismatchBanner =
    configuredName && !hasConfiguredMatch
      ? `<div class="banner error">当前配置填写的是 ${escapeHtml(
          configuredName
        )}，但系统检测到的显示器名称是：${monitorNames
          .map(escapeHtml)
          .join(
            "、"
          )}。如果共享屏现在已经切到另一台电脑，这是正常的；如果它此刻明明在 Windows 侧却仍不匹配，再把这里改成 Windows 实际识别到的名称。</div>`
      : "";

  return `<div>
    ${mismatchBanner}
    <div class="help">当前检测到的显示器名称</div>
    <div class="tip-list">
      ${monitorNames.map((name) => `<span class="pill">${escapeHtml(name)}</span>`).join("")}
    </div>
  </div>`;
}

function renderMonitorDiagnostics(diagnostics) {
  if (!diagnostics) {
    return "";
  }

  const supportedInputsHtml =
    diagnostics.supportedInputs.length > 0
      ? diagnostics.supportedInputs
          .map((item) => `<span class="pill">${escapeHtml(item.label)}</span>`)
          .join("")
      : `<span class="help">这次没有从显示器能力串里读到支持的输入值。</span>`;

  let currentValueLine = "当前没有读到可用的输入回报值。";
  if (Number.isInteger(diagnostics.currentInputValue)) {
    currentValueLine = diagnostics.currentInputReliable
      ? `当前回报值：${escapeHtml(diagnostics.currentInputLabel)}`
      : `当前回报值：${escapeHtml(String(diagnostics.currentInputValue))}（不在支持列表里）`;
  }

  let currentValueHelp = "有些显示器不会可靠回报“当前输入”，所以应用无法把菜单状态当成实时输入。";
  if (diagnostics.currentInputReliable) {
    currentValueHelp = "这次回报值和支持列表匹配，可以当作输入参考。";
  } else if (diagnostics.currentInputError) {
    currentValueHelp = `当前输入回报读取失败：${escapeHtml(diagnostics.currentInputError)}`;
  }

  const warningHtml =
    diagnostics.configWarnings.length > 0
      ? `<div class="banner error">${diagnostics.configWarnings.map(escapeHtml).join(" ")}</div>`
      : "";

  const capabilityHelp = diagnostics.capabilitiesError
    ? `支持列表读取失败：${escapeHtml(diagnostics.capabilitiesError)}`
    : "这些值是显示器自己通过 DDC/CI 能力串声明的输入目标。";
  const compatibilityHelp = shouldUseSamsungMstarCompat(state.config)
    ? "当前已启用 Samsung / MStar 兼容补发。像这台 G72 这种切走后仍会保持 Windows 连接的屏，兼容补发比“判断是否断开”更可靠。"
    : "如果这台屏手动菜单能切、软件却没反应，建议把兼容模式改成 Samsung / MStar 再试。";
  const windowsHandoffHelp = getWindowsDisplayHandoffHelpText(state.config);

  return `<div class="card soft">
    <div class="section-title">显示器诊断</div>
    ${warningHtml}
    <div class="help">目标显示器：${escapeHtml(diagnostics.monitorName)}</div>
    <div class="help">${escapeHtml(capabilityHelp)}</div>
    <div class="tip-list">${supportedInputsHtml}</div>
    <div class="help" style="margin-top: 12px;">${currentValueLine}</div>
    <div class="help">${currentValueHelp}</div>
    <div class="help">${compatibilityHelp}</div>
    <div class="help">${windowsHandoffHelp}</div>
  </div>`;
}

function renderManualHandoffCard() {
  const model = getManualHandoffModelForCurrentPlatform();
  const sessionHelp = state.manualSession.active
    ? `当前有一笔手动交接在等待完成，剩余 ${getManualSessionRemainingSeconds()} 秒；超过 30 秒会自动回收本机这边已经做过的准备动作。`
    : "“接收”只负责把本机该做的准备动作先做掉；“移交”会在当前这台主机直接执行切屏。";
  const formHtml = model.actions
    .map((action) => {
      const disabled = action.disabledReason ? " disabled" : "";
      const reasonHtml = action.disabledReason
        ? `<div class="help" style="margin-top: 8px;">${escapeHtml(action.disabledReason)}</div>`
        : "";

      return `<form method="post" action="/api/${encodeURIComponent(state.controlToken)}/manual/${encodeURIComponent(
        action.targetId
      )}" style="margin-top: 14px;">
        <input type="hidden" name="action" value="${escapeHtml(action.action)}" />
        <button type="submit"${disabled}>${escapeHtml(action.buttonLabel)}</button>
        ${reasonHtml}
      </form>`;
    })
    .join("");
  const refreshHtml =
    process.platform === "win32"
      ? `<form method="post" action="/api/${encodeURIComponent(
          state.controlToken
        )}/windows/refresh" style="margin-top: 14px;">
        <button type="submit" class="secondary">主动刷新 Windows 屏幕状态</button>
      </form>`
      : "";

  return `<div class="card soft">
    <div class="section-title">手动切源辅助</div>
    <div class="help" style="margin-top: 12px;">${escapeHtml(model.introText || model.disabledReason)}</div>
    <div class="help">${escapeHtml(model.recommendation || sessionHelp)}</div>
    ${formHtml}
    ${refreshHtml}
  </div>`;
}

function renderDirectSwitchCard() {
  const switchFormsHtml = TARGET_IDS.map(
    (targetId) => `<form method="post" action="/api/${encodeURIComponent(
      state.controlToken
    )}/switch/${encodeURIComponent(targetId)}" style="margin-top: 14px;">
      <button type="submit">直接切到 ${escapeHtml(getTarget(targetId).label)}</button>
    </form>`
  ).join("");
  const refreshHtml =
    process.platform === "win32"
      ? `<form method="post" action="/api/${encodeURIComponent(
          state.controlToken
        )}/windows/refresh" style="margin-top: 14px;">
        <button type="submit" class="secondary">主动刷新 Windows 屏幕状态</button>
      </form>`
      : "";

  return `<div class="card soft">
    <div class="section-title">直接切换</div>
    <div class="help" style="margin-top: 12px;">当前这台主机会直接对 ${escapeHtml(
      state.config.monitorName || "目标显示器"
    )} 发送切源命令。</div>
    <div class="help">Windows 版会在切走后尝试把共享屏从本机桌面里移除；切回时再尝试加回扩展显示。</div>
    ${switchFormsHtml}
    ${refreshHtml}
  </div>`;
}

function renderMacProbeAssistant(macProbeDiagnostics) {
  if (!macProbeDiagnostics) {
    return "";
  }

  const currentInputLine = Number.isInteger(macProbeDiagnostics.currentInputValue)
    ? `当前 macOS 侧回报输入：${escapeHtml(macProbeDiagnostics.currentInputLabel)}`
    : "当前 macOS 侧暂时没有读到可用的输入回报值。";
  const currentInputHelp = macProbeDiagnostics.currentInputError
    ? `读取失败：${escapeHtml(macProbeDiagnostics.currentInputError)}`
    : "探测助手会真的向显示器发送输入切换命令。若画面切到另一台设备，请从另一台设备或显示器按键切回后，再回来查看结果。";
  const lastProbe = state.macInputProbe;
  const quickGroupsHtml = macProbeDiagnostics.quickCandidateGroups
    .map((group) => renderMacProbeQuickGroup(group))
    .join("");
  const candidateValue = Number.isInteger(lastProbe?.candidate)
    ? lastProbe.candidate
    : state.config.targets.windows.inputValue;
  const resultHtml = renderMacProbeResult(lastProbe);
  const canApplyProbe = Boolean(
    lastProbe &&
      Number.isInteger(lastProbe.candidate) &&
      ["matched", "inconclusive"].includes(lastProbe.status) &&
      parseTargetId(lastProbe.targetId)
  );

  return `<div class="card soft">
    <div class="section-title">输入值探测助手</div>
    <div class="help">目标显示器：${escapeHtml(macProbeDiagnostics.monitorName || "未设置")}</div>
    <div class="probe-meta">
      <div class="help">${currentInputLine}</div>
      <div class="help">${currentInputHelp}</div>
    </div>
    <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/probe/mac" style="margin-top: 14px;">
      <div class="two-col">
        <label>
          把结果用于
          <select name="targetId">
            ${TARGET_IDS.map((targetId) =>
              renderNamedOption(targetId, getTargetSlotName(targetId), lastProbe?.targetId || "windows")
            ).join("")}
          </select>
        </label>
        <label>
          测试输入值
          <input name="candidate" type="number" min="1" max="255" step="1" value="${escapeHtml(
            String(candidateValue)
          )}">
        </label>
      </div>
      <button type="submit" class="secondary">测试这个输入值</button>
    </form>
    <div class="help" style="margin-top: 12px;">快捷测试</div>
    ${quickGroupsHtml}
    ${resultHtml}
    ${
      canApplyProbe
        ? `<div class="probe-actions">
            <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/probe/mac/apply">
              <input type="hidden" name="targetId" value="${escapeHtml(lastProbe.targetId)}">
              <input type="hidden" name="candidate" value="${escapeHtml(String(lastProbe.candidate))}">
              <button type="submit">把 ${escapeHtml(
                String(lastProbe.candidate)
              )} 保存到 ${escapeHtml(getTargetSlotName(lastProbe.targetId))}</button>
            </form>
          </div>`
        : ""
    }
  </div>`;
}

function renderMacProbeQuickGroup(group) {
  if (!group.values.length) {
    return "";
  }

  return `<div>
    <div class="help" style="margin-top: 12px;">${escapeHtml(group.title)}</div>
    <div class="probe-buttons">
      ${group.values
        .map(
          (value) => `<form method="post" action="/api/${encodeURIComponent(state.controlToken)}/probe/mac">
            <input type="hidden" name="targetId" value="${escapeHtml(group.targetId)}">
            <input type="hidden" name="candidate" value="${escapeHtml(String(value))}">
            <button type="submit" class="secondary">${escapeHtml(describeInputValue(value))}</button>
          </form>`
        )
        .join("")}
    </div>
  </div>`;
}

function renderMacProbeResult(result) {
  if (!result || result.status === "idle") {
    return "";
  }

  const statusClass = ["matched", "saved"].includes(result.status) ? "success" : "error";
  const lines = [escapeHtml(result.message)];

  if (Number.isInteger(result.beforeValue)) {
    lines.push(`测试前：${escapeHtml(describeInputValue(result.beforeValue))}`);
  }

  if (Number.isInteger(result.afterValue)) {
    lines.push(`测试后：${escapeHtml(describeInputValue(result.afterValue))}`);
  }

  if (result.expectedValues.length > 0) {
    lines.push(`候选集合：${escapeHtml(result.expectedValues.join(" / "))}`);
  }

  if (result.commandError) {
    lines.push(`底层返回：${escapeHtml(result.commandError)}`);
  }

  return `<div class="banner ${statusClass}" style="margin-top: 14px;">${lines.join("<br>")}</div>`;
}

function renderSettingsBanner(status, message) {
  if (status === "success") {
    return `<div class="banner success">${escapeHtml(message || "设置已保存。新的切换规则会立刻生效。")}</div>`;
  }

  if (status === "error" && message) {
    return `<div class="banner error">${escapeHtml(message)}</div>`;
  }

  return "";
}

function renderSharedStyles() {
  return `
    :root {
      color-scheme: light;
      --bg: #f4efe4;
      --panel: rgba(255, 252, 246, 0.94);
      --ink: #1f2a2c;
      --muted: #596466;
      --accent: #0d6b62;
      --accent-strong: #08463f;
      --accent-warm: #d46d2f;
      --accent-warm-strong: #9b4519;
      --danger: #962f1d;
      --danger-bg: #fbe8e2;
      --success: #145e47;
      --success-bg: #e7f5ed;
      --border: rgba(31, 42, 44, 0.14);
      font-family: "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top left, rgba(13, 107, 98, 0.18), transparent 32%),
        radial-gradient(circle at bottom right, rgba(212, 109, 47, 0.16), transparent 28%),
        var(--bg);
      color: var(--ink);
    }
    main {
      width: min(94vw, 680px);
      padding: 30px;
      border: 1px solid var(--border);
      border-radius: 28px;
      background: var(--panel);
      box-shadow: 0 18px 60px rgba(31, 42, 44, 0.12);
      backdrop-filter: blur(10px);
    }
    .eyebrow {
      margin-bottom: 10px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 30px;
      line-height: 1.15;
    }
    p {
      margin: 0;
      line-height: 1.6;
      color: var(--muted);
    }
    strong {
      display: block;
      margin-bottom: 6px;
      font-size: 13px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .stack {
      display: grid;
      gap: 14px;
      margin-top: 24px;
    }
    .grid {
      display: grid;
      gap: 12px;
    }
    .meta-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .card {
      padding: 16px 18px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--border);
    }
    .card.soft {
      background: rgba(255, 255, 255, 0.56);
    }
    .banner {
      padding: 12px 14px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.5;
    }
    .banner.success {
      background: var(--success-bg);
      color: var(--success);
    }
    .banner.error {
      background: var(--danger-bg);
      color: var(--danger);
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 16px;
      padding: 16px 18px;
      font-size: 18px;
      font-weight: 700;
      cursor: pointer;
      color: white;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
    }
    button.secondary {
      background: linear-gradient(135deg, var(--accent-warm), var(--accent-warm-strong));
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    code {
      display: inline-block;
      margin-top: 8px;
      word-break: break-all;
      font-size: 13px;
      color: var(--ink);
    }
    a {
      color: var(--accent-strong);
      font-weight: 700;
      text-decoration: none;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
    }
    @media (max-width: 640px) {
      main {
        padding: 22px;
      }
      .meta-grid {
        grid-template-columns: 1fr;
      }
    }
  `;
}

function summarizeMenuMessage(message, maxLength = 72) {
  const normalized = normalizeText(message).replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function isRecoverablePortError(error) {
  return error && ["EACCES", "EADDRINUSE"].includes(error.code);
}

function getListeningPort() {
  if (!controlServer) {
    return PREFERRED_CONTROL_PORT;
  }

  const address = controlServer.address();
  return address && typeof address === "object" && address.port
    ? address.port
    : PREFERRED_CONTROL_PORT;
}

function getTarget(targetId) {
  return state.config.targets[targetId];
}

function getLocalPlatformTargetId() {
  if (process.platform === "win32") {
    return "windows";
  }

  if (process.platform === "darwin") {
    return "mac";
  }

  return null;
}

function getManualHandoffModelForCurrentPlatform() {
  const localTargetId = getLocalPlatformTargetId();
  if (!localTargetId) {
    return {
      introText: "",
      recommendation: "",
      actions: [],
      disabledReason: "当前平台没有实现手动切源辅助。",
    };
  }

  const oppositeTargetId = getOppositeTargetId(localTargetId);
  const activeReason = state.manualSession.active
    ? `当前有一笔手动交接正在等待完成（剩余 ${getManualSessionRemainingSeconds()} 秒）。`
    : "";
  const transferButtonLabel = getManualHandoffButtonLabel("transfer", oppositeTargetId);
  const receiveButtonLabel = getManualHandoffButtonLabel("receive", oppositeTargetId);

  if (state.manualSession.active) {
    return {
      introText: "当前已有一笔手动交接在等待完成或超时回收。",
      recommendation: activeReason,
      actions: [
        {
          action: "transfer",
          targetId: oppositeTargetId,
          buttonLabel: transferButtonLabel,
          disabledReason: activeReason,
        },
        {
          action: "receive",
          targetId: localTargetId,
          buttonLabel: receiveButtonLabel,
          disabledReason: activeReason,
        },
      ],
      disabledReason: activeReason,
    };
  }

  const transferAction = {
    action: "transfer",
    targetId: oppositeTargetId,
    buttonLabel: transferButtonLabel,
    disabledReason: "",
  };
  const receiveAction = {
    action: "receive",
    targetId: localTargetId,
    buttonLabel: receiveButtonLabel,
    disabledReason: "",
  };

  return {
    introText: `这套交接现在按“两边分别点击”的流程走：接收侧先点“接收”做本机准备，持有画面的那一侧再点“移交”直接执行切屏。`,
    recommendation: `Windows 侧负责本机屏幕增减/恢复；Mac 侧在点“移交”时会直接执行把共享屏交回 Windows 的切源动作。`,
    actions: [transferAction, receiveAction],
    disabledReason: "",
  };
}

function getManualHandoffButtonLabel(action, oppositeTargetId) {
  const oppositeLabel = getTarget(oppositeTargetId).label;

  if (process.platform === "win32") {
    return action === "transfer"
      ? canWindowsManualTransferDetachSharedMonitor()
        ? `立即移交给 ${oppositeLabel}（切源并退回主屏）`
        : `立即移交给 ${oppositeLabel}（执行切源）`
      : `准备接收来自 ${oppositeLabel}（恢复共享屏）`;
  }

  if (process.platform === "darwin") {
    return action === "transfer"
      ? `立即移交给 ${oppositeLabel}（执行切源）`
      : `准备接收来自 ${oppositeLabel}`;
  }

  return action === "transfer"
    ? `准备移交给 ${oppositeLabel}`
    : `准备接收来自 ${oppositeLabel}`;
}

function getManualSessionRemainingSeconds() {
  const expiresAt = Date.parse(state.manualSession.expiresAt || "");
  if (!Number.isFinite(expiresAt)) {
    return 0;
  }

  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function getControlPath() {
  return `/control/${state.controlToken}`;
}

function getSettingsPath() {
  return `/settings/${state.controlToken}`;
}

function isLoopbackRequest(request) {
  const remoteAddress = normalizeText(request.socket?.remoteAddress);
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress);
}

function writeHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function normalizePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function parseCompatibilityMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["auto", "off", "samsung_mstar"].includes(normalized) ? normalized : "auto";
}

function parseWindowsDisplayHandoffMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["auto", "off", "external"].includes(normalized) ? normalized : "auto";
}

function parseInputValue(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runCandidateSequence(candidates, runCandidate) {
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      await runCandidate(candidates[index]);
      return;
    } catch (error) {
      lastError = pickMoreInformativeError(lastError, error);

      if (index >= candidates.length - 1 || shouldAbortCandidateRetries(lastError)) {
        throw lastError;
      }
    }

    if (index < candidates.length - 1) {
      await delay(300);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

async function getWindowsCurrentInputResult(monitorName = state.config.monitorName) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      value: null,
      error: "当前平台不支持 Windows 输入值读取。",
    };
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");

  try {
    const output = await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-MonitorName",
      monitorName,
      "-ReadInputValue",
    ]);
    const parsed = JSON.parse(output);
    const parsedValue = Number.isInteger(parsed?.currentInputValue) ? parsed.currentInputValue : NaN;

    if (!Number.isInteger(parsedValue)) {
      throw new Error(`无法从 Windows 输入探测输出里解析输入值：${output}`);
    }

    return {
      ok: true,
      value: parsedValue,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: error.message,
    };
  }
}

async function verifyWindowsSwitchOutcome(targetId, target, expectedValues) {
  const startedAt = Date.now();
  let lastObservedValue = null;
  let lastErrorMessage = "";
  let missingSince = 0;

  while (Date.now() - startedAt < 3000) {
    const names = await getAvailableMonitorNames();
    updateWindowsMonitorAvailability(names);

    if (!doesMonitorListContainConfiguredMonitor(names, state.config.monitorName)) {
      if (targetId !== "windows") {
        if (!missingSince) {
          missingSince = Date.now();
        }

        if (Date.now() - missingSince >= 1000) {
          return;
        }

        await delay(250);
        continue;
      }

      lastErrorMessage = `No monitor matched '${state.config.monitorName}'. Available monitors: ${
        names.length > 0 ? names.join(", ") : "<none>"
      }`;
      await delay(250);
      continue;
    }

    missingSince = 0;
    const currentInputResult = await getWindowsCurrentInputResult();
    if (currentInputResult.ok) {
      if (expectedValues.includes(currentInputResult.value)) {
        return;
      }

      lastObservedValue = currentInputResult.value;
      lastErrorMessage = "";
    } else {
      lastErrorMessage = currentInputResult.error;
    }

    await delay(250);
  }

  if (Number.isInteger(lastObservedValue)) {
    throw new Error(
      `Windows 已发送输入切换命令，但当前输入仍是 ${lastObservedValue}，未匹配目标值集合：${expectedValues.join(
        " "
      )}`
    );
  }

  throw new Error(
    lastErrorMessage || `Windows 已发送输入切换命令，但还没有确认 ${target.label} 是否真正接管了共享屏。`
  );
}

function shouldAbortCandidateRetries(error) {
  const message = normalizeText(error?.message);

  if (!message) {
    return false;
  }

  return [
    /^No monitor matched /i,
    /^MonitorName was not provided\./i,
    /^No physical monitor handles were found /i,
    /^Windows 当前没有发现可控的外接显示器/u,
    /没有可用的 macOS DDC 辅助程序/u,
    /ddcctl 没有检测到可控制的外接显示器/u,
  ].some((pattern) => pattern.test(message));
}

function pickMoreInformativeError(previousError, nextError) {
  if (!previousError) {
    return nextError;
  }

  return getErrorSpecificityScore(nextError) >= getErrorSpecificityScore(previousError)
    ? nextError
    : previousError;
}

function getErrorSpecificityScore(error) {
  const message = normalizeText(error?.message);

  if (!message) {
    return 0;
  }

  if (/^(failed|error)\.?$/i.test(message)) {
    return 1;
  }

  if (/^(usage|用法)[:：]/i.test(message)) {
    return 5;
  }

  return Math.min(message.length, 200) + 20;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function describeInputValue(value) {
  const knownLabel = COMMON_INPUT_LABELS.get(value);
  return knownLabel ? `${knownLabel} (${value})` : `输入值 ${value}`;
}

function renderNamedOption(value, label, selectedValue) {
  return `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function getInputCandidates(target) {
  const candidates = [target.inputValue];

  if (!shouldUseSamsungMstarCompat(state.config)) {
    return candidates;
  }

  for (const candidate of getSamsungMstarCandidates(target.inputValue)) {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function getExpectedProbeInputValues(inputValue) {
  const candidates = [inputValue];

  for (const candidate of getSamsungMstarCandidates(inputValue)) {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function getTargetIdsForInputValue(inputValue) {
  if (!Number.isInteger(inputValue)) {
    return [];
  }

  return TARGET_IDS.filter((targetId) =>
    getExpectedProbeInputValues(getTarget(targetId).inputValue).includes(inputValue)
  );
}

function getOwnerTargetIdForInputValue(inputValue) {
  const matches = getTargetIdsForInputValue(inputValue);
  return matches.length === 1 ? matches[0] : "unknown";
}

function getMacProbeCandidateGroups() {
  return TARGET_IDS.map((targetId) => {
    const configuredCandidates = getExpectedProbeInputValues(getTarget(targetId).inputValue);
    const commonCandidates = MAC_PROBE_COMMON_INPUT_VALUES.filter(
      (value) => !configuredCandidates.includes(value)
    );

    return {
      targetId,
      title: `${getTargetSlotName(targetId)} 当前候选与常见补充`,
      values: [...configuredCandidates, ...commonCandidates],
    };
  });
}

function shouldUseSamsungMstarCompat(config) {
  if (config.compatibilityMode === "samsung_mstar") {
    return true;
  }

  if (config.compatibilityMode === "off") {
    return false;
  }

  return /\b(g7|g72|odyssey|samsung)\b/i.test(config.monitorName);
}

function shouldUseWindowsDisplayHandoff(config) {
  if (process.platform !== "win32") {
    return false;
  }

  if (config.windowsDisplayHandoffMode === "off") {
    return false;
  }

  return getWindowsDisplayLayoutInfo().displayCount >= 2;
}

function canWindowsManualTransferDetachSharedMonitor() {
  if (process.platform !== "win32") {
    return false;
  }

  return getWindowsDisplayLayoutInfo().displayCount >= 2;
}

function getWindowsDisplayLayoutInfo() {
  if (process.platform !== "win32") {
    return {
      displayCount: 0,
      internalDisplayCount: 0,
      externalDisplayCount: 0,
    };
  }

  try {
    const displays = screen.getAllDisplays();
    const internalDisplayCount = displays.filter((display) => display.internal).length;
    return {
      displayCount: displays.length,
      internalDisplayCount,
      externalDisplayCount: Math.max(0, displays.length - internalDisplayCount),
    };
  } catch {
    return {
      displayCount: 0,
      internalDisplayCount: 0,
      externalDisplayCount: 0,
    };
  }
}

function getWindowsDisplayHandoffDisabledReason() {
  if (process.platform !== "win32") {
    return "";
  }

  const layoutInfo = getWindowsDisplayLayoutInfo();
  if (layoutInfo.displayCount === 0) {
    return "当前没有读到可用的 Windows 显示器拓扑，先不自动联动。";
  }

  if (layoutInfo.displayCount < 2) {
    return "当前 Windows 只有一块显示器，不需要做桌面联动。";
  }

  return "";
}

function getWindowsDisplayHandoffHelpText(config) {
  if (process.platform !== "win32") {
    return "如果切到另一台设备后 Windows 主屏内容还留在原位，可以在 Windows 版里调整“桌面联动”设置。";
  }

  if (shouldUseWindowsDisplayHandoff(config)) {
    return "当前已启用 Windows 桌面联动。切到模式 B 后，应用会尝试把 Windows 桌面退回主显示器；等这台共享屏回到 Windows 后，再自动恢复扩展显示。要想切走后只保留保底屏，请先把保底屏设为 Windows 主显示器。";
  }

  if (config.windowsDisplayHandoffMode === "off") {
    return "当前已关闭 Windows 桌面联动。切到另一台设备后，Windows 桌面布局将保持原状。";
  }

  const disabledReason = getWindowsDisplayHandoffDisabledReason();
  if (disabledReason) {
    return disabledReason;
  }

  return "如果切到另一台设备后 Windows 主屏内容还留在原位，可以把“Windows 桌面联动”改成自动判断或强制开启。";
}

function getSamsungMstarCandidates(inputValue) {
  switch (inputValue) {
    case 17:
      return [6];
    case 18:
      return [5];
    case 15:
      return [3];
    case 16:
      return [9, 7];
    default:
      return [];
  }
}

function notify(body) {
  if (!Notification.isSupported()) {
    return;
  }

  new Notification({
    title: APP_NAME,
    body,
  }).show();
}

async function handOffWindowsDesktop() {
  try {
    await detachConfiguredWindowsSharedMonitor();
    return;
  } catch (error) {
    appendDiagnosticLog("Targeted Windows shared-monitor detach failed; falling back to generic collapse", error);
  }

  try {
    await runWindowsDisplaySwitch("/internal");
    await waitForDisplayCount(1, "Windows 没有切成仅保留主屏。");
    return;
  } catch (error) {
    appendDiagnosticLog("DisplaySwitch /internal did not collapse topology; trying topology helper", error);
  }

  await runWindowsTopologyCommand(["-PrimaryOnly"]);
  await waitForDisplayCount(1, "Windows 没有切成仅保留主屏。");
}

async function restoreWindowsDesktopToTargetMonitor() {
  const expectedCount = getExpectedWindowsRestoreDisplayCount();
  try {
    await attachConfiguredWindowsSharedMonitor(expectedCount);
    return;
  } catch (error) {
    appendDiagnosticLog("Targeted Windows shared-monitor attach failed; falling back to generic extend", error);
  }

  await extendWindowsDesktopToExpectedCount(expectedCount, "Windows 没有恢复到扩展显示。");
}

async function prepareWindowsDesktopForIncomingOwnership() {
  if (process.platform !== "win32") {
    return {
      prepared: false,
      detail: "当前平台不是 Windows，无需预热共享屏接管。",
    };
  }

  const expectedCount = getExpectedWindowsRestoreDisplayCount();

  try {
    await extendWindowsDesktopToExpectedCount(
      expectedCount,
      "Windows 预热共享屏输出后仍没有恢复到扩展显示。"
    );
  } catch (error) {
    appendDiagnosticLog("Failed to prime Windows shared display path", error);
    return {
      prepared: false,
      detail: error.message,
    };
  }

  markPendingWindowsDesktopRestore(expectedCount);

  try {
    const names = await getAvailableMonitorNames();
    const availability = await updateWindowsMonitorAvailability(names);
    return {
      prepared: true,
      detail:
        availability.status === "visible"
          ? `${state.config.monitorName} 已在 Windows 侧恢复为可见，等待显示器切回。`
          : `${state.config.monitorName} 的 Windows 输出链路已预热，等待显示器切回。`,
    };
  } catch (error) {
    appendDiagnosticLog("Failed to refresh Windows availability after priming shared display path", error);
    return {
      prepared: true,
      detail: "Windows 已尝试恢复共享屏输出链路，等待显示器切回。",
    };
  }
}

function runWindowsDisplaySwitch(mode) {
  const displaySwitchPath = path.join(
    process.env.WINDIR || "C:\\Windows",
    "System32",
    "DisplaySwitch.exe"
  );
  return runCommand(displaySwitchPath, [mode]);
}

async function runWindowsTopologyCommand(args) {
  const topologyScriptPath = getBundledResourcePath("windows", "display-topology.ps1");
  return runCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    topologyScriptPath,
    ...args,
  ]);
}

async function waitForDisplayCount(expectedCount, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8000) {
    try {
      const topologyDisplays = await getWindowsTopologyDisplays();
      const attachedDisplayCount = getAttachedWindowsTopologyDisplayCount(topologyDisplays);
      if (Number.isInteger(attachedDisplayCount)) {
        if (attachedDisplayCount === expectedCount) {
          return;
        }
      } else if (screen.getAllDisplays().length === expectedCount) {
        return;
      }
    } catch {
      // Ignore transient display enumeration failures while Windows is reconfiguring.
    }

    await delay(250);
  }

  throw new Error(errorMessage);
}

async function waitForConfiguredWindowsSharedMonitorDetached(previousAttachedDisplayCount = null, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8000) {
    try {
      const [names, attachedDisplayCount, topologyDisplays] = await Promise.all([
        getAvailableMonitorNames(),
        getCurrentWindowsAttachedDisplayCount(),
        getWindowsTopologyDisplays(),
      ]);
      const configuredMonitorVisible = doesMonitorListContainConfiguredMonitor(
        Array.isArray(names) ? names : [],
        state.config.monitorName
      );
      const configuredMonitorAttached = isConfiguredWindowsSharedMonitorAttached(topologyDisplays);

      if (!configuredMonitorVisible && !configuredMonitorAttached) {
        return;
      }

      if (
        Number.isInteger(previousAttachedDisplayCount) &&
        Number.isInteger(attachedDisplayCount) &&
        attachedDisplayCount < previousAttachedDisplayCount &&
        !configuredMonitorAttached
      ) {
        return;
      }
    } catch {
      // Ignore transient topology/readback failures while Windows is reconfiguring.
    }

    await delay(250);
  }

  throw new Error(errorMessage);
}

async function waitForConfiguredWindowsSharedMonitorAttached(expectedCount, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8000) {
    try {
      const [names, attachedDisplayCount] = await Promise.all([
        getAvailableMonitorNames(),
        getCurrentWindowsAttachedDisplayCount(),
      ]);
      const configuredMonitorVisible = doesMonitorListContainConfiguredMonitor(
        Array.isArray(names) ? names : [],
        state.config.monitorName
      );

      if (
        configuredMonitorVisible &&
        (!Number.isInteger(expectedCount) ||
          !Number.isInteger(attachedDisplayCount) ||
          attachedDisplayCount >= expectedCount)
      ) {
        return;
      }
    } catch {
      // Ignore transient topology/readback failures while Windows is reconfiguring.
    }

    await delay(250);
  }

  throw new Error(errorMessage);
}

async function detachConfiguredWindowsSharedMonitor() {
  const previousAttachedDisplayCount = await getCurrentWindowsAttachedDisplayCount();
  await runWindowsTopologyCommand([
    "-MonitorName",
    state.config.monitorName,
    "-DetachMonitor",
  ]);
  await waitForConfiguredWindowsSharedMonitorDetached(
    previousAttachedDisplayCount,
    "Windows 没有把共享屏从桌面拓扑里移除。"
  );
}

async function attachConfiguredWindowsSharedMonitor(expectedCount) {
  await runWindowsTopologyCommand([
    "-MonitorName",
    state.config.monitorName,
    "-AttachMonitor",
  ]);
  await waitForConfiguredWindowsSharedMonitorAttached(
    expectedCount,
    "Windows 没有把共享屏重新加回桌面拓扑。"
  );
}

async function extendWindowsDesktopToExpectedCount(expectedCount, errorMessage) {
  try {
    await runWindowsDisplaySwitch("/extend");
    await waitForDisplayCount(expectedCount, errorMessage);
    return;
  } catch (error) {
    appendDiagnosticLog("DisplaySwitch /extend did not restore Windows shared display path; trying topology helper", error);
  }

  await runWindowsTopologyCommand(["-ExtendAll"]);
  await waitForDisplayCount(expectedCount, errorMessage);
}

async function getWindowsTopologyDisplays() {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const output = await runWindowsTopologyCommand(["-Summary"]);
    const parsed = JSON.parse(output);
    const displays = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return displays
      .map((display) => normalizeWindowsTopologyDisplay(display))
      .filter(Boolean);
  } catch (error) {
    appendDiagnosticLog("Failed to read Windows display topology summary", error);
    return [];
  }
}

function normalizeWindowsTopologyDisplay(display) {
  if (!display || typeof display !== "object") {
    return null;
  }

  return {
    deviceName: normalizeText(display.DeviceName),
    deviceString: normalizeText(display.DeviceString),
    displayName: normalizeText(display.DisplayName),
    friendlyName: normalizeText(display.FriendlyName),
    productCode: normalizeText(display.ProductCode),
    attached: Boolean(display.Attached),
    primary: Boolean(display.Primary),
    width: Number.isFinite(display.Width) ? display.Width : 0,
    height: Number.isFinite(display.Height) ? display.Height : 0,
    positionX: Number.isFinite(display.PositionX) ? display.PositionX : 0,
    positionY: Number.isFinite(display.PositionY) ? display.PositionY : 0,
  };
}

function getAttachedWindowsTopologyDisplayCount(displays) {
  if (!Array.isArray(displays) || displays.length === 0) {
    return null;
  }

  return displays.filter((display) => display.attached).length;
}

function isConfiguredWindowsSharedMonitorAttached(displays) {
  if (!Array.isArray(displays) || displays.length === 0) {
    return false;
  }

  return displays.some(
    (display) =>
      display.attached &&
      doesMonitorListContainConfiguredMonitor(
        [
          display.displayName,
          display.friendlyName,
          display.productCode,
          display.deviceString,
          display.deviceName,
        ].filter(Boolean),
        state.config.monitorName
      )
  );
}

function startManualSessionWatcher() {
  void tickManualSession();
  manualSessionTimer = setInterval(() => {
    void tickManualSession();
  }, 1000);
}

async function tickManualSession() {
  if (!state.manualSession.active || manualSessionInFlight) {
    return;
  }

  manualSessionInFlight = true;

  try {
    const snapshot = await getTargetedLocalOwnershipSnapshot(state.manualSession.expectedOwnerTargetId);
    if (snapshot.owner === state.manualSession.expectedOwnerTargetId) {
      finishManualSession(
        "success",
        `软件当前判断 ${state.config.monitorName} 已完成手动${state.manualSession.kind === "transfer" ? "移交" : "接收"}。`,
        state.manualSession.expectedOwnerTargetId,
        { notifyUser: true }
      );
      return;
    }

    const expiresAt = Date.parse(state.manualSession.expiresAt || "");
    if (!Number.isFinite(expiresAt) || Date.now() < expiresAt) {
      return;
    }

    await handleManualSessionTimeout(snapshot);
  } finally {
    manualSessionInFlight = false;
  }
}

async function handleManualSessionTimeout(snapshot) {
  const session = state.manualSession;
  const expectedOwnerTargetId = parseTargetId(session.expectedOwnerTargetId);
  if (!session.active || !expectedOwnerTargetId) {
    finishManualSession("error", "手动交接已超时，当前会话已取消。", null, {
      notifyUser: true,
    });
    return;
  }

  let message = `手动${session.kind === "transfer" ? "移交" : "接收"}超时，已取消本次准备。`;

  if (process.platform === "win32" && session.localAction === "windows_transfer") {
    try {
      await restoreWindowsDesktopToTargetMonitor();
      clearPendingWindowsDesktopRestore();
      message = "手动移交超时，Windows 已恢复扩展显示。";
    } catch (error) {
      message = `手动移交超时，但 Windows 自动恢复失败：${normalizeText(error.message) || "未知错误"}`;
    }
  } else if (
    process.platform === "win32" &&
    session.localAction === "windows_receive" &&
    snapshot.owner !== expectedOwnerTargetId
  ) {
    try {
      await handOffWindowsDesktop();
      markPendingWindowsDesktopRestore(state.windowsDesktop.expectedAttachedDisplayCount);
      message = "手动接收超时，Windows 已回退到仅主屏，继续等待共享屏回来。";
    } catch (error) {
      message = `手动接收超时，但 Windows 回退失败：${normalizeText(error.message) || "未知错误"}`;
    }
  }

  finishManualSession("error", message, expectedOwnerTargetId, {
    notifyUser: true,
  });
}

function finishManualSession(status, message, targetId, { notifyUser = false } = {}) {
  state.manualSession = createDefaultManualSessionState();
  state.lastSwitchOutcome = createSwitchOutcome({
    status,
    targetId,
    mode: "manual_prep",
    message,
  });
  saveState(state);
  refreshMenu();

  if (notifyUser && message) {
    notify(message);
  }
}

async function getLocalOwnershipSnapshot() {
  if (process.platform === "win32") {
    return getWindowsOwnershipSnapshot();
  }

  if (process.platform === "darwin") {
    return getMacOwnershipSnapshot();
  }

  return createDefaultOwnershipSnapshot();
}

async function getTargetedLocalOwnershipSnapshot(targetId) {
  if (process.platform === "win32") {
    return getWindowsOwnershipSnapshot({ attemptedTargetId: targetId });
  }

  if (process.platform === "darwin") {
    return getMacOwnershipSnapshot({ attemptedTargetId: targetId });
  }

  return createDefaultOwnershipSnapshot();
}

async function getWindowsOwnershipSnapshot(options = {}) {
  const names = await getAvailableMonitorNames();
  const availability = await createWindowsMonitorAvailabilitySnapshot(names, options);
  return {
    owner: availability.owner || "unknown",
    source: "local",
    platform: process.platform,
    status: availability.status,
    message: availability.message,
    currentInputValue: availability.currentInputValue,
    updatedAt: new Date().toISOString(),
  };
}

async function getMacOwnershipSnapshot(options = {}) {
  const currentInputResult = await getMacCurrentInputResult();
  if (!currentInputResult.ok) {
    const inferredOwnerTargetId = inferMacOwnerFromLocalDisplayState(options.attemptedTargetId);
    if (inferredOwnerTargetId) {
      return {
        owner: inferredOwnerTargetId,
        source: "local",
        platform: process.platform,
        status: "missing",
        message: `Mac 当前已经看不到共享屏；本机根据当前显示拓扑推断共享屏已经交给 ${getTarget(
          inferredOwnerTargetId
        ).label}。`,
        currentInputValue: null,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      owner: "unknown",
      source: "local",
      platform: process.platform,
      status: "unknown",
      message: currentInputResult.error,
      currentInputValue: null,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    owner: getOwnerTargetIdForInputValue(currentInputResult.value),
    source: "local",
    platform: process.platform,
    status: "visible",
    message: "",
    currentInputValue: currentInputResult.value,
    updatedAt: new Date().toISOString(),
  };
}

async function confirmTargetOwnership(targetId, { timeoutMs = PEER_CONFIRMATION_TIMEOUT_MS } = {}) {
  if (!parseTargetId(targetId)) {
    return {
      confirmed: false,
      snapshot: null,
    };
  }

  const startedAt = Date.now();
  let lastSnapshot = null;

  while (Date.now() - startedAt < timeoutMs) {
    const localSnapshot = await getTargetedLocalOwnershipSnapshot(targetId);
    if (localSnapshot) {
      lastSnapshot = localSnapshot;
      if (localSnapshot.owner === targetId) {
        return {
          confirmed: true,
          snapshot: localSnapshot,
        };
      }
    }

    await delay(PEER_CONFIRMATION_POLL_MS);
  }

  return {
    confirmed: false,
    snapshot: lastSnapshot,
  };
}

function shouldAttemptWindowsDesktopHandoffRecovery(error) {
  const message = normalizeText(error?.message);

  if (!message) {
    return false;
  }

  if (shouldAbortCandidateRetries(error)) {
    return false;
  }

  return !/当前配置无效|当前平台不受支持/u.test(message);
}

async function attemptWindowsDesktopHandoffRecovery(targetId, expectedRestoreDisplayCount = null) {
  if (process.platform !== "win32" || targetId === "windows") {
    return false;
  }

  const ownershipConfirmation = await confirmTargetOwnership(targetId, {
    timeoutMs: 4000,
  });

  if (!ownershipConfirmation.confirmed) {
    return false;
  }

  try {
    await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
    await handOffWindowsDesktop();
    markPendingWindowsDesktopRestore(expectedRestoreDisplayCount);
  } catch (error) {
    appendDiagnosticLog("Windows desktop handoff recovery failed", error);
  }

  return true;
}

function runCommand(file, args, options = {}) {
  const execOptions = {
    windowsHide: true,
    ...options,
  };

  if (options.env) {
    execOptions.env = {
      ...process.env,
      ...options.env,
    };
  }

  return new Promise((resolve, reject) => {
    execFile(file, args, execOptions, (error, stdout, stderr) => {
      const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();

      if (error) {
        reject(new Error(combinedOutput || error.message));
        return;
      }

      if (combinedOutput && /\b(error|failed)\b/i.test(combinedOutput)) {
        reject(new Error(combinedOutput));
        return;
      }

      resolve(combinedOutput);
    });
  });
}

function getBundledResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources", ...segments);
  }

  return path.join(app.getAppPath(), "resources", ...segments);
}

function startWindowsRestoreWatcher() {
  if (process.platform !== "win32") {
    return;
  }

  const scheduleAttempt = () => {
    void attemptPendingWindowsDesktopRestore();
    void refreshWindowsMonitorAvailability();
  };

  screen.on("display-added", () => {
    scheduleTrayRebuild("display-added");
    scheduleAttempt();
  });
  screen.on("display-removed", () => {
    scheduleTrayRebuild("display-removed");
    scheduleAttempt();
  });

  windowsRestoreTimer = setInterval(scheduleAttempt, 2500);
  scheduleAttempt();
}

async function refreshWindowsMonitorAvailability() {
  if (process.platform !== "win32" || windowsMonitorAvailabilityInFlight) {
    return;
  }

  windowsMonitorAvailabilityInFlight = true;

  try {
    const names = await getAvailableMonitorNames();
    await updateWindowsMonitorAvailability(names);
  } finally {
    windowsMonitorAvailabilityInFlight = false;
  }
}

async function updateWindowsMonitorAvailability(names) {
  const monitorNames = Array.isArray(names) ? names.filter(Boolean) : [];
  const nextAvailability = await createWindowsMonitorAvailabilitySnapshot(monitorNames);

  if (
    windowsMonitorAvailability.status === nextAvailability.status &&
    windowsMonitorAvailability.message === nextAvailability.message &&
    windowsMonitorAvailability.owner === nextAvailability.owner &&
    windowsMonitorAvailability.currentInputValue === nextAvailability.currentInputValue &&
    windowsMonitorAvailability.names.join("\n") === nextAvailability.names.join("\n")
  ) {
    return windowsMonitorAvailability;
  }

  windowsMonitorAvailability = nextAvailability;
  refreshMenu();
  return windowsMonitorAvailability;
}

async function createWindowsMonitorAvailabilitySnapshot(monitorNames, options = {}) {
  if (process.platform !== "win32") {
    return {
      status: "unknown",
      names: [],
      message: "",
      owner: "unknown",
      currentInputValue: null,
    };
  }

  if (!normalizeText(state.config.monitorName)) {
    return {
      status: "unknown",
      names: monitorNames,
      message: "",
      owner: "unknown",
      currentInputValue: null,
    };
  }

  const topologyDisplays = await getWindowsTopologyDisplays();
  const attachedDisplayCount = getAttachedWindowsTopologyDisplayCount(topologyDisplays);

  if (shouldInferWindowsAwayFromTopology(attachedDisplayCount, options.attemptedTargetId)) {
    return {
      status: "away",
      names: monitorNames,
      message: `${state.config.monitorName} 已经不在 Windows 当前桌面拓扑里；本机根据当前只剩主屏的状态，推断共享屏已经交给 Mac。`,
      owner: "mac",
      currentInputValue: null,
    };
  }

  if (!doesMonitorListContainConfiguredMonitor(monitorNames, state.config.monitorName)) {
    const visibleText = monitorNames.length > 0 ? monitorNames.join("、") : "没有检测到任何显示器";
    const inferredOwnerTargetId = inferWindowsOwnerFromLocalDisplayState(
      monitorNames,
      attachedDisplayCount,
      options.attemptedTargetId
    );
    return {
      status: "missing",
      names: monitorNames,
      message:
        inferredOwnerTargetId === "mac"
          ? `${state.config.monitorName} 已经不在 Windows 当前桌面拓扑里；本机根据当前显示拓扑推断共享屏已经交给 Mac。现在看到的是 ${visibleText}。`
          : `${state.config.monitorName} 当前看起来不在 Windows 侧；现在看到的是 ${visibleText}。请到 Mac 端或显示器菜单切回。`,
      owner: inferredOwnerTargetId || "unknown",
      currentInputValue: null,
    };
  }

  const currentInputResult = await getWindowsCurrentInputResult();
  if (!currentInputResult.ok) {
    return {
      status: "visible",
      names: monitorNames,
      message: "",
      owner: "unknown",
      currentInputValue: null,
    };
  }

  const currentInputValue = currentInputResult.value;
  const ownerTargetId = getOwnerTargetIdForInputValue(currentInputValue);

  if (ownerTargetId === "windows") {
    return {
      status: "visible",
      names: monitorNames,
      message: "",
      owner: "windows",
      currentInputValue,
    };
  }

  if (ownerTargetId === "mac") {
    return {
      status: "away",
      names: monitorNames,
      message: `${state.config.monitorName} 仍然被 Windows 枚举到，但当前输入回报是 ${describeInputValue(
        currentInputValue
      )}，软件当前据此推断这块共享屏的画面已经交给 Mac 了。请在 Mac 端或显示器菜单里切回 Windows。`,
      owner: "mac",
      currentInputValue,
    };
  }

  return {
    status: "visible",
    names: monitorNames,
    message: "",
    owner: "unknown",
    currentInputValue,
  };
}

function startWindowsTrayWatcher() {
  if (process.platform !== "win32") {
    return;
  }

  void refreshExplorerSignature();
  trayHealthTimer = setInterval(() => {
    void verifyTrayHealth();
  }, TRAY_HEALTHCHECK_INTERVAL_MS);
}

async function verifyTrayHealth() {
  if (process.platform !== "win32") {
    return;
  }

  if (!tray || isTrayDestroyed()) {
    rebuildTray("tray-missing");
    return;
  }

  const nextExplorerSignature = await getExplorerSignature();
  if (!nextExplorerSignature) {
    return;
  }

  if (explorerSignature && nextExplorerSignature !== explorerSignature) {
    explorerSignature = nextExplorerSignature;
    scheduleTrayRebuild("explorer-restarted", 0);
    return;
  }

  explorerSignature = nextExplorerSignature;
}

async function refreshExplorerSignature() {
  explorerSignature = await getExplorerSignature();
}

async function getExplorerSignature() {
  try {
    const output = await runCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$p = Get-Process explorer -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { '{0}:{1}' -f $p.Id, $p.StartTime.ToFileTimeUtc() }",
    ]);
    return normalizeText(output) || null;
  } catch (error) {
    appendDiagnosticLog("Failed to read explorer signature", error);
    return null;
  }
}

function isTrayDestroyed() {
  return !tray || (typeof tray.isDestroyed === "function" && tray.isDestroyed());
}

async function attemptPendingWindowsDesktopRestore() {
  return attemptPendingWindowsDesktopRestoreInternal();
}

async function attemptPendingWindowsDesktopRestoreInternal({ notifyOnSuccess = true } = {}) {
  if (process.platform !== "win32" || windowsRestoreInFlight || !state.windowsDesktop.pendingRestore) {
    return false;
  }

  windowsRestoreInFlight = true;

  try {
    const names = await getAvailableMonitorNames();
    const availability = await updateWindowsMonitorAvailability(names);
    if (availability.status !== "visible" || availability.owner !== "windows") {
      return false;
    }

    await restoreWindowsDesktopToTargetMonitor();
    clearPendingWindowsDesktopRestore();
    if (notifyOnSuccess) {
      notify(`软件当前判断 ${state.config.monitorName} 已回到 Windows，并已把桌面恢复为扩展显示。`);
    }
    return true;
  } catch {
    // Keep waiting. The monitor may have reappeared but not finished handshaking yet.
    return false;
  } finally {
    windowsRestoreInFlight = false;
  }
}

function markPendingWindowsDesktopRestore(expectedAttachedDisplayCount = null) {
  const normalizedExpectedCount =
    Number.isInteger(expectedAttachedDisplayCount) && expectedAttachedDisplayCount > 1
      ? expectedAttachedDisplayCount
      : state.windowsDesktop.expectedAttachedDisplayCount;
  const nextExpectedCount =
    Number.isInteger(normalizedExpectedCount) && normalizedExpectedCount > 1
      ? normalizedExpectedCount
      : 0;
  const changed =
    !state.windowsDesktop.pendingRestore ||
    state.windowsDesktop.expectedAttachedDisplayCount !== nextExpectedCount;

  state.windowsDesktop.pendingRestore = true;
  state.windowsDesktop.expectedAttachedDisplayCount = nextExpectedCount;

  if (!changed) {
    return;
  }

  saveState(state);
  refreshMenu();
}

function clearPendingWindowsDesktopRestore() {
  if (!state.windowsDesktop.pendingRestore) {
    return;
  }

  state.windowsDesktop.pendingRestore = false;
  state.windowsDesktop.expectedAttachedDisplayCount = 0;
  saveState(state);
  refreshMenu();
}

async function getCurrentWindowsAttachedDisplayCount() {
  const topologyDisplays = await getWindowsTopologyDisplays();
  const attachedDisplayCount = getAttachedWindowsTopologyDisplayCount(topologyDisplays);
  if (Number.isInteger(attachedDisplayCount) && attachedDisplayCount > 0) {
    return attachedDisplayCount;
  }

  const electronDisplayCount = getWindowsDisplayCount();
  return electronDisplayCount > 0 ? electronDisplayCount : null;
}

async function refreshWindowsDisplayState({ notifyOnSuccess = false } = {}) {
  if (process.platform !== "win32") {
    return {
      changed: false,
      message: "当前平台不是 Windows，无需刷新 Windows 屏幕状态。",
    };
  }

  const names = await getAvailableMonitorNames();
  let availability = await updateWindowsMonitorAvailability(names);
  const attachedDisplayCount = await getCurrentWindowsAttachedDisplayCount();
  const recentTargetId = getRecentSuccessfulTargetId();
  const lastRequestedTargetId = parseTargetId(state.lastTarget);

  if (state.windowsDesktop.pendingRestore && availability.status === "visible" && availability.owner === "windows") {
    const restored = await attemptPendingWindowsDesktopRestoreInternal({
      notifyOnSuccess: false,
    });
    const message = restored
      ? "Windows 已主动刷新，并已把桌面恢复为扩展显示。"
      : "Windows 已主动刷新当前屏幕状态。";
    refreshMenu();
    if (notifyOnSuccess) {
      notify(message);
    }
    return {
      changed: restored,
      message,
      availability: windowsMonitorAvailability,
      attachedDisplayCount,
    };
  }

  const shouldCollapseSharedMonitor =
    state.config.windowsDisplayHandoffMode !== "off" &&
    Number.isInteger(attachedDisplayCount) &&
    attachedDisplayCount > 1 &&
    availability.owner !== "windows" &&
    (availability.owner === "mac" || recentTargetId === "mac");

  const shouldForceCollapseSharedMonitor =
    state.config.windowsDisplayHandoffMode !== "off" &&
    Number.isInteger(attachedDisplayCount) &&
    attachedDisplayCount > 1 &&
    lastRequestedTargetId === "mac";

  if (shouldCollapseSharedMonitor || shouldForceCollapseSharedMonitor) {
    if (shouldForceCollapseSharedMonitor && !shouldCollapseSharedMonitor) {
      appendDiagnosticLog(
        "Manual Windows refresh is forcing shared-monitor collapse based on last requested target",
        new Error(`lastTarget=${lastRequestedTargetId || "unknown"} attachedDisplayCount=${attachedDisplayCount}`)
      );
    }
    await handOffWindowsDesktop();
    markPendingWindowsDesktopRestore(attachedDisplayCount);
    availability = await updateWindowsMonitorAvailability(await getAvailableMonitorNames());
    const message = "Windows 已主动刷新，并已再次尝试把桌面缩为仅主屏。";
    if (notifyOnSuccess) {
      notify(message);
    }
    return {
      changed: true,
      message,
      availability,
      attachedDisplayCount: await getCurrentWindowsAttachedDisplayCount(),
    };
  }

  const message =
    Number.isInteger(attachedDisplayCount) && attachedDisplayCount <= 1
      ? "Windows 当前已经是仅主屏状态。"
      : "Windows 已主动刷新当前屏幕状态。";
  refreshMenu();
  if (notifyOnSuccess) {
    notify(message);
  }
  return {
    changed: false,
    message,
    availability,
    attachedDisplayCount,
  };
}

function getExpectedWindowsRestoreDisplayCount() {
  return Number.isInteger(state.windowsDesktop.expectedAttachedDisplayCount) &&
    state.windowsDesktop.expectedAttachedDisplayCount > 1
    ? state.windowsDesktop.expectedAttachedDisplayCount
    : 2;
}

function getWindowsDisplayCount() {
  try {
    return screen.getAllDisplays().length;
  } catch {
    return 0;
  }
}

function inferWindowsOwnerFromLocalDisplayState(
  monitorNames = [],
  attachedDisplayCount = null,
  attemptedTargetId = null
) {
  const recentTargetId = attemptedTargetId || getRecentSuccessfulTargetId();
  if (recentTargetId !== "mac") {
    return null;
  }

  const displayCount =
    Number.isInteger(attachedDisplayCount) && attachedDisplayCount >= 0
      ? attachedDisplayCount
      : getWindowsDisplayCount();
  const configuredMonitorVisible = doesMonitorListContainConfiguredMonitor(
    Array.isArray(monitorNames) ? monitorNames : [],
    state.config.monitorName
  );

  if (displayCount <= 1 || !configuredMonitorVisible) {
    return "mac";
  }

  return null;
}

function shouldInferWindowsAwayFromTopology(attachedDisplayCount = null, attemptedTargetId = null) {
  const displayCount =
    Number.isInteger(attachedDisplayCount) && attachedDisplayCount >= 0
      ? attachedDisplayCount
      : getWindowsDisplayCount();
  return (
    displayCount <= 1 &&
    inferWindowsOwnerFromLocalDisplayState([], displayCount, attemptedTargetId) === "mac"
  );
}

function inferMacOwnerFromLocalDisplayState(attemptedTargetId = null) {
  const recentTargetId = attemptedTargetId || getRecentSuccessfulTargetId();
  if (recentTargetId !== "windows") {
    return null;
  }

  try {
    if (screen.getAllDisplays().length === 0) {
      return "windows";
    }
  } catch {
    return "windows";
  }

  return null;
}

function getRecentSuccessfulTargetId(maxAgeMs = LOCAL_HANDOFF_INFERENCE_WINDOW_MS) {
  if (
    state.lastSwitchOutcome.status !== "success" ||
    state.lastSwitchOutcome.mode !== "switch" ||
    !state.lastSwitchOutcome.targetId
  ) {
    return null;
  }

  const updatedAt = Date.parse(state.lastSwitchOutcome.updatedAt || "");
  if (!Number.isFinite(updatedAt)) {
    return state.lastSwitchOutcome.targetId;
  }

  return Date.now() - updatedAt <= maxAgeMs
    ? state.lastSwitchOutcome.targetId
    : null;
}

function recordSwitchOutcome(status, targetId, message = "") {
  state.lastSwitchOutcome = createSwitchOutcome({
    status,
    targetId,
    message,
  });
}

function createDefaultState() {
  return {
    lastTarget: null,
    controlToken: crypto.randomBytes(12).toString("hex"),
    windowsDesktop: createDefaultWindowsDesktopState(),
    manualSession: createDefaultManualSessionState(),
    lastSwitchOutcome: createSwitchOutcome(),
    macInputProbe: createMacInputProbeResult(),
    config: createDefaultConfig(),
  };
}

function createDefaultWindowsDesktopState() {
  return {
    pendingRestore: false,
    expectedAttachedDisplayCount: 0,
  };
}

function createDefaultManualSessionState() {
  return {
    active: false,
    kind: "idle",
    expectedOwnerTargetId: null,
    sourceTargetId: null,
    localAction: "none",
    expiresAt: "",
    updatedAt: "",
  };
}

function createManualSessionState({
  kind = "idle",
  expectedOwnerTargetId = null,
  sourceTargetId = null,
  localAction = "none",
} = {}) {
  return {
    active: kind === "transfer" || kind === "receive",
    kind: ["transfer", "receive"].includes(kind) ? kind : "idle",
    expectedOwnerTargetId: parseTargetId(expectedOwnerTargetId),
    sourceTargetId: parseTargetId(sourceTargetId),
    localAction: ["none", "windows_transfer", "windows_receive"].includes(localAction)
      ? localAction
      : "none",
    expiresAt: new Date(Date.now() + MANUAL_HANDOFF_TIMEOUT_MS).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function resetManualSessionState() {
  if (!state.manualSession.active) {
    return;
  }

  state.manualSession = createDefaultManualSessionState();
}

function createDefaultConfig() {
  return {
    monitorName: "G72",
    macDisplayIndex: 1,
    compatibilityMode: "auto",
    windowsDisplayHandoffMode: "auto",
    targets: {
      windows: {
        label: "Windows（DP2）",
        inputValue: 16,
      },
      mac: {
        label: "Mac mini（HDMI1）",
        inputValue: 17,
      },
    },
  };
}

function createDefaultOwnershipSnapshot() {
  return {
    owner: "unknown",
    source: "local",
    platform: process.platform,
    status: "unknown",
    message: "",
    currentInputValue: null,
    updatedAt: null,
  };
}

function createSwitchOutcome({
  status = "idle",
  targetId = null,
  mode = "switch",
  message = "",
  updatedAt = null,
} = {}) {
  return {
    status: ["idle", "success", "error"].includes(status) ? status : "idle",
    targetId: parseTargetId(targetId),
    mode: ["switch", "manual_prep"].includes(normalizeText(mode)) ? normalizeText(mode) : "switch",
    message: normalizeText(message),
    updatedAt: normalizeText(updatedAt) || new Date().toISOString(),
  };
}

function loadState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(getStatePath(), "utf8")));
  } catch {
    return createDefaultState();
  }
}

function normalizeState(nextState) {
  const defaults = createDefaultState();
  const rawConfig = nextState.config || {};
  const rawTargets = rawConfig.targets || {};

  return {
    lastTarget: TARGET_IDS.includes(nextState.lastTarget) ? nextState.lastTarget : null,
    controlToken: normalizeText(nextState.controlToken) || defaults.controlToken,
    windowsDesktop: {
      pendingRestore: Boolean(nextState.windowsDesktop?.pendingRestore),
      expectedAttachedDisplayCount: normalizePositiveInteger(
        nextState.windowsDesktop?.expectedAttachedDisplayCount,
        0
      ),
    },
    manualSession: normalizeManualSessionState(nextState.manualSession, defaults.manualSession),
    lastSwitchOutcome: createSwitchOutcome(nextState.lastSwitchOutcome),
    macInputProbe: normalizeMacInputProbeState(nextState.macInputProbe, defaults.macInputProbe),
    config: {
      monitorName: normalizeText(rawConfig.monitorName) || defaults.config.monitorName,
      macDisplayIndex: normalizePositiveInteger(rawConfig.macDisplayIndex, defaults.config.macDisplayIndex),
      compatibilityMode: parseCompatibilityMode(rawConfig.compatibilityMode || defaults.config.compatibilityMode),
      windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
        rawConfig.windowsDisplayHandoffMode || defaults.config.windowsDisplayHandoffMode
      ),
      targets: {
        windows: {
          label: normalizeText(rawTargets.windows?.label) || defaults.config.targets.windows.label,
          inputValue: normalizePositiveInteger(rawTargets.windows?.inputValue, defaults.config.targets.windows.inputValue),
        },
        mac: {
          label: normalizeText(rawTargets.mac?.label) || defaults.config.targets.mac.label,
          inputValue: normalizePositiveInteger(rawTargets.mac?.inputValue, defaults.config.targets.mac.inputValue),
        },
      },
    },
  };
}

function normalizeManualSessionState(nextSession, fallbackSession) {
  const normalizedKind = normalizeText(nextSession?.kind);
  const normalizedLocalAction = normalizeText(nextSession?.localAction);

  return {
    active: Boolean(nextSession?.active),
    kind: ["idle", "transfer", "receive"].includes(normalizedKind)
      ? normalizedKind
      : fallbackSession.kind,
    expectedOwnerTargetId: parseTargetId(nextSession?.expectedOwnerTargetId),
    sourceTargetId: parseTargetId(nextSession?.sourceTargetId),
    localAction: ["none", "windows_transfer", "windows_receive"].includes(normalizedLocalAction)
      ? normalizedLocalAction
      : fallbackSession.localAction,
    expiresAt: normalizeText(nextSession?.expiresAt),
    updatedAt: normalizeText(nextSession?.updatedAt),
  };
}

function normalizeMacInputProbeState(nextProbe, fallbackProbe) {
  const targetId = parseTargetId(nextProbe?.targetId) || fallbackProbe.targetId;
  const status = normalizeText(nextProbe?.status) || fallbackProbe.status;

  return {
    targetId,
    candidate: normalizeProbeInteger(nextProbe?.candidate),
    status,
    message: normalizeText(nextProbe?.message),
    beforeValue: normalizeProbeInteger(nextProbe?.beforeValue),
    afterValue: normalizeProbeInteger(nextProbe?.afterValue),
    expectedValues: Array.isArray(nextProbe?.expectedValues)
      ? nextProbe.expectedValues.filter((value) => Number.isInteger(value))
      : [],
    commandError: normalizeText(nextProbe?.commandError),
    updatedAt: normalizeText(nextProbe?.updatedAt) || fallbackProbe.updatedAt,
  };
}

function normalizeProbeInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function saveState(nextState) {
  fs.mkdirSync(path.dirname(getStatePath()), { recursive: true });
  fs.writeFileSync(getStatePath(), JSON.stringify(nextState, null, 2));
}

function getStatePath() {
  return path.join(app.getPath("userData"), "state.json");
}

function getDiagnosticLogPath() {
  return path.join(app.getPath("userData"), "app.log");
}

function appendDiagnosticLog(message, error = null) {
  try {
    fs.mkdirSync(path.dirname(getDiagnosticLogPath()), { recursive: true });
    const lines = [`[${new Date().toISOString()}] ${message}`];
    const details = formatDiagnosticError(error);
    if (details) {
      lines.push(details);
    }
    fs.appendFileSync(getDiagnosticLogPath(), `${lines.join("\n")}\n`);
  } catch {
    // Swallow logging failures to avoid cascading background crashes.
  }
}

function formatDiagnosticError(error) {
  if (!error) {
    return "";
  }

  if (error instanceof Error) {
    return error.stack || error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function shellEscape(value) {
  return value.replace(/'/g, `'\"'\"'`);
}

function appleScriptEscape(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
