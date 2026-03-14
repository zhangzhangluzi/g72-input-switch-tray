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
let trayRebuildTimer = null;
let trayHealthTimer = null;
let explorerSignature = null;
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

  const menu = Menu.buildFromTemplate([
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
      label: "说明：这里显示的是上次发送目标，不是显示器实时输入",
      enabled: false,
    },
    { type: "separator" },
    {
      label: getTarget("windows").label,
      type: "radio",
      checked: state.lastTarget === "windows",
      enabled: configErrors.length === 0,
      click: () => handleTraySwitch("windows"),
    },
    {
      label: getTarget("mac").label,
      type: "radio",
      checked: state.lastTarget === "mac",
      enabled: configErrors.length === 0,
      click: () => handleTraySwitch("mac"),
    },
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
      await switchOnMac(target);
    } else {
      throw new Error(`当前平台不受支持：${process.platform}`);
    }

    state.lastTarget = targetId;
    saveState(state);
    refreshMenu();

    if (notifyOnSuccess) {
      notify(`已向 ${state.config.monitorName} 发送切换命令：${target.label}。`);
    }
  } catch (error) {
    if (showErrorDialog) {
      dialog.showErrorBox(
        APP_NAME,
        `${target.label} 切换命令发送失败。\n\n${error.message}`
      );
    }

    throw error;
  }
}

async function switchOnWindows(targetId, target) {
  const useDisplayHandoff = shouldUseWindowsDisplayHandoff(state.config);

  if (useDisplayHandoff && targetId === "windows") {
    await restoreWindowsDesktopToTargetMonitor();
    clearPendingWindowsDesktopRestore();
  }

  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const candidates = getInputCandidates(target);

  for (let index = 0; index < candidates.length; index += 1) {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-MonitorName",
      state.config.monitorName,
      "-InputValue",
      String(candidates[index]),
    ]);

    if (index < candidates.length - 1) {
      await delay(300);
    }
  }

  if (useDisplayHandoff && targetId !== "windows") {
    await delay(WINDOWS_DISPLAY_HANDOFF_DELAY_MS);
    await handOffWindowsDesktop();
    markPendingWindowsDesktopRestore();
  }
}

function switchOnMac(target) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  const candidates = getInputCandidates(target);
  return runCandidateSequence(candidates, (candidate) =>
    runCommand("/bin/sh", [scriptPath, String(candidate)], {
      env: {
        DISPLAY_NAME: state.config.monitorName,
        DISPLAY_INDEX: String(state.config.macDisplayIndex),
      },
    })
  );
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
          controlServer.listen(0, "127.0.0.1");
        }
      });
      return;
    }

    controlServerError = error;
    controlServer = null;
    refreshMenu();
    notify(`本机设置页启动失败：${error.message}`);
  });

  controlServer.listen(PREFERRED_CONTROL_PORT, "127.0.0.1", () => {
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

  if (requestUrl.pathname === "/health") {
    return writeJson(response, 200, {
      ok: true,
      appName: APP_NAME,
      lastTarget: state.lastTarget,
      monitorName: state.config.monitorName,
    });
  }

  if (requestUrl.pathname === statePath) {
    return writeJson(response, 200, {
      ok: true,
      lastTarget: state.lastTarget,
      currentLabel: getCurrentTargetLabel(),
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
  saveState(state);
  refreshMenu();

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

  if (afterResult.ok && expectedValues.includes(afterResult.value)) {
    return createMacInputProbeResult({
      targetId,
      candidate,
      status: "matched",
      beforeValue: beforeResult.ok ? beforeResult.value : null,
      afterValue: afterResult.value,
      expectedValues,
      commandError,
      message: `值 ${candidate} 已命中 ${getTargetSlotName(targetId)} 的候选集合，当前输入回报为 ${describeInputValue(afterResult.value)}。`,
    });
  }

  if (afterResult.ok && beforeResult.ok && afterResult.value === beforeResult.value) {
    return createMacInputProbeResult({
      targetId,
      candidate,
      status: "unchanged",
      beforeValue: beforeResult.value,
      afterValue: afterResult.value,
      expectedValues,
      commandError,
      message: `测试 ${candidate} 后，显示器当前输入仍是 ${describeInputValue(afterResult.value)}。`,
    });
  }

  if (afterResult.ok) {
    return createMacInputProbeResult({
      targetId,
      candidate,
      status: "different",
      beforeValue: beforeResult.ok ? beforeResult.value : null,
      afterValue: afterResult.value,
      expectedValues,
      commandError,
      message: `测试 ${candidate} 后，当前输入回报为 ${describeInputValue(afterResult.value)}，没有匹配预期集合 ${expectedValues.join(" / ")}。`,
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
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
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
    runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-MonitorName",
      monitorName,
      "-ReadInputValue",
    ]),
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
    try {
      const parsed = JSON.parse(currentInputResult.value);
      diagnostics.currentInputValue = Number.isInteger(parsed.currentInputValue)
        ? parsed.currentInputValue
        : null;
    } catch (error) {
      diagnostics.currentInputError = error.message;
    }
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
    <div class="eyebrow">Local Setup</div>
    <h1>${escapeHtml(APP_NAME)} 设置</h1>
    <p>这里定义“控制哪一台显示器”以及“两种切换模式分别发什么输入值”。实际切换请回到托盘或菜单栏操作；菜单里显示的是最近一次发送的目标，不是显示器实时输入。</p>
    <div class="stack">
      ${statusHtml}
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
              ${renderNamedOption("auto", "自动判断", state.config.windowsDisplayHandoffMode)}
              ${renderNamedOption("off", "关闭联动", state.config.windowsDisplayHandoffMode)}
              ${renderNamedOption(
                "external",
                "切到模式 B 时改为仅用副屏",
                state.config.windowsDisplayHandoffMode
              )}
            </select>
          </label>
          <div class="help">
            只影响 Windows 版。启用后，切到模式 B 时应用会调用系统“仅第二屏幕”把桌面迁到剩余屏幕；等目标显示器回到 Windows 后，再自动恢复扩展显示。
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

  return `<div>
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
  const windowsHandoffHelp = shouldUseWindowsDisplayHandoff(state.config)
    ? "当前已启用 Windows 桌面联动。切到模式 B 后，应用会把 Windows 改成仅用剩余屏幕；等这台屏回到 Windows 后，再自动恢复扩展显示。"
    : "如果切到另一台设备后 Windows 主屏内容还留在原位，可以把“Windows 桌面联动”改成自动判断或强制开启。";

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
      ["matched", "different", "inconclusive"].includes(lastProbe.status) &&
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

function getControlPath() {
  return `/control/${state.controlToken}`;
}

function getSettingsPath() {
  return `/settings/${state.controlToken}`;
}

function getLocalSettingsUrl() {
  return `http://127.0.0.1:${activeControlPort}${getSettingsPath()}`;
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

function normalizeText(value) {
  return String(value ?? "").trim();
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

      if (index >= candidates.length - 1) {
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

  if (config.windowsDisplayHandoffMode === "external") {
    return true;
  }

  if (config.windowsDisplayHandoffMode === "off") {
    return false;
  }

  try {
    return screen.getAllDisplays().length === 2;
  } catch {
    return false;
  }
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

  if (getWindowsDisplayCount() >= 2) {
    clearPendingWindowsDesktopRestore();
    notify(`已检测到 ${state.config.monitorName} 回到 Windows，桌面已恢复为扩展显示。`);
    return;
  }

  windowsRestoreInFlight = true;

  try {
    const names = await getAvailableMonitorNames();
    if (!names.includes(state.config.monitorName)) {
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
    },
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
