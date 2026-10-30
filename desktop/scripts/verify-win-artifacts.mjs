#!/usr/bin/env node
// Structure check for the Windows desktop build artifacts.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");

const SETUP_RE = /^Kinship-Desktop-Setup-.+-x64\.exe$/;
const PORTABLE_RE = /^Kinship-Desktop-Portable-.+-x64\.exe$/;
const ZIP_RE = /^Kinship-Desktop-.+-x64\.zip$/;
const INSTALLER_MIN_BYTES = 100 * 1024 * 1024;
const ZIP_MIN_BYTES = 50 * 1024 * 1024;

const ZIP_EXPECTED = [
  "Kinship Desktop.exe",
  "resources/app.asar",
  "resources/icon.png",
  "resources/pc-sensor/runtime/python.exe",
  "resources/pc-sensor/app/pc_sensor_app.py",
  "resources/pc-sensor/app/pc_sensor/pairing.py",
  "resources/pc-sensor/app/pc_sensor/transport.py",
  "resources/pc-sensor/manifest.json",
  "resources/pc-sensor/app/static/vendor/chart.umd.min.js",
  "resources/pc-sensor/app/assets/tray-icon-64.png",
];
const UNPACKED_EXPECTED = [
  "Kinship Desktop.exe",
  "resources/app.asar",
  "resources/icon.png",
  "resources/pc-sensor/runtime/python.exe",
  "resources/pc-sensor/app/pc_sensor_app.py",
  "resources/pc-sensor/app/pc_sensor/pairing.py",
  "resources/pc-sensor/app/pc_sensor/transport.py",
  "resources/pc-sensor/app/assets/tray-icon-64.png",
];
const ASAR_EXPECTED = [
  "/dist/main/main.js",
  "/dist/preload/preload.js",
  "/dist/renderer/index.html",
  "/package.json",
];
const FORBIDDEN_BASENAMES = new Set([
  "config.json",
  "config.example.json",
  "pc_sensor_config.json",
  "pc_sensor_config.example.json",
  "pc-sensor.log",
  "Kinship-PCSensor.exe",
  "Axeuh-PCSensor.exe",
]);
const ZIP_LIST_CODE =
  "import json,sys,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))";

function fail(errors) {
  for (const error of errors) console.error(`ARTIFACTS_FAIL: ${error}`);
  process.exit(1);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pickArtifact(dir, pattern) {
  const matches = fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const abs = path.join(dir, name);
      return { name, abs, size: fs.statSync(abs).size, mtimeMs: fs.statSync(abs).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0] ?? null;
}

function isForbidden(name) {
  const base = name.split("/").pop() ?? name;
  return FORBIDDEN_BASENAMES.has(base) || base.includes(".bak-");
}

function hasSuffix(entries, expected) {
  return entries.some((entry) => entry === expected || entry.endsWith(`/${expected}`));
}

function checkZip(zipPath, errors) {
  let entries;
  try {
    const output = execFileSync("python3", ["-c", ZIP_LIST_CODE, zipPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(output);
  } catch (error) {
    errors.push(`zip listing failed: ${error.message}`);
    return 0;
  }
  for (const expected of ZIP_EXPECTED) {
    if (!hasSuffix(entries, expected)) errors.push(`zip missing ${expected}`);
  }
  for (const entry of entries) {
    if (isForbidden(entry)) errors.push(`zip contains forbidden ${entry}`);
  }
  return entries.length;
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

function checkUnpacked(unpackedDir, errors) {
  if (!fs.existsSync(unpackedDir)) {
    errors.push(`missing win-unpacked: ${unpackedDir}`);
    return;
  }
  for (const expected of UNPACKED_EXPECTED) {
    if (!fs.existsSync(path.join(unpackedDir, expected))) {
      errors.push(`win-unpacked missing ${expected}`);
    }
  }
  for (const file of walkFiles(unpackedDir)) {
    const relative = path.relative(unpackedDir, file).split(path.sep).join("/");
    if (isForbidden(relative)) errors.push(`win-unpacked contains forbidden ${relative}`);
  }
}

function findOnPath(bin) {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean)
    : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function main() {
  const target = process.argv[2] ?? "release";
  const releaseDir = path.isAbsolute(target) ? target : path.resolve(desktopRoot, target);
  if (!fs.existsSync(releaseDir)) fail([`missing release directory: ${releaseDir}`]);

  const errors = [];
  const setup = pickArtifact(releaseDir, SETUP_RE);
  const portable = pickArtifact(releaseDir, PORTABLE_RE);
  const zip = pickArtifact(releaseDir, ZIP_RE);
  if (!setup) errors.push("missing NSIS installer (*Setup-*-x64.exe)");
  if (!portable) errors.push("missing portable exe (*Portable-*-x64.exe)");
  if (!zip) errors.push("missing zip artifact (*-x64.zip)");
  if (setup && setup.size < INSTALLER_MIN_BYTES) {
    errors.push(`installer too small: ${mb(setup.size)}`);
  }
  if (portable && portable.size < INSTALLER_MIN_BYTES) {
    errors.push(`portable too small: ${mb(portable.size)}`);
  }
  if (zip && zip.size < ZIP_MIN_BYTES) errors.push(`zip too small: ${mb(zip.size)}`);

  const zipCount = zip ? checkZip(zip.abs, errors) : 0;

  const unpackedDir = path.join(releaseDir, "win-unpacked");
  checkUnpacked(unpackedDir, errors);

  let asarCount = 0;
  const asarPath = path.join(unpackedDir, "resources", "app.asar");
  const asarBin = path.join(
    desktopRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "asar.cmd" : "asar",
  );
  if (!fs.existsSync(asarPath)) {
    errors.push("missing resources/app.asar");
  } else if (!fs.existsSync(asarBin)) {
    errors.push(`missing asar CLI: ${asarBin}`);
  } else {
    try {
      const lines = execFileSync(asarBin, ["list", asarPath], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      asarCount = lines.length;
      for (const expected of ASAR_EXPECTED) {
        if (!lines.includes(expected)) errors.push(`app.asar missing ${expected}`);
      }
    } catch (error) {
      errors.push(`asar listing failed: ${error.message}`);
    }
  }

  let nsisLine = "NSIS_UNCHECKED";
  const sevenZip = findOnPath("7zz");
  if (setup) {
    if (sevenZip) {
      try {
        const output = execFileSync(sevenZip, ["l", setup.abs], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        if (!output.includes("Type = Nsis")) errors.push("7zz: installer is not NSIS");
        if (!output.includes("app-64.7z")) errors.push("7zz: installer missing app-64.7z");
        nsisLine = "NSIS_7ZZ_OK";
      } catch (error) {
        errors.push(`7zz listing failed: ${error.message}`);
      }
    } else {
      const fileBin = findOnPath("file");
      if (!fileBin) {
        errors.push("NSIS installer check requires 7zz or file on PATH");
      } else {
        try {
          const output = execFileSync(fileBin, [setup.abs], {
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          });
          if (!output.includes("Nullsoft Installer")) {
            errors.push(`file: installer is not NSIS (${output.trim()})`);
          } else {
            nsisLine = "NSIS_FILE_OK";
          }
        } catch (error) {
          errors.push(`file check failed: ${error.message}`);
        }
      }
    }
  }

  if (errors.length > 0) fail(errors);

  console.log(`Installer: ${setup.name} (${mb(setup.size)})`);
  console.log(`Portable:  ${portable.name} (${mb(portable.size)})`);
  console.log(`Zip:       ${zip.name} (${mb(zip.size)}, ${zipCount} entries)`);
  console.log(`Unpacked:  ${unpackedDir} (structure OK)`);
  console.log(`app.asar:  ${asarCount} entries (key files OK)`);
  console.log(nsisLine);
  console.log("ARTIFACTS_OK");
}

main();
