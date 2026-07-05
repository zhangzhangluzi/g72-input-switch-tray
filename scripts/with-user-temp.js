"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("Usage: node scripts/with-user-temp.js <command> [...args]\n");
  process.exit(1);
}

function getUserTempRoot() {
  if (process.env.G72_INPUT_SWITCH_TEMP) {
    return process.env.G72_INPUT_SWITCH_TEMP;
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Temp", "g72-input-switch-tray");
  }

  return path.join(process.cwd(), ".cache", "tmp");
}

const tempRoot = getUserTempRoot();
fs.mkdirSync(tempRoot, { recursive: true });

const [rawCommand, ...commandArgs] = args;
const command = rawCommand === "node" ? process.execPath : rawCommand;
const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
