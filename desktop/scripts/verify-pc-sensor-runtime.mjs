#!/usr/bin/env node
// Structural verification for the staged Windows PC sensor runtime.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeSourceSha } from "./lib/pc-sensor-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(desktopRoot, "resources", "pc-sensor");
const runtimeDir = path.join(outputRoot, "runtime");
const appDir = path.join(outputRoot, "app");
const sitePackages = path.join(runtimeDir, "Lib", "site-packages");

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function treeSize(dir) {
  return walkFiles(dir).reduce((total, file) => total + fs.statSync(file).size, 0);
}

function rel(file) {
  return path.relative(outputRoot, file).split(path.sep).join("/");
}

function main() {
  check(fs.existsSync(outputRoot), `Missing staged output: ${outputRoot}`);

  const manifestPath = path.join(outputRoot, "manifest.json");
  check(fs.existsSync(manifestPath), "Missing staged manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const actualSourceSha = computeSourceSha(appDir);
  check(
    actualSourceSha === manifest.sourceSha256,
    `Staged app source hash mismatch: manifest ${manifest.sourceSha256}, actual ${actualSourceSha}`,
  );
  for (const moduleName of ["pairing.py", "transport.py"]) {
    check(
      fs.existsSync(path.join(appDir, "pc_sensor", moduleName)),
      `Missing staged PC sensor module: pc_sensor/${moduleName}`,
    );
  }
  const trayIconPath = path.join(appDir, "assets", "tray-icon-64.png");
  check(fs.existsSync(trayIconPath), "Missing app/assets/tray-icon-64.png");

  const pythonExe = path.join(runtimeDir, "python.exe");
  check(fs.existsSync(pythonExe), "Missing runtime/python.exe");
  const fileResult = spawnSync("file", ["-b", pythonExe], { encoding: "utf8" });
  check(!fileResult.error && fileResult.status === 0, `file command failed for runtime/python.exe`);
  const fileDescription = fileResult.stdout.trim();
  check(/PE32\+/.test(fileDescription), `runtime/python.exe is not PE32+: ${fileDescription}`);

  const requiredPyds = [
    "pydantic_core/_pydantic_core.cp311-win_amd64.pyd",
    "PIL/_imaging.cp311-win_amd64.pyd",
    "psutil/_psutil_windows.pyd",
  ];
  for (const relative of requiredPyds) {
    const target = path.join(sitePackages, ...relative.split("/"));
    check(fs.existsSync(target), `Missing required extension module: ${relative}`);
  }

  const allFiles = walkFiles(outputRoot);
  const soFiles = allFiles.filter((file) => file.endsWith(".so"));
  check(soFiles.length === 0, `Found Linux shared objects: ${soFiles.map(rel).join(", ")}`);

  const forbidden = new Set([
    "config.json",
    "pc_sensor_config.json",
    "pc-sensor.log",
    "Kinship-PCSensor.exe",
    "Axeuh-PCSensor.exe",
  ]);
  for (const file of allFiles) {
    const name = path.basename(file);
    check(!forbidden.has(name), `Forbidden staged file: ${rel(file)}`);
    check(!name.includes(".bak-"), `Forbidden backup file: ${rel(file)}`);
  }

  const chartPath = path.join(appDir, "static", "vendor", "chart.umd.min.js");
  check(fs.existsSync(chartPath), "Missing app/static/vendor/chart.umd.min.js");
  const htmlPath = path.join(appDir, "static", "pc_config.html");
  check(fs.existsSync(htmlPath), "Missing app/static/pc_config.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  check(html.includes("/static/vendor/chart.umd.min.js"), "pc_config.html does not reference the vendored chart");
  check(!html.includes("cdn.jsdelivr"), "pc_config.html still references cdn.jsdelivr");

  const runtimeBytes = treeSize(runtimeDir);
  const appBytes = treeSize(appDir);
  const mib = 1024 * 1024;
  check(runtimeBytes >= 35 * mib, `Runtime is too small: ${(runtimeBytes / mib).toFixed(1)} MiB`);
  check(runtimeBytes <= 80 * mib, `Runtime is too large: ${(runtimeBytes / mib).toFixed(1)} MiB`);
  check(appBytes < 5 * mib, `App source is too large: ${(appBytes / mib).toFixed(1)} MiB`);

  const pthPath = path.join(runtimeDir, "python311._pth");
  check(fs.existsSync(pthPath), "Missing runtime/python311._pth");
  const pthLines = fs.readFileSync(pthPath, "utf8").split(/\r?\n/).map((line) => line.trim());
  check(pthLines.includes("..\\app"), "python311._pth is missing the ..\\app entry");

  console.log(
    `runtime ${(runtimeBytes / mib).toFixed(1)} MiB, app ${(appBytes / mib).toFixed(1)} MiB, ` +
      `${allFiles.length} files, chart vendored`,
  );
  console.log("RUNTIME_OK");
}

try {
  main();
} catch (error) {
  console.error(`RUNTIME_FAILED: ${error.message}`);
  process.exit(1);
}
