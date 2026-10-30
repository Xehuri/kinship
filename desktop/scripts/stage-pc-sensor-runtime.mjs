#!/usr/bin/env node
// Stage a clean Windows Python 3.11.9 runtime + the PC sensor source into
// desktop/resources/pc-sensor/. Generated output is gitignored; the cache under
// desktop/.cache/pc-sensor-runtime/ is also gitignored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireWheel,
  computeSourceSha,
  copyAppSource,
  ensurePythonZip,
  fail,
  installWheels,
  mb,
  parseWheelName,
  readRequirementSpecs,
  run,
  treeSize,
} from "./lib/pc-sensor-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const sourceRoot = path.join(repoRoot, "desktop", "pc-sensor");
const outputRoot = path.join(desktopRoot, "resources", "pc-sensor");
const cacheRoot = path.join(desktopRoot, ".cache", "pc-sensor-runtime");
const pythonCacheDir = path.join(cacheRoot, "python-embed");
const wheelCacheDir = path.join(cacheRoot, "wheels");
const appOut = path.join(outputRoot, "app");
const runtimeOut = path.join(outputRoot, "runtime");
const sitePackages = path.join(runtimeOut, "Lib", "site-packages");
const requirementsPath = path.join(scriptDir, "pc-sensor-requirements.txt");
const lockPath = path.join(scriptDir, "python-embed.lock.json");
const seedRoot = process.env.PC_SENSOR_RUNTIME_SEED_DIR || "/tmp/pc-runtime-test";
const APP_VERSION = "2.1.0";
const PTH_LINES = ["python311.zip", ".", "Lib\\site-packages", "..\\app", "import site"];

function main() {
  for (const required of ["pc_sensor_app.py", "pc_sensor", "static", "assets"]) {
    if (!fs.existsSync(path.join(sourceRoot, required))) fail(`Missing PC sensor source: ${required}`);
  }
  fs.mkdirSync(wheelCacheDir, { recursive: true });

  const specs = readRequirementSpecs(requirementsPath);
  const { zipPath, lock } = ensurePythonZip({ pythonCacheDir, lockPath, seedRoot });
  const wheels = specs.map((spec) => acquireWheel(spec, { cacheRoot, wheelCacheDir, seedRoot }));

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(sitePackages, { recursive: true });

  console.log("Extracting embedded Python");
  run("python3", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, runtimeOut]);
  fs.writeFileSync(path.join(runtimeOut, "python311._pth"), `${PTH_LINES.join("\n")}\n`);

  console.log(`Installing ${wheels.length} wheels into runtime/Lib/site-packages`);
  installWheels({ runtimeOut, sitePackages, wheels });

  console.log("Copying PC sensor source");
  copyAppSource({ sourceRoot, appOut });
  const trayIcon = path.join(appOut, "assets", "tray-icon-64.png");
  if (!fs.existsSync(trayIcon)) fail("Missing staged tray icon: app/assets/tray-icon-64.png");

  const appVersionSource = fs.readFileSync(path.join(appOut, "pc_sensor_app.py"), "utf8");
  const versionMatch = /^VERSION\s*=\s*"([^"]+)"/m.exec(appVersionSource);
  if (!versionMatch) fail("Could not read VERSION from pc_sensor_app.py");
  if (versionMatch[1] !== APP_VERSION) {
    fail(`App version mismatch: staged source is ${versionMatch[1]}, expected ${APP_VERSION}`);
  }

  const sourceSha256 = computeSourceSha(appOut);
  const manifest = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    pythonVersion: lock.version,
    pythonEmbedSha256: lock.sha256,
    wheels: wheels.map((wheel) => {
      const meta = parseWheelName(path.basename(wheel.file));
      return { file: path.basename(wheel.file), name: meta.dist, version: meta.version, sha256: wheel.sha256 };
    }),
    sourceSha256,
  };
  fs.writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("");
  console.log("Staging complete");
  console.log(`  output:       ${outputRoot}`);
  console.log(`  runtime:      ${mb(treeSize(runtimeOut))} MiB`);
  console.log(`  app:          ${mb(treeSize(appOut))} MiB`);
  console.log(`  wheels:       ${wheels.length}`);
  console.log(`  sourceSha256: ${sourceSha256}`);
}

try {
  main();
} catch (error) {
  console.error(`STAGE_FAILED: ${error.message}`);
  process.exit(1);
}
