const { app, Tray, Menu, nativeImage, Notification, dialog, shell, screen } = require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const {
  doesMonitorListContainConfiguredMonitor,
  normalizeText,
} = require("./monitor-name-helpers");
const {
  createWindowsSharedMonitorTransferHint,
  createWindowsSwitchMenuModel,
} = require("./tray-menu-helpers");

const APP_NAME = "显示器输入切换";
const APP_ID = "com.zhangzhangluzi.g72inputswitchtray";
const WINDOWS_TRAY_GUID = "f5b6f5d6-2917-42e3-b552-b5796b6f7f0d";
const PREFERRED_CONTROL_PORT = 3847;
const TRAY_REBUILD_DELAY_MS = 1200;
const TRAY_HEALTHCHECK_INTERVAL_MS = 5000;
const WINDOWS_DISPLAY_HANDOFF_DELAY_MS = 1500;
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
let ownershipRefreshTimer = null;
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
let sharedMonitorOwnership = createDefaultOwnershipSnapshot();
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

  if (ownershipRefreshTimer) {
    clearInterval(ownershipRefreshTimer);
    ownershipRefreshTimer = null;
  }
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  state = loadState();
  saveState(state);
  startControlServer();
  startWindowsRestoreWatcher();
  startWindowsTrayWatcher();
  startOwnershipWatcher();
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
  const localSettingsUrl = getLocalSettingsUrl();
  const currentOwnerTargetId = getCurrentOwnerTargetId();
  const windowsSharedMonitorMissing =
    process.platform === "win32" &&
    configErrors.length === 0 &&
    (["missing", "away"].includes(windowsMonitorAvailability.status) || currentOwnerTargetId === "mac");
  const windowsSharedMonitorMessage = windowsSharedMonitorMissing
    ? sharedMonitorOwnership.message ||
      windowsMonitorAvailability.message ||
      `${state.config.monitorName || "共享屏"} 当前不在 Windows 侧，请到 Mac 端或显示器菜单切回。`
    : "";
  const switchMenuItems = createWindowsSwitchMenuModel({
    windowsSharedMonitorMissing,
    hasConfigErrors: configErrors.length > 0,
    lastTarget: state.lastTarget,
    currentOwnerTargetId,
    windowsLabel: getTarget("windows").label,
    macLabel: getTarget("mac").label,
  }).map((item) => {
    if (item.kind === "handoffHint") {
      return {
        label: item.label,
        enabled: item.enabled,
        click: () => showWindowsSharedMonitorTransferHint(windowsSharedMonitorMessage),
      };
    }

    return {
      label: item.label,
      type: item.type,
      checked: item.checked,
      enabled: item.enabled,
      click: () => handleTraySwitch(item.targetId),
    };
  });

  const menu = Menu.buildFromTemplate([
    {
      label: `当前所有权：${getCurrentOwnershipMenuLabel()}`,
      enabled: false,
    },
    {
      label: state.lastTarget
        ? `最近切换请求：${getTarget(state.lastTarget).label}`
        : "最近切换请求：尚未通过此应用发送",
      enabled: false,
    },
    {
      label: `当前显示器：${state.config.monitorName || "未设置"}`,
      enabled: false,
    },
    ...(process.platform === "win32" && state.windowsDesktop.pendingRestore
      ? [
          {
            label: `Windows 桌面：已交给副屏，等待 ${state.config.monitorName || "目标显示器"} 回来后自动恢复`,
            enabled: false,
          },
        ]
      : []),
    ...(windowsSharedMonitorMissing
      ? [
          {
            label: windowsSharedMonitorMessage,
            enabled: false,
          },
        ]
      : []),
    {
      label: controlServerError
        ? `设置页：启动失败（${controlServerError.code || "未知错误"}）`
        : `设置页：${summarizeControlAddress(localSettingsUrl)}`,
      enabled: false,
    },
    ...(configErrors.length > 0
      ? [
          {
            label: `配置未完成：${configErrors[0]}`,
            enabled: false,
          },
        ]
      : []),
    {
      label: "说明：当前所有权尽量按实时归属判断；最近切换请求只表示历史动作",
      enabled: false,
    },
    { type: "separator" },
    ...switchMenuItems,
    { type: "separator" },
    {
      label: "打开本机设置页",
      enabled: !controlServerError,
      click: () => {
        void shell.openExternal(localSettingsUrl).catch((error) => {
          appendDiagnosticLog("Failed to open settings page", error);
          dialog.showErrorBox(APP_NAME, `无法打开本机设置页。\n\n${error.message}`);
        });
      },
    },
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

function showWindowsSharedMonitorTransferHint(message = "") {
  const hint = createWindowsSharedMonitorTransferHint({
    monitorName: state.config.monitorName,
    message,
  });

  void dialog.showMessageBox({
    type: "info",
    title: APP_NAME,
    message: hint.message,
    detail: hint.detail,
    buttons: ["知道了"],
    defaultId: 0,
  });
}

function handleTraySwitch(targetId) {
  void switchMonitor(targetId).catch((error) => {
    appendDiagnosticLog(`Tray switch failed (${targetId})`, error);
  });
}

async function switchMonitor(targetId, options = {}) {
  const { notifyOnSuccess = true, showErrorDialog = true } = options;
  const target = getTarget(targetId);
  const configErrors = getConfigValidationErrors(state.config);

  if (configErrors.length > 0) {
    const error = new Error(configErrors.join(" "));

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, `当前配置无效。\n\n${error.message}`);
    }

    throw error;
  }

  try {
    if (process.platform === "win32") {
      await switchOnWindows(targetId, target);
    } else if (process.platform === "darwin") {
      await switchOnMac(targetId, target);
    } else {
      throw new Error(`当前平台不受支持：${process.platform}`);
    }

    state.lastTarget = targetId;
    state.macInputProbe = createMacInputProbeResult();
    saveState(state);
    refreshMenu();

    if (notifyOnSuccess) {
      notify(`已向 ${state.config.monitorName} 发送切换命令：${target.label}。`);
    }
  } catch (error) {
    const userFacingError = createUserFacingSwitchError(targetId, error);

    if (showErrorDialog) {
      dialog.showErrorBox(
        APP_NAME,
        `${target.label} 切换命令发送失败。\n\n${userFacingError.message}`
      );
    }

    throw userFacingError;
  }
}

async function switchOnWindows(targetId, target) {
  const useDisplayHandoff = shouldUseWindowsDisplayHandoff(state.config);
  await assertWindowsSharedMonitorAvailableForSwitch();

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
    const peerConfirmation = await confirmPeerOwnership(targetId);
    if (!peerConfirmation.confirmed) {
      throw error;
    }

    if (peerConfirmation.snapshot) {
      updateSharedMonitorOwnership(peerConfirmation.snapshot);
    }
  }

  if (useDisplayHandoff && targetId !== "windows") {
    await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
    await handOffWindowsDesktop();
    markPendingWindowsDesktopRestore();
  }
}

function switchOnMac(targetId, target) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  const candidates = getInputCandidates(target);
  return runCandidateSequence(candidates, (candidate) =>
    runCommand("/bin/sh", [scriptPath, String(candidate)], {
      env: {
        DISPLAY_NAME: state.config.monitorName,
        DISPLAY_INDEX: String(state.config.macDisplayIndex),
      },
    })
  ).catch(async (error) => {
    const peerConfirmation = await confirmPeerOwnership(targetId);
    if (peerConfirmation.confirmed) {
      if (peerConfirmation.snapshot) {
        updateSharedMonitorOwnership(peerConfirmation.snapshot);
      }
      return;
    }

    throw error;
  });
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
  const windowsPath = `/api/${state.controlToken}/switch/windows`;
  const macPath = `/api/${state.controlToken}/switch/mac`;
  const macProbePath = `/api/${state.controlToken}/probe/mac`;
  const macProbeApplyPath = `/api/${state.controlToken}/probe/mac/apply`;
  const peerOwnershipPath = getPeerOwnershipPath();

  if (requestUrl.pathname === "/health") {
    const ownership = await getEffectiveOwnershipSnapshot();
    return writeJson(response, 200, {
      ok: true,
      appName: APP_NAME,
      lastTarget: state.lastTarget,
      monitorName: state.config.monitorName,
      ownership,
    });
  }

  if (requestUrl.pathname === peerOwnershipPath && request.method === "GET") {
    return writeJson(response, 200, {
      ok: true,
      ownership: await getEffectiveOwnershipSnapshot({ includePeer: false }),
    });
  }

  if (!isLoopbackRequest(request)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("仅允许本机访问设置与控制接口。");
    return;
  }

  if (requestUrl.pathname === statePath) {
    const ownership = await getEffectiveOwnershipSnapshot();
    return writeJson(response, 200, {
      ok: true,
      lastTarget: state.lastTarget,
      currentLabel: getCurrentTargetLabel(),
      ownership,
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
    const [monitors, diagnostics, macProbeDiagnostics, ownershipSnapshot] = await Promise.all([
      getAvailableMonitorNames(),
      getMonitorDiagnostics(),
      getMacProbeDiagnostics(),
      getEffectiveOwnershipSnapshot(),
    ]);
    return writeHtml(
      response,
      200,
      renderSettingsPage(requestUrl, monitors, diagnostics, macProbeDiagnostics, ownershipSnapshot)
    );
  }

  if (requestUrl.pathname === configPath && request.method === "POST") {
    return handleConfigSave(request, response, requestUrl);
  }

  if (requestUrl.pathname === macProbePath && request.method === "POST") {
    return handleMacProbe(request, response, requestUrl);
  }

  if (requestUrl.pathname === macProbeApplyPath && request.method === "POST") {
    return handleMacProbeApply(request, response, requestUrl);
  }

  if (requestUrl.pathname === windowsPath) {
    return handleControlSwitch(request, response, requestUrl, "windows");
  }

  if (requestUrl.pathname === macPath) {
    return handleControlSwitch(request, response, requestUrl, "mac");
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("未找到对应页面。");
}

async function handleControlSwitch(request, response, requestUrl, targetId) {
  if (!["GET", "POST"].includes(request.method || "GET")) {
    response.writeHead(405, {
      "Allow": "GET, POST",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("当前接口只支持 GET 或 POST。");
    return;
  }

  if (request.method === "POST") {
    await readRequestBody(request);
  }

  try {
    await switchMonitor(targetId, {
      notifyOnSuccess: false,
      showErrorDialog: false,
    });

    redirectToControlPage(response, requestUrl, {
      status: "success",
      target: targetId,
    });
  } catch (error) {
    redirectToControlPage(response, requestUrl, {
      status: "error",
      target: targetId,
      message: error.message,
    });
  }
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
    peerStatusUrl: normalizePeerStatusUrl(form.get("peerStatusUrl")),
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

  if (normalizeText(config.peerStatusUrl) && !isValidPeerStatusUrl(config.peerStatusUrl)) {
    errors.push("对端状态 URL 无效。请填写完整的 http:// 或 https:// 地址。");
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

function normalizePeerStatusUrl(value) {
  const normalized = normalizeText(value);
  return normalized.replace(/\/+$/, "");
}

function isValidPeerStatusUrl(value) {
  if (!normalizeText(value)) {
    return true;
  }

  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
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
    throw new Error(availability.message || `${state.config.monitorName} 当前画面已交给另一台电脑。`);
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

function renderSettingsPage(requestUrl, monitorNames, diagnostics, macProbeDiagnostics, ownershipSnapshot) {
  const status = requestUrl.searchParams.get("status");
  const message = requestUrl.searchParams.get("message");
  const statusHtml = renderSettingsBanner(status, message);
  const monitorHintHtml = renderMonitorHints(monitorNames);
  const diagnosticsHtml = renderMonitorDiagnostics(diagnostics);
  const macProbeHtml = renderMacProbeAssistant(macProbeDiagnostics);
  const ownershipHtml = renderOwnershipStatusCard(ownershipSnapshot);
  const peerStatusHtml = renderPeerStatusCard();

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
    <div class="eyebrow">Local Setup</div>
    <h1>${escapeHtml(APP_NAME)} 设置</h1>
    <p>这里定义“控制哪一台显示器”以及“两种切换模式分别发什么输入值”。下面的“共享屏当前归属”会尽量显示实时所有权；“最近切换请求”只保留历史动作，不再代表当前画面归属。</p>
    <div class="stack">
      ${statusHtml}
      ${ownershipHtml}
      ${diagnosticsHtml}
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
              ${renderNamedOption("auto", "自动判断（仅安全场景启用）", state.config.windowsDisplayHandoffMode)}
              ${renderNamedOption("off", "关闭联动", state.config.windowsDisplayHandoffMode)}
              ${renderNamedOption(
                "external",
                "强制联动（仅建议带内置屏）",
                state.config.windowsDisplayHandoffMode
              )}
            </select>
          </label>
          <div class="help">
            只影响 Windows 版。应用只会在检测到内置屏的安全场景下调用系统“仅第二屏幕”；像台式机双外接屏这种结构，继续强推这条联动很容易黑屏。
          </div>
          ${peerStatusHtml}
          <label>
            对端状态 URL
            <input name="peerStatusUrl" value="${escapeHtml(state.config.peerStatusUrl)}" placeholder="例如：http://192.168.31.8:3847/api/abcdef1234567890/ownership">
          </label>
          <div class="help">
            选填。填上另一台电脑的“只读状态 URL”后，本机在本地读值不可靠时，会向对端确认 G72 是否已经成功交接。
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

function renderOwnershipStatusCard(ownershipSnapshot) {
  const snapshot = ownershipSnapshot || createDefaultOwnershipSnapshot();
  const ownerTargetId = ["windows", "mac"].includes(snapshot.owner) ? snapshot.owner : null;
  const ownerLine = ownerTargetId
    ? `共享屏当前归属：${escapeHtml(getTarget(ownerTargetId).label)}`
    : "共享屏当前归属：暂时无法确认";
  const inputLine = Number.isInteger(snapshot.currentInputValue)
    ? `当前输入回报：${escapeHtml(describeInputValue(snapshot.currentInputValue))}`
    : "当前输入回报：暂时不可用";
  const sourceLine =
    snapshot.source === "peer"
      ? "这次归属来自对端确认。当前机器上的本地回读结果不够可靠，所以优先采用了另一台机器的确认。"
      : "这次归属来自当前机器的本地判断。";
  const detailLine = snapshot.message
    ? escapeHtml(snapshot.message)
    : ownerTargetId
      ? `已根据输入值把 G72 判定为 ${escapeHtml(getTarget(ownerTargetId).label)}。`
      : "当显示器继续保留逻辑连接、或者 DDC 回读不稳定时，这里的归属可能会暂时显示为未知。";

  return `<div class="card soft">
    <div class="section-title">共享屏当前归属</div>
    <div class="help" style="margin-top: 12px;">${ownerLine}</div>
    <div class="help">${inputLine}</div>
    <div class="help">${escapeHtml(sourceLine)}</div>
    <div class="help">${detailLine}</div>
  </div>`;
}

function renderPeerStatusCard() {
  const peerUrls = getLocalPeerStatusUrls();
  const peerUrlHtml =
    peerUrls.length > 0
      ? peerUrls.map((url) => `<span class="pill">${escapeHtml(url)}</span>`).join("")
      : `<span class="help">当前没有检测到可分享的局域网地址。</span>`;

  return `<div class="card soft">
    <div class="section-title">双端协同</div>
    <div class="help" style="margin-top: 12px;">把下面任一地址填到另一台电脑的“对端状态 URL”，就能让两边在本地读值不稳定时互相确认 G72 是否已经交接成功。</div>
    <div class="tip-list">${peerUrlHtml}</div>
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

function summarizeControlAddress(url) {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.hostname}:${parsedUrl.port}`;
  } catch {
    return "不可用";
  }
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

function getCurrentTargetLabel() {
  return state.lastTarget ? getTarget(state.lastTarget).label : "尚未通过此应用发送";
}

function getCurrentOwnerTargetId() {
  return ["windows", "mac"].includes(sharedMonitorOwnership.owner)
    ? sharedMonitorOwnership.owner
    : null;
}

function getCurrentOwnershipMenuLabel() {
  const ownerTargetId = getCurrentOwnerTargetId();
  if (ownerTargetId) {
    const suffix = sharedMonitorOwnership.source === "peer" ? "（来自对端确认）" : "";
    return `${getTarget(ownerTargetId).label}${suffix}`;
  }

  if (Number.isInteger(sharedMonitorOwnership.currentInputValue)) {
    return `${describeInputValue(sharedMonitorOwnership.currentInputValue)}（归属未定）`;
  }

  return "未知";
}

function getControlPath() {
  return `/control/${state.controlToken}`;
}

function getSettingsPath() {
  return `/settings/${state.controlToken}`;
}

function getPeerOwnershipPath() {
  return `/api/${state.peerToken}/ownership`;
}

function getLocalSettingsUrl() {
  return `http://127.0.0.1:${activeControlPort}${getSettingsPath()}`;
}

function getLocalPeerStatusUrls() {
  const pathName = getPeerOwnershipPath();
  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const addressList of Object.values(interfaces)) {
    for (const addressInfo of addressList || []) {
      if (!addressInfo || addressInfo.internal || addressInfo.family !== "IPv4") {
        continue;
      }

      urls.push(`http://${addressInfo.address}:${activeControlPort}${pathName}`);
    }
  }

  return Array.from(new Set(urls)).sort();
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

  if (!canUseWindowsDisplayHandoffSafely()) {
    return false;
  }

  if (config.windowsDisplayHandoffMode === "external") {
    return true;
  }

  return getWindowsDisplayLayoutInfo().displayCount === 2;
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

function canUseWindowsDisplayHandoffSafely() {
  const layoutInfo = getWindowsDisplayLayoutInfo();
  return layoutInfo.internalDisplayCount >= 1 && layoutInfo.externalDisplayCount >= 1;
}

function getWindowsDisplayHandoffDisabledReason() {
  if (process.platform !== "win32") {
    return "";
  }

  const layoutInfo = getWindowsDisplayLayoutInfo();
  if (layoutInfo.displayCount === 0) {
    return "当前没有读到可用的 Windows 显示器拓扑，先不自动联动。";
  }

  if (layoutInfo.internalDisplayCount === 0) {
    return "当前 Windows 没有检测到内置屏；继续调用“仅第二屏幕”容易把桌面切黑，所以已自动停用联动。";
  }

  if (layoutInfo.externalDisplayCount === 0) {
    return "当前 Windows 没有检测到外接屏，桌面联动没有可切换目标。";
  }

  return "";
}

function getWindowsDisplayHandoffHelpText(config) {
  if (process.platform !== "win32") {
    return "如果切到另一台设备后 Windows 主屏内容还留在原位，可以在 Windows 版里调整“桌面联动”设置。";
  }

  if (shouldUseWindowsDisplayHandoff(config)) {
    return "当前已启用 Windows 桌面联动。切到模式 B 后，应用只会在安全的内置屏场景下调用系统切屏；等这台屏回到 Windows 后，再自动恢复扩展显示。";
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
  await runWindowsDisplaySwitch("/external");
  await waitForDisplayCount(1, "Windows 没有切成仅用副屏。");
}

async function restoreWindowsDesktopToTargetMonitor() {
  await runWindowsDisplaySwitch("/extend");
  await waitForDisplayCount(2, "Windows 没有恢复到扩展显示。");
}

function runWindowsDisplaySwitch(mode) {
  const displaySwitchPath = path.join(
    process.env.WINDIR || "C:\\Windows",
    "System32",
    "DisplaySwitch.exe"
  );
  return runCommand(displaySwitchPath, [mode]);
}

async function waitForDisplayCount(expectedCount, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8000) {
    try {
      if (screen.getAllDisplays().length === expectedCount) {
        return;
      }
    } catch {
      // Ignore transient display enumeration failures while Windows is reconfiguring.
    }

    await delay(250);
  }

  throw new Error(errorMessage);
}

function startOwnershipWatcher() {
  void refreshSharedMonitorOwnership();
  ownershipRefreshTimer = setInterval(() => {
    void refreshSharedMonitorOwnership();
  }, 5000);
}

async function refreshSharedMonitorOwnership() {
  const snapshot = await getEffectiveOwnershipSnapshot();
  updateSharedMonitorOwnership(snapshot);
}

function updateSharedMonitorOwnership(nextSnapshot) {
  if (
    sharedMonitorOwnership.owner === nextSnapshot.owner &&
    sharedMonitorOwnership.source === nextSnapshot.source &&
    sharedMonitorOwnership.status === nextSnapshot.status &&
    sharedMonitorOwnership.message === nextSnapshot.message &&
    sharedMonitorOwnership.currentInputValue === nextSnapshot.currentInputValue
  ) {
    return;
  }

  sharedMonitorOwnership = nextSnapshot;
  refreshMenu();
}

async function getEffectiveOwnershipSnapshot({ includePeer = true } = {}) {
  const localSnapshot = await getLocalOwnershipSnapshot();

  if (!includePeer || !normalizeText(state.config.peerStatusUrl)) {
    return localSnapshot;
  }

  const peerSnapshot = await fetchPeerOwnershipSnapshot();
  if (!peerSnapshot) {
    return localSnapshot;
  }

  if (peerSnapshot.owner !== "unknown") {
    if (localSnapshot.owner === "unknown" || localSnapshot.owner !== peerSnapshot.owner) {
      return peerSnapshot;
    }
  }

  return localSnapshot;
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

async function getWindowsOwnershipSnapshot() {
  const names = await getAvailableMonitorNames();
  const availability = await createWindowsMonitorAvailabilitySnapshot(names);
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

async function getMacOwnershipSnapshot() {
  const currentInputResult = await getMacCurrentInputResult();
  if (!currentInputResult.ok) {
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

async function fetchPeerOwnershipSnapshot() {
  const peerStatusUrl = normalizeText(state.config.peerStatusUrl);
  if (!peerStatusUrl) {
    return null;
  }

  try {
    const payload = await requestJson(peerStatusUrl, 1500);
    const ownership = payload?.ownership;
    if (!ownership || !["windows", "mac", "unknown"].includes(ownership.owner)) {
      return null;
    }

    return {
      owner: ownership.owner,
      source: "peer",
      platform: normalizeText(ownership.platform) || "unknown",
      status: normalizeText(ownership.status) || "unknown",
      message: normalizeText(ownership.message),
      currentInputValue: Number.isInteger(ownership.currentInputValue)
        ? ownership.currentInputValue
        : null,
      updatedAt: normalizeText(ownership.updatedAt) || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function confirmPeerOwnership(targetId) {
  if (!parseTargetId(targetId) || !normalizeText(state.config.peerStatusUrl)) {
    return {
      confirmed: false,
      snapshot: null,
    };
  }

  const peerSnapshot = await fetchPeerOwnershipSnapshot();
  return {
    confirmed: Boolean(peerSnapshot && peerSnapshot.owner === targetId),
    snapshot: peerSnapshot,
  };
}

function requestJson(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          "Accept": "application/json",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Peer returned HTTP ${response.statusCode || 0}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Peer request timed out."));
    });
    request.on("error", reject);
  });
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

async function createWindowsMonitorAvailabilitySnapshot(monitorNames) {
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

  if (!doesMonitorListContainConfiguredMonitor(monitorNames, state.config.monitorName)) {
    const visibleText = monitorNames.length > 0 ? monitorNames.join("、") : "没有检测到任何显示器";
    return {
      status: "missing",
      names: monitorNames,
      message: `${state.config.monitorName} 当前不在 Windows 侧；现在看到的是 ${visibleText}。请到 Mac 端或显示器菜单切回。`,
      owner: "unknown",
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
      )}，说明这块共享屏的画面已经交给 Mac 了。请在 Mac 端或显示器菜单里切回 Windows。`,
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
  if (process.platform !== "win32" || windowsRestoreInFlight || !state.windowsDesktop.pendingRestore) {
    return;
  }

  windowsRestoreInFlight = true;

  try {
    const names = await getAvailableMonitorNames();
    const availability = await updateWindowsMonitorAvailability(names);
    if (availability.status !== "visible" || availability.owner === "mac") {
      return;
    }

    await restoreWindowsDesktopToTargetMonitor();
    clearPendingWindowsDesktopRestore();
    notify(`已检测到 ${state.config.monitorName} 回到 Windows，桌面已恢复为扩展显示。`);
  } catch {
    // Keep waiting. The monitor may have reappeared but not finished handshaking yet.
  } finally {
    windowsRestoreInFlight = false;
  }
}

function markPendingWindowsDesktopRestore() {
  if (state.windowsDesktop.pendingRestore) {
    return;
  }

  state.windowsDesktop.pendingRestore = true;
  saveState(state);
  refreshMenu();
}

function clearPendingWindowsDesktopRestore() {
  if (!state.windowsDesktop.pendingRestore) {
    return;
  }

  state.windowsDesktop.pendingRestore = false;
  saveState(state);
  refreshMenu();
}

function getWindowsDisplayCount() {
  try {
    return screen.getAllDisplays().length;
  } catch {
    return 0;
  }
}

function createDefaultState() {
  return {
    lastTarget: null,
    controlToken: crypto.randomBytes(12).toString("hex"),
    peerToken: crypto.randomBytes(12).toString("hex"),
    windowsDesktop: createDefaultWindowsDesktopState(),
    macInputProbe: createMacInputProbeResult(),
    config: createDefaultConfig(),
  };
}

function createDefaultWindowsDesktopState() {
  return {
    pendingRestore: false,
  };
}

function createDefaultConfig() {
  return {
    monitorName: "G72",
    macDisplayIndex: 1,
    compatibilityMode: "auto",
    windowsDisplayHandoffMode: "auto",
    peerStatusUrl: "",
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
    peerToken: normalizeText(nextState.peerToken) || defaults.peerToken,
    windowsDesktop: {
      pendingRestore: Boolean(nextState.windowsDesktop?.pendingRestore),
    },
    macInputProbe: normalizeMacInputProbeState(nextState.macInputProbe, defaults.macInputProbe),
    config: {
      monitorName: normalizeText(rawConfig.monitorName) || defaults.config.monitorName,
      macDisplayIndex: normalizePositiveInteger(rawConfig.macDisplayIndex, defaults.config.macDisplayIndex),
      compatibilityMode: parseCompatibilityMode(rawConfig.compatibilityMode || defaults.config.compatibilityMode),
      windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
        rawConfig.windowsDisplayHandoffMode || defaults.config.windowsDisplayHandoffMode
      ),
      peerStatusUrl: normalizePeerStatusUrl(rawConfig.peerStatusUrl),
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
