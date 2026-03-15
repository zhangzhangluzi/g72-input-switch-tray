"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { doesMonitorListContainConfiguredMonitor } = require("../src/monitor-name-helpers");
const {
  createWindowsSharedMonitorTransferHint,
  createWindowsSwitchMenuModel,
} = require("../src/tray-menu-helpers");

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function verifyWindowsMenuModel() {
  const handoffItems = createWindowsSwitchMenuModel({
    windowsSharedMonitorMissing: true,
    hasConfigErrors: false,
    lastTarget: "mac",
    windowsLabel: "Windows（DP2）",
    macLabel: "Mac mini（HDMI1）",
  });

  assert.equal(handoffItems.length, 1);
  assert.equal(handoffItems[0].kind, "handoffHint");
  assert.equal(handoffItems[0].enabled, true);
  assert.match(handoffItems[0].label, /交给另一台电脑/);

  const targetItems = createWindowsSwitchMenuModel({
    windowsSharedMonitorMissing: false,
    hasConfigErrors: false,
    lastTarget: "windows",
    windowsLabel: "Windows（DP2）",
    macLabel: "Mac mini（HDMI1）",
  });

  assert.deepEqual(
    targetItems.map((item) => ({
      kind: item.kind,
      targetId: item.targetId,
      enabled: item.enabled,
      checked: item.checked,
      type: item.type,
    })),
    [
      {
        kind: "target",
        targetId: "windows",
        enabled: true,
        checked: true,
        type: "radio",
      },
      {
        kind: "target",
        targetId: "mac",
        enabled: true,
        checked: false,
        type: "radio",
      },
    ]
  );

  const hint = createWindowsSharedMonitorTransferHint({
    monitorName: "G72",
    message: "G72 仍然被 Windows 枚举到，但当前输入回报是 HDMI1 (17)，说明这块共享屏的画面已经交给 Mac 了。请在 Mac 端或显示器菜单里切回 Windows。",
  });
  assert.equal(hint.message, "G72 当前已交给另一台电脑");
  assert.match(hint.detail, /谁当前拥有这块共享屏/);
  assert.match(hint.detail, /已经交给 Mac/);

  assert.equal(
    doesMonitorListContainConfiguredMonitor(["G72 Max", "G52 Max"], "G72"),
    true
  );
  assert.equal(
    doesMonitorListContainConfiguredMonitor(["DELLU2723QE"], "DELL U2723QE"),
    true
  );
  assert.equal(
    doesMonitorListContainConfiguredMonitor(["G52 Max"], "G72"),
    false
  );
}

function readPlistJson(plistPath) {
  return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]));
}

function verifyMacHelperApps(appBundlePath) {
  if (!fs.existsSync(appBundlePath)) {
    throw new Error(`App bundle not found: ${appBundlePath}`);
  }

  const frameworksDir = path.join(appBundlePath, "Contents", "Frameworks");
  const helperApps = fs
    .readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(helperApps, [
    "显示器输入切换 Helper (GPU).app",
    "显示器输入切换 Helper (Plugin).app",
    "显示器输入切换 Helper (Renderer).app",
    "显示器输入切换 Helper.app",
  ]);

  for (const helperName of helperApps) {
    const helperPath = path.join(frameworksDir, helperName);
    const plistPath = path.join(helperPath, "Contents", "Info.plist");
    const iconPath = path.join(helperPath, "Contents", "Resources", "icon.icns");
    const plist = readPlistJson(plistPath);
    const invisible = run("/usr/bin/mdls", ["-name", "kMDItemFSInvisible", "-raw", helperPath]);

    assert.equal(plist.CFBundleIconFile, "icon.icns");
    assert.equal(fs.existsSync(iconPath), true, `${iconPath} should exist`);
    assert.equal(invisible, "1");
    assert.match(plist.CFBundleName, /^显示器输入切换 Helper/u);
  }

  const bundledDdcctlPath = path.join(
    appBundlePath,
    "Contents",
    "Resources",
    "resources",
    "bin",
    "ddcctl"
  );
  assert.equal(
    fs.existsSync(bundledDdcctlPath),
    true,
    `${bundledDdcctlPath} should exist`
  );
}

function writeFakeDdcctlBinary(fakeBinaryPath, mode) {
  const script = `#!/bin/sh
set -eu
if [ "\${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
ddcctl    -d <1-..> [display#]
I: found 1 external display
EOF
  exit 0
fi

if [ "\${1:-}" = "-d" ] && [ "\${2:-}" = "1" ] && [ "\${3:-}" = "-i" ] && [ "\${4:-}" = "16" ]; then
  echo "OK"
  exit 0
fi

if [ "\${1:-}" = "-d" ] && [ "\${2:-}" = "1" ] && [ "\${3:-}" = "-i" ] && [ "\${4:-}" = "?" ]; then
  if [ "${mode}" = "matched" ]; then
    echo "VCP 0x60 current: 16 max: 18"
  else
    echo "VCP 0x60 current: 6 max: 18"
  fi
  exit 0
fi

echo "unexpected args: $*" >&2
exit 1
`;

  fs.writeFileSync(fakeBinaryPath, script, { mode: 0o755 });
}

function verifyMacDdcctlFallbackScript() {
  const switchScriptPath = path.resolve(
    __dirname,
    "..",
    "resources",
    "mac",
    "switch-input.sh"
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "g72-ddcctl-selftest-"));
  const fakeBinaryPath = path.join(tempDir, "fake-ddcctl");
  const baseEnv = {
    ...process.env,
    DISPLAY_NAME: "G72",
    DISPLAY_INDEX: "1",
    DISABLE_BETTERDISPLAY: "1",
    BUNDLED_DDCCTL_PATH: fakeBinaryPath,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };

  writeFakeDdcctlBinary(fakeBinaryPath, "matched");
  execFileSync("/bin/sh", [switchScriptPath, "16"], {
    env: baseEnv,
    stdio: "pipe",
    encoding: "utf8",
  });

  writeFakeDdcctlBinary(fakeBinaryPath, "unchanged");
  let failure = null;
  try {
    execFileSync("/bin/sh", [switchScriptPath, "16"], {
      env: baseEnv,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, "ddcctl fallback should fail when readback stays on the old input");
  assert.match(
    `${failure.stderr || failure.message}`,
    /ddcctl 已发送输入切换命令，但当前输入仍是 6，未匹配目标值集合：16 9 7/
  );
}

function main() {
  verifyWindowsMenuModel();

  if (process.platform === "darwin") {
    verifyMacDdcctlFallbackScript();

    const appPaths = [
      path.resolve(__dirname, "..", "release", "mac-arm64", "显示器输入切换.app"),
      "/Applications/显示器输入切换.app",
    ].filter((appPath) => fs.existsSync(appPath));

    if (appPaths.length === 0) {
      throw new Error("No macOS app bundle was found for self verification.");
    }

    for (const appPath of appPaths) {
      verifyMacHelperApps(appPath);
    }
  }

  process.stdout.write("Self verification passed.\n");
}

main();
