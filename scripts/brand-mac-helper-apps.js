"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const PLIST_BUDDY_PATH = "/usr/libexec/PlistBuddy";

async function upsertPlistString(plistPath, key, value) {
  const escapedValue = value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');

  try {
    await execFileAsync(PLIST_BUDDY_PATH, ["-c", `Set :${key} "${escapedValue}"`, plistPath]);
  } catch (error) {
    await execFileAsync(PLIST_BUDDY_PATH, ["-c", `Add :${key} string "${escapedValue}"`, plistPath]);
  }
}

exports.default = async function brandMacHelperApps(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appBundlePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const mainIconPath = path.join(appBundlePath, "Contents", "Resources", "icon.icns");
  const frameworksDir = path.join(appBundlePath, "Contents", "Frameworks");

  let helperEntries = [];
  try {
    helperEntries = await fs.readdir(frameworksDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const helperApps = helperEntries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app")
  );

  await Promise.all(
    helperApps.map(async (entry) => {
      const helperAppPath = path.join(frameworksDir, entry.name);
      const helperName = entry.name.replace(/\.app$/u, "");
      const helperContentsPath = path.join(helperAppPath, "Contents");
      const helperResourcesPath = path.join(helperContentsPath, "Resources");
      const helperIconPath = path.join(helperResourcesPath, "icon.icns");
      const helperPlistPath = path.join(helperContentsPath, "Info.plist");

      await fs.mkdir(helperResourcesPath, { recursive: true });
      await fs.copyFile(mainIconPath, helperIconPath);
      await upsertPlistString(helperPlistPath, "CFBundleIconFile", "icon.icns");
      await upsertPlistString(helperPlistPath, "CFBundleName", helperName);
      await upsertPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    })
  );
};
