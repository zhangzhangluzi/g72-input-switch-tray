"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "win32") {
  process.stdout.write("Windows hidden-process launcher build skipped on this platform.\n");
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(projectRoot, "native", "windows", "hidden-process.cs");
const outputArgumentIndex = process.argv.indexOf("--output");
const outputPath = path.resolve(
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1]
    ? process.argv[outputArgumentIndex + 1]
    : path.join(projectRoot, "resources", "windows", "hidden-process.exe")
);
const windowsRoot = process.env.SystemRoot || "C:\\Windows";
const compilerCandidates = [
  path.join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windowsRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const compilerPath = compilerCandidates.find((candidate) => fs.existsSync(candidate));

if (!compilerPath) {
  throw new Error("Windows .NET Framework C# compiler was not found.");
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.rmSync(outputPath, { force: true });

const result = spawnSync(
  compilerPath,
  [
    "/nologo",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    "/warnaserror+",
    `/out:${outputPath}`,
    sourcePath,
  ],
  {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  }
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0 || !fs.existsSync(outputPath)) {
  throw new Error(
    [result.stdout, result.stderr, `csc.exe exited with ${result.status}`]
      .filter(Boolean)
      .join("\n")
  );
}

const outputSize = fs.statSync(outputPath).size;
if (outputSize < 4096) {
  throw new Error(`Hidden-process launcher is unexpectedly small: ${outputSize} bytes.`);
}

process.stdout.write(`Built Windows hidden-process launcher: ${outputPath} (${outputSize} bytes)\n`);
