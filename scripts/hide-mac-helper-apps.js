"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

async function setFinderInvisible(appPath) {
  const setFilePath = "/usr/bin/SetFile";

  try {
    await fs.access(setFilePath);
    await execFileAsync(setFilePath, ["-a", "V", appPath]);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await execFileAsync("/usr/bin/chflags", ["hidden", appPath]);
}

exports.default = async function hideMacHelperApps(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const frameworksDir = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Frameworks"
  );

  let entries = [];
  try {
    entries = await fs.readdir(frameworksDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const helperAppNames = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => entry.name);

  await Promise.all(
    helperAppNames.map((name) =>
      setFinderInvisible(path.join(frameworksDir, name))
    )
  );
};
