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
const MAC_DISPLAY_METADATA_CACHE_TTL_MS = 5000;
const DDC_PROBE_CACHE_TTL_MS = 10000;
const HELPER_COMMAND_TIMEOUT_MS = 15000;
const WINDOWS_TOPOLOGY_COMMAND_TIMEOUT_MS = 45000;
const WINDOWS_DDC_PROBE_TIMEOUT_MS = 8000;
const CURRENT_INPUT_COMMAND_TIMEOUT_MS = 5000;
const SYSTEM_PROFILER_COMMAND_TIMEOUT_MS = 45000;
const WINDOWS_TAKEOVER_SETTLE_MS = 45000;
const LOCAL_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
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
let windowsDuplicateDetachInFlight = false;
const windowsTakeoverInProgressMonitorIds = new Set();
const windowsTakeoverProtectedUntilByMonitorId = new Map();
let windowsTopologyOperationQueue = Promise.resolve();
let switchOperationQueue = Promise.resolve();
const switchInFlightByMonitorId = new Map();
let macDisplayMetadataCache = {
  fetchedAt: 0,
  displays: [],
};
let windowsDdcProbeCache = new Map();
let macDdcProbeCache = new Map();
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

  try {
    state = loadState();
  } catch (error) {
    appendDiagnosticLog("Failed to load state during startup", error);
    state = createDefaultState();
  }

  startControlServer();
  startDisplayChangeWatcher();
  startWindowsRestoreWatcher();
  startWindowsTrayWatcher();
  createTray();
  void refreshMenu();

  try {
    saveState(state);
  } catch (error) {
    appendDiagnosticLog("Failed to persist initial state during startup", error);
  }

  try {
    const displaySummaries = await syncMonitorConfigsFromLocalDisplays({ persist: true });
    if (process.platform === "win32") {
      await attemptPendingWindowsRestores({
        displaySummaries,
      });
      await attemptWindowsDuplicateForeignDisplayDetaches();
    }
  } catch (error) {
    appendDiagnosticLog("Failed to synchronize displays during startup", error);
    notify("显示器列表初始化失败，可打开设置页或稍后重试。");
  }

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

async function refreshMenu({ monitorContexts = null } = {}) {
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
    const nextMonitorContexts = Array.isArray(monitorContexts)
      ? monitorContexts
      : await buildMonitorContextsWithStatus();
    const windowsTakeoverContexts =
      process.platform === "win32"
        ? await getWindowsDetachedTakeoverContexts({
            connectedMonitorContexts: nextMonitorContexts,
            persistCandidates: true,
          })
        : [];
    const monitorMenuItems =
      nextMonitorContexts.length === 0
        ? [
            {
              label: "当前没有本机已连接的屏幕",
              enabled: false,
            },
          ]
        : nextMonitorContexts.map((monitorContext) => buildTrayMonitorItem(monitorContext));
    const windowsTakeoverMenuItems = buildTrayWindowsTakeoverMenuItems(windowsTakeoverContexts);

    const menu = Menu.buildFromTemplate([
      {
        label: `版本：v${app.getVersion()}`,
        enabled: false,
      },
      ...buildLastSwitchOutcomeMenuItems(),
      ...monitorMenuItems,
      ...(process.platform === "win32"
        ? [
            { type: "separator" },
            ...windowsTakeoverMenuItems,
            {
              label: "高级：修复 Windows 屏幕状态",
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
        label: "打开完整设置页",
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
      ? monitorContext.status.ddcAvailable === false
        ? "不可控"
        : "未知"
      : "当前不在本机";
  const runtime = getMonitorDesktopRuntime(monitorContext.id);
  const directSwitchEnabled = isMonitorDirectSwitchEnabled(monitorContext);
  const peerTargetId = getPreferredPeerTargetId(monitorContext.monitor);
  const peerTarget = peerTargetId ? getTarget(peerTargetId, monitorContext.monitor) : null;
  const ddcProbeNotice =
    monitorContext.status.ddcProbeStatus === "targetable-unconfirmed"
      ? "DDC 状态：目标可定位，结果需人工确认"
      : "";

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
      ...(ddcProbeNotice
        ? [
            {
              label: ddcProbeNotice,
              enabled: false,
            },
          ]
        : []),
      ...(runtime.pendingRestore
        ? [
            {
              label: "状态：等待接回 Windows 桌面",
              enabled: false,
            },
          ]
        : []),
      { type: "separator" },
      ...(peerTarget
        ? [
            {
              label: `交给${getPeerMachineLabel(peerTargetId)}（${peerTarget.label}）`,
              enabled: directSwitchEnabled,
              click: () => handleTrayDirectSwitch(monitorContext.id, peerTargetId),
            },
            { type: "separator" },
            {
              label: "高级：单独切换输入源",
              enabled: false,
            },
          ]
        : []),
      ...TARGET_IDS.map((targetId) => ({
        label: `直接切到 ${getSwitchActionLabel(targetId, monitorContext.monitor)}`,
        enabled: directSwitchEnabled,
        click: () => handleTrayDirectSwitch(monitorContext.id, targetId),
      })),
      ...(process.platform === "win32"
        ? [
            { type: "separator" },
            {
              label: "高级：修复这块 Windows 屏幕状态",
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

function buildTrayWindowsTakeoverMenuItems(windowsTakeoverContexts) {
  if (process.platform !== "win32") {
    return [];
  }

  if (!Array.isArray(windowsTakeoverContexts) || windowsTakeoverContexts.length === 0) {
    return [
      {
        label: "接回 Windows 的共享屏：当前没有可接回项",
        enabled: false,
      },
    ];
  }

  return [
    {
      label: "接回 Windows 的共享屏",
      submenu: windowsTakeoverContexts.map((monitorContext) => {
        const localTarget = getTarget(getLocalInterfaceId(monitorContext.monitor), monitorContext.monitor);
        return {
          label: `接回 ${getMonitorDisplayTitle(monitorContext)}（${localTarget.label}）`,
          click: () => handleTrayWindowsTakeover(monitorContext.id),
        };
      }),
    },
  ];
}

function handleTrayDirectSwitch(monitorId, targetId) {
  void switchMonitor(monitorId, targetId, {
    notifyOnSuccess: true,
    showErrorDialog: false,
  }).catch((error) => {
    appendDiagnosticLog(`Direct switch failed (${monitorId}:${targetId})`, error);
    void refreshMenu();
  });
}

function handleTrayWindowsTakeover(monitorId) {
  void takeoverWindowsDetachedMonitor(monitorId, {
    notifyOnSuccess: true,
    showErrorDialog: false,
  }).catch((error) => {
    appendDiagnosticLog(`Windows takeover failed (${monitorId})`, error);
    void refreshMenu();
  });
}

function buildLastSwitchOutcomeMenuItems() {
  const lastSwitchOutcome = createSwitchOutcome(state.lastSwitchOutcome);
  if (lastSwitchOutcome.status !== "error" || !lastSwitchOutcome.message) {
    return [];
  }

  return [
    {
      label: truncateMenuLabel(`最近失败：${lastSwitchOutcome.message}`),
      enabled: false,
    },
    { type: "separator" },
  ];
}

function truncateMenuLabel(value, maxLength = 96) {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function startControlServer() {
  controlServerError = null;
  activeControlPort = PREFERRED_CONTROL_PORT;
  controlServer = http.createServer((request, response) => {
    handleControlRequest(request, response).catch((error) => {
      if (shouldLogControlRequestError(error)) {
        appendDiagnosticLog("Control request failed", error);
      }
      if (response.headersSent) {
        response.end();
        return;
      }

      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
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

function shouldLogControlRequestError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  return statusCode >= 500;
}

async function handleControlRequest(request, response) {
  if (!isLoopbackRequest(request)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("仅允许本机访问设置与控制接口。");
    return;
  }

  const requestUrl = parseLocalRequestUrl(request);
  const switchPathMatch = new RegExp(`^/api/${state.controlToken}/switch/([^/]+)/([^/]+)$`).exec(
    requestUrl.pathname
  );
  const configPathMatch = new RegExp(`^/api/${state.controlToken}/config/([^/]+)$`).exec(
    requestUrl.pathname
  );
  const windowsRefreshPathMatch = new RegExp(
    `^/api/${state.controlToken}/windows/refresh(?:/([^/]+))?$`
  ).exec(requestUrl.pathname);
  const windowsTakeoverPathMatch = new RegExp(
    `^/api/${state.controlToken}/windows/takeover/([^/]+)$`
  ).exec(requestUrl.pathname);

  if (requestUrl.pathname === "/health") {
    return writeJson(response, 200, {
      ok: true,
      appName: APP_NAME,
      version: app.getVersion(),
      connectedMonitors: getHealthConnectedMonitorSummaries(),
      lastSwitchOutcome: state.lastSwitchOutcome,
      controlPort: getListeningPort(),
    });
  }

  if (requestUrl.pathname === getControlPath()) {
    return redirectToSettingsPage(response, requestUrl, {});
  }

  if (requestUrl.pathname === getSettingsPath()) {
    const monitorContexts = await buildMonitorContextsWithStatus();
    const windowsTakeoverContexts =
      process.platform === "win32"
        ? await getWindowsDetachedTakeoverContexts({
            connectedMonitorContexts: monitorContexts,
            persistCandidates: true,
          })
        : [];
    return writeHtml(
      response,
      200,
      renderSettingsPage(requestUrl, monitorContexts, windowsTakeoverContexts)
    );
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
      decodePathSegment(configPathMatch[1])
    );
  }

  if (switchPathMatch && request.method === "POST") {
    const monitorId = decodePathSegment(switchPathMatch[1]);
    const targetId = parseTargetId(decodePathSegment(switchPathMatch[2]));
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
      windowsRefreshPathMatch[1] ? decodePathSegment(windowsRefreshPathMatch[1]) : null
    );
  }

  if (windowsTakeoverPathMatch && request.method === "POST") {
    return handleWindowsTakeoverRequest(
      response,
      requestUrl,
      decodePathSegment(windowsTakeoverPathMatch[1])
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

function parseLocalRequestUrl(request) {
  try {
    return new URL(request.url || "/", `http://${LOOPBACK_HOST}:${getListeningPort()}`);
  } catch {
    throw createHttpError(400, "请求路径无效。");
  }
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw createHttpError(400, "请求路径编码无效。");
  }
}

async function handleSwitchRequest(response, requestUrl, monitorId, targetId) {
  try {
    const result = await switchMonitor(monitorId, targetId, {
      notifyOnSuccess: true,
      showErrorDialog: false,
    });
    redirectToSettingsPage(response, requestUrl, {
      status: "success",
      message: result?.outcomeMessage || "切换命令已发送，结果待确认。",
    });
  } catch (error) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: normalizeText(error.message) || "切换失败。",
    });
  }
}

async function handleConfigSave(request, response, requestUrl, monitorId) {
  assertFormUrlEncodedRequest(request);
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

async function handleWindowsTakeoverRequest(response, requestUrl, monitorId) {
  try {
    const result = await takeoverWindowsDetachedMonitor(normalizeText(monitorId), {
      notifyOnSuccess: false,
      showErrorDialog: false,
    });
    redirectToSettingsPage(response, requestUrl, {
      status: "success",
      message: result.message,
    });
  } catch (error) {
    redirectToSettingsPage(response, requestUrl, {
      status: "error",
      message: normalizeText(error.message) || "Windows 主动接管失败。",
    });
  }
}

async function switchMonitor(monitorId, targetId, options = {}) {
  const normalizedMonitorId = normalizeText(monitorId);
  const parsedTargetId = parseTargetId(targetId);
  const lockKey = normalizedMonitorId || `raw:${normalizeText(monitorId)}`;
  if (lockKey && switchInFlightByMonitorId.has(lockKey)) {
    throw new Error("这块屏幕正在执行切换，请等待当前命令完成。");
  }

  const switchTask = switchOperationQueue.then(
    () => switchMonitorUnlocked(normalizedMonitorId, parsedTargetId, options),
    () => switchMonitorUnlocked(normalizedMonitorId, parsedTargetId, options)
  );
  switchOperationQueue = switchTask.catch(() => {});
  if (lockKey) {
    switchInFlightByMonitorId.set(lockKey, switchTask);
  }

  try {
    return await switchTask;
  } finally {
    if (lockKey && switchInFlightByMonitorId.get(lockKey) === switchTask) {
      switchInFlightByMonitorId.delete(lockKey);
    }
  }
}

async function switchMonitorUnlocked(monitorId, targetId, options = {}) {
  const { notifyOnSuccess = true, showErrorDialog = false } = options;
  const monitorContext = await getMonitorContextById(monitorId);

  if (!monitorContext) {
    throw new Error("当前没有找到这块本机屏幕，可能它已经不在当前主机上。");
  }

  if (!targetId) {
    throw new Error("目标接口无效。");
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

  if (runtimeStatus.ddcAvailable === false) {
    const error = new Error(
      `${getMonitorDisplayTitle(monitorContext)} 当前没有可用的 DDC/CI 控制通道，不能从这台机器直接切换。`
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

    return {
      monitorId: monitorContext.id,
      targetId,
      verificationStatus: switchResult?.verificationStatus || "unconfirmed",
      outcomeMessage: successMessages.outcomeMessage,
      notificationMessage: successMessages.notificationMessage,
    };
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
  let topologyDisplay = topologyDisplays.find((display) =>
    isTopologyDisplayMatchMonitor(display, monitorContext)
  );
  if (!topologyDisplay?.attached) {
    throw new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 当前不在 Windows 桌面里，Windows 这侧不能直接控制它。`
    );
  }

  if (!switchingToLocalInterface && topologyDisplay.primary) {
    topologyDisplay = await promoteWindowsPrimaryAwayBeforeSwitch(
      monitorContext,
      topologyDisplay,
      attachedTopologyDisplayCount
    );
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const selectorArgs = getWindowsMonitorSelectorArgs(monitorContext);
  const candidates = getInputCandidates(target, monitorConfig);
  const expectedValues = getExpectedProbeInputValues(target.inputValue, monitorConfig);
  const attachedDisplayCountBeforeSwitch = attachedTopologyDisplayCount;

  const switchResult = await runSwitchCandidateSequence(candidates, async (candidate) => {
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

    return {
      verificationStatus: verificationResult.status,
      message: verificationResult.message,
    };
  });

  if (
    switchResult.verificationStatus === "confirmed" &&
    !switchingToLocalInterface &&
    shouldUseWindowsDisplayHandoffForMonitor(monitorConfig, attachedTopologyDisplayCount)
  ) {
    await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
    await detachWindowsDisplayForMonitor(
      monitorConfig,
      attachedDisplayCountBeforeSwitch,
      buildWindowsRestoreLayout(topologyDisplay)
    );
  } else if (switchingToLocalInterface) {
    clearMonitorPendingRestore(monitorConfig.id);
  }

  return {
    verificationStatus: switchResult.verificationStatus,
    message: switchResult.message,
  };
}

async function switchOnMacForContext(monitorContext, targetId, target) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  const candidates = getInputCandidates(target, monitorContext.monitor);
  const expectedValues = getExpectedProbeInputValues(target.inputValue, monitorContext.monitor);

  const switchResult = await runSwitchCandidateSequence(candidates, async (candidate) => {
    const output = await runCommand("/bin/sh", [scriptPath, String(candidate)], {
      env: {
        ...getMacSwitchScriptEnvForContext(monitorContext),
        INPUT_EXPECTED_VALUES: expectedValues.join(" "),
      },
    });
    return {
      verificationStatus: /\bUNCONFIRMED\b/u.test(output) ? "unconfirmed" : "confirmed",
      message: "",
    };
  });

  return {
    verificationStatus: switchResult.verificationStatus,
    message: switchResult.message,
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
      )} 已发送切换命令到 ${target.label}，但当前显示器没有提供可靠回读，结果待人工确认。`
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
      status: "unconfirmed",
      message: `${getMonitorDisplayTitle(
        monitorContext
      )} 已发送切换命令，但当前输入回读仍是 ${lastObservedValue}，结果待人工确认。`,
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
    ], {
      timeout: CURRENT_INPUT_COMMAND_TIMEOUT_MS,
    });
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
      timeout: CURRENT_INPUT_COMMAND_TIMEOUT_MS,
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
  return getMacSwitchScriptEnvForDisplay(monitorContext.display);
}

function getMacSwitchScriptEnvForDisplay(displaySummary) {
  const env = {
    DISPLAY_NAME: getMonitorDisplayName({ display: displaySummary }),
    DISPLAY_INDEX: String(Number.isInteger(displaySummary.index) ? displaySummary.index : 1),
    DISPLAY_NAME_FALLBACK_ALLOWED: displaySummary.displayNameIsUnique ? "1" : "0",
  };

  if (Number.isInteger(displaySummary.macSystemDisplayId)) {
    env.DISPLAY_ID = String(displaySummary.macSystemDisplayId);
  }

  return env;
}

async function attachMacDdcProbeResults(displaySummaries) {
  if (process.platform !== "darwin" || !Array.isArray(displaySummaries)) {
    return displaySummaries;
  }

  const probeResults = await mapSequential(
    displaySummaries,
    async (displaySummary) => ({
      displaySummary,
      probeResult: await getMacDdcProbeResult(displaySummary),
    })
  );

  return probeResults.map(({ displaySummary, probeResult }) => {
    const safeIdentity = hasMacSafeDdcTargetIdentity(displaySummary);
    return {
      ...displaySummary,
      ddcProbe: createDdcProbeSummary(
        {
          ...probeResult,
          ok: Boolean(probeResult.ok && safeIdentity),
        },
        safeIdentity ? "" : "当前 macOS 屏幕缺少可安全定位的 DDC 目标身份。"
      ),
    };
  });
}

function createDdcProbeSummary(probeResult, fallbackError = "") {
  const ok = Boolean(probeResult?.ok);
  const status = normalizeText(probeResult?.status) || (ok ? "ok" : "failed");
  return {
    ok,
    status,
    confirmed: ok && status === "ok",
    error: ok ? "" : normalizeText(probeResult?.error) || normalizeText(fallbackError),
  };
}

function hasMacSafeDdcTargetIdentity(displaySummary) {
  if (Number.isInteger(displaySummary?.macSystemDisplayId)) {
    return true;
  }

  if (buildMacHardwareDisplayKey(displaySummary)) {
    return true;
  }

  return Boolean(
    displaySummary?.displayNameIsUnique && normalizeText(displaySummary?.detectedName)
  );
}

async function getMacDdcProbeResult(displaySummary) {
  const cacheKey =
    normalizeText(displaySummary?.displayKey) ||
    `mac-display:${displaySummary?.electronDisplayId || ""}:${displaySummary?.index || ""}`;
  const cachedResult = macDdcProbeCache.get(cacheKey);
  if (cachedResult && Date.now() - cachedResult.checkedAt < DDC_PROBE_CACHE_TTL_MS) {
    return cachedResult;
  }

  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  try {
    const output = await runCommand("/bin/sh", [scriptPath, "--probe-ddc"], {
      env: getMacSwitchScriptEnvForDisplay(displaySummary),
    });
    const probeStatus = parseMacDdcProbeOutput(output);
    const nextResult = {
      ok:
        probeStatus === "ok" ||
        (probeStatus === "targetable-unconfirmed" && hasMacPhysicalIdentity(displaySummary)),
      status: probeStatus,
      checkedAt: Date.now(),
      error: "",
    };
    macDdcProbeCache.set(cacheKey, nextResult);
    return nextResult;
  } catch (error) {
    const nextResult = {
      ok: false,
      status: "failed",
      checkedAt: Date.now(),
      error: normalizeText(error.message),
    };
    macDdcProbeCache.set(cacheKey, nextResult);
    appendDiagnosticLog(`macOS DDC probe failed for ${getMonitorDisplayName({ display: displaySummary })}`, error);
    return nextResult;
  }
}

function parseMacDdcProbeOutput(output) {
  const normalized = normalizeText(output).toUpperCase();
  if (/\bOK\b/u.test(normalized)) {
    return "ok";
  }

  if (/\bUNKNOWN\b/u.test(normalized)) {
    return "targetable-unconfirmed";
  }

  return "targetable-unconfirmed";
}

function hasMacPhysicalIdentity(displaySummary) {
  const vendorId = normalizeText(displaySummary?.macVendorId).toLowerCase();
  const productId = normalizeText(displaySummary?.macProductId).toLowerCase();
  return Boolean(vendorId && productId && !/^(0x)?0+$/u.test(vendorId) && !/^(0x)?0+$/u.test(productId));
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

function buildWindowsRestoreLayout(topologyDisplay) {
  const positionX = Number.isFinite(topologyDisplay?.positionX) ? topologyDisplay.positionX : NaN;
  const positionY = Number.isFinite(topologyDisplay?.positionY) ? topologyDisplay.positionY : NaN;

  if (!Number.isInteger(positionX) || !Number.isInteger(positionY)) {
    return null;
  }

  return {
    positionX,
    positionY,
  };
}

async function promoteWindowsPrimaryAwayBeforeSwitch(
  monitorContext,
  topologyDisplay,
  attachedDisplayCount
) {
  if (!topologyDisplay?.primary) {
    return topologyDisplay;
  }

  if (!Number.isInteger(attachedDisplayCount) || attachedDisplayCount < 2) {
    throw new Error(
      `${getMonitorDisplayTitle(
        monitorContext
      )} 是 Windows 当前唯一主屏，切走前没有另一块已连接屏可升为主屏。`
    );
  }

  await runWindowsTopologyCommand([
    "-MonitorName",
    getWindowsTopologySelectorValue(monitorContext),
    "-PromotePrimaryAwayFromMonitor",
  ]);

  return waitForWindowsMonitorNoLongerPrimary(
    monitorContext,
    "Windows 没有在切走前把另一块已连接屏升为主屏。"
  );
}

async function detachWindowsDisplayForMonitor(
  monitorConfig,
  expectedAttachedDisplayCount,
  restoreLayout = null
) {
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
  markMonitorPendingRestore(monitorConfig.id, expectedAttachedDisplayCount, restoreLayout);
}

async function attachWindowsDisplayForMonitor(
  monitorConfig,
  expectedAttachedDisplayCount,
  restoreLayout = null
) {
  const args = [
    "-MonitorName",
    getWindowsTopologySelectorValue(monitorConfig),
    "-AttachMonitor",
  ];

  if (restoreLayout) {
    args.push(
      "-PreferredPositionX",
      String(restoreLayout.positionX),
      "-PreferredPositionY",
      String(restoreLayout.positionY)
    );
  }

  await runWindowsTopologyCommand(args);
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

async function waitForWindowsMonitorNoLongerPrimary(monitorConfig, errorMessage) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const topologyDisplay = topologyDisplays.find((display) =>
      isTopologyDisplayMatchMonitor(display, monitorConfig)
    );
    if (topologyDisplay?.attached && !topologyDisplay.primary) {
      return topologyDisplay;
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

  const restored = await attemptPendingWindowsRestores({
    monitorId,
    allowAttachDetached: true,
  });
  const detachedDuplicates = await attemptWindowsDuplicateForeignDisplayDetaches({
    monitorId,
  });
  const changed = restored || detachedDuplicates;
  const message = detachedDuplicates
    ? restored
      ? "Windows 已刷新接回状态，并移除误挂回来的重复屏幕。"
      : "Windows 已移除误挂回来的重复屏幕。"
    : restored
      ? "Windows 已刷新并处理等待接回的屏幕。"
      : "Windows 已刷新当前屏幕状态。";

  if (notifyOnSuccess) {
    notify(message);
  }

  return {
    changed,
    message,
  };
}

async function takeoverWindowsDetachedMonitor(
  monitorId,
  { notifyOnSuccess = false, showErrorDialog = false } = {}
) {
  if (process.platform !== "win32") {
    throw new Error("当前平台不是 Windows，不能执行 Windows 主动接管。");
  }

  const normalizedMonitorId = normalizeText(monitorId);
  const takeoverContexts = await getWindowsDetachedTakeoverContexts({
    persistCandidates: true,
  });
  const takeoverContext = takeoverContexts.find(
    (monitorContext) => monitorContext.id === normalizedMonitorId
  );
  if (!takeoverContext) {
    throw new Error("没有找到可接管的 Windows 断开屏幕。");
  }

  const monitorConfig = takeoverContext.monitor;
  const localTargetId = getLocalInterfaceId(monitorConfig);
  const localTarget = getTarget(localTargetId, monitorConfig);
  let attachedDuringTakeover = false;
  windowsTakeoverInProgressMonitorIds.add(monitorConfig.id);

  try {
    upsertStoredMonitorConfig(monitorConfig);
    saveState(state);

    const topologyDisplays = await getWindowsTopologyDisplays();
    const topologyDisplay = topologyDisplays.find((display) =>
      isTopologyDisplayMatchMonitor(display, monitorConfig)
    );
    if (!topologyDisplay) {
      throw new Error("Windows 拓扑里没有找到这块断开的屏幕。");
    }

    if (!topologyDisplay.attached) {
      const expectedAttachedDisplayCount =
        topologyDisplays.filter((display) => display.attached).length + 1;
      await attachWindowsDisplayForMonitor(
        monitorConfig,
        expectedAttachedDisplayCount,
        getExistingMonitorDesktopRuntime(monitorConfig.id)?.restoreLayout || null
      );
      attachedDuringTakeover = true;
      await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
      await syncMonitorConfigsFromLocalDisplays({ persist: true });
    }

    const switchResult = await switchWindowsDisplayForMonitorConfig(monitorConfig, localTarget);
    await waitForWindowsTopologyDeviceAttachmentState(
      monitorConfig.match?.gdiDeviceName,
      true,
      `${getMonitorDisplayTitle(monitorConfig)} 已发送接管命令，但 Windows 显示拓扑没有稳定保留这块屏。`,
      30000,
      3000
    );
    clearMonitorPendingRestore(monitorConfig.id);
    markWindowsTakeoverProtection(monitorConfig.id);
    await syncMonitorConfigsFromLocalDisplays({ persist: true });
    void refreshMenu();

    const message =
      switchResult?.verificationStatus === "unconfirmed"
        ? `${getMonitorDisplayTitle(monitorConfig)} 已接回 Windows 桌面，并已发送切到 ${localTarget.label} 的命令，结果待人工确认。`
        : `${getMonitorDisplayTitle(monitorConfig)} 已主动接管到 ${localTarget.label}。`;
    recordSwitchOutcome("success", monitorConfig.id, localTargetId, message);
    saveState(state);

    if (notifyOnSuccess) {
      notify(message);
    }

    return {
      changed: true,
      message,
    };
  } catch (error) {
    if (attachedDuringTakeover) {
      try {
        await detachWindowsTopologyDisplay(monitorConfig, "takeover command failed");
      } catch (detachError) {
        appendDiagnosticLog("Failed to rollback Windows takeover attach", detachError);
      }
    }

    const message = formatWindowsTakeoverError(monitorConfig, localTarget, error);
    recordSwitchOutcome("error", monitorConfig.id, localTargetId, message);
    saveState(state);
    void refreshMenu();

    if (showErrorDialog) {
      dialog.showErrorBox(APP_NAME, message);
    }

    throw new Error(message);
  } finally {
    windowsTakeoverInProgressMonitorIds.delete(monitorConfig.id);
  }
}

function formatWindowsTakeoverError(monitorConfig, localTarget, error) {
  const rawMessage = normalizeText(error?.message || error);
  const monitorTitle = getMonitorDisplayTitle(monitorConfig);
  const targetLabel = normalizeText(localTarget?.label) || "当前机器接口";

  if (
    /No monitor matched GDI device|No physical monitor handles|DDC\/CI 控制通道|physical monitor/i.test(
      rawMessage
    )
  ) {
    return `${monitorTitle} 已尝试接回 Windows，但 Windows 没有拿到这块屏的 DDC/CI 控制通道。通常表示显示器当前停在另一台机器的输入源时，不向 Windows 暴露控制句柄；这台机器不能主动把它抢回 ${targetLabel}。请先用显示器菜单切回 Windows 输入，或让当前画面所在机器切走。`;
  }

  if (/Failed to attach display|重新加回桌面拓扑|bad mode|code -2/i.test(rawMessage)) {
    return `${monitorTitle} 无法加回 Windows 桌面拓扑。Windows 没有接受这块断开屏的显示模式，接管没有生效。原始错误：${rawMessage}`;
  }

  return rawMessage || "Windows 主动接管失败。";
}

async function switchWindowsDisplayForMonitorConfig(monitorConfig, target) {
  const deviceName = normalizeText(monitorConfig?.match?.gdiDeviceName);
  if (!deviceName) {
    throw new Error("Windows 当前没有这块屏幕的可用设备标识。");
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const candidates = getInputCandidates(target, monitorConfig);
  const expectedValues = getExpectedProbeInputValues(target.inputValue, monitorConfig);

  return runSwitchCandidateSequence(candidates, async (candidate) => {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-GdiDeviceName",
      deviceName,
      "-InputValue",
      String(candidate),
    ]);

    const currentInputResult = await getWindowsCurrentInputResultForTopologyDisplay({
      deviceName,
    });
    if (currentInputResult.ok && expectedValues.includes(currentInputResult.value)) {
      return {
        verificationStatus: "confirmed",
        message: `当前输入已确认：${describeInputValue(currentInputResult.value)}。`,
      };
    }

    return {
      verificationStatus: "unconfirmed",
      message: currentInputResult.ok
        ? `当前输入仍为 ${describeInputValue(currentInputResult.value)}。`
        : currentInputResult.error,
    };
  });
}

async function attemptPendingWindowsRestores({
  monitorId: targetMonitorId = null,
  displaySummaries = null,
  allowAttachDetached = false,
} = {}) {
  if (process.platform !== "win32" || windowsRestoreInFlight) {
    return false;
  }

  windowsRestoreInFlight = true;

  try {
    if (!Array.isArray(displaySummaries)) {
      await syncMonitorConfigsFromLocalDisplays({ persist: false });
    }
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
        if (!allowAttachDetached) {
          continue;
        }

        try {
          await attachWindowsDisplayForMonitor(
            monitorConfig,
            runtime.expectedAttachedDisplayCount || null,
            runtime.restoreLayout
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

async function attemptWindowsDuplicateForeignDisplayDetaches({ monitorId = null } = {}) {
  if (process.platform !== "win32" || windowsDuplicateDetachInFlight) {
    return false;
  }

  windowsDuplicateDetachInFlight = true;

  try {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const candidates = await getWindowsDuplicateForeignDisplayDetachCandidates(
      topologyDisplays,
      normalizeText(monitorId) || null
    );
    let changed = false;

    for (const candidate of candidates) {
      try {
        await detachWindowsTopologyDisplay(candidate.display, candidate.reason);
        changed = true;
      } catch (error) {
        appendDiagnosticLog(
          `Failed to detach duplicate Windows display ${candidate.display.deviceName}`,
          error
        );
      }
    }

    if (changed) {
      await syncMonitorConfigsFromLocalDisplays({ persist: true });
      void refreshMenu();
    }

    return changed;
  } finally {
    windowsDuplicateDetachInFlight = false;
  }
}

async function getWindowsDuplicateForeignDisplayDetachCandidates(topologyDisplays, targetMonitorId) {
  const attachedDisplays = Array.isArray(topologyDisplays)
    ? topologyDisplays.filter((display) => display.attached)
    : [];
  const duplicateGroups = groupWindowsDuplicateAttachedDisplays(attachedDisplays);
  const candidates = [];

  for (const group of duplicateGroups) {
    const primaryDisplay = group.find((display) => display.primary);
    if (!primaryDisplay) {
      continue;
    }

    for (const display of group.filter((item) => !item.primary)) {
      const monitorConfig = findStoredMonitorConfigForTopologyDisplay(display);
      if (
        !monitorConfig ||
        (targetMonitorId && monitorConfig.id !== targetMonitorId) ||
        isWindowsTakeoverInProgress(monitorConfig) ||
        !shouldUseWindowsDisplayHandoffForMonitor(monitorConfig, attachedDisplays.length)
      ) {
        continue;
      }

      const runtime = getExistingMonitorDesktopRuntime(monitorConfig.id);
      const currentInput = await getWindowsCurrentInputResultForTopologyDisplay(display);
      const inputLooksForeign =
        currentInput.ok &&
        isWindowsInputValueForConfiguredExternalHandoffTarget(currentInput.value, monitorConfig);
      const pendingAwayAndUnverified = Boolean(runtime?.pendingRestore) && !currentInput.ok;

      if (!inputLooksForeign && !pendingAwayAndUnverified) {
        continue;
      }

      candidates.push({
        display,
        reason: inputLooksForeign
          ? `input ${currentInput.value} matches configured external handoff target`
          : "pending restore display is attached but input could not be verified",
      });
    }
  }

  return candidates;
}

function isWindowsTakeoverInProgress(monitorConfigOrId) {
  const monitorId =
    typeof monitorConfigOrId === "string"
      ? normalizeText(monitorConfigOrId)
      : normalizeText(monitorConfigOrId?.id);
  return Boolean(
    monitorId &&
      (windowsTakeoverInProgressMonitorIds.has(monitorId) ||
        isWindowsTakeoverSettleProtected(monitorId))
  );
}

function markWindowsTakeoverProtection(monitorId, durationMs = WINDOWS_TAKEOVER_SETTLE_MS) {
  const normalizedMonitorId = normalizeText(monitorId);
  if (!normalizedMonitorId) {
    return;
  }

  windowsTakeoverProtectedUntilByMonitorId.set(normalizedMonitorId, Date.now() + durationMs);
}

function isWindowsTakeoverSettleProtected(monitorId) {
  const normalizedMonitorId = normalizeText(monitorId);
  if (!normalizedMonitorId) {
    return false;
  }

  const protectedUntil = windowsTakeoverProtectedUntilByMonitorId.get(normalizedMonitorId);
  if (!Number.isFinite(protectedUntil)) {
    return false;
  }

  if (Date.now() <= protectedUntil) {
    return true;
  }

  windowsTakeoverProtectedUntilByMonitorId.delete(normalizedMonitorId);
  return false;
}

function groupWindowsDuplicateAttachedDisplays(attachedDisplays) {
  const groupsByIdentity = new Map();

  for (const display of attachedDisplays) {
    const identityKey = getWindowsDuplicateDisplayIdentityKey(display);
    if (!identityKey) {
      continue;
    }

    if (!groupsByIdentity.has(identityKey)) {
      groupsByIdentity.set(identityKey, []);
    }

    groupsByIdentity.get(identityKey).push(display);
  }

  return [...groupsByIdentity.values()].filter((group) => {
    const primaryCount = group.filter((display) => display.primary).length;
    return group.length > 1 && primaryCount === 1;
  });
}

function getWindowsDuplicateDisplayIdentityKey(display) {
  const productCode = normalizeText(display?.productCode).toLowerCase();
  const displayName = normalizeText(display?.friendlyName || display?.displayName).toLowerCase();
  const width = Number.isFinite(display?.width) ? display.width : 0;
  const height = Number.isFinite(display?.height) ? display.height : 0;

  if (!productCode || !displayName || width <= 0 || height <= 0) {
    return "";
  }

  return `${productCode}:${displayName}:${width}x${height}`;
}

async function getWindowsCurrentInputResultForTopologyDisplay(topologyDisplay) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      value: null,
      error: "当前平台不支持 Windows 输入读取。",
    };
  }

  const deviceName = normalizeText(topologyDisplay?.deviceName);
  if (!deviceName) {
    return {
      ok: false,
      value: null,
      error: "Windows topology display did not include a GDI device name.",
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
      "-GdiDeviceName",
      deviceName,
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

function isWindowsInputValueForTarget(inputValue, target, monitorConfig) {
  if (!Number.isInteger(inputValue) || !Number.isInteger(target?.inputValue)) {
    return false;
  }

  return getExpectedProbeInputValues(target.inputValue, monitorConfig).includes(inputValue);
}

function isWindowsInputValueForConfiguredExternalHandoffTarget(inputValue, monitorConfig) {
  if (!Number.isInteger(inputValue)) {
    return false;
  }

  const localInterfaceId = getLocalInterfaceId(monitorConfig);
  return TARGET_IDS.some((targetId) => {
    if (targetId === localInterfaceId || !isExternalWindowsHandoffTargetId(targetId)) {
      return false;
    }

    return isWindowsInputValueForTarget(inputValue, getTarget(targetId, monitorConfig), monitorConfig);
  });
}

function isExternalWindowsHandoffTargetId(targetId) {
  return /^hdmi\d+$/iu.test(normalizeText(targetId));
}

function findStoredMonitorConfigForTopologyDisplay(topologyDisplay) {
  return (
    getStoredMonitorConfigs().find((monitorConfig) =>
      isTopologyDisplayMatchMonitor(topologyDisplay, monitorConfig)
    ) || null
  );
}

async function detachWindowsTopologyDisplay(topologyDisplay, reason = "") {
  const deviceName = normalizeText(topologyDisplay?.deviceName || topologyDisplay?.match?.gdiDeviceName);
  if (!deviceName) {
    throw new Error("Windows duplicate display did not include a GDI device name.");
  }

  await runWindowsTopologyCommand(["-MonitorName", deviceName, "-DetachMonitor"]);
  await waitForWindowsTopologyDeviceAttachmentState(
    deviceName,
    false,
    `Windows 没有把误挂回来的重复屏幕 ${deviceName} 从桌面拓扑里移除。`
  );
  appendDiagnosticLog(`Detached duplicate Windows display ${deviceName}${reason ? ` (${reason})` : ""}`);
}

async function waitForWindowsTopologyDeviceAttachmentState(
  deviceName,
  expectedAttached,
  errorMessage,
  timeoutMs = 8000,
  stableMs = 0
) {
  const normalizedDeviceName = normalizeText(deviceName).toLowerCase();
  const startedAt = Date.now();
  let matchedSince = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const topologyDisplay = topologyDisplays.find(
      (display) => normalizeText(display.deviceName).toLowerCase() === normalizedDeviceName
    );
    if (Boolean(topologyDisplay?.attached) === expectedAttached) {
      if (stableMs <= 0) {
        return;
      }

      if (!matchedSince) {
        matchedSince = Date.now();
      }

      if (Date.now() - matchedSince >= stableMs) {
        return;
      }
    } else {
      matchedSince = 0;
    }

    await delay(250);
  }

  throw new Error(errorMessage);
}

function startWindowsRestoreWatcher() {
  if (process.platform !== "win32") {
    return;
  }

  windowsRestoreTimer = setInterval(() => {
    void attemptPendingWindowsRestores();
  }, 2500);
}

function startDisplayChangeWatcher() {
  const handleDisplayChange = () => {
    void handleLocalDisplayTopologyChange();
  };

  screen.on("display-added", handleDisplayChange);
  screen.on("display-removed", handleDisplayChange);
  screen.on("display-metrics-changed", handleDisplayChange);
}

async function handleLocalDisplayTopologyChange() {
  try {
    windowsDdcProbeCache.clear();
    macDdcProbeCache.clear();
    const displaySummaries = await syncMonitorConfigsFromLocalDisplays({
      persist: true,
      forceMacDisplayMetadataRefresh: true,
    });

    if (process.platform === "win32") {
      await attemptPendingWindowsRestores({
        displaySummaries,
      });
      await attemptWindowsDuplicateForeignDisplayDetaches();
      scheduleTrayRebuild("display-change");
      return;
    }

    const monitorContexts = await buildMonitorContextsWithStatus({ displaySummaries });
    await refreshMenu({ monitorContexts });
  } catch (error) {
    appendDiagnosticLog("Failed to handle local display topology change", error);
  }
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

async function buildMonitorContextsWithStatus(options = {}) {
  const monitorContexts = await getConnectedMonitorContexts(options);
  const sharedWindowsTopologyDisplays =
    process.platform === "win32" ? await getWindowsTopologyDisplays() : null;
  return Promise.all(
    monitorContexts.map(async (monitorContext) => ({
      ...monitorContext,
      status: await getMonitorStatus(monitorContext, {
        topologyDisplays: sharedWindowsTopologyDisplays,
      }),
    }))
  );
}

async function getMonitorStatus(monitorContext, options = {}) {
  const { topologyDisplays = null } = options;
  if (monitorContext.display?.ddcProbe?.ok === false) {
    return {
      visible: true,
      ddcAvailable: false,
      ddcProbeStatus: monitorContext.display.ddcProbe.status,
      ddcUnavailableReason: getDisplayDdcUnavailableReason(monitorContext.display),
      currentInputValue: null,
      currentInputError: getDisplayDdcUnavailableReason(monitorContext.display),
    };
  }

  if (process.platform === "win32") {
    const resolvedTopologyDisplays = Array.isArray(topologyDisplays)
      ? topologyDisplays
      : await getWindowsTopologyDisplays();
    const visible = isWindowsMonitorAttachedInTopology(resolvedTopologyDisplays, monitorContext);
    if (!visible) {
      return {
        visible: false,
        ddcAvailable: false,
        ddcProbeStatus: monitorContext.display?.ddcProbe?.status || "",
        ddcUnavailableReason: "",
        currentInputValue: null,
        currentInputError: null,
      };
    }

    const currentInputResult = await getWindowsCurrentInputResultForContext(monitorContext);
    return {
      visible: true,
      ddcAvailable: true,
      ddcProbeStatus: monitorContext.display?.ddcProbe?.status || "ok",
      ddcUnavailableReason: "",
      currentInputValue: currentInputResult.ok ? currentInputResult.value : null,
      currentInputError: currentInputResult.ok ? null : currentInputResult.error,
    };
  }

  const currentInputResult = await getMacCurrentInputResultForContext(monitorContext);
  return {
    visible: true,
    ddcAvailable: true,
    ddcProbeStatus: monitorContext.display?.ddcProbe?.status || "ok",
    ddcUnavailableReason: "",
    currentInputValue: currentInputResult.ok ? currentInputResult.value : null,
    currentInputError: currentInputResult.ok ? null : currentInputResult.error,
  };
}

function isMonitorDirectSwitchEnabled(monitorContext) {
  return (
    monitorContext?.status?.visible !== false &&
    monitorContext?.status?.ddcAvailable !== false
  );
}

function getDisplayDdcUnavailableReason(displaySummary) {
  return (
    normalizeText(displaySummary?.ddcProbe?.error) ||
    "当前显示器没有可用的 DDC/CI 控制通道。"
  );
}

async function getConnectedMonitorContexts({
  displaySummaries = null,
  forceMacDisplayMetadataRefresh = false,
} = {}) {
  const nextDisplaySummaries = Array.isArray(displaySummaries)
    ? displaySummaries
    : await syncMonitorConfigsFromLocalDisplays({
        persist: true,
        forceMacDisplayMetadataRefresh,
      });
  const monitorConfigsById = new Map(
    getStoredMonitorConfigs().map((monitorConfig) => [monitorConfig.id, monitorConfig])
  );

  return nextDisplaySummaries
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

async function getWindowsDetachedTakeoverContexts({
  connectedMonitorContexts = null,
  topologyDisplays = null,
  persistCandidates = false,
} = {}) {
  if (process.platform !== "win32") {
    return [];
  }

  const connectedContexts = Array.isArray(connectedMonitorContexts)
    ? connectedMonitorContexts
    : await getConnectedMonitorContexts();
  const connectedMonitorIds = new Set(
    connectedContexts.map((monitorContext) => monitorContext.id)
  );
  const connectedDeviceNames = new Set(
    connectedContexts
      .map((monitorContext) => normalizeText(monitorContext.display?.gdiDeviceName).toLowerCase())
      .filter(Boolean)
  );
  const resolvedTopologyDisplays = Array.isArray(topologyDisplays)
    ? topologyDisplays
    : await getWindowsTopologyDisplays();
  const prunedHeuristicConfigs = persistCandidates
    ? pruneRedundantWindowsHeuristicTakeoverConfigs(
        connectedMonitorIds,
        resolvedTopologyDisplays
      )
    : false;
  const knownContexts = [];
  const usedDeviceNames = new Set(connectedDeviceNames);

  for (const monitorConfig of getStoredMonitorConfigs()) {
    if (connectedMonitorIds.has(monitorConfig.id)) {
      continue;
    }

    const gdiDeviceName = normalizeText(monitorConfig.match?.gdiDeviceName);
    if (!gdiDeviceName) {
      continue;
    }

    const topologyDisplay = resolvedTopologyDisplays.find((display) =>
      isTopologyDisplayMatchMonitor(display, monitorConfig)
    );
    if (!topologyDisplay || topologyDisplay.attached) {
      continue;
    }

    const monitorContext = createWindowsDetachedTakeoverContext(
      monitorConfig,
      topologyDisplay,
      "stored"
    );
    knownContexts.push(monitorContext);
    usedDeviceNames.add(gdiDeviceName.toLowerCase());
  }

  const heuristicDisplays =
    knownContexts.length === 0
      ? getWindowsHeuristicDetachedTakeoverDisplays(resolvedTopologyDisplays, usedDeviceNames)
      : [];
  const fallbackConfig = getStoredMonitorConfigs()[0] || null;
  const heuristicContexts = heuristicDisplays.map((topologyDisplay) => {
    const monitorConfig = createWindowsDetachedMonitorConfig(topologyDisplay, fallbackConfig);
    if (persistCandidates) {
      upsertStoredMonitorConfig(monitorConfig);
    }
    return createWindowsDetachedTakeoverContext(monitorConfig, topologyDisplay, "heuristic");
  });

  if (persistCandidates && (heuristicContexts.length > 0 || prunedHeuristicConfigs)) {
    saveState(state);
  }

  return [...knownContexts, ...heuristicContexts].sort((left, right) =>
    normalizeText(left.display.gdiDeviceName).localeCompare(
      normalizeText(right.display.gdiDeviceName),
      undefined,
      { numeric: true }
    )
  );
}

function pruneRedundantWindowsHeuristicTakeoverConfigs(connectedMonitorIds, topologyDisplays = []) {
  if (process.platform !== "win32" || !(connectedMonitorIds instanceof Set)) {
    return false;
  }

  const storedMonitorConfigs = getStoredMonitorConfigs();
  const hasExplicitDetachedConfig = storedMonitorConfigs.some((monitorConfig) => {
    if (
      connectedMonitorIds.has(monitorConfig.id) ||
      isWindowsAutoGeneratedTakeoverConfig(monitorConfig)
    ) {
      return false;
    }

    const gdiDeviceName = normalizeText(monitorConfig.match?.gdiDeviceName);
    if (!gdiDeviceName) {
      return false;
    }

    const topologyDisplay = Array.isArray(topologyDisplays)
      ? topologyDisplays.find((display) => isTopologyDisplayMatchMonitor(display, monitorConfig))
      : null;
    return Boolean(topologyDisplay && !topologyDisplay.attached);
  });
  const autoGeneratedConfigs = storedMonitorConfigs
    .filter(
      (monitorConfig) =>
        !connectedMonitorIds.has(monitorConfig.id) &&
        isWindowsAutoGeneratedTakeoverConfig(monitorConfig)
    )
    .sort(
      (left, right) =>
        getWindowsDisplayDeviceNumber(left.match?.gdiDeviceName) -
        getWindowsDisplayDeviceNumber(right.match?.gdiDeviceName)
    );

  if (autoGeneratedConfigs.length === 0) {
    return false;
  }

  if (!hasExplicitDetachedConfig && autoGeneratedConfigs.length <= 1) {
    return false;
  }

  const keepMonitorId = hasExplicitDetachedConfig ? "" : autoGeneratedConfigs[0].id;
  const removeMonitorIds = new Set(
    autoGeneratedConfigs
      .filter((monitorConfig) => monitorConfig.id !== keepMonitorId)
      .map((monitorConfig) => monitorConfig.id)
  );

  state.config.monitors = storedMonitorConfigs.filter(
    (monitorConfig) => !removeMonitorIds.has(monitorConfig.id)
  );

  const runtimeMap = state.windowsDesktop?.byMonitorId;
  if (runtimeMap && typeof runtimeMap === "object") {
    for (const monitorId of removeMonitorIds) {
      delete runtimeMap[monitorId];
    }
  }

  return removeMonitorIds.size > 0;
}

function isWindowsAutoGeneratedTakeoverConfig(monitorConfig) {
  if (monitorConfig?.roleLabel !== "可接管屏幕") {
    return false;
  }

  if (getExistingMonitorDesktopRuntime(monitorConfig.id)?.pendingRestore) {
    return false;
  }

  const gdiDeviceName = normalizeText(monitorConfig.match?.gdiDeviceName);
  if (!Number.isInteger(getWindowsDisplayDeviceNumber(gdiDeviceName))) {
    return false;
  }

  const displayName = getMonitorDisplayName(monitorConfig);
  const productCode = normalizeText(monitorConfig.match?.productCode);
  return (
    displayName === gdiDeviceName &&
    (!productCode || isWindowsGenericDetachedDisplayName(productCode))
  );
}

function createWindowsDetachedTakeoverContext(monitorConfig, topologyDisplay, takeoverSource) {
  return {
    id: monitorConfig.id,
    monitor: monitorConfig,
    display: createWindowsDetachedDisplaySummary(monitorConfig, topologyDisplay),
    takeoverSource,
    status: {
      visible: false,
      ddcAvailable: false,
      ddcProbeStatus: "",
      ddcUnavailableReason: "这块屏当前不在 Windows 桌面里，接管时会先加回桌面。",
      currentInputValue: null,
      currentInputError: null,
    },
  };
}

function createWindowsDetachedDisplaySummary(monitorConfig, topologyDisplay) {
  const deviceName = normalizeText(topologyDisplay?.deviceName || monitorConfig?.match?.gdiDeviceName);
  const displayKey = deviceName ? `win:${deviceName}` : normalizeText(monitorConfig?.displayKey);
  const detectedName =
    getWindowsUsableDetachedDisplayName(topologyDisplay) ||
    getMonitorDisplayName(monitorConfig) ||
    deviceName ||
    "断开的 Windows 屏幕";
  const width = Number.isFinite(topologyDisplay?.width) ? topologyDisplay.width : 0;
  const height = Number.isFinite(topologyDisplay?.height) ? topologyDisplay.height : 0;

  return {
    id: monitorConfig.id,
    displayKey,
    index: null,
    roleLabel: "可接管屏幕",
    detectedName,
    resolution: width > 0 && height > 0 ? `${width} × ${height}` : "当前未接入桌面",
    position: "当前未接入桌面",
    internal: false,
    electronDisplayId: null,
    macSystemDisplayId: null,
    macVendorId: "",
    macProductId: "",
    macSerialNumber: "",
    gdiDeviceName: deviceName,
    productCode: normalizeText(topologyDisplay?.productCode || monitorConfig?.match?.productCode),
    bounds: {
      x: 0,
      y: 0,
      width,
      height,
    },
  };
}

function createWindowsDetachedMonitorConfig(topologyDisplay, fallbackMonitorConfig = null) {
  const deviceName = normalizeText(topologyDisplay?.deviceName);
  const displayKey = deviceName ? `win:${deviceName}` : `win-detached:${crypto.randomUUID()}`;
  const detectedName =
    getWindowsUsableDetachedDisplayName(topologyDisplay) || deviceName || "断开的 Windows 屏幕";
  const inheritedConfig = fallbackMonitorConfig
    ? {
        localInterfaceId: fallbackMonitorConfig.localInterfaceId,
        compatibilityMode: fallbackMonitorConfig.compatibilityMode,
        windowsDisplayHandoffMode: fallbackMonitorConfig.windowsDisplayHandoffMode,
        interfaces: cloneInterfacesConfig(fallbackMonitorConfig.interfaces),
      }
    : {};

  return normalizeMonitorConfig(
    {
      ...inheritedConfig,
      id: createMonitorId(displayKey),
      displayKey,
      roleLabel: "可接管屏幕",
      displayName: detectedName,
      match: {
        electronDisplayId: null,
        macSystemDisplayId: null,
        macVendorId: "",
        macProductId: "",
        macSerialNumber: "",
        gdiDeviceName: deviceName,
        productCode: normalizeText(topologyDisplay?.productCode),
      },
    },
    createDefaultMonitorConfig({
      id: createMonitorId(displayKey),
      displayKey,
      roleLabel: "可接管屏幕",
      displayName: detectedName,
      match: {
        gdiDeviceName: deviceName,
        productCode: normalizeText(topologyDisplay?.productCode),
      },
    })
  );
}

function getWindowsHeuristicDetachedTakeoverDisplays(topologyDisplays, usedDeviceNames) {
  const usedNames = usedDeviceNames instanceof Set ? usedDeviceNames : new Set();
  const detachedDisplays = Array.isArray(topologyDisplays)
    ? topologyDisplays.filter(
        (display) =>
          !display.attached &&
          !usedNames.has(normalizeText(display.deviceName).toLowerCase()) &&
          isWindowsPhysicalDetachedDisplayCandidate(display)
      )
    : [];

  const namedDisplays = detachedDisplays.filter((display) => getWindowsUsableDetachedDisplayName(display));
  if (namedDisplays.length > 0) {
    return namedDisplays;
  }

  const attachedNumbers = Array.isArray(topologyDisplays)
    ? topologyDisplays
        .filter((display) => display.attached)
        .map((display) => getWindowsDisplayDeviceNumber(display.deviceName))
        .filter(Number.isInteger)
    : [];
  const genericCandidates = detachedDisplays
    .map((display) => ({
      display,
      deviceNumber: getWindowsDisplayDeviceNumber(display.deviceName),
    }))
    .filter((entry) => Number.isInteger(entry.deviceNumber))
    .sort((left, right) => left.deviceNumber - right.deviceNumber);

  if (genericCandidates.length === 0) {
    return [];
  }

  if (attachedNumbers.length === 0) {
    return [genericCandidates[0].display];
  }

  const preferredDeviceNumber = Math.max(...attachedNumbers) + 1;
  const preferredCandidate =
    genericCandidates.find((entry) => entry.deviceNumber === preferredDeviceNumber) ||
    genericCandidates.find((entry) => entry.deviceNumber > Math.min(...attachedNumbers)) ||
    genericCandidates[0];
  return preferredCandidate ? [preferredCandidate.display] : [];
}

function isWindowsPhysicalDetachedDisplayCandidate(display) {
  const deviceName = normalizeText(display?.deviceName);
  if (!deviceName || !/^\\\\\.\\DISPLAY\d+$/iu.test(deviceName)) {
    return false;
  }

  const text = [
    display?.deviceString,
    display?.displayName,
    display?.friendlyName,
    display?.productCode,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .join(" ");

  return !/\b(gameviewer|todesk|raylink|virtual|idd|indirect|spacedesk|parsec|dummy)\b/u.test(text);
}

function getWindowsUsableDetachedDisplayName(display) {
  for (const value of [display?.friendlyName, display?.displayName, display?.productCode]) {
    const normalized = normalizeText(value);
    if (normalized && !isWindowsGenericDetachedDisplayName(normalized)) {
      return normalized;
    }
  }

  return "";
}

function isWindowsGenericDetachedDisplayName(value) {
  const normalized = normalizeText(value);
  return (
    !normalized ||
    /^VEN_/iu.test(normalized) ||
    /^AMD Radeon\b/iu.test(normalized) ||
    /\bvirtual\b/iu.test(normalized)
  );
}

function getWindowsDisplayDeviceNumber(deviceName) {
  const match = /^\\\\\.\\DISPLAY(\d+)$/iu.exec(normalizeText(deviceName));
  return match ? Number.parseInt(match[1], 10) : NaN;
}

async function getMonitorContextById(monitorId) {
  const monitorContexts = await getConnectedMonitorContexts();
  return monitorContexts.find((monitorContext) => monitorContext.id === normalizeText(monitorId)) || null;
}

async function syncMonitorConfigsFromLocalDisplays({
  persist = true,
  forceMacDisplayMetadataRefresh = false,
} = {}) {
  const displaySummaries = await getLocalDisplaySummaries({
    forceMacDisplayMetadataRefresh,
  });
  const storedMonitorConfigs = getStoredMonitorConfigs();
  const unmatchedStoredMonitorConfigs = storedMonitorConfigs.filter(
    (monitorConfig) => normalizeText(monitorConfig.displayKey)
  );
  const legacyMonitorConfig =
    storedMonitorConfigs.length === 1 && !normalizeText(storedMonitorConfigs[0].displayKey)
      ? storedMonitorConfigs[0]
      : null;
  const singleMacSoftMatchAllowed = shouldAllowSingleMacSoftDisplayMatch(
    displaySummaries,
    unmatchedStoredMonitorConfigs
  );
  let legacyMonitorConfigConsumed = false;
  const usedMonitorIds = new Set();
  const nextMonitorConfigs = [];
  const resolvedDisplaySummaries = [];

  for (const displaySummary of displaySummaries) {
    const macHardwareDisplayKey = buildMacHardwareDisplayKey(displaySummary);
    const matchingMonitorConfig =
      unmatchedStoredMonitorConfigs.find((monitorConfig) => {
        if (usedMonitorIds.has(monitorConfig.id)) {
          return false;
        }

        return (
          normalizeText(monitorConfig.displayKey) === displaySummary.displayKey ||
          (macHardwareDisplayKey &&
            buildMacHardwareDisplayKey(monitorConfig) === macHardwareDisplayKey) ||
          (singleMacSoftMatchAllowed &&
            isSingleMacSoftDisplayMatch(monitorConfig, displaySummary)) ||
          (Number.isInteger(displaySummary.macSystemDisplayId) &&
            monitorConfig.match?.macSystemDisplayId === displaySummary.macSystemDisplayId) ||
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

    const resolvedMonitorId = normalizeText(matchingMonitorConfig?.id) || displaySummary.id;
    const resolvedDisplaySummary = {
      ...displaySummary,
      id: resolvedMonitorId,
    };

    const nextMonitorConfig = normalizeMonitorConfig(
      {
        ...matchingMonitorConfig,
        id: resolvedMonitorId,
        displayKey: resolvedDisplaySummary.displayKey,
        roleLabel: resolvedDisplaySummary.roleLabel,
        displayName: resolvedDisplaySummary.detectedName,
        match: {
          electronDisplayId: resolvedDisplaySummary.electronDisplayId,
          macSystemDisplayId: resolvedDisplaySummary.macSystemDisplayId,
          macVendorId: resolvedDisplaySummary.macVendorId,
          macProductId: resolvedDisplaySummary.macProductId,
          macSerialNumber: resolvedDisplaySummary.macSerialNumber,
          gdiDeviceName: resolvedDisplaySummary.gdiDeviceName,
          productCode: resolvedDisplaySummary.productCode,
        },
      },
      createDefaultMonitorConfig({
        id: resolvedMonitorId,
        displayKey: resolvedDisplaySummary.displayKey,
        roleLabel: resolvedDisplaySummary.roleLabel,
        displayName: resolvedDisplaySummary.detectedName,
        match: {
          electronDisplayId: resolvedDisplaySummary.electronDisplayId,
          macSystemDisplayId: resolvedDisplaySummary.macSystemDisplayId,
          macVendorId: resolvedDisplaySummary.macVendorId,
          macProductId: resolvedDisplaySummary.macProductId,
          macSerialNumber: resolvedDisplaySummary.macSerialNumber,
          gdiDeviceName: resolvedDisplaySummary.gdiDeviceName,
          productCode: resolvedDisplaySummary.productCode,
        },
      })
    );

    usedMonitorIds.add(nextMonitorConfig.id);
    nextMonitorConfigs.push(nextMonitorConfig);
    resolvedDisplaySummaries.push(resolvedDisplaySummary);
  }

  for (const storedMonitorConfig of unmatchedStoredMonitorConfigs) {
    if (usedMonitorIds.has(storedMonitorConfig.id)) {
      continue;
    }

    if (shouldPreserveDisconnectedMonitorConfig(storedMonitorConfig)) {
      nextMonitorConfigs.push(normalizeMonitorConfig(storedMonitorConfig));
    }
  }

  const knownMonitorIds = new Set(nextMonitorConfigs.map((monitorConfig) => monitorConfig.id));
  const prunedRuntimeState = pruneStateForKnownMonitorIds(knownMonitorIds);
  const nextSerialized = JSON.stringify(nextMonitorConfigs);
  const previousSerialized = JSON.stringify(storedMonitorConfigs);
  if (nextSerialized !== previousSerialized || prunedRuntimeState) {
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

  return resolvedDisplaySummaries;
}

function shouldPreserveDisconnectedMonitorConfig(monitorConfig) {
  if (process.platform !== "win32") {
    return false;
  }

  return Boolean(
    normalizeText(monitorConfig?.match?.gdiDeviceName) ||
      getExistingMonitorDesktopRuntime(monitorConfig.id)?.pendingRestore
  );
}

function getExistingMonitorDesktopRuntime(monitorId) {
  const normalizedId = normalizeText(monitorId);
  if (!normalizedId) {
    return null;
  }

  return state.windowsDesktop?.byMonitorId?.[normalizedId] || null;
}

function pruneStateForKnownMonitorIds(knownMonitorIds) {
  if (!(knownMonitorIds instanceof Set)) {
    return false;
  }

  let changed = false;
  const lastTargetMonitorId = normalizeText(state.lastTarget).split(":")[0];
  if (lastTargetMonitorId && !knownMonitorIds.has(lastTargetMonitorId)) {
    state.lastTarget = "";
    changed = true;
  }

  const lastSwitchOutcome = createSwitchOutcome(state.lastSwitchOutcome);
  if (
    shouldClearPersistedSwitchOutcome(lastSwitchOutcome) ||
    (lastSwitchOutcome.monitorId && !knownMonitorIds.has(lastSwitchOutcome.monitorId))
  ) {
    state.lastSwitchOutcome = createSwitchOutcome();
    changed = true;
  }

  const runtimeMap = state.windowsDesktop?.byMonitorId;
  if (runtimeMap && typeof runtimeMap === "object") {
    for (const monitorId of Object.keys(runtimeMap)) {
      if (!knownMonitorIds.has(monitorId)) {
        delete runtimeMap[monitorId];
        changed = true;
      }
    }
  }

  return changed;
}

async function getLocalDisplaySummaries({ forceMacDisplayMetadataRefresh = false } = {}) {
  const orderedDisplays = getOrderedLocalDisplays();
  if (process.platform === "win32") {
    const topologyDisplays = await getWindowsTopologyDisplays();
    const attachedTopologyDisplays = topologyDisplays
      .filter((display) => display.attached)
      .sort(compareDisplayLikeObjects);
    const ddcProbeResultsByDeviceName = await getWindowsDdcProbeResultsByDeviceName(
      attachedTopologyDisplays
    );
    const switchableTopologyDisplays = mapWindowsTopologyDisplaysToElectronDisplays(
      attachedTopologyDisplays,
      orderedDisplays
    )
      .filter(({ electronDisplay }) => Boolean(electronDisplay) && !electronDisplay.internal);
    let secondaryIndex = 2;
    const singleDisplayOnly = switchableTopologyDisplays.length <= 1;

    return withDisplayNameUniqueness(
      switchableTopologyDisplays.map(({ topologyDisplay, electronDisplay }, index) => {
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
          topologyDisplay.friendlyName ||
            topologyDisplay.displayName ||
            topologyDisplay.deviceString ||
            ""
        );
        const ddcProbe = ddcProbeResultsByDeviceName.get(
          normalizeText(topologyDisplay.deviceName).toLowerCase()
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
          ddcProbe: createDdcProbeSummary(ddcProbe, "Windows 没有找到可用的物理显示器 DDC/CI 句柄。"),
          bounds: {
            x: topologyDisplay.positionX,
            y: topologyDisplay.positionY,
            width: topologyDisplay.width,
            height: topologyDisplay.height,
          },
        };
      })
    );
  }

  const externalDisplays = orderedDisplays.filter((display) => !display.internal);
  const macProfilerDisplays = await getMacSystemProfilerDisplays({
    forceRefresh: forceMacDisplayMetadataRefresh,
  });
  const usedMacProfilerDisplayKeys = new Set();
  let secondaryIndex = 2;
  const singleDisplayOnly = externalDisplays.length <= 1;

  const externalDisplaySummaries = withDisplayNameUniqueness(
    externalDisplays.map((display, index) => {
      const macProfilerDisplay = matchMacSystemProfilerDisplay(
        display,
        macProfilerDisplays,
        usedMacProfilerDisplayKeys
      );
      const roleLabel = singleDisplayOnly
        ? "当前机器屏幕"
        : display.primary
          ? "主屏幕"
          : `附屏幕 ${secondaryIndex++}`;
      const displayKey = buildDisplayKeyForLocalDisplay(display, index + 1, null, macProfilerDisplay);
      const detectedName = normalizeText(macProfilerDisplay?.name || display.label || "");

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
        macSystemDisplayId: Number.isInteger(macProfilerDisplay?.systemDisplayId)
          ? macProfilerDisplay.systemDisplayId
          : null,
        macVendorId: normalizeText(macProfilerDisplay?.vendorId).toLowerCase(),
        macProductId: normalizeText(macProfilerDisplay?.productId).toLowerCase(),
        macSerialNumber: normalizeText(macProfilerDisplay?.serialNumber),
        gdiDeviceName: "",
        productCode: "",
        bounds: {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
        },
      };
    })
  );

  return attachMacDdcProbeResults(externalDisplaySummaries);
}

function withDisplayNameUniqueness(displaySummaries) {
  const displayNameCounts = new Map();

  for (const displaySummary of displaySummaries) {
    const normalizedName = normalizeText(displaySummary?.detectedName).toLowerCase();
    if (!normalizedName) {
      continue;
    }

    displayNameCounts.set(normalizedName, (displayNameCounts.get(normalizedName) || 0) + 1);
  }

  return displaySummaries.map((displaySummary) => {
    const normalizedName = normalizeText(displaySummary?.detectedName).toLowerCase();
    return {
      ...displaySummary,
      displayNameIsUnique: normalizedName ? displayNameCounts.get(normalizedName) === 1 : false,
    };
  });
}

function getOrderedLocalDisplays() {
  try {
    const primaryDisplayId = screen.getPrimaryDisplay()?.id;
    return [...screen.getAllDisplays()]
      .map((display) => ({
        ...display,
        primary: Number.isInteger(primaryDisplayId) && display.id === primaryDisplayId,
      }))
      .sort(compareDisplayLikeObjects);
  } catch {
    return [];
  }
}

function getConnectedDisplayCount() {
  return getOrderedLocalDisplays().length;
}

function getHealthConnectedMonitorSummaries() {
  const externalDisplays = getOrderedLocalDisplays().filter((display) => !display.internal);
  const storedMonitorConfigs = getStoredMonitorConfigs();
  const singleDisplayOnly = externalDisplays.length <= 1;
  let secondaryIndex = 2;

  return externalDisplays.map((display, index) => {
    const matchedMonitorConfig = storedMonitorConfigs.find(
      (monitorConfig) => monitorConfig.match?.electronDisplayId === display.id
    );
    const roleLabel = matchedMonitorConfig
      ? matchedMonitorConfig.roleLabel
      : singleDisplayOnly
        ? "当前机器屏幕"
        : display.primary
          ? "主屏幕"
          : `附屏幕 ${secondaryIndex++}`;
    const displayName =
      normalizeText(display.label) || getMonitorDisplayName(matchedMonitorConfig) || "本机屏幕";

    return {
      id:
        normalizeText(matchedMonitorConfig?.id) ||
        createMonitorId(
          `health:${Number.isInteger(display.id) ? display.id : index + 1}:${
            display.bounds?.x || 0
          }:${display.bounds?.y || 0}:${display.bounds?.width || 0}x${
            display.bounds?.height || 0
          }`
        ),
      title: displayName ? `${roleLabel} · ${displayName}` : roleLabel || "本机屏幕",
    };
  });
}

function buildDisplayKeyForLocalDisplay(
  display,
  displayIndex,
  topologyDisplay = null,
  macProfilerDisplay = null
) {
  if (process.platform === "win32") {
    const gdiDeviceName = normalizeText(topologyDisplay?.deviceName);
    if (gdiDeviceName) {
      return `win:${gdiDeviceName}`;
    }

    if (Number.isInteger(display?.id)) {
      return `win-electron:${display.id}`;
    }
  }

  if (process.platform === "darwin") {
    const hardwareDisplayKey = buildMacHardwareDisplayKey(macProfilerDisplay);
    if (hardwareDisplayKey) {
      return hardwareDisplayKey;
    }

    const systemDisplayId = normalizeDisplayIdentifier(macProfilerDisplay?.systemDisplayId);
    if (Number.isInteger(systemDisplayId)) {
      return `mac-system:${systemDisplayId}`;
    }

    if (Number.isInteger(display?.id)) {
      return `mac:${display.id}`;
    }
  }

  return `fallback:${displayIndex}:${display?.bounds?.x || 0}:${display?.bounds?.y || 0}:${
    display?.bounds?.width || 0
  }x${display?.bounds?.height || 0}`;
}

function createMonitorId(displayKey) {
  const normalizedKey = normalizeText(displayKey) || crypto.randomBytes(6).toString("hex");
  return `monitor-${crypto.createHash("sha1").update(normalizedKey).digest("hex").slice(0, 12)}`;
}

async function getMacSystemProfilerDisplays({ forceRefresh = false } = {}) {
  if (process.platform !== "darwin") {
    return [];
  }

  const cachedDisplays =
    !forceRefresh &&
    Array.isArray(macDisplayMetadataCache.displays) &&
    macDisplayMetadataCache.displays.length > 0 &&
    Date.now() - macDisplayMetadataCache.fetchedAt < MAC_DISPLAY_METADATA_CACHE_TTL_MS
      ? macDisplayMetadataCache.displays
      : null;

  if (cachedDisplays) {
    return cachedDisplays;
  }

  try {
    const output = await runCommand("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], {
      timeout: SYSTEM_PROFILER_COMMAND_TIMEOUT_MS,
    });
    const parsed = JSON.parse(output);
    const displays = normalizeMacSystemProfilerDisplays(parsed);
    macDisplayMetadataCache = {
      fetchedAt: Date.now(),
      displays,
    };
    return displays;
  } catch (error) {
    appendDiagnosticLog("Failed to read macOS display metadata", error);
    if (forceRefresh) {
      macDisplayMetadataCache = {
        fetchedAt: 0,
        displays: [],
      };
      return [];
    }

    return Array.isArray(macDisplayMetadataCache.displays) ? macDisplayMetadataCache.displays : [];
  }
}

function normalizeMacSystemProfilerDisplays(parsed) {
  const gpuEntries = Array.isArray(parsed?.SPDisplaysDataType) ? parsed.SPDisplaysDataType : [];
  const displays = [];

  for (const gpuEntry of gpuEntries) {
    const monitorEntries = Array.isArray(gpuEntry?.spdisplays_ndrvs) ? gpuEntry.spdisplays_ndrvs : [];
    for (const monitorEntry of monitorEntries) {
      if (normalizeText(monitorEntry?.spdisplays_online) === "spdisplays_no") {
        continue;
      }

      const resolution = parseMacSystemProfilerResolution(
        monitorEntry?._spdisplays_pixels || monitorEntry?.spdisplays_pixelresolution
      );
      displays.push({
        name: normalizeText(monitorEntry?._name),
        systemDisplayId: normalizeDisplayIdentifier(monitorEntry?._spdisplays_displayID),
        vendorId: normalizeText(monitorEntry?.["_spdisplays_display-vendor-id"]).toLowerCase(),
        productId: normalizeText(monitorEntry?.["_spdisplays_display-product-id"]).toLowerCase(),
        serialNumber: normalizeText(monitorEntry?.["_spdisplays_display-serial-number"]),
        width: resolution.width,
        height: resolution.height,
      });
    }
  }

  return displays;
}

function parseMacSystemProfilerResolution(value) {
  const match = /(\d+)\s*x\s*(\d+)/u.exec(normalizeText(value));
  if (!match) {
    return {
      width: 0,
      height: 0,
    };
  }

  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function matchMacSystemProfilerDisplay(display, profilerDisplays, usedProfilerDisplayKeys) {
  if (!Array.isArray(profilerDisplays) || profilerDisplays.length === 0) {
    return null;
  }

  const availableDisplays = profilerDisplays.filter((candidate) => {
    const candidateKey = getMacProfilerDisplayMatchKey(candidate);
    return candidateKey && !usedProfilerDisplayKeys.has(candidateKey);
  });

  const exactIdMatch =
    availableDisplays.find(
      (candidate) =>
        Number.isInteger(candidate.systemDisplayId) &&
        Number.isInteger(display?.id) &&
        candidate.systemDisplayId === display.id
    ) || null;

  if (exactIdMatch) {
    usedProfilerDisplayKeys.add(getMacProfilerDisplayMatchKey(exactIdMatch));
    return exactIdMatch;
  }

  const displayLabel = normalizeText(display?.label).toLowerCase();
  const nameAndResolutionMatches = availableDisplays.filter(
    (candidate) =>
      normalizeText(candidate.name).toLowerCase() === displayLabel &&
      isMacProfilerDisplayResolutionMatch(candidate, display)
  );

  if (nameAndResolutionMatches.length === 1) {
    usedProfilerDisplayKeys.add(getMacProfilerDisplayMatchKey(nameAndResolutionMatches[0]));
    return nameAndResolutionMatches[0];
  }

  return null;
}

function isMacProfilerDisplayResolutionMatch(candidate, display) {
  const logicalWidth = Number.isFinite(display?.bounds?.width) ? display.bounds.width : 0;
  const logicalHeight = Number.isFinite(display?.bounds?.height) ? display.bounds.height : 0;
  const scaleFactor =
    Number.isFinite(display?.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
  const physicalWidth = Math.round(logicalWidth * scaleFactor);
  const physicalHeight = Math.round(logicalHeight * scaleFactor);

  return (
    (candidate.width === logicalWidth && candidate.height === logicalHeight) ||
    (candidate.width === physicalWidth && candidate.height === physicalHeight)
  );
}

function getMacProfilerDisplayMatchKey(display) {
  const hardwareDisplayKey = buildMacHardwareDisplayKey(display);
  if (hardwareDisplayKey) {
    return hardwareDisplayKey;
  }

  if (Number.isInteger(display?.systemDisplayId)) {
    return `mac-system:${display.systemDisplayId}`;
  }

  return normalizeText(display?.name)
    ? `mac-name:${normalizeText(display.name).toLowerCase()}:${display?.width || 0}x${display?.height || 0}`
    : "";
}

function buildMacHardwareDisplayKey(monitorContextOrDisplay) {
  const vendorId = normalizeText(
    monitorContextOrDisplay?.display?.macVendorId ||
      monitorContextOrDisplay?.match?.macVendorId ||
      monitorContextOrDisplay?.macVendorId ||
      monitorContextOrDisplay?.vendorId
  ).toLowerCase();
  const productId = normalizeText(
    monitorContextOrDisplay?.display?.macProductId ||
      monitorContextOrDisplay?.match?.macProductId ||
      monitorContextOrDisplay?.macProductId ||
      monitorContextOrDisplay?.productId
  ).toLowerCase();
  const serialNumber = normalizeText(
    monitorContextOrDisplay?.display?.macSerialNumber ||
      monitorContextOrDisplay?.match?.macSerialNumber ||
      monitorContextOrDisplay?.macSerialNumber ||
      monitorContextOrDisplay?.serialNumber
  );

  if (
    !vendorId ||
    !productId ||
    !serialNumber ||
    /^(0+|1+)$/u.test(serialNumber) ||
    /^unknown$/iu.test(serialNumber)
  ) {
    return "";
  }

  return `mac-hw:${vendorId}:${productId}:${serialNumber}`;
}

function shouldAllowSingleMacSoftDisplayMatch(displaySummaries, unmatchedStoredMonitorConfigs) {
  return (
    process.platform === "darwin" &&
    Array.isArray(displaySummaries) &&
    displaySummaries.length === 1 &&
    Array.isArray(unmatchedStoredMonitorConfigs) &&
    unmatchedStoredMonitorConfigs.length === 1
  );
}

function isSingleMacSoftDisplayMatch(monitorConfig, displaySummary) {
  const storedSoftKey = buildMacSoftDisplayKey(monitorConfig);
  const displaySoftKey = buildMacSoftDisplayKey(displaySummary);
  return Boolean(storedSoftKey && displaySoftKey && storedSoftKey === displaySoftKey);
}

function buildMacSoftDisplayKey(monitorContextOrDisplay) {
  const vendorId = normalizeText(
    monitorContextOrDisplay?.display?.macVendorId ||
      monitorContextOrDisplay?.match?.macVendorId ||
      monitorContextOrDisplay?.macVendorId ||
      monitorContextOrDisplay?.vendorId
  ).toLowerCase();
  const productId = normalizeText(
    monitorContextOrDisplay?.display?.macProductId ||
      monitorContextOrDisplay?.match?.macProductId ||
      monitorContextOrDisplay?.macProductId ||
      monitorContextOrDisplay?.productId
  ).toLowerCase();
  const displayName = normalizeText(
    monitorContextOrDisplay?.display?.detectedName ||
      monitorContextOrDisplay?.display?.displayName ||
      monitorContextOrDisplay?.detectedName ||
      monitorContextOrDisplay?.displayName ||
      monitorContextOrDisplay?.name
  ).toLowerCase();

  if (!vendorId || !productId || !displayName) {
    return "";
  }

  return `mac-soft:${vendorId}:${productId}:${displayName}`;
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

async function getWindowsDdcProbeResultsByDeviceName(attachedTopologyDisplays) {
  if (!Array.isArray(attachedTopologyDisplays) || attachedTopologyDisplays.length === 0) {
    return new Map();
  }

  const probeResults = await mapSequential(
    attachedTopologyDisplays,
    async (topologyDisplay) => ({
      topologyDisplay,
      probeResult: await getWindowsDdcProbeResult(topologyDisplay),
    })
  );

  return new Map(
    probeResults
      .map(({ topologyDisplay, probeResult }) => [
        normalizeText(topologyDisplay?.deviceName).toLowerCase(),
        probeResult,
      ])
      .filter(([deviceName]) => Boolean(deviceName))
  );
}

async function getWindowsDdcProbeResult(topologyDisplay) {
  const deviceName = normalizeText(topologyDisplay?.deviceName);
  if (!deviceName) {
    return {
      ok: false,
      error: "Windows topology display did not include a GDI device name.",
    };
  }

  const cacheKey = deviceName.toLowerCase();
  const cachedResult = windowsDdcProbeCache.get(cacheKey);
  if (cachedResult && Date.now() - cachedResult.checkedAt < DDC_PROBE_CACHE_TTL_MS) {
    return cachedResult;
  }

  const monitorConfig = findStoredMonitorConfigForTopologyDisplay(topologyDisplay);
  if (monitorConfig && isWindowsTakeoverInProgress(monitorConfig)) {
    const settlingResult = {
      ok: cachedResult?.ok !== false,
      status: "settling",
      checkedAt: Date.now(),
      error: cachedResult?.ok === false ? cachedResult.error : "",
    };
    windowsDdcProbeCache.set(cacheKey, settlingResult);
    return settlingResult;
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  try {
    const output = await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-GdiDeviceName",
      deviceName,
      "-ProbeDdc",
    ], {
      timeout: WINDOWS_DDC_PROBE_TIMEOUT_MS,
    });
    const parsed = JSON.parse(output);
    const nextResult = {
      ok: Boolean(parsed?.ok) && Number(parsed?.physicalMonitorCount || 0) > 0,
      status: Boolean(parsed?.ok) ? "ok" : "failed",
      checkedAt: Date.now(),
      error: "",
    };
    windowsDdcProbeCache.set(cacheKey, nextResult);
    return nextResult;
  } catch (error) {
    const nextResult = {
      ok: false,
      status: "failed",
      checkedAt: Date.now(),
      error: normalizeText(error.message),
    };
    windowsDdcProbeCache.set(cacheKey, nextResult);
    appendDiagnosticLog(`Windows DDC probe failed for ${deviceName}`, error);
    return nextResult;
  }
}

function getWindowsElectronDisplayBoundsCandidates(display) {
  const logicalBounds = {
    x: Number.isFinite(display?.bounds?.x) ? display.bounds.x : 0,
    y: Number.isFinite(display?.bounds?.y) ? display.bounds.y : 0,
    width: Number.isFinite(display?.bounds?.width) ? display.bounds.width : 0,
    height: Number.isFinite(display?.bounds?.height) ? display.bounds.height : 0,
  };
  const scaleFactor =
    Number.isFinite(display?.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
  const physicalBounds = {
    x: Math.round(logicalBounds.x * scaleFactor),
    y: Math.round(logicalBounds.y * scaleFactor),
    width: Math.round(logicalBounds.width * scaleFactor),
    height: Math.round(logicalBounds.height * scaleFactor),
  };
  const boundsCandidates = [logicalBounds, physicalBounds];
  const uniqueBoundsCandidates = [];
  const seenKeys = new Set();

  for (const candidate of boundsCandidates) {
    const key = `${candidate.x}:${candidate.y}:${candidate.width}x${candidate.height}`;
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    uniqueBoundsCandidates.push(candidate);
  }

  return uniqueBoundsCandidates;
}

function doesWindowsElectronDisplayExactlyMatchTopology(topologyDisplay, display) {
  return getWindowsElectronDisplayBoundsCandidates(display).some(
    (candidate) =>
      topologyDisplay.positionX === candidate.x &&
      topologyDisplay.positionY === candidate.y &&
      topologyDisplay.width === candidate.width &&
      topologyDisplay.height === candidate.height
  );
}

function doesWindowsElectronDisplaySizeMatchTopology(topologyDisplay, display) {
  return getWindowsElectronDisplayBoundsCandidates(display).some(
    (candidate) =>
      topologyDisplay.width === candidate.width && topologyDisplay.height === candidate.height
  );
}

function mapWindowsTopologyDisplaysToElectronDisplays(attachedTopologyDisplays, orderedDisplays) {
  if (!Array.isArray(attachedTopologyDisplays) || attachedTopologyDisplays.length === 0) {
    return [];
  }

  const matches = attachedTopologyDisplays.map((topologyDisplay) => ({
    topologyDisplay,
    electronDisplay: null,
  }));
  const usedElectronDisplayIds = new Set();

  for (const match of matches) {
    const exactCandidates = orderedDisplays.filter(
      (display) =>
        !usedElectronDisplayIds.has(display.id) &&
        doesWindowsElectronDisplayExactlyMatchTopology(match.topologyDisplay, display)
    );

    if (exactCandidates.length === 1) {
      match.electronDisplay = exactCandidates[0];
      usedElectronDisplayIds.add(exactCandidates[0].id);
    }
  }

  for (const match of matches.filter((item) => !item.electronDisplay)) {
    const sizeCandidates = orderedDisplays.filter(
      (display) =>
        !usedElectronDisplayIds.has(display.id) &&
        Boolean(display.primary) === Boolean(match.topologyDisplay.primary) &&
        doesWindowsElectronDisplaySizeMatchTopology(match.topologyDisplay, display)
    );

    if (sizeCandidates.length === 1) {
      match.electronDisplay = sizeCandidates[0];
      usedElectronDisplayIds.add(sizeCandidates[0].id);
    }
  }

  return matches;
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
  const commandTask = () =>
    runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      topologyScriptPath,
      ...args,
    ], {
      timeout: WINDOWS_TOPOLOGY_COMMAND_TIMEOUT_MS,
    });

  const nextOperation = windowsTopologyOperationQueue.then(commandTask, commandTask);
  windowsTopologyOperationQueue = nextOperation.catch(() => {});
  return nextOperation;
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

function getUsageIntroText() {
  if (process.platform === "win32") {
    return "把共享屏当成一块可以交接的屏幕：Windows 有画面时用“交给 Mac mini / 对方机器”，共享屏在对方机器时用“接回 Windows 的共享屏”。DP/HDMI 数值只是高级校准。";
  }

  if (process.platform === "darwin") {
    return "把共享屏当成一块可以交接的屏幕：这台 Mac 有画面时用“交给 Windows / 对方机器”。屏幕已经切走后，Mac 不负责远程抢回，由 Windows 接回或用显示器菜单。";
  }

  return "把共享屏当成一块可以交接的屏幕：当前机器有画面时交给对方，屏幕在对方机器时由能看见/能控制它的机器接回。";
}

function renderUsageGuide() {
  const items =
    process.platform === "win32"
      ? [
          {
            title: "交给对方",
            body: "共享屏现在显示 Windows 画面时，点“交给 Mac mini / 对方机器”。软件会切到 HDMI1，并把这块屏从 Windows 桌面移除。",
          },
          {
            title: "接回 Windows",
            body: "共享屏现在在 Mac mini 上时，点“接回 Windows 的共享屏”。软件会先把屏幕加回 Windows 桌面，再切回 Windows 接口。",
          },
          {
            title: "灰色第二屏",
            body: "Windows 设置里还能看到灰色第二屏，通常只是拓扑残留或等待接回，不等于 Windows 已经真正拿到画面。卡住时再用高级修复。",
          },
        ]
      : process.platform === "darwin"
        ? [
            {
              title: "交给 Windows",
              body: "共享屏现在显示 Mac 画面时，点“交给 Windows / 对方机器”。这只是把当前可见屏幕切到 Windows 输入。",
            },
            {
              title: "不远程抢回",
              body: "屏幕已经切走后，Mac 可能看不到菜单栏，也不会假装能远程抢回；请从 Windows 接回，或用显示器实体菜单。",
            },
            {
              title: "只校准数值",
              body: "DP/HDMI 的 DDC 数值只在高级配置里调整。显示器菜单名和 DDC 数值不一致时，只改数值，不改日常按钮含义。",
            },
          ]
        : [
            {
              title: "交给对方",
              body: "共享屏在当前机器上时，从当前机器把它切到对方输入。",
            },
            {
              title: "本机接回",
              body: "共享屏在对方机器上时，由能看见或能控制这块屏的机器把它接回。",
            },
            {
              title: "高级配置",
              body: "DP/HDMI 数值、单独输入源、状态修复只用于校准和异常处理。",
            },
          ];

  return `<div class="card soft">
    <div class="section-title">日常逻辑</div>
    <div class="help" style="margin-top: 10px;">这不是两台电脑互相联网控制，而是“当前能控制这块屏的机器”对显示器发送 DDC/CI 切换命令。</div>
    <div class="usage-grid">
      ${items
        .map(
          (item) => `<div class="usage-step">
            <div class="usage-kicker">${escapeHtml(item.title)}</div>
            <div class="help">${escapeHtml(item.body)}</div>
          </div>`
        )
        .join("")}
    </div>
  </div>`;
}

function renderSettingsPage(requestUrl, monitorContexts, windowsTakeoverContexts = []) {
  const status = requestUrl.searchParams.get("status");
  const message = requestUrl.searchParams.get("message");
  const statusHtml = renderSettingsBanner(status, message);
  const windowsTakeoverHtml =
    process.platform === "win32"
      ? renderWindowsTakeoverSection(windowsTakeoverContexts)
      : "";
  const globalRefreshHtml =
    process.platform === "win32"
      ? `<details class="advanced">
          <summary>高级：修复 Windows 屏幕状态</summary>
          <div class="help" style="margin-top: 12px;">只有在显卡状态卡住、共享屏已经回到 Windows 但系统没自动加回桌面，或者 Windows 设置里残留了灰色第二屏时才需要点。</div>
          <form method="post" action="/api/${encodeURIComponent(
            state.controlToken
          )}/windows/refresh" style="margin-top: 16px;">
            <button type="submit" class="secondary">手动修复 Windows 屏幕状态</button>
          </form>
        </details>`
      : "";
  const contentHtml =
    monitorContexts.length === 0
      ? `<div class="card soft">
          <div class="section-title">当前没有本机已连接屏幕</div>
          <div class="help" style="margin-top: 12px;">识别到几块本机屏幕就显示几块。当前这台机器没有读到可展示的本机屏幕。</div>
        </div>`
      : `<section class="stack">
          <div class="section-heading">当前在 ${escapeHtml(getLocalMachineLabel())} 上的屏幕</div>
          ${monitorContexts.map(renderMonitorSection).join("")}
        </section>`;

  return `<!doctype html>
<html lang="zh-CN">
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
    .section-heading {
      font-size: 15px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent-strong);
    }
    .usage-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .usage-step {
      padding: 15px;
      border-radius: 18px;
      border: 1px solid rgba(13, 107, 98, 0.16);
      background: rgba(255, 255, 255, 0.58);
    }
    .usage-kicker {
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent-strong);
      margin-bottom: 8px;
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
    .daily-actions {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 0.95fr);
      gap: 12px;
      margin-top: 16px;
    }
    .daily-card {
      padding: 16px;
      border-radius: 20px;
      border: 1px solid rgba(13, 107, 98, 0.18);
      background: rgba(231, 245, 237, 0.72);
    }
    .daily-card.muted {
      border-color: var(--border);
      background: rgba(255, 255, 255, 0.52);
    }
    .advanced {
      padding: 14px;
      border-radius: 18px;
      border: 1px dashed rgba(31, 42, 44, 0.2);
      background: rgba(255, 255, 255, 0.36);
    }
    .advanced summary {
      cursor: pointer;
      font-weight: 800;
      color: var(--accent-strong);
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
      .usage-grid,
      .daily-actions {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">本机控制 · v${escapeHtml(app.getVersion())}</div>
    <h1>${escapeHtml(APP_NAME)} 设置</h1>
    <p>${escapeHtml(getUsageIntroText())}</p>
    <div class="stack">
      ${statusHtml}
      ${renderUsageGuide()}
      ${windowsTakeoverHtml}
      ${globalRefreshHtml}
      ${contentHtml}
    </div>
  </main>
</body>
</html>`;
}

function renderWindowsTakeoverSection(windowsTakeoverContexts) {
  const contexts = Array.isArray(windowsTakeoverContexts) ? windowsTakeoverContexts : [];
  const contentHtml =
    contexts.length === 0
      ? `<div class="help" style="margin-top: 12px;">当前没有需要接回的共享屏。如果共享屏已经在 ${escapeHtml(
          getLocalMachineLabel()
        )} 上，它会出现在下面的“当前在 ${escapeHtml(
          getLocalMachineLabel()
        )} 上的屏幕”里；如果它正在对方机器上，且 Windows 还能看到断开的显示设备，接回按钮才会出现在这里。</div>`
      : contexts.map(renderWindowsTakeoverCard).join("");

  return `<div class="card soft">
    <div class="section-title">接回 ${escapeHtml(getLocalMachineLabel())}</div>
    <div class="help" style="margin-top: 12px;">用于“共享屏现在给对方机器用，我要把它拿回这台电脑”。软件会先把共享屏加回 Windows 桌面，再切到当前机器接口。这个动作依赖显卡和显示器在切到别的输入源时仍允许 Windows 控制 DDC/CI。</div>
    <div class="stack" style="margin-top: 16px;">
      ${contentHtml}
    </div>
  </div>`;
}

function renderWindowsTakeoverCard(monitorContext) {
  const localTarget = getTarget(getLocalInterfaceId(monitorContext.monitor), monitorContext.monitor);
  const runtime = getExistingMonitorDesktopRuntime(monitorContext.id);
  const candidateSourceText =
    monitorContext.takeoverSource === "heuristic"
      ? "识别来源：Windows 拓扑推断"
      : runtime?.pendingRestore
        ? "识别来源：等待接回记录"
        : "识别来源：已保存屏幕配置";

  return `<div class="interface-card">
    <div class="section-title">${escapeHtml(getMonitorDisplayTitle(monitorContext))}</div>
    <div class="display-meta">
      ${escapeHtml(getMonitorSystemIdentityText(monitorContext))}<br>
      ${escapeHtml(candidateSourceText)}<br>
      接回目标：${escapeHtml(getLocalMachineLabel())}（${escapeHtml(localTarget.label)}，输入值 ${escapeHtml(
        String(localTarget.inputValue)
      )}）
    </div>
    <form method="post" action="/api/${encodeURIComponent(
      state.controlToken
    )}/windows/takeover/${encodeURIComponent(monitorContext.id)}" style="margin-top: 14px;">
      <button type="submit">接回 ${escapeHtml(getLocalMachineLabel())}</button>
    </form>
    <details class="advanced" style="margin-top: 14px;">
      <summary>高级：校准这块屏</summary>
      ${renderMonitorConfigForm(monitorContext)}
    </details>
  </div>`;
}

function renderMonitorSection(monitorContext) {
  const runtime = getMonitorDesktopRuntime(monitorContext.id);
  const refreshHtml =
    process.platform === "win32"
      ? `<form method="post" action="/api/${encodeURIComponent(
          state.controlToken
        )}/windows/refresh/${encodeURIComponent(monitorContext.id)}" style="margin-top: 16px;">
          <button type="submit" class="secondary">手动修复这块屏幕状态</button>
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
    ${renderDailyVisibleMonitorActions(monitorContext)}
    <details class="advanced" style="margin-top: 16px;">
      <summary>高级：单独切输入源 / 校准 DDC 值</summary>
      <div class="interface-grid">
        ${TARGET_IDS.map((targetId) => renderInterfaceStatusCard(monitorContext, targetId)).join("")}
      </div>
      ${renderMonitorConfigForm(monitorContext)}
      ${refreshHtml}
    </details>
  </div>`;
}

function renderDailyVisibleMonitorActions(monitorContext) {
  const directSwitchEnabled = isMonitorDirectSwitchEnabled(monitorContext);
  const peerTargetId = getPreferredPeerTargetId(monitorContext.monitor);
  const peerTarget = peerTargetId ? getTarget(peerTargetId, monitorContext.monitor) : null;
  const localTarget = getTarget(getLocalInterfaceId(monitorContext.monitor), monitorContext.monitor);
  const currentText = Number.isInteger(monitorContext.status.currentInputValue)
    ? `当前回读：${describeInputValue(monitorContext.status.currentInputValue)}`
    : monitorContext.status.ddcAvailable === false
      ? "当前不能确认输入源，但可以按按钮发送切换命令。"
      : "当前输入源未知，切换后可能需要人工看屏幕确认。";

  if (!peerTarget) {
    return `<div class="banner error" style="margin-top: 14px;">没有找到可交给对方机器的接口，请在高级配置里检查当前机器接口。</div>`;
  }

  return `<div class="daily-actions">
    <div class="daily-card">
      <div class="section-title">日常动作</div>
      <div class="help" style="margin-top: 10px;">
        这块屏现在在 ${escapeHtml(getLocalMachineLabel())} 上。<br>
        ${escapeHtml(currentText)}
      </div>
      <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/switch/${encodeURIComponent(
        monitorContext.id
      )}/${encodeURIComponent(peerTargetId)}" style="margin-top: 14px;">
        <button type="submit"${directSwitchEnabled ? "" : " disabled"}>
          交给${escapeHtml(getPeerMachineLabel(peerTargetId))}（${escapeHtml(peerTarget.label)}）
        </button>
      </form>
      <div class="help" style="margin-top: 10px;">
        执行后会先把显示器切到 ${escapeHtml(peerTarget.label)}；如果当前机器是 Windows，还会把这块屏从桌面里移除，让窗口回到主屏。
      </div>
    </div>
    <div class="daily-card muted">
      <div class="section-title">当前机器接口</div>
      <div class="help" style="margin-top: 10px;">
        ${escapeHtml(getLocalMachineLabel())} 使用 ${escapeHtml(localTarget.label)}。如果显示器菜单里名字和 DDC 数值不一致，只改下面高级配置里的输入值，不改日常按钮。
      </div>
    </div>
  </div>`;
}

function renderInterfaceStatusCard(monitorContext, targetId) {
  const target = getTarget(targetId, monitorContext.monitor);
  const currentInputValue = Number.isInteger(monitorContext.status.currentInputValue)
    ? monitorContext.status.currentInputValue
    : null;
  const isCurrent = Number.isInteger(currentInputValue)
    ? getExpectedProbeInputValues(target.inputValue, monitorContext.monitor).includes(currentInputValue)
    : false;
  const directSwitchEnabled = isMonitorDirectSwitchEnabled(monitorContext);

  let statusText = "连接状态未知";
  let detailText = "未激活接口是否真的接了机器，DDC/CI 不能无损读出来。";
  if (!monitorContext.status.visible) {
    statusText = "当前不在本机";
    detailText = "这块屏当前不在本机桌面里，所以本机无法直接读取它的当前输入。";
  } else if (monitorContext.status.ddcAvailable === false) {
    statusText = "当前不可控";
    detailText = monitorContext.status.ddcUnavailableReason;
  } else if (isCurrent) {
    statusText = "当前正在显示";
    detailText = `当前输入回报：${describeInputValue(currentInputValue)}。`;
  } else if (Number.isInteger(currentInputValue)) {
    statusText = "当前未显示";
    detailText = `当前输入回报：${describeInputValue(currentInputValue)}。`;
  } else if (monitorContext.status.currentInputError) {
    statusText = "当前输入未知";
    detailText =
      monitorContext.status.ddcProbeStatus === "targetable-unconfirmed"
        ? "DDC 目标可定位但未确认可回读或写入；切换命令可发送，结果需人工确认。"
        : "当前显示器没有提供可靠回读，结果不能自动确认。";
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

  return buildMacMonitorSystemIdentityText(monitorContext) || "Display ID：未知";
}

function buildMacMonitorSystemIdentityText(monitorContextOrConfig) {
  const hardwareDisplayKey = buildMacHardwareDisplayKey(monitorContextOrConfig);
  const displayId = normalizeDisplayIdentifier(
    monitorContextOrConfig?.display?.macSystemDisplayId ||
      monitorContextOrConfig?.match?.macSystemDisplayId ||
      monitorContextOrConfig?.display?.electronDisplayId ||
      monitorContextOrConfig?.match?.electronDisplayId
  );

  if (!hardwareDisplayKey) {
    return Number.isInteger(displayId) ? `Display ID：${displayId}` : "";
  }

  const [, vendorId = "", productId = "", serialNumber = ""] = hardwareDisplayKey.split(":");
  const hardwareText = `Vendor/Product/Serial：${vendorId}/${productId}/${serialNumber}`;
  return Number.isInteger(displayId) ? `${hardwareText} · Display ID：${displayId}` : hardwareText;
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
      macSystemDisplayId: Number.isInteger(partial.match?.macSystemDisplayId)
        ? partial.match.macSystemDisplayId
        : null,
      macVendorId: normalizeText(partial.match?.macVendorId).toLowerCase(),
      macProductId: normalizeText(partial.match?.macProductId).toLowerCase(),
      macSerialNumber: normalizeText(partial.match?.macSerialNumber),
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
      macSystemDisplayId: Number.isInteger(rawMonitorConfig.match?.macSystemDisplayId)
        ? rawMonitorConfig.match.macSystemDisplayId
        : baseline.match.macSystemDisplayId,
      macVendorId:
        normalizeText(rawMonitorConfig.match?.macVendorId).toLowerCase() || baseline.match.macVendorId,
      macProductId:
        normalizeText(rawMonitorConfig.match?.macProductId).toLowerCase() ||
        baseline.match.macProductId,
      macSerialNumber:
        normalizeText(rawMonitorConfig.match?.macSerialNumber) || baseline.match.macSerialNumber,
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

function upsertStoredMonitorConfig(monitorConfig) {
  const nextMonitorConfig = normalizeMonitorConfig(monitorConfig);
  const existingIndex = getStoredMonitorConfigs().findIndex(
    (storedMonitorConfig) => storedMonitorConfig.id === nextMonitorConfig.id
  );

  if (!state.config || typeof state.config !== "object") {
    state.config = {
      monitors: [],
    };
  }

  if (!Array.isArray(state.config.monitors)) {
    state.config.monitors = [];
  }

  if (existingIndex >= 0) {
    state.config.monitors[existingIndex] = nextMonitorConfig;
    return;
  }

  state.config.monitors.push(nextMonitorConfig);
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

function getPreferredPeerTargetId(monitorConfig) {
  const localInterfaceId = getLocalInterfaceId(monitorConfig);
  const preferredTargetId =
    process.platform === "win32" ? "hdmi1" : process.platform === "darwin" ? "dp2" : "";

  if (preferredTargetId && preferredTargetId !== localInterfaceId) {
    return preferredTargetId;
  }

  return TARGET_IDS.find((targetId) => targetId !== localInterfaceId) || "";
}

function getLocalMachineLabel() {
  if (process.platform === "win32") {
    return "Windows";
  }

  if (process.platform === "darwin") {
    return "这台 Mac";
  }

  return "这台电脑";
}

function getPeerMachineLabel(targetId = "") {
  if (process.platform === "win32" && targetId === "hdmi1") {
    return "Mac mini / 对方机器";
  }

  if (process.platform === "darwin" && targetId === "dp2") {
    return "Windows / 对方机器";
  }

  return "对方机器";
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

function getExpectedProbeInputValues(inputValue, monitorConfig = null) {
  const candidates = [inputValue];
  if (!shouldUseSamsungMstarCompat(monitorConfig)) {
    return candidates;
  }

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

function normalizePersistedSwitchOutcome(rawOutcome) {
  const outcome = createSwitchOutcome(rawOutcome);
  return shouldClearPersistedSwitchOutcome(outcome) ? createSwitchOutcome() : outcome;
}

function shouldClearPersistedSwitchOutcome(outcome) {
  const normalizedOutcome = createSwitchOutcome(outcome);
  return (
    normalizedOutcome.status !== "idle" &&
    (!normalizedOutcome.monitorId || !normalizedOutcome.targetId)
  );
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
      restoreLayout: null,
    };
  }

  return state.windowsDesktop.byMonitorId[normalizedId];
}

function markMonitorPendingRestore(
  monitorId,
  expectedAttachedDisplayCount = null,
  restoreLayout = null
) {
  const runtime = getMonitorDesktopRuntime(monitorId);
  runtime.pendingRestore = true;
  runtime.expectedAttachedDisplayCount =
    Number.isInteger(expectedAttachedDisplayCount) && expectedAttachedDisplayCount > 1
      ? expectedAttachedDisplayCount
      : 0;
  runtime.restoreLayout = normalizeWindowsRestoreLayout(restoreLayout);
  saveState(state);
  void refreshMenu();
}

function clearMonitorPendingRestore(monitorId) {
  const runtime = getMonitorDesktopRuntime(monitorId);
  if (!runtime.pendingRestore && runtime.expectedAttachedDisplayCount === 0 && !runtime.restoreLayout) {
    return;
  }

  runtime.pendingRestore = false;
  runtime.expectedAttachedDisplayCount = 0;
  runtime.restoreLayout = null;
  saveState(state);
  void refreshMenu();
}

function loadState() {
  const candidates = [
    { path: getStatePath(), label: "state" },
    { path: getStateBackupPath(), label: "backup-state" },
  ];
  let sawReadFailure = false;

  for (const candidate of candidates) {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(candidate.path, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }

      sawReadFailure = true;
      appendDiagnosticLog(`Failed to read persisted ${candidate.label}`, error);
    }
  }

  if (sawReadFailure) {
    appendDiagnosticLog("Falling back to a fresh default state because no readable snapshot remained.");
  }

  return createDefaultState();
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
    lastSwitchOutcome: normalizePersistedSwitchOutcome(nextState.lastSwitchOutcome),
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
      restoreLayout: normalizeWindowsRestoreLayout(runtime?.restoreLayout),
    };
  }

  return nextRuntimeMap;
}

function normalizeWindowsRestoreLayout(rawLayout) {
  if (!rawLayout || typeof rawLayout !== "object") {
    return null;
  }

  const positionX = Number.parseInt(String(rawLayout.positionX ?? ""), 10);
  const positionY = Number.parseInt(String(rawLayout.positionY ?? ""), 10);

  if (!Number.isInteger(positionX) || !Number.isInteger(positionY)) {
    return null;
  }

  return {
    positionX,
    positionY,
  };
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
  const statePath = getStatePath();
  const backupPath = getStateBackupPath();
  const tempPath = `${statePath}.tmp-${process.pid}`;

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(normalizedState, null, 2));

  try {
    if (fs.existsSync(statePath)) {
      removeFileIfExists(backupPath);
      fs.renameSync(statePath, backupPath);
    }

    fs.renameSync(tempPath, statePath);

    try {
      fs.copyFileSync(statePath, backupPath);
    } catch (error) {
      appendDiagnosticLog("Failed to refresh state backup", error);
    }
  } finally {
    removeFileIfExists(tempPath);
  }
}

function getStatePath() {
  return path.join(app.getPath("userData"), "state.json");
}

function getStateBackupPath() {
  return `${getStatePath()}.bak`;
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

function removeFileIfExists(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Ignore cleanup failures.
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

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertFormUrlEncodedRequest(request) {
  const contentType = normalizeText(request.headers["content-type"]).split(";")[0].toLowerCase();
  if (contentType && contentType !== "application/x-www-form-urlencoded") {
    throw createHttpError(415, "仅支持 application/x-www-form-urlencoded 表单提交。");
  }
}

function readRequestBody(request, maxBytes = LOCAL_REQUEST_BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(createHttpError(413, "请求内容过大。"));
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", fail);
  });
}

function runCommand(file, args, options = {}) {
  const execOptions = {
    windowsHide: true,
    timeout: HELPER_COMMAND_TIMEOUT_MS,
    ...options,
  };

  if (options.env) {
    execOptions.env = {
      ...process.env,
      ...options.env,
    };
  }

  return new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(execOptions.timeout) ? execOptions.timeout : 0;
    const childOptions = {
      ...execOptions,
      timeout: 0,
    };
    let settled = false;
    let timeoutTimer = null;

    const settle = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      callback();
    };

    const child = execFile(file, args, childOptions, (error, stdout, stderr) => {
      const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
      settle(() => {
        if (error) {
          reject(new Error(combinedOutput || error.message));
          return;
        }

        resolve(combinedOutput);
      });
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        settle(() => {
          killProcessTree(child.pid);
          reject(new Error(`底层 helper 超时（${timeoutMs}ms）：${file}`));
        });
      }, timeoutMs);
    }
  });
}

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 5000,
      }, () => {});
    } catch {
      // Best effort: the command has already timed out from the app's perspective.
    }
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best effort only.
  }
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

async function mapSequential(items, mapper) {
  const results = [];
  for (const item of items) {
    results.push(await mapper(item));
  }
  return results;
}

async function runSwitchCandidateSequence(candidates, runCandidate) {
  let lastError = null;
  let lastUnconfirmedResult = null;

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const result = await runCandidate(candidates[index]);
      if (result?.verificationStatus === "confirmed") {
        return result;
      }

      lastUnconfirmedResult = {
        verificationStatus: "unconfirmed",
        message: normalizeText(result?.message),
      };
    } catch (error) {
      lastError = error;
    }

    if (index < candidates.length - 1) {
      await delay(300);
    }
  }

  if (lastUnconfirmedResult) {
    return lastUnconfirmedResult;
  }

  if (lastError) {
    throw lastError;
  }

  return {
    verificationStatus: "unconfirmed",
    message: "",
  };
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

function normalizeDisplayIdentifier(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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
