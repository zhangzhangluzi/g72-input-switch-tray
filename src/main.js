const { app, Tray, Menu, nativeImage, Notification, dialog, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "G72 输入切换";
const MONITOR_NAME = "G72";
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
let state = { lastTarget: null };

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

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  state = loadState();
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

  const menu = Menu.buildFromTemplate([
    {
      label: state.lastTarget
        ? `当前输入：${TARGETS[state.lastTarget].label}`
        : "当前输入：尚未通过此应用切换",
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

async function switchMonitor(target) {
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
    notify(`已将 ${MONITOR_NAME} 切换到 ${target.label}。`);
  } catch (error) {
    dialog.showErrorBox(
      APP_NAME,
      `${target.label} 切换失败。\n\n${error.message}`
    );
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
    return JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
  } catch {
    return { lastTarget: null };
  }
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
