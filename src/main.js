const { app, Tray, Menu, nativeImage, Notification, dialog, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "G72 Input Switch Tray";
const MONITOR_NAME = "G72";
const WINDOWS_TWINKLE_MONITOR_ID = "UID512";
const TARGETS = {
  windows: {
    id: "windows",
    label: "Windows (DP2)",
    value: 16,
  },
  mac: {
    id: "mac",
    label: "Mac mini (HDMI1)",
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
        ? `Current: ${TARGETS[state.lastTarget].label}`
        : "Current: not switched by this app yet",
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
      label: "Launch at login",
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
      label: "Reveal app folder",
      click: () => shell.showItemInFolder(process.execPath),
    },
    { type: "separator" },
    {
      label: "Uninstall...",
      click: () => uninstallApp(),
    },
    {
      label: "Quit",
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
      throw new Error(`Unsupported platform: ${process.platform}`);
    }

    state.lastTarget = target.id;
    saveState(state);
    refreshMenu();
    notify(`Switched ${MONITOR_NAME} to ${target.label}.`);
  } catch (error) {
    dialog.showErrorBox(
      APP_NAME,
      `${target.label} switch failed.\n\n${error.message}`
    );
  }
}

function switchOnWindows(target) {
  const twinklePath = getTwinklePath();
  const args = [
    `--MonitorID=${WINDOWS_TWINKLE_MONITOR_ID}`,
    `--VCP=0x60:${target.value}`,
    "--Overlay",
  ];

  return runCommand(twinklePath, args);
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
          buttons: ["Cancel", "Uninstall"],
          defaultId: 1,
          cancelId: 0,
          title: APP_NAME,
          message: "Uninstall G72 Input Switch Tray?",
          detail:
            process.platform === "win32"
              ? "The Windows uninstaller will open."
              : "The app will quit and then remove itself from Applications.",
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

  dialog.showErrorBox(APP_NAME, `Uninstall is not supported on ${process.platform}.`);
}

function uninstallOnWindows() {
  const appDir = path.dirname(process.execPath);
  const entries = fs.readdirSync(appDir);
  const uninstallFile = entries.find((entry) => /^Uninstall .*\.exe$/i.test(entry));

  if (!uninstallFile) {
    dialog.showErrorBox(APP_NAME, "Windows uninstaller was not found next to the app executable.");
    return;
  }

  execFile(path.join(appDir, uninstallFile), (error) => {
    if (error) {
      dialog.showErrorBox(APP_NAME, `Unable to open the uninstaller.\n\n${error.message}`);
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

function getTwinklePath() {
  const configuredPath = process.env.G72_TWINKLE_PATH;
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  const defaultPath = path.join(
    os.homedir(),
    "AppData",
    "Local",
    "Programs",
    "twinkle-tray",
    "Twinkle Tray.exe"
  );

  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  throw new Error(
    "Twinkle Tray was not found. Install Twinkle Tray or set G72_TWINKLE_PATH to its executable."
  );
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
