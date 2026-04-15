"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function verifyMainSourceSyntax() {
  execFileSync(process.execPath, ["--check", path.resolve(__dirname, "..", "src", "main.js")], {
    stdio: "pipe",
    encoding: "utf8",
  });
}

function verifyMainSourceBusinessGuards() {
  const mainSourcePath = path.resolve(__dirname, "..", "src", "main.js");
  const mainSource = fs.readFileSync(mainSourcePath, "utf8");

  assert.match(
    mainSource,
    /verificationStatus === "confirmed"[\s\S]*detachWindowsDisplayForMonitor/u
  );
  assert.match(mainSource, /const externalDisplays = orderedDisplays\.filter\(\(display\) => !display\.internal\);/u);
  assert.match(
    mainSource,
    /\.filter\(\(\{ electronDisplay \}\) => Boolean\(electronDisplay\) && !electronDisplay\.internal\);/u
  );
}

function verifyLocalOnlyDocs() {
  const readmePath = path.resolve(__dirname, "..", "README.md");
  const handoffDocPath = path.resolve(__dirname, "..", "docs", "shared-monitor-handoff.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const handoffDoc = fs.readFileSync(handoffDocPath, "utf8");

  assert.match(readme, /127\.0\.0\.1/u);
  assert.match(handoffDoc, /no LAN peer discovery/u);
  assert.match(
    handoffDoc,
    /controls only the external physical screens that are currently attached to the local host/u
  );
  assert.doesNotMatch(handoffDoc, /includes a first peer-confirmation layer/u);
  assert.doesNotMatch(handoffDoc, /ownership endpoint on the LAN/u);
  assert.doesNotMatch(handoffDoc, /discovered Windows peer/u);
}

function verifyPinnedMacDdcctlBuildScript() {
  const buildScriptPath = path.resolve(__dirname, "..", "scripts", "build-macos-ddcctl.sh");
  const buildScript = fs.readFileSync(buildScriptPath, "utf8");

  assert.match(buildScript, /DDCCTL_COMMIT="([0-9a-f]{40})"/u);
  assert.match(buildScript, /git -C "\$WORK_DIR" fetch --depth 1 origin "\$DDCCTL_COMMIT"/u);
}

function verifyWindowsScriptSyntax() {
  const topologyScriptPath = path.resolve(
    __dirname,
    "..",
    "resources",
    "windows",
    "display-topology.ps1"
  );
  const setInputScriptPath = path.resolve(
    __dirname,
    "..",
    "resources",
    "windows",
    "set-input.ps1"
  );
  const syntaxCheckCommand = `
$ErrorActionPreference = 'Stop'
$scripts = @(
  '${topologyScriptPath.replace(/'/gu, "''")}',
  '${setInputScriptPath.replace(/'/gu, "''")}'
)
foreach ($script in $scripts) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    throw ($errors | ForEach-Object { $_.Message } | Out-String)
  }
}
`;

  execFileSync("powershell.exe", ["-NoProfile", "-Command", syntaxCheckCommand], {
    stdio: "pipe",
    encoding: "utf8",
  });
}

function readPlistJson(plistPath) {
  return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]));
}

function isMacPathHidden(appPath) {
  try {
    return run("/usr/bin/mdls", ["-name", "kMDItemFSInvisible", "-raw", appPath]) === "1";
  } catch {
    // Fall through to filesystem flags below.
  }

  try {
    return run("/usr/bin/stat", ["-f", "%Sf", appPath]).split(",").includes("hidden");
  } catch {
    return false;
  }
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

    assert.equal(plist.CFBundleIconFile, "icon.icns");
    assert.equal(fs.existsSync(iconPath), true, `${iconPath} should exist`);
    assert.equal(isMacPathHidden(helperPath), true);
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

  const bundledWindowsTopologyHelperPath = path.join(
    appBundlePath,
    "Contents",
    "Resources",
    "resources",
    "windows",
    "display-topology.ps1"
  );
  assert.equal(
    fs.existsSync(bundledWindowsTopologyHelperPath),
    true,
    `${bundledWindowsTopologyHelperPath} should exist`
  );
}

function writeFakeDdcctlBinary(fakeBinaryPath, mode) {
  const script = `#!/bin/sh
set -eu
if [ "\${1:-}" = "-h" ]; then
  if [ "${mode}" = "missing-count" ]; then
    cat <<'EOF'
Usage:
ddcctl    -d <1-..> [display#]
EOF
  else
    cat <<'EOF'
Usage:
ddcctl    -d <1-..> [display#]
I: found 1 external display
EOF
  fi
  exit 0
fi

if [ "\${1:-}" = "-d" ] && [ "\${2:-}" = "1" ] && [ "\${3:-}" = "-i" ] && [ "\${4:-}" = "16" ]; then
  echo "OK"
  exit 0
fi

if [ "\${1:-}" = "-d" ] && [ "\${2:-}" = "1" ] && [ "\${3:-}" = "-i" ] && [ "\${4:-}" = "?" ]; then
  if [ "${mode}" = "matched" ]; then
    echo "VCP 0x60 current: 16 max: 18"
  elif [ "${mode}" = "query-fails" ]; then
    echo "readback unavailable" >&2
    exit 1
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-input-switch-selftest-"));
  const fakeBinaryPath = path.join(tempDir, "fake-ddcctl");
  const baseEnv = {
    ...process.env,
    DISPLAY_NAME: "Local Monitor",
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

  writeFakeDdcctlBinary(fakeBinaryPath, "query-fails");
  const unconfirmedOutput = execFileSync("/bin/sh", [switchScriptPath, "16"], {
    env: baseEnv,
    stdio: "pipe",
    encoding: "utf8",
  });
  assert.match(unconfirmedOutput, /UNCONFIRMED/u);

  writeFakeDdcctlBinary(fakeBinaryPath, "missing-count");
  let queryFailure = null;
  try {
    execFileSync("/bin/sh", [switchScriptPath, "--query-input"], {
      env: baseEnv,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    queryFailure = error;
  }

  assert.ok(queryFailure, "ddcctl query fallback should fail closed when display count is unknown");
  assert.match(
    `${queryFailure.stderr || queryFailure.message}`,
    /ddcctl 没有可靠返回外接屏数量/u
  );

  let missingCountFailure = null;
  try {
    execFileSync("/bin/sh", [switchScriptPath, "16"], {
      env: baseEnv,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    missingCountFailure = error;
  }

  assert.ok(missingCountFailure, "ddcctl switch fallback should fail closed when display count is unknown");
  assert.match(
    `${missingCountFailure.stderr || missingCountFailure.message}`,
    /ddcctl 没有可靠返回外接屏数量/u
  );
}

function verifyMacBetterDisplayDisplayIdSafety() {
  const switchScriptPath = path.resolve(
    __dirname,
    "..",
    "resources",
    "mac",
    "switch-input.sh"
  );
  const switchScript = fs.readFileSync(switchScriptPath, "utf8");

  assert.match(
    switchScript,
    /query_betterdisplay_input\(\)[\s\S]*if \[ -n "\$DISPLAY_ID" \]; then[\s\S]*remember_error "\$output" 2[\s\S]*return 1[\s\S]*\n  fi/u
  );
  assert.match(
    switchScript,
    /try_betterdisplay\(\)[\s\S]*if \[ -n "\$DISPLAY_ID" \]; then[\s\S]*remember_error "\$output" 2[\s\S]*return 1[\s\S]*\n  fi/u
  );
}

function verifyMacHelperAppsIfAvailable() {
  const builtAppPath = path.resolve(
    __dirname,
    "..",
    "release",
    "mac-arm64",
    "显示器输入切换.app"
  );
  const installedAppPath = "/Applications/显示器输入切换.app";
  if (fs.existsSync(builtAppPath)) {
    verifyMacHelperApps(builtAppPath);
    return;
  }

  if (fs.existsSync(installedAppPath)) {
    verifyMacHelperApps(installedAppPath);
    return;
  }

  if (process.env.SELF_VERIFY_REQUIRE_MAC_APP_BUNDLE === "1") {
    throw new Error("No macOS app bundle was found for self verification.");
  }
}

function main() {
  verifyMainSourceSyntax();
  verifyMainSourceBusinessGuards();
  verifyLocalOnlyDocs();
  verifyPinnedMacDdcctlBuildScript();

  if (process.platform === "win32") {
    verifyWindowsScriptSyntax();
  }

  if (process.platform === "darwin") {
    verifyMacDdcctlFallbackScript();
    verifyMacBetterDisplayDisplayIdSafety();
    verifyMacHelperAppsIfAvailable();
  }

  process.stdout.write("Self verification passed.\n");
}

main();
