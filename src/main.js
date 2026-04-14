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
const TARGET_SLOTS = [
  { id: "dp1", title: "DP1", defaultInputValue: 15 },
  { id: "dp2", title: "DP2", defaultInputValue: 16 },
  { id: "hdmi1", title: "HDMI1", defaultInputValue: 17 },
  { id: "hdmi2", title: "HDMI2", defaultInputValue: 18 },
];
const TARGET_SLOT_MAP = new Map(TARGET_SLOTS.map((slot) => [slot.id, slot]));
const TARGET_IDS = TARGET_SLOTS.map((slot) => slot.id);
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

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  state = loadState();
  state.manualSession = createDefaultManualSessionState();
  await syncMonitorConfigsFromLocalDisplays({ persist: false });
  saveState(state);
  startControlServer();
  startWindowsRestoreWatcher();
  startWindowsTrayWatcher();
  createTray();
  void refreshMenu();
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
    label: `直接切到 ${getSwitchActionLabel(targetId)}`,
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
      label: `当前共享屏：${state.config.monitorName || "未设置"}`,
      enabled: false,
    },
    {
      label: `本机共享屏接口：${getTarget(getLocalInterfaceId()).label}`,
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
  const switchingToLocalInterface = isLocalInterfaceTarget(targetId);
  const attachedDisplayCountBeforeSwitch =
    !switchingToLocalInterface
      ? await getCurrentWindowsAttachedDisplayCount()
      : null;
  const handoffEnabledByConfig = state.config.windowsDisplayHandoffMode !== "off";
  const canDetachSharedMonitor =
    (Number.isInteger(attachedDisplayCountBeforeSwitch) &&
      attachedDisplayCountBeforeSwitch > 1) ||
    canWindowsManualTransferDetachSharedMonitor();
  const useDisplayHandoff = forceDisplayHandoff
    ? !switchingToLocalInterface && canDetachSharedMonitor
    : switchingToLocalInterface
      ? state.windowsDesktop.pendingRestore || shouldUseWindowsDisplayHandoff(state.config)
      : handoffEnabledByConfig &&
        (shouldUseWindowsDisplayHandoff(state.config) || canDetachSharedMonitor);
  await assertWindowsSharedMonitorAvailableForSwitch();
  let desktopHandedOff = false;

  if (useDisplayHandoff && switchingToLocalInterface) {
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
      !switchingToLocalInterface &&
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

  if (useDisplayHandoff && !switchingToLocalInterface && !desktopHandedOff) {
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
          env: getMacSwitchScriptEnv(),
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
    )} 的输入值还没配对，或者该接口当前没有稳定可切入的信号。请先确认目标接口背后的设备正在输出画面，再到设置页里的“输入值探测助手”为 ${target.label} 测试并保存正确值。当前候选集合：${expectedValues}。`;
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
      return `Windows 当前没有看到共享屏“${requestedName}”。如果它已经被切到不属于当前机器的其它接口，这是正常的；如果它本来就在当前机器这边，请确认显示器已连接、已亮屏，并且 DDC/CI 已开启。`;
    }

    return `Windows 当前没有看到配置的共享屏“${requestedName}”。现在能看到的是：${availableText}。如果共享屏已经被切到其它接口，这是预期行为；如果共享屏此刻明明仍在当前机器这边，再把设置页里的“显示器名称”改成 Windows 实际识别到的名称。`;
  }

  const noPhysicalHandleMatch = /^No physical monitor handles were found for '([^']+)'\.$/i.exec(rawMessage);
  if (noPhysicalHandleMatch) {
    return `Windows 找到了“${noPhysicalHandleMatch[1]}”，但没有拿到可控的物理显示器句柄。请确认它是支持 DDC/CI 的外接显示器，并在显示器菜单里开启 DDC/CI。`;
  }

  const setInputFailedMatch = /^Setting VCP 0x60 to value ([0-9]+) failed for '([^']+)'\.$/i.exec(rawMessage);
  if (setInputFailedMatch) {
    return `Windows 已找到“${setInputFailedMatch[2]}”，但显示器拒绝了输入值 ${setInputFailedMatch[1]}。请确认 DDC/CI 已开启，并检查对应接口的输入值是否填对。`;
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
    )}。这通常说明 ${target.label} 的输入值还没配对，或者目标接口当前没有稳定可切入的信号。请先确认该接口对应的设备正在输出画面，再检查设置页里的输入值配置。当前候选集合：${expectedValues}。`;
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
  const windowsRefreshPath = `/api/${state.controlToken}/windows/refresh`;
  const macProbePath = `/api/${state.controlToken}/probe/mac`;
  const macProbeApplyPath = `/api/${state.controlToken}/probe/mac/apply`;
  const switchPathMatch = new RegExp(`^/api/${state.controlToken}/switch/([^/]+)$`).exec(requestUrl.pathname);

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
    const [monitors, diagnostics, macProbeDiagnostics, localDisplays] = await Promise.all([
      getAvailableMonitorNames(),
      getMonitorDiagnostics(),
      getMacProbeDiagnostics(),
      getLocalDisplaySummaries(),
    ]);
    return writeHtml(
      response,
      200,
      renderSettingsPage(requestUrl, monitors, diagnostics, macProbeDiagnostics, localDisplays)
    );
  }

  if (requestUrl.pathname === configPath && request.method === "POST") {
    return handleConfigSave(request, response, requestUrl);
  }

  if (switchPathMatch && request.method === "POST") {
    const targetId = parseTargetId(decodeURIComponent(switchPathMatch[1]));
    if (!targetId) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("未找到对应接口。");
      return;
    }

    return handleSwitchRequest(response, requestUrl, targetId);
  }

  if (requestUrl.pathname === macProbePath && request.method === "POST") {
    return handleMacProbe(request, response, requestUrl);
  }

  if (requestUrl.pathname === macProbeApplyPath && request.method === "POST") {
    return handleMacProbeApply(request, response, requestUrl);
  }

  if (requestUrl.pathname.startsWith(`/api/${state.controlToken}/manual/`)) {
    response.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("手动交接接口已移除。当前版本只保留当前主机直接切换到指定接口。");
    return;
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
      targetId: getLocalInterfaceId(),
      candidate,
      status: "error",
      message: "请选择要写回的目标接口。",
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

  state.config.interfaces[targetId].inputValue = candidate;
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
      "命令已发送，但目前无法重新读回当前输入值。若画面已经切到目标接口，请切回后再决定是否保存这个值。",
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
      env: getMacSwitchScriptEnv(),
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
    env: getMacSwitchScriptEnv(),
  });
}

function parseMacInputValueOutput(output) {
  const normalized = normalizeText(output);
  return /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : NaN;
}

function createMacInputProbeResult({
  targetId = TARGET_IDS[0],
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
  const interfaces = {};

  for (const targetId of TARGET_IDS) {
    interfaces[targetId] = {
      inputValue: parseInputValue(form.get(`${targetId}InputValue`)),
    };
  }

  const config = {
    monitorName: normalizeText(form.get("monitorName")),
    localDisplayIndex: normalizePositiveInteger(form.get("localDisplayIndex"), 1),
    localInterfaceId: parseTargetId(form.get("localInterfaceId")) || TARGET_IDS[0],
    compatibilityMode: parseCompatibilityMode(form.get("compatibilityMode")),
    windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
      form.get("windowsDisplayHandoffMode")
    ),
    interfaces,
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

  if (!Number.isInteger(config.localDisplayIndex) || config.localDisplayIndex < 1) {
    errors.push("本机共享屏序号必须是大于等于 1 的整数。");
  }

  if (!parseTargetId(config.localInterfaceId)) {
    errors.push("请选择当前这台机器自己的共享屏接口。");
  }

  if (!["auto", "off", "samsung_mstar"].includes(config.compatibilityMode)) {
    errors.push("兼容模式配置无效。");
  }

  if (!["auto", "off", "external"].includes(config.windowsDisplayHandoffMode)) {
    errors.push("Windows 桌面联动配置无效。");
  }

  for (const targetId of TARGET_IDS) {
    const target = config.interfaces?.[targetId];

    if (!Number.isInteger(target?.inputValue) || target.inputValue < 1 || target.inputValue > 255) {
      errors.push(`${getTargetSlotName(targetId)} 的输入值必须是 1 到 255 的整数。`);
    }
  }

  return Array.from(new Set(errors));
}

function getTargetSlotName(targetId) {
  return TARGET_SLOT_MAP.get(targetId)?.title || "接口";
}

function parseTargetId(value) {
  return TARGET_IDS.includes(value) ? value : null;
}

function parseManualHandoffAction(value) {
  return ["transfer", "receive"].includes(value) ? value : null;
}

function getOppositeTargetId(targetId) {
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

async function getLocalDisplaySummaries() {
  const orderedDisplays = getOrderedLocalDisplays();
  const topologyDisplays = process.platform === "win32" ? await getWindowsTopologyDisplays() : [];
  let secondaryIndex = 2;
  const singleDisplayOnly = orderedDisplays.length <= 1;

  return orderedDisplays.map((display, index) => {
    const roleLabel = singleDisplayOnly
      ? "当前机器屏幕"
      : display.primary
        ? "主屏幕"
        : `附屏幕 ${secondaryIndex++}`;
    const topologyMatch =
      process.platform === "win32"
        ? matchWindowsTopologyDisplayToElectronDisplay(display, topologyDisplays)
        : null;
    const detectedName = normalizeText(
      topologyMatch?.friendlyName ||
        topologyMatch?.displayName ||
        topologyMatch?.deviceString ||
        display.label ||
        ""
    );

    return {
      index: index + 1,
      roleLabel,
      detectedName,
      resolution: `${display.bounds.width} × ${display.bounds.height}`,
      position: `${display.bounds.x}, ${display.bounds.y}`,
      internal: Boolean(display.internal),
      selected: index + 1 === state.config.localDisplayIndex,
    };
  });
}

function getOrderedLocalDisplays() {
  try {
    return [...screen.getAllDisplays()].sort((left, right) => {
      if (left.primary !== right.primary) {
        return left.primary ? -1 : 1;
      }

      if (left.bounds.y !== right.bounds.y) {
        return left.bounds.y - right.bounds.y;
      }

      return left.bounds.x - right.bounds.x;
    });
  } catch {
    return [];
  }
}

function getConfiguredLocalDisplay() {
  const orderedDisplays = getOrderedLocalDisplays();
  if (orderedDisplays.length === 0) {
    return null;
  }

  const configuredIndex = normalizePositiveInteger(state.config.localDisplayIndex, 1);
  return orderedDisplays[configuredIndex - 1] || orderedDisplays[0] || null;
}

function getMacSwitchScriptEnv() {
  const env = {
    DISPLAY_NAME: state.config.monitorName,
    DISPLAY_INDEX: String(state.config.localDisplayIndex),
  };
  const localDisplay = getConfiguredLocalDisplay();

  if (process.platform === "darwin" && localDisplay && Number.isInteger(localDisplay.id)) {
    env.DISPLAY_ID = String(localDisplay.id);
  }

  return env;
}

function matchWindowsTopologyDisplayToElectronDisplay(display, topologyDisplays) {
  if (!display || !Array.isArray(topologyDisplays) || topologyDisplays.length === 0) {
    return null;
  }

  return (
    topologyDisplays.find(
      (topologyDisplay) =>
        topologyDisplay.attached &&
        topologyDisplay.width === display.bounds.width &&
        topologyDisplay.height === display.bounds.height &&
        topologyDisplay.positionX === display.bounds.x &&
        topologyDisplay.positionY === display.bounds.y
    ) || null
  );
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

function renderSettingsPage(requestUrl, monitorNames, diagnostics, macProbeDiagnostics, localDisplays) {
  const status = requestUrl.searchParams.get("status");
  const message = requestUrl.searchParams.get("message");
  const statusHtml = renderSettingsBanner(status, message);
  const monitorHintHtml = renderMonitorHints(monitorNames);
  const diagnosticsHtml = renderMonitorDiagnostics(diagnostics);
  const localDisplaysHtml = renderLocalDisplaysCard(localDisplays);
  const interfaceOverviewHtml = renderInterfaceOverviewCard(diagnostics, macProbeDiagnostics);
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
    .display-list {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .display-item {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.62);
      border: 1px solid var(--border);
    }
    .display-item.active {
      border-color: rgba(13, 107, 98, 0.42);
      box-shadow: inset 0 0 0 1px rgba(13, 107, 98, 0.12);
    }
    .display-meta {
      margin-top: 6px;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.6;
    }
    .interface-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 14px;
    }
    .interface-card {
      padding: 14px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.62);
      border: 1px solid var(--border);
    }
    .interface-card.current {
      border-color: rgba(13, 107, 98, 0.42);
      box-shadow: inset 0 0 0 1px rgba(13, 107, 98, 0.12);
    }
    .status-pill.success {
      background: var(--success-bg);
      color: var(--success);
    }
    .status-pill.neutral {
      background: rgba(13, 107, 98, 0.08);
      color: var(--accent-strong);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      margin-top: 10px;
    }
    .radio-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      font-size: 14px;
      color: var(--ink);
    }
    .radio-row input {
      width: auto;
      margin: 0;
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
      .interface-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Local Setup · v${escapeHtml(app.getVersion())}</div>
    <h1>${escapeHtml(APP_NAME)} 设置</h1>
    <p>这里现在只按“当前这台主机直接切换共享屏接口”的逻辑工作。界面会先展示本机识别到的屏幕，再展示这块共享屏的 4 个接口。</p>
    <div class="stack">
      ${statusHtml}
      ${diagnosticsHtml}
      ${localDisplaysHtml}
      ${interfaceOverviewHtml}
      ${macProbeHtml}
      <div class="card">
        <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/config">
          <label>
            共享屏显示器名称
            <input name="monitorName" value="${escapeHtml(state.config.monitorName)}" placeholder="例如：G72、DELL U2723QE、LG ULTRAGEAR">
          </label>
          <div class="help">
            Windows 会按这个名字去匹配要控制的共享屏。macOS 会优先按这个名字调用 BetterDisplay CLI；如果回退到 ddcctl，再参考下面的本机共享屏序号。
          </div>
          ${monitorHintHtml}
          <label>
            当前这台机器里的共享屏序号
            ${
              localDisplays.length > 1
                ? `<select name="localDisplayIndex">
                    ${localDisplays
                      .map((display) =>
                        renderNamedOption(
                          String(display.index),
                          `${display.roleLabel}${display.detectedName ? ` · ${display.detectedName}` : ""}`,
                          String(state.config.localDisplayIndex)
                        )
                      )
                      .join("")}
                  </select>`
                : localDisplays.length === 1
                  ? `<input type="hidden" name="localDisplayIndex" value="${escapeHtml(
                      String(localDisplays[0].index)
                    )}">
                    <div class="display-item active">
                      <div><strong>${escapeHtml(localDisplays[0].roleLabel)}</strong></div>
                      <div class="display-meta">
                        ${localDisplays[0].detectedName ? `系统名称：${escapeHtml(localDisplays[0].detectedName)}<br>` : ""}
                        分辨率：${escapeHtml(localDisplays[0].resolution)}<br>
                        位置：${escapeHtml(localDisplays[0].position)}
                      </div>
                    </div>`
                : `<input name="localDisplayIndex" type="number" min="1" step="1" value="${escapeHtml(
                    String(state.config.localDisplayIndex)
                  )}">`
            }
          </label>
          <div class="help">
            识别到几块本机屏幕，这里就显示几项；如果当前机器只连了一块屏，这里就只展示这一块。macOS 会把这个序号传给切屏脚本；Windows 也会把它当成当前机器的共享屏参考序号。
          </div>
          <label>
            当前这台机器的共享屏接口
            <select name="localInterfaceId">
              ${TARGET_IDS.map((targetId) =>
                renderNamedOption(
                  targetId,
                  `${getTarget(targetId).label}${targetId === getLocalInterfaceId() ? "（当前）" : ""}`,
                  getLocalInterfaceId()
                )
              ).join("")}
            </select>
          </label>
          <div class="help">
            这里只告诉软件：这台机器自己的共享屏线，实际上接在共享屏的哪一个接口上。Windows 的缩屏/恢复逻辑会以这个接口为准。
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
            只影响 Windows 版。切到“不是当前机器接口”的其它接口后，应用会尝试把 Windows 桌面退回主显示器；切回“当前机器接口”后，再恢复扩展显示。要想切走后真正只剩保底屏，请先把保底屏设为 Windows 主显示器。
          </div>
          <div class="interface-grid">
            ${TARGET_IDS.map((targetId) => renderInterfaceConfigCard(targetId)).join("")}
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

function renderLocalDisplaysCard(localDisplays) {
  const emptyHtml =
    localDisplays.length === 0
      ? `<div class="help">当前没有从系统里读到本机屏幕列表；如果这是临时状态，重新打开设置页即可。</div>`
      : `<div class="display-list">
          ${localDisplays
            .map(
              (display) => `<div class="display-item${display.selected ? " active" : ""}">
                <div><strong>${escapeHtml(display.roleLabel)}</strong></div>
                <div class="display-meta">
                  ${display.detectedName ? `系统名称：${escapeHtml(display.detectedName)}<br>` : ""}
                  分辨率：${escapeHtml(display.resolution)}<br>
                  位置：${escapeHtml(display.position)}${display.internal ? "<br>类型：内建屏幕" : "<br>类型：外接屏幕"}
                  ${display.selected ? "<br>当前已选为这台机器的共享屏序号。" : ""}
                </div>
              </div>`
            )
            .join("")}
        </div>`;

  return `<div class="card soft">
    <div class="section-title">本机识别到的屏幕</div>
    <div class="help" style="margin-top: 12px;">识别到几块本机屏幕，这里就显示几块。主屏幕永远排在最前面，其余依次显示为附屏幕 2、附屏幕 3。</div>
    ${emptyHtml}
  </div>`;
}

function renderInterfaceOverviewCard(diagnostics, macProbeDiagnostics) {
  return `<div class="card soft">
    <div class="section-title">共享屏的 4 个接口</div>
    <div class="help" style="margin-top: 12px;">这里固定按 DP1、DP2、HDMI1、HDMI2 展示。软件能可靠读到的是“当前正在显示哪个接口”；其余未激活接口是否真的有机器连着，只能如实显示为未知。</div>
    <div class="interface-grid">
      ${TARGET_IDS.map((targetId) => renderInterfaceOverviewItem(targetId, diagnostics, macProbeDiagnostics)).join("")}
    </div>
  </div>`;
}

function renderInterfaceOverviewItem(targetId, diagnostics, macProbeDiagnostics) {
  const target = getTarget(targetId);
  const status = getInterfaceStatusModel(targetId, diagnostics, macProbeDiagnostics);
  const localBadge = isLocalInterfaceTarget(targetId)
    ? `<div class="status-pill neutral">当前机器接口</div>`
    : "";

  return `<div class="interface-card${status.current ? " current" : ""}">
    <div class="section-title">${escapeHtml(target.label)}</div>
    ${localBadge}
    <div class="status-pill ${escapeHtml(status.tone)}">${escapeHtml(status.text)}</div>
    <div class="display-meta">
      输入值：${escapeHtml(String(target.inputValue))}<br>
      ${escapeHtml(status.detail)}
    </div>
    <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/switch/${encodeURIComponent(
      targetId
    )}" style="margin-top: 14px;">
      <button type="submit">直接切到 ${escapeHtml(getSwitchActionLabel(targetId))}</button>
    </form>
  </div>`;
}

function renderInterfaceConfigCard(targetId) {
  const target = getTarget(targetId);

  return `<div class="interface-card${isLocalInterfaceTarget(targetId) ? " current" : ""}">
    <div class="section-title">${escapeHtml(target.label)}</div>
    <div class="help">默认标准值：${escapeHtml(String(TARGET_SLOT_MAP.get(targetId)?.defaultInputValue || target.inputValue))}</div>
    <label>
      输入值
      <input name="${escapeHtml(targetId)}InputValue" type="number" min="1" max="255" step="1" value="${escapeHtml(
        String(target.inputValue)
      )}">
    </label>
    <label class="radio-row">
      <input type="radio" name="localInterfaceId" value="${escapeHtml(targetId)}"${
        isLocalInterfaceTarget(targetId) ? " checked" : ""
      }>
      这一路就是当前机器自己的共享屏接口
    </label>
  </div>`;
}

function getInterfaceStatusModel(targetId, diagnostics, macProbeDiagnostics) {
  const target = getTarget(targetId);
  const currentInputValue = Number.isInteger(diagnostics?.currentInputValue)
    ? diagnostics.currentInputValue
    : Number.isInteger(macProbeDiagnostics?.currentInputValue)
      ? macProbeDiagnostics.currentInputValue
      : null;

  if (Number.isInteger(currentInputValue)) {
    const current = getExpectedProbeInputValues(target.inputValue).includes(currentInputValue);
    return {
      current,
      tone: current ? "success" : "neutral",
      text: current ? "当前正在显示" : "当前未显示",
      detail: current
        ? `当前输入回报是 ${describeInputValue(currentInputValue)}。`
        : `当前输入回报是 ${describeInputValue(currentInputValue)}；未激活接口的接入状态无法直接读取。`,
    };
  }

  const supportedByMonitor = Array.isArray(diagnostics?.supportedInputs)
    ? diagnostics.supportedInputs.some((item) => item.value === target.inputValue)
    : false;
  return {
    current: false,
    tone: "neutral",
    text: supportedByMonitor ? "显示器声明支持" : "连接状态未知",
    detail: supportedByMonitor
      ? "显示器能力串里声明支持这个接口值，但当前没有读到它是否正在显示。"
      : "当前没有可靠的输入回报，软件无法无损判断这个接口上是否真的有设备接入。",
  };
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
          )}。如果共享屏现在已经切到别的接口，这可能是正常的；如果它此刻明明仍在当前机器这边却仍不匹配，再把这里改成系统实际识别到的名称。</div>`
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
    ? "当前已启用 Samsung / MStar 兼容补发。对一部分三星或 MStar 方案显示器，这会比只发标准值更稳。"
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
    : "探测助手会真的向显示器发送输入切换命令。若画面切到目标接口，请通过当前设备的输入切换方式或显示器按键切回后，再回来查看结果。";
  const lastProbe = state.macInputProbe;
  const quickGroupsHtml = macProbeDiagnostics.quickCandidateGroups
    .map((group) => renderMacProbeQuickGroup(group))
    .join("");
  const candidateValue = Number.isInteger(lastProbe?.candidate)
    ? lastProbe.candidate
    : getTarget(getLocalInterfaceId()).inputValue;
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
              renderNamedOption(targetId, getTargetSlotName(targetId), lastProbe?.targetId || getLocalInterfaceId())
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
  const slot = TARGET_SLOT_MAP.get(targetId);
  const configuredTarget = state.config.interfaces?.[targetId] || {};
  return {
    id: targetId,
    label: slot?.title || targetId,
    inputValue: Number.isInteger(configuredTarget.inputValue)
      ? configuredTarget.inputValue
      : slot?.defaultInputValue,
  };
}

function getLocalPlatformTargetId() {
  return getLocalInterfaceId();
}

function getLocalInterfaceId() {
  return parseTargetId(state.config.localInterfaceId) || TARGET_IDS[0];
}

function isLocalInterfaceTarget(targetId) {
  return parseTargetId(targetId) === getLocalInterfaceId();
}

function getSwitchActionLabel(targetId) {
  const target = getTarget(targetId);
  return isLocalInterfaceTarget(targetId)
    ? `${target.label}（当前机器接口）`
    : target.label;
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
  const localInterfaceId = getLocalInterfaceId();

  while (Date.now() - startedAt < 3000) {
    const names = await getAvailableMonitorNames();
    updateWindowsMonitorAvailability(names);

    if (!doesMonitorListContainConfiguredMonitor(names, state.config.monitorName)) {
      if (targetId !== localInterfaceId) {
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
    return "如果切到其它接口后 Windows 主屏内容还留在原位，可以在 Windows 版里调整“桌面联动”设置。";
  }

  if (shouldUseWindowsDisplayHandoff(config)) {
    return "当前已启用 Windows 桌面联动。切到不是当前机器接口的其它接口后，应用会尝试把 Windows 桌面退回主显示器；切回当前机器接口后，再自动恢复扩展显示。要想切走后只保留保底屏，请先把保底屏设为 Windows 主显示器。";
  }

  if (config.windowsDisplayHandoffMode === "off") {
    return "当前已关闭 Windows 桌面联动。切到其它接口后，Windows 桌面布局将保持原状。";
  }

  const disabledReason = getWindowsDisplayHandoffDisabledReason();
  if (disabledReason) {
    return disabledReason;
  }

  return "如果切到其它接口后 Windows 主屏内容还留在原位，可以把“Windows 桌面联动”改成自动判断或强制开启。";
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
  if (process.platform !== "win32" || isLocalInterfaceTarget(targetId)) {
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
    void attemptWindowsDesktopAutoRestoreToLocalInterface();
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
  const inferredOwnerFromTopology = inferWindowsOwnerFromLocalDisplayState(
    monitorNames,
    attachedDisplayCount,
    options.attemptedTargetId
  );

  if (!doesMonitorListContainConfiguredMonitor(monitorNames, state.config.monitorName)) {
    const visibleText = monitorNames.length > 0 ? monitorNames.join("、") : "没有检测到任何显示器";
    return {
      status: "missing",
      names: monitorNames,
      message:
        inferredOwnerFromTopology && inferredOwnerFromTopology !== getLocalInterfaceId()
          ? `${state.config.monitorName} 已经不在 Windows 当前桌面拓扑里；软件当前根据本机只剩其它屏幕的状态，推断共享屏更可能已经切到 ${getTarget(
              inferredOwnerFromTopology
            ).label}。现在看到的是 ${visibleText}。`
          : `${state.config.monitorName} 当前没有出现在 Windows 本机可见列表里；现在看到的是 ${visibleText}。`,
      owner: inferredOwnerFromTopology || "unknown",
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

  if (ownerTargetId !== "unknown") {
    return {
      status: "visible",
      names: monitorNames,
      message: "",
      owner: ownerTargetId,
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
    if (availability.status !== "visible" || availability.owner !== getLocalInterfaceId()) {
      return false;
    }

    await restoreWindowsDesktopToTargetMonitor();
    clearPendingWindowsDesktopRestore();
    if (notifyOnSuccess) {
      notify(`软件当前判断 ${state.config.monitorName} 已回到当前机器接口，并已把桌面恢复为扩展显示。`);
    }
    return true;
  } catch {
    // Keep waiting. The monitor may have reappeared but not finished handshaking yet.
    return false;
  } finally {
    windowsRestoreInFlight = false;
  }
}

async function attemptWindowsDesktopAutoRestoreToLocalInterface({ notifyOnSuccess = false } = {}) {
  if (process.platform !== "win32" || windowsRestoreInFlight || state.config.windowsDisplayHandoffMode === "off") {
    return false;
  }

  windowsRestoreInFlight = true;

  try {
    const names = await getAvailableMonitorNames();
    const availability = await updateWindowsMonitorAvailability(names);
    const localInterfaceId = getLocalInterfaceId();

    if (availability.status !== "visible" || availability.owner !== localInterfaceId) {
      return false;
    }

    const attachedDisplayCount = await getCurrentWindowsAttachedDisplayCount();
    const expectedCount = getExpectedWindowsRestoreDisplayCount();
    if (
      !Number.isInteger(attachedDisplayCount) ||
      attachedDisplayCount >= expectedCount ||
      expectedCount <= 1
    ) {
      return false;
    }

    await restoreWindowsDesktopToTargetMonitor();
    clearPendingWindowsDesktopRestore();
    if (notifyOnSuccess) {
      notify(`Windows 已检测到共享屏切回当前机器接口，并已主动恢复扩展显示。`);
    }
    return true;
  } catch (error) {
    appendDiagnosticLog("Windows auto-restore to local interface failed", error);
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
  const localInterfaceId = getLocalInterfaceId();

  if (
    state.windowsDesktop.pendingRestore &&
    availability.status === "visible" &&
    availability.owner === localInterfaceId
  ) {
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

  if (
    !state.windowsDesktop.pendingRestore &&
    state.config.windowsDisplayHandoffMode !== "off" &&
    availability.status === "visible" &&
    availability.owner === localInterfaceId
  ) {
    const autoRestored = await attemptWindowsDesktopAutoRestoreToLocalInterface({
      notifyOnSuccess: false,
    });
    if (autoRestored) {
      const message = "Windows 已主动刷新，并已重新把共享屏接回扩展桌面。";
      if (notifyOnSuccess) {
        notify(message);
      }
      return {
        changed: true,
        message,
        availability: windowsMonitorAvailability,
        attachedDisplayCount: await getCurrentWindowsAttachedDisplayCount(),
      };
    }
  }

  const shouldCollapseSharedMonitor =
    state.config.windowsDisplayHandoffMode !== "off" &&
    Number.isInteger(attachedDisplayCount) &&
    attachedDisplayCount > 1 &&
    availability.owner !== localInterfaceId &&
    (parseTargetId(availability.owner) !== null || (recentTargetId && recentTargetId !== localInterfaceId));

  const shouldForceCollapseSharedMonitor =
    state.config.windowsDisplayHandoffMode !== "off" &&
    Number.isInteger(attachedDisplayCount) &&
    attachedDisplayCount > 1 &&
    lastRequestedTargetId &&
    lastRequestedTargetId !== localInterfaceId;

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
  const localInterfaceId = getLocalInterfaceId();
  const recentTargetId = attemptedTargetId || getRecentSuccessfulTargetId();
  if (!recentTargetId || recentTargetId === localInterfaceId) {
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
    return recentTargetId;
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
    Boolean(inferWindowsOwnerFromLocalDisplayState([], displayCount, attemptedTargetId))
  );
}

function inferMacOwnerFromLocalDisplayState(attemptedTargetId = null) {
  const localInterfaceId = getLocalInterfaceId();
  const recentTargetId = attemptedTargetId || getRecentSuccessfulTargetId();
  if (!recentTargetId || recentTargetId === localInterfaceId) {
    return null;
  }

  try {
    if (screen.getAllDisplays().length === 0) {
      return recentTargetId;
    }
  } catch {
    return recentTargetId;
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

function createDefaultInterfacesConfig() {
  const interfaces = {};

  for (const slot of TARGET_SLOTS) {
    interfaces[slot.id] = {
      inputValue: slot.defaultInputValue,
    };
  }

  return interfaces;
}

function getInterfaceIdByDefaultInputValue(inputValue) {
  const parsedValue = normalizePositiveInteger(inputValue, 0);
  const matchedSlot = TARGET_SLOTS.find((slot) => slot.defaultInputValue === parsedValue);
  return matchedSlot ? matchedSlot.id : null;
}

function migrateLegacyInterfacesConfig(rawConfig, defaults) {
  const nextInterfaces = { ...defaults.config.interfaces };

  if (rawConfig.interfaces && typeof rawConfig.interfaces === "object") {
    for (const targetId of TARGET_IDS) {
      nextInterfaces[targetId] = {
        inputValue: normalizePositiveInteger(
          rawConfig.interfaces?.[targetId]?.inputValue,
          defaults.config.interfaces[targetId].inputValue
        ),
      };
    }

    return nextInterfaces;
  }

  const rawTargets = rawConfig.targets || {};
  for (const legacyTarget of [rawTargets.windows, rawTargets.mac]) {
    const mappedTargetId = getInterfaceIdByDefaultInputValue(legacyTarget?.inputValue);
    if (!mappedTargetId) {
      continue;
    }

    nextInterfaces[mappedTargetId] = {
      inputValue: normalizePositiveInteger(
        legacyTarget?.inputValue,
        defaults.config.interfaces[mappedTargetId].inputValue
      ),
    };
  }

  return nextInterfaces;
}

function inferLocalInterfaceIdFromConfig(rawConfig, defaults) {
  const configuredLocalInterfaceId = parseTargetId(rawConfig.localInterfaceId);
  if (configuredLocalInterfaceId) {
    return configuredLocalInterfaceId;
  }

  const rawTargets = rawConfig.targets || {};
  const legacyLocalTarget =
    process.platform === "win32"
      ? rawTargets.windows
      : process.platform === "darwin"
        ? rawTargets.mac
        : null;
  const migratedInterfaceId = getInterfaceIdByDefaultInputValue(legacyLocalTarget?.inputValue);
  return migratedInterfaceId || defaults.config.localInterfaceId;
}

function createDefaultConfig() {
  return {
    monitorName: "",
    localDisplayIndex: 1,
    localInterfaceId: TARGET_IDS[0],
    compatibilityMode: "auto",
    windowsDisplayHandoffMode: "auto",
    interfaces: createDefaultInterfacesConfig(),
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
      monitorName: normalizeText(rawConfig.monitorName),
      localDisplayIndex: normalizePositiveInteger(
        rawConfig.localDisplayIndex ?? rawConfig.macDisplayIndex,
        defaults.config.localDisplayIndex
      ),
      localInterfaceId: inferLocalInterfaceIdFromConfig(rawConfig, defaults),
      compatibilityMode: parseCompatibilityMode(rawConfig.compatibilityMode || defaults.config.compatibilityMode),
      windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
        rawConfig.windowsDisplayHandoffMode || defaults.config.windowsDisplayHandoffMode
      ),
      interfaces: migrateLegacyInterfacesConfig(rawConfig, defaults),
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

let monitorMenuRefreshInFlight = false;
let monitorMenuRefreshQueued = false;

function cloneInterfacesConfig(sourceInterfaces = null) {
  const defaults = createDefaultInterfacesConfig();
  const nextInterfaces = {};

  for (const targetId of TARGET_IDS) {
    nextInterfaces[targetId] = {
      inputValue: normalizePositiveInteger(
        sourceInterfaces?.[targetId]?.inputValue,
        defaults[targetId].inputValue
      ),
    };
  }

  return nextInterfaces;
}

function getMonitorIdForDisplayKey(displayKey) {
  const normalizedKey = normalizeText(displayKey) || crypto.randomBytes(6).toString("hex");
  return `monitor-${crypto.createHash("sha1").update(normalizedKey).digest("hex").slice(0, 12)}`;
}

function createDefaultMonitorConfig(partial = {}) {
  const displayKey = normalizeText(partial.displayKey);

  return {
    id: normalizeText(partial.id) || getMonitorIdForDisplayKey(displayKey),
    displayKey,
    roleLabel: normalizeText(partial.roleLabel),
    displayName: normalizeText(partial.displayName),
    localInterfaceId: parseTargetId(partial.localInterfaceId) || TARGET_IDS[0],
    compatibilityMode: parseCompatibilityMode(partial.compatibilityMode),
    windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(partial.windowsDisplayHandoffMode),
    interfaces: cloneInterfacesConfig(partial.interfaces),
    match: {
      electronDisplayId: Number.isInteger(partial.match?.electronDisplayId)
        ? partial.match.electronDisplayId
        : null,
      gdiDeviceName: normalizeText(partial.match?.gdiDeviceName),
      productCode: normalizeText(partial.match?.productCode),
    },
  };
}

function normalizeMonitorConfig(rawMonitorConfig = {}, fallbackMonitorConfig = {}) {
  const baseline = createDefaultMonitorConfig(fallbackMonitorConfig);
  return createDefaultMonitorConfig({
    ...baseline,
    ...rawMonitorConfig,
    id: normalizeText(rawMonitorConfig.id) || baseline.id,
    displayKey: normalizeText(rawMonitorConfig.displayKey) || baseline.displayKey,
    roleLabel: normalizeText(rawMonitorConfig.roleLabel) || baseline.roleLabel,
    displayName: normalizeText(rawMonitorConfig.displayName) || baseline.displayName,
    localInterfaceId:
      parseTargetId(rawMonitorConfig.localInterfaceId) || baseline.localInterfaceId,
    compatibilityMode:
      parseCompatibilityMode(rawMonitorConfig.compatibilityMode) || baseline.compatibilityMode,
    windowsDisplayHandoffMode:
      parseWindowsDisplayHandoffMode(rawMonitorConfig.windowsDisplayHandoffMode) ||
      baseline.windowsDisplayHandoffMode,
    interfaces: cloneInterfacesConfig(rawMonitorConfig.interfaces || baseline.interfaces),
    match: {
      electronDisplayId: Number.isInteger(rawMonitorConfig.match?.electronDisplayId)
        ? rawMonitorConfig.match.electronDisplayId
        : baseline.match.electronDisplayId,
      gdiDeviceName:
        normalizeText(rawMonitorConfig.match?.gdiDeviceName) || baseline.match.gdiDeviceName,
      productCode:
        normalizeText(rawMonitorConfig.match?.productCode) || baseline.match.productCode,
    },
  });
}

function createDefaultConfig() {
  return {
    monitorName: "",
    localDisplayIndex: 1,
    localInterfaceId: TARGET_IDS[0],
    compatibilityMode: "auto",
    windowsDisplayHandoffMode: "auto",
    interfaces: createDefaultInterfacesConfig(),
    monitors: [],
  };
}

function createDefaultState() {
  return {
    lastTarget: null,
    controlToken: crypto.randomBytes(12).toString("hex"),
    windowsDesktop: {
      pendingRestore: false,
      expectedAttachedDisplayCount: 0,
      byMonitorId: {},
    },
    manualSession: createDefaultManualSessionState(),
    lastSwitchOutcome: createSwitchOutcome(),
    macInputProbe: createMacInputProbeResult(),
    config: createDefaultConfig(),
  };
}

function createLegacyMonitorConfig(rawConfig, defaults) {
  return normalizeMonitorConfig(
    {
      id: "legacy-monitor",
      displayKey: normalizeText(rawConfig.displayKey),
      roleLabel: "当前机器屏幕",
      displayName: normalizeText(rawConfig.monitorName),
      localInterfaceId: inferLocalInterfaceIdFromConfig(rawConfig, defaults),
      compatibilityMode: parseCompatibilityMode(
        rawConfig.compatibilityMode || defaults.config.compatibilityMode
      ),
      windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
        rawConfig.windowsDisplayHandoffMode || defaults.config.windowsDisplayHandoffMode
      ),
      interfaces: migrateLegacyInterfacesConfig(rawConfig, defaults),
      match: {
        electronDisplayId: null,
        gdiDeviceName: normalizeText(rawConfig.gdiDeviceName),
        productCode: normalizeText(rawConfig.productCode),
      },
    },
    {}
  );
}

function normalizeWindowsDesktopRuntime(nextStateWindowsDesktop = {}) {
  const byMonitorId = {};
  const rawMap = nextStateWindowsDesktop.byMonitorId;

  if (rawMap && typeof rawMap === "object") {
    for (const [monitorId, runtime] of Object.entries(rawMap)) {
      const normalizedId = normalizeText(monitorId);
      if (!normalizedId) {
        continue;
      }

      byMonitorId[normalizedId] = {
        pendingRestore: Boolean(runtime?.pendingRestore),
        expectedAttachedDisplayCount: normalizePositiveInteger(
          runtime?.expectedAttachedDisplayCount,
          0
        ),
      };
    }
  }

  return {
    pendingRestore: Boolean(nextStateWindowsDesktop.pendingRestore),
    expectedAttachedDisplayCount: normalizePositiveInteger(
      nextStateWindowsDesktop.expectedAttachedDisplayCount,
      0
    ),
    byMonitorId,
  };
}

function normalizeState(nextState) {
  const defaults = createDefaultState();
  const rawConfig = nextState.config || {};
  const rawMonitorConfigs = Array.isArray(rawConfig.monitors) ? rawConfig.monitors : [];
  const normalizedMonitorConfigs =
    rawMonitorConfigs.length > 0
      ? rawMonitorConfigs.map((monitorConfig, index) =>
          normalizeMonitorConfig(monitorConfig, {
            id: normalizeText(monitorConfig?.id) || `legacy-monitor-${index + 1}`,
          })
        )
      : [createLegacyMonitorConfig(rawConfig, defaults)];

  return {
    lastTarget: normalizeText(nextState.lastTarget),
    controlToken: normalizeText(nextState.controlToken) || defaults.controlToken,
    windowsDesktop: normalizeWindowsDesktopRuntime(nextState.windowsDesktop),
    manualSession: normalizeManualSessionState(nextState.manualSession, defaults.manualSession),
    lastSwitchOutcome: createSwitchOutcome(nextState.lastSwitchOutcome),
    macInputProbe: normalizeMacInputProbeState(nextState.macInputProbe, defaults.macInputProbe),
    config: {
      monitorName: normalizeText(rawConfig.monitorName),
      localDisplayIndex: normalizePositiveInteger(
        rawConfig.localDisplayIndex ?? rawConfig.macDisplayIndex,
        defaults.config.localDisplayIndex
      ),
      localInterfaceId: inferLocalInterfaceIdFromConfig(rawConfig, defaults),
      compatibilityMode: parseCompatibilityMode(
        rawConfig.compatibilityMode || defaults.config.compatibilityMode
      ),
      windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
        rawConfig.windowsDisplayHandoffMode || defaults.config.windowsDisplayHandoffMode
      ),
      interfaces: migrateLegacyInterfacesConfig(rawConfig, defaults),
      monitors: normalizedMonitorConfigs,
    },
  };
}

function getStoredMonitorConfigs() {
  return Array.isArray(state.config?.monitors) ? state.config.monitors : [];
}

function getMonitorDesktopRuntime(monitorId) {
  const normalizedId = normalizeText(monitorId);
  if (!state.windowsDesktop || typeof state.windowsDesktop !== "object") {
    state.windowsDesktop = {
      pendingRestore: false,
      expectedAttachedDisplayCount: 0,
      byMonitorId: {},
    };
  }

  if (!state.windowsDesktop.byMonitorId || typeof state.windowsDesktop.byMonitorId !== "object") {
    state.windowsDesktop.byMonitorId = {};
  }

  if (!state.windowsDesktop.byMonitorId[normalizedId]) {
    state.windowsDesktop.byMonitorId[normalizedId] = {
      pendingRestore: false,
      expectedAttachedDisplayCount: 0,
    };
  }

  return state.windowsDesktop.byMonitorId[normalizedId];
}

function buildDisplayKeyForLocalDisplay(display, displayIndex, topologyDisplay = null) {
  if (process.platform === "win32") {
    const gdiDeviceName = normalizeText(topologyDisplay?.deviceName);
    if (gdiDeviceName) {
      return `win:${gdiDeviceName}`;
    }
  }

  if (process.platform === "darwin" && Number.isInteger(display?.id)) {
    return `mac:${display.id}`;
  }

  return `fallback:${displayIndex}:${display?.bounds?.x || 0}:${display?.bounds?.y || 0}:${
    display?.bounds?.width || 0
  }x${display?.bounds?.height || 0}`;
}

async function getLocalDisplaySummaries() {
  const orderedDisplays = getOrderedLocalDisplays();
  const topologyDisplays = process.platform === "win32" ? await getWindowsTopologyDisplays() : [];
  const singleDisplayOnly = orderedDisplays.length <= 1;
  let secondaryIndex = 2;

  return orderedDisplays.map((display, index) => {
    const topologyMatch =
      process.platform === "win32"
        ? matchWindowsTopologyDisplayToElectronDisplay(display, topologyDisplays)
        : null;
    const roleLabel = singleDisplayOnly
      ? "当前机器屏幕"
      : display.primary
        ? "主屏幕"
        : `附屏幕 ${secondaryIndex++}`;
    const displayKey = buildDisplayKeyForLocalDisplay(display, index + 1, topologyMatch);
    const displayName = normalizeText(
      topologyMatch?.friendlyName ||
        topologyMatch?.displayName ||
        topologyMatch?.deviceString ||
        display.label ||
        ""
    );

    return {
      id: getMonitorIdForDisplayKey(displayKey),
      displayKey,
      index: index + 1,
      roleLabel,
      detectedName: displayName,
      resolution: `${display.bounds.width} × ${display.bounds.height}`,
      position: `${display.bounds.x}, ${display.bounds.y}`,
      internal: Boolean(display.internal),
      primary: Boolean(display.primary),
      electronDisplayId: Number.isInteger(display.id) ? display.id : null,
      gdiDeviceName: normalizeText(topologyMatch?.deviceName),
      productCode: normalizeText(topologyMatch?.productCode),
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
    };
  });
}

function resolveStoredMonitorConfigForDisplay(displaySummary, storedMonitorConfigs, usedMonitorIds) {
  const normalizedDisplayKey = normalizeText(displaySummary.displayKey);
  const normalizedDeviceName = normalizeText(displaySummary.gdiDeviceName);
  const electronDisplayId = Number.isInteger(displaySummary.electronDisplayId)
    ? displaySummary.electronDisplayId
    : null;

  const directMatch = storedMonitorConfigs.find((monitorConfig) => {
    if (usedMonitorIds.has(monitorConfig.id)) {
      return false;
    }

    return (
      normalizeText(monitorConfig.displayKey) === normalizedDisplayKey ||
      (normalizedDeviceName &&
        normalizeText(monitorConfig.match?.gdiDeviceName) === normalizedDeviceName) ||
      (Number.isInteger(electronDisplayId) &&
        monitorConfig.match?.electronDisplayId === electronDisplayId)
    );
  });

  if (directMatch) {
    return directMatch;
  }

  return (
    storedMonitorConfigs.find((monitorConfig) => {
      if (usedMonitorIds.has(monitorConfig.id)) {
        return false;
      }

      return !normalizeText(monitorConfig.displayKey);
    }) || null
  );
}

async function syncMonitorConfigsFromLocalDisplays({ persist = true } = {}) {
  const displaySummaries = await getLocalDisplaySummaries();
  const storedMonitorConfigs = getStoredMonitorConfigs();
  const usedMonitorIds = new Set();
  const nextMonitorConfigs = [];

  for (const displaySummary of displaySummaries) {
    const matchedMonitorConfig = resolveStoredMonitorConfigForDisplay(
      displaySummary,
      storedMonitorConfigs,
      usedMonitorIds
    );
    const nextMonitorConfig = normalizeMonitorConfig(
      {
        ...matchedMonitorConfig,
        id: displaySummary.id,
        displayKey: displaySummary.displayKey,
        roleLabel: displaySummary.roleLabel,
        displayName: displaySummary.detectedName || matchedMonitorConfig?.displayName || "",
        match: {
          electronDisplayId: displaySummary.electronDisplayId,
          gdiDeviceName: displaySummary.gdiDeviceName,
          productCode: displaySummary.productCode,
        },
      },
      createDefaultMonitorConfig({
        id: displaySummary.id,
        displayKey: displaySummary.displayKey,
        roleLabel: displaySummary.roleLabel,
        displayName: displaySummary.detectedName,
        match: {
          electronDisplayId: displaySummary.electronDisplayId,
          gdiDeviceName: displaySummary.gdiDeviceName,
          productCode: displaySummary.productCode,
        },
      })
    );

    usedMonitorIds.add(nextMonitorConfig.id);
    nextMonitorConfigs.push(nextMonitorConfig);
  }

  for (const storedMonitorConfig of storedMonitorConfigs) {
    if (usedMonitorIds.has(storedMonitorConfig.id)) {
      continue;
    }

    if (!normalizeText(storedMonitorConfig.displayKey)) {
      continue;
    }

    nextMonitorConfigs.push(normalizeMonitorConfig(storedMonitorConfig));
  }

  const nextSerialized = JSON.stringify(nextMonitorConfigs);
  const previousSerialized = JSON.stringify(storedMonitorConfigs);
  if (nextSerialized !== previousSerialized) {
    state.config.monitors = nextMonitorConfigs;
    if (persist) {
      saveState(state);
    }
  } else if (!Array.isArray(state.config.monitors)) {
    state.config.monitors = nextMonitorConfigs;
    if (persist) {
      saveState(state);
    }
  }

  return displaySummaries;
}

function buildConnectedMonitorContextsFromSummaries(displaySummaries) {
  const monitorConfigsById = new Map(
    getStoredMonitorConfigs().map((monitorConfig) => [monitorConfig.id, monitorConfig])
  );

  return displaySummaries
    .map((displaySummary) => {
      const monitorConfig = monitorConfigsById.get(displaySummary.id);
      if (!monitorConfig) {
        return null;
      }

      return {
        id: monitorConfig.id,
        monitor: monitorConfig,
        display: displaySummary,
      };
    })
    .filter(Boolean);
}

async function getConnectedMonitorContexts() {
  const displaySummaries = await syncMonitorConfigsFromLocalDisplays();
  return buildConnectedMonitorContextsFromSummaries(displaySummaries);
}

async function getMonitorContextById(monitorId) {
  const monitorContexts = await getConnectedMonitorContexts();
  return (
    monitorContexts.find((monitorContext) => monitorContext.id === normalizeText(monitorId)) || null
  );
}

function getMonitorConfigValidationErrors(monitorConfig) {
  const errors = [];

  if (!parseTargetId(monitorConfig.localInterfaceId)) {
    errors.push("当前机器接口配置无效。");
  }

  if (!["auto", "off", "samsung_mstar"].includes(monitorConfig.compatibilityMode)) {
    errors.push("兼容模式配置无效。");
  }

  if (!["auto", "off", "external"].includes(monitorConfig.windowsDisplayHandoffMode)) {
    errors.push("Windows 屏幕联动配置无效。");
  }

  for (const targetId of TARGET_IDS) {
    const inputValue = monitorConfig.interfaces?.[targetId]?.inputValue;
    if (!Number.isInteger(inputValue) || inputValue < 1 || inputValue > 255) {
      errors.push(`${getTargetSlotName(targetId)} 的输入值必须是 1 到 255 的整数。`);
    }
  }

  return Array.from(new Set(errors));
}

function buildMonitorConfigFromForm(form, existingMonitorConfig) {
  const nextMonitorConfig = normalizeMonitorConfig(
    {
      ...existingMonitorConfig,
      localInterfaceId:
        parseTargetId(form.get("localInterfaceId")) || existingMonitorConfig.localInterfaceId,
      compatibilityMode: parseCompatibilityMode(form.get("compatibilityMode")),
      windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
        form.get("windowsDisplayHandoffMode")
      ),
      interfaces: TARGET_IDS.reduce((result, targetId) => {
        result[targetId] = {
          inputValue: parseInputValue(form.get(`${targetId}InputValue`)),
        };
        return result;
      }, {}),
    },
    existingMonitorConfig
  );

  return {
    monitorConfig: nextMonitorConfig,
    errors: getMonitorConfigValidationErrors(nextMonitorConfig),
  };
}

function getTarget(targetId, monitorConfig = state.config) {
  const slot = TARGET_SLOT_MAP.get(targetId);
  const configuredTarget = monitorConfig?.interfaces?.[targetId] || state.config.interfaces?.[targetId] || {};
  return {
    id: targetId,
    label: slot?.title || targetId,
    inputValue: Number.isInteger(configuredTarget.inputValue)
      ? configuredTarget.inputValue
      : slot?.defaultInputValue,
  };
}

function getLocalInterfaceId(monitorConfig = state.config) {
  return parseTargetId(monitorConfig?.localInterfaceId) || TARGET_IDS[0];
}

function isLocalInterfaceTarget(targetId, monitorConfig = state.config) {
  return parseTargetId(targetId) === getLocalInterfaceId(monitorConfig);
}

function getSwitchActionLabel(targetId, monitorConfig = state.config) {
  const target = getTarget(targetId, monitorConfig);
  return isLocalInterfaceTarget(targetId, monitorConfig)
    ? `${target.label}（当前机器接口）`
    : target.label;
}

function shouldUseSamsungMstarCompat(config) {
  if (config?.compatibilityMode === "samsung_mstar") {
    return true;
  }

  if (config?.compatibilityMode === "off") {
    return false;
  }

  return /\b(g7|g72|odyssey|samsung)\b/i.test(
    normalizeText(config?.displayName || config?.monitorName)
  );
}

function getInputCandidates(target, monitorConfig = state.config) {
  const candidates = [target.inputValue];

  if (!shouldUseSamsungMstarCompat(monitorConfig)) {
    return candidates;
  }

  for (const candidate of getSamsungMstarCandidates(target.inputValue)) {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function getMonitorDisplayName(monitorContextOrConfig) {
  return normalizeText(
    monitorContextOrConfig?.display?.detectedName ||
      monitorContextOrConfig?.monitor?.displayName ||
      monitorContextOrConfig?.displayName
  );
}

function getMonitorDisplayTitle(monitorContextOrConfig) {
  const roleLabel = normalizeText(
    monitorContextOrConfig?.display?.roleLabel || monitorContextOrConfig?.roleLabel
  );
  const displayName = getMonitorDisplayName(monitorContextOrConfig);
  return displayName ? `${roleLabel} · ${displayName}` : roleLabel || "本机屏幕";
}

function getWindowsMonitorSelectorArgs(monitorContextOrConfig) {
  const gdiDeviceName = normalizeText(
    monitorContextOrConfig?.display?.gdiDeviceName ||
      monitorContextOrConfig?.monitor?.match?.gdiDeviceName ||
      monitorContextOrConfig?.match?.gdiDeviceName
  );
  if (gdiDeviceName) {
    return ["-GdiDeviceName", gdiDeviceName];
  }

  const displayName = getMonitorDisplayName(monitorContextOrConfig);
  if (displayName) {
    return ["-MonitorName", displayName];
  }

  throw new Error("Windows 当前没有这块屏幕的可用设备标识。");
}

function getWindowsTopologySelectorValue(monitorContextOrConfig) {
  const selectorArgs = getWindowsMonitorSelectorArgs(monitorContextOrConfig);
  return selectorArgs[1];
}

function getMacSwitchScriptEnvForContext(monitorContext) {
  const displayName = getMonitorDisplayName(monitorContext);
  const env = {
    DISPLAY_NAME: displayName,
    DISPLAY_INDEX: String(monitorContext.display.index),
  };

  if (Number.isInteger(monitorContext.display.electronDisplayId)) {
    env.DISPLAY_ID = String(monitorContext.display.electronDisplayId);
  }

  return env;
}

function createSwitchOutcome({
  status = "idle",
  monitorId = null,
  targetId = null,
  mode = "switch",
  message = "",
  updatedAt = null,
} = {}) {
  return {
    status: ["idle", "success", "error"].includes(status) ? status : "idle",
    monitorId: normalizeText(monitorId),
    targetId: parseTargetId(targetId),
    mode: ["switch", "manual_prep"].includes(normalizeText(mode)) ? normalizeText(mode) : "switch",
    message: normalizeText(message),
    updatedAt: normalizeText(updatedAt) || new Date().toISOString(),
  };
}

function recordSwitchOutcome(status, monitorId, targetId, message = "") {
  state.lastSwitchOutcome = createSwitchOutcome({
    status,
    monitorId,
    targetId,
    message,
  });
}

function persistSuccessfulLocalSwitch(monitorContext, targetId, target) {
  state.lastTarget = `${monitorContext.id}:${targetId}`;
  state.macInputProbe = createMacInputProbeResult();
  recordSwitchOutcome(
    "success",
    monitorContext.id,
    targetId,
    `${getMonitorDisplayTitle(monitorContext)} 已执行切换：${target.label}。`
  );
  saveState(state);
  refreshMenu();
}

function getConnectedDisplayCount() {
  return getOrderedLocalDisplays().length;
}

function shouldUseWindowsDisplayHandoffForMonitor(monitorConfig) {
  if (process.platform !== "win32") {
    return false;
  }

  if (monitorConfig.windowsDisplayHandoffMode === "off") {
    return false;
  }

  if (monitorConfig.windowsDisplayHandoffMode === "external") {
    return true;
  }

  return getConnectedDisplayCount() >= 2;
}

function isWindowsMonitorAttachedInTopology(topologyDisplays, monitorContextOrConfig) {
  const selectorValue = normalizeText(getWindowsTopologySelectorValue(monitorContextOrConfig));
  if (!selectorValue) {
    return false;
  }

  return topologyDisplays.some((display) => {
    if (!display.attached) {
      return false;
    }

    return (
      normalizeText(display.deviceName).toLowerCase() === selectorValue.toLowerCase() ||
      normalizeText(display.displayName).toLowerCase() === selectorValue.toLowerCase() ||
      normalizeText(display.friendlyName).toLowerCase() === selectorValue.toLowerCase()
    );
  });
}

async function getWindowsCurrentInputResultForContext(monitorContext) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      value: null,
      error: "当前平台不支持 Windows 输入读取。",
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
      ...getWindowsMonitorSelectorArgs(monitorContext),
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
      error: normalizeText(error.message),
    };
  }
}

async function getMacCurrentInputResultForContext(monitorContext) {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      value: null,
      error: "当前平台不支持 macOS 输入读取。",
    };
  }

  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");

  try {
    const output = await runCommand("/bin/sh", [scriptPath, "--query-input"], {
      env: getMacSwitchScriptEnvForContext(monitorContext),
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
      error: normalizeText(error.message),
    };
  }
}

async function getMonitorLiveStatus(monitorContext) {
  if (process.platform === "win32") {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const visible = isWindowsMonitorAttachedInTopology(topologyDisplays, monitorContext);
    if (!visible) {
      return {
        visible: false,
        currentInputValue: null,
        currentInputError: "当前这块屏幕不在 Windows 桌面里。",
      };
    }

    const currentInputResult = await getWindowsCurrentInputResultForContext(monitorContext);
    return {
      visible: true,
      currentInputValue: currentInputResult.ok ? currentInputResult.value : null,
      currentInputError: currentInputResult.ok ? null : currentInputResult.error,
    };
  }

  const currentInputResult = await getMacCurrentInputResultForContext(monitorContext);
  return {
    visible: true,
    currentInputValue: currentInputResult.ok ? currentInputResult.value : null,
    currentInputError: currentInputResult.ok ? null : currentInputResult.error,
  };
}

async function buildMonitorContextsWithStatus() {
  const monitorContexts = await getConnectedMonitorContexts();
  return Promise.all(
    monitorContexts.map(async (monitorContext) => ({
      ...monitorContext,
      status: await getMonitorLiveStatus(monitorContext),
    }))
  );
}

async function waitForWindowsMonitorAttachmentState(monitorConfig, expectedAttached, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8000) {
    const topologyDisplays = await getWindowsTopologyDisplays();
    if (isWindowsMonitorAttachedInTopology(topologyDisplays, monitorConfig) === expectedAttached) {
      return;
    }

    await delay(250);
  }

  throw new Error(errorMessage);
}

async function detachWindowsDisplayForMonitor(monitorConfig, expectedAttachedDisplayCount) {
  const selectorValue = getWindowsTopologySelectorValue(monitorConfig);
  await runWindowsTopologyCommand(["-MonitorName", selectorValue, "-DetachMonitor"]);
  await waitForWindowsMonitorAttachmentState(
    monitorConfig,
    false,
    "Windows 没有把这块共享屏从桌面拓扑里移除。"
  );
  markMonitorPendingRestore(monitorConfig.id, expectedAttachedDisplayCount);
}

async function attachWindowsDisplayForMonitor(monitorConfig, expectedAttachedDisplayCount) {
  const selectorValue = getWindowsTopologySelectorValue(monitorConfig);
  await runWindowsTopologyCommand(["-MonitorName", selectorValue, "-AttachMonitor"]);
  await waitForWindowsMonitorAttachmentState(
    monitorConfig,
    true,
    "Windows 没有把这块共享屏重新加回桌面拓扑。"
  );

  if (Number.isInteger(expectedAttachedDisplayCount) && expectedAttachedDisplayCount > 1) {
    await waitForDisplayCount(expectedAttachedDisplayCount, "Windows 没有恢复到预期的扩展显示数量。");
  }
}

function markMonitorPendingRestore(monitorId, expectedAttachedDisplayCount = null) {
  const runtime = getMonitorDesktopRuntime(monitorId);
  runtime.pendingRestore = true;
  runtime.expectedAttachedDisplayCount =
    Number.isInteger(expectedAttachedDisplayCount) && expectedAttachedDisplayCount > 1
      ? expectedAttachedDisplayCount
      : 0;
  saveState(state);
  refreshMenu();
}

function clearMonitorPendingRestore(monitorId) {
  const runtime = getMonitorDesktopRuntime(monitorId);
  if (!runtime.pendingRestore && runtime.expectedAttachedDisplayCount === 0) {
    return;
  }

  runtime.pendingRestore = false;
  runtime.expectedAttachedDisplayCount = 0;
  saveState(state);
  refreshMenu();
}

async function verifyWindowsSwitchOutcomeForContext(monitorContext, targetId, target, expectedValues) {
  const startedAt = Date.now();
  const switchingToLocalInterface = isLocalInterfaceTarget(targetId, monitorContext.monitor);
  let lastObservedValue = null;
  let lastErrorMessage = "";

  while (Date.now() - startedAt < 4000) {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const visible = isWindowsMonitorAttachedInTopology(topologyDisplays, monitorContext);
    if (!visible && !switchingToLocalInterface) {
      return;
    }

    const currentInputResult = await getWindowsCurrentInputResultForContext(monitorContext);
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
      `${getMonitorDisplayTitle(monitorContext)} 当前输入仍是 ${lastObservedValue}，未匹配目标值集合：${expectedValues.join(
        " "
      )}`
    );
  }

  throw new Error(
    lastErrorMessage || `${getMonitorDisplayTitle(monitorContext)} 还没有确认真正切到 ${target.label}。`
  );
}

async function switchOnWindowsForContext(monitorContext, targetId, target) {
  const monitorConfig = monitorContext.monitor;
  const switchingToLocalInterface = isLocalInterfaceTarget(targetId, monitorConfig);
  const topologyDisplays = await getWindowsTopologyDisplays();
  if (!isWindowsMonitorAttachedInTopology(topologyDisplays, monitorContext)) {
    throw new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 当前不在 Windows 桌面里，Windows 这侧不能直接控制它。请在当前持有这块屏的主机上切，或用显示器按键切回。`
    );
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const candidates = getInputCandidates(target, monitorConfig);
  const expectedValues = getExpectedProbeInputValues(target.inputValue);
  const attachedDisplayCountBeforeSwitch = await getCurrentWindowsAttachedDisplayCount();

  await runCandidateSequence(candidates, async (candidate) => {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...getWindowsMonitorSelectorArgs(monitorContext),
      "-InputValue",
      String(candidate),
    ]);
    await verifyWindowsSwitchOutcomeForContext(monitorContext, targetId, target, expectedValues);
  });

  if (!switchingToLocalInterface && shouldUseWindowsDisplayHandoffForMonitor(monitorConfig)) {
    await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
    await detachWindowsDisplayForMonitor(monitorConfig, attachedDisplayCountBeforeSwitch);
  } else if (switchingToLocalInterface) {
    clearMonitorPendingRestore(monitorConfig.id);
  }
}

async function switchOnMacForContext(monitorContext, targetId, target) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  const candidates = getInputCandidates(target, monitorContext.monitor);
  await runCandidateSequence(candidates, (candidate) =>
    runCommand("/bin/sh", [scriptPath, String(candidate)], {
      env: getMacSwitchScriptEnvForContext(monitorContext),
    })
  );
}

function formatMonitorSwitchError(monitorContext, targetId, error) {
  const target = getTarget(targetId, monitorContext.monitor);
  const rawMessage = normalizeText(error?.message);
  if (!rawMessage) {
    return new Error(`${getMonitorDisplayTitle(monitorContext)} 切换失败。`);
  }

  if (/^No monitor matched GDI device /i.test(rawMessage)) {
    return new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 当前没有出现在本机可控列表里。这通常说明它已经切到别的主机，当前这台机器无法直接发切换命令。`
    );
  }

  if (/^No physical monitor handles were found /i.test(rawMessage)) {
    return new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 已被系统识别，但没有拿到可控的物理显示器句柄。请确认它是支持 DDC/CI 的外接显示器，并在菜单里开启 DDC/CI。`
    );
  }

  if (/^Failed\.?$/i.test(rawMessage)) {
    return new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 的底层工具只返回了 “Failed.”。请检查该接口输入值是否填对。`
    );
  }

  if (/未匹配目标值集合/u.test(rawMessage)) {
    return new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 没有真正切到 ${target.label}。常见原因是输入值还没配对，或者目标接口当前没有稳定视频信号。`
    );
  }

  return new Error(rawMessage);
}

async function switchMonitor(monitorId, targetId, options = {}) {
  const { notifyOnSuccess = true, showErrorDialog = false } = options;
  const monitorContext = await getMonitorContextById(monitorId);

  if (!monitorContext) {
    throw new Error("当前没有找到这块本机屏幕，可能它已经不在当前主机上。");
  }

  const monitorConfig = monitorContext.monitor;
  const target = getTarget(targetId, monitorConfig);
  const configErrors = getMonitorConfigValidationErrors(monitorConfig);
  if (configErrors.length > 0) {
    const error = new Error(configErrors.join(" "));
    recordSwitchOutcome("error", monitorContext.id, targetId, error.message);
    saveState(state);
    refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, error.message);
    }

    throw error;
  }

  try {
    if (process.platform === "win32") {
      await switchOnWindowsForContext(monitorContext, targetId, target);
    } else if (process.platform === "darwin") {
      await switchOnMacForContext(monitorContext, targetId, target);
    } else {
      throw new Error(`当前平台不受支持：${process.platform}`);
    }

    persistSuccessfulLocalSwitch(monitorContext, targetId, target);

    if (notifyOnSuccess) {
      notify(`${getMonitorDisplayTitle(monitorContext)} 已切到 ${target.label}。`);
    }
  } catch (error) {
    const userFacingError = formatMonitorSwitchError(monitorContext, targetId, error);
    recordSwitchOutcome("error", monitorContext.id, targetId, userFacingError.message);
    saveState(state);
    refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, userFacingError.message);
    }

    throw userFacingError;
  }
}

async function attemptPendingWindowsRestores() {
  if (process.platform !== "win32" || windowsRestoreInFlight) {
    return false;
  }

  windowsRestoreInFlight = true;

  try {
    await syncMonitorConfigsFromLocalDisplays({ persist: false });
    const topologyDisplays = await getWindowsTopologyDisplays();
    const pendingMonitorConfigs = getStoredMonitorConfigs().filter(
      (monitorConfig) => getMonitorDesktopRuntime(monitorConfig.id).pendingRestore
    );

    let restored = false;
    for (const monitorConfig of pendingMonitorConfigs) {
      const selectorValue = normalizeText(monitorConfig.match?.gdiDeviceName);
      if (!selectorValue) {
        continue;
      }

      const targetDisplay = topologyDisplays.find(
        (display) => normalizeText(display.deviceName).toLowerCase() === selectorValue.toLowerCase()
      );
      if (!targetDisplay) {
        continue;
      }

      if (!targetDisplay.attached) {
        const runtime = getMonitorDesktopRuntime(monitorConfig.id);
        try {
          await attachWindowsDisplayForMonitor(
            monitorConfig,
            runtime.expectedAttachedDisplayCount || null
          );
          restored = true;
        } catch (error) {
          appendDiagnosticLog("Failed to restore detached Windows display", error);
          continue;
        }
      }

      clearMonitorPendingRestore(monitorConfig.id);
      restored = true;
    }

    return restored;
  } finally {
    windowsRestoreInFlight = false;
  }
}

async function refreshWindowsDisplayState(options = {}) {
  const { monitorId = null, notifyOnSuccess = false } = options;
  if (process.platform !== "win32") {
    return {
      changed: false,
      message: "当前平台不是 Windows。",
    };
  }

  await syncMonitorConfigsFromLocalDisplays({ persist: false });
  const topologyDisplays = await getWindowsTopologyDisplays();
  let changed = false;

  for (const monitorConfig of getStoredMonitorConfigs()) {
    if (monitorId && monitorConfig.id !== monitorId) {
      continue;
    }

    const runtime = getMonitorDesktopRuntime(monitorConfig.id);
    if (!runtime.pendingRestore) {
      continue;
    }

    const visible = isWindowsMonitorAttachedInTopology(topologyDisplays, monitorConfig);
    if (visible) {
      clearMonitorPendingRestore(monitorConfig.id);
      changed = true;
      continue;
    }

    const restored = await attemptPendingWindowsRestores();
    changed = changed || restored;
  }

  const message = changed ? "Windows 已刷新并处理共享屏恢复。" : "Windows 已刷新当前屏幕状态。";
  if (notifyOnSuccess) {
    notify(message);
  }

  return {
    changed,
    message,
  };
}

function startWindowsRestoreWatcher() {
  if (process.platform !== "win32") {
    return;
  }

  const scheduleAttempt = () => {
    void syncMonitorConfigsFromLocalDisplays();
    void attemptPendingWindowsRestores();
    void refreshMenu();
  };

  screen.on("display-added", () => {
    scheduleTrayRebuild("display-added");
    scheduleAttempt();
  });
  screen.on("display-removed", () => {
    scheduleTrayRebuild("display-removed");
    scheduleAttempt();
  });

  if (windowsRestoreTimer) {
    clearInterval(windowsRestoreTimer);
  }
  windowsRestoreTimer = setInterval(scheduleAttempt, 2500);
  scheduleAttempt();
}

function handleTrayDirectSwitch(monitorId, targetId) {
  void switchMonitor(monitorId, targetId, {
    notifyOnSuccess: true,
    showErrorDialog: false,
  }).catch((error) => {
    appendDiagnosticLog(`Direct switch failed (${monitorId}:${targetId})`, error);
  });
}

async function refreshMenu() {
  if (!tray) {
    return;
  }

  if (monitorMenuRefreshInFlight) {
    monitorMenuRefreshQueued = true;
    return;
  }

  monitorMenuRefreshInFlight = true;

  try {
    const openAtLogin = app.getLoginItemSettings().openAtLogin;
    const monitorContexts = await getConnectedMonitorContexts();
    const monitorMenuItems =
      monitorContexts.length === 0
        ? [
            {
              label: "当前没有识别到本机已连接的可控屏幕",
              enabled: false,
            },
          ]
        : monitorContexts.map((monitorContext) => ({
            label: getMonitorDisplayTitle(monitorContext),
            submenu: [
              {
                label: `当前机器接口：${getTarget(
                  getLocalInterfaceId(monitorContext.monitor),
                  monitorContext.monitor
                ).label}`,
                enabled: false,
              },
              {
                label: `系统标识：${
                  normalizeText(monitorContext.display.gdiDeviceName) ||
                  normalizeText(monitorContext.display.electronDisplayId) ||
                  "未知"
                }`,
                enabled: false,
              },
              { type: "separator" },
              ...TARGET_IDS.map((targetId) => ({
                label: `直接切到 ${getSwitchActionLabel(targetId, monitorContext.monitor)}`,
                click: () => handleTrayDirectSwitch(monitorContext.id, targetId),
              })),
              ...(process.platform === "win32"
                ? [
                    { type: "separator" },
                    {
                      label: "主动刷新这块 Windows 屏幕",
                      click: () => {
                        void refreshWindowsDisplayState({
                          monitorId: monitorContext.id,
                          notifyOnSuccess: true,
                        });
                      },
                    },
                  ]
                : []),
            ],
          }));

    const menu = Menu.buildFromTemplate([
      {
        label: `版本：v${app.getVersion()}`,
        enabled: false,
      },
      ...monitorMenuItems,
      ...(process.platform === "win32"
        ? [
            { type: "separator" },
            {
              label: "主动刷新全部等待接回的 Windows 屏幕",
              click: () => {
                void refreshWindowsDisplayState({
                  notifyOnSuccess: true,
                });
              },
            },
          ]
        : []),
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
  } catch (error) {
    appendDiagnosticLog("Failed to refresh tray menu", error);
  } finally {
    monitorMenuRefreshInFlight = false;
    if (monitorMenuRefreshQueued) {
      monitorMenuRefreshQueued = false;
      void refreshMenu();
    }
  }
}

function renderMonitorRuntimeHint(monitorContext) {
  if (process.platform !== "win32") {
    return "";
  }

  const runtime = getMonitorDesktopRuntime(monitorContext.id);
  if (!runtime.pendingRestore) {
    return "";
  }

  return `<div class="banner success" style="margin-top: 12px;">这块屏已标记为“等待接回”。当它重新回到 Windows 信号链路后，软件会自动把它加回桌面拓扑。</div>`;
}

function renderMonitorInterfaceStatusCard(monitorContext, targetId) {
  const target = getTarget(targetId, monitorContext.monitor);
  const currentInputValue = Number.isInteger(monitorContext.status?.currentInputValue)
    ? monitorContext.status.currentInputValue
    : null;
  const current = Number.isInteger(currentInputValue)
    ? getExpectedProbeInputValues(target.inputValue).includes(currentInputValue)
    : false;

  let statusText = "连接状态未知";
  let detailText = "未激活接口是否真的接了设备，DDC/CI 没法无损读出来。";
  if (!monitorContext.status?.visible) {
    statusText = "当前不在本机";
    detailText = "这块屏当前不在本机显示拓扑里，因此本机无法直接读取它的当前输入。";
  } else if (current) {
    statusText = "当前正在显示";
    detailText = `当前输入回报：${describeInputValue(currentInputValue)}。`;
  } else if (Number.isInteger(currentInputValue)) {
    statusText = "当前未显示";
    detailText = `当前输入回报：${describeInputValue(currentInputValue)}。`;
  } else if (monitorContext.status?.currentInputError) {
    statusText = "读取失败";
    detailText = monitorContext.status.currentInputError;
  }

  return `<div class="interface-card${current ? " current" : ""}">
    <div class="section-title">${escapeHtml(target.label)}</div>
    <div class="status-pill ${escapeHtml(current ? "success" : "neutral")}">${escapeHtml(statusText)}</div>
    <div class="display-meta">
      输入值：${escapeHtml(String(target.inputValue))}<br>
      ${escapeHtml(detailText)}
    </div>
    <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/switch/${encodeURIComponent(
      monitorContext.id
    )}/${encodeURIComponent(targetId)}" style="margin-top: 14px;">
      <button type="submit">直接切到 ${escapeHtml(getSwitchActionLabel(targetId, monitorContext.monitor))}</button>
    </form>
  </div>`;
}

function renderMonitorConfigForm(monitorContext) {
  const monitorConfig = monitorContext.monitor;
  return `<form method="post" action="/api/${encodeURIComponent(
    state.controlToken
  )}/config/${encodeURIComponent(monitorContext.id)}" style="margin-top: 18px;">
    <div class="two-col">
      <label>
        当前机器接口
        <select name="localInterfaceId">
          ${TARGET_IDS.map((targetId) =>
            renderNamedOption(
              targetId,
              getTarget(targetId, monitorConfig).label,
              getLocalInterfaceId(monitorConfig)
            )
          ).join("")}
        </select>
      </label>
      <label>
        兼容模式
        <select name="compatibilityMode">
          ${renderNamedOption("auto", "自动判断", monitorConfig.compatibilityMode)}
          ${renderNamedOption("off", "关闭兼容补发", monitorConfig.compatibilityMode)}
          ${renderNamedOption("samsung_mstar", "Samsung / MStar", monitorConfig.compatibilityMode)}
        </select>
      </label>
    </div>
    ${
      process.platform === "win32"
        ? `<label style="margin-top: 14px;">
            Windows 屏幕联动
            <select name="windowsDisplayHandoffMode">
              ${renderNamedOption(
                "auto",
                "自动：切走后移出桌面，回来后自动接回",
                monitorConfig.windowsDisplayHandoffMode
              )}
              ${renderNamedOption("off", "关闭联动", monitorConfig.windowsDisplayHandoffMode)}
              ${renderNamedOption("external", "强制启用", monitorConfig.windowsDisplayHandoffMode)}
            </select>
          </label>`
        : `<input type="hidden" name="windowsDisplayHandoffMode" value="${escapeHtml(
            monitorConfig.windowsDisplayHandoffMode
          )}">`
    }
    <div class="interface-grid" style="margin-top: 14px;">
      ${TARGET_IDS.map((targetId) => {
        const target = getTarget(targetId, monitorConfig);
        return `<div class="interface-card${isLocalInterfaceTarget(targetId, monitorConfig) ? " current" : ""}">
          <div class="section-title">${escapeHtml(target.label)}</div>
          <label>
            输入值
            <input name="${escapeHtml(targetId)}InputValue" type="number" min="1" max="255" step="1" value="${escapeHtml(
              String(target.inputValue)
            )}">
          </label>
        </div>`;
      }).join("")}
    </div>
    <button type="submit" style="margin-top: 16px;">保存这块屏幕配置</button>
  </form>`;
}

function renderMonitorSection(monitorContext) {
  const systemId = normalizeText(monitorContext.display.gdiDeviceName)
    ? `Windows DeviceName：${monitorContext.display.gdiDeviceName}`
    : Number.isInteger(monitorContext.display.electronDisplayId)
      ? `Display ID：${monitorContext.display.electronDisplayId}`
      : "系统标识：未知";
  const refreshButtonHtml =
    process.platform === "win32"
      ? `<form method="post" action="/api/${encodeURIComponent(
          state.controlToken
        )}/windows/refresh/${encodeURIComponent(monitorContext.id)}" style="margin-top: 16px;">
          <button type="submit" class="secondary">主动刷新这块 Windows 屏幕</button>
        </form>`
      : "";

  return `<div class="card soft">
    <div class="section-title">${escapeHtml(getMonitorDisplayTitle(monitorContext))}</div>
    <div class="help" style="margin-top: 12px;">
      ${escapeHtml(systemId)}<br>
      分辨率：${escapeHtml(monitorContext.display.resolution)}<br>
      位置：${escapeHtml(monitorContext.display.position)}<br>
      当前机器接口：${escapeHtml(
        getTarget(getLocalInterfaceId(monitorContext.monitor), monitorContext.monitor).label
      )}
    </div>
    ${renderMonitorRuntimeHint(monitorContext)}
    <div class="interface-grid">
      ${TARGET_IDS.map((targetId) => renderMonitorInterfaceStatusCard(monitorContext, targetId)).join("")}
    </div>
    ${renderMonitorConfigForm(monitorContext)}
    ${refreshButtonHtml}
  </div>`;
}

function renderSettingsPage(requestUrl, monitorContexts) {
  const status = requestUrl.searchParams.get("status");
  const message = requestUrl.searchParams.get("message");
  const statusHtml = renderSettingsBanner(status, message);
  const globalRefreshHtml =
    process.platform === "win32"
      ? `<div class="card soft">
          <div class="section-title">Windows 主动刷新</div>
          <div class="help" style="margin-top: 12px;">如果显示器已经切回 Windows，但系统还没把它重新接回桌面，可以手动触发一次全局刷新。</div>
          <form method="post" action="/api/${encodeURIComponent(
            state.controlToken
          )}/windows/refresh" style="margin-top: 16px;">
            <button type="submit" class="secondary">主动刷新全部等待接回的 Windows 屏幕</button>
          </form>
        </div>`
      : "";
  const emptyStateHtml =
    monitorContexts.length === 0
      ? `<div class="card soft">
          <div class="section-title">当前没有本机已连接屏幕</div>
          <div class="help" style="margin-top: 12px;">
            如果你刚把共享屏移交出去，这是正常的。Windows 版会在信号回来后自动尝试接回；macOS 版会在这块屏重新回到本机后再次显示出来。
          </div>
        </div>`
      : monitorContexts.map((monitorContext) => renderMonitorSection(monitorContext)).join("");

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
    input, select {
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
    .section-title {
      margin: 4px 0 0;
      font-size: 20px;
    }
    .interface-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 14px;
    }
    .interface-card {
      padding: 14px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.62);
      border: 1px solid var(--border);
    }
    .interface-card.current {
      border-color: rgba(13, 107, 98, 0.42);
      box-shadow: inset 0 0 0 1px rgba(13, 107, 98, 0.12);
    }
    .display-meta {
      margin-top: 6px;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.6;
    }
    .status-pill.success {
      background: var(--success-bg);
      color: var(--success);
    }
    .status-pill.neutral {
      background: rgba(13, 107, 98, 0.08);
      color: var(--accent-strong);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      margin-top: 10px;
    }
    .help {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.6;
    }
    @media (max-width: 640px) {
      .two-col {
        grid-template-columns: 1fr;
      }
      .interface-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Local Setup · v${escapeHtml(app.getVersion())}</div>
    <h1>${escapeHtml(APP_NAME)} 设置</h1>
    <p>这里不再做跨主机伪状态推断，只按“当前主机直接控制当前主机已连接的物理屏”工作。识别到几块本机屏幕，就展示几块。</p>
    <div class="stack">
      ${statusHtml}
      ${globalRefreshHtml}
      ${emptyStateHtml}
    </div>
  </main>
</body>
</html>`;
}

async function handleConfigSave(request, response, requestUrl, monitorId) {
  const body = await readRequestBody(request);
  const form = new URLSearchParams(body);
  const existingMonitorConfig = getStoredMonitorConfigs().find(
    (monitorConfig) => monitorConfig.id === normalizeText(monitorId)
  );

  if (!existingMonitorConfig) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: "没有找到要保存的屏幕配置。",
    });
    return;
  }

  const { monitorConfig, errors } = buildMonitorConfigFromForm(form, existingMonitorConfig);
  if (errors.length > 0) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: errors.join(" "),
    });
    return;
  }

  state.config.monitors = getStoredMonitorConfigs().map((storedMonitorConfig) =>
    storedMonitorConfig.id === monitorConfig.id ? monitorConfig : storedMonitorConfig
  );
  saveState(state);
  refreshMenu();

  redirectToSettingsPage(response, requestUrl, {
    status: "success",
    message: `${getMonitorDisplayTitle(monitorConfig)} 配置已保存。`,
  });
}

async function handleSwitchRequest(response, requestUrl, monitorId, targetId) {
  try {
    await switchMonitor(monitorId, targetId, {
      notifyOnSuccess: true,
      showErrorDialog: false,
    });
    redirectToSettingsPage(response, requestUrl, {
      status: "success",
      message: "切换命令已发送。",
    });
  } catch (error) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: normalizeText(error.message) || "切换失败。",
    });
  }
}

async function handleWindowsRefreshRequest(response, requestUrl, monitorId = null) {
  try {
    const result = await refreshWindowsDisplayState({
      monitorId: normalizeText(monitorId) || null,
      notifyOnSuccess: false,
    });
    redirectToSettingsPage(response, requestUrl, {
      status: "success",
      message: result.message,
    });
  } catch (error) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: normalizeText(error.message) || "Windows 刷新失败。",
    });
  }
}

async function handleControlRequest(request, response) {
  const baseUrl = `http://${request.headers.host || "127.0.0.1"}`;
  const requestUrl = new URL(request.url || "/", baseUrl);
  const controlPath = getControlPath();
  const settingsPath = getSettingsPath();
  const statePath = `/api/${state.controlToken}/state`;
  const configPath = `/api/${state.controlToken}/config`;
  const switchPathMatch = new RegExp(`^/api/${state.controlToken}/switch/([^/]+)/([^/]+)$`).exec(
    requestUrl.pathname
  );
  const configPathMatch = new RegExp(`^/api/${state.controlToken}/config/([^/]+)$`).exec(
    requestUrl.pathname
  );
  const windowsRefreshPathMatch = new RegExp(
    `^/api/${state.controlToken}/windows/refresh(?:/([^/]+))?$`
  ).exec(requestUrl.pathname);

  if (requestUrl.pathname === "/health") {
    const monitorContexts = await getConnectedMonitorContexts();
    return writeJson(response, 200, {
      ok: true,
      appName: APP_NAME,
      version: app.getVersion(),
      connectedMonitors: monitorContexts.map((monitorContext) => ({
        id: monitorContext.id,
        title: getMonitorDisplayTitle(monitorContext),
      })),
      lastSwitchOutcome: state.lastSwitchOutcome,
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
      lastSwitchOutcome: state.lastSwitchOutcome,
    });
  }

  if (requestUrl.pathname === configPath && request.method === "GET") {
    return writeJson(response, 200, {
      ok: true,
      config: state.config,
    });
  }

  if (requestUrl.pathname === controlPath) {
    return redirectToSettingsPage(response, requestUrl, {});
  }

  if (requestUrl.pathname === settingsPath) {
    const monitorContexts = await buildMonitorContextsWithStatus();
    return writeHtml(response, 200, renderSettingsPage(requestUrl, monitorContexts));
  }

  if (configPathMatch && request.method === "POST") {
    return handleConfigSave(
      request,
      response,
      requestUrl,
      decodeURIComponent(configPathMatch[1])
    );
  }

  if (switchPathMatch && request.method === "POST") {
    const targetId = parseTargetId(decodeURIComponent(switchPathMatch[2]));
    if (!targetId) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("未找到对应接口。");
      return;
    }

    return handleSwitchRequest(
      response,
      requestUrl,
      decodeURIComponent(switchPathMatch[1]),
      targetId
    );
  }

  if (windowsRefreshPathMatch && request.method === "POST") {
    return handleWindowsRefreshRequest(
      response,
      requestUrl,
      windowsRefreshPathMatch[1] ? decodeURIComponent(windowsRefreshPathMatch[1]) : null
    );
  }

  if (
    requestUrl.pathname.startsWith(`/api/${state.controlToken}/manual/`) ||
    requestUrl.pathname.startsWith(`/api/${state.controlToken}/probe/`) ||
    requestUrl.pathname === `/api/${state.controlToken}/monitors`
  ) {
    response.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("旧的交接、probe 和单屏监控接口已移除。当前版本只保留按本机物理屏直接切换。");
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("未找到对应页面。");
}
