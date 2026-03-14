const { app, Tray, Menu, nativeImage, Notification, dialog, shell, clipboard } = require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "G72 输入切换";
const MONITOR_NAME = "G72";
const CONTROL_PORT = 3847;
const TARGETS = {
  windows: {
    id: "windows",
    label: "Windows（DP2）",
    value: 16,
  },
  mac: {
    id: "mac",
    label: "Mac mini（HDMI1）",
    value: 17,
  },
};

let tray = null;
let controlServer = null;
let controlServerError = null;
let state = { lastTarget: null, controlToken: null };

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
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  state = loadState();
  saveState(state);
  startControlServer();
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

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  if (process.platform === "win32") {
    tray.on("click", () => tray.popUpContextMenu());
    tray.on("right-click", () => tray.popUpContextMenu());
  }
}

function refreshMenu() {
  if (!tray) {
    return;
  }

  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const localControlUrl = getLocalControlUrl();
  const preferredLanControlUrl = getPreferredLanControlUrl();
  const copyControlLabel = preferredLanControlUrl ? "复制局域网控制地址" : "复制本机控制地址";

  const menu = Menu.buildFromTemplate([
    {
      label: state.lastTarget
        ? `当前输入：${TARGETS[state.lastTarget].label}`
        : "当前输入：尚未通过此应用切换",
      enabled: false,
    },
    {
      label: controlServerError
        ? `网页控制：启动失败（${controlServerError.code || "未知错误"}）`
        : `网页控制：${summarizeControlAddress(preferredLanControlUrl || localControlUrl)}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: TARGETS.windows.label,
      type: "radio",
      checked: state.lastTarget === TARGETS.windows.id,
      click: () => switchMonitor(TARGETS.windows),
    },
    {
      label: TARGETS.mac.label,
      type: "radio",
      checked: state.lastTarget === TARGETS.mac.id,
      click: () => switchMonitor(TARGETS.mac),
    },
    { type: "separator" },
    {
      label: "打开本机网页控制页",
      enabled: !controlServerError,
      click: () => shell.openExternal(localControlUrl),
    },
    {
      label: copyControlLabel,
      enabled: !controlServerError,
      click: () => copyControlUrl(preferredLanControlUrl || localControlUrl),
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

async function switchMonitor(target, options = {}) {
  const { notifyOnSuccess = true, showErrorDialog = true } = options;

  try {
    if (process.platform === "win32") {
      await switchOnWindows(target);
    } else if (process.platform === "darwin") {
      await switchOnMac(target);
    } else {
      throw new Error(`当前平台不受支持：${process.platform}`);
    }

    state.lastTarget = target.id;
    saveState(state);
    refreshMenu();

    if (notifyOnSuccess) {
      notify(`已将 ${MONITOR_NAME} 切换到 ${target.label}。`);
    }
  } catch (error) {
    if (showErrorDialog) {
      dialog.showErrorBox(
        APP_NAME,
        `${target.label} 切换失败。\n\n${error.message}`
      );
    }

    throw error;
  }
}

function switchOnWindows(target) {
  const scriptPath = getBundledResourcePath("windows", "set-input.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-MonitorName",
    MONITOR_NAME,
    "-InputValue",
    String(target.value),
  ];

  return runCommand("powershell.exe", args);
}

function switchOnMac(target) {
  const scriptPath = getBundledResourcePath("mac", "switch-input.sh");
  return runCommand("/bin/sh", [scriptPath, target.id]);
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
          message: "要卸载 G72 输入切换吗？",
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
  const tempScriptPath = path.join(os.tmpdir(), `g72-uninstall-${Date.now()}.sh`);
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
  controlServer = http.createServer((request, response) => {
    handleControlRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`控制页请求失败：${error.message}`);
    });
  });

  controlServer.on("error", (error) => {
    controlServerError = error;
    controlServer = null;
    refreshMenu();
    notify(`网页控制页启动失败：${error.message}`);
  });

  controlServer.listen(CONTROL_PORT, "0.0.0.0", () => {
    controlServerError = null;
    refreshMenu();
  });
}

async function handleControlRequest(request, response) {
  const baseUrl = `http://${request.headers.host || "127.0.0.1"}`;
  const requestUrl = new URL(request.url || "/", baseUrl);
  const controlPath = getControlPath();
  const statePath = `/api/${state.controlToken}/state`;
  const windowsPath = `/api/${state.controlToken}/switch/windows`;
  const macPath = `/api/${state.controlToken}/switch/mac`;

  if (requestUrl.pathname === "/health") {
    return writeJson(response, 200, {
      ok: true,
      appName: APP_NAME,
      lastTarget: state.lastTarget,
    });
  }

  if (requestUrl.pathname === statePath) {
    return writeJson(response, 200, {
      ok: true,
      lastTarget: state.lastTarget,
      currentLabel: getCurrentTargetLabel(),
      targets: TARGETS,
    });
  }

  if (requestUrl.pathname === controlPath) {
    return writeHtml(response, 200, renderControlPage(requestUrl));
  }

  if (requestUrl.pathname === windowsPath) {
    return handleControlSwitch(request, response, requestUrl, TARGETS.windows);
  }

  if (requestUrl.pathname === macPath) {
    return handleControlSwitch(request, response, requestUrl, TARGETS.mac);
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("未找到控制页。");
}

async function handleControlSwitch(request, response, requestUrl, target) {
  if (!["GET", "POST"].includes(request.method || "GET")) {
    response.writeHead(405, {
      "Allow": "GET, POST",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("当前接口只支持 GET 或 POST。");
    return;
  }

  if (request.method === "POST") {
    await consumeRequestBody(request);
  }

  try {
    await switchMonitor(target, {
      notifyOnSuccess: false,
      showErrorDialog: false,
    });

    redirectToControlPage(response, requestUrl, {
      status: "success",
      target: target.id,
    });
  } catch (error) {
    redirectToControlPage(response, requestUrl, {
      status: "error",
      target: target.id,
      message: error.message,
    });
  }
}

function redirectToControlPage(response, requestUrl, query) {
  const nextUrl = new URL(getControlPath(), requestUrl);

  Object.entries(query).forEach(([key, value]) => {
    if (value) {
      nextUrl.searchParams.set(key, value);
    }
  });

  response.writeHead(303, {
    "Location": `${nextUrl.pathname}${nextUrl.search}`,
    "Cache-Control": "no-store",
  });
  response.end();
}

function renderControlPage(requestUrl) {
  const status = requestUrl.searchParams.get("status");
  const target = requestUrl.searchParams.get("target");
  const message = requestUrl.searchParams.get("message");
  const currentLabel = getCurrentTargetLabel();
  const preferredLanControlUrl = getPreferredLanControlUrl();
  const addressText = preferredLanControlUrl || getLocalControlUrl();
  const statusHtml = renderStatusBanner(status, target, message);

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(APP_NAME)} 控制页</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5efe3;
      --panel: rgba(255, 252, 245, 0.92);
      --ink: #1f2a2c;
      --muted: #5b6769;
      --accent: #0d6b62;
      --accent-strong: #08463f;
      --danger: #9b2f1f;
      --danger-bg: #fce9e3;
      --success: #116149;
      --success-bg: #e8f6ef;
      --border: rgba(31, 42, 44, 0.12);
      font-family: "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top left, rgba(13, 107, 98, 0.18), transparent 32%),
        radial-gradient(circle at bottom right, rgba(230, 122, 46, 0.14), transparent 28%),
        var(--bg);
      color: var(--ink);
    }
    main {
      width: min(92vw, 560px);
      padding: 28px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: 0 18px 60px rgba(31, 42, 44, 0.12);
      backdrop-filter: blur(10px);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 30px;
    }
    p {
      margin: 0;
      line-height: 1.6;
      color: var(--muted);
    }
    .stack {
      display: grid;
      gap: 14px;
      margin-top: 22px;
    }
    .banner {
      padding: 12px 14px;
      border-radius: 16px;
      font-size: 14px;
    }
    .banner.success {
      background: var(--success-bg);
      color: var(--success);
    }
    .banner.error {
      background: var(--danger-bg);
      color: var(--danger);
    }
    .card {
      padding: 16px 18px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid var(--border);
    }
    .grid {
      display: grid;
      gap: 12px;
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
      background: linear-gradient(135deg, #d56a2a, #9d4215);
    }
    code {
      word-break: break-all;
      font-size: 13px;
      color: var(--ink);
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(APP_NAME)}</h1>
    <p>当前记录的输入源：${escapeHtml(currentLabel)}</p>
    <div class="stack">
      ${statusHtml}
      <div class="card grid">
        <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/switch/windows">
          <button type="submit">切到 Windows（DP2）</button>
        </form>
        <form method="post" action="/api/${encodeURIComponent(state.controlToken)}/switch/mac">
          <button class="secondary" type="submit">切到 Mac mini（HDMI1）</button>
        </form>
      </div>
      <div class="card">
        <p>先把这个页面收藏到手机、平板或另一台电脑。这样即使 Mac 当前没有画面，也能直接从浏览器切回来。</p>
      </div>
      <div class="card">
        <p>控制地址</p>
        <code>${escapeHtml(addressText)}</code>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderStatusBanner(status, target, message) {
  if (status === "success" && target && TARGETS[target]) {
    return `<div class="banner success">已切换到 ${escapeHtml(TARGETS[target].label)}。</div>`;
  }

  if (status === "error") {
    const targetLabel = target && TARGETS[target] ? TARGETS[target].label : "目标输入";
    const detail = message ? ` ${escapeHtml(message)}` : "";
    return `<div class="banner error">${escapeHtml(targetLabel)} 切换失败。${detail}</div>`;
  }

  return "";
}

function copyControlUrl(url) {
  clipboard.writeText(url);
  notify(`已复制控制地址：${url}`);
}

function summarizeControlAddress(url) {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.hostname}:${parsedUrl.port}`;
  } catch {
    return "不可用";
  }
}

function getCurrentTargetLabel() {
  return state.lastTarget ? TARGETS[state.lastTarget].label : "尚未通过此应用切换";
}

function getControlPath() {
  return `/control/${state.controlToken}`;
}

function getLocalControlUrl() {
  return `http://127.0.0.1:${CONTROL_PORT}${getControlPath()}`;
}

function getPreferredLanControlUrl() {
  const lanAddresses = getLanIpv4Addresses();

  if (lanAddresses.length === 0) {
    return null;
  }

  return `http://${lanAddresses[0]}:${CONTROL_PORT}${getControlPath()}`;
}

function getLanIpv4Addresses() {
  const networkInterfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(networkInterfaces)) {
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return Array.from(new Set(addresses));
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

function consumeRequestBody(request) {
  return new Promise((resolve, reject) => {
    request.on("data", () => {});
    request.on("end", resolve);
    request.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function runCommand(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
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

function loadState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(getStatePath(), "utf8")));
  } catch {
    return normalizeState({});
  }
}

function normalizeState(nextState) {
  return {
    lastTarget: nextState.lastTarget || null,
    controlToken: nextState.controlToken || crypto.randomBytes(12).toString("hex"),
  };
}

function saveState(nextState) {
  fs.mkdirSync(path.dirname(getStatePath()), { recursive: true });
  fs.writeFileSync(getStatePath(), JSON.stringify(nextState, null, 2));
}

function getStatePath() {
  return path.join(app.getPath("userData"), "state.json");
}

function shellEscape(value) {
  return value.replace(/'/g, `'\"'\"'`);
}

function appleScriptEscape(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
