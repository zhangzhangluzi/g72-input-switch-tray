const { app, Tray, Menu, nativeImage, Notification, dialog, shell, screen } = require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "显示器输入切换";
const APP_ID = "com.zhangzhangluzi.g72inputswitchtray";
const WINDOWS_TRAY_GUID = "f5b6f5d6-2917-42e3-b552-b5796b6f7f0d";
const LOOPBACK_HOST = "127.0.0.1";
const PREFERRED_CONTROL_PORT = 3847;
const TRAY_REBUILD_DELAY_MS = 1200;
const TRAY_HEALTHCHECK_INTERVAL_MS = 5000;
const WINDOWS_DISPLAY_HANDOFF_DELAY_MS = 1500;
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
  { value: 27, label: "27: USB-C / Type-C" },
];
const COMMON_INPUT_LABELS = new Map(
  COMMON_INPUT_VALUES.map((item) => [item.value, item.label.replace(/^\d+:\s*/, "")])
);

let tray = null;
let controlServer = null;
let controlServerError = null;
let activeControlPort = PREFERRED_CONTROL_PORT;
let windowsRestoreTimer = null;
let trayRebuildTimer = null;
let trayHealthTimer = null;
let explorerSignature = null;
let refreshMenuInFlight = false;
let refreshMenuQueued = false;
let windowsRestoreInFlight = false;
let state = createDefaultState();

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
});

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  state = loadState();
  saveState(state);
  await syncMonitorConfigsFromLocalDisplays({ persist: true });
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
    // Ignore stale tray handles.
  }

  tray = null;
}

function rebuildTray(reason = "unknown") {
  appendDiagnosticLog(`Rebuilding tray (${reason})`);
  createTray();
  void refreshMenu();
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

async function refreshMenu() {
  if (!tray) {
    return;
  }

  if (refreshMenuInFlight) {
    refreshMenuQueued = true;
    return;
  }

  refreshMenuInFlight = true;

  try {
    const openAtLogin = app.getLoginItemSettings().openAtLogin;
    const monitorContexts = await buildMonitorContextsWithStatus();
    const monitorMenuItems =
      monitorContexts.length === 0
        ? [
            {
              label: "当前没有本机已连接的屏幕",
              enabled: false,
            },
          ]
        : monitorContexts.map((monitorContext) => buildTrayMonitorItem(monitorContext));

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
        label: "打开设置页",
        click: () => {
          shell.openExternal(`http://127.0.0.1:${getListeningPort()}${getSettingsPath()}`);
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
          void refreshMenu();
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
    refreshMenuInFlight = false;
    if (refreshMenuQueued) {
      refreshMenuQueued = false;
      void refreshMenu();
    }
  }
}

function buildTrayMonitorItem(monitorContext) {
  const currentInputLabel = Number.isInteger(monitorContext.status.currentInputValue)
    ? describeInputValue(monitorContext.status.currentInputValue)
    : monitorContext.status.visible
      ? "未知"
      : "当前不在本机";
  const runtime = getMonitorDesktopRuntime(monitorContext.id);

  return {
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
        label: `当前输入：${currentInputLabel}`,
        enabled: false,
      },
      ...(runtime.pendingRestore
        ? [
            {
              label: "状态：等待接回 Windows 桌面",
              enabled: false,
            },
          ]
        : []),
      { type: "separator" },
      ...TARGET_IDS.map((targetId) => ({
        label: `直接切到 ${getSwitchActionLabel(targetId, monitorContext.monitor)}`,
        enabled: monitorContext.status.visible !== false,
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
  };
}

function handleTrayDirectSwitch(monitorId, targetId) {
  void switchMonitor(monitorId, targetId, {
    notifyOnSuccess: true,
    showErrorDialog: false,
  }).catch((error) => {
    appendDiagnosticLog(`Direct switch failed (${monitorId}:${targetId})`, error);
  });
}

function startControlServer() {
  controlServerError = null;
  activeControlPort = PREFERRED_CONTROL_PORT;
  controlServer = http.createServer((request, response) => {
    handleControlRequest(request, response).catch((error) => {
      appendDiagnosticLog("Control request failed", error);
      if (response.headersSent) {
        response.end();
        return;
      }

      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`请求失败：${normalizeText(error.message) || "未知错误"}`);
    });
  });

  let fallbackAttempted = false;

  controlServer.on("error", (error) => {
    if (!fallbackAttempted && isRecoverablePortError(error)) {
      fallbackAttempted = true;
      setImmediate(() => {
        if (controlServer) {
          controlServer.listen(0, LOOPBACK_HOST);
        }
      });
      return;
    }

    controlServerError = error;
    controlServer = null;
    void refreshMenu();
    notify(`本机设置页启动失败：${error.message}`);
  });

  controlServer.listen(PREFERRED_CONTROL_PORT, LOOPBACK_HOST, () => {
    activeControlPort = getListeningPort();
    controlServerError = null;
    void refreshMenu();
  });
}

async function handleControlRequest(request, response) {
  const baseUrl = `http://${request.headers.host || "127.0.0.1"}`;
  const requestUrl = new URL(request.url || "/", baseUrl);
  const switchPathMatch = new RegExp(`^/api/${state.controlToken}/switch/([^/]+)/([^/]+)$`).exec(
    requestUrl.pathname
  );
  const configPathMatch = new RegExp(`^/api/${state.controlToken}/config/([^/]+)$`).exec(
    requestUrl.pathname
  );
  const windowsRefreshPathMatch = new RegExp(
    `^/api/${state.controlToken}/windows/refresh(?:/([^/]+))?$`
  ).exec(requestUrl.pathname);

  if (!isLoopbackRequest(request)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("仅允许本机访问设置与控制接口。");
    return;
  }

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
      controlPort: getListeningPort(),
    });
  }

  if (requestUrl.pathname === getControlPath()) {
    return redirectToSettingsPage(response, requestUrl, {});
  }

  if (requestUrl.pathname === getSettingsPath()) {
    const monitorContexts = await buildMonitorContextsWithStatus();
    return writeHtml(response, 200, renderSettingsPage(requestUrl, monitorContexts));
  }

  if (requestUrl.pathname === `/api/${state.controlToken}/state` && request.method === "GET") {
    return writeJson(response, 200, {
      ok: true,
      version: app.getVersion(),
      config: state.config,
      lastSwitchOutcome: state.lastSwitchOutcome,
    });
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
    const monitorId = decodeURIComponent(switchPathMatch[1]);
    const targetId = parseTargetId(decodeURIComponent(switchPathMatch[2]));
    if (!targetId) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("未找到对应接口。");
      return;
    }

    return handleSwitchRequest(response, requestUrl, monitorId, targetId);
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
    requestUrl.pathname === `/api/${state.controlToken}/monitors` ||
    requestUrl.pathname === `/api/${state.controlToken}/config`
  ) {
    response.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("旧的单屏、交接和 probe 接口已移除。当前版本只按本机物理屏工作。");
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("未找到对应页面。");
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
  void refreshMenu();

  redirectToSettingsPage(response, requestUrl, {
    status: "success",
    message: `${getMonitorDisplayTitle(monitorConfig)} 配置已保存。`,
  });
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
    recordSwitchOutcome("error", monitorId, targetId, error.message);
    saveState(state);
    void refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, error.message);
    }

    throw error;
  }

  const runtimeStatus = await getMonitorStatus(monitorContext);
  if (runtimeStatus.visible === false) {
    const error = new Error(
      `${getMonitorDisplayTitle(monitorContext)} 当前不在本机桌面里，不能从这台机器直接切换。`
    );
    recordSwitchOutcome("error", monitorId, targetId, error.message);
    saveState(state);
    void refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, error.message);
    }

    throw error;
  }

  try {
    let switchResult = null;
    if (process.platform === "win32") {
      switchResult = await switchOnWindowsForContext(monitorContext, targetId, target);
    } else if (process.platform === "darwin") {
      switchResult = await switchOnMacForContext(monitorContext, targetId, target);
    } else {
      throw new Error(`当前平台不受支持：${process.platform}`);
    }

    const successMessages = getSwitchSuccessMessages(monitorContext, target, switchResult);
    persistSuccessfulLocalSwitch(monitorContext, targetId, successMessages.outcomeMessage);
    if (notifyOnSuccess) {
      notify(successMessages.notificationMessage);
    }
  } catch (error) {
    const userFacingError = formatMonitorSwitchError(monitorContext, targetId, error);
    recordSwitchOutcome("error", monitorId, targetId, userFacingError.message);
    saveState(state);
    void refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, userFacingError.message);
    }

    throw userFacingError;
  }
}

async function switchOnWindowsForContext(monitorContext, targetId, target) {
  const monitorConfig = monitorContext.monitor;
  const switchingToLocalInterface = isLocalInterfaceTarget(targetId, monitorConfig);
  const topologyDisplays = await getWindowsTopologyDisplays();
  const attachedTopologyDisplayCount = topologyDisplays.filter((display) => display.attached).length;
  if (!isWindowsMonitorAttachedInTopology(topologyDisplays, monitorContext)) {
    throw new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 当前不在 Windows 桌面里，Windows 这侧不能直接控制它。`
    );
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const selectorArgs = getWindowsMonitorSelectorArgs(monitorContext);
  const candidates = getInputCandidates(target, monitorConfig);
  const expectedValues = getExpectedProbeInputValues(target.inputValue);
  const attachedDisplayCountBeforeSwitch = await getCurrentWindowsAttachedDisplayCount();
  let verificationStatus = "unconfirmed";

  await runCandidateSequence(candidates, async (candidate) => {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...selectorArgs,
      "-InputValue",
      String(candidate),
    ]);
    const verificationResult = await verifyWindowsSwitchOutcomeForContext(
      monitorContext,
      target,
      expectedValues
    );
    if (verificationResult.status === "mismatch") {
      throw new Error(verificationResult.message);
    }

    verificationStatus = verificationResult.status;
  });

  if (
    verificationStatus === "confirmed" &&
    !switchingToLocalInterface &&
    shouldUseWindowsDisplayHandoffForMonitor(monitorConfig, attachedTopologyDisplayCount)
  ) {
    await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
    await detachWindowsDisplayForMonitor(monitorConfig, attachedDisplayCountBeforeSwitch);
  } else if (switchingToLocalInterface) {
    clearMonitorPendingRestore(monitorConfig.id);
  }

  return {
    verificationStatus,
  };
}

async function switchOnMacForContext(monitorContext, targetId, target) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  const candidates = getInputCandidates(target, monitorContext.monitor);
  let verificationStatus = "confirmed";

  await runCandidateSequence(candidates, async (candidate) => {
    const output = await runCommand("/bin/sh", [scriptPath, String(candidate)], {
      env: getMacSwitchScriptEnvForContext(monitorContext),
    });
    verificationStatus = /\bUNCONFIRMED\b/u.test(output) ? "unconfirmed" : "confirmed";
  });

  return {
    verificationStatus,
  };
}

function formatMonitorSwitchError(monitorContext, targetId, error) {
  const rawMessage = normalizeText(error?.message);
  const target = getTarget(targetId, monitorContext.monitor);
  if (!rawMessage) {
    return new Error(`${getMonitorDisplayTitle(monitorContext)} 切换失败。`);
  }

  if (/^No monitor matched GDI device /i.test(rawMessage)) {
    return new Error(`${getMonitorDisplayTitle(monitorContext)} 当前不在本机可控列表里。`);
  }

  if (/^No physical monitor handles were found /i.test(rawMessage)) {
    return new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 已被系统识别，但没有拿到可控的物理显示器句柄。请确认这块屏支持 DDC/CI，并且菜单里已经开启 DDC/CI。`
    );
  }

  if (/^Setting VCP 0x60 to value /i.test(rawMessage)) {
    return new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 拒绝了这个输入值。请检查 ${target.label} 的输入值配置。`
    );
  }

  if (/未匹配目标值集合/u.test(rawMessage)) {
    return new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 没有真正切到 ${target.label}。通常是输入值填错，或者目标接口当前没有稳定信号。`
    );
  }

  if (/^Failed\.?$/i.test(rawMessage)) {
    return new Error(`${getMonitorDisplayTitle(monitorContext)} 的底层工具只返回了 “Failed.”。`);
  }

  return new Error(rawMessage);
}

async function verifyWindowsSwitchOutcomeForContext(monitorContext, target, expectedValues) {
  const startedAt = Date.now();
  let lastObservedValue = null;
  let lastErrorMessage = "";

  while (Date.now() - startedAt < 4000) {
    const currentInputResult = await getWindowsCurrentInputResultForContext(monitorContext);
    if (currentInputResult.ok) {
      if (expectedValues.includes(currentInputResult.value)) {
        return {
          status: "confirmed",
          message: "",
        };
      }

      lastObservedValue = currentInputResult.value;
      lastErrorMessage = "";
    } else {
      lastErrorMessage = currentInputResult.error;
    }

    await delay(250);
  }

  if (Number.isInteger(lastObservedValue)) {
    return {
      status: "mismatch",
      message: `${getMonitorDisplayTitle(
        monitorContext
      )} 当前输入仍是 ${lastObservedValue}，未匹配目标值集合：${expectedValues.join(" ")}`,
    };
  }

  return {
    status: "unconfirmed",
    message:
      lastErrorMessage ||
      `${getMonitorDisplayTitle(monitorContext)} 已发送切换命令，但当前显示器没有提供可靠的输入回读。`,
  };
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
    const currentInputValue = Number.isInteger(parsed?.currentInputValue)
      ? parsed.currentInputValue
      : NaN;

    if (!Number.isInteger(currentInputValue)) {
      throw new Error(`无法从读取结果里解析当前输入值：${output}`);
    }

    return {
      ok: true,
      value: currentInputValue,
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

function getMacSwitchScriptEnvForContext(monitorContext) {
  const env = {
    DISPLAY_NAME: getMonitorDisplayName(monitorContext),
    DISPLAY_INDEX: String(monitorContext.display.index),
  };

  if (Number.isInteger(monitorContext.display.electronDisplayId)) {
    env.DISPLAY_ID = String(monitorContext.display.electronDisplayId);
  }

  return env;
}

function parseMacInputValueOutput(output) {
  const normalized = normalizeText(output);
  return /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : NaN;
}

function getWindowsMonitorSelectorArgs(monitorContextOrConfig) {
  const gdiDeviceName = normalizeText(
    monitorContextOrConfig?.display?.gdiDeviceName ||
      monitorContextOrConfig?.match?.gdiDeviceName
  );
  if (gdiDeviceName) {
    return ["-GdiDeviceName", gdiDeviceName];
  }

  const fallbackName = getMonitorDisplayName(monitorContextOrConfig);
  if (fallbackName) {
    return ["-MonitorName", fallbackName];
  }

  throw new Error("Windows 当前没有这块屏幕的可用设备标识。");
}

function getWindowsTopologySelectorValue(monitorContextOrConfig) {
  const gdiDeviceName = normalizeText(
    monitorContextOrConfig?.display?.gdiDeviceName ||
      monitorContextOrConfig?.match?.gdiDeviceName
  );
  return gdiDeviceName || getMonitorDisplayName(monitorContextOrConfig);
}

async function detachWindowsDisplayForMonitor(monitorConfig, expectedAttachedDisplayCount) {
  await runWindowsTopologyCommand([
    "-MonitorName",
    getWindowsTopologySelectorValue(monitorConfig),
    "-DetachMonitor",
  ]);
  await waitForWindowsMonitorAttachmentState(
    monitorConfig,
    false,
    "Windows 没有把这块屏从桌面拓扑里移除。"
  );
  markMonitorPendingRestore(monitorConfig.id, expectedAttachedDisplayCount);
}

async function attachWindowsDisplayForMonitor(monitorConfig, expectedAttachedDisplayCount) {
  await runWindowsTopologyCommand([
    "-MonitorName",
    getWindowsTopologySelectorValue(monitorConfig),
    "-AttachMonitor",
  ]);
  await waitForWindowsMonitorAttachmentState(
    monitorConfig,
    true,
    "Windows 没有把这块屏重新加回桌面拓扑。"
  );

  if (Number.isInteger(expectedAttachedDisplayCount) && expectedAttachedDisplayCount > 1) {
    await waitForDisplayCount(expectedAttachedDisplayCount, "Windows 没有恢复到预期的屏幕数量。");
  }
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

function shouldUseWindowsDisplayHandoffForMonitor(monitorConfig, attachedDisplayCount = null) {
  if (process.platform !== "win32") {
    return false;
  }

  if (monitorConfig.windowsDisplayHandoffMode === "off") {
    return false;
  }

  if (monitorConfig.windowsDisplayHandoffMode === "external") {
    return true;
  }

  if (Number.isInteger(attachedDisplayCount)) {
    return attachedDisplayCount >= 2;
  }

  return getConnectedDisplayCount() >= 2;
}

async function refreshWindowsDisplayState({ monitorId = null, notifyOnSuccess = false } = {}) {
  if (process.platform !== "win32") {
    return {
      changed: false,
      message: "当前平台不是 Windows。",
    };
  }

  const changed = await attemptPendingWindowsRestores(monitorId);
  const message = changed ? "Windows 已刷新并处理等待接回的屏幕。" : "Windows 已刷新当前屏幕状态。";

  if (notifyOnSuccess) {
    notify(message);
  }

  return {
    changed,
    message,
  };
}

async function attemptPendingWindowsRestores(targetMonitorId = null) {
  if (process.platform !== "win32" || windowsRestoreInFlight) {
    return false;
  }

  windowsRestoreInFlight = true;

  try {
    await syncMonitorConfigsFromLocalDisplays({ persist: false });
    const topologyDisplays = await getWindowsTopologyDisplays();
    let changed = false;

    for (const monitorConfig of getStoredMonitorConfigs()) {
      if (targetMonitorId && monitorConfig.id !== targetMonitorId) {
        continue;
      }

      const runtime = getMonitorDesktopRuntime(monitorConfig.id);
      if (!runtime.pendingRestore) {
        continue;
      }

      const topologyDisplay = topologyDisplays.find((display) =>
        isTopologyDisplayMatchMonitor(display, monitorConfig)
      );
      if (!topologyDisplay) {
        continue;
      }

      if (!topologyDisplay.attached) {
        try {
          await attachWindowsDisplayForMonitor(
            monitorConfig,
            runtime.expectedAttachedDisplayCount || null
          );
        } catch (error) {
          appendDiagnosticLog("Failed to attach Windows display back into topology", error);
          continue;
        }
      }

      clearMonitorPendingRestore(monitorConfig.id);
      changed = true;
    }

    if (changed) {
      void refreshMenu();
    }

    return changed;
  } finally {
    windowsRestoreInFlight = false;
  }
}

function startWindowsRestoreWatcher() {
  if (process.platform !== "win32") {
    return;
  }

  const scheduleAttempt = () => {
    void syncMonitorConfigsFromLocalDisplays({ persist: false });
    void attemptPendingWindowsRestores();
    scheduleTrayRebuild("display-change");
  };

  screen.on("display-added", scheduleAttempt);
  screen.on("display-removed", scheduleAttempt);

  windowsRestoreTimer = setInterval(() => {
    void attemptPendingWindowsRestores();
  }, 2500);
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

  if (explorerSignature && explorerSignature !== nextExplorerSignature) {
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

async function buildMonitorContextsWithStatus() {
  const monitorContexts = await getConnectedMonitorContexts();
  return Promise.all(
    monitorContexts.map(async (monitorContext) => ({
      ...monitorContext,
      status: await getMonitorStatus(monitorContext),
    }))
  );
}

async function getMonitorStatus(monitorContext) {
  if (process.platform === "win32") {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const visible = isWindowsMonitorAttachedInTopology(topologyDisplays, monitorContext);
    if (!visible) {
      return {
        visible: false,
        currentInputValue: null,
        currentInputError: null,
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

async function getConnectedMonitorContexts() {
  const displaySummaries = await syncMonitorConfigsFromLocalDisplays({ persist: true });
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

async function getMonitorContextById(monitorId) {
  const monitorContexts = await getConnectedMonitorContexts();
  return monitorContexts.find((monitorContext) => monitorContext.id === normalizeText(monitorId)) || null;
}

async function syncMonitorConfigsFromLocalDisplays({ persist = true } = {}) {
  const displaySummaries = await getLocalDisplaySummaries();
  const storedMonitorConfigs = getStoredMonitorConfigs();
  const unmatchedStoredMonitorConfigs = storedMonitorConfigs.filter(
    (monitorConfig) => normalizeText(monitorConfig.displayKey)
  );
  const legacyMonitorConfig =
    storedMonitorConfigs.length === 1 && !normalizeText(storedMonitorConfigs[0].displayKey)
      ? storedMonitorConfigs[0]
      : null;
  let legacyMonitorConfigConsumed = false;
  const usedMonitorIds = new Set();
  const nextMonitorConfigs = [];

  for (const displaySummary of displaySummaries) {
    const matchingMonitorConfig =
      unmatchedStoredMonitorConfigs.find((monitorConfig) => {
        if (usedMonitorIds.has(monitorConfig.id)) {
          return false;
        }

        return (
          normalizeText(monitorConfig.displayKey) === displaySummary.displayKey ||
          (displaySummary.gdiDeviceName &&
            normalizeText(monitorConfig.match?.gdiDeviceName) === displaySummary.gdiDeviceName) ||
          (Number.isInteger(displaySummary.electronDisplayId) &&
            monitorConfig.match?.electronDisplayId === displaySummary.electronDisplayId)
        );
      }) ||
      (!legacyMonitorConfigConsumed && legacyMonitorConfig ? legacyMonitorConfig : null);

    if (matchingMonitorConfig === legacyMonitorConfig) {
      legacyMonitorConfigConsumed = true;
    }

    const nextMonitorConfig = normalizeMonitorConfig(
      {
        ...matchingMonitorConfig,
        id: displaySummary.id,
        displayKey: displaySummary.displayKey,
        roleLabel: displaySummary.roleLabel,
        displayName: displaySummary.detectedName,
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

  for (const storedMonitorConfig of unmatchedStoredMonitorConfigs) {
    if (usedMonitorIds.has(storedMonitorConfig.id)) {
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

async function getLocalDisplaySummaries() {
  const orderedDisplays = getOrderedLocalDisplays();
  if (process.platform === "win32") {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const attachedTopologyDisplays = topologyDisplays
      .filter((display) => display.attached)
      .sort(compareDisplayLikeObjects);
    const switchableTopologyDisplays = attachedTopologyDisplays
      .map((topologyDisplay) => ({
        topologyDisplay,
        electronDisplay: matchElectronDisplayToWindowsTopologyDisplay(
          topologyDisplay,
          orderedDisplays,
          attachedTopologyDisplays
        ),
      }))
      .filter(({ electronDisplay }) => !electronDisplay?.internal);
    let secondaryIndex = 2;
    const singleDisplayOnly = switchableTopologyDisplays.length <= 1;

    return switchableTopologyDisplays.map(({ topologyDisplay, electronDisplay }, index) => {
      const roleLabel = singleDisplayOnly
        ? "当前机器屏幕"
        : topologyDisplay.primary
          ? "主屏幕"
          : `附屏幕 ${secondaryIndex++}`;
      const displayKey = buildDisplayKeyForLocalDisplay(
        electronDisplay || {
          id: null,
          bounds: {
            x: topologyDisplay.positionX,
            y: topologyDisplay.positionY,
            width: topologyDisplay.width,
            height: topologyDisplay.height,
          },
        },
        index + 1,
        topologyDisplay
      );
      const detectedName = normalizeText(
        topologyDisplay.friendlyName || topologyDisplay.displayName || topologyDisplay.deviceString || ""
      );

      return {
        id: createMonitorId(displayKey),
        displayKey,
        index: index + 1,
        roleLabel,
        detectedName,
        resolution: `${topologyDisplay.width} × ${topologyDisplay.height}`,
        position: `${topologyDisplay.positionX}, ${topologyDisplay.positionY}`,
        internal: Boolean(electronDisplay?.internal),
        electronDisplayId: Number.isInteger(electronDisplay?.id) ? electronDisplay.id : null,
        gdiDeviceName: normalizeText(topologyDisplay.deviceName),
        productCode: normalizeText(topologyDisplay.productCode),
        bounds: {
          x: topologyDisplay.positionX,
          y: topologyDisplay.positionY,
          width: topologyDisplay.width,
          height: topologyDisplay.height,
        },
      };
    });
  }

  const externalDisplays = orderedDisplays.filter((display) => !display.internal);
  let secondaryIndex = 2;
  const singleDisplayOnly = externalDisplays.length <= 1;

  return externalDisplays.map((display, index) => {
    const roleLabel = singleDisplayOnly
      ? "当前机器屏幕"
      : display.primary
        ? "主屏幕"
        : `附屏幕 ${secondaryIndex++}`;
    const displayKey = buildDisplayKeyForLocalDisplay(display, index + 1, null);
    const detectedName = normalizeText(display.label || "");

    return {
      id: createMonitorId(displayKey),
      displayKey,
      index: index + 1,
      roleLabel,
      detectedName,
      resolution: `${display.bounds.width} × ${display.bounds.height}`,
      position: `${display.bounds.x}, ${display.bounds.y}`,
      internal: Boolean(display.internal),
      electronDisplayId: Number.isInteger(display.id) ? display.id : null,
      gdiDeviceName: "",
      productCode: "",
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
    };
  });
}

function getOrderedLocalDisplays() {
  try {
    return [...screen.getAllDisplays()].sort(compareDisplayLikeObjects);
  } catch {
    return [];
  }
}

function getConnectedDisplayCount() {
  return getOrderedLocalDisplays().length;
}

function buildDisplayKeyForLocalDisplay(display, displayIndex, topologyDisplay = null) {
  if (process.platform === "win32") {
    const gdiDeviceName = normalizeText(topologyDisplay?.deviceName);
    if (gdiDeviceName) {
      return `win:${gdiDeviceName}`;
    }

    if (Number.isInteger(display?.id)) {
      return `win-electron:${display.id}`;
    }
  }

  if (process.platform === "darwin" && Number.isInteger(display?.id)) {
    return `mac:${display.id}`;
  }

  return `fallback:${displayIndex}:${display?.bounds?.x || 0}:${display?.bounds?.y || 0}:${
    display?.bounds?.width || 0
  }x${display?.bounds?.height || 0}`;
}

function createMonitorId(displayKey) {
  const normalizedKey = normalizeText(displayKey) || crypto.randomBytes(6).toString("hex");
  return `monitor-${crypto.createHash("sha1").update(normalizedKey).digest("hex").slice(0, 12)}`;
}

async function getWindowsTopologyDisplays() {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const output = await runWindowsTopologyCommand(["-Summary"]);
    const parsed = JSON.parse(output);
    const displays = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return displays.map(normalizeWindowsTopologyDisplay).filter(Boolean);
  } catch (error) {
    appendDiagnosticLog("Failed to read Windows topology", error);
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

function matchElectronDisplayToWindowsTopologyDisplay(
  topologyDisplay,
  orderedDisplays,
  attachedTopologyDisplays
) {
  if (!topologyDisplay || !Array.isArray(orderedDisplays) || orderedDisplays.length === 0) {
    return null;
  }

  const exactMatch =
    orderedDisplays.find(
      (display) =>
        topologyDisplay.width === display.bounds.width &&
        topologyDisplay.height === display.bounds.height &&
        topologyDisplay.positionX === display.bounds.x &&
        topologyDisplay.positionY === display.bounds.y
    ) || null;

  if (exactMatch) {
    return exactMatch;
  }

  if (
    !Array.isArray(attachedTopologyDisplays) ||
    orderedDisplays.length !== attachedTopologyDisplays.length
  ) {
    return null;
  }

  const topologyDisplayIndex = attachedTopologyDisplays.findIndex(
    (candidateDisplay) =>
      normalizeText(candidateDisplay.deviceName) &&
      normalizeText(candidateDisplay.deviceName) === normalizeText(topologyDisplay.deviceName)
  );
  if (topologyDisplayIndex < 0) {
    return null;
  }

  return orderedDisplays[topologyDisplayIndex] || null;
}

function isTopologyDisplayMatchMonitor(topologyDisplay, monitorContextOrConfig) {
  const gdiDeviceName = normalizeText(
    monitorContextOrConfig?.display?.gdiDeviceName ||
      monitorContextOrConfig?.match?.gdiDeviceName
  );
  if (gdiDeviceName) {
    return normalizeText(topologyDisplay?.deviceName).toLowerCase() === gdiDeviceName.toLowerCase();
  }

  const displayName = getMonitorDisplayName(monitorContextOrConfig).toLowerCase();
  return [topologyDisplay?.displayName, topologyDisplay?.friendlyName, topologyDisplay?.deviceString]
    .map((value) => normalizeText(value).toLowerCase())
    .includes(displayName);
}

function isWindowsMonitorAttachedInTopology(topologyDisplays, monitorContextOrConfig) {
  return Array.isArray(topologyDisplays)
    ? topologyDisplays.some(
        (topologyDisplay) =>
          topologyDisplay.attached && isTopologyDisplayMatchMonitor(topologyDisplay, monitorContextOrConfig)
      )
    : false;
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

async function getCurrentWindowsAttachedDisplayCount() {
  const topologyDisplays = await getWindowsTopologyDisplays();
  const attachedCount = topologyDisplays.filter((display) => display.attached).length;
  return attachedCount > 0 ? attachedCount : null;
}

async function waitForDisplayCount(expectedCount, errorMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8000) {
    const attachedCount = await getCurrentWindowsAttachedDisplayCount();
    if (!Number.isInteger(expectedCount) || attachedCount === expectedCount) {
      return;
    }

    await delay(250);
  }

  throw new Error(errorMessage);
}

function renderSettingsPage(requestUrl, monitorContexts) {
  const status = requestUrl.searchParams.get("status");
  const message = requestUrl.searchParams.get("message");
  const statusHtml = renderSettingsBanner(status, message);
  const globalRefreshHtml =
    process.platform === "win32"
      ? `<div class="card soft">
          <div class="section-title">Windows 主动刷新</div>
          <div class="help" style="margin-top: 12px;">如果某块屏已经切回 Windows，但系统还没把它重新加回桌面，可以手动触发一次全局刷新。</div>
          <form method="post" action="/api/${encodeURIComponent(
            state.controlToken
          )}/windows/refresh" style="margin-top: 16px;">
            <button type="submit" class="secondary">主动刷新全部等待接回的 Windows 屏幕</button>
          </form>
        </div>`
      : "";
  const contentHtml =
    monitorContexts.length === 0
      ? `<div class="card soft">
          <div class="section-title">当前没有本机已连接屏幕</div>
          <div class="help" style="margin-top: 12px;">识别到几块本机屏幕就显示几块。当前这台机器没有读到可展示的本机屏幕。</div>
        </div>`
      : monitorContexts.map(renderMonitorSection).join("");

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
    <p>这里只按“当前主机直接控制当前主机已连接的物理屏”工作。识别到几块本机屏幕，就展示几块。</p>
    <div class="stack">
      ${statusHtml}
      ${globalRefreshHtml}
      ${contentHtml}
    </div>
  </main>
</body>
</html>`;
}

function renderMonitorSection(monitorContext) {
  const runtime = getMonitorDesktopRuntime(monitorContext.id);
  const refreshHtml =
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
      ${escapeHtml(getMonitorSystemIdentityText(monitorContext))}<br>
      分辨率：${escapeHtml(monitorContext.display.resolution)}<br>
      位置：${escapeHtml(monitorContext.display.position)}<br>
      当前机器接口：${escapeHtml(
        getTarget(getLocalInterfaceId(monitorContext.monitor), monitorContext.monitor).label
      )}
    </div>
    ${
      runtime.pendingRestore
        ? `<div class="banner success" style="margin-top: 12px;">这块屏已经标记为“等待接回”。Windows 会持续尝试把它重新加回桌面。</div>`
        : ""
    }
    <div class="interface-grid">
      ${TARGET_IDS.map((targetId) => renderInterfaceStatusCard(monitorContext, targetId)).join("")}
    </div>
    ${renderMonitorConfigForm(monitorContext)}
    ${refreshHtml}
  </div>`;
}

function renderInterfaceStatusCard(monitorContext, targetId) {
  const target = getTarget(targetId, monitorContext.monitor);
  const currentInputValue = Number.isInteger(monitorContext.status.currentInputValue)
    ? monitorContext.status.currentInputValue
    : null;
  const isCurrent = Number.isInteger(currentInputValue)
    ? getExpectedProbeInputValues(target.inputValue).includes(currentInputValue)
    : false;
  const directSwitchEnabled = monitorContext.status.visible !== false;

  let statusText = "连接状态未知";
  let detailText = "未激活接口是否真的接了机器，DDC/CI 不能无损读出来。";
  if (!monitorContext.status.visible) {
    statusText = "当前不在本机";
    detailText = "这块屏当前不在本机桌面里，所以本机无法直接读取它的当前输入。";
  } else if (isCurrent) {
    statusText = "当前正在显示";
    detailText = `当前输入回报：${describeInputValue(currentInputValue)}。`;
  } else if (Number.isInteger(currentInputValue)) {
    statusText = "当前未显示";
    detailText = `当前输入回报：${describeInputValue(currentInputValue)}。`;
  } else if (monitorContext.status.currentInputError) {
    statusText = "读取失败";
    detailText = monitorContext.status.currentInputError;
  }

  return `<div class="interface-card${isCurrent ? " current" : ""}">
    <div class="section-title">${escapeHtml(target.label)}</div>
    <div class="status-pill ${escapeHtml(isCurrent ? "success" : "neutral")}">${escapeHtml(statusText)}</div>
    <div class="display-meta">
      输入值：${escapeHtml(String(target.inputValue))}<br>
      ${escapeHtml(detailText)}
    </div>
    <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/switch/${encodeURIComponent(
      monitorContext.id
    )}/${encodeURIComponent(targetId)}" style="margin-top: 14px;">
      <button type="submit"${directSwitchEnabled ? "" : " disabled"}>
        ${
          directSwitchEnabled
            ? `直接切到 ${escapeHtml(getSwitchActionLabel(targetId, monitorContext.monitor))}`
            : "当前不可从本机直接切换"
        }
      </button>
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
        ? `<label>
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
    <div class="interface-grid">
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
    <div class="help" style="margin-top: 10px;">
      ${COMMON_INPUT_VALUES.map((item) => escapeHtml(item.label)).join(" / ")}
    </div>
    <button type="submit" style="margin-top: 16px;">保存这块屏幕配置</button>
  </form>`;
}

function renderSettingsBanner(status, message) {
  if (!status || !message) {
    return "";
  }

  const tone = status === "success" ? "success" : "error";
  return `<div class="banner ${escapeHtml(tone)}">${escapeHtml(message)}</div>`;
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
    .stack {
      display: grid;
      gap: 14px;
      margin-top: 24px;
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
    @media (max-width: 640px) {
      main {
        padding: 22px;
      }
    }
  `;
}

function getMonitorSystemIdentityText(monitorContext) {
  if (process.platform === "win32") {
    return normalizeText(monitorContext.display.gdiDeviceName)
      ? `Windows DeviceName：${monitorContext.display.gdiDeviceName}`
      : "Windows DeviceName：未知";
  }

  return Number.isInteger(monitorContext.display.electronDisplayId)
    ? `Display ID：${monitorContext.display.electronDisplayId}`
    : "Display ID：未知";
}

function getMonitorDisplayTitle(monitorContextOrConfig) {
  const roleLabel = normalizeText(
    monitorContextOrConfig?.display?.roleLabel || monitorContextOrConfig?.roleLabel
  );
  const displayName = getMonitorDisplayName(monitorContextOrConfig);
  return displayName ? `${roleLabel} · ${displayName}` : roleLabel || "本机屏幕";
}

function getMonitorDisplayName(monitorContextOrConfig) {
  return normalizeText(
    monitorContextOrConfig?.display?.detectedName || monitorContextOrConfig?.displayName
  );
}

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

function createDefaultInterfacesConfig() {
  const interfaces = {};
  for (const slot of TARGET_SLOTS) {
    interfaces[slot.id] = {
      inputValue: slot.defaultInputValue,
    };
  }
  return interfaces;
}

function createDefaultMonitorConfig(partial = {}) {
  return {
    id: normalizeText(partial.id) || createMonitorId(normalizeText(partial.displayKey)),
    displayKey: normalizeText(partial.displayKey),
    roleLabel: normalizeText(partial.roleLabel) || "当前机器屏幕",
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

function buildMonitorConfigFromForm(form, existingMonitorConfig) {
  const monitorConfig = normalizeMonitorConfig(
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
    monitorConfig,
    errors: getMonitorConfigValidationErrors(monitorConfig),
  };
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

function getStoredMonitorConfigs() {
  return Array.isArray(state.config?.monitors) ? state.config.monitors : [];
}

function getTarget(targetId, monitorConfig = null) {
  const slot = TARGET_SLOT_MAP.get(targetId);
  const configuredTarget = monitorConfig?.interfaces?.[targetId] || {};
  return {
    id: targetId,
    label: slot?.title || targetId,
    inputValue: Number.isInteger(configuredTarget.inputValue)
      ? configuredTarget.inputValue
      : slot?.defaultInputValue,
  };
}

function getTargetSlotName(targetId) {
  return TARGET_SLOT_MAP.get(targetId)?.title || "接口";
}

function getLocalInterfaceId(monitorConfig) {
  return parseTargetId(monitorConfig?.localInterfaceId) || TARGET_IDS[0];
}

function isLocalInterfaceTarget(targetId, monitorConfig) {
  return parseTargetId(targetId) === getLocalInterfaceId(monitorConfig);
}

function getSwitchActionLabel(targetId, monitorConfig) {
  const target = getTarget(targetId, monitorConfig);
  return isLocalInterfaceTarget(targetId, monitorConfig)
    ? `${target.label}（当前机器接口）`
    : target.label;
}

function shouldUseSamsungMstarCompat(monitorConfig) {
  if (monitorConfig?.compatibilityMode === "samsung_mstar") {
    return true;
  }

  if (monitorConfig?.compatibilityMode === "off") {
    return false;
  }

  return /\b(g7|odyssey|samsung)\b/i.test(getMonitorDisplayName(monitorConfig));
}

function getInputCandidates(target, monitorConfig) {
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

function getExpectedProbeInputValues(inputValue) {
  const candidates = [inputValue];
  for (const candidate of getSamsungMstarCandidates(inputValue)) {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
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

function createDefaultState() {
  return {
    controlToken: crypto.randomBytes(12).toString("hex"),
    lastTarget: "",
    windowsDesktop: {
      byMonitorId: {},
    },
    lastSwitchOutcome: createSwitchOutcome(),
    config: {
      monitors: [],
    },
  };
}

function createSwitchOutcome({
  status = "idle",
  monitorId = "",
  targetId = "",
  message = "",
  updatedAt = null,
} = {}) {
  return {
    status: ["idle", "success", "error"].includes(status) ? status : "idle",
    monitorId: normalizeText(monitorId),
    targetId: parseTargetId(targetId),
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

function getSwitchSuccessMessages(monitorContext, target, switchResult = null) {
  if (switchResult?.verificationStatus === "unconfirmed") {
    return {
      outcomeMessage: `${getMonitorDisplayTitle(
        monitorContext
      )} 已发送切换命令：${target.label}。当前显示器未提供可靠回读，结果待人工确认。`,
      notificationMessage: `${getMonitorDisplayTitle(
        monitorContext
      )} 已发送切换命令到 ${target.label}，当前无法可靠确认结果。`,
    };
  }

  return {
    outcomeMessage: `${getMonitorDisplayTitle(monitorContext)} 已执行切换：${target.label}。`,
    notificationMessage: `${getMonitorDisplayTitle(monitorContext)} 已切到 ${target.label}。`,
  };
}

function persistSuccessfulLocalSwitch(monitorContext, targetId, outcomeMessage) {
  state.lastTarget = `${monitorContext.id}:${targetId}`;
  recordSwitchOutcome("success", monitorContext.id, targetId, outcomeMessage);
  saveState(state);
  void refreshMenu();
}

function getMonitorDesktopRuntime(monitorId) {
  const normalizedId = normalizeText(monitorId);
  if (!state.windowsDesktop || typeof state.windowsDesktop !== "object") {
    state.windowsDesktop = {
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

function markMonitorPendingRestore(monitorId, expectedAttachedDisplayCount = null) {
  const runtime = getMonitorDesktopRuntime(monitorId);
  runtime.pendingRestore = true;
  runtime.expectedAttachedDisplayCount =
    Number.isInteger(expectedAttachedDisplayCount) && expectedAttachedDisplayCount > 1
      ? expectedAttachedDisplayCount
      : 0;
  saveState(state);
  void refreshMenu();
}

function clearMonitorPendingRestore(monitorId) {
  const runtime = getMonitorDesktopRuntime(monitorId);
  if (!runtime.pendingRestore && runtime.expectedAttachedDisplayCount === 0) {
    return;
  }

  runtime.pendingRestore = false;
  runtime.expectedAttachedDisplayCount = 0;
  saveState(state);
  void refreshMenu();
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
  const legacyMonitorConfig =
    rawConfig && (rawConfig.interfaces || rawConfig.localInterfaceId || rawConfig.compatibilityMode)
      ? createDefaultMonitorConfig({
          localInterfaceId: parseTargetId(rawConfig.localInterfaceId) || TARGET_IDS[0],
          compatibilityMode: parseCompatibilityMode(rawConfig.compatibilityMode),
          windowsDisplayHandoffMode: parseWindowsDisplayHandoffMode(
            rawConfig.windowsDisplayHandoffMode
          ),
          interfaces: cloneInterfacesConfig(rawConfig.interfaces),
        })
      : null;
  const normalizedMonitorConfigs = Array.isArray(rawConfig.monitors)
    ? rawConfig.monitors
        .filter(Boolean)
        .map((monitorConfig) => normalizeMonitorConfig(monitorConfig))
        .filter((monitorConfig) => normalizeText(monitorConfig.displayKey))
    : legacyMonitorConfig
      ? [legacyMonitorConfig]
      : [];

  return {
    controlToken: normalizeText(nextState.controlToken) || defaults.controlToken,
    lastTarget: normalizeText(nextState.lastTarget),
    windowsDesktop: {
      byMonitorId: normalizeWindowsDesktopRuntime(nextState.windowsDesktop?.byMonitorId),
    },
    lastSwitchOutcome: createSwitchOutcome(nextState.lastSwitchOutcome),
    config: {
      monitors: normalizedMonitorConfigs,
    },
  };
}

function normalizeWindowsDesktopRuntime(rawRuntimeMap) {
  const nextRuntimeMap = {};
  if (!rawRuntimeMap || typeof rawRuntimeMap !== "object") {
    return nextRuntimeMap;
  }

  for (const [monitorId, runtime] of Object.entries(rawRuntimeMap)) {
    const normalizedId = normalizeText(monitorId);
    if (!normalizedId) {
      continue;
    }

    nextRuntimeMap[normalizedId] = {
      pendingRestore: Boolean(runtime?.pendingRestore),
      expectedAttachedDisplayCount: normalizePositiveInteger(
        runtime?.expectedAttachedDisplayCount,
        0
      ),
    };
  }

  return nextRuntimeMap;
}

function compareDisplayLikeObjects(left, right) {
  if (Boolean(left?.primary) !== Boolean(right?.primary)) {
    return left?.primary ? -1 : 1;
  }

  const leftY = Number.isFinite(left?.bounds?.y) ? left.bounds.y : left?.positionY || 0;
  const rightY = Number.isFinite(right?.bounds?.y) ? right.bounds.y : right?.positionY || 0;
  if (leftY !== rightY) {
    return leftY - rightY;
  }

  const leftX = Number.isFinite(left?.bounds?.x) ? left.bounds.x : left?.positionX || 0;
  const rightX = Number.isFinite(right?.bounds?.x) ? right.bounds.x : right?.positionX || 0;
  return leftX - rightX;
}

function saveState(nextState) {
  const normalizedState = normalizeState(nextState);
  fs.mkdirSync(path.dirname(getStatePath()), { recursive: true });
  fs.writeFileSync(getStatePath(), JSON.stringify(normalizedState, null, 2));
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
    // Ignore logging failures.
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

function redirectToSettingsPage(response, requestUrl, query) {
  const nextUrl = new URL(getSettingsPath(), requestUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value) {
      nextUrl.searchParams.set(key, value);
    }
  }

  response.writeHead(303, {
    Location: `${nextUrl.pathname}${nextUrl.search}`,
    "Cache-Control": "no-store",
  });
  response.end();
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
      lastError = error;
    }

    if (index < candidates.length - 1) {
      await delay(300);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function describeInputValue(value) {
  const knownLabel = COMMON_INPUT_LABELS.get(value);
  return knownLabel ? `${knownLabel} (${value})` : `输入值 ${value}`;
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

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function parseInputValue(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function parseCompatibilityMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["auto", "off", "samsung_mstar"].includes(normalized) ? normalized : "auto";
}

function parseWindowsDisplayHandoffMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["auto", "off", "external"].includes(normalized) ? normalized : "auto";
}

function parseTargetId(value) {
  return TARGET_IDS.includes(value) ? value : null;
}

function renderNamedOption(value, label, selectedValue) {
  return `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function uninstallApp() {
  const response = dialog.showMessageBoxSync({
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
  });

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
  const script = `#!/bin/sh
APP_PATH='${shellEscape(appBundlePath)}'
sleep 2
/usr/bin/osascript <<APPLESCRIPT
set appPath to "${appleScriptEscape(appBundlePath)}"
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

function shellEscape(value) {
  return value.replace(/'/g, `'\"'\"'`);
}

function appleScriptEscape(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
